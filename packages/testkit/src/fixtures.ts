import {
  type ClientClearContext,
  type ClientHandlerCollection,
  type ClientSnapshotHookContext,
  type ClientTableHandler,
  enqueueOutboxCommit,
  ensureClientSyncSchema,
  type SyncClientDb,
  type SyncClientPlugin,
  SyncEngine,
  type SyncOnceOptions,
  type SyncOnceResult,
  type SyncPullOnceOptions,
  type SyncPullResponse,
  type SyncPushOnceOptions,
  type SyncPushOnceResult,
  syncOnce,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import {
  isRecord,
  type SyncCombinedResponse,
  type SyncOperation,
  type SyncSubscriptionRequest,
  type SyncTransport,
} from '@syncular/core';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import { createLibsqlDb } from '@syncular/dialect-libsql';
import { createPgliteDb } from '@syncular/dialect-pglite';
import { createSqlite3Db } from '@syncular/dialect-sqlite3';
import {
  type ApplyOperationResult,
  createServerHandlerCollection,
  type EmittedChange,
  ensureSyncSchema,
  pull,
  pushCommit,
  readSnapshotChunk,
  recordClientCursor,
  type ServerHandlerCollection,
  type ServerSyncDialect,
  type ServerTableHandler,
  type SyncCoreDb,
} from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Kysely } from 'kysely';

export type ServerDialect = 'sqlite' | 'pglite';
export type ClientDialect = 'bun-sqlite' | 'pglite';

export type TestSqliteDbDialect = 'bun-sqlite' | 'sqlite3' | 'libsql';
export type TestClientDialect = ClientDialect | 'sqlite3' | 'libsql';

export interface TasksServerDb extends SyncCoreDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    server_version: number;
  };
}

export interface TasksClientDb extends SyncClientDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    server_version: number;
  };
}

type TestAuth = { actorId: string };

export interface TestServer {
  db: Kysely<TasksServerDb>;
  dialect: ServerSyncDialect;
  handlers: ServerHandlerCollection<TasksServerDb, TestAuth>;
  destroy: () => Promise<void>;
}

export interface TestClient {
  mode: 'raw';
  db: Kysely<TasksClientDb>;
  transport: SyncTransport;
  handlers: ClientHandlerCollection<TasksClientDb>;
  actorId: string;
  clientId: string;
  enqueue: (
    args: Parameters<typeof enqueueOutboxCommit<TasksClientDb>>[1]
  ) => Promise<{ id: string; clientCommitId: string }>;
  push: (
    options?: Omit<SyncPushOnceOptions, 'clientId' | 'actorId'>
  ) => Promise<SyncPushOnceResult>;
  pull: (
    options: Omit<SyncPullOnceOptions, 'clientId' | 'actorId'>
  ) => Promise<SyncPullResponse>;
  syncOnce: (
    options: Omit<SyncOnceOptions, 'clientId' | 'actorId'>
  ) => Promise<SyncOnceResult>;
  destroy: () => Promise<void>;
}

export interface EngineTestClient extends Omit<TestClient, 'mode'> {
  mode: 'engine';
  engine: SyncEngine<TasksClientDb>;
  startEngine: () => Promise<void>;
  stopEngine: () => void;
  syncEngine: () => Promise<
    Awaited<ReturnType<SyncEngine<TasksClientDb>['sync']>>
  >;
  refreshOutboxStats: () => Promise<
    Awaited<ReturnType<SyncEngine<TasksClientDb>['refreshOutboxStats']>>
  >;
}

export interface CreateTestClientOptions {
  actorId: string;
  clientId: string;
}

export interface CreateEngineTestClientOptions extends CreateTestClientOptions {
  clientDialect?: TestClientDialect;
  plugins?: SyncClientPlugin[];
  subscriptions?: Array<Omit<SyncSubscriptionRequest, 'cursor'>>;
  pollIntervalMs?: number;
  realtimeEnabled?: boolean;
}

export interface CreateSyncFixtureOptions {
  serverDialect: ServerDialect;
  defaultClientDialect?: TestClientDialect;
  defaultMode?: 'raw' | 'engine';
  defaultSubscriptions?: Array<Omit<SyncSubscriptionRequest, 'cursor'>>;
  pollIntervalMs?: number;
  realtimeEnabled?: boolean;
}

