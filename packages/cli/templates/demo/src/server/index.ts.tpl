import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import { runMigrations } from '@syncular/migrations';
import { createServerHandler, ensureSyncSchema } from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncServer } from '@syncular/server-hono';
import { Hono } from 'hono';
import { demoMigrations, type AppServerDb } from '../shared/db';

const DATABASE_PATH = './data/server.sqlite';
const PORT = Number(process.env.PORT ?? 8787);

async function ensureDemoSchema() {
  await mkdir(dirname(DATABASE_PATH), { recursive: true });

  const db = createBunSqliteDb<AppServerDb>({ path: DATABASE_PATH });
  const dialect = createSqliteServerDialect();
  await ensureSyncSchema(db, dialect);
  await runMigrations({
    db,
    migrations: demoMigrations,
    trackingTable: 'sync_server_migration_state',
  });

  const tasksHandler = createServerHandler({
    table: 'tasks',
    scopes: ['user:{user_id}'],
    resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
  });

  const { syncRoutes } = createSyncServer({
    db,
    dialect,
    handlers: [tasksHandler],
    authenticate: async (c) => {
      const actorId = c.req.header('x-user-id') ?? 'demo-user';
      return { actorId };
    },
  });

  const app = new Hono();
  app.get('/api/health', (c) =>
    c.json({ ok: true, message: 'Syncular demo server running' })
  );
  app.route('/api/sync', syncRoutes);

  return app;
}

const app = await ensureDemoSchema();

Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`Syncular demo server listening on http://localhost:${PORT}`);
