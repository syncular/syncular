/**
 * @syncular/server/hono - Sync routes for Hono
 *
 * Provides:
 * - POST /      (combined push + pull in one round-trip)
 * - GET  /snapshot-chunks/:chunkId (download encoded snapshot chunks)
 * - GET  /snapshot-artifacts/:artifactId (download scoped snapshot artifacts)
 * - GET  /realtime (optional WebSocket "wake up" notifications)
 */

import type { SqlFamily, SyncCoreDb } from '@syncular/server';
import type { Hono } from 'hono';
import { registerAuditRoutes } from './routes/audit';
import { registerAuthLeaseRoutes } from './routes/auth-leases';
import { registerCombinedSyncRoutes } from './routes/combined';
import { createSyncRoutesContext } from './routes/context';
import { registerHealthRoutes } from './routes/health';
import { registerRealtimeRoutes } from './routes/realtime';
import {
  type CreateSyncRoutesOptions,
  realtimeUnsubscribeMap,
  type SyncAuthResult,
  wsConnectionManagerMap,
} from './routes/shared';
import { registerSnapshotRoutes } from './routes/snapshots';
import type { WebSocketConnectionManager } from './ws';

export type {
  CreateSyncRoutesOptions,
  NormalizedSyncCorsConfig,
  SyncAuthResult,
  SyncCorsOptions,
  SyncCorsOrigin,
  SyncCorsOriginResolver,
  SyncRoutesConfigWithRateLimit,
} from './routes/shared';
export { normalizeSyncCorsConfig } from './routes/shared';

export function createSyncRoutes<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(options: CreateSyncRoutesOptions<DB, Auth, F>): Hono {
  const ctx = createSyncRoutesContext(options);

  // Route registration order matters in Hono; keep it identical to the
  // original monolithic factory.
  registerHealthRoutes(ctx);
  registerAuthLeaseRoutes(ctx);
  registerAuditRoutes(ctx);
  registerCombinedSyncRoutes(ctx);
  registerSnapshotRoutes(ctx);
  registerRealtimeRoutes(ctx);

  return ctx.routes;
}

export function getSyncWebSocketConnectionManager(
  routes: Hono
): WebSocketConnectionManager | undefined {
  return wsConnectionManagerMap.get(routes);
}

export function getSyncRealtimeUnsubscribe(
  routes: Hono
): (() => void) | undefined {
  return realtimeUnsubscribeMap.get(routes);
}
