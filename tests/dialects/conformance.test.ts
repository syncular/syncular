import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Kysely } from 'kysely';
import type { DialectConformanceDb } from './conformance-db';
import { DIALECT_HARNESSES } from './harness';
import type { JsonValue } from './json';
import { createConformanceSchema } from './schema';

function expectJsonEqual(actual: JsonValue, expected: JsonValue): void {
  expect(actual).toEqual(expected);
}

function expectDateEqual(actual: Date, expected: Date): void {
  expect(actual).toBeInstanceOf(Date);
  expect(actual.getTime()).toBe(expected.getTime());
}

function asUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function expectBytesEqual(
  actual: Uint8Array | ArrayBuffer,
  expected: Uint8Array
): void {
  expect(Array.from(asUint8Array(actual))).toEqual(Array.from(expected));
}

function buildLargeJsonPayload(): JsonValue {
  const bigString = 'x'.repeat(64 * 1024);
  return {
    unicode: 'こんにちは 🌍 — café — 😀',
    nested: {
      ok: true,
      bigString,
      list: Array.from({ length: 2000 }, (_, i) => ({
        i,
        v: `value-${i}`,
      })),
    },
  };
}

for (const dialect of DIALECT_HARNESSES) {
  describe(`dialect conformance: ${dialect.name}`, () => {
    let db: Kysely<DialectConformanceDb>;

    beforeEach(async () => {
      db = await dialect.createDb();
      await createConformanceSchema(db, dialect.kind);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('roundtrips core types (json, date, bigint, bytes, bool)', async () => {
      const now = new Date('2025-01-02T03:04:05.678Z');
      const payload: JsonValue = {
        a: 1,
        b: [true, null, { c: 'x', d: [1, 2, 3] }],
        e: { nested: { ok: true } },
      };
      const largePayload = buildLargeJsonPayload();
      const bytes = new Uint8Array([0, 1, 2, 255, 254, 42]);
      const big = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
      const safeBig = 9_007_199_254_740_991n;
      const nBigint = dialect.kind === 'sqlite' ? safeBig : big;
      const storedBigint =
        dialect.kind === 'sqlite' ? Number(nBigint) : nBigint;
      const tText = 'unicode: 北京 — café — 😀 — newline:\nsecond-line';

      await db
        .insertInto('dialect_conformance')
        .values({
          id: 'row-1',
          n_int: 123,
          n_bigint: storedBigint,
          bigint_text: big.toString(),
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

      expect(row.n_int).toBe(123);
      if (dialect.kind === 'sqlite') {
        if (typeof row.n_bigint === 'bigint') {
          expect(row.n_bigint).toBe(nBigint);
        } else {
          expect(row.n_bigint).toBe(Number(nBigint));
        }
      } else {
        expect(row.n_bigint).toBe(nBigint);
      }
      expect(row.bigint_text).toBe(big.toString());
      expect(row.t_text).toBe(tText);
      expect(row.u_unique).toBe('u-1');
      expect(row.b_bool).toBe(true);
      expectJsonEqual(row.j_json, payload);
      expectJsonEqual(row.j_large, largePayload);
      expectDateEqual(row.d_date, now);
      expectBytesEqual(row.bytes, bytes);
      expect(row.nullable_text).toBeNull();
      expect(row.nullable_int).toBeNull();
      expect(row.nullable_bigint).toBeNull();
      expect(row.nullable_bool).toBeNull();
      expect(row.nullable_bytes).toBeNull();
      expect(row.nullable_json).toBeNull();
      expect(row.nullable_date).toBeNull();
    });

    it('handles NULL toggles across types', async () => {
      const now = new Date('2025-01-02T03:04:05.678Z');
      const bytes = new Uint8Array([9, 8, 7]);
      const safeBig = 9_007_199_254_740_991n;
      const nBigint = dialect.kind === 'sqlite' ? safeBig : safeBig;
      const storedBigint =
        dialect.kind === 'sqlite' ? Number(nBigint) : nBigint;

      await db
        .insertInto('dialect_conformance')
        .values({
          id: 'nulls-1',
          n_int: -1,
          n_bigint: storedBigint,
          bigint_text: safeBig.toString(),
          t_text: 'row-1',
          u_unique: 'u-null-1',
          b_bool: false,
          j_json: { ok: false },
          j_large: { big: false },
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

      await db
        .updateTable('dialect_conformance')
        .set({
          nullable_text: 'hello',
          nullable_int: 2147483647,
          nullable_bigint: dialect.kind === 'sqlite' ? 42 : 42n,
          nullable_bool: true,
          nullable_bytes: new Uint8Array([1, 2, 3, 4]),
          nullable_json: { ok: true },
          nullable_date: new Date('2025-02-03T04:05:06.007Z'),
        })
        .where('id', '=', 'nulls-1')
        .execute();

      const row = await db
        .selectFrom('dialect_conformance')
        .selectAll()
        .where('id', '=', 'nulls-1')
        .executeTakeFirstOrThrow();

      expect(row.nullable_text).toBe('hello');
      expect(row.nullable_int).toBe(2147483647);
      if (dialect.kind === 'sqlite') {
        expect(row.nullable_bigint).toBe(42);
      } else {
        if (typeof row.nullable_bigint === 'bigint') {
          expect(row.nullable_bigint).toBe(42n);
        } else {
          expect(row.nullable_bigint).toBe(42);
        }
      }
      expect(row.nullable_bool).toBe(true);
      expect(row.nullable_bytes).not.toBeNull();
      expectBytesEqual(row.nullable_bytes!, new Uint8Array([1, 2, 3, 4]));
      expectJsonEqual(row.nullable_json!, { ok: true });
      expectDateEqual(row.nullable_date!, new Date('2025-02-03T04:05:06.007Z'));
    });

    it('supports unique constraints + conflict updates', async () => {
      const now = new Date('2025-01-02T03:04:05.678Z');
      const safeBig = 9_007_199_254_740_991n;
      const nBigint = dialect.kind === 'sqlite' ? safeBig : safeBig;
      const storedBigint =
        dialect.kind === 'sqlite' ? Number(nBigint) : nBigint;

      await db
        .insertInto('dialect_conformance')
        .values({
          id: 'uniq-1',
          n_int: 1,
          n_bigint: storedBigint,
          bigint_text: safeBig.toString(),
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
          n_bigint: storedBigint,
          bigint_text: safeBig.toString(),
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

      const row = await db
        .selectFrom('dialect_conformance')
        .select(['id', 'n_int', 't_text', 'b_bool', 'u_unique'])
        .where('u_unique', '=', 'unique-key')
        .executeTakeFirstOrThrow();

      expect(row.id).toBe('uniq-2');
      expect(row.n_int).toBe(2);
      expect(row.t_text).toBe('two');
      expect(row.b_bool).toBe(false);
      expect(row.u_unique).toBe('unique-key');
    });

    it('supports transactions (rollback does not persist)', async () => {
      await db
        .transaction()
        .execute(async (trx) => {
          await trx
            .insertInto('dialect_conformance')
            .values({
              id: 'tx-row',
              n_int: 1,
              n_bigint: dialect.kind === 'sqlite' ? 1 : 1n,
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
          expect(String(e)).toContain('rollback');
        });

      const row = await db
        .selectFrom('dialect_conformance')
        .select(['id'])
        .where('id', '=', 'tx-row')
        .executeTakeFirst();

      expect(row).toBeUndefined();
    });

    it('supports RETURNING on insert, update, and delete', async () => {
      const safeBig = 9_007_199_254_740_991n;
      const storedBigint =
        dialect.kind === 'sqlite' ? Number(safeBig) : safeBig;

      const inserted = await db
        .insertInto('dialect_conformance')
        .values({
          id: 'returning-1',
          n_int: 1,
          n_bigint: storedBigint,
          bigint_text: safeBig.toString(),
          t_text: 'before',
          u_unique: 'u-returning-1',
          b_bool: true,
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
        .returning(['id', 't_text'])
        .executeTakeFirstOrThrow();

      expect(inserted).toEqual({ id: 'returning-1', t_text: 'before' });

      const updated = await db
        .updateTable('dialect_conformance')
        .set({ t_text: 'after' })
        .where('id', '=', 'returning-1')
        .returning(['id', 't_text'])
        .executeTakeFirstOrThrow();

      expect(updated).toEqual({ id: 'returning-1', t_text: 'after' });

      const deleted = await db
        .deleteFrom('dialect_conformance')
        .where('id', '=', 'returning-1')
        .returning(['id'])
        .executeTakeFirstOrThrow();

      expect(deleted).toEqual({ id: 'returning-1' });
    });

    it('streaming behavior matches harness capability', async () => {
      const rowsToInsert = 250;

      const values = Array.from({ length: rowsToInsert }, (_, i) => ({
        id: `s-${i}`,
        n_int: i,
        n_bigint: dialect.kind === 'sqlite' ? i : BigInt(i),
        bigint_text: String(BigInt(i)),
        t_text: `t-${i}`,
        u_unique: `u-s-${i}`,
        b_bool: i % 2 === 0,
        j_json: { i } as const,
        j_large: { i, large: true } as const,
        d_date: new Date('2025-01-01T00:00:00.000Z'),
        bytes: new Uint8Array([i % 256]),
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      }));

      await db.insertInto('dialect_conformance').values(values).execute();

      const query = db
        .selectFrom('dialect_conformance')
        .select(['id', 'n_int'])
        .orderBy('n_int', 'asc');

      if (!dialect.supportsStreaming) {
        await expect(
          (async () => {
            const stream = query.stream();
            for await (const _chunk of stream) {
              // drain
            }
          })()
        ).rejects.toThrow();
        return;
      }

      let count = 0;
      const got: number[] = [];
      for await (const row of query.stream()) {
        count++;
        got.push(row.n_int);
      }

      expect(count).toBe(rowsToInsert);
      expect(got[0]).toBe(0);
      expect(got[got.length - 1]).toBe(rowsToInsert - 1);
    });

    it('streaming can be canceled early', async () => {
      const rowsToInsert = 250;

      const values = Array.from({ length: rowsToInsert }, (_, i) => ({
        id: `c-${i}`,
        n_int: i,
        n_bigint: dialect.kind === 'sqlite' ? i : BigInt(i),
        bigint_text: String(BigInt(i)),
        t_text: `t-${i}`,
        u_unique: `u-c-${i}`,
        b_bool: i % 2 === 0,
        j_json: { i } as const,
        j_large: { i, large: true } as const,
        d_date: new Date('2025-01-01T00:00:00.000Z'),
        bytes: new Uint8Array([i % 256]),
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      }));

      await db.insertInto('dialect_conformance').values(values).execute();

      const query = db
        .selectFrom('dialect_conformance')
        .select(['id', 'n_int'])
        .where('id', 'like', 'c-%')
        .orderBy('n_int', 'asc');

      if (!dialect.supportsStreaming) {
        await expect(
          (async () => {
            const stream = query.stream();
            const iterator = stream[Symbol.asyncIterator]();
            await iterator.next();
          })()
        ).rejects.toThrow();
        return;
      }

      const stream = query.stream();
      const iterator = stream[Symbol.asyncIterator]();

      const got: number[] = [];
      while (got.length < 10) {
        const next = await iterator.next();
        if (next.done) break;
        got.push(next.value.n_int);
      }

      if (typeof iterator.return === 'function') {
        await iterator.return();
      }

      expect(got.length).toBe(10);
      expect(got[0]).toBe(0);
      expect(got[got.length - 1]).toBe(9);

      const count = await db
        .selectFrom('dialect_conformance')
        .where('id', 'like', 'c-%')
        .select(({ fn }) => fn.countAll().as('count'))
        .executeTakeFirstOrThrow();

      expect(Number(count.count)).toBe(rowsToInsert);
    });
  });
}
