/**
 * §5.11 client-side encryption, cross-core (SPEC.md §5.11; Appendix B).
 *
 * A scope-mate with the shared fixture key decrypts what the writer encrypted
 * — whichever core is on each side of the pairing (TS writes / Rust reads and
 * vice versa via the same key bytes). The server holds only ciphertext: a
 * raw-driver read asserts the stored row carries the §5.11 envelope, not
 * plaintext. A wrong-key client surfaces `client.decrypt_failed` on apply.
 */
import { decodeMessage, type PushCommitFrame } from '@syncular/core';
import { check, checkEqual } from '../checks';
import type { DriverEncryptionConfig, DriverSchema } from '../driver';
import { bytesToHex } from '../raw';
import type { Scenario, ScenarioContext } from '../scenario';
import { syncFails, syncIdle, syncOk } from './util';

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

/** The sparse push payload hex for one commit in a captured request;
 * throws when the request or payload is absent so a missing capture cannot
 * satisfy an inequality assertion. */
function pushPayloadHex(request: Uint8Array, commitId: string): string {
  const message = decodeMessage(request);
  if (message.msgKind !== 'request') throw new Error('expected a request');
  const frame = message.frames.find(
    (candidate): candidate is PushCommitFrame =>
      candidate.type === 'PUSH_COMMIT' && candidate.clientCommitId === commitId,
  );
  if (frame === undefined)
    throw new Error(`request has no push commit ${commitId}`);
  const payloads = frame.operations.map((operation) => {
    if (operation.payload === undefined)
      throw new Error(`push commit ${commitId} has a payload-less operation`);
    return bytesToHex(operation.payload);
  });
  if (payloads.length === 0)
    throw new Error(`push commit ${commitId} has no operations`);
  return payloads.join(',');
}

