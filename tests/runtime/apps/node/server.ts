/**
 * Node.js runtime test server — proves sync works under native Node.js.
 *
 * Uses better-sqlite3 + Hono + node:http.
 * Outputs JSON `{ port: <number> }` on stdout when ready.
 */

import { createServer } from 'node:http';
import type { SyncOperation } from '@syncular/core';
import { createBetterSqlite3Db } from '@syncular/dialect-better-sqlite3';
import type {
  ApplyOperationResult,
  EmittedChange,
  ServerTableHandler,
  SyncCoreDb,
} from '@syncular/server';
import { ensureSyncSchema, TableRegistry } from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncRoutes } from '@syncular/server-hono';
import { Hono } from 'hono';
import { sql } from 'kysely';

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

// ---------------------------------------------------------------------------
// Tasks handler (inline, mirrors relay test)
// ---------------------------------------------------------------------------

function createTasksHandler(): ServerTableHandler<ServerDb> {
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
// Hono → node:http bridge
// ---------------------------------------------------------------------------

function serveHono(app: Hono): ReturnType<typeof createServer> {
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
// Boot
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

async function main() {
  const dialect = createSqliteServerDialect();
  const db = createBetterSqlite3Db<ServerDb>({ path: ':memory:' });

  await ensureSyncSchema(db, dialect);
  await sql.raw(TASKS_DDL).execute(db);

  const handlers = new TableRegistry<ServerDb>();
  handlers.register(createTasksHandler());

  const app = new Hono();
  const syncRoutes = createSyncRoutes<ServerDb>({
    db,
    dialect,
    handlers: [createTasksHandler()],
    authenticate: async (c) => {
      const actorId = c.req.header('x-actor-id');
      if (!actorId) return null;
      return { actorId };
    },
    sync: { rateLimit: false },
  });

  app.route('/sync', syncRoutes);
  app.get('/health', (c) => c.json({ ok: true }));

  const httpServer = serveHono(app);
  httpServer.listen(0, '127.0.0.1', () => {
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    // Signal to test runner that server is ready
    process.stdout.write(`${JSON.stringify({ port })}\n`);
  });

  // Graceful shutdown
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
