/**
 * @syncular/server-hono - Console API Zod schemas
 */

import { z } from 'zod';

// ============================================================================
// Stats Schema
// ============================================================================

export const SyncStatsSchema = z.object({
  commitCount: z.number().int(),
  changeCount: z.number().int(),
  minCommitSeq: z.number().int(),
  maxCommitSeq: z.number().int(),
  clientCount: z.number().int(),
  activeClientCount: z.number().int(),
  minActiveClientCursor: z.number().int().nullable(),
  maxActiveClientCursor: z.number().int().nullable(),
});

export type SyncStats = z.infer<typeof SyncStatsSchema>;

// ============================================================================
// Commit Schemas
// ============================================================================

export const ConsoleCommitListItemSchema = z.object({
  commitSeq: z.number().int(),
  actorId: z.string(),
  clientId: z.string(),
  clientCommitId: z.string(),
  createdAt: z.string(),
  changeCount: z.number().int(),
  affectedTables: z.array(z.string()),
});

export type ConsoleCommitListItem = z.infer<typeof ConsoleCommitListItemSchema>;

export const ConsoleChangeSchema = z.object({
  changeId: z.number().int(),
  table: z.string(),
  rowId: z.string(),
  op: z.enum(['upsert', 'delete']),
  rowJson: z.unknown().nullable(),
  rowVersion: z.number().int().nullable(),
  scopes: z.record(z.string(), z.unknown()),
});

export type ConsoleChange = z.infer<typeof ConsoleChangeSchema>;

export const ConsoleCommitDetailSchema = ConsoleCommitListItemSchema.extend({
  changes: z.array(ConsoleChangeSchema),
});

export type ConsoleCommitDetail = z.infer<typeof ConsoleCommitDetailSchema>;

// ============================================================================
// Client Schemas
// ============================================================================

export const ConsoleClientSchema = z.object({
  clientId: z.string(),
  actorId: z.string(),
  cursor: z.number().int(),
  lagCommitCount: z.number().int().nonnegative(),
  connectionPath: z.enum(['direct', 'relay']),
  connectionMode: z.enum(['polling', 'realtime']),
  realtimeConnectionCount: z.number().int().nonnegative(),
  isRealtimeConnected: z.boolean(),
  activityState: z.enum(['active', 'idle', 'stale']),
  lastRequestAt: z.string().nullable(),
  lastRequestType: z.enum(['push', 'pull']).nullable(),
  lastRequestOutcome: z.string().nullable(),
  effectiveScopes: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});

export type ConsoleClient = z.infer<typeof ConsoleClientSchema>;

// ============================================================================
// Handler Schemas
// ============================================================================

export const ConsoleHandlerSchema = z.object({
  table: z.string(),
  dependsOn: z.array(z.string()).optional(),
  snapshotChunkTtlMs: z.number().int().optional(),
});

export type ConsoleHandler = z.infer<typeof ConsoleHandlerSchema>;

// ============================================================================
// Prune & Compact Schemas
// ============================================================================

export const ConsolePrunePreviewSchema = z.object({
  watermarkCommitSeq: z.number().int(),
  commitsToDelete: z.number().int(),
});

export type ConsolePrunePreview = z.infer<typeof ConsolePrunePreviewSchema>;

export const ConsolePruneResultSchema = z.object({
  deletedCommits: z.number().int(),
});

export type ConsolePruneResult = z.infer<typeof ConsolePruneResultSchema>;

export const ConsoleCompactResultSchema = z.object({
  deletedChanges: z.number().int(),
});

export type ConsoleCompactResult = z.infer<typeof ConsoleCompactResultSchema>;

// ============================================================================
// Evict Schema
// ============================================================================

export const ConsoleEvictResultSchema = z.object({
  evicted: z.boolean(),
});

export type ConsoleEvictResult = z.infer<typeof ConsoleEvictResultSchema>;

// ============================================================================
// Request Event Schemas
// ============================================================================

