/**
 * Deno runtime test server — proves sync works under Deno.
 *
 * Uses node:sqlite (built-in to Deno 2.x) + Hono + node:http.
 * Outputs JSON `{ port: <number> }` on stdout when ready.
 */

import sqlite from 'node:sqlite';
import { Hono } from 'hono';
import { SqliteDialect } from 'kysely';
import { createDatabase } from '../../../../packages/core/src/index';
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

function wrapStatement(stmt: ReturnType<sqlite.DatabaseSync['prepare']>) {
  let isReader = false;
  try {
    const cols = stmt.columns();
    isReader = cols.length > 0;
  } catch {
    isReader = false;
  }

  return {
    all: (...args: unknown[]) => {
      const params: Parameters<typeof stmt.all> =
        args.length === 1 && Array.isArray(args[0])
          ? (args[0] as Parameters<typeof stmt.all>)
          : (args as Parameters<typeof stmt.all>);
      return stmt.all(...params);
    },
    run: (...args: unknown[]) => {
      const params: Parameters<typeof stmt.run> =
        args.length === 1 && Array.isArray(args[0])
          ? (args[0] as Parameters<typeof stmt.run>)
          : (args as Parameters<typeof stmt.run>);
      return stmt.run(...params);
    },
    iterate: (...args: unknown[]) => {
      const params: Parameters<typeof stmt.iterate> =
        args.length === 1 && Array.isArray(args[0])
          ? (args[0] as Parameters<typeof stmt.iterate>)
          : (args as Parameters<typeof stmt.iterate>);
      return stmt.iterate(...params);
    },
    columns: () => {
      try {
        return stmt.columns();
      } catch {
        return [];
      }
    },
    reader: isReader,
  };
}

function wrapDatabase(raw: sqlite.DatabaseSync) {
  return {
    prepare: (sqlStr: string) => wrapStatement(raw.prepare(sqlStr)),
    exec: (sqlStr: string) => raw.exec(sqlStr),
    close: () => raw.close(),
  };
}

function createNodeSqliteDialect(path: string): SqliteDialect {
  const raw = new sqlite.DatabaseSync(path);
  const wrapped = wrapDatabase(raw);

  const database: ConstructorParameters<typeof SqliteDialect>[0]['database'] =
    wrapped;

  return new SqliteDialect({ database });
}

interface ServerDb extends SyncCoreDb {
  tasks: ProjectScopedTasksRow;
}

async function main() {
  const dialect = createSqliteServerDialect();
  const db = createDatabase<ServerDb>({
    dialect: createNodeSqliteDialect(':memory:'),
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
