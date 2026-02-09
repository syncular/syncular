import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import {
  type SyncPullResponse,
  SyncPullResponseSchema,
  type SyncSnapshotChunkRef,
} from '@syncular/core';
import {
  createServerHandler,
  ensureSyncSchema,
  type SnapshotChunkStorage,
  type SyncCoreDb,
} from '@syncular/server';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createBunSqliteDb } from '../../../dialect-bun-sqlite/src';
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

function mustGetFirstChunkId(payload: SyncPullResponse): string {
  const chunkId = payload.subscriptions[0]?.snapshots?.[0]?.chunks?.[0]?.id;
  if (!chunkId) {
    throw new Error('Expected pull bootstrap response to include a chunk id.');
  }
  return chunkId;
}

describe('createSyncRoutes chunkStorage wiring', () => {
  let db: Kysely<ServerDb>;
  const dialect = createSqliteServerDialect();

  beforeEach(async () => {
    db = createBunSqliteDb<ServerDb>({ path: ':memory:' });
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

  it('uses external chunk storage in /pull and serves chunks from it', async () => {
    await db
      .insertInto('tasks')
      .values({
        id: 't1',
        user_id: 'u1',
        title: 'Task 1',
        server_version: 1,
      })
      .execute();

    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    const externalChunkBodies = new Map<string, Uint8Array>();
    let storeChunkCalls = 0;
    const chunkStorage: SnapshotChunkStorage = {
      name: 'test-external',
      async storeChunk(metadata) {
        storeChunkCalls += 1;
        const ref: SyncSnapshotChunkRef = {
          id: `chunk-${storeChunkCalls}`,
          sha256: metadata.sha256,
          byteLength: metadata.body.length,
          encoding: metadata.encoding,
          compression: metadata.compression,
        };
        externalChunkBodies.set(ref.id, new Uint8Array(metadata.body));
        return ref;
      },
      async readChunk(chunkId: string) {
        const body = externalChunkBodies.get(chunkId);
        return body ? new Uint8Array(body) : null;
      },
      async findChunk() {
        return null;
      },
      async cleanupExpired() {
        return 0;
      },
    };

    const routes = createSyncRoutes({
      db,
      dialect,
      handlers: [tasksHandler],
      authenticate: async (c) => {
        const actorId = c.req.header('x-user-id');
        return actorId ? { actorId } : null;
      },
      chunkStorage,
    });

    const app = new Hono();
    app.route('/sync', routes);

    const pullResponse = await app.request(
      new Request('http://localhost/sync/pull', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': 'u1',
        },
        body: JSON.stringify({
          clientId: 'client-1',
          limitCommits: 10,
          limitSnapshotRows: 100,
          maxSnapshotPages: 1,
          subscriptions: [
            {
              id: 'sub-1',
              shape: 'tasks',
              scopes: { user_id: 'u1' },
              cursor: -1,
            },
          ],
        }),
      })
    );

    expect(pullResponse.status).toBe(200);
    const parsed = SyncPullResponseSchema.parse(await pullResponse.json());
    const chunkId = mustGetFirstChunkId(parsed);
    expect(storeChunkCalls).toBe(1);
    expect(externalChunkBodies.has(chunkId)).toBe(true);

    const storedExternal = externalChunkBodies.get(chunkId);
    if (!storedExternal) {
      throw new Error('Expected external chunk body to be stored.');
    }

    const decoded = new TextDecoder().decode(gunzipSync(storedExternal));
    const rows = decoded
      .split('\n')
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            user_id: string;
            title: string;
            server_version: number;
          }
      );

    const snapshotChunkCountRow = await db
      .selectFrom('sync_snapshot_chunks')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow();

    expect(Number(snapshotChunkCountRow.count)).toBe(0);
    expect(rows).toEqual([
      { id: 't1', user_id: 'u1', title: 'Task 1', server_version: 1 },
    ]);
  }, 10_000);
});
