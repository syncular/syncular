/**
 * Hono adapter for Syncular server infrastructure.
 *
 * The root @syncular/server export stays framework-agnostic; Hono-specific
 * imports live behind this opt-in subpath.
 */

// API Key Auth
export * from './api-key-auth';

// Blob routes
export {
  type BlobAccessCheckResult,
  type BlobRouteAccessDecision,
  type CreateBlobRoutesOptions,
  createBlobRoutes,
} from './blobs';

// Console API and live gateway. Console UI mounting lives in ./console/ui and
// intentionally is not re-exported here because it requires @syncular/console.
export * from './console/gateway';
export * from './console/routes';
export * from './console/schemas';
export * from './console/types';

// Simplified server factory
export {
  createSyncServer,
  type SyncServerOptions,
  type SyncServerResult,
} from './create-server';

// OpenAPI utilities
export * from './openapi';

// Proxy
export * from './proxy';

// Rate limiting
export * from './rate-limit';

// Realtime binary sync-pack helpers
export * from './realtime-sync-packs';

// Route types and factory
export {
  type CreateSyncRoutesOptions,
  createSyncRoutes,
  getSyncRealtimeUnsubscribe,
  getSyncWebSocketConnectionManager,
  type NormalizedSyncCorsConfig,
  normalizeSyncCorsConfig,
  type SyncCorsOptions,
  type SyncCorsOrigin,
  type SyncCorsOriginResolver,
} from './routes';

// WebSocket helpers for realtime sync
export * from './ws';
