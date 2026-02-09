/**
 * Integration test server factory
 *
 * Creates a real HTTP server using Hono + node:http on port 0 (auto-assign).
 * Uses node:http instead of Bun.serve to avoid happy-dom global Response conflicts
 * when running from root `bun test` (which preloads happy-dom for React tests).
 */

import { createServer, type Server as NodeServer } from 'node:http';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import { createPgliteDb } from '@syncular/dialect-pglite';
import { ensureSyncSchema } from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncRoutes } from '@syncular/server-hono';
import { Hono } from 'hono';
import { projectsServerShape } from '../handlers/projects-server';
import { createTasksServerShape } from '../handlers/tasks-server';
import type {
  IntegrationServer,
  IntegrationServerDb,
  ServerDialect,
} from './types';

/**
 * Bridge a Hono app to a node:http server.
 * Converts IncomingMessage to Request, calls app.fetch(), streams Response back.
 */
function serveHono(app: Hono): NodeServer {
  return createServer(async (req, res) => {
    const url = `http://localhost${req.url ?? '/'}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
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

    // Handle CORS preflight (needed for browser runtime tests)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers':
          'content-type, x-actor-id, x-syncular-transport-path, x-user-id',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }

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
    // Add CORS headers to all responses
    responseHeaders['access-control-allow-origin'] = '*';
    res.writeHead(response.status, responseHeaders);
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  });
}

export async function createIntegrationServer(
  serverDialect: ServerDialect
): Promise<IntegrationServer> {
  const db =
    serverDialect === 'pglite'
      ? createPgliteDb<IntegrationServerDb>()
      : createBunSqliteDb<IntegrationServerDb>({ path: ':memory:' });

  const dialect =
    serverDialect === 'pglite'
      ? createPostgresServerDialect()
      : createSqliteServerDialect();

  await ensureSyncSchema(db, dialect);

  // Create application tables
  await db.schema
    .createTable('projects')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('owner_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('project_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // Register table handlers
  const handlers = [
    createTasksServerShape<IntegrationServerDb>(),
    projectsServerShape,
  ];

  // Create Hono app with sync routes
  const app = new Hono();

  const syncRoutes = createSyncRoutes<IntegrationServerDb>({
    db,
    dialect,
    handlers,
    authenticate: async (c) => {
      const actorId = c.req.header('x-actor-id');
      if (!actorId) return null;
      return { actorId };
    },
    sync: {
      rateLimit: false,
    },
  });

  app.route('/sync', syncRoutes);

  // Start real HTTP server on port 0 (auto-assign)
  const httpServer = serveHono(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://localhost:${port}`;

  return {
    db,
    dialect,
    app,
    httpServer,
    baseUrl,
    destroy: async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      );
      await db.destroy();
    },
  };
}
