/**
 * @syncular/core - Shared types and utilities for sync infrastructure
 *
 * This package contains:
 * - Protocol types (commit-log + subscriptions)
 * - Pure conflict detection and merge utilities
 * - Logging utilities
 * - Data transformation hooks (optional)
 * - Blob types for media/binary handling
 * - Zod schemas for runtime validation and OpenAPI
 */

// Blob transport/storage types and utilities (protocol types come from ./schemas)
export type {
  BlobSignDownloadOptions,
  BlobSignedUpload,
  BlobSignUploadOptions,
  BlobStorageAdapter,
  BlobTransport,
} from './blobs';
export {
  createBlobHash,
  createBlobRef,
  parseBlobHash,
} from './blobs';
// Conflict detection utilities
export { performFieldLevelMerge } from './conflict';
// Kysely plugin utilities
export { SerializePlugin } from './kysely-serialize';
// Logging utilities
export {
  createSyncTimer,
  logSyncEvent,
} from './logger';
// Proxy protocol types
export type {
  ProxyHandshake,
  ProxyHandshakeAck,
  ProxyMessage,
  ProxyResponse,
} from './proxy';
// Schemas (Zod)
export * from './schemas';
// Scope types, patterns, and utilities
export type {
  ScopeDefinition,
  ScopePattern,
  ScopeValues,
  StoredScopes,
} from './scopes';
export { extractScopeVars, normalizeScopes } from './scopes';
// Data transformation hooks
export * from './transforms';

// Transport and conflict types (protocol types come from ./schemas)
export type {
  ConflictCheckResult,
  MergeResult,
  MergeResultConflict,
  MergeResultOk,
  SyncTransport,
  SyncTransportBlobs,
  SyncTransportOptions,
} from './types';
export { SyncTransportError } from './types';
