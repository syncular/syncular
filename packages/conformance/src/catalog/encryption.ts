/**
 * §5.11 client-side encryption, cross-core (SPEC.md §5.11; Appendix B).
 *
 * A scope-mate with the shared fixture key decrypts what the writer encrypted
 * — whichever core is on each side of the pairing (TS writes / Rust reads and
 * vice versa via the same key bytes). The server holds only ciphertext: a
 * raw-driver read asserts the stored row carries the §5.11 envelope, not
 * plaintext. A wrong-key client surfaces `client.decrypt_failed` on apply.
 */
import { check, checkEqual } from '../checks';
import type { DriverEncryptionConfig, DriverSchema } from '../driver';
import type { Scenario, ScenarioContext } from '../scenario';
import { syncFails, syncIdle } from './util';

const P1 = { project_id: ['p1'] } as const;

/** A table with two encrypted columns: a string `note` and an integer `amount`. */
const E2EE_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'secrets',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        {
          name: 'note',
          type: 'bytes',
          nullable: false,
          encrypted: true,
          declaredType: 'string',
        },
        {
          name: 'amount',
          type: 'bytes',
          nullable: true,
          encrypted: true,
          declaredType: 'integer',
        },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
  ],
};

const E2EE_SERVER = { schema: E2EE_SCHEMA } as const;

// Shared fixture key (`keyId = table` per the §5.11 per-table default).
const KEY_HEX = '2a'.repeat(32);
const WRONG_KEY_HEX = '99'.repeat(32);
const goodKeys: DriverEncryptionConfig = {
  keys: { secrets: { $bytes: KEY_HEX } },
};
const wrongKeys: DriverEncryptionConfig = {
  keys: { secrets: { $bytes: WRONG_KEY_HEX } },
};

/** A table whose key id is selected by a plaintext column (§5.11). */
const SELECTED_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'secrets',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'encryption_key_id', type: 'string', nullable: true },
        {
          name: 'note',
          type: 'bytes',
          nullable: true,
          encrypted: true,
          declaredType: 'string',
        },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
  ],
};

const SELECTED_SERVER = { schema: SELECTED_SCHEMA } as const;
const SELECTED_KEY_ID = 'practice-key-v1';
const selectedKeys: DriverEncryptionConfig = {
  keys: { [SELECTED_KEY_ID]: { $bytes: KEY_HEX } },
  keyIdColumns: { secrets: 'encryption_key_id' },
};

/**
 * §5.11 sidecar shape: a plaintext primary `records` (no encrypted column)
 * plus an encrypted sidecar `record_details` under its own scope. The
 * sidecar's value is encrypted; the primary carries only shared columns and
 * a disclosed presence marker.
 */
const SIDECAR_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'records',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        {
          name: 'status_reason_state',
          type: 'string',
          nullable: false,
        },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
    {
      name: 'record_details',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'detail_scope', type: 'string', nullable: false },
        {
          name: 'value',
          type: 'bytes',
          nullable: true,
          encrypted: true,
          declaredType: 'string',
        },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'detail:{detail_scope}' }],
    },
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
  ],
};

const SIDECAR_SERVER = { schema: SIDECAR_SCHEMA } as const;
const PRIMARY_SCOPES = { project_id: ['p1'] } as const;
const DETAIL_SCOPES = { detail_scope: ['d1'] } as const;
const SIDECAR_ALLOWED = { project_id: ['p1'], detail_scope: ['d1'] } as const;
const PROTECTED_VALUE = 'patient declined to say';
const writerKeys: DriverEncryptionConfig = {
  keys: { record_details: { $bytes: KEY_HEX } },
};

