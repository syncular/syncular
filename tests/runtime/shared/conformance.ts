/**
 * Shared dialect conformance tests for runtime environments.
 *
 * Tests core type roundtrips (json, date, bool, bytes, nullable columns),
 * unique constraints, upsert, and transaction rollback.
 * Streaming is NOT tested here (varies by dialect; tested in tests/dialects/).
 */

import type { Kysely } from 'kysely';

export interface ConformanceDb {
  dialect_conformance: {
    id: string;
    n_int: number;
    n_bigint: number;
    bigint_text: string;
    t_text: string;
    u_unique: string;
    b_bool: boolean;
    j_json: unknown;
    j_large: unknown;
    d_date: Date;
    bytes: Uint8Array | ArrayBuffer;
    nullable_text: string | null;
    nullable_int: number | null;
    nullable_bigint: number | null;
    nullable_bool: boolean | null;
    nullable_bytes: (Uint8Array | ArrayBuffer) | null;
    nullable_json: unknown;
    nullable_date: Date | null;
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function jsonEqual(a: unknown, b: unknown, label: string): void {
  assert(JSON.stringify(a) === JSON.stringify(b), `${label} mismatch`);
}

function bytesToArray(value: Uint8Array | ArrayBuffer): number[] {
  return value instanceof Uint8Array
    ? Array.from(value)
    : Array.from(new Uint8Array(value));
}

function buildLargeJsonPayload(): unknown {
  const bigString = 'x'.repeat(64 * 1024);
  return {
    unicode: 'こんにちは 🌍 — café — 😀',
    nested: {
      ok: true,
      bigString,
      list: Array.from({ length: 2000 }, (_, i) => ({ i, v: `value-${i}` })),
    },
  };
}

async function createConformanceSchema(
  db: Kysely<ConformanceDb>
): Promise<void> {
  await db.schema
    .createTable('dialect_conformance')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('n_int', 'integer', (c) => c.notNull())
    .addColumn('n_bigint', 'integer', (c) => c.notNull())
    .addColumn('bigint_text', 'text', (c) => c.notNull())
    .addColumn('t_text', 'text', (c) => c.notNull())
    .addColumn('u_unique', 'text', (c) => c.notNull())
    .addColumn('b_bool', 'text', (c) => c.notNull())
    .addColumn('j_json', 'text', (c) => c.notNull())
    .addColumn('j_large', 'text', (c) => c.notNull())
    .addColumn('d_date', 'text', (c) => c.notNull())
    .addColumn('bytes', 'blob', (c) => c.notNull())
    .addColumn('nullable_text', 'text')
    .addColumn('nullable_int', 'integer')
    .addColumn('nullable_bigint', 'integer')
    .addColumn('nullable_bool', 'text')
    .addColumn('nullable_bytes', 'blob')
    .addColumn('nullable_json', 'text')
    .addColumn('nullable_date', 'text')
    .execute();

  await db.schema
    .createIndex('dialect_conformance_u_unique_idx')
    .ifNotExists()
    .on('dialect_conformance')
    .column('u_unique')
    .unique()
    .execute();
}

export async function runConformanceTests(
  db: Kysely<ConformanceDb>
): Promise<void> {
  await createConformanceSchema(db);

  // --- 1. Type roundtrips ---
  const now = new Date('2025-01-02T03:04:05.678Z');
  const payload = {
    a: 1,
    b: [true, null, { c: 'x', d: [1, 2, 3] }],
    e: { nested: { ok: true } },
  };
  const largePayload = buildLargeJsonPayload();
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 42]);
  const bigText = '9007199254740993';
  const tText = 'unicode: 北京 — café — 😀 — newline:\nsecond-line';

  await db
    .insertInto('dialect_conformance')
    .values({
      id: 'row-1',
      n_int: 123,
      n_bigint: 42,
      bigint_text: bigText,
      t_text: tText,
      u_unique: 'u-1',
      b_bool: true,
      j_json: payload,
      j_large: largePayload,
      d_date: now,
      bytes,
      nullable_text: null,
      nullable_int: null,
      nullable_bigint: null,
      nullable_bool: null,
      nullable_bytes: null,
      nullable_json: null,
      nullable_date: null,
    })
    .execute();

  const row = await db
    .selectFrom('dialect_conformance')
    .selectAll()
    .where('id', '=', 'row-1')
    .executeTakeFirstOrThrow();

  assert(row.n_int === 123, 'n_int mismatch');
  assert(row.bigint_text === bigText, 'bigint_text mismatch');
  assert(row.t_text === tText, 't_text mismatch');
  assert(row.u_unique === 'u-1', 'u_unique mismatch');
  jsonEqual(row.j_json, payload, 'j_json');
  jsonEqual(row.j_large, largePayload, 'j_large');
  assert(row.b_bool === true, 'b_bool mismatch');
  assert(row.d_date instanceof Date, 'd_date should be Date');
  assert((row.d_date as Date).getTime() === now.getTime(), 'd_date mismatch');
  assert(
    JSON.stringify(bytesToArray(row.bytes as Uint8Array | ArrayBuffer)) ===
      JSON.stringify(Array.from(bytes)),
    'bytes mismatch'
  );
  assert(row.nullable_json === null, 'nullable_json should be null');
  assert(row.nullable_date === null, 'nullable_date should be null');

