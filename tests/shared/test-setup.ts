/**
 * Shared test setup utilities for matrix and performance tests.
 *
 * Provides factory functions for creating servers and clients with
 * different dialect configurations.
 */

import type {
  ClientClearContext,
  ClientSnapshotHookContext,
  SyncClientDb,
  SyncTransport,
} from '@syncular/client';
import { ClientTableRegistry, ensureClientSyncSchema } from '@syncular/client';
import type {
  SyncOperation,
  SyncPullRequest,
  SyncPushRequest,
} from '@syncular/core';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import { createLibsqlDb } from '@syncular/dialect-libsql';
import { createPgliteDb } from '@syncular/dialect-pglite';
import { createSqlite3Db } from '@syncular/dialect-sqlite3';
import {
  type ApplyOperationResult,
  type EmittedChange,
  ensureSyncSchema,
  pull,
  pushCommit,
  readSnapshotChunk,
  recordClientCursor,
  type ServerSyncDialect,
  type ServerTableHandler,
  type SyncCoreDb,
  TableRegistry,
} from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Kysely } from 'kysely';

export type ServerDialect = 'sqlite' | 'pglite';
export type ClientDialect = 'bun-sqlite' | 'pglite';

export type TestSqliteDbDialect = 'bun-sqlite' | 'sqlite3' | 'libsql';
export type TestClientDialect = ClientDialect | 'sqlite3' | 'libsql';

/**
 * Server database schema for tests
 */
export interface ServerDb extends SyncCoreDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    server_version: number;
  };
}

/**
 * Client database schema for tests
 */
interface ClientDb extends SyncClientDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    server_version: number;
  };
}

/**
 * Test server instance
 */
export interface TestServer {
  db: Kysely<ServerDb>;
  dialect: ServerSyncDialect;
  shapes: TableRegistry<ServerDb>;
  destroy: () => Promise<void>;
}

/**
 * Test client instance
 */
