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
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION,
  SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  SYNC_SNAPSHOT_CHUNK_ENCODINGS,
} from '../snapshot-chunks';
import { SYNC_PACK_ENCODINGS } from '../sync-packs';

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
// Auth Lease Schemas
// ============================================================================

export const SYNC_AUTH_LEASE_VERSION = 1;
export const SYNC_AUTH_LEASE_PROTOCOL_VERSION = 1;
export const SYNC_AUTH_LEASE_ALG_ES256 = 'ES256';
export const SYNC_AUTH_LEASE_TYP = 'syncular-auth-lease+jws';
export const SYNC_AUTH_LEASE_CODE_MISSING = 'sync.auth_lease_missing';
export const SYNC_AUTH_LEASE_CODE_INVALID = 'sync.auth_lease_invalid';
export const SYNC_AUTH_LEASE_CODE_EXPIRED = 'sync.auth_lease_expired';
export const SYNC_AUTH_LEASE_CODE_SCHEMA_MISMATCH =
  'sync.auth_lease_schema_mismatch';
export const SYNC_AUTH_LEASE_CODE_SCOPE_MISMATCH =
  'sync.auth_lease_scope_mismatch';
export const SYNC_AUTH_LEASE_CODE_SCOPE_REVOKED =
  'sync.auth_lease_scope_revoked';
export const SYNC_AUTH_LEASE_CODE_BUSINESS_REJECTED =
  'sync.auth_lease_business_rejected';

export const SyncAuthLeaseProtectedHeaderSchema = z.object({
  alg: z.literal(SYNC_AUTH_LEASE_ALG_ES256),
  kid: z.string().min(1),
  typ: z.literal(SYNC_AUTH_LEASE_TYP),
});

export type SyncAuthLeaseProtectedHeader = z.infer<
  typeof SyncAuthLeaseProtectedHeaderSchema
>;

export const SyncAuthLeaseCapabilitiesSchema = z.object({
  allowBlobs: z.boolean(),
  allowCrdt: z.boolean(),
  allowEncryptedFields: z.boolean(),
});

export type SyncAuthLeaseCapabilities = z.infer<
  typeof SyncAuthLeaseCapabilitiesSchema
>;

export const SyncAuthLeaseScopeSchema = z.object({
  subscriptionId: z.string().min(1),
  table: z.string().min(1),
  values: ScopeValuesSchema,
  operations: z.array(SyncOpSchema).min(1),
});

export type SyncAuthLeaseScope = z.infer<typeof SyncAuthLeaseScopeSchema>;

export const SyncAuthLeasePayloadSchema = z.object({
  version: z.literal(SYNC_AUTH_LEASE_VERSION),
  leaseId: z.string().min(1),
  issuer: z.string().min(1),
  audience: z.string().min(1),
  actorId: z.string().min(1),
  subject: z.record(z.string(), z.unknown()).default({}),
  schemaVersion: z.number().int().min(1),
  protocolVersion: z.literal(SYNC_AUTH_LEASE_PROTOCOL_VERSION),
  issuedAtMs: z.number().int(),
  notBeforeMs: z.number().int(),
  expiresAtMs: z.number().int(),
  maxClockSkewMs: z.number().int().min(0),
  scopes: z.array(SyncAuthLeaseScopeSchema).min(1),
  capabilities: SyncAuthLeaseCapabilitiesSchema,
});

export type SyncAuthLeasePayload = z.infer<typeof SyncAuthLeasePayloadSchema>;

export const SyncAuthLeaseIssueRequestSchema = z.object({
  schemaVersion: z.number().int().min(1),
  ttlMs: z.number().int().positive().optional(),
  scopes: z.array(SyncAuthLeaseScopeSchema).min(1),
});

export type SyncAuthLeaseIssueRequest = z.infer<
  typeof SyncAuthLeaseIssueRequestSchema
>;

export const SyncAuthLeaseIssueResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string().min(1),
  protectedHeader: SyncAuthLeaseProtectedHeaderSchema,
  payload: SyncAuthLeasePayloadSchema,
});

export type SyncAuthLeaseIssueResponse = z.infer<
  typeof SyncAuthLeaseIssueResponseSchema
>;

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

export const SyncAuthLeaseProvenanceSchema = z.object({
  leaseId: z.string().min(1),
  leaseExpiresAtMs: z.number().int(),
  leaseStatusAtEnqueue: z.string().min(1),
  leaseScopeSummaryJson: z.string().optional(),
  leaseToken: z.string().min(1).optional(),
});

export type SyncAuthLeaseProvenance = z.infer<
  typeof SyncAuthLeaseProvenanceSchema
>;

export const SyncPushRequestSchema = z.object({
  clientId: z.string().min(1),
  clientCommitId: z.string().min(1),
  operations: z.array(SyncOperationSchema).min(1),
  schemaVersion: z.number().int().min(1),
  authLease: SyncAuthLeaseProvenanceSchema.optional(),
});

