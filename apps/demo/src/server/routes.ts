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
import { createBlobRoutes } from '@syncular/server-hono/blobs';
import { createSyncServer } from '@syncular/server-hono/create-server';
import { createYjsServerPushPlugin } from '@syncular/server-plugin-crdt-yjs';
import type { Context } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Kysely } from 'kysely';
import type { ServerDb } from './db';
import { catalogItemsServerHandler } from './handlers/catalog-items';
import { patientNotesServerHandler } from './handlers/patient-notes';
import { sharedTasksServerHandler } from './handlers/shared-tasks';
import { tasksServerHandler } from './handlers/tasks';
import { normalizePartitionId } from './partition-id';

const yjsPushPlugin = createYjsServerPushPlugin({
  rules: [
    {
      table: 'tasks',
      field: 'title',
      stateColumn: 'title_yjs_state',
      containerKey: 'title',
      kind: 'text',
    },
  ],
});

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

  // Simple auth - extract user ID from header/query.
  const authenticateRequest = async (request: Request) => {
    const url = new URL(request.url);
    const userId =
      request.headers.get('x-user-id') ?? url.searchParams.get('userId');
    if (!userId) return null;
    const partitionId = normalizePartitionId(
      request.headers.get('x-demo-id') ??
        url.searchParams.get('demoId') ??
        url.searchParams.get('demo_id')
    );
    return { actorId: userId, partitionId };
  };
  const authenticateBlobContext = async (context: Context) =>
    authenticateRequest(context.req.raw);

  const { syncRoutes, consoleRoutes, consoleEventEmitter } = createSyncServer({
    db,
    dialect,
    sync: {
      handlers: [
        tasksServerHandler,
        sharedTasksServerHandler,
        catalogItemsServerHandler,
        patientNotesServerHandler,
      ],
      plugins: [yjsPushPlugin],
      authenticate: authenticateRequest,
    },
    chunkStorage: args?.chunkStorage,
    routes: {
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
      authenticate: authenticateBlobContext,
      tokenSigner,
      db,
    });
    syncRoutes.route('/', blobRoutes);
  }

  void consoleEventEmitter;
  return { syncRoutes, consoleRoutes };
}
