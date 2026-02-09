/**
 * Integration test setup for @syncular/client-react
 *
 * Provides utilities for creating test clients and servers for integration testing.
 * Based on the e2e test-utils pattern.
 */

import type {
  SyncClientDb,
  SyncClientPlugin,
  SyncTransport,
} from '@syncular/client';
import {
  ClientTableRegistry,
  ensureClientSyncSchema,
  SyncEngine,
  type SyncEngineConfig,
} from '@syncular/client';
import type { SyncOperation } from '@syncular/core';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import { createPgliteDb } from '@syncular/dialect-pglite';
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
import { type Kysely, sql } from 'kysely';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Server database schema for tests
 */
interface ServerDb extends SyncCoreDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    server_version: number;
  };
}

/**
 * Client database schema for tests (extends SyncClientDb to include sync tables)
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
  /** Full database instance with app tables (also includes sync tables) */
  db: Kysely<ServerDb>;
  dialect: ServerSyncDialect;
  handlers: TableRegistry<ServerDb>;
}

/**
 * Test client instance
 */
export interface TestClient {
  /** Full database instance with app tables (also includes sync tables) */
  db: Kysely<ClientDb>;
  engine: SyncEngine<ClientDb>;
  transport: SyncTransport;
  /** Client handler registry */
  handlers: ClientTableRegistry<ClientDb>;
}

/**
 * Server-side tasks table handler for tests
 */