interface TestClient {
  db: Kysely<ClientDb>;
  transport: SyncTransport;
  shapes: ClientTableRegistry<ClientDb>;
  destroy: () => Promise<void>;
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

/**
 * Server-side tasks shape handler
 */
const tasksServerShape: ServerTableHandler<ServerDb> = {
  table: 'tasks',
  scopePatterns: ['user:{user_id}'],

  async resolveScopes(ctx) {
    // In tests, user can only access their own tasks
    return { user_id: ctx.actorId };
  },

  extractScopes(row: Record<string, unknown>) {
    return { user_id: String(row.user_id ?? '') };
  },

  async snapshot(ctx): Promise<{ rows: unknown[]; nextCursor: string | null }> {
    const d = ctx.db;

    const userIdValue = ctx.scopeValues.user_id;
    const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;

    if (!userId || userId !== ctx.actorId) {
      return { rows: [], nextCursor: null };
    }

    const query = d
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
    const d = ctx.trx;

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
      const existing = await d
        .selectFrom('tasks')
        .select(['id'])
        .where('id', '=', op.row_id)
        .where('user_id', '=', ctx.actorId)
        .executeTakeFirst();

      if (!existing) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      await d
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

    const payload = (op.payload ?? {}) as {
      title?: string;
      completed?: number;
      user_id?: string;
    };

    const existing = await d
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
      await d
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
      await d
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

    const updated = await d
      .selectFrom('tasks')
      .select(['id', 'title', 'completed', 'user_id', 'server_version'])
      .where('id', '=', op.row_id)
      .where('user_id', '=', ctx.actorId)
      .executeTakeFirstOrThrow();

    const emitted: EmittedChange = {
      table: 'tasks',
      row_id: op.row_id,
      op: 'upsert',
      row_json: updated,
      row_version: updated.server_version,
      scopes: { user_id: ctx.actorId },
    };

    return {
      result: { opIndex, status: 'applied' },
      emittedChanges: [emitted],
    };
  },
};

async function setupTestServer(
  db: Kysely<ServerDb>,
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

  const shapes = new TableRegistry<ServerDb>();
  shapes.register(tasksServerShape);

  return {
    db,
    dialect,
    shapes,
    destroy: async () => {
      await db.destroy();
    },
  };
}

/**
 * Create a test server with the specified dialect
 */
export async function createTestServer(
  serverDialect: ServerDialect
): Promise<TestServer> {
  if (serverDialect === 'pglite') {
    return setupTestServer(
      createPgliteDb<ServerDb>(),
      createPostgresServerDialect()
    );
  }

  return setupTestServer(
    createTestSqliteDb<ServerDb>('bun-sqlite'),
    createSqliteServerDialect()
  );
}

export async function createTestSqliteServer(
  dialect: TestSqliteDbDialect
): Promise<TestServer> {
  return setupTestServer(
    createTestSqliteDb<ServerDb>(dialect),
    createSqliteServerDialect()
  );
}

/**
 * Create an in-process transport that calls server functions directly
 */
function createInProcessTransport(
  server: TestServer,
  actorId: string
): SyncTransport {
  return {
    async pull(request: SyncPullRequest) {
      const pulled = await pull({
        db: server.db,
        dialect: server.dialect,
        shapes: server.shapes,
        actorId,
        request,
      });

      await recordClientCursor(server.db, server.dialect, {
        clientId: request.clientId,
        actorId,
        cursor: pulled.clientCursor,
        effectiveScopes: pulled.effectiveScopes,
      });

      return pulled.response;
    },

    async push(request: SyncPushRequest) {
      const pushed = await pushCommit({
        db: server.db,
        dialect: server.dialect,
        shapes: server.shapes,
        actorId,
        request,
      });
      return pushed.response;
    },

    async fetchSnapshotChunk(request) {
      const chunk = await readSnapshotChunk(server.db, request.chunkId);
      if (!chunk) throw new Error(`Chunk not found: ${request.chunkId}`);
      return chunk.body;
    },
  };
}

/**
 * Create a test client with the specified dialect
 */
export async function createTestClient(
  clientDialect: TestClientDialect,
  server: TestServer,
  options: { actorId: string; clientId: string }
): Promise<TestClient> {
  let db: Kysely<ClientDb>;

  db =
    clientDialect === 'pglite'
      ? createPgliteDb<ClientDb>()
      : createTestSqliteDb<ClientDb>(clientDialect);

  await ensureClientSyncSchema(db);

  // Create tasks table
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  const shapes = new ClientTableRegistry<ClientDb>();
  shapes.register({
    table: 'tasks',

    async onSnapshotStart(ctx: ClientSnapshotHookContext<ClientDb>) {
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
      const rows = (snapshot.rows ?? []) as ClientDb['tasks'][];
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

    async clearAll(ctx: ClientClearContext<ClientDb>) {
      // Clear only tasks matching the scopes
      const userIdValue = ctx.scopes?.user_id;
      const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;

      if (userId) {
        await ctx.trx
          .deleteFrom('tasks')
          .where('user_id', '=', userId)
          .execute();
      } else {
        await ctx.trx.deleteFrom('tasks').execute();
      }
    },

    async applyChange(ctx, change) {
      if (change.op === 'delete') {
        await ctx.trx
          .deleteFrom('tasks')
          .where('id', '=', change.row_id)
          .execute();
        return;
      }

      const row = (change.row_json ?? {}) as Partial<ClientDb['tasks']>;

      await ctx.trx
        .insertInto('tasks')
        .values({
          id: change.row_id,
          title: row.title ?? '',
          completed: row.completed ?? 0,
          user_id: row.user_id ?? '',
          server_version: change.row_version ?? row.server_version ?? 0,
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
  });

  const transport = createInProcessTransport(server, options.actorId);

  return {
    db,
    transport,
    shapes,
    destroy: async () => {
      await db.destroy();
    },
  };
}

/**
 * Seed the server with test data
 */
export async function seedServerData(
  server: TestServer,
  options: { userId: string; count: number }
): Promise<void> {
  const { userId, count } = options;

  const rows = Array.from({ length: count }, (_, i) => ({
    id: `task-${i + 1}`,
    title: `Task ${i + 1}`,
    completed: 0,
    user_id: userId,
    server_version: 1,
  }));

  // Insert in batches of 1000
  const batchSize = 1000;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await server.db.insertInto('tasks').values(batch).execute();
  }
}
