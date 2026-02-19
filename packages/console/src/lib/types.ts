/**
 * Console API types - derived from OpenAPI spec
 */

export type ApiKeyType = 'relay' | 'proxy' | 'admin';

export interface ConsoleApiKey {
  keyId: string;
  keyPrefix: string;
  name: string;
  keyType: ApiKeyType;
  scopeKeys: string[];
  actorId: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ConsoleApiKeyBulkRevokeResponse {
  requestedCount: number;
  revokedCount: number;
  alreadyRevokedCount: number;
  notFoundCount: number;
  revokedKeyIds: string[];
  alreadyRevokedKeyIds: string[];
  notFoundKeyIds: string[];
}

export interface ConsoleCommitListItem {
  commitSeq: number;
  actorId: string;
  clientId: string;
  clientCommitId: string;
  createdAt: string;
  changeCount: number;
  affectedTables: string[];
  instanceId?: string;
  federatedCommitId?: string;
  localCommitSeq?: number;
}

export interface ConsoleChange {
  changeId: number;
  table: string;
  rowId: string;
  op: 'upsert' | 'delete';
  rowJson: unknown | null;
  rowVersion: number | null;
  scopes: Record<string, unknown>;
}

export interface ConsoleCommitDetail extends ConsoleCommitListItem {
  changes: ConsoleChange[];
}

export interface ConsoleClient {
  clientId: string;
  actorId: string;
  cursor: number;
  lagCommitCount: number;
  connectionPath: 'direct' | 'relay';
  connectionMode: 'polling' | 'realtime';
  realtimeConnectionCount: number;
  isRealtimeConnected: boolean;
  activityState: 'active' | 'idle' | 'stale';
  lastRequestAt: string | null;
  lastRequestType: 'push' | 'pull' | null;
  lastRequestOutcome: string | null;
  effectiveScopes: Record<string, unknown>;
  updatedAt: string;
  instanceId?: string;
  federatedClientId?: string;
}

export interface ConsoleHandler {
  table: string;
  dependsOn?: string[];
  snapshotChunkTtlMs?: number;
}

export interface ConsoleRequestEvent {
  eventId: number;
  partitionId: string;
  requestId: string;
  traceId: string | null;
  spanId: string | null;
  eventType: 'push' | 'pull';
  syncPath: 'http-combined' | 'ws-push';
  transportPath: 'direct' | 'relay';
  actorId: string;
  clientId: string;
  statusCode: number;
  outcome: string;
  responseStatus: string;
  errorCode: string | null;
  durationMs: number;
  commitSeq: number | null;
  operationCount: number | null;
  rowCount: number | null;
  subscriptionCount: number | null;
  scopesSummary: Record<string, string | string[]> | null;
  tables: string[];
  errorMessage: string | null;
  payloadRef: string | null;
  createdAt: string;
  instanceId?: string;
  federatedEventId?: string;
  localEventId?: number;
}

export interface ConsoleRequestPayload {
  payloadRef: string;
  partitionId: string;
  requestPayload: unknown;
  responsePayload: unknown | null;
  createdAt: string;
  instanceId?: string;
  federatedEventId?: string;
  localEventId?: number;
}

export interface ConsoleTimelineItem {
  type: 'commit' | 'event';
  timestamp: string;
  commit: ConsoleCommitListItem | null;
  event: ConsoleRequestEvent | null;
  instanceId?: string;
  federatedTimelineId?: string;
  localCommitSeq?: number | null;
  localEventId?: number | null;
}

export type ConsoleOperationType =
  | 'prune'
  | 'compact'
  | 'notify_data_change'
  | 'evict_client';

export interface ConsoleOperationEvent {
  operationId: number;
  operationType: ConsoleOperationType;
  consoleUserId: string | null;
  partitionId: string | null;
  targetClientId: string | null;
  requestPayload: unknown | null;
  resultPayload: unknown | null;
  createdAt: string;
  instanceId?: string;
  federatedOperationId?: string;
  localOperationId?: number;
}

export interface ConsoleNotifyDataChangeResponse {
  commitSeq: number;
  tables: string[];
  deletedChunks: number;
}

export interface SyncStats {
  commitCount: number;
  changeCount: number;
  minCommitSeq: number;
  maxCommitSeq: number;
  clientCount: number;
  activeClientCount: number;
  minActiveClientCursor: number | null;
  maxActiveClientCursor: number | null;
  partial?: boolean;
  failedInstances?: Array<{
    instanceId: string;
    reason: string;
    status?: number;
  }>;
  minCommitSeqByInstance?: Record<string, number>;
  maxCommitSeqByInstance?: Record<string, number>;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

// Time-series types
export type TimeseriesInterval = 'minute' | 'hour' | 'day';
export type TimeseriesRange = '1h' | '6h' | '24h' | '7d' | '30d';

export interface TimeseriesBucket {
  timestamp: string;
  pushCount: number;
  pullCount: number;
  errorCount: number;
  avgLatencyMs: number;
}

export interface TimeseriesStatsResponse {
  buckets: TimeseriesBucket[];
  interval: TimeseriesInterval;
  range: TimeseriesRange;
}

// Latency percentiles types
export interface LatencyPercentiles {
  p50: number;
  p90: number;
  p99: number;
}

export interface LatencyStatsResponse {
  push: LatencyPercentiles;
  pull: LatencyPercentiles;
  range: TimeseriesRange;
}

// Live events types
export interface LiveEvent {
  type:
    | 'push'
    | 'pull'
    | 'commit'
    | 'client_update'
    | 'instance_error'
    | 'error';
  timestamp: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Blob storage
// ---------------------------------------------------------------------------

export interface ConsoleBlob {
  key: string;
  size: number;
  uploaded: string;
  httpMetadata?: { contentType?: string };
}

export interface ConsoleBlobListResponse {
  items: ConsoleBlob[];
  truncated: boolean;
  cursor: string | null;
}
