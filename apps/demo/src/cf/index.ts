/**
 * @syncular/demo - Cloudflare Worker + Durable Object entry
 *
 * Deploys the demo on Cloudflare using:
 * - D1 (SQLite) for database
 * - Durable Objects for WebSocket realtime
 * - R2 for blob storage
 * - Static Assets for the frontend SPA
 */

import { createD1Db } from '@syncular/dialect-d1';
import { runMigrations } from '@syncular/migrations';
import {
  ensureBlobStorageSchemaSqlite,
  ensureSyncSchema,
  type SyncBlobDb,
  type SyncCoreDb,
} from '@syncular/server';
import {
  createHmacTokenSigner,
  createR2BlobStorageAdapter,
  createSyncWorkerWithDO,
  SyncDurableObject,
} from '@syncular/server-cloudflare';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { ClientDb } from '../client/types.generated';
import {
  clearCatalog,
  getCatalogRowCount,
  seedCatalog,
} from '../server/catalog';
import { serverMigrations } from '../server/migrations';
import { createDemoRoutes } from '../server/routes';

interface ServerDb extends SyncCoreDb, SyncBlobDb, ClientDb {}

interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  BLOB_SECRET: string;
  SYNC_DO: DurableObjectNamespace;
}

export class SyncDO extends SyncDurableObject<Env> {
  override async setup(
    app: Hono<{ Bindings: Env }>,
    env: Env,
    upgradeWebSocket: UpgradeWebSocket<WebSocket>
  ) {
    const db = createD1Db<ServerDb>(env.DB);
    const dialect = createSqliteServerDialect({ supportsTransactions: false });

    // Idempotent schema + migrations
    await ensureSyncSchema(db, dialect);
    await runMigrations({
      db,
      migrations: serverMigrations,
      trackingTable: 'sync_server_migration_state',
    });
    await ensureBlobStorageSchemaSqlite(db);

    // Blob storage via R2
    const tokenSigner = createHmacTokenSigner(env.BLOB_SECRET);
    const blobAdapter = createR2BlobStorageAdapter({
      bucket: env.BLOBS,
      baseUrl: '/api/sync',
      tokenSigner,
    });

    const { syncRoutes, consoleRoutes } = createDemoRoutes(db, dialect, {
      upgradeWebSocket,
      blobAdapter,
      tokenSigner,
    });

    app.route('/api/sync', syncRoutes);
    if (consoleRoutes) {
      app.route('/api/console', consoleRoutes);
    }

    // Demo helper routes (large catalog)
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
      const rows = Number.isFinite(Number(rowsRaw))
        ? Number(rowsRaw)
        : 1_000_000;
      const force = bodyRecord.force === true;
      // D1 limits: 100 bound params/query (50 rows × 2 cols) and ~60s DO timeout.
      // Cap each request at 25k inserts; client retries to reach the full target.
      const result = await seedCatalog(db, {
        rows,
        force,
        batchSize: 50,
        maxInsert: 25_000,
      });
      return c.json({
        ...result,
        hasMore: result.totalRows < rows,
      });
    });

    app.post('/api/demo/catalog/clear', async (c) => {
      await clearCatalog(db);
      const totalRows = await getCatalogRowCount(db);
      return c.json({ totalRows });
    });

    // Health check
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
  }
}

export default createSyncWorkerWithDO<Env>('SYNC_DO');
