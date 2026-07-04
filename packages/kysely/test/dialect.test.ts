/**
 * The typed read layer against a REAL SyncClient over bun:sqlite (no server,
 * no mocks) — the loopback doctrine's local-only slice. It proves: the
 * dialect compiles Kysely to SQLite and reads real optimistic rows; writes
 * are rejected loudly (read-only rule); it works over an ASYNC query surface
 * (the handle hosts) unchanged; and table extraction feeds React's `{tables}`.
 */

import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  type SqlRow,
  type SqlValue,
  SyncClient,
  type SyncClientConfig,
} from '@syncular-v2/web-client';
import { BunClientDatabase } from '@syncular-v2/web-client/bun';
import { Kysely } from 'kysely';
import {
  assertReadOnly,
  createSyncularKysely,
  extractTables,
  SyncularDialect,
  type SyncularQuerySurface,
  SyncularReadOnlyError,
} from '../src/index';

const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'todos',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'done', type: 'boolean', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['list:{list_id}'],
    },
  ],
};

// The typed Database interface a typegen module would emit.
interface Database {
  todos: {
    id: string;
    list_id: string;
    title: string;
    done: boolean;
  };
}

/** A never-syncing client with a couple of optimistic local rows. */
async function makeLocalClient(): Promise<SyncClient> {
  const config: SyncClientConfig = {
    database: new BunClientDatabase(),
    schema: SCHEMA,
    clientId: 'test-client',
    transport: async () => {
      throw new Error('no server in this test');
    },
  };
  const client = new SyncClient(config);
  await client.start();
  client.mutate([
    {
      table: 'todos',
      op: 'upsert',
      values: { id: 't1', list_id: 'a', title: 'first', done: false },
    },
    {
      table: 'todos',
      op: 'upsert',
      values: { id: 't2', list_id: 'a', title: 'second', done: true },
    },
    {
      table: 'todos',
      op: 'upsert',
      values: { id: 't3', list_id: 'b', title: 'other list', done: false },
    },
  ]);
  return client;
}

describe('SyncularDialect reads', () => {
  test('runs a typed SELECT against a real SyncClient', async () => {
    const client = await makeLocalClient();
    const db = new Kysely<Database>({
      dialect: new SyncularDialect({ client }),
    });
    const rows = await db
      .selectFrom('todos')
      .select(['id', 'title', 'done'])
      .where('list_id', '=', 'a')
      .orderBy('id')
      .execute();
    // `done` comes back as the raw SQLite integer (0/1) — the dialect passes
    // through exactly what ClientDatabase.query returns, same as useSyncQuery.
    expect(rows).toEqual([
      { id: 't1', title: 'first', done: 0 as unknown as boolean },
      { id: 't2', title: 'second', done: 1 as unknown as boolean },
    ]);
    await client.close();
  });

  test('createSyncularKysely factory works the same', async () => {
    const client = await makeLocalClient();
    const db = createSyncularKysely<Database>(client);
    const count = await db
      .selectFrom('todos')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(3);
    await client.close();
  });

  test('works over an ASYNC query surface (handle hosts)', async () => {
    const client = await makeLocalClient();
    // Wrap the sync client as an async-only surface — what a worker handle,
    // follower, Tauri, or RN bridge exposes (query returns a Promise).
    const asyncHost: SyncularQuerySurface = {
      query: (sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]> =>
        Promise.resolve(client.query(sql, params)),
    };
    const db = createSyncularKysely<Database>(asyncHost);
    const rows = await db
      .selectFrom('todos')
      .select('title')
      .where('done', '=', true)
      .execute();
    expect(rows).toEqual([{ title: 'second' }]);
    await client.close();
  });
});

describe('read-only rule', () => {
  test('rejects INSERT at the driver, pointing to mutate()', async () => {
    const client = await makeLocalClient();
    const db = createSyncularKysely<Database>(client);
    const promise = db
      .insertInto('todos')
      .values({ id: 'x', list_id: 'a', title: 'nope', done: false })
      .execute();
    await expect(promise).rejects.toThrow(/mutate/);
    await client.close();
  });

  test('rejects UPDATE and DELETE', async () => {
    const client = await makeLocalClient();
    const db = createSyncularKysely<Database>(client);
    await expect(
      db
        .updateTable('todos')
        .set({ title: 'x' })
        .where('id', '=', 't1')
        .execute(),
    ).rejects.toThrow(SyncularReadOnlyError);
    await expect(
      db.deleteFrom('todos').where('id', '=', 't1').execute(),
    ).rejects.toThrow(SyncularReadOnlyError);
    await client.close();
  });

  test('rejects a transaction (no write path)', async () => {
    const client = await makeLocalClient();
    const db = createSyncularKysely<Database>(client);
    await expect(
      db.transaction().execute(async () => undefined),
    ).rejects.toThrow(SyncularReadOnlyError);
    await client.close();
  });

  test('assertReadOnly allowlist', () => {
    expect(() => assertReadOnly('SELECT 1')).not.toThrow();
    expect(() =>
      assertReadOnly('  \n WITH x AS (SELECT 1) SELECT * FROM x'),
    ).not.toThrow();
    expect(() => assertReadOnly('/* c */ select 1')).not.toThrow();
    expect(() => assertReadOnly('EXPLAIN QUERY PLAN SELECT 1')).not.toThrow();
    expect(() => assertReadOnly('insert into t values (1)')).toThrow(
      SyncularReadOnlyError,
    );
    expect(() => assertReadOnly('DELETE FROM t')).toThrow(
      SyncularReadOnlyError,
    );
    expect(() => assertReadOnly('')).toThrow(SyncularReadOnlyError);
  });
});

describe('table extraction', () => {
  test('extracts every table a query reads (from, join, subquery)', () => {
    const db = new Kysely<Database & { lists: { id: string } }>({
      dialect: new SyncularDialect({
        client: { query: () => [] },
      }),
    });
    const compiled = db
      .selectFrom('todos')
      .innerJoin('lists', 'lists.id', 'todos.list_id')
      .selectAll('todos')
      .compile();
    expect(new Set(extractTables(compiled))).toEqual(
      new Set(['todos', 'lists']),
    );
  });

  test('extracts tables from a CTE', () => {
    const db = createSyncularKysely<Database>({ query: () => [] });
    const compiled = db
      .with('active', (qb) =>
        qb.selectFrom('todos').where('done', '=', false).selectAll(),
      )
      .selectFrom('active')
      .selectAll()
      .compile();
    // The CTE body reads `todos`; the outer reads the CTE name `active`.
    expect(new Set(extractTables(compiled))).toEqual(
      new Set(['todos', 'active']),
    );
  });
});