export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

export const SyncPushCommitRequestSchema = SyncPushRequestSchema.omit({
  clientId: true,
});

export type SyncPushCommitRequest = z.infer<typeof SyncPushCommitRequestSchema>;

const SyncOperationResultAppliedSchema = z.object({
  opIndex: z.number().int(),
  status: z.literal('applied'),
});

const SyncOperationResultConflictSchema = z.object({
  opIndex: z.number().int(),
  status: z.literal('conflict'),
  message: z.string(),
  code: z.string().optional(),
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

export const SyncPushBatchCommitResponseSchema = SyncPushResponseSchema.extend({
  clientCommitId: z.string().min(1),
});

export type SyncPushBatchCommitResponse = z.infer<
  typeof SyncPushBatchCommitResponseSchema
>;

export const SyncPushBatchRequestSchema = z.object({
  clientId: z.string().min(1),
  commits: z.array(SyncPushCommitRequestSchema).min(1),
});

export type SyncPushBatchRequest = z.infer<typeof SyncPushBatchRequestSchema>;

export const SyncPushBatchResponseSchema = z.object({
  ok: z.literal(true),
  commits: z.array(SyncPushBatchCommitResponseSchema),
});

export type SyncPushBatchResponse = z.infer<typeof SyncPushBatchResponseSchema>;

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

export const SyncCrdtStateVectorHintSchema = z.object({
  rowId: z.string().min(1),
  field: z.string().min(1),
  stateColumn: z.string().min(1),
  stateVectorBase64: z.string().min(1),
  syncMode: z.string().min(1),
  updatedAt: z.number().int(),
});

export type SyncCrdtStateVectorHint = z.infer<
  typeof SyncCrdtStateVectorHintSchema
>;

export const SyncSubscriptionRequestSchema = z.object({
  id: z.string().min(1),
  table: z.string().min(1),
  scopes: ScopeValuesSchema,
  params: z.record(z.string(), z.unknown()).optional(),
  cursor: z.number().int(),
  bootstrapState: SyncBootstrapStateSchema.nullable().optional(),
  verifiedRoot: z.string().optional(),
  crdtStateVectors: z
    .array(SyncCrdtStateVectorHintSchema)
    .optional()
    .default([]),
});

export type SyncSubscriptionRequest = z.infer<
  typeof SyncSubscriptionRequestSchema
>;

export const SyncSnapshotChunkEncodingSchema = z.enum(
  SYNC_SNAPSHOT_CHUNK_ENCODINGS
);
export const SyncPackEncodingSchema = z.enum(SYNC_PACK_ENCODINGS);
export const SyncScopedSnapshotArtifactKindSchema = z.literal(
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1
);
export const SyncSnapshotArtifactCompressionSchema = z.union([
  z.literal(SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE),
  z.literal(SYNC_SNAPSHOT_CHUNK_COMPRESSION),
]);

export const SyncSnapshotArtifactsRequestSchema = z.object({
  schemaVersion: z.string().min(1),
  artifactKinds: z.array(SyncScopedSnapshotArtifactKindSchema).min(1),
  compressions: z.array(SyncSnapshotArtifactCompressionSchema).optional(),
  featureSet: z.array(z.string()).optional(),
});

export type SyncSnapshotArtifactsRequest = z.infer<
  typeof SyncSnapshotArtifactsRequestSchema
>;

export const SyncPullRequestSchema = z.object({
  clientId: z.string().min(1),
  limitCommits: z.number().int().min(1),
  limitSnapshotRows: z.number().int().min(1).optional(),
  maxSnapshotPages: z.number().int().min(1).optional(),
  dedupeRows: z.boolean().optional(),
  snapshotEncodings: z.array(SyncSnapshotChunkEncodingSchema).optional(),
  snapshotArtifacts: SyncSnapshotArtifactsRequestSchema.optional(),
  syncPackEncodings: z.array(SyncPackEncodingSchema).optional(),
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

export const SyncPullSubscriptionIntegritySchema = z.object({
  partitionId: z.string(),
  previousChainRoot: z.string(),
  commitChainRoot: z.string(),
  commitSeq: z.number().int(),
});

export type SyncPullSubscriptionIntegrity = z.infer<
  typeof SyncPullSubscriptionIntegritySchema
>;

export const SyncSnapshotChunkRefSchema = z.object({
  id: z.string(),
  byteLength: z.number().int(),
  sha256: z.string(),
  encoding: SyncSnapshotChunkEncodingSchema,
  compression: z.literal(SYNC_SNAPSHOT_CHUNK_COMPRESSION),
});

export type SyncSnapshotChunkRef = z.infer<typeof SyncSnapshotChunkRefSchema>;

export const SyncSnapshotManifestChunkSchema = z.object({
  id: z.string(),
  byteLength: z.number().int(),
  sha256: z.string(),
  encoding: SyncSnapshotChunkEncodingSchema,
  compression: z.literal(SYNC_SNAPSHOT_CHUNK_COMPRESSION),
});

export const SyncSnapshotManifestSchema = z.object({
  version: z.literal(1),
  digest: z.string(),
  table: z.string(),
  asOfCommitSeq: z.number().int(),
  scopeDigest: z.string(),
  rowCursor: z.string().nullable(),
  rowLimit: z.number().int().min(1),
  nextRowCursor: z.string().nullable(),
  isFirstPage: z.boolean(),
  isLastPage: z.boolean(),
  chunks: z.array(SyncSnapshotManifestChunkSchema),
});

export type SyncSnapshotManifest = z.infer<typeof SyncSnapshotManifestSchema>;

export const SyncScopedSnapshotArtifactManifestSchema = z.object({
  version: z.literal(SYNC_SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION),
  artifactKind: z.literal(SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1),
  digest: z.string(),
  partitionId: z.string(),
  subscriptionId: z.string(),
  table: z.string(),
  schemaVersion: z.string(),
  asOfCommitSeq: z.number().int(),
  scopeDigest: z.string(),
  rowCursor: z.string().nullable(),
  rowLimit: z.number().int().min(1),
  rowCount: z.number().int().min(0),
  nextRowCursor: z.string().nullable(),
  isFirstPage: z.boolean(),
  isLastPage: z.boolean(),
  compression: z.union([
    z.literal(SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE),
    z.literal(SYNC_SNAPSHOT_CHUNK_COMPRESSION),
  ]),
  byteLength: z.number().int().min(0),
  sha256: z.string(),
  featureSet: z.array(z.string()),
});

export type SyncScopedSnapshotArtifactManifest = z.infer<
  typeof SyncScopedSnapshotArtifactManifestSchema
>;

export const SyncSnapshotArtifactRefSchema = z.object({
  id: z.string(),
  byteLength: z.number().int().min(0),
  sha256: z.string(),
  manifestDigest: z.string(),
  artifactKind: z.literal(SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1),
  compression: z.union([
    z.literal(SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE),
    z.literal(SYNC_SNAPSHOT_CHUNK_COMPRESSION),
  ]),
  rowCount: z.number().int().min(0),
  nextRowCursor: z.string().nullable(),
  isFirstPage: z.boolean(),
  isLastPage: z.boolean(),
  manifest: SyncScopedSnapshotArtifactManifestSchema,
});

export type SyncSnapshotArtifactRef = z.infer<
  typeof SyncSnapshotArtifactRefSchema
>;

export const SyncSnapshotSchema = z
  .object({
    table: z.string(),
    rows: z.array(z.unknown()),
    chunks: z.array(SyncSnapshotChunkRefSchema).optional(),
    manifest: SyncSnapshotManifestSchema.optional(),
    artifacts: z.array(SyncSnapshotArtifactRefSchema).optional(),
    isFirstPage: z.boolean(),
    isLastPage: z.boolean(),
    bootstrapStateAfter: SyncBootstrapStateSchema.nullable().optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (!snapshot.artifacts || snapshot.artifacts.length === 0) return;
    if (snapshot.rows.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rows'],
        message: 'Snapshot artifacts cannot be mixed with inline rows',
      });
    }
    if (snapshot.chunks && snapshot.chunks.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chunks'],
        message: 'Snapshot artifacts cannot be mixed with chunk refs',
      });
    }
    if (snapshot.manifest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manifest'],
        message: 'Snapshot artifacts cannot be mixed with chunk manifests',
      });
    }
  });

export type SyncSnapshot = z.infer<typeof SyncSnapshotSchema>;

export const SyncPullSubscriptionResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['active', 'revoked']),
  scopes: ScopeValuesSchema,
  bootstrap: z.boolean(),
  bootstrapState: SyncBootstrapStateSchema.nullable().optional(),
  nextCursor: z.number().int(),
  integrity: SyncPullSubscriptionIntegritySchema.optional(),
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
  syncPackEncodings: z.array(SyncPackEncodingSchema).optional(),
  push: SyncPushBatchRequestSchema.omit({ clientId: true }).optional(),
  pull: SyncPullRequestSchema.omit({ clientId: true }).optional(),
});

export type SyncCombinedRequest = z.infer<typeof SyncCombinedRequestSchema>;

export const SyncCombinedResponseSchema = z.object({
  ok: z.literal(true),
  requiredSchemaVersion: z.number().int().min(1).optional(),
  latestSchemaVersion: z.number().int().min(1).optional(),
  push: SyncPushBatchResponseSchema.optional(),
  pull: SyncPullResponseSchema.optional(),
});

export type SyncCombinedResponse = z.infer<typeof SyncCombinedResponseSchema>;