export interface CreateSyncClientOptions {
  actorId: string;
  clientId: string;
  mode?: 'raw' | 'engine';
  clientDialect?: TestClientDialect;
  plugins?: SyncClientPlugin[];
  subscriptions?: Array<Omit<SyncSubscriptionRequest, 'cursor'>>;
}

export interface SyncFixture {
  server: TestServer;
  createClient: (
    options: CreateSyncClientOptions
  ) => Promise<TestClient | EngineTestClient>;
  destroyAll: () => Promise<void>;
}

function createTestSqliteDb<T>(
  dialect: TestSqliteDbDialect,
  options: { path?: string; url?: string } = {}
): Kysely<T> {
  if (dialect === 'bun-sqlite') {
    return createBunSqliteDb<T>({ path: options.path ?? ':memory:' });
  }

  if (dialect === 'sqlite3') {
    return createSqlite3Db<T>({ path: options.path ?? ':memory:' });
  }

  return createLibsqlDb<T>({ url: options.url ?? ':memory:' });
}

function parseTaskPayload(payload: SyncOperation['payload']): {
  title?: string;
  completed?: number;
} {
  if (!isRecord(payload)) {
    return {};
  }

  return {
    title: typeof payload.title === 'string' ? payload.title : undefined,
    completed:
      typeof payload.completed === 'number' ? payload.completed : undefined,
  };
}