function utf8Hex(text: string): string {
  let hex = '';
  for (const b of new TextEncoder().encode(text)) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

export const encryptionScenarios: readonly Scenario[] = [
  {
    // A writes an encrypted row; B (a scope-mate with the same key) decrypts
    // it on pull back to plaintext; the server row holds ciphertext.
    name: 'encryption/round-trip',
    specRefs: ['§5.11'],
    server: E2EE_SERVER,
    async run(ctx: ScenarioContext) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-a',
        schema: E2EE_SCHEMA,
        allowed: P1,
        encryption: goodKeys,
      });
      const b = await ctx.newClient({
        actorId: 'b',
        clientId: 'client-b',
        schema: E2EE_SCHEMA,
        allowed: P1,
        encryption: goodKeys,
      });
      await a.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await b.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await syncIdle(a);
      await syncIdle(b);

      await a.api.mutate([
        {
          op: 'upsert',
          table: 'secrets',
          values: {
            id: 'r1',
            project_id: 'p1',
            note: 'top secret',
            amount: 42,
          },
        },
      ]);
      // A's local mirror is plaintext (the declared-type values).
      const aRow = (await a.api.readRows('secrets')).find(
        (r) => r.values.id === 'r1',
      );
      check(aRow?.values.note === 'top secret', 'A local note is plaintext');
      checkEqual(aRow?.values.amount, 42, 'A local amount is plaintext');

      await syncIdle(a);
      await syncIdle(b);

      // The SERVER row is ciphertext: the `note` column is a `{ $bytes }`
      // envelope (version byte 0x01), never the plaintext string.
      const serverRow = (await ctx.server.readRows('secrets')).find(
        (r) => r.rowId === 'r1',
      );
      check(serverRow !== undefined, 'server stored r1');
      const noteVal = serverRow?.values.note;
      check(
        typeof noteVal === 'object' && noteVal !== null && '$bytes' in noteVal,
        'server note column is bytes (ciphertext), not a string',
      );
      const noteHex = (noteVal as { $bytes: string }).$bytes;
      check(
        noteHex.startsWith('01'),
        'server note ciphertext starts with the §5.11 envelope version 0x01',
      );
      check(
        !noteHex.includes(utf8Hex('top secret')),
        'server note ciphertext does not contain the plaintext bytes',
      );

      // B decrypts on apply back to plaintext.
      const bRow = (await b.api.readRows('secrets')).find(
        (r) => r.values.id === 'r1',
      );
      check(
        bRow?.values.note === 'top secret',
        'B decrypted note to plaintext',
      );
      checkEqual(bRow?.values.amount, 42, 'B decrypted amount to plaintext');
    },
  },
  {
    // A wrong-key scope-mate cannot decrypt — apply surfaces
    // `client.decrypt_failed` (§5.11, §10.3).
    name: 'encryption/wrong-key-fails',
    specRefs: ['§5.11', '§10.3'],
    server: E2EE_SERVER,
    async run(ctx: ScenarioContext) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-a',
        schema: E2EE_SCHEMA,
        allowed: P1,
        encryption: goodKeys,
      });
      await a.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'secrets',
          values: {
            id: 'r1',
            project_id: 'p1',
            note: 'confidential',
            amount: 7,
          },
        },
      ]);
      await syncIdle(a);

      const bad = await ctx.newClient({
        actorId: 'b',
        clientId: 'client-bad',
        schema: E2EE_SCHEMA,
        allowed: P1,
        encryption: wrongKeys,
      });
      await bad.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      // The wrong-key apply fails; the sync surfaces client.decrypt_failed.
      await syncFails(
        bad,
        'client.decrypt_failed',
        'wrong-key apply surfaces client.decrypt_failed',
      );
    },
  },
  {
    // §5.11: a sparse patch that omits the key-id selector resolves it from
    // the stored local row; an unresolvable key id is a durable
    // `client.encrypt_failed` rejection instead of a sync() abort.
    name: 'encryption/sparse-patch-key-resolution',
    specRefs: ['§5.11', '§10.3', '§6.1'],
    server: SELECTED_SERVER,
    async run(ctx: ScenarioContext) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-selected',
        schema: SELECTED_SCHEMA,
        allowed: P1,
        encryption: selectedKeys,
      });
      await a.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'secrets',
          values: {
            id: 'r1',
            project_id: 'p1',
            encryption_key_id: SELECTED_KEY_ID,
            note: 'original',
          },
        },
      ]);
      await syncIdle(a);

      // A sparse patch that omits the selector falls back to the stored row.
      await a.api.patch('secrets', 'r1', { note: 'updated' });
      await syncIdle(a);
      const serverRow = (await ctx.server.readRows('secrets')).find(
        (r) => r.rowId === 'r1',
      );
      const noteVal = serverRow?.values.note;
      check(
        typeof noteVal === 'object' && noteVal !== null && '$bytes' in noteVal,
        'the patched note is ciphertext on the server',
      );
      check(
        !(noteVal as { $bytes: string }).$bytes.includes(utf8Hex('updated')),
        'the patched note plaintext is not on the server',
      );
      const local = (await a.api.readRows('secrets')).find(
        (r) => r.values.id === 'r1',
      );
      checkEqual(local?.values.note, 'updated', 'the local note is plaintext');
      checkEqual(
        local?.values.encryption_key_id,
        SELECTED_KEY_ID,
        'the stored selector survived the patch',
      );
      checkEqual((await a.api.rejections()).length, 0, 'no rejection yet');

      // A patch that presents no encrypted column needs no key: the new
      // selector names a key the provider lacks, so any key resolution would
      // reject. The commit reaches the server with zero rejections (§5.11).
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'secrets',
          values: {
            id: 'r2',
            project_id: 'p1',
            encryption_key_id: SELECTED_KEY_ID,
            note: null,
          },
        },
      ]);
      await syncIdle(a);
      await a.api.patch('secrets', 'r2', {
        encryption_key_id: 'rotated-away-key',
      });
      const keyless = await syncIdle(a);
      checkEqual(
        keyless.rejected.length,
        0,
        'the selector-only patch is not server-rejected',
      );
      checkEqual(
        (await a.api.rejections()).length,
        0,
        'a patch presenting no encrypted column yields zero rejections',
      );
      const keylessLocal = (await a.api.readRows('secrets')).find(
        (r) => r.values.id === 'r2',
      );
      checkEqual(
        keylessLocal?.values.encryption_key_id,
        'rotated-away-key',
        'the unconfigured selector is stored, proving no key was resolved',
      );
      checkEqual(
        keylessLocal?.values.note,
        null,
        'the untouched encrypted column stays NULL',
      );
      const keylessServer = (await ctx.server.readRows('secrets')).find(
        (r) => r.rowId === 'r2',
      );
      checkEqual(
        keylessServer?.values.encryption_key_id,
        'rotated-away-key',
        'the server stored the selector instead of rejecting the patch',
      );

      // A patch on a locally absent row presents an encrypted column with no
      // stored selector: durable rejection, dropped commit, no sync() abort.
      const ghost = await a.api.patch('secrets', 'ghost', { note: 'x' });
      const report = await syncIdle(a);
      check(
        !report.rejected.includes(ghost),
        'the encode failure is client-local, not a server rejection',
      );
      const rejections = await a.api.rejections();
      checkEqual(rejections.length, 1, 'one durable rejection');
      checkEqual(
        rejections[0]?.code,
        'client.encrypt_failed',
        'the encode seam code',
      );
      checkEqual(
        rejections[0]?.clientCommitId,
        ghost,
        'the rejection names the dropped commit',
      );
      check(
        !(await a.api.pendingCommitIds()).includes(ghost),
        'the dropped commit left the outbox',
      );

      // A present NULL selector is not an absent selector: it stays NULL and
      // never reads the stored key id, so the encode fails durably. A core
      // that fell back would have encrypted under the stored key and put
      // ciphertext on the server with zero rejections (§6.1 absent ≠ NULL).
      const nullSelector = await a.api.patch('secrets', 'r1', {
        encryption_key_id: null,
        note: 'nullled',
      });
      const nullReport = await syncIdle(a);
      check(
        !nullReport.rejected.includes(nullSelector),
        'the present-NULL encode failure is client-local, not a server rejection',
      );
      const afterNull = await a.api.rejections();
      checkEqual(afterNull.length, 2, 'a second durable rejection');
      checkEqual(
        afterNull[1]?.code,
        'client.encrypt_failed',
        'the present NULL selector is unusable, not rescued from the stored row',
      );
      checkEqual(
        afterNull[1]?.clientCommitId,
        nullSelector,
        'the rejection names the dropped present-NULL commit',
      );
      check(
        afterNull[1]?.operation?.present?.includes('encryption_key_id') ===
          true && afterNull[1]?.operation?.present?.includes('note') === true,
        'the rejected operation presented the selector (NULL) and the note',
      );
      check(
        !(await a.api.pendingCommitIds()).includes(nullSelector),
        'the dropped present-NULL commit left the outbox',
      );
      const r1After = (await a.api.readRows('secrets')).find(
        (r) => r.values.id === 'r1',
      );
      checkEqual(
        r1After?.values.encryption_key_id,
        SELECTED_KEY_ID,
        'the failed commit rolled back, so the stored selector survives',
      );
      checkEqual(
        r1After?.values.note,
        'updated',
        'the failed commit rolled back the stored note',
      );
      const r1Server = (await ctx.server.readRows('secrets')).find(
        (r) => r.rowId === 'r1',
      );
      checkEqual(
        r1Server?.values.encryption_key_id,
        SELECTED_KEY_ID,
        'the server row kept the stored selector',
      );
    },
  },
  {
    // §5.11 sidecar isolation: a no-key client subscribes to the plaintext
    // primary (and to an unrelated plaintext table) while a non-NULL
    // protected value sits in the encrypted sidecar committed in the SAME
    // commit. The reader's table projection never yields the sidecar row, so
    // the reader executes no decrypt; this proves the sidecar stays isolated
    // for a primary-only subscriber and that a round carrying sidecar work
    // does not starve the reader's other subscriptions. It does NOT prove
    // decrypt-failure semantics: the deliberately-subscribed no-key client is
    // the negative case below.
    name: 'encryption/sidecar-no-key-primary-read',
    specRefs: ['§5.11'],
    server: SIDECAR_SERVER,
    async run(ctx: ScenarioContext) {
      const writer = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-writer',
        schema: SIDECAR_SCHEMA,
        allowed: SIDECAR_ALLOWED,
        encryption: writerKeys,
      });
      await writer.api.subscribe({
        id: 'primary',
        table: 'records',
        scopes: PRIMARY_SCOPES,
      });
      await writer.api.subscribe({
        id: 'sidecar',
        table: 'record_details',
        scopes: DETAIL_SCOPES,
      });
      await writer.api.subscribe({
        id: 'related',
        table: 'notes',
        scopes: PRIMARY_SCOPES,
      });
      await syncIdle(writer);

      // One commit carries both plaintext primary rows, the encrypted sidecar
      // row, and an unrelated plaintext row: the mixed-shape case a no-key
      // client must survive without losing its other subscriptions.
      await writer.api.mutate([
        {
          op: 'upsert',
          table: 'records',
          values: {
            id: 'r1',
            project_id: 'p1',
            title: 'Colonoscopy',
            status_reason_state: 'protected_source_value',
          },
        },
        {
          op: 'upsert',
          table: 'records',
          values: {
            id: 'r2',
            project_id: 'p1',
            title: 'Consultation',
            status_reason_state: 'not_recorded',
          },
        },
        {
          op: 'upsert',
          table: 'record_details',
          values: {
            id: 'r1',
            project_id: 'p1',
            detail_scope: 'd1',
            value: PROTECTED_VALUE,
          },
        },
        {
          op: 'upsert',
          table: 'notes',
          values: { id: 'n1', project_id: 'p1', body: 'shared note' },
        },
      ]);
      await syncIdle(writer);

      // The key-holding writer reads its own plaintext back, and the server
      // holds a non-NULL envelope: the fixture is not a masked null.
      const writerDetail = (await writer.api.readRows('record_details')).find(
        (r) => r.values.id === 'r1',
      );
      checkEqual(
        writerDetail?.values.value,
        PROTECTED_VALUE,
        'the key-holding writer reads the protected value plaintext',
      );
      const serverDetail = (await ctx.server.readRows('record_details')).find(
        (r) => r.rowId === 'r1',
      );
      check(serverDetail !== undefined, 'the sidecar row exists on the server');
      const serverValue = serverDetail?.values.value;
      check(
        typeof serverValue === 'object' &&
          serverValue !== null &&
          '$bytes' in serverValue,
        'the server sidecar value is a non-NULL envelope',
      );
      check(
        !(serverValue as { $bytes: string }).$bytes.includes(
          utf8Hex(PROTECTED_VALUE),
        ),
        'the server sidecar value is ciphertext, not plaintext',
      );

      // The no-key client is authorized for both scopes but subscribes to
      // the primary and to an unrelated plaintext table only: subscribing to
      // the sidecar would abort the round (the negative case covers that).
      const reader = await ctx.newClient({
        actorId: 'reader',
        clientId: 'client-no-key',
        schema: SIDECAR_SCHEMA,
        allowed: SIDECAR_ALLOWED,
        encryption: { keys: {} },
      });
      await reader.api.subscribe({
        id: 'primary',
        table: 'records',
        scopes: PRIMARY_SCOPES,
      });
      await reader.api.subscribe({
        id: 'related',
        table: 'notes',
        scopes: PRIMARY_SCOPES,
      });
      await syncIdle(reader);

      const primaryRow = (await reader.api.readRows('records')).find(
        (r) => r.values.id === 'r1',
      );
      check(
        primaryRow !== undefined,
        'the no-key client received the primary row',
      );
      checkEqual(
        Object.keys(primaryRow?.values ?? {}).sort(),
        ['id', 'project_id', 'status_reason_state', 'title'],
        'the no-key client received every primary column',
      );
      checkEqual(
        primaryRow?.values.title,
        'Colonoscopy',
        'the shared primary column is readable without the key',
      );
      checkEqual(
        primaryRow?.values.status_reason_state,
        'protected_source_value',
        'the presence marker reports a recorded protected value',
      );
      // Acceptance item 5's third state (disclosure not authorized, the client
      // reports `unknown`) has no driver surface: no availability field
      // distinguishes protected-unavailable from absent, so it cannot be
      // asserted here. The two authorized marker states are covered.
      const unrecordedRow = (await reader.api.readRows('records')).find(
        (r) => r.values.id === 'r2',
      );
      checkEqual(
        unrecordedRow?.values.status_reason_state,
        'not_recorded',
        'the presence marker distinguishes a row with no recorded value',
      );

      // An unrelated subscription in the same round is not starved by the
      // sidecar work in that commit.
      const noteRow = (await reader.api.readRows('notes')).find(
        (r) => r.values.id === 'n1',
      );
      checkEqual(
        noteRow?.values.body,
        'shared note',
        'the unrelated subscription survived the round intact',
      );

      // The sidecar is isolated by the reader's table projection: it never
      // yields a sidecar row, so no decrypt runs here. Structural absence of
      // the sidecar table is the assertion, not decrypt-failure semantics.
      const readerDetails = await reader.api.readRows('record_details');
      checkEqual(
        readerDetails.length,
        0,
        'the primary-only subscriber received no sidecar row',
      );
      checkEqual(
        (await reader.api.subscriptionState('primary'))?.status,
        'active',
        'the primary subscription is active after the round',
      );
      checkEqual(
        (await reader.api.subscriptionState('related'))?.status,
        'active',
        'the unrelated subscription is active after the round',
      );

      // The no-key client cannot mutate the protected value: the encode seam
      // rejects the commit with no key to encrypt under, and the commit never
      // reaches the server.
      await reader.api.mutate([
        {
          op: 'upsert',
          table: 'record_details',
          values: {
            id: 'r1',
            project_id: 'p1',
            detail_scope: 'd1',
            value: 'tampered',
          },
        },
      ]);
      await syncIdle(reader);
      const rejections = await reader.api.rejections();
      checkEqual(
        rejections.length,
        1,
        'one durable keyless-mutation rejection',
      );
      checkEqual(
        rejections[0]?.code,
        'client.encrypt_failed',
        'a keyless mutation of the protected value is rejected at encode',
      );
      checkEqual(
        (await reader.api.pendingCommitIds()).length,
        0,
        'the rejected keyless mutation left the outbox',
      );
      const serverAfter = (await ctx.server.readRows('record_details')).find(
        (r) => r.rowId === 'r1',
      );
      checkEqual(
        serverAfter?.values.value,
        serverValue,
        'the server protected value is unchanged after the keyless mutation',
      );
    },
  },
  {
    // §5.11 sidecar negative case: a no-key client that DOES subscribe to the
    // encrypted sidecar must fail closed with `client.decrypt_failed` and must
    // not apply the protected row. This is what proves the value is neither
    // NULL-masked nor stored as envelope bytes: a NULL-mask implementation
    // would apply a row and raise nothing.
    name: 'encryption/sidecar-no-key-subscribe-fails',
    specRefs: ['§5.11', '§10.3'],
    server: SIDECAR_SERVER,
    async run(ctx: ScenarioContext) {
      const writer = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-writer',
        schema: SIDECAR_SCHEMA,
        allowed: SIDECAR_ALLOWED,
        encryption: writerKeys,
      });
      await writer.api.subscribe({
        id: 'primary',
        table: 'records',
        scopes: PRIMARY_SCOPES,
      });
      await writer.api.subscribe({
        id: 'sidecar',
        table: 'record_details',
        scopes: DETAIL_SCOPES,
      });
      await syncIdle(writer);
      await writer.api.mutate([
        {
          op: 'upsert',
          table: 'records',
          values: {
            id: 'r1',
            project_id: 'p1',
            title: 'Colonoscopy',
            status_reason_state: 'protected_source_value',
          },
        },
        {
          op: 'upsert',
          table: 'record_details',
          values: {
            id: 'r1',
            project_id: 'p1',
            detail_scope: 'd1',
            value: PROTECTED_VALUE,
          },
        },
      ]);
      await syncIdle(writer);

      const reader = await ctx.newClient({
        actorId: 'reader',
        clientId: 'client-no-key-negative',
        schema: SIDECAR_SCHEMA,
        allowed: SIDECAR_ALLOWED,
        encryption: { keys: {} },
      });
      await reader.api.subscribe({
        id: 'sidecar',
        table: 'record_details',
        scopes: DETAIL_SCOPES,
      });
      await syncFails(
        reader,
        'client.decrypt_failed',
        'a no-key client subscribed to the encrypted sidecar fails closed',
      );
      checkEqual(
        (await reader.api.readRows('record_details')).length,
        0,
        'the undecryptable sidecar row was not applied as NULL or raw bytes',
      );
    },
  },
];
