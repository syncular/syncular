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
  attachCloudflareSentryTraceHeaders,
  captureCloudflareSentryMessage,
  configureCloudflareSentryTelemetry,
  instrumentCloudflareDurableObjectWithSentry,
  logCloudflareSentryMessage,
  withCloudflareSentry,
} from '@syncular/observability-sentry';
import {
  ensureBlobStorageSchemaSqlite,
  ensureSyncSchema,
  type SyncBlobDb,
  type SyncCoreDb,
} from '@syncular/server';
import { createDbMetadataChunkStorage } from '@syncular/server/snapshot-chunks';
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
  DEFAULT_DEMO_SENTRY_ENVIRONMENT,
  DEMO_WORKER_SENTRY_DSN,
} from '../sentry-config';
import {
  clearCatalog,
  getCatalogRowCount,
  seedCatalog,
} from '../server/catalog';
import { serverMigrations } from '../server/migrations';
import { resolvePartitionIdFromRequest } from '../server/partition-id';
import { resetDemoData } from '../server/reset';
import { createDemoRoutes } from '../server/routes';

interface ServerDb extends SyncCoreDb, SyncBlobDb, ClientDb {}

interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  BLOB_SECRET: string;
  SYNC_DO: DurableObjectNamespace;
  CF_VERSION_METADATA?: { id?: string };
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
}

function resolveDemoCloudflareSentryOptions(env: Env) {
  const dsn =
    typeof env.SENTRY_DSN === 'string' && env.SENTRY_DSN.trim().length > 0
      ? env.SENTRY_DSN
      : DEMO_WORKER_SENTRY_DSN;

  return {
    dsn,
    enabled: Boolean(dsn),
    environment: env.SENTRY_ENVIRONMENT || DEFAULT_DEMO_SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE || env.CF_VERSION_METADATA?.id,
    enableLogs: true,
    tracesSampleRate: 1.0,
  };
}

class SyncDOBase extends SyncDurableObject<Env> {
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

    // Snapshot chunk storage: metadata in D1, bodies in R2
    const chunkStorage = createDbMetadataChunkStorage({ db, blobAdapter });

    const { syncRoutes, consoleRoutes } = createDemoRoutes(db, dialect, {
      upgradeWebSocket,
      blobAdapter,
      tokenSigner,
      chunkStorage,
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

    app.post('/api/demo/reset-all', async (c) => {
      await resetDemoData(db);
      return c.json({ ok: true });
    });

    // Health check
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
  }
}

export const SyncDO = instrumentCloudflareDurableObjectWithSentry(
  (env) => resolveDemoCloudflareSentryOptions(env),
  SyncDOBase
);

const syncWorker = createSyncWorkerWithDO<Env>('SYNC_DO', {
  getStubId: (ns, request) => {
    const partitionId = resolvePartitionIdFromRequest(request);
    return ns.idFromName(partitionId);
  },
});

configureCloudflareSentryTelemetry();
let hasCapturedWorkerStartupMessage = false;

export default withCloudflareSentry<Env>(
  (env) => resolveDemoCloudflareSentryOptions(env),
  {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (
        !hasCapturedWorkerStartupMessage &&
        url.pathname === '/api/health' &&
        Boolean(resolveDemoCloudflareSentryOptions(env).dsn)
      ) {
        hasCapturedWorkerStartupMessage = true;
        logCloudflareSentryMessage('syncular.demo.worker.startup', {
          level: 'info',
          attributes: {
            app: 'demo',
            runtime: 'cloudflare-worker',
          },
        });
      }
      const tracedRequest = attachCloudflareSentryTraceHeaders(request);
      const response = await syncWorker.fetch(tracedRequest, env, ctx);
      if (response.status >= 500 && url.pathname.startsWith('/api/sync')) {
        const status = String(response.status);
        captureCloudflareSentryMessage('syncular.demo.worker.http_5xx', {
          level: 'error',
          tags: {
            method: request.method,
            path: url.pathname,
            status,
          },
        });
        logCloudflareSentryMessage('syncular.demo.worker.http_5xx', {
          level: 'error',
          attributes: {
            method: request.method,
            path: url.pathname,
            status: response.status,
          },
        });
      }
      return response;
    },
  }
);