const tasksServerHandler: ServerTableHandler<TasksServerDb> = {
  table: 'tasks',
  scopePatterns: ['user:{user_id}'],

  async resolveScopes(ctx) {
    return { user_id: ctx.actorId };
  },

  extractScopes(row) {
    return { user_id: String(row.user_id ?? '') };
  },

  async snapshot(ctx): Promise<{ rows: unknown[]; nextCursor: string | null }> {
    const userIdValue = ctx.scopeValues.user_id;
    const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;

    if (!userId || userId !== ctx.actorId) {
      return { rows: [], nextCursor: null };
    }

    const query = ctx.db
      .selectFrom('tasks')
      .select(['id', 'title', 'completed', 'user_id', 'server_version'])
      .where('user_id', '=', userId);

    const pageSize = Math.max(1, Math.min(10_000, ctx.limit));
    const cursor = ctx.cursor;

    const rows = await (cursor ? query.where('id', '>', cursor) : query)
      .orderBy('id', 'asc')
      .limit(pageSize + 1)
      .execute();

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore
      ? (pageRows[pageRows.length - 1]?.id ?? null)
      : null;

    return {
      rows: pageRows,
      nextCursor:
        typeof nextCursor === 'string' && nextCursor.length > 0
          ? nextCursor
          : null,
    };
  },

  async applyOperation(
    ctx,
    op: SyncOperation,
    opIndex: number
  ): Promise<ApplyOperationResult> {
    const db = ctx.trx;

    if (op.table !== 'tasks') {
      return {
        result: {
          opIndex,
          status: 'error',
          error: `UNKNOWN_TABLE:${op.table}`,
          code: 'UNKNOWN_TABLE',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    if (op.op === 'delete') {
      const existing = await db
        .selectFrom('tasks')
        .select(['id'])
        .where('id', '=', op.row_id)
        .where('user_id', '=', ctx.actorId)
        .executeTakeFirst();

      if (!existing) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      await db
        .deleteFrom('tasks')
        .where('id', '=', op.row_id)
        .where('user_id', '=', ctx.actorId)
        .execute();

      const emitted: EmittedChange = {
        table: 'tasks',
        row_id: op.row_id,
        op: 'delete',
        row_json: null,
        row_version: null,
        scopes: { user_id: ctx.actorId },
      };

      return {
        result: { opIndex, status: 'applied' },
        emittedChanges: [emitted],
      };
    }

    const payload = parseTaskPayload(op.payload);

    const existing = await db
      .selectFrom('tasks')
      .select(['id', 'title', 'completed', 'server_version'])
      .where('id', '=', op.row_id)
      .where('user_id', '=', ctx.actorId)
      .executeTakeFirst();

    if (
      existing &&
      op.base_version != null &&
      existing.server_version !== op.base_version
    ) {
      return {
        result: {
          opIndex,
          status: 'conflict',
          message: `Version conflict: server=${existing.server_version}, base=${op.base_version}`,
          server_version: existing.server_version,
          server_row: {
            id: existing.id,
            title: existing.title,
            completed: existing.completed,
            user_id: ctx.actorId,
            server_version: existing.server_version,
          },
        },
        emittedChanges: [],
      };
    }

    if (existing) {
      const nextVersion = existing.server_version + 1;

      await db
        .updateTable('tasks')
        .set({
          title: payload.title ?? existing.title,
          completed: payload.completed ?? existing.completed,
          server_version: nextVersion,
        })
        .where('id', '=', op.row_id)
        .where('user_id', '=', ctx.actorId)
        .execute();
    } else {
      await db
        .insertInto('tasks')
        .values({
          id: op.row_id,
          title: payload.title ?? '',
          completed: payload.completed ?? 0,
          user_id: ctx.actorId,
          server_version: 1,
        })
        .execute();
    }

    const updated = await db
      .selectFrom('tasks')
      .select(['id', 'title', 'completed', 'user_id', 'server_version'])
      .where('id', '=', op.row_id)
      .where('user_id', '=', ctx.actorId)
      .executeTakeFirst();

    if (!updated) {
      throw new Error('TASK_NOT_FOUND_AFTER_UPSERT');
    }

    const emitted: EmittedChange = {
      table: 'tasks',
      row_id: op.row_id,
      op: 'upsert',
      row_json: {
        id: updated.id,
        title: updated.title,
        completed: updated.completed,
        user_id: updated.user_id,
        server_version: updated.server_version,
      },
      row_version: updated.server_version,
      scopes: { user_id: ctx.actorId },
    };

    return {
      result: {
        opIndex,
        status: 'applied',
      },
      emittedChanges: [emitted],
    };
  },
};

function parseTaskSnapshotRow(value: unknown): TasksClientDb['tasks'] | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === 'string' ? value.id : null;
  const title = typeof value.title === 'string' ? value.title : null;
  const completed =
    typeof value.completed === 'number' ? value.completed : null;
  const userId = typeof value.user_id === 'string' ? value.user_id : null;
  const serverVersion =
    typeof value.server_version === 'number' ? value.server_version : null;

  if (
    id === null ||
    title === null ||
    completed === null ||
    userId === null ||
    serverVersion === null
  ) {
    return null;
  }

  return {
    id,
    title,
    completed,
    user_id: userId,
    server_version: serverVersion,
  };
}

function createTasksClientHandler(): ClientTableHandler<
  TasksClientDb,
  'tasks'
> {
  return {
    table: 'tasks',

    async onSnapshotStart(ctx: ClientSnapshotHookContext<TasksClientDb>) {
      const userIdValue = ctx.scopes.user_id;
      const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;

      if (userId) {
        await ctx.trx
          .deleteFrom('tasks')
          .where('user_id', '=', userId)
          .execute();
      }
    },

    async applySnapshot(ctx, snapshot) {
      const rows: TasksClientDb['tasks'][] = [];
      for (const row of snapshot.rows ?? []) {
        const parsed = parseTaskSnapshotRow(row);
        if (parsed) {
          rows.push(parsed);
        }
      }

      if (rows.length === 0) return;

      await ctx.trx
        .insertInto('tasks')
        .values(rows)
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            title: (eb) => eb.ref('excluded.title'),
            completed: (eb) => eb.ref('excluded.completed'),
            user_id: (eb) => eb.ref('excluded.user_id'),
            server_version: (eb) => eb.ref('excluded.server_version'),
          })
        )
        .execute();
    },

    async clearAll(ctx: ClientClearContext<TasksClientDb>) {
      const userIdValue = ctx.scopes?.user_id;
      const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;

      if (userId) {
        await ctx.trx
          .deleteFrom('tasks')
          .where('user_id', '=', userId)
          .execute();
        return;
      }

      await ctx.trx.deleteFrom('tasks').execute();
    },

    async applyChange(ctx, change) {
      if (change.op === 'delete') {
        await ctx.trx
          .deleteFrom('tasks')
          .where('id', '=', change.row_id)
          .execute();
        return;
      }

      const parsed = parseTaskSnapshotRow(change.row_json);
      const row =
        parsed ??
        ({
          id: change.row_id,
          title: '',
          completed: 0,
          user_id: '',
          server_version: change.row_version ?? 0,
        } satisfies TasksClientDb['tasks']);

      await ctx.trx
        .insertInto('tasks')
        .values({
          id: change.row_id,
          title: row.title,
          completed: row.completed,
          user_id: row.user_id,
          server_version: change.row_version ?? row.server_version,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            title: (eb) => eb.ref('excluded.title'),
            completed: (eb) => eb.ref('excluded.completed'),
            user_id: (eb) => eb.ref('excluded.user_id'),
            server_version: (eb) => eb.ref('excluded.server_version'),
          })
        )
        .execute();
    },
  };
}

