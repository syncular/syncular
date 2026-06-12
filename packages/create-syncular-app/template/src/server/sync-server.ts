import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialects/bun-sqlite';
import {
  createServerHandler,
  ensureSyncSchema,
  type SyncCoreDb,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncServer } from '@syncular/server-hono';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import type { Kysely } from 'kysely';
// Codecs and row types come from the generated client module; regenerate it
// with `bun run codegen` after changing migrations/ or syncular.app.ts.
import {
  type SyncularAppDb,
  syncularGeneratedCodecs,
} from '../generated/syncular.generated';

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

  const app = new Hono()
    .get('/health', (c) => c.json({ ok: true }))
    .route('/sync', syncRoutes);

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
