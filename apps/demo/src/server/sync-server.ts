import { type BlobRef, createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  createServerHandler,
  ensureSyncSchema,
  type SyncCoreDb,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncRoutes } from '@syncular/server-hono';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import type { Kysely } from 'kysely';
import { syncularGeneratedCodecs } from '../../../../rust/examples/todo-app/generated/typescript/syncular.generated';

interface DemoTaskRow {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string | null;
  server_version: number;
  image: BlobRef | null;
  title_yjs_state: string | null;
}

interface DemoServerDb extends SyncCoreDb {
  tasks: DemoTaskRow;
}

interface DemoClientDb {
  tasks: DemoTaskRow;
}

interface DemoSyncServer {
  origin: string;
  close(): Promise<void>;
}

export async function startDemoSyncServer(
  options: { port?: number } = {}
): Promise<DemoSyncServer> {
  const dialect = createSqliteServerDialect();
  const db = createDatabase<DemoServerDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
    family: 'sqlite',
  });

  await ensureSyncSchema(db, dialect);
  await ensureDemoTables(db);
  await seedDemoRows(db);

  const syncRoutes = createSyncRoutes<DemoServerDb, { actorId: string }>({
    db,
    dialect,
    handlers: [
      createServerHandler<
        DemoServerDb,
        DemoClientDb,
        'tasks',
        { actorId: string }
      >({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        codecs: syncularGeneratedCodecs,
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ],
    authenticate: async (c) => {
      const authorization = c.req.header('authorization');
      const token = c.req.query('token');
      if (authorization !== 'Bearer demo-user' && token !== 'demo-user') {
        return null;
      }
      return { actorId: 'demo-user' };
    },
    sync: {
      cors: ['http://127.0.0.1:*', 'http://localhost:*'],
      rateLimit: false,
      websocket: {
        enabled: true,
        upgradeWebSocket,
        allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
        heartbeatIntervalMs: 15_000,
      },
    },
  });

  const app = new Hono()
    .get('/health', (c) => c.json({ ok: true }))
    .route('/sync', syncRoutes);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 4101,
    fetch: async (request, server) => {
      const response = await app.fetch(request, server);
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return response;
      }
      return toNativeBunResponse(response);
    },
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

async function ensureDemoTables(db: Kysely<DemoServerDb>) {
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('project_id', 'text')
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('image', 'text')
    .addColumn('title_yjs_state', 'text')
    .execute();
}

async function toNativeBunResponse(response: Response): Promise<Response> {
  const NativeResponse = (globalThis as Record<string, unknown>)
    .__nativeResponse as typeof Response | undefined;
  if (
    !NativeResponse ||
    Object.prototype.isPrototypeOf.call(NativeResponse.prototype, response)
  ) {
    return response;
  }

  const headers: [string, string][] = [];
  response.headers.forEach((value, key) => {
    headers.push([key, value]);
  });
  const body =
    response.status === 204 || response.status === 304
      ? null
      : await response.arrayBuffer();
  return new NativeResponse(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function seedDemoRows(db: Kysely<DemoServerDb>) {
  const existing = await db
    .selectFrom('tasks')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirst();

  if ((existing?.count ?? 0) > 0) return;

  await db
    .insertInto('tasks')
    .values([
      {
        id: 'server-seed-plan',
        title: 'Prepare project brief',
        completed: 0,
        user_id: 'demo-user',
        project_id: null,
        server_version: 1,
        image: null,
        title_yjs_state: null,
      },
      {
        id: 'server-seed-sync',
        title: 'Review launch checklist',
        completed: 0,
        user_id: 'demo-user',
        project_id: null,
        server_version: 2,
        image: null,
        title_yjs_state: null,
      },
    ])
    .execute();
}
