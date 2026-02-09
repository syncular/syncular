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
} from '@syncular/server';
import { createBlobRoutes, createSyncServer } from '@syncular/server-hono';
import type { Context } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Kysely } from 'kysely';
import type { ServerDb } from './db';
import { catalogItemsServerHandler } from './shapes/catalog-items';
import { patientNotesServerHandler } from './shapes/patient-notes';
import { sharedTasksServerHandler } from './shapes/shared-tasks';
import { tasksServerHandler } from './shapes/tasks';

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
  }
) {
  const upgradeWebSocket = args?.upgradeWebSocket;

  // Simple auth - extract user ID from header
  const authenticate = async (c: Context) => {
    const userId = c.req.header('x-user-id') ?? c.req.query('userId');
    if (!userId) return null;
    return { actorId: userId };
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
    sync: {
      rateLimit: false, // Disable rate limiting for demo
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
