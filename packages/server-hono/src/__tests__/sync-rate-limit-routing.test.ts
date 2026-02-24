import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import {
  createServerHandler,
  ensureSyncSchema,
  type SyncCoreDb,
} from '@syncular/server';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../../server-dialect-sqlite/src';
import { resetRateLimitStore } from '../rate-limit';
import { createSyncRoutes } from '../routes';

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

describe('createSyncRoutes rate limit routing', () => {
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
    resetRateLimitStore();
    await db.destroy();
  });

  const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
    table: 'tasks',
    scopes: ['user:{user_id}'],
    resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
  });

  const pullPayload = {
    limitCommits: 10,
    subscriptions: [
      {
        id: 'sub-1',
        table: 'tasks',
        scopes: { user_id: 'u1' },
        cursor: -1,
      },
    ],
  };

  function pushPayload(clientCommitId: string, rowId: string) {
    return {
      clientCommitId,
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: rowId,
          op: 'upsert' as const,
          base_version: null,
          payload: {
            id: rowId,
            user_id: 'u1',
            title: `Task ${rowId}`,
            server_version: 0,
          },
        },
      ],
    };
  }

  function createJsonRequest(body: object): Request {
    return new Request('http://localhost/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('does not consume push quota for pull-only requests', async () => {
    const routes = createSyncRoutes({
      db,
      dialect,
      handlers: [tasksHandler],
      authenticate: async () => ({ actorId: 'u1' }),
      sync: {
        rateLimit: {
          pull: { maxRequests: 1, windowMs: 60_000 },
          push: { maxRequests: 1, windowMs: 60_000 },
        },
      },
    });

    const app = new Hono();
    app.route('/sync', routes);

    const pullFirst = await app.request(
      createJsonRequest({
        clientId: 'client-1',
        pull: pullPayload,
      })
    );
    const pushFirst = await app.request(
      createJsonRequest({
        clientId: 'client-1',
        push: pushPayload('commit-1', 't1'),
      })
    );
    const pullSecond = await app.request(
      createJsonRequest({
        clientId: 'client-1',
        pull: pullPayload,
      })
    );
    const pushSecond = await app.request(
      createJsonRequest({
        clientId: 'client-1',
        push: pushPayload('commit-2', 't2'),
      })
    );

    expect(pullFirst.status).toBe(200);
    expect(pushFirst.status).toBe(200);
    expect(pullSecond.status).toBe(429);
    expect(pushSecond.status).toBe(429);
  });

  it('authenticates once per combined sync request with rate limiting enabled', async () => {
    let authCalls = 0;

    const routes = createSyncRoutes({
      db,
      dialect,
      handlers: [tasksHandler],
      authenticate: async () => {
        authCalls += 1;
        return { actorId: 'u1' };
      },
      sync: {
        rateLimit: {
          pull: { maxRequests: 10, windowMs: 60_000 },
          push: { maxRequests: 10, windowMs: 60_000 },
        },
      },
    });

    const app = new Hono();
    app.route('/sync', routes);

    const response = await app.request(
      createJsonRequest({
        clientId: 'client-1',
        push: pushPayload('commit-combined-1', 't-combined-1'),
        pull: pullPayload,
      })
    );

    expect(response.status).toBe(200);
    expect(authCalls).toBe(1);
  });
});
