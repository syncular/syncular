import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase, type SyncChange } from '@syncular/core';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../server-dialect-sqlite/src';
import { createServerHandler, createServerHandlerCollection } from './handlers';
import { ensureSyncSchema } from './migrate';
import { pull } from './pull';
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

describe('server pull plugins', () => {
  let db: ReturnType<typeof createBunSqliteDialect<TestDb>>;

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
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('applies incremental pull change transforms before wire integrity', async () => {
    const handlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ]);

    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'writer',
        clientCommitId: 'commit-1',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'Pulled', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    const result = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'reader',
        limitCommits: 10,
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: 0,
            crdtStateVectors: [],
          },
        ],
      },
      plugins: [
        {
          name: 'test-transform',
          transformPullChanges(args) {
            return args.changes.map((change): SyncChange => {
              if (
                change.op !== 'upsert' ||
                change.table !== 'tasks' ||
                typeof change.row_json !== 'object' ||
                change.row_json === null
              ) {
                return change;
              }
              return {
                ...change,
                row_json: {
                  ...(change.row_json as Record<string, unknown>),
                  title: 'Transformed',
                },
              };
            });
          },
        },
      ],
    });

    const subscription = result.response.subscriptions[0]!;
    expect(subscription.integrity?.commitChainRoot).toMatch(/^[a-f0-9]{64}$/);
    expect(subscription.commits[0]?.changes[0]?.row_json).toMatchObject({
      title: 'Transformed',
    });
  });
});
