import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import {
  configureSyncTelemetry,
  decodeSnapshotRows,
  getSyncTelemetry,
  SyncCombinedResponseSchema,
  type SyncPullResponse,
  type SyncSnapshotChunkRef,
  type SyncSpan,
  type SyncTelemetry,
} from '@syncular/core';
import {
  createServerHandler,
  ensureSyncSchema,
  type SnapshotChunkStorage,
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

function createExceptionCaptureTelemetry(calls: {
  exceptions: Array<{
    error: unknown;
    context: Record<string, unknown> | undefined;
  }>;
}): SyncTelemetry {
  return {
    log() {},
    tracer: {
      startSpan(_options, callback) {
        const span: SyncSpan = {
          setAttribute() {},
          setAttributes() {},
          setStatus() {},
        };
        return callback(span);
      },
    },
    metrics: {
      count() {},
      gauge() {},
      distribution() {},
    },
    captureException(error, context) {
      calls.exceptions.push({ error, context });
    },
  };
}

function mustGetFirstChunkId(payload: SyncPullResponse): string {
  const chunkId = payload.subscriptions[0]?.snapshots?.[0]?.chunks?.[0]?.id;
  if (!chunkId) {
    throw new Error('Expected pull bootstrap response to include a chunk id.');
  }
  return chunkId;
}

async function streamToBytes(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } finally {
    reader.releaseLock();
  }
}