  // --- 2. NULL toggles ---
  await db
    .insertInto('dialect_conformance')
    .values({
      id: 'nulls-1',
      n_int: -1,
      n_bigint: 1,
      bigint_text: '1',
      t_text: 'row-1',
      u_unique: 'u-null-1',
      b_bool: false,
      j_json: { ok: false },
      j_large: { big: false },
      d_date: now,
      bytes: new Uint8Array([9, 8, 7]),
      nullable_text: null,
      nullable_int: null,
      nullable_bigint: null,
      nullable_bool: null,
      nullable_bytes: null,
      nullable_json: null,
      nullable_date: null,
    })
    .execute();

  await db
    .updateTable('dialect_conformance')
    .set({
      nullable_text: 'hello',
      nullable_int: 2147483647,
      nullable_bigint: 42,
      nullable_bool: true,
      nullable_bytes: new Uint8Array([1, 2, 3, 4]),
      nullable_json: { ok: true },
      nullable_date: new Date('2025-02-03T04:05:06.007Z'),
    })
    .where('id', '=', 'nulls-1')
    .execute();

  const nulls = await db
    .selectFrom('dialect_conformance')
    .selectAll()
    .where('id', '=', 'nulls-1')
    .executeTakeFirstOrThrow();

  assert(nulls.nullable_text === 'hello', 'nullable_text mismatch');
  assert(nulls.nullable_int === 2147483647, 'nullable_int mismatch');
  assert(nulls.nullable_bigint === 42, 'nullable_bigint mismatch');
  assert(nulls.nullable_bool === true, 'nullable_bool mismatch');
  assert(nulls.nullable_bytes != null, 'nullable_bytes should not be null');
  assert(
    JSON.stringify(
      bytesToArray(nulls.nullable_bytes as Uint8Array | ArrayBuffer)
    ) === JSON.stringify([1, 2, 3, 4]),
    'nullable_bytes mismatch'
  );
  jsonEqual(nulls.nullable_json, { ok: true }, 'nullable_json');
  assert(nulls.nullable_date instanceof Date, 'nullable_date should be Date');

  // --- 3. Unique constraints + upsert ---
  await db
    .insertInto('dialect_conformance')
    .values({
      id: 'uniq-1',
      n_int: 1,
      n_bigint: 1,
      bigint_text: '1',
      t_text: 'one',
      u_unique: 'unique-key',
      b_bool: true,
      j_json: { ok: true },
      j_large: { ok: true },
      d_date: now,
      bytes: new Uint8Array([1]),
      nullable_text: null,
      nullable_int: null,
      nullable_bigint: null,
      nullable_bool: null,
      nullable_bytes: null,
      nullable_json: null,
      nullable_date: null,
    })
    .execute();

  await db
    .insertInto('dialect_conformance')
    .values({
      id: 'uniq-2',
      n_int: 2,
      n_bigint: 1,
      bigint_text: '1',
      t_text: 'two',
      u_unique: 'unique-key',
      b_bool: false,
      j_json: { ok: false },
      j_large: { ok: false },
      d_date: now,
      bytes: new Uint8Array([2]),
      nullable_text: null,
      nullable_int: null,
      nullable_bigint: null,
      nullable_bool: null,
      nullable_bytes: null,
      nullable_json: null,
      nullable_date: null,
    })
    .onConflict((oc) =>
      oc.column('u_unique').doUpdateSet({
        id: (eb) => eb.ref('excluded.id'),
        n_int: (eb) => eb.ref('excluded.n_int'),
        t_text: (eb) => eb.ref('excluded.t_text'),
        b_bool: (eb) => eb.ref('excluded.b_bool'),
      })
    )
    .execute();

  const uniq = await db
    .selectFrom('dialect_conformance')
    .select(['id', 'n_int', 't_text', 'b_bool', 'u_unique'])
    .where('u_unique', '=', 'unique-key')
    .executeTakeFirstOrThrow();

  assert(uniq.id === 'uniq-2', 'unique upsert id mismatch');
  assert(uniq.n_int === 2, 'unique upsert n_int mismatch');
  assert(uniq.t_text === 'two', 'unique upsert t_text mismatch');
  assert(uniq.b_bool === false, 'unique upsert b_bool mismatch');

  // --- 4. Transaction rollback ---
  let rolledBack = false;
  await db
    .transaction()
    .execute(async (trx) => {
      await trx
        .insertInto('dialect_conformance')
        .values({
          id: 'tx-row',
          n_int: 1,
          n_bigint: 1,
          bigint_text: '1',
          t_text: 'tx',
          u_unique: 'u-tx',
          b_bool: false,
          j_json: { ok: true },
          j_large: { ok: true },
          d_date: new Date('2025-01-01T00:00:00.000Z'),
          bytes: new Uint8Array([1, 2, 3]),
          nullable_text: null,
          nullable_int: null,
          nullable_bigint: null,
          nullable_bool: null,
          nullable_bytes: null,
          nullable_json: null,
          nullable_date: null,
        })
        .execute();
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      rolledBack = String(e).includes('rollback');
    });

  assert(rolledBack, 'expected rollback error');
  const txRow = await db
    .selectFrom('dialect_conformance')
    .select(['id'])
    .where('id', '=', 'tx-row')
    .executeTakeFirst();
  assert(txRow === undefined, 'tx-row should not persist after rollback');
}
