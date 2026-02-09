/**
 * Node.js runtime test server (better-sqlite3).
 *
 * Handles HTTP RPC for conformance and sync scenarios.
 * Started by the test coordinator via `node --import tsx server.ts --port=PORT`.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  ClientTableRegistry,
  enqueueOutboxCommit,
  ensureClientSyncSchema,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import { createBetterSqlite3Db } from '@syncular/dialect-better-sqlite3';
import { createHttpTransport } from '@syncular/transport-http';
import type { RuntimeClientDb } from '../../shared/client-types';
import type { ConformanceDb } from '../../shared/conformance';
import { runConformanceTests } from '../../shared/conformance';
import { tasksClientHandler } from '../../shared/tasks-client-handler';

// --- Helpers ---

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number.parseInt(portArg.split('=')[1]!, 10) : 0;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// --- Sync client factory ---

async function createSyncClient(serverUrl: string, actorId: string) {
  const db = createBetterSqlite3Db<RuntimeClientDb>({ path: ':memory:' });
  await ensureClientSyncSchema(db);

  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('completed', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('project_id', 'text', (c) => c.notNull())
    .addColumn('server_version', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();

  const shapes = new ClientTableRegistry<RuntimeClientDb>();
  shapes.register(tasksClientHandler);

  const transport = createHttpTransport({
    baseUrl: serverUrl,
    getHeaders: () => ({ 'x-actor-id': actorId }),
  });

  return { db, shapes, transport };
}

// --- Scenario handlers ---

async function handleConformance(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const db = createBetterSqlite3Db<ConformanceDb>({ path: ':memory:' });
  try {
    await runConformanceTests(db);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await db.destroy();
  }
}

async function handleBootstrap(params: {
  serverUrl: string;
  actorId: string;
  clientId: string;
}): Promise<{ ok: boolean; rowCount?: number; error?: string }> {
  const client = await createSyncClient(params.serverUrl, params.actorId);
  try {
    await syncPullOnce(client.db, client.transport, client.shapes, {
      clientId: params.clientId,
      subscriptions: [
        {
          id: 'tasks',
          shape: 'tasks',
          scopes: { user_id: params.actorId, project_id: 'p1' },
        },
      ],
    });

    const rows = await client.db.selectFrom('tasks').selectAll().execute();
    return { ok: true, rowCount: rows.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.db.destroy();
  }
}

async function handlePushPull(params: {
  serverUrl: string;
  actorId: string;
  clientId: string;
}): Promise<{ ok: boolean; finalRowCount?: number; error?: string }> {
  const client = await createSyncClient(params.serverUrl, params.actorId);
  try {
    const sub = {
      id: 'tasks',
      shape: 'tasks',
      scopes: { user_id: params.actorId, project_id: 'p1' },
    };

    // Bootstrap empty state
    await syncPullOnce(client.db, client.transport, client.shapes, {
      clientId: params.clientId,
      subscriptions: [sub],
    });

    // Push a task
    await enqueueOutboxCommit(client.db, {
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'rt-task-1',
          op: 'upsert',
          payload: { title: 'Runtime Task', completed: 0, project_id: 'p1' },
          base_version: null,
        },
      ],
    });

    const pushResult = await syncPushOnce(client.db, client.transport, {
      clientId: params.clientId,
    });

    if (!pushResult.pushed || pushResult.response?.status !== 'applied') {
      return {
        ok: false,
        error: `Push failed: ${pushResult.response?.status}`,
      };
    }

    // Pull to get server-confirmed version
    await syncPullOnce(client.db, client.transport, client.shapes, {
      clientId: params.clientId,
      subscriptions: [sub],
    });

    const rows = await client.db.selectFrom('tasks').selectAll().execute();
    return { ok: true, finalRowCount: rows.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.db.destroy();
  }
}

// --- HTTP server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST') {
    json(res, 404, { ok: false, error: 'NOT_FOUND' });
    return;
  }

  const body = await readBody(req);
  const params = body ? JSON.parse(body) : {};

  try {
    if (url.pathname === '/conformance') {
      const result = await handleConformance();
      json(res, result.ok ? 200 : 500, result);
    } else if (url.pathname === '/bootstrap') {
      const result = await handleBootstrap(params);
      json(res, result.ok ? 200 : 500, result);
    } else if (url.pathname === '/push-pull') {
      const result = await handlePushPull(params);
      json(res, result.ok ? 200 : 500, result);
    } else {
      json(res, 404, { ok: false, error: 'NOT_FOUND' });
    }
  } catch (err) {
    json(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    // Signal readiness to the coordinator
    process.stdout.write(`READY:${addr.port}\n`);
  }
});

// Graceful shutdown on SIGTERM
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
