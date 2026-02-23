/**
 * @syncular/server-hono - Hono adapter for sync infrastructure
 *
 * This package provides Hono-specific routes for @syncular/server.
 * Keeps @syncular/server framework-agnostic.
 */

// API Key Auth
export * from './api-key-auth';

// Blob routes
export { type CreateBlobRoutesOptions, createBlobRoutes } from './blobs';

// Console
export * from './console';

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

// Route types and factory
export {
  type CreateSyncRoutesOptions,
  createSyncRoutes,
  getSyncRealtimeUnsubscribe,
  getSyncWebSocketConnectionManager,
} from './routes';

// WebSocket helpers for realtime sync
export * from './ws';
