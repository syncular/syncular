import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import {
  createServerHandler,
  ensureSyncSchema,
  type SyncCoreDb,
} from '@syncular/server';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../../server-dialect-sqlite/src';
import { type CreateSyncRoutesOptions, createSyncRoutes } from '../routes';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

describe('createSyncRoutes maintenance automation', () => {
  let db: Kysely<ServerDb>;
  const dialect = createSqliteServerDialect();

  beforeEach(async () => {
    db = createDatabase<ServerDb>({
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

  const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
    table: 'tasks',
    scopes: ['user:{user_id}'],
    resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
  });

  function createApp(
    sync: NonNullable<CreateSyncRoutesOptions<ServerDb>['sync']>
  ): Hono {
    const routes = createSyncRoutes({
      db,
      dialect,
      handlers: [tasksHandler],
      authenticate: async () => ({ actorId: 'u1' }),
      sync,
    });

    const app = new Hono();
    app.route('/sync', routes);
    return app;
  }

  function createJsonRequest(body: object): Request {
    return new Request('http://localhost/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function pushTask(
    app: Hono,
    args: { clientId: string; commitId: string; rowId: string; title: string }
  ): Promise<void> {
    const response = await app.request(
      createJsonRequest({
        clientId: args.clientId,
        push: {
          clientCommitId: args.commitId,
          schemaVersion: 1,
          operations: [
            {
              table: 'tasks',
              row_id: args.rowId,
              op: 'upsert',
              base_version: null,
              payload: {
                id: args.rowId,
                user_id: 'u1',
                title: args.title,
                server_version: 0,
              },
            },
          ],
        },
      })
    );
    expect(response.status).toBe(200);
  }

  async function triggerPull(app: Hono, clientId: string): Promise<void> {
    const response = await app.request(
      createJsonRequest({
        clientId,
        pull: {
          limitCommits: 50,
          subscriptions: [
            {
              id: 'sub-tasks',
              table: 'tasks',
              scopes: { user_id: 'u1' },
              cursor: -1,
            },
          ],
        },
      })
    );
    expect(response.status).toBe(200);
  }

  async function countRows(tableName: 'sync_commits' | 'sync_changes') {
    if (tableName === 'sync_commits') {
      const row = await db
        .selectFrom('sync_commits')
        .select((eb) => eb.fn.count<number>('commit_seq').as('c'))
        .executeTakeFirstOrThrow();
      return Number(row.c);
    }

    const row = await db
      .selectFrom('sync_changes')
      .select((eb) => eb.fn.count<number>('change_id').as('c'))
      .executeTakeFirstOrThrow();
    return Number(row.c);
  }

  async function waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs: number,
    failureMessage: string
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(failureMessage);
  }

  it('auto-prunes commits in the background when enabled', async () => {
    const app = createApp({
      rateLimit: false,
      prune: {
        minIntervalMs: 1,
        options: {
          activeWindowMs: 60_000,
          fallbackMaxAgeMs: 0,
          keepNewestCommits: 1,
        },
      },
    });

    for (let i = 1; i <= 5; i++) {
      await pushTask(app, {
        clientId: 'maintenance-client',
        commitId: `prune-commit-${i}`,
        rowId: `task-${i}`,
        title: `Task ${i}`,
      });
    }

    await sql`
      INSERT INTO sync_client_cursors (
        partition_id,
        client_id,
        actor_id,
        cursor,
        effective_scopes,
        updated_at
      ) VALUES (
        ${'default'},
        ${'maintenance-client'},
        ${'u1'},
        ${5},
        ${'{}'},
        ${new Date().toISOString()}
      )
      ON CONFLICT(partition_id, client_id) DO UPDATE SET
        actor_id = EXCLUDED.actor_id,
        cursor = EXCLUDED.cursor,
        effective_scopes = EXCLUDED.effective_scopes,
        updated_at = EXCLUDED.updated_at
    `.execute(db);

    await triggerPull(app, 'maintenance-client');

    await waitFor(
      async () => (await countRows('sync_commits')) <= 1,
      2_000,
      'expected auto-prune to reduce sync_commits'
    );

    expect(await countRows('sync_commits')).toBe(1);
  });

  it('auto-compacts old change history in the background when enabled', async () => {
    const app = createApp({
      rateLimit: false,
      compact: {
        minIntervalMs: 1,
        options: {
          fullHistoryHours: 1,
        },
      },
    });

    for (let i = 1; i <= 3; i++) {
      await pushTask(app, {
        clientId: 'compact-client',
        commitId: `compact-commit-${i}`,
        rowId: 'shared-task',
        title: `Version ${i}`,
      });
    }

    const before = await countRows('sync_changes');
    expect(before).toBeGreaterThanOrEqual(3);

    const oldIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await db.updateTable('sync_commits').set({ created_at: oldIso }).execute();

    await triggerPull(app, 'compact-client');

    await waitFor(
      async () => (await countRows('sync_changes')) < before,
      2_000,
      'expected auto-compact to reduce sync_changes'
    );

    expect(await countRows('sync_changes')).toBe(1);
  });
});
