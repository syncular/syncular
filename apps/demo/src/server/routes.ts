/**
 * @syncular/demo - Server sync routes
 *
 * Creates Hono sync routes for the demo server using the simplified API.
 */

import type { BlobStorageAdapter } from '@syncular/core';
import {
  type BlobTokenSigner,
  createBlobManager,
  createHmacTokenSigner,
  type ServerSyncDialect,
  type SnapshotChunkStorage,
} from '@syncular/server';
import { createBlobRoutes, createSyncServer } from '@syncular/server-hono';
import type { Context } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Kysely } from 'kysely';
import type { ServerDb } from './db';
import { catalogItemsServerHandler } from './handlers/catalog-items';
import { patientNotesServerHandler } from './handlers/patient-notes';
import { sharedTasksServerHandler } from './handlers/shared-tasks';
import { tasksServerHandler } from './handlers/tasks';
import { normalizePartitionId } from './partition-id';

/**
 * Create sync and console routes for the demo
 */
export function createDemoRoutes(
  db: Kysely<ServerDb>,
  dialect: ServerSyncDialect,
  args?: {
    upgradeWebSocket?: UpgradeWebSocket;
    consoleToken?: string;
    blobAdapter?: BlobStorageAdapter;
    tokenSigner?: BlobTokenSigner;
    chunkStorage?: SnapshotChunkStorage;
  }
) {
  const upgradeWebSocket = args?.upgradeWebSocket;

  // Simple auth - extract user ID from header
  const authenticate = async (c: Context) => {
    const userId = c.req.header('x-user-id') ?? c.req.query('userId');
    if (!userId) return null;
    const partitionId = normalizePartitionId(
      c.req.header('x-demo-id') ??
        c.req.query('demoId') ??
        c.req.query('demo_id')
    );
    return { actorId: userId, partitionId };
  };

  const { syncRoutes, consoleRoutes, consoleEventEmitter } = createSyncServer({
    db,
    dialect,
    handlers: [
      tasksServerHandler,
      sharedTasksServerHandler,
      catalogItemsServerHandler,
      patientNotesServerHandler,
    ],
    authenticate,
    chunkStorage: args?.chunkStorage,
    sync: {
      rateLimit: false, // Disable rate limiting for demo
      maxPullLimitSnapshotRows: 50_000,
      maxPullMaxSnapshotPages: 20,
    },
    upgradeWebSocket,
    console: {
      token:
        args?.consoleToken ?? process.env.SYNC_CONSOLE_TOKEN ?? 'demo-token',
      corsOrigins: '*',
    },
  });

  // Mount blob routes when a blob adapter is provided
  if (args?.blobAdapter) {
    const tokenSigner =
      args.tokenSigner ?? createHmacTokenSigner('demo-blob-secret');
    const blobManager = createBlobManager({
      db,
      adapter: args.blobAdapter,
    });
    const blobRoutes = createBlobRoutes({
      blobManager,
      authenticate,
      tokenSigner,
      db,
    });
    syncRoutes.route('/', blobRoutes);
  }

  void consoleEventEmitter;
  return { syncRoutes, consoleRoutes };
}