export const encryptionScenarios: readonly Scenario[] = [
  {
    name: 'encryption/atomic-plain-patches-without-keys',
    specRefs: ['§5.11', '§6.1', '§7.1'],
    server: {
      schema: {
        ...E2EE_SCHEMA,
        tables: E2EE_SCHEMA.tables.map((table) => ({
          ...table,
          columns: [
            ...table.columns,
            { name: 'starts', type: 'integer' as const, nullable: false },
          ],
        })),
      },
    },
    async run(ctx) {
      const schema: DriverSchema = {
        ...E2EE_SCHEMA,
        tables: E2EE_SCHEMA.tables.map((table) => ({
          ...table,
          columns: [
            ...table.columns,
            { name: 'starts', type: 'integer', nullable: false },
          ],
        })),
      };
      const writer = await ctx.newClient({
        actorId: 'writer',
        clientId: 'writer',
        schema,
        allowed: P1,
        encryption: goodKeys,
      });
      await writer.api.mutate(
        ['s1', 's2'].map((id) => ({
          op: 'upsert' as const,
          table: 'secrets',
          values: {
            id,
            project_id: 'p1',
            note: 'private',
            amount: 7,
            starts: 10,
          },
        })),
      );
      await syncIdle(writer);
      const before = await ctx.server.readRows('secrets');
      // No protected pull is requested by the locked actor; encrypting omitted
      // columns must never be attempted at its push boundary.
      const locked = await ctx.newClient({
        actorId: 'locked',
        clientId: 'locked',
        schema,
        allowed: P1,
        encryption: { keys: {} },
      });
      check(
        locked.api.executeStorageSql !== undefined,
        'the driver exposes the stored replica fixture',
      );
      // A locked replica already contains the exact ciphertext it read before
      // keys were locked. Seed those server bytes without requesting a new
      // protected pull or inventing any column values.
      const clientCore = ctx.pairing.client.name;
      check(
        clientCore === 'rust-client(rusqlite)' ||
          clientCore === 'ts-web-client(bun:sqlite)',
        'the stored-row fixture supports both reference cores',
      );
      // Rust stores the version beside the row; TS stores it separately.
      const nativeVersion = clientCore === 'rust-client(rusqlite)';
      for (const row of before) {
        const note = row.values.note;
        const amount = row.values.amount;
        check(
          typeof note === 'object' && note !== null && '$bytes' in note,
          'stored note is ciphertext',
        );
        check(
          typeof amount === 'object' && amount !== null && '$bytes' in amount,
          'stored amount is ciphertext',
        );
        await locked.api.executeStorageSql(
          `INSERT INTO secrets (id, project_id, note, amount, starts${nativeVersion ? ', _syncular_version' : ''}) VALUES ('${row.rowId}', 'p1', X'${note.$bytes}', X'${amount.$bytes}', 10${nativeVersion ? `, ${row.version}` : ''})`,
        );
      }
      await locked.api.mutate(
        ['s1', 's2'].map((id, index) => ({
          op: 'patch' as const,
          table: 'secrets',
          values: { id, starts: 20 + index },
          baseVersion: 1,
        })),
      );
      await syncIdle(locked);
      const after = await ctx.server.readRows('secrets');
      checkEqual(
        after.map((row) => row.values.starts),
        [20, 21],
        'all plain columns commit without keys',
      );
      checkEqual(
        after.map((row) => [row.values.note, row.values.amount]),
        before.map((row) => [row.values.note, row.values.amount]),
        'omitted ciphertext remains byte-identical',
      );
      checkEqual(
        await locked.api.rejections(),
        [],
        'plain batch has no key refusal',
      );
    },
  },

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
    // §5.11 + §2.3: the client re-encrypts on every send, so a lost-ACK
    // retry carries different ciphertext under the same commit ID. The
    // ID-keyed idempotency cache deduplicates it, which forbids a wire-payload
    // fingerprint.
    name: 'encryption/lost-ack-retry-dedupes-changed-ciphertext',
    specRefs: ['§5.11', '§2.3', '§6.3'],
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

      const commitId = await a.api.mutate([
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
      // The server applies, but the ack response is lost on the way back.
      a.faults.dropNextResponses = 1;
      await syncFails(
        a,
        'transport.lost',
        'lost ack after the encrypted apply',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [commitId],
        'the client keeps the unacked commit queued',
      );
      const seqAfterFirst = await ctx.server.getMaxCommitSeq();
      check(seqAfterFirst >= 1, 'the server applied the encrypted commit');
      const firstRequest = a.sentRequests[a.sentRequests.length - 1];
      check(firstRequest !== undefined, 'captured the first push request');
      const storedBeforeRetry = (await ctx.server.readRows('secrets')).find(
        (row) => row.rowId === 'r1',
      );

      const report = await syncOk(a);
      check(
        report.applied.includes(commitId),
        'the cached replay drained the outbox',
      );
      const retryRequest = a.sentRequests[a.sentRequests.length - 1];
      check(retryRequest !== undefined, 'captured the retry push request');
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the successful retry left the outbox empty',
      );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        seqAfterFirst,
        'no second commitSeq: the changed ciphertext deduplicated (§2.3)',
      );
      check(
        pushPayloadHex(firstRequest, commitId) !==
          pushPayloadHex(retryRequest, commitId),
        'the retry ciphertext changed (fresh nonce) and still deduplicated',
      );

      // The first send's ciphertext is the persisted one: the replay wrote
      // nothing, and the observer decrypts the same plaintext the writer
      // holds locally.
      const storedAfterRetry = (await ctx.server.readRows('secrets')).find(
        (row) => row.rowId === 'r1',
      );
      checkEqual(
        storedAfterRetry,
        storedBeforeRetry,
        'the replay left the stored ciphertext unchanged',
      );
      checkEqual(
        storedAfterRetry?.version,
        1,
        'the server applied the row exactly once',
      );
      check(
        typeof storedAfterRetry?.values.note === 'object' &&
          storedAfterRetry.values.note !== null &&
          '$bytes' in storedAfterRetry.values.note,
        'the server row is ciphertext',
      );
      await syncIdle(b);
      const writerRow = (await a.api.readRows('secrets')).find(
        (row) => row.values.id === 'r1',
      );
      const observerRow = (await b.api.readRows('secrets')).find(
        (row) => row.values.id === 'r1',
      );
      check(
        writerRow?.values.note === 'top secret',
        'the writer holds plaintext',
      );
      checkEqual(
        observerRow?.values.note,
        'top secret',
        'the observer decrypts the plaintext',
      );
      checkEqual(
        observerRow?.values.amount,
        42,
        'the observer decrypts amount',
      );
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

      // An existing row with no selector authors an encrypted patch locally;
      // key selection rejects at the push seam without aborting sync.
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'secrets',
          values: {
            id: 'ghost',
            project_id: 'p1',
            encryption_key_id: null,
            note: null,
          },
        },
      ]);
      await syncIdle(a);
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
  {
    // §7.1 + §5.11: the push byte budget counts the encrypted frame. A cap one
    // byte below the real encrypted request fails with the full encoded size,
    // and the request on the wire carries ciphertext, never the plaintext.
    name: 'encryption/push-byte-cap-counts-ciphertext',
    specRefs: ['§7.1', '§5.11'],
    server: E2EE_SERVER,
    async run(ctx: ScenarioContext) {
      const values = {
        id: 'r1',
        project_id: 'p1',
        note: 'top secret',
        amount: 42,
      };
      const measured = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-a',
        schema: E2EE_SCHEMA,
        allowed: P1,
        encryption: goodKeys,
      });
      await measured.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await syncIdle(measured);
      await measured.api.mutate([{ op: 'upsert', table: 'secrets', values }]);
      measured.sentRequests.length = 0;
      await syncOk(measured);
      const request = measured.sentRequests.at(-1);
      if (request === undefined) throw new Error('missing encrypted request');
      const requestBytes = request.byteLength;
      check(
        !new TextDecoder().decode(request).includes('top secret'),
        'the counted request carries ciphertext, not the plaintext',
      );

      const capped = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-b',
        schema: E2EE_SCHEMA,
        allowed: P1,
        encryption: goodKeys,
        limits: { maxPushRequestBytes: requestBytes },
      });
      await capped.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await syncIdle(capped);
      await capped.api.mutate([{ op: 'upsert', table: 'secrets', values }]);
      capped.sentRequests.length = 0;
      const admitted = await syncOk(capped);
      checkEqual(
        admitted.applied.length,
        1,
        'a cap equal to the encrypted request admits it',
      );
      const cappedRequest = capped.sentRequests.at(-1);
      if (cappedRequest === undefined)
        throw new Error('missing capped push request');
      checkEqual(
        cappedRequest.byteLength,
        requestBytes,
        'the admitted request exactly fills the byte cap',
      );
      check(
        decodeMessage(cappedRequest).frames.some(
          (frame) => frame.type === 'PUSH_COMMIT',
        ),
        'the capped request carries the push commit',
      );

      const tight = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-c',
        schema: E2EE_SCHEMA,
        allowed: P1,
        encryption: goodKeys,
        limits: { maxPushRequestBytes: requestBytes - 1 },
      });
      await tight.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await syncIdle(tight);
      const id = await tight.api.mutate([
        { op: 'upsert', table: 'secrets', values },
      ]);
      tight.sentRequests.length = 0;
      const failed = await tight.api.sync();
      check(!failed.ok, 'one byte under the encrypted size fails');
      if (!failed.ok) {
        checkEqual(
          failed.errorCode,
          'client.push_request_too_large',
          'typed capacity code',
        );
        checkEqual(failed.details?.kind, 'bytes', 'byte kind');
        checkEqual(
          failed.details?.size,
          requestBytes,
          'the reported size is the encrypted request',
        );
        checkEqual(failed.details?.clientCommitId, id, 'blocked commit id');
      }
      checkEqual(
        await tight.api.pendingCommitIds(),
        [id],
        'intent stays queued',
      );
      checkEqual(
        tight.sentRequests.length,
        0,
        'no request is sent for a blocked head',
      );
    },
  },
];