export const ConsoleRequestEventSchema = z.object({
  eventId: z.number().int(),
  partitionId: z.string(),
  requestId: z.string(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  eventType: z.enum(['push', 'pull']),
  syncPath: z.enum(['http-combined', 'ws-push']),
  transportPath: z.enum(['direct', 'relay']),
  actorId: z.string(),
  clientId: z.string(),
  statusCode: z.number().int(),
  outcome: z.string(),
  responseStatus: z.string(),
  errorCode: z.string().nullable(),
  durationMs: z.number().int(),
  commitSeq: z.number().int().nullable(),
  operationCount: z.number().int().nullable(),
  rowCount: z.number().int().nullable(),
  subscriptionCount: z.number().int().nullable(),
  scopesSummary: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .nullable(),
  tables: z.array(z.string()),
  errorMessage: z.string().nullable(),
  payloadRef: z.string().nullable(),
  createdAt: z.string(),
});

export type ConsoleRequestEvent = z.infer<typeof ConsoleRequestEventSchema>;

export const ConsoleRequestPayloadSchema = z.object({
  payloadRef: z.string(),
  partitionId: z.string(),
  requestPayload: z.unknown(),
  responsePayload: z.unknown().nullable(),
  createdAt: z.string(),
});

export type ConsoleRequestPayload = z.infer<typeof ConsoleRequestPayloadSchema>;

export const ConsoleTimelineItemSchema = z.object({
  type: z.enum(['commit', 'event']),
  timestamp: z.string(),
  commit: ConsoleCommitListItemSchema.nullable(),
  event: ConsoleRequestEventSchema.nullable(),
});

export type ConsoleTimelineItem = z.infer<typeof ConsoleTimelineItemSchema>;

export const ConsoleClearEventsResultSchema = z.object({
  deletedCount: z.number().int(),
});

export type ConsoleClearEventsResult = z.infer<
  typeof ConsoleClearEventsResultSchema
>;

export const ConsolePruneEventsResultSchema = z.object({
  deletedCount: z.number().int(),
});

export type ConsolePruneEventsResult = z.infer<
  typeof ConsolePruneEventsResultSchema
>;

// ============================================================================
// Operation Audit Schemas
// ============================================================================

export const ConsoleOperationTypeSchema = z.enum([
  'prune',
  'compact',
  'notify_data_change',
  'evict_client',
]);

export type ConsoleOperationType = z.infer<typeof ConsoleOperationTypeSchema>;

export const ConsoleOperationEventSchema = z.object({
  operationId: z.number().int(),
  operationType: ConsoleOperationTypeSchema,
  consoleUserId: z.string().nullable(),
  partitionId: z.string().nullable(),
  targetClientId: z.string().nullable(),
  requestPayload: z.unknown().nullable(),
  resultPayload: z.unknown().nullable(),
  createdAt: z.string(),
});

export type ConsoleOperationEvent = z.infer<typeof ConsoleOperationEventSchema>;

// ============================================================================
// API Key Schemas
// ============================================================================

export const ApiKeyTypeSchema = z.enum(['relay', 'proxy', 'admin']);
export type ApiKeyType = z.infer<typeof ApiKeyTypeSchema>;

export const ConsoleApiKeySchema = z.object({
  keyId: z.string(),
  keyPrefix: z.string(),
  name: z.string(),
  keyType: ApiKeyTypeSchema,
  scopeKeys: z.array(z.string()),
  actorId: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export type ConsoleApiKey = z.infer<typeof ConsoleApiKeySchema>;

export const ConsoleApiKeyCreateRequestSchema = z.object({
  name: z.string().min(1),
  keyType: ApiKeyTypeSchema,
  scopeKeys: z.array(z.string()).optional(),
  actorId: z.string().optional(),
  expiresInDays: z.number().int().positive().optional(),
});

export const ConsoleApiKeyCreateResponseSchema = z.object({
  key: ConsoleApiKeySchema,
  secretKey: z.string(),
});

export type ConsoleApiKeyCreateResponse = z.infer<
  typeof ConsoleApiKeyCreateResponseSchema
>;

export const ConsoleApiKeyRevokeResponseSchema = z.object({
  revoked: z.boolean(),
});

export const ConsoleApiKeyBulkRevokeRequestSchema = z.object({
  keyIds: z.array(z.string().min(1)).min(1).max(200),
});

export const ConsoleApiKeyBulkRevokeResponseSchema = z.object({
  requestedCount: z.number().int().nonnegative(),
  revokedCount: z.number().int().nonnegative(),
  alreadyRevokedCount: z.number().int().nonnegative(),
  notFoundCount: z.number().int().nonnegative(),
  revokedKeyIds: z.array(z.string()),
  alreadyRevokedKeyIds: z.array(z.string()),
  notFoundKeyIds: z.array(z.string()),
});

export type ConsoleApiKeyBulkRevokeResponse = z.infer<
  typeof ConsoleApiKeyBulkRevokeResponseSchema
>;

// ============================================================================
// Pagination Schemas (Console-specific)
// ============================================================================

export const ConsolePaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ConsolePartitionQuerySchema = z.object({
  partitionId: z.string().min(1).optional(),
});

export const ConsolePartitionedPaginationQuerySchema =
  ConsolePaginationQuerySchema.extend({
    partitionId: z.string().min(1).optional(),
  });

export const ConsolePaginatedResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T
) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
  });

