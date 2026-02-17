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
export * from './blobs';
// Column-level codecs shared by typegen and runtime paths
export * from './column-codecs';
// Conflict detection utilities
export * from './conflict';
// Kysely plugin for applying column codecs in generic queries
export * from './kysely-column-codecs';
// Logging utilities
export * from './logger';
// Proxy protocol types
export * from './proxy';
// Schemas (Zod)
export * from './schemas';
// Scope types, patterns, and utilities
export * from './scopes';
// Snapshot chunk encoding helpers
export * from './snapshot-chunks';
// Telemetry abstraction
export * from './telemetry';
// Data transformation hooks
export * from './transforms';
// Transport and conflict types (protocol types come from ./schemas)
export * from './types';
// Shared runtime utilities
export * from './utils';
