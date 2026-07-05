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
];