const tasksServerHandler: ServerTableHandler<ServerDb> = {
  table: 'tasks',
  scopePatterns: ['user:{user_id}'],

  async resolveScopes(ctx) {
    return { user_id: ctx.actorId };
  },

  extractScopes(row: Record<string, unknown>) {
    return { user_id: String(row.user_id ?? '') };
  },

  async snapshot(ctx): Promise<{ rows: unknown[]; nextCursor: string | null }> {
    const userIdValue = ctx.scopeValues.user_id;
    const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;
    if (!userId || userId !== ctx.actorId)
      return { rows: [], nextCursor: null };

    const pageSize = Math.max(1, Math.min(10_000, ctx.limit));
    const cursor = ctx.cursor;

    const cursorFilter =
      cursor && cursor.length > 0
        ? sql`and ${sql.ref('id')} > ${sql.val(cursor)}`
        : sql``;

    const result = await sql<{
      id: string;
      title: string;
      completed: number;
      user_id: string;
      server_version: number;
    }>`
      select
        ${sql.ref('id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('user_id')},
        ${sql.ref('server_version')}
      from ${sql.table('tasks')}
      where ${sql.ref('user_id')} = ${sql.val(userId)}
      ${cursorFilter}
      order by ${sql.ref('id')} asc
      limit ${sql.val(pageSize + 1)}
    `.execute(ctx.db);

    const rows = result.rows;

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
      const existingResult = await sql<{ id: string }>`
        select ${sql.ref('id')}
        from ${sql.table('tasks')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
          and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
        limit ${sql.val(1)}
      `.execute(ctx.trx);
      const existing = existingResult.rows[0];

      if (!existing) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      await sql`
        delete from ${sql.table('tasks')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
          and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
      `.execute(ctx.trx);

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

    const payload = isRecord(op.payload) ? op.payload : {};
    const nextTitle =
      typeof payload.title === 'string' ? payload.title : undefined;
    const nextCompleted =
      typeof payload.completed === 'number' ? payload.completed : undefined;

    const existingResult = await sql<{
      id: string;
      title: string;
      completed: number;
      server_version: number;
    }>`
      select
        ${sql.ref('id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('server_version')}
      from ${sql.table('tasks')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
        and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
    const existing = existingResult.rows[0];

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
      await sql`
        update ${sql.table('tasks')}
        set
          ${sql.ref('title')} = ${sql.val(nextTitle ?? existing.title)},
          ${sql.ref('completed')} = ${sql.val(nextCompleted ?? existing.completed)},
          ${sql.ref('server_version')} = ${sql.val(nextVersion)}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
          and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
      `.execute(ctx.trx);
    } else {
      await sql`
        insert into ${sql.table('tasks')} (
          ${sql.join([
            sql.ref('id'),
            sql.ref('title'),
            sql.ref('completed'),
            sql.ref('user_id'),
            sql.ref('server_version'),
          ])}
        ) values (
          ${sql.join([
            sql.val(op.row_id),
            sql.val(nextTitle ?? ''),
            sql.val(nextCompleted ?? 0),
            sql.val(ctx.actorId),
            sql.val(1),
          ])}
        )
      `.execute(ctx.trx);
    }

    const updatedResult = await sql<{
      id: string;
      title: string;
      completed: number;
      user_id: string;
      server_version: number;
    }>`
      select
        ${sql.ref('id')},
        ${sql.ref('title')},
        ${sql.ref('completed')},
        ${sql.ref('user_id')},
        ${sql.ref('server_version')}
      from ${sql.table('tasks')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
        and ${sql.ref('user_id')} = ${sql.val(ctx.actorId)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
    const updated = updatedResult.rows[0];
    if (!updated) {
      throw new Error(`Failed to read updated task ${op.row_id}`);
    }

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

/**
 * Create an in-memory test server with PGlite
 */
export async function createTestServer(): Promise<TestServer> {
  const db = createPgliteDb<ServerDb>();
  const dialect = createPostgresServerDialect();

  await ensureSyncSchema(db, dialect);

  // Create tasks table
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // Register handlers
  const handlers = new TableRegistry<ServerDb>();
  handlers.register(tasksServerHandler);

  return {
    db,
    dialect,
    handlers,
  };
}

/**
 * Create an in-process transport that calls server functions directly
 */
function createInProcessTransport(
  server: TestServer,
  actorId: string
): SyncTransport {
  const syncDb = server.db;

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

      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return merged;
    } finally {
      reader.releaseLock();
    }
  }

  return {
    async sync(request) {
      const result: { ok: true; push?: any; pull?: any } = { ok: true };

      if (request.push) {
        const pushed = await pushCommit({
          db: syncDb,
          dialect: server.dialect,
          handlers: server.handlers,
          actorId,
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
          db: syncDb,
          dialect: server.dialect,
          handlers: server.handlers,
          actorId,
          request: {
            clientId: request.clientId,
            ...request.pull,
          },
        });

        recordClientCursor(syncDb, server.dialect, {
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
      const chunk = await readSnapshotChunk(syncDb, request.chunkId);
      if (!chunk) {
        throw new Error(`Snapshot chunk not found: ${request.chunkId}`);
      }

      if (chunk.body instanceof Uint8Array) {
        return new Uint8Array(chunk.body);
      }

      return streamToBytes(chunk.body);
    },
  };
}

/**
 * Create an in-memory test client with SQLite
 */
export async function createTestClient(
  server: TestServer,
  options: {
    actorId: string;
    clientId: string;
    plugins?: SyncClientPlugin[];
  }
): Promise<TestClient> {
  const db = createBunSqliteDb<ClientDb>({ path: ':memory:' });

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

  // Create client handler registry
  const handlers = new ClientTableRegistry<ClientDb>();
  handlers.register({
    table: 'tasks',

    async applySnapshot(ctx, snapshot) {
      if (snapshot.isFirstPage) {
        await ctx.trx.deleteFrom('tasks').execute();
      }

      const rows = (snapshot.rows ?? []).filter(isRecord).map((row) => ({
        id: typeof row.id === 'string' ? row.id : '',
        title: typeof row.title === 'string' ? row.title : '',
        completed: typeof row.completed === 'number' ? row.completed : 0,
        user_id: typeof row.user_id === 'string' ? row.user_id : '',
        server_version:
          typeof row.server_version === 'number' ? row.server_version : 0,
      }));
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

    async clearAll(ctx) {
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

      const row = isRecord(change.row_json) ? change.row_json : {};
      const title = typeof row.title === 'string' ? row.title : '';
      const completed = typeof row.completed === 'number' ? row.completed : 0;
      const userId = typeof row.user_id === 'string' ? row.user_id : '';
      const baseVersion =
        typeof row.server_version === 'number' ? row.server_version : 0;

      await ctx.trx
        .insertInto('tasks')
        .values({
          id: change.row_id,
          title,
          completed,
          user_id: userId,
          server_version: change.row_version ?? baseVersion,
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

  const config: SyncEngineConfig<ClientDb> = {
    db,
    transport,
    handlers,
    actorId: options.actorId,
    clientId: options.clientId,
    subscriptions: [
      { id: 'my-tasks', table: 'tasks', scopes: { user_id: options.actorId } },
    ],
    pollIntervalMs: 999999, // Disable polling for tests
    realtimeEnabled: false,
    plugins: options.plugins,
  };

  const engine = new SyncEngine<ClientDb>(config);

  return { db, engine, transport, handlers };
}

/**
 * Destroy test resources
 */
export async function destroyTestClient(client: TestClient): Promise<void> {
  client.engine.destroy();
  await client.db.destroy();
}

export async function destroyTestServer(server: TestServer): Promise<void> {
  await server.db.destroy();
}
