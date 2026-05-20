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
