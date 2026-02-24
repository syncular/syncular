import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type {
  ExpoSqliteBindParams,
  ExpoSqliteBindValue,
  ExpoSqliteDatabaseLike,
  ExpoSqliteRunResult,
} from './index';
import { createExpoSqliteDialect } from './index';

interface TestDb {
  tasks: {
    id: string;
    title: string;
  };
}

class FakeExpoDatabase implements ExpoSqliteDatabaseLike {
  readonly getAllSql: string[] = [];
  readonly runSql: string[] = [];
  closed = false;

  getAllSync<R>(sql: string, params: ExpoSqliteBindParams): R[];
  getAllSync<R>(sql: string, ...params: readonly ExpoSqliteBindValue[]): R[];
  getAllSync<R>(
    sql: string,
    ...paramsOrFirst:
      | readonly [ExpoSqliteBindParams]
      | readonly ExpoSqliteBindValue[]
  ): R[] {
    this.getAllSql.push(sql);
    void paramsOrFirst;
    if (/\breturning\b/i.test(sql)) {
      return [{ id: 'task-1', title: 'after' }] as R[];
    }
    return [];
  }

  runSync(sql: string, params: ExpoSqliteBindParams): ExpoSqliteRunResult;
  runSync(
    sql: string,
    ...params: readonly ExpoSqliteBindValue[]
  ): ExpoSqliteRunResult;
  runSync(
    sql: string,
    ...paramsOrFirst:
      | readonly [ExpoSqliteBindParams]
      | readonly ExpoSqliteBindValue[]
  ): ExpoSqliteRunResult {
    this.runSql.push(sql);
    void paramsOrFirst;
    return { changes: 1, lastInsertRowId: 1 };
  }

  closeSync(): void {
    this.closed = true;
  }
}

describe('expo sqlite dialect RETURNING behavior', () => {
  let fakeDb: FakeExpoDatabase;
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    fakeDb = new FakeExpoDatabase();
    db = createDatabase<TestDb>({
      dialect: createExpoSqliteDialect({ database: fakeDb }),
      family: 'sqlite',
    });
    // Run a no-op query to trigger driver init (PRAGMA statements).
    // Then clear the tracking arrays so tests only see their own SQL.
    await db
      .selectFrom('tasks' as any)
      .selectAll()
      .execute()
      .catch(() => {});
    fakeDb.getAllSql.length = 0;
    fakeDb.runSql.length = 0;
  });

  it('routes UPDATE ... RETURNING through getAllSync and returns rows', async () => {
    const updated = await db
      .updateTable('tasks')
      .set({ title: 'after' })
      .where('id', '=', 'task-1')
      .returning(['id', 'title'])
      .executeTakeFirstOrThrow();

    expect(updated).toEqual({ id: 'task-1', title: 'after' });
    expect(fakeDb.getAllSql).toHaveLength(1);
    expect(fakeDb.runSql).toHaveLength(0);
  });

  it('keeps non-returning updates on runSync', async () => {
    await db
      .updateTable('tasks')
      .set({ title: 'later' })
      .where('id', '=', 'task-1')
      .execute();

    expect(fakeDb.runSql).toHaveLength(1);
    expect(fakeDb.getAllSql).toHaveLength(0);
  });

  afterEach(async () => {
    await db.destroy();
  });
});

/**
 * Adapter that wraps bun:sqlite Database to match ExpoSqliteDatabaseLike,
 * so we can run real SQLite concurrency tests without expo-sqlite.
 */
class BunSqliteAdapter implements ExpoSqliteDatabaseLike {
  readonly #db: Database;

  constructor(path = ':memory:') {
    this.#db = new Database(path);
  }

  getAllSync<R>(sqlStr: string, params: ExpoSqliteBindParams): R[];
  getAllSync<R>(sqlStr: string, ...params: readonly ExpoSqliteBindValue[]): R[];
  getAllSync<R>(
    sqlStr: string,
    ...paramsOrFirst:
      | readonly [ExpoSqliteBindParams]
      | readonly ExpoSqliteBindValue[]
  ): R[] {
    const p = this.#resolveParams(paramsOrFirst);
    return this.#db.prepare(sqlStr).all(...p) as R[];
  }

  runSync(sqlStr: string, params: ExpoSqliteBindParams): ExpoSqliteRunResult;
  runSync(
    sqlStr: string,
    ...params: readonly ExpoSqliteBindValue[]
  ): ExpoSqliteRunResult;
  runSync(
    sqlStr: string,
    ...paramsOrFirst:
      | readonly [ExpoSqliteBindParams]
      | readonly ExpoSqliteBindValue[]
  ): ExpoSqliteRunResult {
    const p = this.#resolveParams(paramsOrFirst);
    const result = this.#db.run(sqlStr, ...p);
    return {
      changes: result.changes,
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }

  closeSync(): void {
    this.#db.close();
  }

  #resolveParams(
    paramsOrFirst:
      | readonly [ExpoSqliteBindParams]
      | readonly ExpoSqliteBindValue[]
  ): ExpoSqliteBindValue[] {
    if (paramsOrFirst.length === 1 && Array.isArray(paramsOrFirst[0])) {
      return paramsOrFirst[0] as ExpoSqliteBindValue[];
    }
    return paramsOrFirst as ExpoSqliteBindValue[];
  }
}

interface ConcurrencyDb {
  items: { id: number; value: string };
}

describe('expo sqlite dialect concurrency (real SQLite)', () => {
  let adapter: BunSqliteAdapter;
  let db: Kysely<ConcurrencyDb>;

  beforeEach(async () => {
    adapter = new BunSqliteAdapter();
    db = createDatabase<ConcurrencyDb>({
      dialect: createExpoSqliteDialect({ database: adapter }),
      family: 'sqlite',
    });
    await sql`create table items (id integer primary key, value text)`.execute(
      db
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('concurrent transaction + read does not deadlock', async () => {
    // Seed data
    for (let i = 0; i < 100; i++) {
      await db
        .insertInto('items')
        .values({ id: i, value: `v${i}` })
        .execute();
    }

    // Simulate sync engine: long-running write transaction
    const writeTx = db.transaction().execute(async (trx) => {
      for (let i = 100; i < 200; i++) {
        await trx
          .insertInto('items')
          .values({ id: i, value: `tx-${i}` })
          .execute();
      }
      // Yield to allow the concurrent read to interleave
      await new Promise((r) => setTimeout(r, 10));
      for (let i = 200; i < 300; i++) {
        await trx
          .insertInto('items')
          .values({ id: i, value: `tx-${i}` })
          .execute();
      }
    });

    // Simulate React hook: concurrent read while transaction is open
    const readResult = db.selectFrom('items').select(['id', 'value']).execute();

    // Both should complete without "database is locked"
    const [, rows] = await Promise.all([writeTx, readResult]);
    expect(rows.length).toBeGreaterThanOrEqual(100);
  });

  it('sequential write transactions complete without error', async () => {
    await db.transaction().execute(async (trx) => {
      for (let i = 0; i < 50; i++) {
        await trx
          .insertInto('items')
          .values({ id: i, value: `a-${i}` })
          .execute();
      }
    });

    await db.transaction().execute(async (trx) => {
      for (let i = 1000; i < 1050; i++) {
        await trx
          .insertInto('items')
          .values({ id: i, value: `b-${i}` })
          .execute();
      }
    });

    const { rows } = await sql<{
      cnt: number;
    }>`select count(*) as cnt from items`.execute(db);
    expect(rows[0].cnt).toBe(100);
  });
});
