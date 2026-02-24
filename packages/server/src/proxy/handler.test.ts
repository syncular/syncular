import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../../server-dialect-sqlite/src';
import { ensureSyncSchema } from '../migrate';
import type { SyncCoreDb } from '../schema';
import { createProxyHandlerCollection } from './collection';
import { executeProxyQuery } from './handler';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface ProxyTestDb extends SyncCoreDb {
  tasks: TasksTable;
}

describe('executeProxyQuery', () => {
  let db: Kysely<ProxyTestDb>;
  const dialect = createSqliteServerDialect();
  const handlers = createProxyHandlerCollection([
    {
      table: 'tasks',
      computeScopes: (row) => ({
        user_id: String(row.user_id),
      }),
    },
  ]);

  beforeEach(async () => {
    db = createDatabase<ProxyTestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);

    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) => col.notNull())
      .execute();

    await db
      .insertInto('tasks')
      .values({
        id: 't1',
        user_id: 'u1',
        title: 'old title',
        server_version: 1,
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('tracks comment-prefixed mutations in the sync oplog', async () => {
    const result = await executeProxyQuery({
      db,
      dialect,
      handlers,
      ctx: { actorId: 'actor-1', clientId: 'proxy-client-1' },
      sqlQuery:
        '/* admin */ UPDATE tasks SET title = $1, server_version = server_version + 1 WHERE id = $2',
      parameters: ['new title', 't1'],
    });

    expect(result.rowCount).toBe(1);
    expect(result.commitSeq).toBeGreaterThan(0);

    const commitCount = await db
      .selectFrom('sync_commits')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(commitCount.count)).toBe(1);

    const changeCount = await db
      .selectFrom('sync_changes')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(changeCount.count)).toBe(1);

    const updated = await db
      .selectFrom('tasks')
      .select(['title', 'server_version'])
      .where('id', '=', 't1')
      .executeTakeFirstOrThrow();
    expect(updated.title).toBe('new title');
    expect(updated.server_version).toBe(2);
  });

  it('rejects non-wildcard RETURNING on synced-table mutations', async () => {
    await expect(
      executeProxyQuery({
        db,
        dialect,
        handlers,
        ctx: { actorId: 'actor-1', clientId: 'proxy-client-1' },
        sqlQuery: 'UPDATE tasks SET title = $1 WHERE id = $2 RETURNING id',
        parameters: ['blocked title', 't1'],
      })
    ).rejects.toThrow(
      'Proxy mutation on synced table "tasks" must use RETURNING * (or omit RETURNING)'
    );

    const commitCount = await db
      .selectFrom('sync_commits')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(commitCount.count)).toBe(0);

    const row = await db
      .selectFrom('tasks')
      .select(['title'])
      .where('id', '=', 't1')
      .executeTakeFirstOrThrow();
    expect(row.title).toBe('old title');
  });
});
