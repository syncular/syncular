import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase, type SyncPushRequest } from '@syncular/core';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../server-dialect-sqlite/src';
import { createServerHandler, createServerHandlerCollection } from './handlers';
import { ensureSyncSchema } from './migrate';
import { pushCommit } from './push';
import type { SyncCoreDb } from './schema';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

const dialect = createSqliteServerDialect();

describe('push operation result error codes', () => {
  let db: ReturnType<typeof createBunSqliteDialect<TestDb>>;
  let handlers: ReturnType<typeof createServerHandlerCollection<TestDb>>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    handlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ]);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('rejects empty commits with a stable sync code', async () => {
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-empty',
        clientCommitId: 'commit-empty',
        schemaVersion: 1,
        operations: [],
      },
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.empty_commit',
          error: 'Empty commit',
          retriable: false,
        },
      ],
    });
  });

  it('rejects malformed pushes with sync.invalid_request', async () => {
    const request = {
      clientId: '',
      clientCommitId: 'commit-invalid',
      schemaVersion: 1,
      operations: [],
    } as SyncPushRequest;

    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request,
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.invalid_request',
          error: 'Invalid push request',
          retriable: false,
        },
      ],
    });
  });

  it('rejects inserts outside resolved scopes without materializing rows or changes', async () => {
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-forbidden-insert',
        clientCommitId: 'commit-forbidden-insert',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-forbidden',
            op: 'upsert',
            payload: { title: 'forbidden title', user_id: 'u2' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.forbidden',
          error: 'Forbidden',
          retriable: false,
        },
      ],
    });

    const task = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-forbidden')
      .executeTakeFirst();
    expect(task).toBeUndefined();

    const changes = await db
      .selectFrom('sync_changes')
      .select(['table', 'row_id'])
      .execute();
    expect(changes).toEqual([]);

    const tableRoutes = await db
      .selectFrom('sync_table_commits')
      .select(['table', 'commit_seq'])
      .execute();
    expect(tableRoutes).toEqual([]);

    const scopeRoutes = await db
      .selectFrom('sync_scope_commits')
      .select(['table', 'scope_key', 'commit_seq'])
      .execute();
    expect(scopeRoutes).toEqual([]);
  });

  it('fails closed when write scope resolution fails', async () => {
    const failingHandlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async () => {
          throw new Error('scope backend unavailable');
        },
      }),
    ]);

    const result = await pushCommit({
      db,
      dialect,
      handlers: failingHandlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-scope-failure',
        clientCommitId: 'commit-scope-failure',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-scope-failure',
            op: 'upsert',
            payload: { title: 'should not apply', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.forbidden',
          error: 'Forbidden',
          retriable: false,
        },
      ],
    });

    const task = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-scope-failure')
      .executeTakeFirst();
    expect(task).toBeUndefined();
  });

  it('rejects updates and deletes outside resolved scopes without leaking the row', async () => {
    await db
      .insertInto('tasks')
      .values({
        id: 'task-u2',
        user_id: 'u2',
        title: 'Owned by u2',
        server_version: 3,
      })
      .execute();

    const updateResult = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-forbidden-update',
        clientCommitId: 'commit-forbidden-update',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'upsert',
            payload: { title: 'stolen title', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(updateResult.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.forbidden',
          error: 'Forbidden',
          retriable: false,
        },
      ],
    });
    expect(JSON.stringify(updateResult.response)).not.toContain('Owned by u2');

    const deleteResult = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-forbidden-delete',
        clientCommitId: 'commit-forbidden-delete',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'delete',
            base_version: null,
          },
        ],
      },
    });

    expect(deleteResult.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.forbidden',
          error: 'Forbidden',
          retriable: false,
        },
      ],
    });
    expect(JSON.stringify(deleteResult.response)).not.toContain('Owned by u2');

    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-u2')
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      id: 'task-u2',
      user_id: 'u2',
      title: 'Owned by u2',
      server_version: 3,
    });

    const changes = await db
      .selectFrom('sync_changes')
      .select(['table', 'row_id'])
      .execute();
    expect(changes).toEqual([]);
  });

  it('stores version conflicts with a stable sync code', async () => {
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-conflict',
        clientCommitId: 'commit-seed',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'server title', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-conflict',
        clientCommitId: 'commit-stale',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'stale title', user_id: 'u1' },
            base_version: 0,
          },
        ],
      },
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'conflict',
          code: 'sync.version_conflict',
          server_version: 1,
        },
      ],
    });
  });
});
