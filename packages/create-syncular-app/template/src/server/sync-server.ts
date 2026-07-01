import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '@syncular/core';
import {
  createServerHandler,
  ensureSyncSchema,
  type SyncCoreDb,
} from '@syncular/server';
import { createBunSqliteDialect } from '@syncular/server/bun-sqlite';
import { createSyncServer } from '@syncular/server/hono';
import { createSqliteServerDialect } from '@syncular/server/sqlite';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import type { Kysely } from 'kysely';
// Regenerate the generated modules with `bun run codegen` after changing
// migrations/ or syncular.app.ts.
import { syncularGeneratedCodecs } from '../generated/syncular.generated';
import type { SyncularAppDb } from '../generated/syncular.server.generated';

interface AppServerDb extends SyncCoreDb, SyncularAppDb {}

interface AppSyncServer {
  origin: string;
  close(): Promise<void>;
}

/**
 * Demo auth: every request authenticates as the same single user via a static
 * bearer token. Replace `authenticate` with your real session/token check and
 * derive `actorId` from it.
 */
const DEMO_TOKEN = 'demo-user';
const DEMO_ACTOR_ID = 'demo-user';
const smokeFailpointsEnabled =
  process.env.SYNCULAR_STARTER_SMOKE_FAILPOINTS === '1';

type SyncTransportFailpointState = {
  blockedClientIds: Set<string>;
  blockedPostCount: number;
  blockedPushCount: number;
  blockedRequestCount: number;
  lastBlockedClientId: string | null;
  lastBlockedPath: string | null;
};

type SyncTransportFailpointView = {
  blockedClientIds: string[];
  blockedPostCount: number;
  blockedPushCount: number;
  blockedRequestCount: number;
  enabled: boolean;
  lastBlockedClientId: string | null;
  lastBlockedPath: string | null;
};

export async function startSyncServer(
  options: { port?: number; databasePath?: string } = {}
): Promise<AppSyncServer> {
  const databasePath =
    options.databasePath ??
    process.env.SYNC_DB_PATH ??
    path.resolve(import.meta.dir, '../../data/sync.sqlite');
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const dialect = createSqliteServerDialect();
  const db = createDatabase<AppServerDb>({
    dialect: createBunSqliteDialect({ path: databasePath }),
    family: 'sqlite',
  });

  await ensureSyncSchema(db, dialect);
  await ensureAppTables(db);

  const { syncRoutes } = createSyncServer<AppServerDb, { actorId: string }>({
    db,
    dialect,
    sync: {
      handlers: [
        createServerHandler<
          AppServerDb,
          SyncularAppDb,
          'tasks',
          { actorId: string }
        >({
          table: 'tasks',
          scopes: ['user:{user_id}'],
          codecs: syncularGeneratedCodecs,
          resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
        }),
      ],
      authenticate: (request) => {
        const authorization = request.headers.get('authorization');
        const token = new URL(request.url).searchParams.get('token');
        if (authorization !== `Bearer ${DEMO_TOKEN}` && token !== DEMO_TOKEN) {
          return null;
        }
        return { actorId: DEMO_ACTOR_ID };
      },
    },
    routes: {
      cors: ['http://127.0.0.1:*', 'http://localhost:*'],
      rateLimit: false,
      websocket: {
        allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
        heartbeatIntervalMs: 15_000,
      },
    },
    upgradeWebSocket,
  });

  const syncTransportFailpoint = smokeFailpointsEnabled
    ? createSyncTransportFailpoint()
    : null;
  const app = new Hono().get('/health', (c) => c.json({ ok: true }));

  if (syncTransportFailpoint) {
    app
      .get('/__syncular-smoke/sync-transport', (c) =>
        c.json(syncTransportFailpoint.view())
      )
      .post('/__syncular-smoke/sync-transport', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        syncTransportFailpoint.configure(body);
        return c.json(syncTransportFailpoint.view());
      })
      .use('/sync', syncTransportFailpoint.middleware)
      .use('/sync/*', syncTransportFailpoint.middleware);
  }

  app.route('/sync', syncRoutes);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 4100,
    fetch: app.fetch,
    websocket,
    idleTimeout: 0,
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    async close() {
      server.stop(true);
      await db.destroy();
    },
  };
}

/**
 * The server owns its copy of the synced tables. Keep this in sync with
 * migrations/*.sql (the client installs the same schema locally from the
 * generated embedded migrations).
 */
async function ensureAppTables(db: Kysely<AppServerDb>) {
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('server_version', 'bigint', (col) => col.notNull().defaultTo(0))
    .execute();
}

function createSyncTransportFailpoint() {
  const state: SyncTransportFailpointState = {
    blockedClientIds: new Set(),
    blockedPostCount: 0,
    blockedPushCount: 0,
    blockedRequestCount: 0,
    lastBlockedClientId: null,
    lastBlockedPath: null,
  };

  const view = (): SyncTransportFailpointView => ({
    blockedClientIds: [...state.blockedClientIds].sort(),
    blockedPostCount: state.blockedPostCount,
    blockedPushCount: state.blockedPushCount,
    blockedRequestCount: state.blockedRequestCount,
    enabled: true,
    lastBlockedClientId: state.lastBlockedClientId,
    lastBlockedPath: state.lastBlockedPath,
  });

  const configure = (body: unknown) => {
    if (!isRecord(body)) return;
    const clientId =
      typeof body.clientId === 'string'
        ? normalizeFailpointClientId(body.clientId)
        : null;
    const blocked = body.blocked === true;
    if (body.reset === true) {
      state.blockedClientIds.clear();
      state.blockedPostCount = 0;
      state.blockedPushCount = 0;
      state.blockedRequestCount = 0;
      state.lastBlockedClientId = null;
      state.lastBlockedPath = null;
    }
    if (!clientId) return;
    if (blocked) {
      state.blockedClientIds.add(clientId);
    } else {
      state.blockedClientIds.delete(clientId);
    }
  };

  const middleware = async (
    c: Context,
    next: Next
  ): Promise<Response | undefined> => {
    if (c.req.method !== 'POST') {
      await next();
      return;
    }

    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => null);
    const clientId = readSyncTransportClientId(body);
    if (!clientId || !state.blockedClientIds.has(clientId)) {
      await next();
      return;
    }

    const pathname = new URL(c.req.url).pathname;
    state.blockedRequestCount += 1;
    state.blockedPostCount += 1;
    state.lastBlockedClientId = clientId;
    state.lastBlockedPath = pathname;
    if (isRecord(body) && isRecord(body.push)) {
      state.blockedPushCount += 1;
    }

    const origin = c.req.header('origin');
    const headers = new Headers({
      'content-type': 'application/json',
      'x-syncular-smoke-failpoint': 'sync-transport',
    });
    if (origin) {
      headers.set('access-control-allow-origin', origin);
      headers.set('vary', 'Origin');
    }

    return new Response(
      JSON.stringify({
        error: {
          code: 'sync.transport_failpoint',
          message: 'Sync transport disabled by create-syncular-app smoke test',
        },
      }),
      { headers, status: 503 }
    );
  };

  return { configure, middleware, view };
}

function readSyncTransportClientId(body: unknown): string | null {
  if (!isRecord(body) || typeof body.clientId !== 'string') return null;
  return normalizeFailpointClientId(body.clientId);
}

function normalizeFailpointClientId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