describe('createSyncRoutes chunkStorage wiring', () => {
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
      new Request('http://localhost/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': 'u1',
        },
        body: JSON.stringify({
          clientId: 'client-1',
          pull: {
            limitCommits: 10,
            limitSnapshotRows: 100,
            maxSnapshotPages: 1,
            subscriptions: [
              {
                id: 'sub-1',
                table: 'tasks',
                scopes: { user_id: 'u1' },
                cursor: -1,
              },
            ],
          },
        }),
      })
    );

    expect(pullResponse.status).toBe(200);
    const combined = SyncCombinedResponseSchema.parse(
      await pullResponse.json()
    );
    const parsed = combined.pull!;
    const chunkId = mustGetFirstChunkId(parsed);
    expect(storeChunkCalls).toBe(1);
    expect(externalChunkBodies.has(chunkId)).toBe(true);

    const storedExternal = externalChunkBodies.get(chunkId);
    if (!storedExternal) {
      throw new Error('Expected external chunk body to be stored.');
    }

    const rows = decodeSnapshotRows(gunzipSync(storedExternal));

    const snapshotChunkCountRow = await db
      .selectFrom('sync_snapshot_chunks')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow();

    expect(Number(snapshotChunkCountRow.count)).toBe(0);
    expect(rows).toEqual([
      { id: 't1', user_id: 'u1', title: 'Task 1', server_version: 1 },
    ]);
  }, 10_000);

  it('uses storeChunkStream when the adapter provides it', async () => {
    await db
      .insertInto('tasks')
      .values([
        { id: 't1', user_id: 'u1', title: 'Task 1', server_version: 1 },
        { id: 't2', user_id: 'u1', title: 'Task 2', server_version: 2 },
      ])
      .execute();

    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    const externalChunkBodies = new Map<string, Uint8Array>();
    let storeChunkCalls = 0;
    let storeChunkStreamCalls = 0;
    const chunkStorage: SnapshotChunkStorage = {
      name: 'test-external-stream',
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
      async storeChunkStream(metadata) {
        storeChunkStreamCalls += 1;
        const body = await streamToBytes(metadata.bodyStream);
        const ref: SyncSnapshotChunkRef = {
          id: `chunk-stream-${storeChunkStreamCalls}`,
          sha256: metadata.sha256,
          byteLength: body.length,
          encoding: metadata.encoding,
          compression: metadata.compression,
        };
        externalChunkBodies.set(ref.id, body);
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
      new Request('http://localhost/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': 'u1',
        },
        body: JSON.stringify({
          clientId: 'client-1',
          pull: {
            limitCommits: 10,
            limitSnapshotRows: 1,
            maxSnapshotPages: 2,
            subscriptions: [
              {
                id: 'sub-1',
                table: 'tasks',
                scopes: { user_id: 'u1' },
                cursor: -1,
              },
            ],
          },
        }),
      })
    );

    expect(pullResponse.status).toBe(200);
    const combined = SyncCombinedResponseSchema.parse(
      await pullResponse.json()
    );
    const parsed = combined.pull!;
    const chunkId = mustGetFirstChunkId(parsed);

    expect(storeChunkStreamCalls).toBe(1);
    expect(storeChunkCalls).toBe(0);
    expect(externalChunkBodies.has(chunkId)).toBe(true);

    const storedExternal = externalChunkBodies.get(chunkId);
    if (!storedExternal) {
      throw new Error('Expected external chunk body to be stored.');
    }

    const rows = decodeSnapshotRows(gunzipSync(storedExternal));
    expect(rows).toEqual([
      { id: 't1', user_id: 'u1', title: 'Task 1', server_version: 1 },
      { id: 't2', user_id: 'u1', title: 'Task 2', server_version: 2 },
    ]);
  }, 10_000);

  it('bundles multiple snapshot pages into one stored chunk', async () => {
    await db
      .insertInto('tasks')
      .values([
        { id: 't1', user_id: 'u1', title: 'Task 1', server_version: 1 },
        { id: 't2', user_id: 'u1', title: 'Task 2', server_version: 2 },
        { id: 't3', user_id: 'u1', title: 'Task 3', server_version: 3 },
      ])
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
      new Request('http://localhost/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': 'u1',
        },
        body: JSON.stringify({
          clientId: 'client-1',
          pull: {
            limitCommits: 10,
            limitSnapshotRows: 1,
            maxSnapshotPages: 3,
            subscriptions: [
              {
                id: 'sub-1',
                table: 'tasks',
                scopes: { user_id: 'u1' },
                cursor: -1,
              },
            ],
          },
        }),
      })
    );

    expect(pullResponse.status).toBe(200);
    const combined = SyncCombinedResponseSchema.parse(
      await pullResponse.json()
    );
    const parsed = combined.pull!;
    const chunkId = mustGetFirstChunkId(parsed);

    expect(parsed.subscriptions[0]?.snapshots?.length).toBe(1);
    expect(storeChunkCalls).toBe(1);

    const storedExternal = externalChunkBodies.get(chunkId);
    if (!storedExternal) {
      throw new Error('Expected external chunk body to be stored.');
    }

    const rows = decodeSnapshotRows(gunzipSync(storedExternal));

    expect(rows).toEqual([
      { id: 't1', user_id: 'u1', title: 'Task 1', server_version: 1 },
      { id: 't2', user_id: 'u1', title: 'Task 2', server_version: 2 },
      { id: 't3', user_id: 'u1', title: 'Task 3', server_version: 3 },
    ]);
  }, 10_000);

  it('captures unhandled pull exceptions via telemetry', async () => {
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

    const chunkStorageError = new Error('chunk storage failed');
    const chunkStorage: SnapshotChunkStorage = {
      name: 'failing-external',
      async storeChunk() {
        throw chunkStorageError;
      },
      async storeChunkStream() {
        throw chunkStorageError;
      },
      async readChunk() {
        return null;
      },
      async findChunk() {
        return null;
      },
      async cleanupExpired() {
        return 0;
      },
    };

    const captured = {
      exceptions: [] as Array<{
        error: unknown;
        context: Record<string, unknown> | undefined;
      }>,
    };
    const previousTelemetry = getSyncTelemetry();
    configureSyncTelemetry(createExceptionCaptureTelemetry(captured));

    try {
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

      const response = await app.request(
        new Request('http://localhost/sync', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-user-id': 'u1',
          },
          body: JSON.stringify({
            clientId: 'client-1',
            pull: {
              limitCommits: 10,
              limitSnapshotRows: 100,
              maxSnapshotPages: 1,
              subscriptions: [
                {
                  id: 'sub-1',
                  table: 'tasks',
                  scopes: { user_id: 'u1' },
                  cursor: -1,
                },
              ],
            },
          }),
        })
      );
      expect(response.status).toBe(500);

      const capturedUnhandledException = captured.exceptions.find(
        (entry) => entry.context?.event === 'sync.route.unhandled'
      );
      expect(capturedUnhandledException).toBeDefined();
      if (!capturedUnhandledException) {
        throw new Error('Expected unhandled exception telemetry entry');
      }
      expect(capturedUnhandledException.context).toEqual({
        event: 'sync.route.unhandled',
        method: 'POST',
        path: '/sync',
      });
      expect(capturedUnhandledException.error).toBe(chunkStorageError);
    } finally {
      configureSyncTelemetry(previousTelemetry);
    }
  });
});
