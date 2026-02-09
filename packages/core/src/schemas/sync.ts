/**
 * @syncular/core - Sync protocol Zod schemas
 *
 * These schemas define the sync protocol types and can be used for:
 * - Runtime validation
 * - OpenAPI spec generation
 * - Type inference
 */

import { z } from 'zod';
import {
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  SYNC_SNAPSHOT_CHUNK_ENCODING,
} from '../snapshot-chunks';

// ============================================================================
// Operation Types
// ============================================================================

export const SyncOpSchema = z.enum(['upsert', 'delete']);
export type SyncOp = z.infer<typeof SyncOpSchema>;

// ============================================================================
// Scope Schemas
// ============================================================================

/**
 * Stored scopes on a change (single values only)
 */
const StoredScopesSchema = z.record(z.string(), z.string());

/**
 * Scope values in a subscription request (can be arrays)
 */
export const ScopeValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())])
);

// ============================================================================
// Sync Operation Schema
// ============================================================================

export const SyncOperationSchema = z.object({
  table: z.string(),
  row_id: z.string(),
  op: SyncOpSchema,
  payload: z.record(z.string(), z.unknown()).nullable(),
  base_version: z.number().int().nullable().optional(),
});

export type SyncOperation = z.infer<typeof SyncOperationSchema>;

// ============================================================================
// Push Request/Response Schemas
// ============================================================================

export const SyncPushRequestSchema = z.object({
  clientId: z.string().min(1),
  clientCommitId: z.string().min(1),
  operations: z.array(SyncOperationSchema).min(1),
  schemaVersion: z.number().int().min(1),
});

export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

const SyncOperationResultAppliedSchema = z.object({
  opIndex: z.number().int(),
  status: z.literal('applied'),
});

const SyncOperationResultConflictSchema = z.object({
  opIndex: z.number().int(),
  status: z.literal('conflict'),
  message: z.string(),
  server_version: z.number().int(),
  server_row: z.unknown(),
});

const SyncOperationResultErrorSchema = z.object({
  opIndex: z.number().int(),
  status: z.literal('error'),
  error: z.string(),
  code: z.string().optional(),
  retriable: z.boolean().optional(),
});

export const SyncOperationResultSchema = z.union([
  SyncOperationResultAppliedSchema,
  SyncOperationResultConflictSchema,
  SyncOperationResultErrorSchema,
]);

export type SyncOperationResult = z.infer<typeof SyncOperationResultSchema>;

export const SyncPushResponseSchema = z.object({
  ok: z.literal(true),
  status: z.enum(['applied', 'cached', 'rejected']),
  commitSeq: z.number().int().optional(),
  results: z.array(SyncOperationResultSchema),
});

export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

// ============================================================================
// Bootstrap State Schema
// ============================================================================

export const SyncBootstrapStateSchema = z.object({
  asOfCommitSeq: z.number().int(),
  tables: z.array(z.string()),
  tableIndex: z.number().int(),
  rowCursor: z.string().nullable(),
});

export type SyncBootstrapState = z.infer<typeof SyncBootstrapStateSchema>;

// ============================================================================
// Pull Request/Response Schemas
// ============================================================================

export const SyncSubscriptionRequestSchema = z.object({
  id: z.string().min(1),
  table: z.string().min(1),
  scopes: ScopeValuesSchema,
  params: z.record(z.string(), z.unknown()).optional(),
  cursor: z.number().int(),
  bootstrapState: SyncBootstrapStateSchema.nullable().optional(),
});

export type SyncSubscriptionRequest = z.infer<
  typeof SyncSubscriptionRequestSchema
>;

export const SyncPullRequestSchema = z.object({
  clientId: z.string().min(1),
  limitCommits: z.number().int().min(1),
  limitSnapshotRows: z.number().int().min(1).optional(),
  maxSnapshotPages: z.number().int().min(1).optional(),
  dedupeRows: z.boolean().optional(),
  subscriptions: z.array(SyncSubscriptionRequestSchema),
});

export type SyncPullRequest = z.infer<typeof SyncPullRequestSchema>;

export const SyncChangeSchema = z.object({
  table: z.string(),
  row_id: z.string(),
  op: SyncOpSchema,
  row_json: z.unknown().nullable(),
  row_version: z.number().int().nullable(),
  scopes: StoredScopesSchema,
});

export type SyncChange = z.infer<typeof SyncChangeSchema>;

export const SyncCommitSchema = z.object({
  commitSeq: z.number().int(),
  createdAt: z.string(),
  actorId: z.string(),
  changes: z.array(SyncChangeSchema),
});

export type SyncCommit = z.infer<typeof SyncCommitSchema>;

export const SyncSnapshotChunkRefSchema = z.object({
  id: z.string(),
  byteLength: z.number().int(),
  sha256: z.string(),
  encoding: z.literal(SYNC_SNAPSHOT_CHUNK_ENCODING),
  compression: z.literal(SYNC_SNAPSHOT_CHUNK_COMPRESSION),
});

export type SyncSnapshotChunkRef = z.infer<typeof SyncSnapshotChunkRefSchema>;

export const SyncSnapshotSchema = z.object({
  table: z.string(),
  rows: z.array(z.unknown()),
  chunks: z.array(SyncSnapshotChunkRefSchema).optional(),
  isFirstPage: z.boolean(),
  isLastPage: z.boolean(),
});

export type SyncSnapshot = z.infer<typeof SyncSnapshotSchema>;

export const SyncPullSubscriptionResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['active', 'revoked']),
  scopes: ScopeValuesSchema,
  bootstrap: z.boolean(),
  bootstrapState: SyncBootstrapStateSchema.nullable().optional(),
  nextCursor: z.number().int(),
  commits: z.array(SyncCommitSchema),
  snapshots: z.array(SyncSnapshotSchema).optional(),
});

export type SyncPullSubscriptionResponse = z.infer<
  typeof SyncPullSubscriptionResponseSchema
>;

export const SyncPullResponseSchema = z.object({
  ok: z.literal(true),
  subscriptions: z.array(SyncPullSubscriptionResponseSchema),
});

export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;

// ============================================================================
// Combined Sync Request/Response Schemas
// ============================================================================

export const SyncCombinedRequestSchema = z.object({
  clientId: z.string().min(1),
  push: SyncPushRequestSchema.omit({ clientId: true }).optional(),
  pull: SyncPullRequestSchema.omit({ clientId: true }).optional(),
});

export type SyncCombinedRequest = z.infer<typeof SyncCombinedRequestSchema>;

export const SyncCombinedResponseSchema = z.object({
  ok: z.literal(true),
  push: SyncPushResponseSchema.optional(),
  pull: SyncPullResponseSchema.optional(),
});

export type SyncCombinedResponse = z.infer<typeof SyncCombinedResponseSchema>;
