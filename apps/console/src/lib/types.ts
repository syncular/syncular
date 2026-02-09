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

export interface ConsoleCommitListItem {
  commitSeq: number;
  actorId: string;
  clientId: string;
  clientCommitId: string;
  createdAt: string;
  changeCount: number;
  affectedTables: string[];
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
}

export interface ConsoleHandler {
  table: string;
  dependsOn?: string[];
  snapshotChunkTtlMs?: number;
}

export interface ConsoleRequestEvent {
  eventId: number;
  eventType: 'push' | 'pull';
  transportPath: 'direct' | 'relay';
  actorId: string;
  clientId: string;
  statusCode: number;
  outcome: string;
  durationMs: number;
  commitSeq: number | null;
  operationCount: number | null;
  rowCount: number | null;
  tables: string[];
  errorMessage: string | null;
  createdAt: string;
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
  type: 'push' | 'pull' | 'commit' | 'client_update';
  timestamp: string;
  data: Record<string, unknown>;
}
