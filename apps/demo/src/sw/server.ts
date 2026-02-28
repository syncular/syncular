import { createWaSqliteMainThreadDialect } from '@syncular/dialect-wa-sqlite';
import { runMigrations } from '@syncular/migrations';
import {
  createDatabase,
  createDatabaseBlobStorageAdapter,
  createHmacTokenSigner,
  ensureBlobStorageSchemaSqlite,
  ensureSyncSchema,
  type SyncBlobDb,
  type SyncCoreDb,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import {
  attachServiceWorkerServer,
  createServiceWorkerServer,
} from '@syncular/server-service-worker';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { ClientDb } from '../client/types.generated';
import {
  clearCatalog,
  getCatalogRowCount,
  seedCatalog,
} from '../server/catalog';
import { serverMigrations } from '../server/migrations';
import { resetDemoData } from '../server/reset';
import { createDemoRoutes } from '../server/routes';

interface ServerDb extends SyncCoreDb, SyncBlobDb, ClientDb {}

const CONSOLE_TOKEN = 'demo-token';
const BLOB_SECRET = 'demo-blob-secret';
const DB_FILE = 'syncular-demo-sw-server.sqlite';
const SW_SERVER_SCRIPT_PATH = '/__demo/sw-server.js';

let appPromise: Promise<Hono> | null = null;

function getWorkerOrigin(): string {
  if (typeof location === 'undefined' || !location.origin) {
    throw new Error('Service worker origin is unavailable');
  }
  return location.origin;
}

async function createServiceWorkerDb(): Promise<{
  db: Kysely<ServerDb>;
  dialect: ReturnType<typeof createSqliteServerDialect>;
}> {
  const origin = getWorkerOrigin();
  const db = createDatabase<ServerDb>({
    dialect: createWaSqliteMainThreadDialect({
      fileName: DB_FILE,
      // ServiceWorker scope cannot rely on nested Worker support.
      // Keep SQLite persistence via IndexedDB-backed wa-sqlite.
      useOPFS: false,
      url: `${origin}/__demo/wasqlite/wa-sqlite-async.wasm`,
    }),
    family: 'sqlite',
  });

  const dialect = createSqliteServerDialect();
  await ensureSyncSchema(db, dialect);
  await ensureBlobStorageSchemaSqlite(db);
  await runMigrations({
    db,
    migrations: serverMigrations,
    trackingTable: 'sync_server_migration_state',
  });

  return { db, dialect };
}

async function createApiApp(): Promise<Hono> {
  const { db, dialect } = await createServiceWorkerDb();
  const tokenSigner = createHmacTokenSigner(BLOB_SECRET);
  const blobAdapter = createDatabaseBlobStorageAdapter({
    db,
    baseUrl: '/api/sync',
    tokenSigner,
  });

  const { syncRoutes, consoleRoutes } = createDemoRoutes(db, dialect, {
    consoleToken: CONSOLE_TOKEN,
    blobAdapter,
    tokenSigner,
  });

  const app = new Hono();
  app.route('/api/sync', syncRoutes);
  if (consoleRoutes) {
    app.route('/api/console', consoleRoutes);
  }

  app.get('/api/demo/catalog/status', async (c) => {
    const totalRows = await getCatalogRowCount(db);
    return c.json({ totalRows });
  });

  app.post('/api/demo/catalog/seed', async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const bodyRecord =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const rowsRaw = bodyRecord.rows ?? 1_000_000;
    const rows = Number.isFinite(Number(rowsRaw)) ? Number(rowsRaw) : 1_000_000;
    const force = bodyRecord.force === true;
    const result = await seedCatalog(db, { rows, force });
    return c.json(result);
  });

  app.post('/api/demo/catalog/clear', async (c) => {
    await clearCatalog(db);
    const totalRows = await getCatalogRowCount(db);
    return c.json({ totalRows });
  });

  app.post('/api/demo/reset-all', async (c) => {
    await resetDemoData(db);
    return c.json({ ok: true });
  });

  app.get('/api/health', (c) => {
    c.header('x-syncular-sw-server', '1');
    return c.json({ status: 'ok' });
  });
  return app;
}

async function getApiApp(): Promise<Hono> {
  if (!appPromise) {
    appPromise = createApiApp().catch((error) => {
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
}

const serviceWorkerServer = createServiceWorkerServer({
  serviceWorkerScriptPath: SW_SERVER_SCRIPT_PATH,
  handleRequest: async (request) => {
    const app = await getApiApp();
    return await app.fetch(request);
  },
  onError: (error) => {
    console.error('[demo-sw-server] request failed', error);
    const message =
      error instanceof Error
        ? [error.message, error.stack].filter(Boolean).join('\n')
        : String(error);
    return new Response(`Service worker server failed\n${message}`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
});

const swGlobal = globalThis as unknown as {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  skipWaiting?: () => Promise<void>;
  clients?: {
    claim?: () => Promise<void>;
    matchAll?: (options?: {
      type?: 'window' | 'worker' | 'sharedworker' | 'all';
      includeUncontrolled?: boolean;
    }) => Promise<Array<{ postMessage: (message: unknown) => void }>>;
  };
  location?: Location;
};

attachServiceWorkerServer(swGlobal, serviceWorkerServer, {
  logger: console,
});