async function setupTestServer(
  db: Kysely<TasksServerDb>,
  dialect: ServerSyncDialect
): Promise<TestServer> {
  await ensureSyncSchema(db, dialect);

  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  const handlers = createServerHandlerCollection<TasksServerDb, TestAuth>([
    tasksServerHandler,
  ]);

  return {
    db,
    dialect,
    handlers,
    destroy: async () => {
      await db.destroy();
    },
  };
}

function createInProcessTransport(
  server: TestServer,
  actorId: string
): SyncTransport {
  const toBytes = async (
    body: Uint8Array | ReadableStream<Uint8Array>
  ): Promise<Uint8Array> => {
    if (body instanceof Uint8Array) return body;

    const reader = body.getReader();
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
  };

  return {
    async sync(request) {
      const result: SyncCombinedResponse = { ok: true };

      if (request.push) {
        const pushed = await pushCommit({
          db: server.db,
          dialect: server.dialect,
          handlers: server.handlers,
          auth: { actorId },
          request: {
            clientId: request.clientId,
            clientCommitId: request.push.clientCommitId,
            operations: request.push.operations,
            schemaVersion: request.push.schemaVersion,
          },
        });
        result.push = pushed.response;
      }

      if (request.pull) {
        const pulled = await pull({
          db: server.db,
          dialect: server.dialect,
          handlers: server.handlers,
          auth: { actorId },
          request: {
            clientId: request.clientId,
            ...request.pull,
          },
        });

        recordClientCursor(server.db, server.dialect, {
          clientId: request.clientId,
          actorId,
          cursor: pulled.clientCursor,
          effectiveScopes: pulled.effectiveScopes,
        }).catch(() => {});

        result.pull = pulled.response;
      }

      return result;
    },

    async fetchSnapshotChunk(request) {
      const chunk = await readSnapshotChunk(server.db, request.chunkId);
      if (!chunk) {
        throw new Error(`Chunk not found: ${request.chunkId}`);
      }
      return toBytes(chunk.body);
    },
  };
}

function defaultSubscriptions(
  actorId: string
): Array<Omit<SyncSubscriptionRequest, 'cursor'>> {
  return [{ id: 'my-tasks', table: 'tasks', scopes: { user_id: actorId } }];
}

export async function createTestServer(
  serverDialect: ServerDialect
): Promise<TestServer> {
  if (serverDialect === 'pglite') {
    return setupTestServer(
      createPgliteDb<TasksServerDb>(),
      createPostgresServerDialect()
    );
  }

  return setupTestServer(
    createTestSqliteDb<TasksServerDb>('bun-sqlite'),
    createSqliteServerDialect()
  );
}

export async function createTestSqliteServer(
  dialect: TestSqliteDbDialect
): Promise<TestServer> {
  return setupTestServer(
    createTestSqliteDb<TasksServerDb>(dialect),
    createSqliteServerDialect()
  );
}

