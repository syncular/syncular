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

describe('createSyncRoutes audit endpoints', () => {
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

  function createApp() {
    const routes = createSyncRoutes({
      db,
      dialect,
      handlers: [tasksHandler],
      authenticate: async (c) => {
        const actorId = c.req.header('x-user-id') ?? 'u1';
        const partitionId = c.req.header('x-partition-id') ?? 'p1';
        if (actorId === 'anon') return null;
        return { actorId, partitionId };
      },
    });

    const app = new Hono();
    app.route('/sync', routes);
    return app;
  }

  async function pushCommit(args: {
    app: Hono;
    actorId: string;
    partitionId?: string;
    clientId: string;
    clientCommitId: string;
    rowId: string;
    title: string;
  }): Promise<number> {
    const response = await args.app.request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': args.actorId,
        'x-partition-id': args.partitionId ?? 'p1',
      },
      body: JSON.stringify({
        clientId: args.clientId,
        push: {
          clientCommitId: args.clientCommitId,
          schemaVersion: 1,
          operations: [
            {
              table: 'tasks',
              row_id: args.rowId,
              op: 'upsert',
              base_version: null,
              payload: {
                id: args.rowId,
                user_id: args.actorId,
                title: args.title,
                server_version: 0,
              },
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      push?: { commitSeq?: number; status?: string };
    };
    expect(json.push?.status).toBe('applied');
    expect(typeof json.push?.commitSeq).toBe('number');
    return json.push!.commitSeq!;
  }

  it('lists commits with pagination and actor filter', async () => {
    const app = createApp();

    await pushCommit({
      app,
      actorId: 'u1',
      clientId: 'client-1',
      clientCommitId: 'commit-1',
      rowId: 't1',
      title: 'Task 1',
    });
    await pushCommit({
      app,
      actorId: 'u2',
      clientId: 'client-2',
      clientCommitId: 'commit-2',
      rowId: 't2',
      title: 'Task 2',
    });

    const page1 = await app.request(
      'http://localhost/sync/audit/commits?limit=1',
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );
    expect(page1.status).toBe(200);
    const page1Json = (await page1.json()) as {
      ok: boolean;
      commits: Array<{ actorId: string; commitSeq: number }>;
      nextCursor: number | null;
    };
    expect(page1Json.ok).toBe(true);
    expect(page1Json.commits).toHaveLength(1);
    expect(page1Json.nextCursor).not.toBeNull();

    const actorFiltered = await app.request(
      'http://localhost/sync/audit/commits?actorId=u1',
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );
    expect(actorFiltered.status).toBe(200);
    const actorJson = (await actorFiltered.json()) as {
      commits: Array<{ actorId: string }>;
    };
    expect(actorJson.commits).toHaveLength(1);
    expect(actorJson.commits[0]?.actorId).toBe('u1');
  });

  it('returns commit details scoped to partition', async () => {
    const app = createApp();

    const commitSeq = await pushCommit({
      app,
      actorId: 'u1',
      clientId: 'client-1',
      clientCommitId: 'commit-detail-1',
      rowId: 't-detail',
      title: 'Detail Task',
    });

    const detailResponse = await app.request(
      `http://localhost/sync/audit/commits/${commitSeq}`,
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p1',
        },
      }
    );

    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      ok: boolean;
      commit: { commitSeq: number; actorId: string };
      changes: Array<{ table: string; rowId: string; op: string }>;
    };
    expect(detail.ok).toBe(true);
    expect(detail.commit.commitSeq).toBe(commitSeq);
    expect(detail.commit.actorId).toBe('u1');
    expect(detail.changes).toHaveLength(1);
    expect(detail.changes[0]).toMatchObject({
      table: 'tasks',
      rowId: 't-detail',
      op: 'upsert',
    });

    const wrongPartition = await app.request(
      `http://localhost/sync/audit/commits/${commitSeq}`,
      {
        headers: {
          'x-user-id': 'u1',
          'x-partition-id': 'p2',
        },
      }
    );
    expect(wrongPartition.status).toBe(404);
  });

  it('requires authentication for audit endpoints', async () => {
    const app = createApp();

    const response = await app.request('http://localhost/sync/audit/commits', {
      headers: {
        'x-user-id': 'anon',
      },
    });

    expect(response.status).toBe(401);
  });
});
