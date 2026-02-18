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
import { type Kysely, sql } from 'kysely';
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

const RUNTIME_BOOTSTRAP_STATE_TABLE = 'sync_runtime_bootstrap_state';
const RUNTIME_BOOTSTRAP_STATE_KEY = 'demo-cf-runtime';
const RUNTIME_BOOTSTRAP_SCHEMA_VERSION = 1;
const RUNTIME_REQUIRED_TABLES = [
  'sync_commits',
  'sync_table_commits',
  'sync_changes',
  'sync_client_cursors',
  'sync_snapshot_chunks',
  'sync_blob_uploads',
] as const;

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

interface RuntimeBootstrapStateRow {
  cache_key: string;
  version: unknown;
}

async function ensureRuntimeBootstrapStateTable(
  db: Kysely<ServerDb>
): Promise<void> {
  await db.schema
    .createTable(RUNTIME_BOOTSTRAP_STATE_TABLE)
    .ifNotExists()
    .addColumn('cache_key', 'text', (col) => col.primaryKey())
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();
}

async function readRuntimeBootstrapVersion(
  db: Kysely<ServerDb>
): Promise<number | null> {
  const res = await sql<RuntimeBootstrapStateRow>`
    SELECT cache_key, version
    FROM ${sql.table(RUNTIME_BOOTSTRAP_STATE_TABLE)}
    WHERE cache_key = ${RUNTIME_BOOTSTRAP_STATE_KEY}
    LIMIT 1
  `.execute(db);

  const row = res.rows[0];
  if (!row) return null;

  const version =
    typeof row.version === 'number'
      ? row.version
      : typeof row.version === 'bigint'
        ? Number(row.version)
        : Number(row.version);
  return Number.isFinite(version) ? version : null;
}

async function writeRuntimeBootstrapVersion(
  db: Kysely<ServerDb>,
  version: number
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO ${sql.table(RUNTIME_BOOTSTRAP_STATE_TABLE)} (cache_key, version, updated_at)
    VALUES (${RUNTIME_BOOTSTRAP_STATE_KEY}, ${version}, ${now})
    ON CONFLICT(cache_key) DO UPDATE SET
      version = excluded.version,
      updated_at = excluded.updated_at
  `.execute(db);
}

async function hasRuntimeRequiredTables(
  db: Kysely<ServerDb>
): Promise<boolean> {
  const res = await sql<{ name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
  `.execute(db);

  const existing = new Set(
    res.rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string')
  );

  for (const tableName of RUNTIME_REQUIRED_TABLES) {
    if (!existing.has(tableName)) return false;
  }

  return true;
}

async function ensureRuntimeSchemaIfNeeded(
  db: Kysely<ServerDb>,
  dialect: ReturnType<typeof createSqliteServerDialect>
): Promise<void> {
  await ensureRuntimeBootstrapStateTable(db);

  const version = await readRuntimeBootstrapVersion(db);
  const canSkipBootstrap =
    version === RUNTIME_BOOTSTRAP_SCHEMA_VERSION &&
    (await hasRuntimeRequiredTables(db));

  if (canSkipBootstrap) {
    return;
  }

  await ensureSyncSchema(db, dialect);
  await ensureBlobStorageSchemaSqlite(db);
  await writeRuntimeBootstrapVersion(db, RUNTIME_BOOTSTRAP_SCHEMA_VERSION);
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
  private static runtimeBootstrapPromise: Promise<void> | null = null;

  private async ensureRuntimeBootstrap(
    db: Kysely<ServerDb>,
    dialect: ReturnType<typeof createSqliteServerDialect>
  ): Promise<void> {
    if (!SyncDOBase.runtimeBootstrapPromise) {
      SyncDOBase.runtimeBootstrapPromise = (async () => {
        await ensureRuntimeSchemaIfNeeded(db, dialect);
        await runMigrations({
          db,
          migrations: serverMigrations,
          trackingTable: 'sync_server_migration_state',
        });
      })().catch((error) => {
        SyncDOBase.runtimeBootstrapPromise = null;
        throw error;
      });
    }

    await SyncDOBase.runtimeBootstrapPromise;
  }

  override async setup(
    app: Hono<{ Bindings: Env }>,
    env: Env,
    upgradeWebSocket: UpgradeWebSocket<WebSocket>
  ) {
    const db = createD1Db<ServerDb>(env.DB);
    const dialect = createSqliteServerDialect({ supportsTransactions: false });

    // Ensure runtime schema/migrations once per isolate and only when needed.
    await this.ensureRuntimeBootstrap(db, dialect);

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
