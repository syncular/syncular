/**
 * Relay runtime test — proves the relay server correctly forwards operations
 * between local clients and a main server.
 *
 * Runs entirely in-process (bun:sqlite + node:http, no wrangler).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type Server as NodeServer } from 'node:http';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import {
  createRelayRoutes,
  ensureRelaySchema,
  type RelayDatabase,
  RelayServer,
} from '@syncular/relay';
import {
  ensureSyncSchema,
  type SyncCoreDb,
  TableRegistry,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncRoutes } from '@syncular/server-hono';
import { createHttpTransport } from '@syncular/transport-http';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { getNativeFetch } from '../shared/utils';

const _fetch = getNativeFetch();

/** Random suffix so IDs are unique across test runs. */
const RUN = crypto.randomUUID().slice(0, 8);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TasksTable {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string;
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface RelayDb extends RelayDatabase {
  tasks: TasksTable;
}

// ---------------------------------------------------------------------------
// Inline tasks handler (avoids cross-workspace import issues)
// ---------------------------------------------------------------------------

import type { SyncOperation } from '@syncular/core';
import type {
  ApplyOperationResult,
  EmittedChange,
  ServerTableHandler,
} from '@syncular/server';

function createTasksHandler<
  DB extends SyncCoreDb & { tasks: TasksTable },
>(): ServerTableHandler<DB> {
  return {
    table: 'tasks',
    scopePatterns: ['user:{user_id}:project:{project_id}'],

    async resolveScopes(ctx) {
      return {
        user_id: ctx.actorId,
        project_id: Array.from({ length: 100 }, (_, i) => `p${i}`),
      };
    },

    extractScopes(row: Record<string, unknown>) {
      return {
        user_id: String(row.user_id ?? ''),
        project_id: String(row.project_id ?? ''),
      };
    },

    async snapshot(ctx) {
      const userIdValue = ctx.scopeValues.user_id;
      const projectIdValue = ctx.scopeValues.project_id;
      const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;
      const projectId = Array.isArray(projectIdValue)
        ? projectIdValue[0]
        : projectIdValue;

      if (!userId || userId !== ctx.actorId)
        return { rows: [], nextCursor: null };
      if (!projectId) return { rows: [], nextCursor: null };

      const pageSize = Math.max(1, Math.min(10_000, ctx.limit));
      const cursor = ctx.cursor;

      const cursorFilter =
        cursor && cursor.length > 0
          ? sql`and ${sql.ref('id')} > ${sql.val(cursor)}`
          : sql``;

      const result = await sql<TasksTable>`
        select id, title, completed, user_id, project_id, server_version
        from tasks
        where user_id = ${sql.val(userId)}
          and project_id = ${sql.val(projectId)}
        ${cursorFilter}
        order by id asc
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
        const existingResult = await sql<{ id: string; project_id: string }>`
          select id, project_id from tasks
          where id = ${sql.val(op.row_id)} and user_id = ${sql.val(ctx.actorId)}
          limit 1
        `.execute(ctx.trx);
        const existing = existingResult.rows[0];

        if (!existing) {
          return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
        }

        await sql`
          delete from tasks
          where id = ${sql.val(op.row_id)} and user_id = ${sql.val(ctx.actorId)}
        `.execute(ctx.trx);

        const emitted: EmittedChange = {
          table: 'tasks',
          row_id: op.row_id,
          op: 'delete',
          row_json: null,
          row_version: null,
          scopes: { user_id: ctx.actorId, project_id: existing.project_id },
        };

        return {
          result: { opIndex, status: 'applied' },
          emittedChanges: [emitted],
        };
      }

      const payload = (op.payload ?? {}) as {
        title?: string;
        completed?: number;
        project_id?: string;
      };

      const existingResult = await sql<{
        id: string;
        title: string;
        completed: number;
        project_id: string;
        server_version: number;
      }>`
        select id, title, completed, project_id, server_version
        from tasks
        where id = ${sql.val(op.row_id)} and user_id = ${sql.val(ctx.actorId)}
        limit 1
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
              project_id: existing.project_id,
              server_version: existing.server_version,
            },
          },
          emittedChanges: [],
        };
      }

      const projectId = payload.project_id ?? existing?.project_id;
      if (!projectId) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: 'MISSING_PROJECT_ID',
            code: 'INVALID_REQUEST',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      if (existing) {
        const nextVersion = existing.server_version + 1;
        await sql`
          update tasks set
            title = ${sql.val(payload.title ?? existing.title)},
            completed = ${sql.val(payload.completed ?? existing.completed)},
            server_version = ${sql.val(nextVersion)}
          where id = ${sql.val(op.row_id)} and user_id = ${sql.val(ctx.actorId)}
        `.execute(ctx.trx);
      } else {
        await sql`
          insert into tasks (id, title, completed, user_id, project_id, server_version)
          values (
            ${sql.val(op.row_id)},
            ${sql.val(payload.title ?? '')},
            ${sql.val(payload.completed ?? 0)},
            ${sql.val(ctx.actorId)},
            ${sql.val(projectId)},
            ${sql.val(1)}
          )
        `.execute(ctx.trx);
      }

      const updatedResult = await sql<TasksTable>`
        select id, title, completed, user_id, project_id, server_version
        from tasks
        where id = ${sql.val(op.row_id)} and user_id = ${sql.val(ctx.actorId)}
        limit 1
      `.execute(ctx.trx);
      const updated = updatedResult.rows[0];
      if (!updated) throw new Error('TASKS_ROW_NOT_FOUND');

      const emitted: EmittedChange = {
        table: 'tasks',
        row_id: op.row_id,
        op: 'upsert',
        row_json: {
          id: updated.id,
          title: updated.title,
          completed: updated.completed,
          user_id: updated.user_id,
          project_id: updated.project_id,
          server_version: updated.server_version,
        },
        row_version: updated.server_version,
        scopes: { user_id: ctx.actorId, project_id: updated.project_id },
      };

      return {
        result: { opIndex, status: 'applied' },
        emittedChanges: [emitted],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Server helper: bridge Hono → node:http
// ---------------------------------------------------------------------------

function serveHono(app: Hono): NodeServer {
  return createServer(async (req, res) => {
    const url = `http://localhost${req.url ?? '/'}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody
      ? await new Promise<Uint8Array>((resolve) => {
          const chunks: Uint8Array[] = [];
          req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
          req.on('end', () => {
            const total = chunks.reduce((sum, c) => sum + c.length, 0);
            const result = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              result.set(chunk, offset);
              offset += chunk.length;
            }
            resolve(result);
          });
        })
      : undefined;

    const request = new Request(url, {
      method: req.method,
      headers,
      body: body as BodyInit | undefined,
    });

    const response = await app.fetch(request);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    res.writeHead(response.status, responseHeaders);
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  });
}

// ---------------------------------------------------------------------------
// Create tasks table helper
// ---------------------------------------------------------------------------

const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    completed INTEGER NOT NULL DEFAULT 0,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    server_version INTEGER NOT NULL DEFAULT 1
  )
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Relay runtime', () => {
  const userId = `relay-test-user-${RUN}`;
  const dialect = createSqliteServerDialect();

  // Main server
  let mainDb: Kysely<ServerDb>;
  let mainApp: Hono;
  let mainHttpServer: NodeServer;
  let mainBaseUrl: string;

  // Relay server
  let relayDb: Kysely<RelayDb>;
  let relay: RelayServer<RelayDb>;
  let relayApp: Hono;
  let relayHttpServer: NodeServer;
  let relayBaseUrl: string;

  beforeAll(async () => {
    // ---- Main server ----
    mainDb = createBunSqliteDb<ServerDb>({ path: ':memory:' });
    await ensureSyncSchema(mainDb, dialect);
    await sql.raw(TASKS_DDL).execute(mainDb);

    mainApp = new Hono();
    const mainSyncRoutes = createSyncRoutes<ServerDb>({
      db: mainDb,
      dialect,
      handlers: [createTasksHandler<ServerDb>()],
      authenticate: async (c) => {
        const actorId = c.req.header('x-actor-id');
        if (!actorId) return null;
        return { actorId };
      },
      sync: { rateLimit: false },
    });
    mainApp.route('/sync', mainSyncRoutes);

    mainHttpServer = serveHono(mainApp);
    await new Promise<void>((resolve) => mainHttpServer.listen(0, resolve));
    const mainAddr = mainHttpServer.address();
    const mainPort =
      typeof mainAddr === 'object' && mainAddr ? mainAddr.port : 0;
    mainBaseUrl = `http://localhost:${mainPort}`;

    // ---- Relay server ----
    relayDb = createBunSqliteDb<RelayDb>({ path: ':memory:' });
    await ensureSyncSchema(relayDb, dialect);
    await sql.raw(TASKS_DDL).execute(relayDb);

    const mainTransport = createHttpTransport({
      baseUrl: mainBaseUrl,
      getHeaders: () => ({ 'x-actor-id': userId }),
      fetch: _fetch,
    });

    const relayHandlers = new TableRegistry<RelayDb>();
    relayHandlers.register(createTasksHandler<RelayDb>());

    // Initialize relay schema without starting background processes
    // (tests use manual pullOnce/forwardOnce to avoid race conditions)
    await ensureRelaySchema(relayDb, dialect);

    relay = new RelayServer<RelayDb>({
      db: relayDb,
      dialect,
      mainServerTransport: mainTransport,
      mainServerClientId: `relay-client-${RUN}`,
      mainServerActorId: userId,
      tables: ['tasks'],
      scopes: { user_id: userId, project_id: 'p0' },
      handlers: relayHandlers,
    });

    relayApp = new Hono();
    const relayRoutes = createRelayRoutes<RelayDb>({
      db: relayDb,
      dialect,
      handlers: relayHandlers,
      realtime: relay.getRealtime(),
      authenticate: async (c) => {
        const actorId = c.req.header('x-actor-id') ?? userId;
        return { actorId };
      },
    });
    relayApp.route('/sync', relayRoutes);

    relayHttpServer = serveHono(relayApp);
    await new Promise<void>((resolve) => relayHttpServer.listen(0, resolve));
    const relayAddr = relayHttpServer.address();
    const relayPort =
      typeof relayAddr === 'object' && relayAddr ? relayAddr.port : 0;
    relayBaseUrl = `http://localhost:${relayPort}`;
  });

  afterAll(async () => {
    await relay?.stop();
    await new Promise<void>((resolve, reject) =>
      relayHttpServer?.close((err) => (err ? reject(err) : resolve()))
    );
    await new Promise<void>((resolve, reject) =>
      mainHttpServer?.close((err) => (err ? reject(err) : resolve()))
    );
    await relayDb?.destroy();
    await mainDb?.destroy();
  });

  // -------------------------------------------------------------------------
  // 1. Main → relay: push to main, relay pulls, visible through relay
  // -------------------------------------------------------------------------

  it('main → relay: data flows from main to relay', async () => {
    const taskId = `relay-main-task-${RUN}`;

    // Bootstrap: do an initial pull so the relay establishes cursor with main
    await relay.pullOnce();

    // Push task directly to main server
    const pushRes = await _fetch(`${mainBaseUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': userId,
      },
      body: JSON.stringify({
        clientId: `main-direct-client-${RUN}`,
        push: {
          clientCommitId: `main-commit-1-${RUN}`,
          operations: [
            {
              table: 'tasks',
              row_id: taskId,
              op: 'upsert',
              payload: {
                title: 'Main Server Task',
                completed: 0,
                project_id: 'p0',
              },
              base_version: null,
            },
          ],
          schemaVersion: 1,
        },
      }),
    });

    expect(pushRes.status).toBe(200);
    const pushJson = (await pushRes.json()) as {
      ok: boolean;
      push?: { status: string };
    };
    expect(pushJson.push?.status).toBe('applied');

    // Relay pulls from main
    await relay.pullOnce();

    // Pull from relay HTTP endpoint
    const pullRes = await _fetch(`${relayBaseUrl}/sync/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': userId },
      body: JSON.stringify({
        clientId: `relay-local-client-${RUN}`,
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: userId, project_id: 'p0' },
            cursor: 0,
            bootstrapState: null,
          },
        ],
        limitCommits: 50,
      }),
    });

    expect(pullRes.status).toBe(200);
    const pullJson = (await pullRes.json()) as Record<string, unknown>;

    // The relay pull returns SyncPullResponse: { ok: true, subscriptions: [...] }
    const subscriptions = pullJson.subscriptions as Array<{
      id: string;
      commits?: Array<{
        changes: Array<{
          row_id: string;
          row_json: Record<string, unknown> | null;
        }>;
      }>;
    }>;

    const sub = subscriptions?.find((s) => s.id === 'sub-tasks');
    expect(sub).toBeDefined();
    const allChanges = sub?.commits?.flatMap((c) => c.changes) ?? [];
    const taskChange = allChanges.find((ch) => ch.row_id === taskId);
    expect(taskChange).toBeDefined();
    expect(
      (taskChange?.row_json as Record<string, unknown> | null)?.title
    ).toBe('Main Server Task');
  });

  // -------------------------------------------------------------------------
  // 2. Relay → main: push to relay, forward to main, verify in main DB
  // -------------------------------------------------------------------------

  it('relay → main: data flows from relay to main', async () => {
    const taskId = `relay-local-task-${RUN}`;

    // Push task to relay
    const pushRes = await _fetch(`${relayBaseUrl}/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': userId },
      body: JSON.stringify({
        clientId: `relay-push-client-${RUN}`,
        clientCommitId: `relay-commit-1-${RUN}`,
        operations: [
          {
            table: 'tasks',
            row_id: taskId,
            op: 'upsert',
            payload: {
              title: 'Relay Local Task',
              completed: 0,
              project_id: 'p0',
            },
            base_version: null,
          },
        ],
        schemaVersion: 1,
      }),
    });

    expect(pushRes.status).toBe(200);

    // Forward from relay to main
    await relay.forwardOnce();

    // Verify task exists in main server DB
    const result = await sql<TasksTable>`
      select * from tasks where id = ${sql.val(taskId)}
    `.execute(mainDb);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.title).toBe('Relay Local Task');
  });

  // -------------------------------------------------------------------------
  // 3. Round-trip: push to relay + push to main, relay syncs both ways
  // -------------------------------------------------------------------------

  it('round-trip: both directions sync correctly', async () => {
    const taskA = `relay-rt-task-a-${RUN}`;
    const taskB = `relay-rt-task-b-${RUN}`;

    // Push task A to relay
    await _fetch(`${relayBaseUrl}/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': userId },
      body: JSON.stringify({
        clientId: `relay-rt-client-${RUN}`,
        clientCommitId: `relay-rt-commit-a-${RUN}`,
        operations: [
          {
            table: 'tasks',
            row_id: taskA,
            op: 'upsert',
            payload: {
              title: 'RT Task A (from relay)',
              completed: 0,
              project_id: 'p0',
            },
            base_version: null,
          },
        ],
        schemaVersion: 1,
      }),
    });

    // Forward task A to main
    await relay.forwardOnce();

    // Push task B directly to main
    await _fetch(`${mainBaseUrl}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': userId,
      },
      body: JSON.stringify({
        clientId: `main-rt-client-${RUN}`,
        push: {
          clientCommitId: `main-rt-commit-b-${RUN}`,
          operations: [
            {
              table: 'tasks',
              row_id: taskB,
              op: 'upsert',
              payload: {
                title: 'RT Task B (from main)',
                completed: 0,
                project_id: 'p0',
              },
              base_version: null,
            },
          ],
          schemaVersion: 1,
        },
      }),
    });

    // Relay pulls (gets task B from main, confirms task A)
    await relay.pullOnce();

    // Both tasks should be visible through relay
    const pullRes = await _fetch(`${relayBaseUrl}/sync/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': userId },
      body: JSON.stringify({
        clientId: `relay-rt-reader-${RUN}`,
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: userId, project_id: 'p0' },
            cursor: 0,
            bootstrapState: null,
          },
        ],
        limitCommits: 100,
      }),
    });

    expect(pullRes.status).toBe(200);
    const pullJson = (await pullRes.json()) as {
      subscriptions: Array<{
        id: string;
        commits?: Array<{
          changes: Array<{
            row_id: string;
            row_json: Record<string, unknown> | null;
          }>;
        }>;
      }>;
    };

    const sub = pullJson.subscriptions?.find((s) => s.id === 'sub-tasks');
    const allChanges = sub?.commits?.flatMap((c) => c.changes) ?? [];

    const changeA = allChanges.find((ch) => ch.row_id === taskA);
    const changeB = allChanges.find((ch) => ch.row_id === taskB);

    expect(changeA).toBeDefined();
    expect((changeA?.row_json as Record<string, unknown> | null)?.title).toBe(
      'RT Task A (from relay)'
    );

    expect(changeB).toBeDefined();
    expect((changeB?.row_json as Record<string, unknown> | null)?.title).toBe(
      'RT Task B (from main)'
    );
  });
});
