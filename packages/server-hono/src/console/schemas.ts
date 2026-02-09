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
  scopes: z.record(z.unknown()),
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
  effectiveScopes: z.record(z.unknown()),
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
  eventType: z.enum(['push', 'pull']),
  transportPath: z.enum(['direct', 'relay']),
  actorId: z.string(),
  clientId: z.string(),
  statusCode: z.number().int(),
  outcome: z.string(),
  durationMs: z.number().int(),
  commitSeq: z.number().int().nullable(),
  operationCount: z.number().int().nullable(),
  rowCount: z.number().int().nullable(),
  tables: z.array(z.string()),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
});

export type ConsoleRequestEvent = z.infer<typeof ConsoleRequestEventSchema>;

const ConsoleRequestEventFiltersSchema = z.object({
  eventType: z.enum(['push', 'pull']).optional(),
  actorId: z.string().optional(),
  clientId: z.string().optional(),
  outcome: z.string().optional(),
});

export type ConsoleRequestEventFilters = z.infer<
  typeof ConsoleRequestEventFiltersSchema
>;

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

export type ConsoleApiKeyCreateRequest = z.infer<
  typeof ConsoleApiKeyCreateRequestSchema
>;

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

export type ConsoleApiKeyRevokeResponse = z.infer<
  typeof ConsoleApiKeyRevokeResponseSchema
>;

// ============================================================================
// Pagination Schemas (Console-specific)
// ============================================================================

export const ConsolePaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ConsolePaginationQuery = z.infer<
  typeof ConsolePaginationQuerySchema
>;

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

// ============================================================================
// Time-Series Stats Schemas
// ============================================================================

const TimeseriesIntervalSchema = z.enum(['minute', 'hour', 'day']);
export type TimeseriesInterval = z.infer<typeof TimeseriesIntervalSchema>;

const TimeseriesRangeSchema = z.enum(['1h', '6h', '24h', '7d', '30d']);
export type TimeseriesRange = z.infer<typeof TimeseriesRangeSchema>;

export const TimeseriesQuerySchema = z.object({
  interval: TimeseriesIntervalSchema.default('hour'),
  range: TimeseriesRangeSchema.default('24h'),
});

export type TimeseriesQuery = z.infer<typeof TimeseriesQuerySchema>;

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
});

export type LatencyQuery = z.infer<typeof LatencyQuerySchema>;

// ============================================================================
// Live Events Schemas (for WebSocket)
// ============================================================================

export const LiveEventSchema = z.object({
  type: z.enum(['push', 'pull', 'commit', 'client_update']),
  timestamp: z.string(),
  data: z.record(z.unknown()),
});

export type LiveEvent = z.infer<typeof LiveEventSchema>;
