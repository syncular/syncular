import {
  createDatabaseBlobStorageAdapter,
  createHmacTokenSigner,
  ensureBlobStorageSchemaPostgres,
} from '@syncular/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { UpgradeWebSocket } from 'hono/ws';
import { clearCatalog, getCatalogRowCount, seedCatalog } from './catalog';
import { createServerDb } from './db';
import { createDemoRoutes } from './routes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface CreateDemoAppResult {
  app: Hono;
}

export async function createDemoApp(args: {
  consoleToken: string;
  upgradeWebSocket?: UpgradeWebSocket;
}): Promise<CreateDemoAppResult> {
  const { db, dialect } = await createServerDb();

  // Set up blob storage (database adapter for local dev)
  await ensureBlobStorageSchemaPostgres(db);
  const tokenSigner = createHmacTokenSigner('demo-blob-secret');
  const blobAdapter = createDatabaseBlobStorageAdapter({
    db,
    baseUrl: '/api/sync',
    tokenSigner,
  });

  const { syncRoutes, consoleRoutes } = createDemoRoutes(db, dialect, {
    upgradeWebSocket: args.upgradeWebSocket,
    consoleToken: args.consoleToken,
    blobAdapter,
    tokenSigner,
  });

  const app = new Hono();

  // Enable CORS for development (allow all localhost origins)
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return null;
        if (origin.startsWith('http://localhost:')) return origin;
        if (origin.startsWith('http://127.0.0.1:')) return origin;
        return null;
      },
      credentials: true,
    })
  );

  // Mount routes
  app.route('/api/sync', syncRoutes);
  if (consoleRoutes) {
    app.route('/api/console', consoleRoutes);
  }

  // -------------------------------------------------------------------------
  // Demo helper routes (large catalog)
  // -------------------------------------------------------------------------

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

    const bodyRecord = isRecord(body) ? body : {};

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

  // Health check endpoint
  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  return { app };
}