export type ConsolePaginatedResponse<T> = {
  items: T[];
  total: number;
  offset: number;
  limit: number;
};

export const ConsoleTimelineQuerySchema =
  ConsolePartitionedPaginationQuerySchema.extend({
    view: z.enum(['all', 'commits', 'events']).default('all'),
    eventType: z.enum(['push', 'pull']).optional(),
    actorId: z.string().optional(),
    clientId: z.string().optional(),
    requestId: z.string().optional(),
    traceId: z.string().optional(),
    table: z.string().optional(),
    outcome: z.string().optional(),
    search: z.string().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  });

export const ConsoleOperationsQuerySchema =
  ConsolePartitionedPaginationQuerySchema.extend({
    operationType: ConsoleOperationTypeSchema.optional(),
  });

// ============================================================================
// Time-Series Stats Schemas
// ============================================================================

const TimeseriesIntervalSchema = z.enum(['minute', 'hour', 'day']);
const TimeseriesRangeSchema = z.enum(['1h', '6h', '24h', '7d', '30d']);
export const TimeseriesQuerySchema = z.object({
  interval: TimeseriesIntervalSchema.default('hour'),
  range: TimeseriesRangeSchema.default('24h'),
  partitionId: z.string().min(1).optional(),
});

export const TimeseriesBucketSchema = z.object({
  timestamp: z.string(),
  pushCount: z.number().int(),
  pullCount: z.number().int(),
  errorCount: z.number().int(),
  avgLatencyMs: z.number(),
});

export type TimeseriesBucket = z.infer<typeof TimeseriesBucketSchema>;

export const TimeseriesStatsResponseSchema = z.object({
  buckets: z.array(TimeseriesBucketSchema),
  interval: TimeseriesIntervalSchema,
  range: TimeseriesRangeSchema,
});

export type TimeseriesStatsResponse = z.infer<
  typeof TimeseriesStatsResponseSchema
>;

// ============================================================================
// Latency Percentiles Schemas
// ============================================================================

export const LatencyPercentilesSchema = z.object({
  p50: z.number(),
  p90: z.number(),
  p99: z.number(),
});

export type LatencyPercentiles = z.infer<typeof LatencyPercentilesSchema>;

export const LatencyStatsResponseSchema = z.object({
  push: LatencyPercentilesSchema,
  pull: LatencyPercentilesSchema,
  range: TimeseriesRangeSchema,
});

export type LatencyStatsResponse = z.infer<typeof LatencyStatsResponseSchema>;

export const LatencyQuerySchema = z.object({
  range: TimeseriesRangeSchema.default('24h'),
  partitionId: z.string().min(1).optional(),
});

// ============================================================================
// Live Events Schemas (for WebSocket)
// ============================================================================

export const LiveEventSchema = z.object({
  type: z.enum(['push', 'pull', 'commit', 'client_update']),
  timestamp: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export type LiveEvent = z.infer<typeof LiveEventSchema>;

// ---------------------------------------------------------------------------
// Blob storage
// ---------------------------------------------------------------------------

export const ConsoleBlobSchema = z.object({
  key: z.string(),
  size: z.number().int(),
  uploaded: z.string(),
  httpMetadata: z.object({ contentType: z.string().optional() }).optional(),
});

export type ConsoleBlob = z.infer<typeof ConsoleBlobSchema>;

export const ConsoleBlobListQuerySchema = z.object({
  prefix: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const ConsoleBlobListResponseSchema = z.object({
  items: z.array(ConsoleBlobSchema),
  truncated: z.boolean(),
  cursor: z.string().nullable(),
});

export const ConsoleBlobDeleteResponseSchema = z.object({
  deleted: z.boolean(),
});
