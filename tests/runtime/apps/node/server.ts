/**
 * Node.js runtime test server — proves sync works under native Node.js.
 *
 * Uses better-sqlite3 + Hono + node:http.
 * Outputs JSON `{ port: <number> }` on stdout when ready.
 */

import { Hono } from 'hono';
import { createDatabase } from '../../../../packages/core/src/index';
import { createBetterSqlite3Dialect } from '../../../../packages/dialect-better-sqlite3/src/index';
import type { SyncCoreDb } from '../../../../packages/server/src/index';
import { ensureSyncSchema } from '../../../../packages/server/src/index';
import { createSqliteServerDialect } from '../../../../packages/server-dialect-sqlite/src/index';
import { createSyncRoutes } from '../../../../packages/server-hono/src/index';
import { createNodeHonoServer } from '../../../../packages/testkit/src/hono-node-server';
import {
  createProjectScopedTasksHandler,
  ensureProjectScopedTasksTable,
  type ProjectScopedTasksRow,
} from '../../../../packages/testkit/src/project-scoped-tasks';

interface ServerDb extends SyncCoreDb {
  tasks: ProjectScopedTasksRow;
}

async function main() {
  const dialect = createSqliteServerDialect();
  const db = createDatabase<ServerDb>({
    dialect: createBetterSqlite3Dialect({ path: ':memory:' }),
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
      const actorId = c.req.header('x-actor-id');
      if (!actorId) {
        return null;
      }

      return { actorId };
    },
    sync: { rateLimit: false },
  });

  app.route('/sync', syncRoutes);
  app.get('/health', (c) => c.json({ ok: true }));

  const httpServer = createNodeHonoServer(app, { cors: false });
  httpServer.listen(0, '127.0.0.1', () => {
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    process.stdout.write(`${JSON.stringify({ port })}\n`);
  });

  process.on('SIGTERM', () => {
    httpServer.close(() => {
      db.destroy().then(() => process.exit(0));
    });
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
