/**
 * Cloudflare Worker runtime test — Durable Object + D1 + WebSocket.
 *
 * Uses SyncDurableObject + createSyncWorkerWithDO (the real CF stack).
 */

import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { createD1Dialect } from '@syncular/dialect-d1';
import {
  createBlobManager,
  createDatabase,
  ensureBlobStorageSchemaSqlite,
  ensureSyncSchema,
  type SyncBlobUploadsDb,
  type SyncCoreDb,
} from '@syncular/server';
import {
  createHmacTokenSigner,
  createR2BlobStorageAdapter,
  createSyncWorkerWithDO,
  SyncDurableObject,
} from '@syncular/server-cloudflare';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createBlobRoutes, createSyncServer } from '@syncular/server-hono';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import {
  createProjectScopedTasksHandler,
  ensureProjectScopedTasksTable,
  type ProjectScopedTasksRow,
} from '../../../../packages/testkit/src/project-scoped-tasks';

interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  SYNC_DO: DurableObjectNamespace;
}

interface ServerDb extends SyncCoreDb, SyncBlobUploadsDb {
  tasks: ProjectScopedTasksRow;
}

export class SyncDO extends SyncDurableObject<Env> {
  override async setup(
    app: Hono<{ Bindings: Env }>,
    env: Env,
    upgradeWebSocket: UpgradeWebSocket<WebSocket>
  ) {
    const db = createDatabase<ServerDb>({
      dialect: createD1Dialect(env.DB),
      family: 'sqlite',
    });
    const dialect = createSqliteServerDialect({ supportsTransactions: false });

    await ensureSyncSchema(db, dialect);
    if (dialect.ensureConsoleSchema) {
      await dialect.ensureConsoleSchema(db);
    }
    await ensureProjectScopedTasksTable(db);
    await ensureBlobStorageSchemaSqlite(db);

    const tokenSigner = createHmacTokenSigner('test-blob-secret');
    const blobAdapter = createR2BlobStorageAdapter({
      bucket: env.BLOBS,
      baseUrl: '/sync',
      tokenSigner,
    });
    const blobManager = createBlobManager({ db, adapter: blobAdapter });

    const { syncRoutes } = createSyncServer({
      db,
      dialect,
      sync: {
        handlers: [createProjectScopedTasksHandler<ServerDb>()],
        authenticate: async (request) => {
          const url = new URL(request.url);
          const userId =
            request.headers.get('x-user-id') ??
            url.searchParams.get('userId') ??
            null;
          if (!userId) {
            return null;
          }
          return { actorId: userId };
        },
      },
      upgradeWebSocket,
    });

    const blobRoutes = createBlobRoutes({
      blobManager,
      db,
      authenticate: async (c) => {
        const userId =
          c.req.header('x-user-id') ?? c.req.query('userId') ?? null;
        if (!userId) {
          return null;
        }
        return { actorId: userId };
      },
      tokenSigner,
    });

    app.route('/sync', syncRoutes);
    app.route('/sync', blobRoutes);
    app.get('/health', (c) => c.json({ status: 'ok' }));
  }
}

export default createSyncWorkerWithDO<Env>('SYNC_DO');
