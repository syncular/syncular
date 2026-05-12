/**
 * Bun-native runtime test server.
 *
 * This is intentionally similar to `apps/node/server.ts`, but uses
 * `@syncular/dialect-bun-sqlite` instead of better-sqlite3 so it runs under
 * Bun without native addon support.
 */

import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { createDatabase } from '../../../../packages/core/src/index';
import { createBunSqliteDialect } from '../../../../packages/dialect-bun-sqlite/src/index';
import type { SyncCoreDb } from '../../../../packages/server/src/index';
import { ensureSyncSchema } from '../../../../packages/server/src/index';
import { createSqliteServerDialect } from '../../../../packages/server-dialect-sqlite/src/index';
import { createSyncRoutes } from '../../../../packages/server-hono/src/index';
import {
  createProjectScopedTasksHandler,
  ensureProjectScopedTasksTable,
  type ProjectScopedTasksRow,
} from '../../../../packages/testkit/src/project-scoped-tasks';

interface ServerDb extends SyncCoreDb {
  tasks: ProjectScopedTasksRow;
}

const dialect = createSqliteServerDialect();
const db = createDatabase<ServerDb>({
  dialect: createBunSqliteDialect({ path: ':memory:' }),
  family: 'sqlite',
});

await ensureSyncSchema(db, dialect);
if (dialect.ensureConsoleSchema) {
  await dialect.ensureConsoleSchema(db);
}
await ensureProjectScopedTasksTable(db);

const app = new Hono();
const syncRoutes = createSyncRoutes<ServerDb>({
  db,
  dialect,
  handlers: [createProjectScopedTasksHandler<ServerDb>()],
  authenticate: async (c) => {
    const actorId = c.req.header('x-actor-id') ?? c.req.header('x-user-id');
    if (!actorId) return null;
    return { actorId };
  },
  sync: {
    rateLimit: false,
    websocket: {
      enabled: true,
      upgradeWebSocket,
      heartbeatIntervalMs: 30_000,
    },
  },
});

app.route('/sync', syncRoutes);
app.get('/health', (c) => c.json({ ok: true }));

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});

process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);

const shutdown = () => {
  server.stop();
  void db.destroy().finally(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