export async function createTestClient(
  clientDialect: TestClientDialect,
  server: TestServer,
  options: CreateTestClientOptions
): Promise<TestClient> {
  const db =
    clientDialect === 'pglite'
      ? createPgliteDb<TasksClientDb>()
      : createTestSqliteDb<TasksClientDb>(clientDialect);

  await ensureClientSyncSchema(db);

  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  const handlers: ClientHandlerCollection<TasksClientDb> = [
    createTasksClientHandler(),
  ];

  const transport = createInProcessTransport(server, options.actorId);

  return {
    mode: 'raw',
    db,
    transport,
    handlers,
    actorId: options.actorId,
    clientId: options.clientId,
    enqueue: (args) => enqueueOutboxCommit(db, args),
    push: (pushOptions) =>
      syncPushOnce(db, transport, {
        clientId: options.clientId,
        actorId: options.actorId,
        plugins: pushOptions?.plugins,
      }),
    pull: (pullOptions) =>
      syncPullOnce(db, transport, handlers, {
        ...pullOptions,
        clientId: options.clientId,
        actorId: options.actorId,
      }),
    syncOnce: (syncOptions) =>
      syncOnce(db, transport, handlers, {
        ...syncOptions,
        clientId: options.clientId,
        actorId: options.actorId,
      }),
    destroy: async () => {
      await db.destroy();
    },
  };
}

export async function createEngineTestClient(
  server: TestServer,
  options: CreateEngineTestClientOptions
): Promise<EngineTestClient> {
  const rawClient = await createTestClient(
    options.clientDialect ?? 'bun-sqlite',
    server,
    {
      actorId: options.actorId,
      clientId: options.clientId,
    }
  );

  const subscriptions =
    options.subscriptions ?? defaultSubscriptions(options.actorId);

  const engine = new SyncEngine<TasksClientDb>({
    db: rawClient.db,
    transport: rawClient.transport,
    handlers: rawClient.handlers,
    actorId: options.actorId,
    clientId: options.clientId,
    subscriptions,
    pollIntervalMs: options.pollIntervalMs ?? 999999,
    realtimeEnabled: options.realtimeEnabled ?? false,
    plugins: options.plugins,
  });

  return {
    ...rawClient,
    mode: 'engine',
    engine,
    startEngine: () => engine.start(),
    stopEngine: () => {
      engine.destroy();
    },
    syncEngine: () => engine.sync(),
    refreshOutboxStats: () => engine.refreshOutboxStats(),
    destroy: async () => {
      engine.destroy();
      await rawClient.db.destroy();
    },
  };
}

export async function createSyncFixture(
  options: CreateSyncFixtureOptions
): Promise<SyncFixture> {
  const server = await createTestServer(options.serverDialect);
  const createdClients: Array<TestClient | EngineTestClient> = [];

  const createClient = async (
    clientOptions: CreateSyncClientOptions
  ): Promise<TestClient | EngineTestClient> => {
    const mode = clientOptions.mode ?? options.defaultMode ?? 'raw';

    if (mode === 'engine') {
      const client = await createEngineTestClient(server, {
        actorId: clientOptions.actorId,
        clientId: clientOptions.clientId,
        clientDialect:
          clientOptions.clientDialect ?? options.defaultClientDialect,
        plugins: clientOptions.plugins,
        subscriptions:
          clientOptions.subscriptions ?? options.defaultSubscriptions,
        pollIntervalMs: options.pollIntervalMs,
        realtimeEnabled: options.realtimeEnabled,
      });
      createdClients.push(client);
      return client;
    }

    const client = await createTestClient(
      clientOptions.clientDialect ??
        options.defaultClientDialect ??
        'bun-sqlite',
      server,
      {
        actorId: clientOptions.actorId,
        clientId: clientOptions.clientId,
      }
    );
    createdClients.push(client);
    return client;
  };

  const destroyAll = async () => {
    for (const client of createdClients) {
      await client.destroy();
    }
    await server.destroy();
  };

  return { server, createClient, destroyAll };
}

export async function seedServerData(
  server: TestServer,
  options: { userId: string; count: number }
): Promise<void> {
  const rows = Array.from({ length: options.count }, (_, i) => ({
    id: `task-${i + 1}`,
    title: `Task ${i + 1}`,
    completed: 0,
    user_id: options.userId,
    server_version: 1,
  }));

  const batchSize = 1000;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await server.db.insertInto('tasks').values(batch).execute();
  }
}

export async function destroyTestClient(
  client: Pick<TestClient, 'destroy'> | Pick<EngineTestClient, 'destroy'>
): Promise<void> {
  await client.destroy();
}

export async function destroyTestServer(
  server: Pick<TestServer, 'destroy'>
): Promise<void> {
  await server.destroy();
}
