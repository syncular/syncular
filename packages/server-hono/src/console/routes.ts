/**
 * @syncular/server-hono - Console API routes
 *
 * Provides monitoring and operations endpoints for the @syncular dashboard.
 *
 * Endpoints:
 * - GET  /stats           - Sync statistics
 * - GET  /commits         - Paginated commit list
 * - GET  /commits/:seq    - Single commit with changes
 * - GET  /clients         - Client cursor list
 * - GET  /handlers        - Registered handlers
 * - POST /prune           - Trigger pruning
 * - POST /prune/preview   - Preview pruning (dry run)
 * - POST /compact         - Trigger compaction
 * - DELETE /clients/:id   - Evict client
 */

import {
  createSyncularErrorResponse,
  ErrorResponseSchema,
  logSyncEvent,
  type ScopeValues,
  type StoredScopes,
  type SyncularErrorCode,
  sha256Hex,
} from '@syncular/core';
import type { SqlFamily, SyncCoreDb, SyncServerAuth } from '@syncular/server';
import {
  coerceNumber,
  compactChanges,
  notifyExternalDataChange,
  parseJsonValue,
  previewPruneSync,
  pruneSync,
  readSyncStats,
  toDialectJsonValue,
} from '@syncular/server';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { resolver } from 'hono-openapi';
import { type Generated, type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { summarizeAuditChange } from '../audit-redaction';
import { consoleValidator as zValidator } from '../validation';
import { isWebSocketOriginAllowed } from '../websocket-origin';
import {
  closeUnauthenticatedSocket,
  parseBearerToken,
  parseWebSocketAuthToken,
} from './live-auth';
import { describeConsoleRoute } from './route-descriptor';
import { isBenignConsoleSchemaError } from './schema-errors';
import {
  type ApiKeyType,
  ApiKeyTypeSchema,
  type ConsoleApiKey,
  ConsoleApiKeyBulkRevokeRequestSchema,
  type ConsoleApiKeyBulkRevokeResponse,
  ConsoleApiKeyBulkRevokeResponseSchema,
  ConsoleApiKeyCreateRequestSchema,
  type ConsoleApiKeyCreateResponse,
  ConsoleApiKeyCreateResponseSchema,
  ConsoleApiKeyRevokeResponseSchema,
  ConsoleApiKeySchema,
  ConsoleBlobDeleteResponseSchema,
  ConsoleBlobListQuerySchema,
  ConsoleBlobListResponseSchema,
  type ConsoleChange,
  type ConsoleClearEventsResult,
  ConsoleClearEventsResultSchema,
  type ConsoleClient,
  type ConsoleClientDiagnosticCodeSummary,
  type ConsoleClientDiagnosticFreshnessState,
  type ConsoleClientDiagnosticHealthSeverity,
  type ConsoleClientDiagnosticIngest,
  ConsoleClientDiagnosticIngestSchema,
  type ConsoleClientDiagnosticRecord,
  ConsoleClientDiagnosticRecordSchema,
  ConsoleClientSchema,
  type ConsoleCommitDetail,
  ConsoleCommitDetailSchema,
  type ConsoleCommitListItem,
  ConsoleCommitListItemSchema,
  type ConsoleCompactResult,
  ConsoleCompactResultSchema,
  type ConsoleDebugExportCommit,
  type ConsoleDebugExportEvent,
  type ConsoleDebugExportResponse,
  ConsoleDebugExportResponseSchema,
  type ConsoleEvictResult,
  ConsoleEvictResultSchema,
  type ConsoleHandler,
  ConsoleHandlerSchema,
  type ConsoleOperationEvent,
  ConsoleOperationEventSchema,
  ConsoleOperationsQuerySchema,
  type ConsoleOperationType,
  type ConsolePaginatedResponse,
  ConsolePaginatedResponseSchema,
  ConsolePaginationQuerySchema,
  ConsolePartitionedPaginationQuerySchema,
  ConsolePartitionQuerySchema,
  type ConsolePruneEventsResult,
  ConsolePruneEventsResultSchema,
  type ConsolePrunePreview,
  ConsolePrunePreviewSchema,
  type ConsolePruneResult,
  ConsolePruneResultSchema,
  type ConsoleRequestEvent,
  type ConsoleRequestEventResponseSummary,
  ConsoleRequestEventSchema,
  type ConsoleRequestPayload,
  ConsoleRequestPayloadSchema,
  type ConsoleRowHistoryResponse,
  ConsoleRowHistoryResponseSchema,
  type ConsoleRowInvestigationClient,
  type ConsoleRowInvestigationFinding,
  type ConsoleRowInvestigationRealtimeEvidence,
  type ConsoleRowInvestigationRequestEvidence,
  type ConsoleRowInvestigationResponse,
  ConsoleRowInvestigationResponseSchema,
  type ConsoleRowInvestigationScopeEligibility,
  type ConsoleRowInvestigationSnapshotEvidence,
  type ConsoleRowInvestigationSubscriptionEvidence,
  type ConsoleTimelineItem,
  ConsoleTimelineItemSchema,
  ConsoleTimelineQuerySchema,
  type LatencyPercentiles,
  LatencyQuerySchema,
  type LatencyStatsResponse,
  LatencyStatsResponseSchema,
  type LiveEvent,
  type SyncStats,
  SyncStatsSchema,
  type TimeseriesBucket,
  TimeseriesQuerySchema,
  type TimeseriesStatsResponse,
  TimeseriesStatsResponseSchema,
} from './schemas';
import type {
  ConsoleAuthResult,
  ConsoleEventEmitter,
  ConsoleEventListener,
  CreateConsoleRoutesOptions,
} from './types';

/**
 * Create a simple console event emitter for broadcasting live events.
 */
export function createConsoleEventEmitter(options?: {
  maxHistory?: number;
}): ConsoleEventEmitter {
  const listeners = new Set<ConsoleEventListener>();
  const history: LiveEvent[] = [];
  const maxHistory = Math.max(1, options?.maxHistory ?? 500);

  return {
    addListener(listener: ConsoleEventListener) {
      listeners.add(listener);
    },
    removeListener(listener: ConsoleEventListener) {
      listeners.delete(listener);
    },
    emit(event: LiveEvent) {
      history.push(event);
      if (history.length > maxHistory) {
        history.splice(0, history.length - maxHistory);
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Ignore errors in listeners
        }
      }
    },
    replay(replayOptions) {
      const sinceMs = replayOptions?.since
        ? Date.parse(replayOptions.since)
        : Number.NaN;
      const hasSince = Number.isFinite(sinceMs);
      const normalizedPartitionId = replayOptions?.partitionId?.trim();
      const hasPartitionFilter = Boolean(normalizedPartitionId);

      const filteredByTime = hasSince
        ? history.filter((event) => {
            const eventMs = Date.parse(event.timestamp);
            return Number.isFinite(eventMs) && eventMs > sinceMs;
          })
        : history;

      const filtered = hasPartitionFilter
        ? filteredByTime.filter((event) => {
            const eventPartitionId = event.data.partitionId;
            return (
              typeof eventPartitionId === 'string' &&
              eventPartitionId === normalizedPartitionId
            );
          })
        : filteredByTime;

      const normalizedLimit =
        replayOptions?.limit && replayOptions.limit > 0
          ? Math.floor(replayOptions.limit)
          : 100;
      const limited = filtered.slice(-normalizedLimit);
      return [...limited];
    },
  };
}

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function includesSearchTerm(
  value: string | null | undefined,
  searchTerm: string | null
): boolean {
  if (!searchTerm) return true;
  if (!value) return false;
  return value.toLowerCase().includes(searchTerm);
}

function parseJsonStringArray(value: unknown): string[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function parseScopesSummary(
  value: unknown
): Record<string, string | string[]> | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const summary: Record<string, string | string[]> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === 'string') {
      summary[key] = entry;
      continue;
    }
    if (!Array.isArray(entry)) continue;
    summary[key] = entry.filter(
      (value): value is string => typeof value === 'string'
    );
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function parseResponseSummary(
  value: unknown
): ConsoleRequestEventResponseSummary | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const summary: ConsoleRequestEventResponseSummary = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      summary[key] = entry;
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function scopeValueCovers(
  allowed: ScopeValues[string] | undefined,
  rowValue: string | undefined
): boolean {
  if (!rowValue || allowed === undefined) return false;
  const allowedValues = Array.isArray(allowed) ? allowed : [allowed];
  return allowedValues.includes('*') || allowedValues.includes(rowValue);
}

function assessScopeEligibility(args: {
  rowScopes: StoredScopes | null;
  clientScopes: ScopeValues | null;
}): ConsoleRowInvestigationScopeEligibility {
  if (!args.clientScopes) {
    return {
      status: 'no_client',
      requiredScopeKeys: [],
      matchedScopeKeys: [],
      missingScopeKeys: [],
    };
  }
  if (!args.rowScopes || Object.keys(args.rowScopes).length === 0) {
    return {
      status: 'unknown',
      requiredScopeKeys: [],
      matchedScopeKeys: [],
      missingScopeKeys: [],
    };
  }

  const requiredScopeKeys = Object.keys(args.rowScopes).sort();
  const matchedScopeKeys: string[] = [];
  const missingScopeKeys: string[] = [];

  for (const key of requiredScopeKeys) {
    if (scopeValueCovers(args.clientScopes[key], args.rowScopes[key])) {
      matchedScopeKeys.push(key);
      continue;
    }
    missingScopeKeys.push(key);
  }

  return {
    status: missingScopeKeys.length === 0 ? 'eligible' : 'not_eligible',
    requiredScopeKeys,
    matchedScopeKeys,
    missingScopeKeys,
  };
}

function summarizeSubscriptionEvidence(
  events: readonly ConsoleRequestEvent[]
): ConsoleRowInvestigationSubscriptionEvidence {
  const subscriptionEvents = events.filter(
    (event) =>
      event.eventType === 'pull' ||
      (event.eventType === 'sync' && event.subscriptionCount !== null)
  );
  const latest = subscriptionEvents[0] ?? null;
  const observedScopeKeys = new Set<string>();
  let revokedSubscriptionCount = 0;
  for (const event of subscriptionEvents) {
    for (const key of Object.keys(event.scopesSummary ?? {})) {
      observedScopeKeys.add(key);
    }
    revokedSubscriptionCount +=
      event.responseSummary?.revokedSubscriptionCount ?? 0;
  }

  return {
    status:
      subscriptionEvents.length === 0
        ? 'unknown'
        : revokedSubscriptionCount > 0
          ? 'revoked'
          : subscriptionEvents.some(
                (event) => (event.subscriptionCount ?? 0) > 0
              )
            ? 'observed'
            : 'not_observed',
    matchingEventCount: subscriptionEvents.length,
    latestEventId: latest?.eventId ?? null,
    latestRequestId: latest?.requestId ?? null,
    latestEventOutcome: latest?.outcome ?? null,
    latestSubscriptionCount: latest?.subscriptionCount ?? null,
    requestedTableObserved: events.length > 0,
    observedScopeKeys: Array.from(observedScopeKeys).sort(),
  };
}

function summarizeRequestEvidence(
  events: readonly ConsoleRequestEvent[]
): ConsoleRowInvestigationRequestEvidence {
  const latest = events[0] ?? null;
  const successEvents = events.filter(
    (event) => event.responseStatus === 'success'
  );
  const nonSuccessEvents = events.filter(
    (event) => event.responseStatus !== 'success'
  );
  const latestSuccess = successEvents[0] ?? null;
  const latestNonSuccess = nonSuccessEvents[0] ?? null;

  return {
    matchingEventCount: events.length,
    successEventCount: successEvents.length,
    nonSuccessEventCount: nonSuccessEvents.length,
    latestEventId: latest?.eventId ?? null,
    latestRequestId: latest?.requestId ?? null,
    latestOutcome: latest?.outcome ?? null,
    latestResponseStatus: latest?.responseStatus ?? null,
    latestErrorCode: latest?.errorCode ?? null,
    latestErrorMessage: latest?.errorMessage ?? null,
    latestSuccessRequestId: latestSuccess?.requestId ?? null,
    latestNonSuccessRequestId: latestNonSuccess?.requestId ?? null,
    latestNonSuccessResponseStatus: latestNonSuccess?.responseStatus ?? null,
    latestNonSuccessErrorCode: latestNonSuccess?.errorCode ?? null,
  };
}

function summarizeSnapshotEvidence(
  events: readonly ConsoleRequestEvent[]
): ConsoleRowInvestigationSnapshotEvidence {
  return events.reduce<ConsoleRowInvestigationSnapshotEvidence>(
    (summary, event) => {
      const responseSummary = event.responseSummary;
      summary.pageCount += responseSummary?.snapshotPageCount ?? 0;
      summary.inlineRowCount += responseSummary?.snapshotInlineRowCount ?? 0;
      summary.chunkCount += responseSummary?.snapshotChunkCount ?? 0;
      summary.chunkBytes += responseSummary?.snapshotChunkBytes ?? 0;
      summary.artifactCount += responseSummary?.snapshotArtifactCount ?? 0;
      summary.artifactBytes += responseSummary?.snapshotArtifactBytes ?? 0;
      return summary;
    },
    {
      pageCount: 0,
      inlineRowCount: 0,
      chunkCount: 0,
      chunkBytes: 0,
      artifactCount: 0,
      artifactBytes: 0,
    }
  );
}

interface RealtimeEvidenceRow {
  event_id: unknown;
  event_type: string;
  reason: string | null;
  cursor: unknown;
  latest_cursor: unknown;
}

function summarizeRealtimeEvidence(
  rows: readonly RealtimeEvidenceRow[]
): ConsoleRowInvestigationRealtimeEvidence {
  const latest = rows[0] ?? null;
  const latestPullRequired = rows.find(
    (row) => row.event_type === 'pull_required'
  );

  return {
    matchingEventCount: rows.length,
    connectedEventCount: rows.filter((row) => row.event_type === 'connected')
      .length,
    pullRequiredEventCount: rows.filter(
      (row) => row.event_type === 'pull_required'
    ).length,
    ackEventCount: rows.filter((row) => row.event_type === 'ack').length,
    rejectedEventCount: rows.filter((row) => row.event_type === 'rejected')
      .length,
    errorEventCount: rows.filter((row) => row.event_type === 'error').length,
    latestEventId: coerceNumber(latest?.event_id) ?? null,
    latestEventType: latest?.event_type ?? null,
    latestReason: latest?.reason ?? null,
    latestCursor: coerceNumber(latest?.cursor) ?? null,
    latestServerCursor: coerceNumber(latest?.latest_cursor) ?? null,
    latestPullRequiredReason: latestPullRequired?.reason ?? null,
  };
}

function normalizeRequestEventType(value: unknown): 'sync' | 'push' | 'pull' {
  if (value === 'sync' || value === 'push' || value === 'pull') {
    return value;
  }
  return 'pull';
}

function getClientActivityState(args: {
  connectionCount: number;
  updatedAt: string | null | undefined;
}): 'active' | 'idle' | 'stale' {
  if (args.connectionCount > 0) {
    return 'active';
  }

  const updatedAtMs = parseDate(args.updatedAt);
  if (updatedAtMs === null) {
    return 'stale';
  }

  const ageMs = Date.now() - updatedAtMs;
  if (ageMs <= 60_000) {
    return 'active';
  }
  if (ageMs <= 5 * 60_000) {
    return 'idle';
  }
  return 'stale';
}

function getDiagnosticFreshnessState(
  reportedAt: string,
  receivedAt: string
): ConsoleClientDiagnosticFreshnessState {
  const reportedAtMs = parseDate(reportedAt);
  const receivedAtMs = parseDate(receivedAt);
  if (reportedAtMs === null || receivedAtMs === null) {
    return 'stale';
  }

  const ageMs = Math.max(0, receivedAtMs - reportedAtMs);
  if (ageMs <= 60_000) {
    return 'active';
  }
  if (ageMs <= 5 * 60_000) {
    return 'idle';
  }
  return 'stale';
}

const diagnosticSeverityRank: Record<
  ConsoleClientDiagnosticHealthSeverity,
  number
> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function maxDiagnosticSeverity(
  current: ConsoleClientDiagnosticHealthSeverity | null,
  next: ConsoleClientDiagnosticHealthSeverity
): ConsoleClientDiagnosticHealthSeverity {
  if (!current) {
    return next;
  }
  return diagnosticSeverityRank[next] > diagnosticSeverityRank[current]
    ? next
    : current;
}

function summarizeDiagnosticCodes(
  diagnostics: ConsoleClientDiagnosticRecord['recentDiagnostics']
): {
  codes: ConsoleClientDiagnosticCodeSummary[];
  healthMaxSeverity: ConsoleClientDiagnosticHealthSeverity | null;
} {
  const summary = new Map<
    string,
    { count: number; maxLevel: ConsoleClientDiagnosticHealthSeverity }
  >();
  let healthMaxSeverity: ConsoleClientDiagnosticHealthSeverity | null = null;

  for (const event of diagnostics) {
    const code = event.code.trim();
    if (!code) {
      continue;
    }
    const level = event.level;
    healthMaxSeverity = maxDiagnosticSeverity(healthMaxSeverity, level);
    const existing = summary.get(code);
    if (!existing) {
      summary.set(code, { count: 1, maxLevel: level });
      continue;
    }
    existing.count += 1;
    existing.maxLevel = maxDiagnosticSeverity(existing.maxLevel, level);
  }

  const codes = Array.from(summary.entries())
    .map(([code, value]) => ({
      code,
      count: value.count,
      maxLevel: value.maxLevel,
    }))
    .sort((a, b) => {
      const severityDelta =
        diagnosticSeverityRank[b.maxLevel] - diagnosticSeverityRank[a.maxLevel];
      return severityDelta === 0 ? a.code.localeCompare(b.code) : severityDelta;
    });

  return { codes, healthMaxSeverity };
}

function buildQueueSummary(
  record: Pick<
    ConsoleClientDiagnosticRecord,
    'blobUploadStats' | 'conflictStats' | 'outboxStats'
  >
): Record<string, unknown> | null {
  const summary = {
    outbox: record.outboxStats,
    conflicts: record.conflictStats,
    blobUploads: record.blobUploadStats,
  };
  return Object.values(summary).some((value) => value !== null)
    ? summary
    : null;
}

function buildTimingSummary(
  timings: ConsoleClientDiagnosticRecord['recentSyncTimings']
): Record<string, unknown> | null {
  const latest = timings[timings.length - 1] ?? null;
  if (!latest && timings.length === 0) {
    return null;
  }
  return {
    count: timings.length,
    latest,
  };
}

function normalizeDiagnosticFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function findSensitiveDiagnosticField(
  value: unknown,
  path = '$',
  depth = 0
): string | null {
  if (depth > 12 || value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findSensitiveDiagnosticField(
        value[index],
        `${path}[${index}]`,
        depth + 1
      );
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (
      CLIENT_DIAGNOSTIC_SENSITIVE_KEYS.has(normalizeDiagnosticFieldKey(key))
    ) {
      return `${path}.${key}`;
    }
    const found = findSensitiveDiagnosticField(
      entry,
      `${path}.${key}`,
      depth + 1
    );
    if (found) {
      return found;
    }
  }

  return null;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function readStringProperty(
  value: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const entry = value?.[key];
  return typeof entry === 'string' && entry.length > 0 ? entry : null;
}

type TimeseriesInterval = 'minute' | 'hour' | 'day';
type TimeseriesRange = '1h' | '6h' | '24h' | '7d' | '30d';

function rangeToMs(range: TimeseriesRange): number {
  if (range === '1h') return 60 * 60 * 1000;
  if (range === '6h') return 6 * 60 * 60 * 1000;
  if (range === '24h') return 24 * 60 * 60 * 1000;
  if (range === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function intervalToMs(interval: TimeseriesInterval): number {
  if (interval === 'minute') return 60 * 1000;
  if (interval === 'hour') return 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function intervalToSqliteBucketFormat(interval: TimeseriesInterval): string {
  if (interval === 'minute') return '%Y-%m-%dT%H:%M:00.000Z';
  if (interval === 'hour') return '%Y-%m-%dT%H:00:00.000Z';
  return '%Y-%m-%dT00:00:00.000Z';
}

type TimeseriesBucketAccumulator = {
  pushCount: number;
  pullCount: number;
  errorCount: number;
  totalLatency: number;
  eventCount: number;
};

function createEmptyTimeseriesAccumulator(): TimeseriesBucketAccumulator {
  return {
    pushCount: 0,
    pullCount: 0,
    errorCount: 0,
    totalLatency: 0,
    eventCount: 0,
  };
}

function createTimeseriesBucketMap(args: {
  startTime: Date;
  rangeMs: number;
  intervalMs: number;
}): Map<string, TimeseriesBucketAccumulator> {
  const map = new Map<string, TimeseriesBucketAccumulator>();
  const bucketCount = Math.ceil(args.rangeMs / args.intervalMs);

  for (let i = 0; i < bucketCount; i++) {
    const bucketTimestamp = new Date(
      args.startTime.getTime() + i * args.intervalMs
    ).toISOString();
    map.set(bucketTimestamp, createEmptyTimeseriesAccumulator());
  }

  return map;
}

function normalizeBucketTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function finalizeTimeseriesBuckets(
  bucketMap: Map<string, TimeseriesBucketAccumulator>
): TimeseriesBucket[] {
  return Array.from(bucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timestamp, data]) => ({
      timestamp,
      pushCount: data.pushCount,
      pullCount: data.pullCount,
      errorCount: data.errorCount,
      avgLatencyMs:
        data.eventCount > 0 ? data.totalLatency / data.eventCount : 0,
    }));
}

function calculatePercentiles(latencies: number[]): LatencyPercentiles {
  if (latencies.length === 0) {
    return { p50: 0, p90: 0, p99: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const getPercentile = (p: number): number => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] ?? 0;
  };

  return {
    p50: getPercentile(50),
    p90: getPercentile(90),
    p99: getPercentile(99),
  };
}

function consoleRouteError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 501 | 503,
  code: SyncularErrorCode,
  message?: string,
  details?: Record<string, unknown>
): Response {
  return c.json(
    createSyncularErrorResponse(code, {
      ...(message ? { message } : {}),
      ...(details ? { details } : {}),
    }),
    status
  );
}

function consoleNotFound(c: Context, message?: string): Response {
  return consoleRouteError(c, 404, 'console.not_found', message);
}

function blobStorageNotConfigured(c: Context): Response {
  return consoleRouteError(c, 501, 'blob.storage_not_configured');
}

// ============================================================================
// Route Schemas
// ============================================================================

const commitSeqParamSchema = z.object({ seq: z.coerce.number().int() });
const rowHistoryParamSchema = z.object({
  table: z.string().min(1),
  rowId: z.string().min(1),
});
const clientIdParamSchema = z.object({ id: z.string().min(1) });
const eventIdParamSchema = z.object({ id: z.coerce.number().int() });
const apiKeyIdParamSchema = z.object({ id: z.string().min(1) });
const clientDiagnosticsQuerySchema =
  ConsolePartitionedPaginationQuerySchema.extend({
    clientId: z.string().min(1).optional(),
  });
const clientDiagnosticDetailQuerySchema = ConsolePartitionQuerySchema;
const clientDiagnosticHistoryQuerySchema =
  ConsolePartitionedPaginationQuerySchema;

const eventsQuerySchema = ConsolePartitionedPaginationQuerySchema.extend({
  eventType: z.enum(['sync', 'push', 'pull']).optional(),
  actorId: z.string().optional(),
  clientId: z.string().optional(),
  requestId: z.string().optional(),
  traceId: z.string().optional(),
  syncAttemptId: z.string().optional(),
  outcome: z.string().optional(),
});

const commitDetailQuerySchema = ConsolePartitionQuerySchema;
const rowHistoryQueryBaseSchema = ConsolePartitionQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeCommitSeq: z.coerce.number().int().min(1).optional(),
  afterCommitSeq: z.coerce.number().int().min(1).optional(),
});
const rowHistoryQuerySchema = rowHistoryQueryBaseSchema.refine(
  (query) =>
    query.beforeCommitSeq === undefined ||
    query.afterCommitSeq === undefined ||
    query.afterCommitSeq < query.beforeCommitSeq,
  {
    message: 'afterCommitSeq must be lower than beforeCommitSeq',
    path: ['afterCommitSeq'],
  }
);
const rowInvestigationQuerySchema = rowHistoryQueryBaseSchema
  .extend({
    clientId: z.string().min(1).optional(),
  })
  .refine(
    (query) =>
      query.beforeCommitSeq === undefined ||
      query.afterCommitSeq === undefined ||
      query.afterCommitSeq < query.beforeCommitSeq,
    {
      message: 'afterCommitSeq must be lower than beforeCommitSeq',
      path: ['afterCommitSeq'],
    }
  );
const debugExportQuerySchema = ConsolePartitionQuerySchema.extend({
  limitCommits: z.coerce.number().int().min(1).max(200).default(50),
  limitEvents: z.coerce.number().int().min(1).max(500).default(100),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
const eventDetailQuerySchema = ConsolePartitionQuerySchema;
const evictClientQuerySchema = ConsolePartitionQuerySchema;
const apiKeyStatusSchema = z.enum(['active', 'revoked', 'expiring']);

const apiKeysQuerySchema = ConsolePaginationQuerySchema.extend({
  type: ApiKeyTypeSchema.optional(),
  status: apiKeyStatusSchema.optional(),
  expiresWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});

const handlersResponseSchema = z.object({
  items: z.array(ConsoleHandlerSchema),
});

const DEFAULT_REQUEST_EVENTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REQUEST_EVENTS_MAX_ROWS = 10_000;
const DEFAULT_OPERATION_EVENTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_OPERATION_EVENTS_MAX_ROWS = 5_000;
const DEFAULT_TIMELINE_SCAN_MAX_ROWS = 10_000;
const DEFAULT_AUTO_EVENTS_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CLIENT_DIAGNOSTICS_MAX_RECORDS = 500;
const DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES = 64 * 1024;
const CLIENT_DIAGNOSTIC_SENSITIVE_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'mnemonic',
  'password',
  'plaintext',
  'privatekey',
  'refreshtoken',
  'secret',
  'seedphrase',
]);

function readNonNegativeInteger(
  value: number | undefined,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function isoFromUnixMs(value: number | undefined, fallback: Date): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback.toISOString();
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return fallback.toISOString();
  }
  return date.toISOString();
}

function clientDiagnosticStoreKey(partitionId: string, clientId: string) {
  return `${partitionId}\u0000${clientId}`;
}

function buildClientDiagnosticRecord(
  payload: ConsoleClientDiagnosticIngest,
  receivedAt: Date
): ConsoleClientDiagnosticRecord {
  const { snapshot } = payload;
  const reportedAt = isoFromUnixMs(snapshot.generatedAt, receivedAt);
  const receivedAtIso = receivedAt.toISOString();
  const partialRecord = {
    clientId: payload.clientId,
    actorId: payload.actorId ?? null,
    partitionId: payload.partitionId,
    reportedAt,
    receivedAt: receivedAtIso,
    runtime: snapshot.runtime ?? null,
    connection: snapshot.connection ?? null,
    lifecycle: payload.lifecycle ?? null,
    bootstrap: snapshot.bootstrap ?? null,
    transportStats: snapshot.transportStats ?? null,
    outboxStats: snapshot.outboxStats ?? null,
    conflictStats: snapshot.conflictStats ?? null,
    blobUploadStats: snapshot.blobUploadStats ?? null,
    subscriptions: snapshot.subscriptions ?? [],
    recentDiagnostics: snapshot.recentDiagnostics ?? [],
    recentSyncTimings: snapshot.recentSyncTimings ?? [],
  };
  const diagnosticSummary = summarizeDiagnosticCodes(
    partialRecord.recentDiagnostics
  );
  const queueSummary = buildQueueSummary(partialRecord);

  return {
    ...partialRecord,
    freshnessState: getDiagnosticFreshnessState(reportedAt, receivedAtIso),
    healthMaxSeverity: diagnosticSummary.healthMaxSeverity,
    diagnosticCodesSummary: diagnosticSummary.codes,
    queueSummary,
    timingSummary: buildTimingSummary(partialRecord.recentSyncTimings),
    redactionSummary: {
      rawSnapshot: 'normalized_redacted_record',
      sensitiveKeys: 'rejected',
      payloadValues: 'client_redacted',
    },
  };
}

export function createConsoleRoutes<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
  F extends SqlFamily = SqlFamily,
>(
  options: CreateConsoleRoutesOptions<DB, Auth, F>
): Hono<{ Variables: { consoleAuth: ConsoleAuthResult } }> {
  const routes = new Hono<{
    Variables: { consoleAuth: ConsoleAuthResult };
  }>();

  routes.onError((error, context) => {
    const message =
      error instanceof Error ? error.message : 'Unknown console error';
    console.error('[console] route error', error);
    return context.json(
      createSyncularErrorResponse('console.internal', { message }),
      500
    );
  });

  interface SyncRequestEventsTable {
    event_id: number;
    partition_id: string;
    request_id: string | null;
    trace_id: string | null;
    span_id: string | null;
    event_type: string;
    sync_path: string;
    transport_path: string;
    actor_id: string;
    client_id: string;
    status_code: number;
    outcome: string;
    response_status: string;
    error_code: string | null;
    duration_ms: number;
    commit_seq: number | null;
    operation_count: number | null;
    row_count: number | null;
    subscription_count: number | null;
    scopes_summary: unknown | null;
    response_summary: unknown | null;
    tables: unknown;
    error_message: string | null;
    payload_ref: string | null;
    created_at: string;
  }

  interface SyncRequestPayloadsTable {
    payload_ref: string;
    partition_id: string;
    request_payload: unknown;
    response_payload: unknown | null;
    created_at: string;
  }

  interface SyncApiKeysTable {
    key_id: string;
    key_hash: string;
    key_prefix: string;
    name: string;
    key_type: string;
    scope_keys: unknown | null;
    actor_id: string | null;
    created_at: string;
    expires_at: string | null;
    last_used_at: string | null;
    revoked_at: string | null;
  }

  interface SyncOperationEventsTable {
    operation_id: Generated<number>;
    operation_type: string;
    console_user_id: string | null;
    partition_id: string | null;
    target_client_id: string | null;
    request_payload: unknown | null;
    result_payload: unknown | null;
    created_at: Generated<string>;
  }

  interface SyncRealtimeEventsTable {
    event_id: Generated<number>;
    partition_id: string;
    actor_id: string;
    client_id: string;
    transport_path: string;
    event_type: string;
    reason: string | null;
    cursor: number | null;
    latest_cursor: number | null;
    commit_seq: number | null;
    scope_count: number | null;
    skipped_count: number | null;
    sync_pack_encoding: string | null;
    created_at: Generated<string>;
  }

  interface SyncClientDiagnosticSnapshotsTable {
    snapshot_id: Generated<number>;
    partition_id: string;
    client_id: string;
    actor_id: string | null;
    runtime_kind: string | null;
    runtime_version: string | null;
    schema_version: number | null;
    reported_at: string;
    received_at: Generated<string>;
    lifecycle_phase: string | null;
    connection_state: string | null;
    freshness_state: string;
    health_max_severity: string | null;
    diagnostic_codes_summary: unknown | null;
    queue_summary: unknown | null;
    timing_summary: unknown | null;
    redaction_summary: unknown | null;
    snapshot_json: unknown;
  }

  type SyncOperationEventRow = Selectable<SyncOperationEventsTable>;
  type SyncClientDiagnosticSnapshotRow =
    Selectable<SyncClientDiagnosticSnapshotsTable>;

  interface ConsoleDb extends SyncCoreDb {
    sync_request_events: SyncRequestEventsTable;
    sync_request_payloads: SyncRequestPayloadsTable;
    sync_operation_events: SyncOperationEventsTable;
    sync_realtime_events: SyncRealtimeEventsTable;
    sync_client_diagnostic_snapshots: SyncClientDiagnosticSnapshotsTable;
    sync_api_keys: SyncApiKeysTable;
  }

  const db = options.db as Pick<
    Kysely<ConsoleDb>,
    'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
  >;
  const metricsAggregationMode = options.metrics?.aggregationMode ?? 'auto';
  const rawFallbackMaxEvents = Math.max(
    1,
    options.metrics?.rawFallbackMaxEvents ?? 5000
  );
  const requestEventsMaxAgeMs = readNonNegativeInteger(
    options.maintenance?.requestEventsMaxAgeMs,
    DEFAULT_REQUEST_EVENTS_MAX_AGE_MS
  );
  const requestEventsMaxRows = readNonNegativeInteger(
    options.maintenance?.requestEventsMaxRows,
    DEFAULT_REQUEST_EVENTS_MAX_ROWS
  );
  const operationEventsMaxAgeMs = readNonNegativeInteger(
    options.maintenance?.operationEventsMaxAgeMs,
    DEFAULT_OPERATION_EVENTS_MAX_AGE_MS
  );
  const operationEventsMaxRows = readNonNegativeInteger(
    options.maintenance?.operationEventsMaxRows,
    DEFAULT_OPERATION_EVENTS_MAX_ROWS
  );
  const timelineScanMaxRows = readNonNegativeInteger(
    options.maintenance?.timelineScanMaxRows,
    DEFAULT_TIMELINE_SCAN_MAX_ROWS
  );
  const autoEventsPruneIntervalMs = readNonNegativeInteger(
    options.maintenance?.autoPruneIntervalMs,
    DEFAULT_AUTO_EVENTS_PRUNE_INTERVAL_MS
  );
  const clientDiagnosticsMaxRecords = readNonNegativeInteger(
    options.maintenance?.clientDiagnosticsMaxRows,
    DEFAULT_CLIENT_DIAGNOSTICS_MAX_RECORDS
  );
  let lastEventsPruneRunAt = 0;

  // Ensure console schema exists before handlers query console tables.
  const consoleSchemaReadyPromise = (
    options.consoleSchemaReady ??
    options.dialect.ensureConsoleSchema?.(options.db) ??
    Promise.resolve()
  ).catch((err) => {
    if (isBenignConsoleSchemaError(err)) {
      return;
    }
    console.error('[console] Failed to ensure console schema:', err);
    throw err;
  });

  // CORS configuration
  const corsOrigins = options.corsOrigins ?? [
    'http://localhost:5173',
    'https://console.sync.dev',
  ];
  const allowWildcardCors = corsOrigins === '*';

  routes.use(
    '*',
    cors({
      origin: allowWildcardCors ? '*' : corsOrigins,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-Syncular-Transport-Path',
        'Baggage',
        'Sentry-Trace',
        'Traceparent',
        'Tracestate',
      ],
      exposeHeaders: ['X-Total-Count'],
      credentials: !allowWildcardCors,
    })
  );

  const ensureConsoleSchemaReady = async (
    c: Context
  ): Promise<Response | null> => {
    try {
      await consoleSchemaReadyPromise;
      return null;
    } catch {
      return consoleRouteError(c, 503, 'console.schema_unavailable');
    }
  };

  routes.use('*', async (c, next) => {
    const readyError = await ensureConsoleSchemaReady(c);
    if (readyError) {
      return readyError;
    }
    await next();
  });

  routes.use('*', async (c, next) => {
    if (c.req.method !== 'OPTIONS') {
      triggerAutomaticEventsPrune();
    }
    await next();
  });

  // Route auth middleware. Keep /events/live exempt so browser WebSocket
  // clients can authenticate with the first message instead of a header.
  routes.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path.endsWith('/events/live')) {
      await next();
      return;
    }

    const auth = await options.authenticate(c);
    if (!auth) {
      return consoleRouteError(c, 401, 'console.auth_required');
    }

    c.set('consoleAuth', auth);
    await next();
  });

  const requestEventSelectColumns = [
    'event_id',
    'partition_id',
    'request_id',
    'trace_id',
    'span_id',
    'event_type',
    'sync_path',
    'transport_path',
    'actor_id',
    'client_id',
    'status_code',
    'outcome',
    'response_status',
    'error_code',
    'duration_ms',
    'commit_seq',
    'operation_count',
    'row_count',
    'subscription_count',
    'scopes_summary',
    'response_summary',
    'tables',
    'error_message',
    'payload_ref',
    'created_at',
  ] as const;

  const mapRequestEvent = (
    row: SyncRequestEventsTable
  ): ConsoleRequestEvent => ({
    eventId: coerceNumber(row.event_id) ?? 0,
    partitionId: row.partition_id ?? 'default',
    requestId: row.request_id ?? '',
    traceId: row.trace_id ?? null,
    spanId: row.span_id ?? null,
    eventType: normalizeRequestEventType(row.event_type),
    syncPath: row.sync_path === 'ws-push' ? 'ws-push' : 'http-combined',
    transportPath: row.transport_path === 'relay' ? 'relay' : 'direct',
    actorId: row.actor_id ?? '',
    clientId: row.client_id ?? '',
    statusCode: coerceNumber(row.status_code) ?? 0,
    outcome: row.outcome ?? '',
    responseStatus: row.response_status ?? 'unknown',
    errorCode: row.error_code ?? null,
    durationMs: coerceNumber(row.duration_ms) ?? 0,
    commitSeq: coerceNumber(row.commit_seq),
    operationCount: coerceNumber(row.operation_count),
    rowCount: coerceNumber(row.row_count),
    subscriptionCount: coerceNumber(row.subscription_count),
    scopesSummary: parseScopesSummary(row.scopes_summary),
    responseSummary: parseResponseSummary(row.response_summary),
    tables: options.dialect.dbToArray(row.tables),
    errorMessage: row.error_message ?? null,
    payloadRef: row.payload_ref ?? null,
    createdAt: row.created_at ?? '',
  });

  const mapDebugExportEvent = (
    row: SyncRequestEventsTable
  ): ConsoleDebugExportEvent => {
    const mapped = mapRequestEvent(row);
    return {
      eventId: mapped.eventId,
      partitionId: mapped.partitionId,
      requestId: mapped.requestId,
      traceId: mapped.traceId,
      spanId: mapped.spanId,
      eventType: mapped.eventType,
      syncPath: mapped.syncPath,
      transportPath: mapped.transportPath,
      actorId: mapped.actorId,
      clientId: mapped.clientId,
      statusCode: mapped.statusCode,
      outcome: mapped.outcome,
      responseStatus: mapped.responseStatus,
      errorCode: mapped.errorCode,
      durationMs: mapped.durationMs,
      commitSeq: mapped.commitSeq,
      operationCount: mapped.operationCount,
      rowCount: mapped.rowCount,
      subscriptionCount: mapped.subscriptionCount,
      scopesSummary: mapped.scopesSummary,
      responseSummary: mapped.responseSummary,
      tables: mapped.tables,
      createdAt: mapped.createdAt,
    };
  };

  const operationEventSelectColumns = [
    'operation_id',
    'operation_type',
    'console_user_id',
    'partition_id',
    'target_client_id',
    'request_payload',
    'result_payload',
    'created_at',
  ] as const;

  const mapOperationEvent = (
    row: SyncOperationEventRow
  ): ConsoleOperationEvent => ({
    operationId: coerceNumber(row.operation_id) ?? 0,
    operationType:
      row.operation_type === 'prune' ||
      row.operation_type === 'compact' ||
      row.operation_type === 'notify_data_change' ||
      row.operation_type === 'evict_client'
        ? row.operation_type
        : 'prune',
    consoleUserId: row.console_user_id ?? null,
    partitionId: row.partition_id ?? null,
    targetClientId: row.target_client_id ?? null,
    requestPayload: parseJsonValue(row.request_payload),
    resultPayload: parseJsonValue(row.result_payload),
    createdAt: row.created_at ?? '',
  });

  const readRedactedCommitChanges = async (
    partitionId: string,
    commitSeqs: readonly number[]
  ): Promise<Map<number, ConsoleChange[]>> => {
    if (commitSeqs.length === 0) {
      return new Map();
    }

    const rows = await db
      .selectFrom('sync_changes')
      .select([
        'commit_seq',
        'change_id',
        'table',
        'row_id',
        'op',
        'row_json',
        'row_version',
        'scopes',
      ])
      .where('partition_id', '=', partitionId)
      .where('commit_seq', 'in', [...commitSeqs])
      .orderBy('commit_seq', 'asc')
      .orderBy('change_id', 'asc')
      .execute();

    const changesByCommitSeq = new Map<number, ConsoleChange[]>();
    for (const row of rows) {
      const commitSeq = coerceNumber(row.commit_seq);
      if (commitSeq === null) continue;
      const changes = changesByCommitSeq.get(commitSeq) ?? [];
      changes.push({
        ...summarizeAuditChange({
          table: row.table ?? '',
          op: row.op === 'delete' ? 'delete' : 'upsert',
          rowJson: row.row_json,
          scopes: row.scopes,
        }),
        changeId: coerceNumber(row.change_id) ?? 0,
        table: row.table ?? '',
        rowId: row.row_id ?? '',
        op: row.op === 'delete' ? 'delete' : 'upsert',
        rowVersion: coerceNumber(row.row_version),
      });
      changesByCommitSeq.set(commitSeq, changes);
    }

    return changesByCommitSeq;
  };

  type PruneEventsRunResult = {
    requestEventsDeleted: number;
    operationEventsDeleted: number;
    realtimeEventsDeleted: number;
    payloadSnapshotsDeleted: number;
    totalDeleted: number;
  };

  const deleteUnreferencedPayloadSnapshots = async (): Promise<number> => {
    const result = await db
      .deleteFrom('sync_request_payloads')
      .where(
        'payload_ref',
        'not in',
        db
          .selectFrom('sync_request_events')
          .select('payload_ref')
          .where('payload_ref', 'is not', null)
      )
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneRequestEventsByAge = async (): Promise<number> => {
    if (requestEventsMaxAgeMs <= 0) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - requestEventsMaxAgeMs);
    const result = await db
      .deleteFrom('sync_request_events')
      .where('created_at', '<', cutoffDate.toISOString())
      .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneRequestEventsByCount = async (): Promise<number> => {
    if (requestEventsMaxRows <= 0) {
      return 0;
    }

    const countRow = await db
      .selectFrom('sync_request_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();

    const total = coerceNumber(countRow?.total) ?? 0;
    if (total <= requestEventsMaxRows) {
      return 0;
    }

    const cutoffRow = await db
      .selectFrom('sync_request_events')
      .select(['event_id'])
      .orderBy('event_id', 'desc')
      .offset(requestEventsMaxRows)
      .limit(1)
      .executeTakeFirst();

    const cutoffEventId = coerceNumber(cutoffRow?.event_id);
    if (cutoffEventId === null) {
      return 0;
    }

    const result = await db
      .deleteFrom('sync_request_events')
      .where('event_id', '<=', cutoffEventId)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneOperationEventsByAge = async (): Promise<number> => {
    if (operationEventsMaxAgeMs <= 0) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - operationEventsMaxAgeMs);
    const result = await db
      .deleteFrom('sync_operation_events')
      .where('created_at', '<', cutoffDate.toISOString())
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneOperationEventsByCount = async (): Promise<number> => {
    if (operationEventsMaxRows <= 0) {
      return 0;
    }

    const countRow = await db
      .selectFrom('sync_operation_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    const total = coerceNumber(countRow?.total) ?? 0;
    if (total <= operationEventsMaxRows) {
      return 0;
    }

    const cutoffRow = await db
      .selectFrom('sync_operation_events')
      .select(['operation_id'])
      .orderBy('operation_id', 'desc')
      .offset(operationEventsMaxRows)
      .limit(1)
      .executeTakeFirst();

    const cutoffOperationId = coerceNumber(cutoffRow?.operation_id);
    if (cutoffOperationId === null) {
      return 0;
    }

    const result = await db
      .deleteFrom('sync_operation_events')
      .where('operation_id', '<=', cutoffOperationId)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneRealtimeEventsByAge = async (): Promise<number> => {
    if (requestEventsMaxAgeMs <= 0) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - requestEventsMaxAgeMs);
    const result = await db
      .deleteFrom('sync_realtime_events')
      .where('created_at', '<', cutoffDate.toISOString())
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneRealtimeEventsByCount = async (): Promise<number> => {
    if (requestEventsMaxRows <= 0) {
      return 0;
    }

    const countRow = await db
      .selectFrom('sync_realtime_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    const total = coerceNumber(countRow?.total) ?? 0;
    if (total <= requestEventsMaxRows) {
      return 0;
    }

    const cutoffRow = await db
      .selectFrom('sync_realtime_events')
      .select(['event_id'])
      .orderBy('event_id', 'desc')
      .offset(requestEventsMaxRows)
      .limit(1)
      .executeTakeFirst();

    const cutoffEventId = coerceNumber(cutoffRow?.event_id);
    if (cutoffEventId === null) {
      return 0;
    }

    const result = await db
      .deleteFrom('sync_realtime_events')
      .where('event_id', '<=', cutoffEventId)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  };

  const pruneConsoleEvents = async (): Promise<PruneEventsRunResult> => {
    const requestEventsDeletedByAge = await pruneRequestEventsByAge();
    const requestEventsDeletedByCount = await pruneRequestEventsByCount();
    const requestEventsDeleted =
      requestEventsDeletedByAge + requestEventsDeletedByCount;

    const operationEventsDeletedByAge = await pruneOperationEventsByAge();
    const operationEventsDeletedByCount = await pruneOperationEventsByCount();
    const operationEventsDeleted =
      operationEventsDeletedByAge + operationEventsDeletedByCount;

    const realtimeEventsDeletedByAge = await pruneRealtimeEventsByAge();
    const realtimeEventsDeletedByCount = await pruneRealtimeEventsByCount();
    const realtimeEventsDeleted =
      realtimeEventsDeletedByAge + realtimeEventsDeletedByCount;

    const payloadSnapshotsDeleted = await deleteUnreferencedPayloadSnapshots();
    const totalDeleted =
      requestEventsDeleted + operationEventsDeleted + realtimeEventsDeleted;

    return {
      requestEventsDeleted,
      operationEventsDeleted,
      realtimeEventsDeleted,
      payloadSnapshotsDeleted,
      totalDeleted,
    };
  };

  let eventsPrunePromise: Promise<PruneEventsRunResult> | null = null;

  const runEventsPrune = async (): Promise<PruneEventsRunResult> => {
    if (eventsPrunePromise) {
      return eventsPrunePromise;
    }

    let pending: Promise<PruneEventsRunResult>;
    pending = pruneConsoleEvents()
      .then((result) => {
        lastEventsPruneRunAt = Date.now();
        return result;
      })
      .finally(() => {
        if (eventsPrunePromise === pending) {
          eventsPrunePromise = null;
        }
      });

    eventsPrunePromise = pending;
    return pending;
  };

  const triggerAutomaticEventsPrune = (): void => {
    if (autoEventsPruneIntervalMs <= 0) {
      return;
    }
    if (eventsPrunePromise) {
      return;
    }
    if (Date.now() - lastEventsPruneRunAt < autoEventsPruneIntervalMs) {
      return;
    }

    void runEventsPrune()
      .then((result) => {
        if (result.totalDeleted <= 0 && result.payloadSnapshotsDeleted <= 0) {
          return;
        }

        logSyncEvent({
          event: 'console.prune_events_auto',
          deletedCount: result.totalDeleted,
          requestEventsDeleted: result.requestEventsDeleted,
          operationEventsDeleted: result.operationEventsDeleted,
          realtimeEventsDeleted: result.realtimeEventsDeleted,
          payloadDeletedCount: result.payloadSnapshotsDeleted,
        });
      })
      .catch((error) => {
        logSyncEvent({
          event: 'console.prune_events_auto_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const recordOperationEvent = async (event: {
    operationType: ConsoleOperationType;
    consoleUserId?: string;
    partitionId?: string | null;
    targetClientId?: string | null;
    requestPayload?: unknown;
    resultPayload?: unknown;
  }) => {
    await db
      .insertInto('sync_operation_events')
      .values({
        operation_type: event.operationType,
        console_user_id: event.consoleUserId ?? null,
        partition_id: event.partitionId ?? null,
        target_client_id: event.targetClientId ?? null,
        request_payload:
          event.requestPayload === undefined
            ? null
            : JSON.stringify(event.requestPayload),
        result_payload:
          event.resultPayload === undefined
            ? null
            : JSON.stringify(event.resultPayload),
      })
      .execute();
  };

  const parseClientDiagnosticSnapshotRow = (
    row: SyncClientDiagnosticSnapshotRow
  ): ConsoleClientDiagnosticRecord | null => {
    const parsed = parseJsonValue(row.snapshot_json);
    const record = ConsoleClientDiagnosticRecordSchema.safeParse(parsed);
    if (!record.success) {
      return null;
    }
    return record.data;
  };

  const readClientDiagnosticRecords = async (args: {
    clientId?: string;
    clientIds?: string[];
    latestOnly: boolean;
    limit?: number;
    offset?: number;
    partitionId?: string;
  }): Promise<{ items: ConsoleClientDiagnosticRecord[]; total: number }> => {
    let query = db.selectFrom('sync_client_diagnostic_snapshots').selectAll();

    if (args.partitionId) {
      query = query.where('partition_id', '=', args.partitionId);
    }
    if (args.clientId) {
      query = query.where('client_id', '=', args.clientId);
    }
    if (args.clientIds && args.clientIds.length > 0) {
      query = query.where('client_id', 'in', args.clientIds);
    }

    const rows = await query
      .orderBy('received_at', 'desc')
      .orderBy('snapshot_id', 'desc')
      .execute();
    const items: ConsoleClientDiagnosticRecord[] = [];
    const latestKeys = new Set<string>();

    for (const row of rows) {
      const record = parseClientDiagnosticSnapshotRow(row);
      if (!record) {
        continue;
      }
      if (args.latestOnly) {
        const key = clientDiagnosticStoreKey(
          record.partitionId,
          record.clientId
        );
        if (latestKeys.has(key)) {
          continue;
        }
        latestKeys.add(key);
      }
      items.push(record);
    }

    const offset = args.offset ?? 0;
    const limit = args.limit ?? items.length;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
    };
  };

  const writeClientDiagnosticRecord = async (
    record: ConsoleClientDiagnosticRecord
  ): Promise<void> => {
    await db
      .insertInto('sync_client_diagnostic_snapshots')
      .values({
        partition_id: record.partitionId,
        client_id: record.clientId,
        actor_id: record.actorId,
        runtime_kind:
          record.runtime?.rust?.crateName ??
          record.runtime?.packageName ??
          null,
        runtime_version:
          record.runtime?.rust?.crateVersion ??
          record.runtime?.packageVersion ??
          null,
        schema_version: record.runtime?.rust?.schemaVersion ?? null,
        reported_at: record.reportedAt,
        received_at: record.receivedAt,
        lifecycle_phase: readStringProperty(record.lifecycle, 'phase'),
        connection_state:
          readStringProperty(record.connection, 'realtime') ??
          readStringProperty(record.lifecycle, 'realtime'),
        freshness_state: record.freshnessState,
        health_max_severity: record.healthMaxSeverity,
        diagnostic_codes_summary: toDialectJsonValue(
          options.dialect,
          record.diagnosticCodesSummary
        ),
        queue_summary: toDialectJsonValue(options.dialect, record.queueSummary),
        timing_summary: toDialectJsonValue(
          options.dialect,
          record.timingSummary
        ),
        redaction_summary: toDialectJsonValue(
          options.dialect,
          record.redactionSummary
        ),
        snapshot_json: toDialectJsonValue(options.dialect, record),
      })
      .execute();
  };

  const pruneClientDiagnosticRecordsByCount = async (): Promise<void> => {
    if (clientDiagnosticsMaxRecords <= 0) {
      return;
    }

    const countRow = await db
      .selectFrom('sync_client_diagnostic_snapshots')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    const total = coerceNumber(countRow?.total) ?? 0;
    if (total <= clientDiagnosticsMaxRecords) {
      return;
    }

    const cutoffRow = await db
      .selectFrom('sync_client_diagnostic_snapshots')
      .select(['snapshot_id'])
      .orderBy('snapshot_id', 'desc')
      .offset(clientDiagnosticsMaxRecords)
      .limit(1)
      .executeTakeFirst();
    const cutoffSnapshotId = coerceNumber(cutoffRow?.snapshot_id);
    if (cutoffSnapshotId === null) {
      return;
    }

    await db
      .deleteFrom('sync_client_diagnostic_snapshots')
      .where('snapshot_id', '<=', cutoffSnapshotId)
      .executeTakeFirst();
  };

  const shouldUseRawMetrics = async (
    startIso: string,
    partitionId?: string
  ): Promise<boolean> => {
    if (metricsAggregationMode === 'raw') {
      return true;
    }
    if (metricsAggregationMode === 'aggregated') {
      return false;
    }

    let countQuery = db
      .selectFrom('sync_request_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .where('created_at', '>=', startIso);

    if (partitionId) {
      countQuery = countQuery.where('partition_id', '=', partitionId);
    }

    const countRow = await countQuery.executeTakeFirst();
    const total = coerceNumber(countRow?.total) ?? 0;
    return total <= rawFallbackMaxEvents;
  };

  // -------------------------------------------------------------------------
  // GET /stats
  // -------------------------------------------------------------------------

  routes.get(
    '/stats',
    describeConsoleRoute({
      summary: 'Get sync statistics',
      responses: {
        200: {
          description: 'Sync statistics',
          content: {
            'application/json': { schema: resolver(SyncStatsSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', ConsolePartitionQuerySchema),
    async (c) => {
      const { partitionId } = c.req.valid('query');

      const stats: SyncStats = await readSyncStats(options.db, {
        partitionId,
      });

      logSyncEvent({
        event: 'console.stats',
        consoleUserId: c.var.consoleAuth.consoleUserId,
      });

      return c.json(stats, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /stats/timeseries
  // -------------------------------------------------------------------------

  routes.get(
    '/stats/timeseries',
    describeConsoleRoute({
      summary: 'Get time-series statistics',
      responses: {
        200: {
          description: 'Time-series statistics',
          content: {
            'application/json': {
              schema: resolver(TimeseriesStatsResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', TimeseriesQuerySchema),
    async (c) => {
      const { interval, range, partitionId } = c.req.valid('query');

      const rangeMs = rangeToMs(range);
      const startTime = new Date(Date.now() - rangeMs);
      const startIso = startTime.toISOString();
      const intervalMs = intervalToMs(interval);
      const bucketMap = createTimeseriesBucketMap({
        startTime,
        rangeMs,
        intervalMs,
      });
      const useRawMetrics = await shouldUseRawMetrics(startIso, partitionId);

      if (useRawMetrics) {
        let eventsQuery = db
          .selectFrom('sync_request_events')
          .select(['event_type', 'duration_ms', 'outcome', 'created_at'])
          .where('created_at', '>=', startIso);

        if (partitionId) {
          eventsQuery = eventsQuery.where('partition_id', '=', partitionId);
        }

        const events = await eventsQuery.orderBy('created_at', 'asc').execute();

        for (const event of events) {
          const eventTime = parseDate(event.created_at);
          if (eventTime === null) continue;
          const bucketIndex = Math.floor(
            (eventTime - startTime.getTime()) / intervalMs
          );
          const bucketTime = new Date(
            startTime.getTime() + bucketIndex * intervalMs
          ).toISOString();

          let bucket = bucketMap.get(bucketTime);
          if (!bucket) {
            bucket = createEmptyTimeseriesAccumulator();
            bucketMap.set(bucketTime, bucket);
          }

          if (event.event_type === 'push') {
            bucket.pushCount++;
          } else if (event.event_type === 'pull') {
            bucket.pullCount++;
          }

          if (event.outcome === 'error') {
            bucket.errorCount++;
          }

          const durationMs = coerceNumber(event.duration_ms);
          if (durationMs !== null) {
            bucket.totalLatency += durationMs;
            bucket.eventCount++;
          }
        }
      } else {
        const partitionFilter = partitionId
          ? sql`and partition_id = ${partitionId}`
          : sql``;

        if (options.dialect.family === 'sqlite') {
          const bucketFormat = intervalToSqliteBucketFormat(interval);
          const rowsResult = await sql<{
            bucket: unknown;
            push_count: unknown;
            pull_count: unknown;
            event_count: unknown;
            error_count: unknown;
            avg_latency_ms: unknown;
          }>`
            select
              strftime(${bucketFormat}, created_at) as bucket,
              sum(case when event_type = 'push' then 1 else 0 end) as push_count,
              sum(case when event_type = 'pull' then 1 else 0 end) as pull_count,
              count(*) as event_count,
              sum(case when outcome = 'error' then 1 else 0 end) as error_count,
              avg(duration_ms) as avg_latency_ms
            from ${sql.table('sync_request_events')}
            where created_at >= ${startIso}
            ${partitionFilter}
            group by 1
            order by 1 asc
          `.execute(options.db);

          for (const row of rowsResult.rows) {
            const bucketTimestamp = normalizeBucketTimestamp(row.bucket);
            if (!bucketTimestamp) continue;

            let bucket = bucketMap.get(bucketTimestamp);
            if (!bucket) {
              bucket = createEmptyTimeseriesAccumulator();
              bucketMap.set(bucketTimestamp, bucket);
            }

            const pushCount = coerceNumber(row.push_count) ?? 0;
            const pullCount = coerceNumber(row.pull_count) ?? 0;
            const rowEventCount = coerceNumber(row.event_count) ?? 0;
            const errorCount = coerceNumber(row.error_count) ?? 0;
            const avgLatencyMs = coerceNumber(row.avg_latency_ms);

            bucket.pushCount += pushCount;
            bucket.pullCount += pullCount;
            bucket.errorCount += errorCount;
            if (avgLatencyMs !== null && rowEventCount > 0) {
              bucket.totalLatency += avgLatencyMs * rowEventCount;
              bucket.eventCount += rowEventCount;
            }
          }
        } else {
          const rowsResult = await sql<{
            bucket: unknown;
            push_count: unknown;
            pull_count: unknown;
            event_count: unknown;
            error_count: unknown;
            avg_latency_ms: unknown;
          }>`
            select
              date_trunc(${interval}, created_at::timestamptz) as bucket,
              count(*) filter (where event_type = 'push') as push_count,
              count(*) filter (where event_type = 'pull') as pull_count,
              count(*) as event_count,
              count(*) filter (where outcome = 'error') as error_count,
              avg(duration_ms) as avg_latency_ms
            from ${sql.table('sync_request_events')}
            where created_at >= ${startIso}
            ${partitionFilter}
            group by 1
            order by 1 asc
          `.execute(options.db);

          for (const row of rowsResult.rows) {
            const bucketTimestamp = normalizeBucketTimestamp(row.bucket);
            if (!bucketTimestamp) continue;

            let bucket = bucketMap.get(bucketTimestamp);
            if (!bucket) {
              bucket = createEmptyTimeseriesAccumulator();
              bucketMap.set(bucketTimestamp, bucket);
            }

            const pushCount = coerceNumber(row.push_count) ?? 0;
            const pullCount = coerceNumber(row.pull_count) ?? 0;
            const rowEventCount = coerceNumber(row.event_count) ?? 0;
            const errorCount = coerceNumber(row.error_count) ?? 0;
            const avgLatencyMs = coerceNumber(row.avg_latency_ms);

            bucket.pushCount += pushCount;
            bucket.pullCount += pullCount;
            bucket.errorCount += errorCount;
            if (avgLatencyMs !== null && rowEventCount > 0) {
              bucket.totalLatency += avgLatencyMs * rowEventCount;
              bucket.eventCount += rowEventCount;
            }
          }
        }
      }

      const buckets: TimeseriesBucket[] = finalizeTimeseriesBuckets(bucketMap);

      const response: TimeseriesStatsResponse = {
        buckets,
        interval,
        range,
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /stats/latency
  // -------------------------------------------------------------------------

  routes.get(
    '/stats/latency',
    describeConsoleRoute({
      summary: 'Get latency percentiles',
      responses: {
        200: {
          description: 'Latency percentiles',
          content: {
            'application/json': {
              schema: resolver(LatencyStatsResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', LatencyQuerySchema),
    async (c) => {
      const { range, partitionId } = c.req.valid('query');

      const rangeMs = rangeToMs(range);
      const startTime = new Date(Date.now() - rangeMs);
      const startIso = startTime.toISOString();
      const useRawMetrics = await shouldUseRawMetrics(startIso, partitionId);

      if (!useRawMetrics && options.dialect.family !== 'sqlite') {
        const partitionFilter = partitionId
          ? sql`and partition_id = ${partitionId}`
          : sql``;
        const rowsResult = await sql<{
          event_type: unknown;
          p50: unknown;
          p90: unknown;
          p99: unknown;
        }>`
          select
            event_type,
            percentile_disc(0.5) within group (order by duration_ms) as p50,
            percentile_disc(0.9) within group (order by duration_ms) as p90,
            percentile_disc(0.99) within group (order by duration_ms) as p99
          from ${sql.table('sync_request_events')}
          where created_at >= ${startIso}
          ${partitionFilter}
          group by event_type
        `.execute(options.db);

        const push: LatencyPercentiles = { p50: 0, p90: 0, p99: 0 };
        const pull: LatencyPercentiles = { p50: 0, p90: 0, p99: 0 };

        for (const row of rowsResult.rows) {
          const eventType = normalizeRequestEventType(row.event_type);
          if (eventType === 'sync') continue;
          const target = eventType === 'push' ? push : pull;
          target.p50 = coerceNumber(row.p50) ?? 0;
          target.p90 = coerceNumber(row.p90) ?? 0;
          target.p99 = coerceNumber(row.p99) ?? 0;
        }

        const aggregatedResponse: LatencyStatsResponse = {
          push,
          pull,
          range,
        };
        return c.json(aggregatedResponse, 200);
      }

      // Raw fallback path (default for local/dev and SQLite)
      let eventsQuery = db
        .selectFrom('sync_request_events')
        .select(['event_type', 'duration_ms'])
        .where('created_at', '>=', startIso);

      if (partitionId) {
        eventsQuery = eventsQuery.where('partition_id', '=', partitionId);
      }

      const events = await eventsQuery.execute();

      const pushLatencies: number[] = [];
      const pullLatencies: number[] = [];

      for (const event of events) {
        const durationMs = coerceNumber(event.duration_ms);
        if (durationMs !== null) {
          if (event.event_type === 'push') {
            pushLatencies.push(durationMs);
          } else if (event.event_type === 'pull') {
            pullLatencies.push(durationMs);
          }
        }
      }

      const response: LatencyStatsResponse = {
        push: calculatePercentiles(pushLatencies),
        pull: calculatePercentiles(pullLatencies),
        range,
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /timeline
  // -------------------------------------------------------------------------

  routes.get(
    '/timeline',
    describeConsoleRoute({
      summary: 'List timeline items',
      responses: {
        200: {
          description: 'Paginated merged timeline',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleTimelineItemSchema)
              ),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', ConsoleTimelineQuerySchema),
    async (c) => {
      const {
        limit,
        offset,
        view,
        partitionId,
        eventType,
        actorId,
        clientId,
        requestId,
        traceId,
        syncAttemptId,
        table,
        outcome,
        search,
        from,
        to,
      } = c.req.valid('query');
      const resolvedTraceId = traceId ?? syncAttemptId;

      const items: ConsoleTimelineItem[] = [];
      const normalizedSearchTerm = search?.trim().toLowerCase() || null;
      const normalizedTable = table?.trim() || null;
      const timelineSourceScanLimit =
        timelineScanMaxRows > 0 ? timelineScanMaxRows : null;
      let timelineTruncated = false;

      if (
        view !== 'events' &&
        !eventType &&
        !outcome &&
        !requestId &&
        !resolvedTraceId
      ) {
        let commitsQuery = db
          .selectFrom('sync_commits')
          .select([
            'commit_seq',
            'actor_id',
            'client_id',
            'client_commit_id',
            'created_at',
            'change_count',
            'affected_tables',
          ]);

        if (partitionId) {
          commitsQuery = commitsQuery.where('partition_id', '=', partitionId);
        }
        if (actorId) {
          commitsQuery = commitsQuery.where('actor_id', '=', actorId);
        }
        if (clientId) {
          commitsQuery = commitsQuery.where('client_id', '=', clientId);
        }
        if (from) {
          commitsQuery = commitsQuery.where('created_at', '>=', from);
        }
        if (to) {
          commitsQuery = commitsQuery.where('created_at', '<=', to);
        }

        let commitsQueryWithOrdering = commitsQuery.orderBy(
          'created_at',
          'desc'
        );
        if (timelineSourceScanLimit !== null) {
          commitsQueryWithOrdering = commitsQueryWithOrdering.limit(
            timelineSourceScanLimit + 1
          );
        }

        const commitRows = await commitsQueryWithOrdering.execute();
        const scannedCommitRows =
          timelineSourceScanLimit === null
            ? commitRows
            : commitRows.slice(0, timelineSourceScanLimit);
        if (
          timelineSourceScanLimit !== null &&
          commitRows.length > timelineSourceScanLimit
        ) {
          timelineTruncated = true;
        }

        for (const row of scannedCommitRows) {
          const commit: ConsoleCommitListItem = {
            commitSeq: coerceNumber(row.commit_seq) ?? 0,
            actorId: row.actor_id ?? '',
            clientId: row.client_id ?? '',
            clientCommitId: row.client_commit_id ?? '',
            createdAt: row.created_at ?? '',
            changeCount: coerceNumber(row.change_count) ?? 0,
            affectedTables: options.dialect.dbToArray(row.affected_tables),
          };

          items.push({
            type: 'commit',
            timestamp: commit.createdAt,
            commit,
            event: null,
          });
        }
      }

      if (view !== 'commits') {
        let eventsQuery = db
          .selectFrom('sync_request_events')
          .select(requestEventSelectColumns);

        if (partitionId) {
          eventsQuery = eventsQuery.where('partition_id', '=', partitionId);
        }
        if (eventType) {
          eventsQuery = eventsQuery.where('event_type', '=', eventType);
        }
        if (actorId) {
          eventsQuery = eventsQuery.where('actor_id', '=', actorId);
        }
        if (clientId) {
          eventsQuery = eventsQuery.where('client_id', '=', clientId);
        }
        if (requestId) {
          eventsQuery = eventsQuery.where('request_id', '=', requestId);
        }
        if (resolvedTraceId) {
          eventsQuery = eventsQuery.where('trace_id', '=', resolvedTraceId);
        }
        if (outcome) {
          eventsQuery = eventsQuery.where('outcome', '=', outcome);
        }
        if (from) {
          eventsQuery = eventsQuery.where('created_at', '>=', from);
        }
        if (to) {
          eventsQuery = eventsQuery.where('created_at', '<=', to);
        }

        let eventsQueryWithOrdering = eventsQuery.orderBy('created_at', 'desc');
        if (timelineSourceScanLimit !== null) {
          eventsQueryWithOrdering = eventsQueryWithOrdering.limit(
            timelineSourceScanLimit + 1
          );
        }

        const eventRows = await eventsQueryWithOrdering.execute();
        const scannedEventRows =
          timelineSourceScanLimit === null
            ? eventRows
            : eventRows.slice(0, timelineSourceScanLimit);
        if (
          timelineSourceScanLimit !== null &&
          eventRows.length > timelineSourceScanLimit
        ) {
          timelineTruncated = true;
        }

        for (const row of scannedEventRows) {
          const event = mapRequestEvent(row);

          items.push({
            type: 'event',
            timestamp: event.createdAt,
            commit: null,
            event,
          });
        }
      }

      const filteredItems = items.filter((item) => {
        if (item.type === 'commit') {
          const commit = item.commit;
          if (!commit) return false;

          if (
            normalizedTable &&
            !(commit.affectedTables ?? []).includes(normalizedTable)
          ) {
            return false;
          }

          if (!normalizedSearchTerm) return true;

          const searchableCommitFields = [
            String(commit.commitSeq),
            commit.actorId,
            commit.clientId,
            commit.clientCommitId,
            ...(commit.affectedTables ?? []),
          ];

          return searchableCommitFields.some((field) =>
            includesSearchTerm(field, normalizedSearchTerm)
          );
        }

        const event = item.event;
        if (!event) return false;

        if (
          normalizedTable &&
          !(event.tables ?? []).includes(normalizedTable)
        ) {
          return false;
        }

        if (!normalizedSearchTerm) return true;

        const searchableEventFields = [
          String(event.eventId),
          event.requestId,
          event.traceId ?? '',
          event.actorId,
          event.clientId,
          event.outcome,
          event.responseStatus,
          event.errorCode ?? '',
          event.errorMessage ?? '',
          ...(event.tables ?? []),
        ];

        return searchableEventFields.some((field) =>
          includesSearchTerm(field, normalizedSearchTerm)
        );
      });

      filteredItems.sort(
        (a, b) => (parseDate(b.timestamp) ?? 0) - (parseDate(a.timestamp) ?? 0)
      );

      const total = filteredItems.length;
      const pagedItems = filteredItems.slice(offset, offset + limit);

      const response: ConsolePaginatedResponse<ConsoleTimelineItem> = {
        items: pagedItems,
        total,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(total));
      if (timelineTruncated) {
        c.header('X-Timeline-Truncated', 'true');
        if (timelineSourceScanLimit !== null) {
          c.header('X-Timeline-Scan-Limit', String(timelineSourceScanLimit));
        }
      }
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /commits
  // -------------------------------------------------------------------------

  routes.get(
    '/commits',
    describeConsoleRoute({
      summary: 'List commits',
      responses: {
        200: {
          description: 'Paginated commit list',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleCommitListItemSchema)
              ),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', ConsolePartitionedPaginationQuerySchema),
    async (c) => {
      const { limit, offset, partitionId } = c.req.valid('query');

      let query = db
        .selectFrom('sync_commits')
        .select([
          'commit_seq',
          'actor_id',
          'client_id',
          'client_commit_id',
          'created_at',
          'change_count',
          'affected_tables',
        ]);

      let countQuery = db
        .selectFrom('sync_commits')
        .select(({ fn }) => fn.countAll().as('total'));

      if (partitionId) {
        query = query.where('partition_id', '=', partitionId);
        countQuery = countQuery.where('partition_id', '=', partitionId);
      }

      const [rows, countRow] = await Promise.all([
        query
          .orderBy('commit_seq', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
      ]);

      const items: ConsoleCommitListItem[] = rows.map((row) => ({
        commitSeq: coerceNumber(row.commit_seq) ?? 0,
        actorId: row.actor_id ?? '',
        clientId: row.client_id ?? '',
        clientCommitId: row.client_commit_id ?? '',
        createdAt: row.created_at ?? '',
        changeCount: coerceNumber(row.change_count) ?? 0,
        affectedTables: options.dialect.dbToArray(row.affected_tables),
      }));

      const total = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleCommitListItem> = {
        items,
        total,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /commits/:seq
  // -------------------------------------------------------------------------

  routes.get(
    '/commits/:seq',
    describeConsoleRoute({
      summary: 'Get commit details',
      responses: {
        200: {
          description: 'Commit with changes',
          content: {
            'application/json': { schema: resolver(ConsoleCommitDetailSchema) },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', commitSeqParamSchema),
    zValidator('query', commitDetailQuerySchema),
    async (c) => {
      const { seq } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');

      let commitQuery = db
        .selectFrom('sync_commits')
        .select([
          'commit_seq',
          'actor_id',
          'client_id',
          'client_commit_id',
          'created_at',
          'change_count',
          'affected_tables',
        ])
        .where('commit_seq', '=', seq);

      if (partitionId) {
        commitQuery = commitQuery.where('partition_id', '=', partitionId);
      }

      const commitRow = await commitQuery.executeTakeFirst();

      if (!commitRow) {
        return consoleNotFound(c);
      }

      let changesQuery = db
        .selectFrom('sync_changes')
        .select([
          'change_id',
          'table',
          'row_id',
          'op',
          'row_json',
          'row_version',
          'scopes',
        ])
        .where('commit_seq', '=', seq);

      if (partitionId) {
        changesQuery = changesQuery.where('partition_id', '=', partitionId);
      }

      const changeRows = await changesQuery
        .orderBy('change_id', 'asc')
        .execute();

      const changes: ConsoleChange[] = changeRows.map((row) => {
        const op = row.op === 'delete' ? 'delete' : 'upsert';
        return {
          ...summarizeAuditChange({
            table: row.table ?? '',
            op,
            rowJson: row.row_json,
            scopes: row.scopes,
          }),
          changeId: coerceNumber(row.change_id) ?? 0,
          table: row.table ?? '',
          rowId: row.row_id ?? '',
          op,
          rowVersion: coerceNumber(row.row_version),
        };
      });

      const commit: ConsoleCommitDetail = {
        commitSeq: coerceNumber(commitRow.commit_seq) ?? 0,
        actorId: commitRow.actor_id ?? '',
        clientId: commitRow.client_id ?? '',
        clientCommitId: commitRow.client_commit_id ?? '',
        createdAt: commitRow.created_at ?? '',
        changeCount: coerceNumber(commitRow.change_count) ?? 0,
        affectedTables: parseJsonStringArray(commitRow.affected_tables),
        changes,
      };

      return c.json(commit, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /row-history/:table/:rowId
  // -------------------------------------------------------------------------

  routes.get(
    '/row-history/:table/:rowId',
    describeConsoleRoute({
      summary: 'Get redacted row history',
      responses: {
        200: {
          description: 'Redacted row history with request-event links',
          content: {
            'application/json': {
              schema: resolver(ConsoleRowHistoryResponseSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', rowHistoryParamSchema),
    zValidator('query', rowHistoryQuerySchema),
    async (c) => {
      const { table, rowId } = c.req.valid('param');
      const {
        partitionId: requestedPartitionId,
        limit,
        beforeCommitSeq,
        afterCommitSeq,
      } = c.req.valid('query');
      const partitionId = requestedPartitionId ?? 'default';

      const rows = await options.dialect.readAuditRowHistory(
        options.db as unknown as Kysely<SyncCoreDb>,
        {
          partitionId,
          table,
          rowId,
          scopes: {},
          limit,
          beforeCommitSeq,
          afterCommitSeq,
        }
      );
      if (rows.length === 0) {
        return consoleNotFound(c);
      }

      const hasMore = rows.length > limit;
      const selectedRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? Number(selectedRows[selectedRows.length - 1]?.commit_seq ?? 0)
        : null;
      const commitSeqs = Array.from(
        new Set(selectedRows.map((row) => Number(row.commit_seq)))
      );

      const eventRows =
        commitSeqs.length > 0
          ? await db
              .selectFrom('sync_request_events')
              .select(['event_id', 'commit_seq', 'request_id', 'trace_id'])
              .where('partition_id', '=', partitionId)
              .where('commit_seq', 'in', commitSeqs)
              .orderBy('event_id', 'asc')
              .execute()
          : [];
      const eventLinksByCommitSeq = new Map<
        number,
        {
          eventIds: Set<number>;
          requestIds: Set<string>;
          traceIds: Set<string>;
        }
      >();
      for (const row of eventRows) {
        const commitSeq = coerceNumber(row.commit_seq);
        if (commitSeq === null) continue;
        const links = eventLinksByCommitSeq.get(commitSeq) ?? {
          eventIds: new Set<number>(),
          requestIds: new Set<string>(),
          traceIds: new Set<string>(),
        };
        const eventId = coerceNumber(row.event_id);
        if (eventId !== null) links.eventIds.add(eventId);
        if (row.request_id) links.requestIds.add(row.request_id);
        if (row.trace_id) links.traceIds.add(row.trace_id);
        eventLinksByCommitSeq.set(commitSeq, links);
      }

      const response: ConsoleRowHistoryResponse = {
        table,
        rowId,
        partitionId,
        history: selectedRows.map((row) => {
          const commitSeq = Number(row.commit_seq);
          const links = eventLinksByCommitSeq.get(commitSeq);
          const summary = summarizeAuditChange({
            table: row.table,
            op: row.op,
            rowJson: row.row_json,
            scopes: row.scopes,
          });
          return {
            commitSeq,
            actorId: row.actor_id,
            clientId: row.client_id,
            clientCommitId: row.client_commit_id,
            createdAt: row.created_at,
            changeId: Number(row.change_id),
            table: row.table,
            rowId: row.row_id,
            op: row.op,
            rowVersion:
              row.row_version === null ? null : Number(row.row_version),
            ...summary,
            requestEventIds: links ? Array.from(links.eventIds) : [],
            requestIds: links ? Array.from(links.requestIds) : [],
            traceIds: links ? Array.from(links.traceIds) : [],
          };
        }),
        nextCursor,
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /row-investigation/:table/:rowId
  // -------------------------------------------------------------------------

  routes.get(
    '/row-investigation/:table/:rowId',
    describeConsoleRoute({
      summary: 'Investigate row visibility',
      responses: {
        200: {
          description: 'Redacted row investigation with client/event hints',
          content: {
            'application/json': {
              schema: resolver(ConsoleRowInvestigationResponseSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', rowHistoryParamSchema),
    zValidator('query', rowInvestigationQuerySchema),
    async (c) => {
      const { table, rowId } = c.req.valid('param');
      const {
        partitionId: requestedPartitionId,
        clientId,
        limit,
        beforeCommitSeq,
        afterCommitSeq,
      } = c.req.valid('query');
      const partitionId = requestedPartitionId ?? 'default';

      const rows = await options.dialect.readAuditRowHistory(
        options.db as unknown as Kysely<SyncCoreDb>,
        {
          partitionId,
          table,
          rowId,
          scopes: {},
          limit,
          beforeCommitSeq,
          afterCommitSeq,
        }
      );

      const hasMore = rows.length > limit;
      const selectedRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? Number(selectedRows[selectedRows.length - 1]?.commit_seq ?? 0)
        : null;
      const commitSeqs = Array.from(
        new Set(selectedRows.map((row) => Number(row.commit_seq)))
      );

      const eventLinkRows =
        commitSeqs.length > 0
          ? await db
              .selectFrom('sync_request_events')
              .select(['event_id', 'commit_seq', 'request_id', 'trace_id'])
              .where('partition_id', '=', partitionId)
              .where('commit_seq', 'in', commitSeqs)
              .orderBy('event_id', 'asc')
              .execute()
          : [];
      const eventLinksByCommitSeq = new Map<
        number,
        {
          eventIds: Set<number>;
          requestIds: Set<string>;
          traceIds: Set<string>;
        }
      >();
      for (const row of eventLinkRows) {
        const commitSeq = coerceNumber(row.commit_seq);
        if (commitSeq === null) continue;
        const links = eventLinksByCommitSeq.get(commitSeq) ?? {
          eventIds: new Set<number>(),
          requestIds: new Set<string>(),
          traceIds: new Set<string>(),
        };
        const eventId = coerceNumber(row.event_id);
        if (eventId !== null) links.eventIds.add(eventId);
        if (row.request_id) links.requestIds.add(row.request_id);
        if (row.trace_id) links.traceIds.add(row.trace_id);
        eventLinksByCommitSeq.set(commitSeq, links);
      }

      const history = selectedRows.map((row) => {
        const commitSeq = Number(row.commit_seq);
        const links = eventLinksByCommitSeq.get(commitSeq);
        const summary = summarizeAuditChange({
          table: row.table,
          op: row.op,
          rowJson: row.row_json,
          scopes: row.scopes,
        });
        return {
          commitSeq,
          actorId: row.actor_id,
          clientId: row.client_id,
          clientCommitId: row.client_commit_id,
          createdAt: row.created_at,
          changeId: Number(row.change_id),
          table: row.table,
          rowId: row.row_id,
          op: row.op,
          rowVersion: row.row_version === null ? null : Number(row.row_version),
          ...summary,
          requestEventIds: links ? Array.from(links.eventIds) : [],
          requestIds: links ? Array.from(links.requestIds) : [],
          traceIds: links ? Array.from(links.traceIds) : [],
        };
      });

      const latestRow = selectedRows[0] ?? null;
      const latestCommitSeq = latestRow
        ? (coerceNumber(latestRow.commit_seq) ?? 0)
        : null;
      const latestOp =
        latestRow?.op === 'delete' || latestRow?.op === 'upsert'
          ? latestRow.op
          : null;

      const clientRow = clientId
        ? await db
            .selectFrom('sync_client_cursors')
            .select([
              'client_id',
              'actor_id',
              'cursor',
              'effective_scopes',
              'updated_at',
            ])
            .where('partition_id', '=', partitionId)
            .where('client_id', '=', clientId)
            .executeTakeFirst()
        : null;

      const eventRows = await db
        .selectFrom('sync_request_events')
        .select(requestEventSelectColumns)
        .where('partition_id', '=', partitionId)
        .$if(Boolean(clientId), (query) =>
          query.where('client_id', '=', clientId ?? '')
        )
        .orderBy('created_at', 'desc')
        .limit(Math.min(Math.max(limit * 5, 25), 200))
        .execute();
      const relevantEvents = eventRows
        .map((row) => mapRequestEvent(row))
        .filter((event) => (event.tables ?? []).includes(table))
        .slice(0, limit);
      const subscriptionEvidence =
        summarizeSubscriptionEvidence(relevantEvents);
      const requestEvidence = summarizeRequestEvidence(relevantEvents);
      const snapshotEvidence = summarizeSnapshotEvidence(relevantEvents);
      const realtimeRows = clientId
        ? await db
            .selectFrom('sync_realtime_events')
            .select([
              'event_id',
              'event_type',
              'reason',
              'cursor',
              'latest_cursor',
            ])
            .where('partition_id', '=', partitionId)
            .where('client_id', '=', clientId)
            .orderBy('created_at', 'desc')
            .limit(Math.min(Math.max(limit * 5, 25), 200))
            .execute()
        : [];
      const realtimeEvidence = summarizeRealtimeEvidence(realtimeRows);

      const latestClientEvent = relevantEvents.find(
        (event) => !clientId || event.clientId === clientId
      );
      const clientScopes = clientRow
        ? (options.dialect.dbToScopes(
            clientRow.effective_scopes
          ) as ScopeValues)
        : null;
      const latestRowScopes = latestRow
        ? options.dialect.dbToScopes(latestRow.scopes)
        : null;
      const client: ConsoleRowInvestigationClient | null = clientRow
        ? {
            clientId: clientRow.client_id ?? '',
            actorId: clientRow.actor_id ?? '',
            cursor: coerceNumber(clientRow.cursor) ?? 0,
            effectiveScopeKeys: Object.keys(clientScopes ?? {}).sort(),
            updatedAt: clientRow.updated_at ?? '',
            lastRequestAt: latestClientEvent?.createdAt ?? null,
            lastRequestType: latestClientEvent?.eventType ?? null,
            lastRequestOutcome: latestClientEvent?.outcome ?? null,
          }
        : null;

      const scopeEligibility = assessScopeEligibility({
        rowScopes: latestRowScopes,
        clientScopes,
      });
      const findings: ConsoleRowInvestigationFinding[] = [];
      if (!latestRow) {
        findings.push({
          severity: 'warning',
          code: 'row.not_found',
          message:
            'No audit entry exists for this table and row in the selected partition.',
        });
      }
      if (!clientId) {
        findings.push({
          severity: 'info',
          code: 'client.not_selected',
          message:
            'Provide a client id to check cursor position and scope eligibility.',
        });
      } else if (!client) {
        findings.push({
          severity: 'warning',
          code: 'client.not_found',
          message:
            'No client cursor exists for this client in the selected partition.',
        });
      }
      if (latestOp === 'delete') {
        findings.push({
          severity: 'warning',
          code: 'row.deleted',
          message: 'The latest recorded operation for this row is a delete.',
        });
      }
      if (
        client &&
        latestCommitSeq !== null &&
        client.cursor < latestCommitSeq
      ) {
        findings.push({
          severity: 'warning',
          code: 'client.cursor_behind',
          message:
            'The client cursor is behind the latest row commit, so the row may not have been pulled yet.',
        });
      }
      if (scopeEligibility.status === 'not_eligible') {
        findings.push({
          severity: 'warning',
          code: 'scope.not_eligible',
          message:
            'The client effective scopes do not cover the latest row scopes.',
        });
      }
      if (relevantEvents.length === 0) {
        findings.push({
          severity: 'info',
          code: 'events.none_for_table',
          message:
            'No recent request events mention this table for the selected filters.',
        });
      } else if (subscriptionEvidence.status === 'revoked') {
        findings.push({
          severity: 'warning',
          code: 'subscription.revoked',
          message:
            'A relevant pull event reported at least one revoked subscription.',
        });
      } else if (subscriptionEvidence.status === 'unknown') {
        findings.push({
          severity: 'info',
          code: 'subscription.not_recorded',
          message:
            'Relevant events exist, but none include subscription-count evidence.',
        });
      } else if (subscriptionEvidence.status === 'not_observed') {
        findings.push({
          severity: 'warning',
          code: 'subscription.not_observed',
          message:
            'Relevant pull events did not report an active subscription for this table.',
        });
      }
      if (latestClientEvent && latestClientEvent.responseStatus !== 'success') {
        findings.push({
          severity: 'warning',
          code: 'events.latest_not_success',
          message:
            'The latest relevant request event did not complete successfully.',
        });
      }

      const response: ConsoleRowInvestigationResponse = {
        table,
        rowId,
        partitionId,
        clientId: clientId ?? null,
        rowKnown: history.length > 0,
        latestCommitSeq,
        latestOp,
        client,
        scopeEligibility,
        subscriptionEvidence,
        requestEvidence,
        snapshotEvidence,
        realtimeEvidence,
        history,
        relevantEvents,
        findings,
        nextCursor,
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /debug/export
  // -------------------------------------------------------------------------

  routes.get(
    '/debug/export',
    describeConsoleRoute({
      summary: 'Export a redacted debug bundle',
      responses: {
        200: {
          description: 'Size-bounded redacted debug export',
          content: {
            'application/json': {
              schema: resolver(ConsoleDebugExportResponseSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', debugExportQuerySchema),
    async (c) => {
      const {
        partitionId: requestedPartitionId,
        limitCommits,
        limitEvents,
      } = c.req.valid('query');
      const { from, to } = c.req.valid('query');
      const partitionId = requestedPartitionId ?? 'default';

      let commitsQuery = db
        .selectFrom('sync_commits')
        .select([
          'commit_seq',
          'actor_id',
          'client_id',
          'client_commit_id',
          'created_at',
          'change_count',
          'affected_tables',
        ])
        .where('partition_id', '=', partitionId);
      if (from) commitsQuery = commitsQuery.where('created_at', '>=', from);
      if (to) commitsQuery = commitsQuery.where('created_at', '<=', to);

      let eventsQuery = db
        .selectFrom('sync_request_events')
        .select(requestEventSelectColumns)
        .where('partition_id', '=', partitionId);
      if (from) eventsQuery = eventsQuery.where('created_at', '>=', from);
      if (to) eventsQuery = eventsQuery.where('created_at', '<=', to);

      const [commitRows, eventRows] = await Promise.all([
        commitsQuery
          .orderBy('commit_seq', 'desc')
          .limit(limitCommits + 1)
          .execute(),
        eventsQuery
          .orderBy('created_at', 'desc')
          .limit(limitEvents + 1)
          .execute(),
      ]);

      const selectedCommitRows = commitRows.slice(0, limitCommits);
      const selectedEventRows = eventRows.slice(0, limitEvents);
      const commitSeqs = selectedCommitRows
        .map((row) => coerceNumber(row.commit_seq))
        .filter((seq): seq is number => seq !== null);
      const changesByCommitSeq = await readRedactedCommitChanges(
        partitionId,
        commitSeqs
      );

      const commits: ConsoleDebugExportCommit[] = selectedCommitRows.map(
        (row) => {
          const commitSeq = coerceNumber(row.commit_seq) ?? 0;
          return {
            commitSeq,
            actorId: row.actor_id ?? '',
            clientId: row.client_id ?? '',
            clientCommitId: row.client_commit_id ?? '',
            createdAt: row.created_at ?? '',
            changeCount: coerceNumber(row.change_count) ?? 0,
            affectedTables: options.dialect.dbToArray(row.affected_tables),
            changes: changesByCommitSeq.get(commitSeq) ?? [],
          };
        }
      );

      const response: ConsoleDebugExportResponse = {
        generatedAt: new Date().toISOString(),
        partitionId,
        limits: {
          commits: limitCommits,
          requestEvents: limitEvents,
        },
        truncated: {
          commits: commitRows.length > limitCommits,
          requestEvents: eventRows.length > limitEvents,
        },
        commits,
        requestEvents: selectedEventRows.map(mapDebugExportEvent),
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /clients
  // -------------------------------------------------------------------------

  routes.get(
    '/clients',
    describeConsoleRoute({
      summary: 'List clients',
      responses: {
        200: {
          description: 'Paginated client list',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleClientSchema)
              ),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', ConsolePartitionedPaginationQuerySchema),
    async (c) => {
      const { limit, offset, partitionId } = c.req.valid('query');

      let clientsQuery = db
        .selectFrom('sync_client_cursors')
        .select([
          'client_id',
          'actor_id',
          'cursor',
          'effective_scopes',
          'updated_at',
        ]);
      let countQuery = db
        .selectFrom('sync_client_cursors')
        .select(({ fn }) => fn.countAll().as('total'));
      let maxCommitSeqQuery = db
        .selectFrom('sync_commits')
        .select(({ fn }) => fn.max('commit_seq').as('max_commit_seq'));

      if (partitionId) {
        clientsQuery = clientsQuery.where('partition_id', '=', partitionId);
        countQuery = countQuery.where('partition_id', '=', partitionId);
        maxCommitSeqQuery = maxCommitSeqQuery.where(
          'partition_id',
          '=',
          partitionId
        );
      }

      const [rows, countRow, maxCommitSeqRow] = await Promise.all([
        clientsQuery
          .orderBy('updated_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
        maxCommitSeqQuery.executeTakeFirst(),
      ]);

      const maxCommitSeq = coerceNumber(maxCommitSeqRow?.max_commit_seq) ?? 0;
      const pagedClientIds = rows
        .map((row) => row.client_id)
        .filter((clientId): clientId is string => typeof clientId === 'string');

      const latestEventsByClientId = new Map<
        string,
        {
          createdAt: string;
          eventType: 'sync' | 'push' | 'pull';
          outcome: string;
          transportPath: 'direct' | 'relay';
        }
      >();
      const latestDiagnosticsByClientId = new Map<
        string,
        ConsoleClientDiagnosticRecord
      >();

      if (pagedClientIds.length > 0) {
        let recentEventsQuery = db
          .selectFrom('sync_request_events')
          .select([
            'client_id',
            'event_type',
            'outcome',
            'created_at',
            'transport_path',
          ])
          .where('client_id', 'in', pagedClientIds);

        if (partitionId) {
          recentEventsQuery = recentEventsQuery.where(
            'partition_id',
            '=',
            partitionId
          );
        }

        const recentEventRows = await recentEventsQuery
          .orderBy('created_at', 'desc')
          .execute();

        for (const row of recentEventRows) {
          const clientId = row.client_id;
          if (!clientId || latestEventsByClientId.has(clientId)) {
            continue;
          }

          const eventType = normalizeRequestEventType(row.event_type);

          latestEventsByClientId.set(clientId, {
            createdAt: row.created_at ?? '',
            eventType,
            outcome: row.outcome ?? '',
            transportPath: row.transport_path === 'relay' ? 'relay' : 'direct',
          });
        }

        const diagnosticRecords = await readClientDiagnosticRecords({
          clientIds: pagedClientIds,
          latestOnly: true,
          partitionId,
        });
        for (const record of diagnosticRecords.items) {
          if (!latestDiagnosticsByClientId.has(record.clientId)) {
            latestDiagnosticsByClientId.set(record.clientId, record);
          }
        }
      }

      const items: ConsoleClient[] = rows.map((row) => {
        const clientId = row.client_id ?? '';
        const cursor = coerceNumber(row.cursor) ?? 0;
        const latestEvent = latestEventsByClientId.get(clientId);
        const latestDiagnostic = latestDiagnosticsByClientId.get(clientId);
        const connectionCount =
          options.wsConnectionManager?.getConnectionCount(clientId) ?? 0;
        const connectionPath =
          options.wsConnectionManager?.getClientTransportPath(clientId) ??
          latestEvent?.transportPath ??
          'direct';

        return {
          clientId,
          actorId: row.actor_id ?? '',
          cursor,
          lagCommitCount: Math.max(0, maxCommitSeq - cursor),
          connectionPath,
          connectionMode: connectionCount > 0 ? 'realtime' : 'polling',
          realtimeConnectionCount: connectionCount,
          isRealtimeConnected: connectionCount > 0,
          activityState: getClientActivityState({
            connectionCount,
            updatedAt: row.updated_at,
          }),
          diagnosticFreshnessState: latestDiagnostic?.freshnessState ?? null,
          diagnosticHealthMaxSeverity:
            latestDiagnostic?.healthMaxSeverity ?? null,
          diagnosticReceivedAt: latestDiagnostic?.receivedAt ?? null,
          lastRequestAt: latestEvent?.createdAt ?? null,
          lastRequestType: latestEvent?.eventType ?? null,
          lastRequestOutcome: latestEvent?.outcome ?? null,
          effectiveScopes: options.dialect.dbToScopes(row.effective_scopes),
          updatedAt: row.updated_at ?? '',
        };
      });

      const total = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleClient> = {
        items,
        total,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /client-diagnostics
  // -------------------------------------------------------------------------

  routes.post(
    '/client-diagnostics',
    describeConsoleRoute({
      summary: 'Ingest a redacted Rust client diagnostic snapshot',
      responses: {
        202: {
          description: 'Accepted client diagnostic snapshot',
          content: {
            'application/json': {
              schema: resolver(ConsoleClientDiagnosticRecordSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('json', ConsoleClientDiagnosticIngestSchema),
    async (c) => {
      const payload = c.req.valid('json');
      const sensitiveField = findSensitiveDiagnosticField(payload);
      if (sensitiveField) {
        return consoleRouteError(c, 400, 'console.invalid_request', undefined, {
          fieldPath: sensitiveField,
          reason: 'client_diagnostic_sensitive_field',
        });
      }

      const record = buildClientDiagnosticRecord(payload, new Date());
      const recordBytes = jsonByteLength(record);
      if (recordBytes > DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES) {
        return consoleRouteError(c, 400, 'console.invalid_request', undefined, {
          maxBytes: DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES,
          actualBytes: recordBytes,
          reason: 'client_diagnostic_snapshot_too_large',
        });
      }

      await writeClientDiagnosticRecord(record);
      await pruneClientDiagnosticRecordsByCount();
      return c.json(record, 202);
    }
  );

  // -------------------------------------------------------------------------
  // GET /client-diagnostics
  // -------------------------------------------------------------------------

  routes.get(
    '/client-diagnostics',
    describeConsoleRoute({
      summary: 'List latest redacted Rust client diagnostic snapshots',
      responses: {
        200: {
          description: 'Paginated client diagnostic snapshots',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(
                  ConsoleClientDiagnosticRecordSchema
                )
              ),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', clientDiagnosticsQuerySchema),
    async (c) => {
      const { limit, offset, partitionId, clientId } = c.req.valid('query');
      const records = await readClientDiagnosticRecords({
        clientId,
        latestOnly: true,
        limit,
        offset,
        partitionId,
      });

      const response: ConsolePaginatedResponse<ConsoleClientDiagnosticRecord> =
        {
          items: records.items,
          total: records.total,
          offset,
          limit,
        };

      c.header('X-Total-Count', String(records.total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /client-diagnostics/:id/history
  // -------------------------------------------------------------------------

  routes.get(
    '/client-diagnostics/:id/history',
    describeConsoleRoute({
      summary: 'List retained redacted Rust client diagnostic snapshots',
      responses: {
        200: {
          description: 'Paginated client diagnostic snapshot history',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(
                  ConsoleClientDiagnosticRecordSchema
                )
              ),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', clientIdParamSchema),
    zValidator('query', clientDiagnosticHistoryQuerySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const { limit, offset, partitionId } = c.req.valid('query');
      const records = await readClientDiagnosticRecords({
        clientId: id,
        latestOnly: false,
        limit,
        offset,
        partitionId,
      });

      const response: ConsolePaginatedResponse<ConsoleClientDiagnosticRecord> =
        {
          items: records.items,
          total: records.total,
          offset,
          limit,
        };

      c.header('X-Total-Count', String(records.total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /client-diagnostics/:id
  // -------------------------------------------------------------------------

  routes.get(
    '/client-diagnostics/:id',
    describeConsoleRoute({
      summary: 'Get latest redacted Rust client diagnostic snapshot',
      responses: {
        200: {
          description: 'Client diagnostic snapshot',
          content: {
            'application/json': {
              schema: resolver(ConsoleClientDiagnosticRecordSchema),
            },
          },
        },
        404: {
          description: 'Diagnostic snapshot not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', clientIdParamSchema),
    zValidator('query', clientDiagnosticDetailQuerySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');
      const records = await readClientDiagnosticRecords({
        clientId: id,
        latestOnly: true,
        limit: 1,
        offset: 0,
        partitionId,
      });
      const record = records.items[0] ?? null;
      if (!record) {
        return consoleNotFound(c, 'Client diagnostic snapshot not found.');
      }
      return c.json(record, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /handlers
  // -------------------------------------------------------------------------

  routes.get(
    '/handlers',
    describeConsoleRoute({
      summary: 'List registered handlers',
      responses: {
        200: {
          description: 'Handler list',
          content: {
            'application/json': { schema: resolver(handlersResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      const items: ConsoleHandler[] = options.handlers.map((handler) => ({
        table: handler.table,
        dependsOn: handler.dependsOn,
        snapshotChunkTtlMs: handler.snapshotChunkTtlMs,
      }));

      return c.json({ items }, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /operations - Operation audit log
  // -------------------------------------------------------------------------

  routes.get(
    '/operations',
    describeConsoleRoute({
      summary: 'List operation audit events',
      responses: {
        200: {
          description: 'Paginated operation events',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleOperationEventSchema)
              ),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', ConsoleOperationsQuerySchema),
    async (c) => {
      const { limit, offset, operationType, partitionId } =
        c.req.valid('query');

      let query = db
        .selectFrom('sync_operation_events')
        .select(operationEventSelectColumns);

      let countQuery = db
        .selectFrom('sync_operation_events')
        .select(({ fn }) => fn.countAll().as('total'));

      if (operationType) {
        query = query.where('operation_type', '=', operationType);
        countQuery = countQuery.where('operation_type', '=', operationType);
      }
      if (partitionId) {
        query = query.where('partition_id', '=', partitionId);
        countQuery = countQuery.where('partition_id', '=', partitionId);
      }

      const [rows, countRow] = await Promise.all([
        query
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
      ]);

      const items = rows.map((row) => mapOperationEvent(row));
      const total = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleOperationEvent> = {
        items,
        total,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /prune/preview
  // -------------------------------------------------------------------------

  routes.post(
    '/prune/preview',
    describeConsoleRoute({
      summary: 'Preview pruning',
      responses: {
        200: {
          description: 'Prune preview',
          content: {
            'application/json': { schema: resolver(ConsolePrunePreviewSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      const previews = await previewPruneSync(options.db, options.prune);
      const watermarkCommitSeq = previews.reduce(
        (max, preview) => Math.max(max, preview.watermarkCommitSeq),
        0
      );
      const commitsToDelete = previews.reduce(
        (total, preview) => total + preview.commitsToDelete,
        0
      );

      const preview: ConsolePrunePreview = {
        watermarkCommitSeq,
        commitsToDelete,
      };

      return c.json(preview, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /prune
  // -------------------------------------------------------------------------

  routes.post(
    '/prune',
    describeConsoleRoute({
      summary: 'Trigger pruning',
      responses: {
        200: {
          description: 'Prune result',
          content: {
            'application/json': { schema: resolver(ConsolePruneResultSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      const previews = await previewPruneSync(options.db, options.prune);
      const watermarkCommitSeq = previews.reduce(
        (max, preview) => Math.max(max, preview.watermarkCommitSeq),
        0
      );
      let deletedCommits = 0;
      for (const preview of previews) {
        deletedCommits += await pruneSync(options.db, {
          partitionId: preview.partitionId,
          watermarkCommitSeq: preview.watermarkCommitSeq,
          keepNewestCommits: options.prune?.keepNewestCommits,
        });
      }

      logSyncEvent({
        event: 'console.prune',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        deletedCommits,
        watermarkCommitSeq,
      });
      await recordOperationEvent({
        operationType: 'prune',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        requestPayload: {
          watermarkCommitSeq,
          keepNewestCommits: options.prune?.keepNewestCommits ?? null,
        },
        resultPayload: { deletedCommits, watermarkCommitSeq },
      });

      const result: ConsolePruneResult = { deletedCommits };
      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /compact
  // -------------------------------------------------------------------------

  routes.post(
    '/compact',
    describeConsoleRoute({
      summary: 'Trigger compaction',
      responses: {
        200: {
          description: 'Compact result',
          content: {
            'application/json': {
              schema: resolver(ConsoleCompactResultSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      const fullHistoryHours = options.compact?.fullHistoryHours ?? 24 * 7;

      const deletedChanges = await compactChanges(options.db, {
        dialect: options.dialect,
        options: { fullHistoryHours },
      });

      logSyncEvent({
        event: 'console.compact',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        deletedChanges,
        fullHistoryHours,
      });
      await recordOperationEvent({
        operationType: 'compact',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        requestPayload: { fullHistoryHours },
        resultPayload: { deletedChanges },
      });

      const result: ConsoleCompactResult = { deletedChanges };
      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /notify-data-change
  // -------------------------------------------------------------------------

  const NotifyDataChangeRequestSchema = z.object({
    tables: z.array(z.string().min(1)).min(1),
    partitionId: z.string().optional(),
  });

  const NotifyDataChangeResponseSchema = z.object({
    commitSeq: z.number(),
    tables: z.array(z.string()),
    deletedChunks: z.number(),
  });

  routes.post(
    '/notify-data-change',
    describeConsoleRoute({
      summary: 'Notify external data change',
      description:
        'Creates a synthetic commit to force re-bootstrap for affected tables. ' +
        'Use after pipeline imports or direct DB writes to notify connected clients.',
      responses: {
        200: {
          description: 'Notification result',
          content: {
            'application/json': {
              schema: resolver(NotifyDataChangeResponseSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('json', NotifyDataChangeRequestSchema),
    async (c) => {
      const body = c.req.valid('json');

      const result = await notifyExternalDataChange({
        db: options.db,
        dialect: options.dialect,
        tables: body.tables,
        partitionId: body.partitionId,
      });

      logSyncEvent({
        event: 'console.notify_data_change',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        tables: body.tables,
        commitSeq: result.commitSeq,
        deletedChunks: result.deletedChunks,
      });
      await recordOperationEvent({
        operationType: 'notify_data_change',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        partitionId: body.partitionId ?? null,
        requestPayload: {
          tables: body.tables,
          partitionId: body.partitionId ?? null,
        },
        resultPayload: result,
      });

      // Wake all WS clients so they pull immediately
      if (options.wsConnectionManager) {
        options.wsConnectionManager.notifyAllClients(result.commitSeq);
      }

      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /clients/:id
  // -------------------------------------------------------------------------

  routes.delete(
    '/clients/:id',
    describeConsoleRoute({
      summary: 'Evict client',
      responses: {
        200: {
          description: 'Evict result',
          content: {
            'application/json': { schema: resolver(ConsoleEvictResultSchema) },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', clientIdParamSchema),
    zValidator('query', evictClientQuerySchema),
    async (c) => {
      const { id: clientId } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');

      let deleteQuery = db
        .deleteFrom('sync_client_cursors')
        .where('client_id', '=', clientId);

      if (partitionId) {
        deleteQuery = deleteQuery.where('partition_id', '=', partitionId);
      }

      const res = await deleteQuery.executeTakeFirst();

      const evicted = Number(res?.numDeletedRows ?? 0) > 0;

      logSyncEvent({
        event: 'console.evict_client',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        clientId,
        evicted,
      });
      await recordOperationEvent({
        operationType: 'evict_client',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        partitionId: partitionId ?? null,
        targetClientId: clientId,
        requestPayload: { clientId, partitionId: partitionId ?? null },
        resultPayload: { evicted },
      });

      const result: ConsoleEvictResult = { evicted };
      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /events - Paginated request events list
  // -------------------------------------------------------------------------

  routes.get(
    '/events',
    describeConsoleRoute({
      summary: 'List request events',
      responses: {
        200: {
          description: 'Paginated event list',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleRequestEventSchema)
              ),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', eventsQuerySchema),
    async (c) => {
      const {
        limit,
        offset,
        partitionId,
        eventType,
        actorId,
        clientId,
        requestId,
        traceId,
        syncAttemptId,
        outcome,
      } = c.req.valid('query');
      const resolvedTraceId = traceId ?? syncAttemptId;

      let query = db
        .selectFrom('sync_request_events')
        .select(requestEventSelectColumns);

      let countQuery = db
        .selectFrom('sync_request_events')
        .select(({ fn }) => fn.countAll().as('total'));

      if (partitionId) {
        query = query.where('partition_id', '=', partitionId);
        countQuery = countQuery.where('partition_id', '=', partitionId);
      }
      if (eventType) {
        query = query.where('event_type', '=', eventType);
        countQuery = countQuery.where('event_type', '=', eventType);
      }
      if (actorId) {
        query = query.where('actor_id', '=', actorId);
        countQuery = countQuery.where('actor_id', '=', actorId);
      }
      if (clientId) {
        query = query.where('client_id', '=', clientId);
        countQuery = countQuery.where('client_id', '=', clientId);
      }
      if (requestId) {
        query = query.where('request_id', '=', requestId);
        countQuery = countQuery.where('request_id', '=', requestId);
      }
      if (resolvedTraceId) {
        query = query.where('trace_id', '=', resolvedTraceId);
        countQuery = countQuery.where('trace_id', '=', resolvedTraceId);
      }
      if (outcome) {
        query = query.where('outcome', '=', outcome);
        countQuery = countQuery.where('outcome', '=', outcome);
      }

      const [rows, countRow] = await Promise.all([
        query
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
      ]);

      const items: ConsoleRequestEvent[] = rows.map((row) =>
        mapRequestEvent(row)
      );

      const total = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleRequestEvent> = {
        items,
        total,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /events/live - WebSocket for live activity feed
  // NOTE: Must be defined BEFORE /events/:id to avoid route conflict
  // -------------------------------------------------------------------------

  if (
    options.eventEmitter &&
    options.websocket?.enabled &&
    options.websocket?.upgradeWebSocket
  ) {
    const emitter = options.eventEmitter;
    const upgradeWebSocket = options.websocket.upgradeWebSocket;
    const heartbeatIntervalMs = options.websocket.heartbeatIntervalMs ?? 30000;
    const maxMessageBytes = options.websocket.maxMessageBytes ?? 1024 * 1024;
    const maxMessagesPerWindow = options.websocket.maxMessagesPerWindow ?? 120;
    const messageRateWindowMs = options.websocket.messageRateWindowMs ?? 10000;

    type WebSocketLike = {
      send: (data: string) => void;
      close: (code?: number, reason?: string) => void;
    };

    const wsState = new WeakMap<
      WebSocketLike,
      {
        listener: ConsoleEventListener | null;
        heartbeatInterval: ReturnType<typeof setInterval> | null;
        authTimeout: ReturnType<typeof setTimeout> | null;
        isAuthenticated: boolean;
        startAuthenticatedSession: (() => void) | null;
        messageRateWindowStart: number;
        messageRateWindowCount: number;
      }
    >();

    const cleanup = (ws: WebSocketLike) => {
      const state = wsState.get(ws);
      if (!state) return;
      if (state.listener) {
        emitter.removeListener(state.listener);
      }
      if (state.heartbeatInterval) {
        clearInterval(state.heartbeatInterval);
      }
      if (state.authTimeout) {
        clearTimeout(state.authTimeout);
      }
      wsState.delete(ws);
    };

    const liveEventsWebSocketRoute = upgradeWebSocket(async (c) => {
      const authHeader = c.req.header('Authorization');
      const partitionId = c.req.query('partitionId')?.trim() || undefined;
      const replaySince = c.req.query('since');
      const replayLimitRaw = c.req.query('replayLimit');
      const replayLimitNumber = replayLimitRaw
        ? Number.parseInt(replayLimitRaw, 10)
        : Number.NaN;
      const replayLimit = Number.isFinite(replayLimitNumber)
        ? Math.max(1, Math.min(500, replayLimitNumber))
        : 100;
      const mockContext = {
        req: {
          header: (name: string) =>
            name === 'Authorization' ? authHeader : undefined,
          query: () => undefined,
        },
      } as unknown as Context;

      const initialAuth = await options.authenticate(mockContext);

      const authenticateWithBearer = async (token: string) => {
        const trimmedToken = token.trim();
        if (!trimmedToken) return null;
        const authContext = {
          req: {
            header: (name: string) =>
              name === 'Authorization' ? `Bearer ${trimmedToken}` : undefined,
            query: () => undefined,
          },
        } as unknown as Context;
        return options.authenticate(authContext);
      };

      return {
        onOpen(_event, ws) {
          const state: {
            listener: ConsoleEventListener | null;
            heartbeatInterval: ReturnType<typeof setInterval> | null;
            authTimeout: ReturnType<typeof setTimeout> | null;
            isAuthenticated: boolean;
            startAuthenticatedSession: (() => void) | null;
            messageRateWindowStart: number;
            messageRateWindowCount: number;
          } = {
            listener: null,
            heartbeatInterval: null,
            authTimeout: null,
            isAuthenticated: false,
            startAuthenticatedSession: null,
            messageRateWindowStart: Date.now(),
            messageRateWindowCount: 0,
          };
          wsState.set(ws, state);

          const startAuthenticatedSession = () => {
            if (state.isAuthenticated) return;
            state.isAuthenticated = true;
            if (state.authTimeout) {
              clearTimeout(state.authTimeout);
              state.authTimeout = null;
            }

            const listener: ConsoleEventListener = (event) => {
              if (partitionId) {
                const eventPartitionId = event.data.partitionId;
                if (
                  typeof eventPartitionId !== 'string' ||
                  eventPartitionId !== partitionId
                ) {
                  return;
                }
              }
              try {
                ws.send(JSON.stringify(event));
              } catch {
                // Connection closed
              }
            };

            emitter.addListener(listener);
            state.listener = listener;

            ws.send(
              JSON.stringify({
                type: 'connected',
                timestamp: new Date().toISOString(),
              })
            );

            const replayEvents = emitter.replay({
              since: replaySince,
              limit: replayLimit,
              partitionId,
            });
            for (const replayEvent of replayEvents) {
              try {
                ws.send(JSON.stringify(replayEvent));
              } catch {
                // Connection closed
                break;
              }
            }

            const heartbeatInterval = setInterval(() => {
              try {
                ws.send(
                  JSON.stringify({
                    type: 'heartbeat',
                    timestamp: new Date().toISOString(),
                  })
                );
              } catch {
                clearInterval(heartbeatInterval);
              }
            }, heartbeatIntervalMs);
            state.heartbeatInterval = heartbeatInterval;
          };
          state.startAuthenticatedSession = startAuthenticatedSession;

          if (initialAuth) {
            startAuthenticatedSession();
            return;
          }

          state.authTimeout = setTimeout(() => {
            const current = wsState.get(ws);
            if (!current || current.isAuthenticated) {
              return;
            }
            closeUnauthenticatedSocket(ws);
            cleanup(ws);
          }, 5_000);
        },
        async onMessage(event, ws) {
          const state = wsState.get(ws);
          if (!state) {
            return;
          }

          const messageBytes = measureWebSocketMessageBytes(event.data);
          if (messageBytes > maxMessageBytes) {
            ws.close(1009, 'message too large');
            cleanup(ws);
            return;
          }

          if (maxMessagesPerWindow > 0 && messageRateWindowMs > 0) {
            const nowMs = Date.now();
            if (nowMs - state.messageRateWindowStart >= messageRateWindowMs) {
              state.messageRateWindowStart = nowMs;
              state.messageRateWindowCount = 0;
            }
            state.messageRateWindowCount += 1;
            if (state.messageRateWindowCount > maxMessagesPerWindow) {
              ws.close(1008, 'message rate exceeded');
              cleanup(ws);
              return;
            }
          }

          if (state.isAuthenticated) {
            return;
          }

          if (typeof event.data !== 'string') {
            closeUnauthenticatedSocket(ws);
            cleanup(ws);
            return;
          }

          const token = parseWebSocketAuthToken(event.data);

          if (!token) {
            closeUnauthenticatedSocket(ws);
            cleanup(ws);
            return;
          }

          const auth = await authenticateWithBearer(token);
          const currentState = wsState.get(ws);
          if (!currentState || currentState.isAuthenticated) {
            return;
          }
          if (!auth) {
            closeUnauthenticatedSocket(ws);
            cleanup(ws);
            return;
          }
          currentState.startAuthenticatedSession?.();
        },
        onClose(_event, ws) {
          cleanup(ws);
        },
        onError(_event, ws) {
          cleanup(ws);
        },
      };
    });

    routes.get('/events/live', async (c, next) => {
      if (!isWebSocketOriginAllowed(c, options.websocket?.allowedOrigins)) {
        return c.json(
          createSyncularErrorResponse('console.forbidden_origin'),
          403
        );
      }
      return liveEventsWebSocketRoute(c, next);
    });
  }

  // -------------------------------------------------------------------------
  // GET /events/:id - Single event detail
  // -------------------------------------------------------------------------

  routes.get(
    '/events/:id',
    describeConsoleRoute({
      summary: 'Get event details',
      responses: {
        200: {
          description: 'Event details',
          content: {
            'application/json': {
              schema: resolver(ConsoleRequestEventSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', eventIdParamSchema),
    zValidator('query', eventDetailQuerySchema),
    async (c) => {
      const { id: eventId } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');

      let eventQuery = db
        .selectFrom('sync_request_events')
        .select(requestEventSelectColumns)
        .where('event_id', '=', eventId);

      if (partitionId) {
        eventQuery = eventQuery.where('partition_id', '=', partitionId);
      }

      const row = await eventQuery.executeTakeFirst();

      if (!row) {
        return consoleNotFound(c);
      }

      return c.json(mapRequestEvent(row), 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /events/:id/payload - payload snapshot detail (if retained)
  // -------------------------------------------------------------------------

  routes.get(
    '/events/:id/payload',
    describeConsoleRoute({
      summary: 'Get event payload snapshot',
      responses: {
        200: {
          description: 'Payload snapshot details',
          content: {
            'application/json': {
              schema: resolver(ConsoleRequestPayloadSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', eventIdParamSchema),
    zValidator('query', eventDetailQuerySchema),
    async (c) => {
      const { id: eventId } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');

      let eventQuery = db
        .selectFrom('sync_request_events')
        .select(['payload_ref', 'partition_id'])
        .where('event_id', '=', eventId);

      if (partitionId) {
        eventQuery = eventQuery.where('partition_id', '=', partitionId);
      }

      const eventRow = await eventQuery.executeTakeFirst();

      if (!eventRow) {
        return consoleNotFound(c);
      }

      const payloadRef = eventRow.payload_ref;
      if (!payloadRef) {
        return consoleNotFound(c, 'No payload snapshot recorded');
      }

      const payloadRow = await db
        .selectFrom('sync_request_payloads')
        .select([
          'payload_ref',
          'partition_id',
          'request_payload',
          'response_payload',
          'created_at',
        ])
        .where('payload_ref', '=', payloadRef)
        .where('partition_id', '=', eventRow.partition_id)
        .executeTakeFirst();

      if (!payloadRow) {
        return consoleNotFound(c, 'Payload snapshot not available');
      }

      const payload: ConsoleRequestPayload = {
        payloadRef: payloadRow.payload_ref,
        partitionId: payloadRow.partition_id,
        requestPayload: parseJsonValue(payloadRow.request_payload),
        responsePayload: parseJsonValue(payloadRow.response_payload),
        createdAt: payloadRow.created_at,
      };

      return c.json(payload, 200);
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /events - Clear all events
  // -------------------------------------------------------------------------

  routes.delete(
    '/events',
    describeConsoleRoute({
      summary: 'Clear all events',
      responses: {
        200: {
          description: 'Clear result',
          content: {
            'application/json': {
              schema: resolver(ConsoleClearEventsResultSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      const res = await db.deleteFrom('sync_request_events').executeTakeFirst();

      const deletedCount = Number(res?.numDeletedRows ?? 0);
      const payloadDeletedCount = await deleteUnreferencedPayloadSnapshots();

      logSyncEvent({
        event: 'console.clear_events',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        deletedCount,
        payloadDeletedCount,
      });

      const result: ConsoleClearEventsResult = { deletedCount };
      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /events/prune - Prune old events
  // -------------------------------------------------------------------------

  routes.post(
    '/events/prune',
    describeConsoleRoute({
      summary: 'Prune old events',
      responses: {
        200: {
          description: 'Prune result',
          content: {
            'application/json': {
              schema: resolver(ConsolePruneEventsResultSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      const pruneResult = await runEventsPrune();
      const deletedCount = pruneResult.totalDeleted;

      logSyncEvent({
        event: 'console.prune_events',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        deletedCount,
        requestEventsDeleted: pruneResult.requestEventsDeleted,
        operationEventsDeleted: pruneResult.operationEventsDeleted,
        realtimeEventsDeleted: pruneResult.realtimeEventsDeleted,
        payloadDeletedCount: pruneResult.payloadSnapshotsDeleted,
      });

      const result: ConsolePruneEventsResult = {
        deletedCount,
        requestEventsDeleted: pruneResult.requestEventsDeleted,
        operationEventsDeleted: pruneResult.operationEventsDeleted,
        realtimeEventsDeleted: pruneResult.realtimeEventsDeleted,
        payloadDeletedCount: pruneResult.payloadSnapshotsDeleted,
      };
      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /api-keys - List all API keys
  // -------------------------------------------------------------------------

  routes.get(
    '/api-keys',
    describeConsoleRoute({
      summary: 'List API keys',
      responses: {
        200: {
          description: 'Paginated API key list',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleApiKeySchema)
              ),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', apiKeysQuerySchema),
    async (c) => {
      const {
        limit,
        offset,
        type: keyType,
        status,
        expiresWithinDays,
      } = c.req.valid('query');

      let query = db
        .selectFrom('sync_api_keys')
        .select([
          'key_id',
          'key_prefix',
          'name',
          'key_type',
          'scope_keys',
          'actor_id',
          'created_at',
          'expires_at',
          'last_used_at',
          'revoked_at',
        ]);

      let countQuery = db
        .selectFrom('sync_api_keys')
        .select(({ fn }) => fn.countAll().as('total'));

      if (keyType) {
        query = query.where('key_type', '=', keyType);
        countQuery = countQuery.where('key_type', '=', keyType);
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const expiringThresholdIso = new Date(
        now.getTime() + (expiresWithinDays ?? 14) * 24 * 60 * 60 * 1000
      ).toISOString();

      if (status === 'active') {
        query = query
          .where('revoked_at', 'is', null)
          .where((eb) =>
            eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', nowIso)])
          );
        countQuery = countQuery
          .where('revoked_at', 'is', null)
          .where((eb) =>
            eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', nowIso)])
          );
      } else if (status === 'revoked') {
        query = query.where('revoked_at', 'is not', null);
        countQuery = countQuery.where('revoked_at', 'is not', null);
      } else if (status === 'expiring') {
        query = query
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', nowIso)
          .where('expires_at', '<=', expiringThresholdIso);
        countQuery = countQuery
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', nowIso)
          .where('expires_at', '<=', expiringThresholdIso);
      }

      const [rows, countRow] = await Promise.all([
        query
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
      ]);

      const items: ConsoleApiKey[] = rows.map((row) => ({
        keyId: row.key_id ?? '',
        keyPrefix: row.key_prefix ?? '',
        name: row.name ?? '',
        keyType: row.key_type as ApiKeyType,
        scopeKeys: options.dialect.dbToArray(row.scope_keys),
        actorId: row.actor_id ?? null,
        createdAt: row.created_at ?? '',
        expiresAt: row.expires_at ?? null,
        lastUsedAt: row.last_used_at ?? null,
        revokedAt: row.revoked_at ?? null,
      }));

      const totalCount = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleApiKey> = {
        items,
        total: totalCount,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(totalCount));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /api-keys - Create new API key
  // -------------------------------------------------------------------------

  routes.post(
    '/api-keys',
    describeConsoleRoute({
      summary: 'Create API key',
      responses: {
        201: {
          description: 'Created API key',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyCreateResponseSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('json', ConsoleApiKeyCreateRequestSchema),
    async (c) => {
      const body = c.req.valid('json');

      // Generate key components
      const keyId = generateKeyId();
      const secretKey = generateSecretKey(body.keyType);
      const keyHash = await hashApiKey(secretKey);
      const keyPrefix = secretKey.slice(0, 12);

      // Calculate expiry
      let expiresAt: string | null = null;
      if (body.expiresInDays && body.expiresInDays > 0) {
        expiresAt = new Date(
          Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000
        ).toISOString();
      }

      const scopeKeys = body.scopeKeys ?? [];
      const now = new Date().toISOString();

      // Insert into database
      await db
        .insertInto('sync_api_keys')
        .values({
          key_id: keyId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          name: body.name,
          key_type: body.keyType,
          scope_keys: options.dialect.arrayToDb(scopeKeys),
          actor_id: body.actorId ?? null,
          created_at: now,
          expires_at: expiresAt,
          last_used_at: null,
          revoked_at: null,
        })
        .execute();

      logSyncEvent({
        event: 'console.create_api_key',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        keyId,
        keyType: body.keyType,
      });

      const key: ConsoleApiKey = {
        keyId,
        keyPrefix,
        name: body.name,
        keyType: body.keyType,
        scopeKeys,
        actorId: body.actorId ?? null,
        createdAt: now,
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      };

      const response: ConsoleApiKeyCreateResponse = {
        key,
        secretKey,
      };

      return c.json(response, 201);
    }
  );

  // -------------------------------------------------------------------------
  // GET /api-keys/:id - Get single API key
  // -------------------------------------------------------------------------

  routes.get(
    '/api-keys/:id',
    describeConsoleRoute({
      summary: 'Get API key',
      responses: {
        200: {
          description: 'API key details',
          content: {
            'application/json': { schema: resolver(ConsoleApiKeySchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', apiKeyIdParamSchema),
    async (c) => {
      const { id: keyId } = c.req.valid('param');

      const row = await db
        .selectFrom('sync_api_keys')
        .select([
          'key_id',
          'key_prefix',
          'name',
          'key_type',
          'scope_keys',
          'actor_id',
          'created_at',
          'expires_at',
          'last_used_at',
          'revoked_at',
        ])
        .where('key_id', '=', keyId)
        .executeTakeFirst();

      if (!row) {
        return consoleNotFound(c);
      }

      const key: ConsoleApiKey = {
        keyId: row.key_id ?? '',
        keyPrefix: row.key_prefix ?? '',
        name: row.name ?? '',
        keyType: row.key_type as ApiKeyType,
        scopeKeys: options.dialect.dbToArray(row.scope_keys),
        actorId: row.actor_id ?? null,
        createdAt: row.created_at ?? '',
        expiresAt: row.expires_at ?? null,
        lastUsedAt: row.last_used_at ?? null,
        revokedAt: row.revoked_at ?? null,
      };

      return c.json(key, 200);
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /api-keys/:id - Revoke API key (soft delete)
  // -------------------------------------------------------------------------

  routes.delete(
    '/api-keys/:id',
    describeConsoleRoute({
      summary: 'Revoke API key',
      responses: {
        200: {
          description: 'Revoke result',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyRevokeResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', apiKeyIdParamSchema),
    async (c) => {
      const { id: keyId } = c.req.valid('param');
      const now = new Date().toISOString();

      const res = await db
        .updateTable('sync_api_keys')
        .set({ revoked_at: now })
        .where('key_id', '=', keyId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();

      const revoked = Number(res?.numUpdatedRows ?? 0) > 0;

      logSyncEvent({
        event: 'console.revoke_api_key',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        keyId,
        revoked,
      });

      return c.json({ revoked }, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /api-keys/bulk-revoke - Revoke multiple API keys
  // -------------------------------------------------------------------------

  routes.post(
    '/api-keys/bulk-revoke',
    describeConsoleRoute({
      summary: 'Bulk revoke API keys',
      responses: {
        200: {
          description: 'Bulk revoke result',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyBulkRevokeResponseSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('json', ConsoleApiKeyBulkRevokeRequestSchema),
    async (c) => {
      const body = c.req.valid('json');
      const keyIds = [...new Set(body.keyIds.map((keyId) => keyId.trim()))]
        .filter((keyId) => keyId.length > 0)
        .slice(0, 200);

      if (keyIds.length === 0) {
        return consoleRouteError(
          c,
          400,
          'console.invalid_request',
          'No API key IDs provided'
        );
      }

      const now = new Date().toISOString();
      const existingRows = await db
        .selectFrom('sync_api_keys')
        .select(['key_id', 'revoked_at'])
        .where('key_id', 'in', keyIds)
        .execute();

      const existingById = new Map(
        existingRows.map((row) => [row.key_id, row.revoked_at])
      );

      const notFoundKeyIds: string[] = [];
      const alreadyRevokedKeyIds: string[] = [];
      const revokeCandidateKeyIds: string[] = [];

      for (const keyId of keyIds) {
        const revokedAt = existingById.get(keyId);
        if (revokedAt === undefined) {
          notFoundKeyIds.push(keyId);
        } else if (revokedAt !== null) {
          alreadyRevokedKeyIds.push(keyId);
        } else {
          revokeCandidateKeyIds.push(keyId);
        }
      }

      let revokedCount = 0;
      if (revokeCandidateKeyIds.length > 0) {
        const updateResult = await db
          .updateTable('sync_api_keys')
          .set({ revoked_at: now })
          .where('key_id', 'in', revokeCandidateKeyIds)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();

        revokedCount = Number(updateResult?.numUpdatedRows ?? 0);
      }

      const response: ConsoleApiKeyBulkRevokeResponse = {
        requestedCount: keyIds.length,
        revokedCount,
        alreadyRevokedCount: alreadyRevokedKeyIds.length,
        notFoundCount: notFoundKeyIds.length,
        revokedKeyIds: revokeCandidateKeyIds,
        alreadyRevokedKeyIds,
        notFoundKeyIds,
      };

      logSyncEvent({
        event: 'console.bulk_revoke_api_keys',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        requestedCount: response.requestedCount,
        revokedCount: response.revokedCount,
        alreadyRevokedCount: response.alreadyRevokedCount,
        notFoundCount: response.notFoundCount,
      });

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /api-keys/:id/rotate/stage - Stage rotate API key (keep old active)
  // -------------------------------------------------------------------------

  routes.post(
    '/api-keys/:id/rotate/stage',
    describeConsoleRoute({
      summary: 'Stage rotate API key',
      responses: {
        200: {
          description: 'Staged API key replacement',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyCreateResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', apiKeyIdParamSchema),
    async (c) => {
      const { id: keyId } = c.req.valid('param');
      const now = new Date().toISOString();

      const existingRow = await db
        .selectFrom('sync_api_keys')
        .select([
          'name',
          'key_type',
          'scope_keys',
          'actor_id',
          'expires_at',
          'revoked_at',
        ])
        .where('key_id', '=', keyId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();

      if (!existingRow) {
        return consoleNotFound(c);
      }

      const newKeyId = generateKeyId();
      const keyType = existingRow.key_type as ApiKeyType;
      const secretKey = generateSecretKey(keyType);
      const keyHash = await hashApiKey(secretKey);
      const keyPrefix = secretKey.slice(0, 12);
      const scopeKeys = options.dialect.dbToArray(existingRow.scope_keys);

      await db
        .insertInto('sync_api_keys')
        .values({
          key_id: newKeyId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          name: existingRow.name,
          key_type: keyType,
          scope_keys: options.dialect.arrayToDb(scopeKeys),
          actor_id: existingRow.actor_id ?? null,
          created_at: now,
          expires_at: existingRow.expires_at,
          last_used_at: null,
          revoked_at: null,
        })
        .execute();

      logSyncEvent({
        event: 'console.stage_rotate_api_key',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        oldKeyId: keyId,
        newKeyId,
      });

      const key: ConsoleApiKey = {
        keyId: newKeyId,
        keyPrefix,
        name: existingRow.name,
        keyType,
        scopeKeys,
        actorId: existingRow.actor_id ?? null,
        createdAt: now,
        expiresAt: existingRow.expires_at ?? null,
        lastUsedAt: null,
        revokedAt: null,
      };

      const response: ConsoleApiKeyCreateResponse = {
        key,
        secretKey,
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /api-keys/:id/rotate - Rotate API key
  // -------------------------------------------------------------------------

  routes.post(
    '/api-keys/:id/rotate',
    describeConsoleRoute({
      summary: 'Rotate API key',
      responses: {
        200: {
          description: 'Rotated API key',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyCreateResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', apiKeyIdParamSchema),
    async (c) => {
      const { id: keyId } = c.req.valid('param');
      const now = new Date().toISOString();

      // Get existing key
      const existingRow = await db
        .selectFrom('sync_api_keys')
        .select([
          'key_id',
          'name',
          'key_type',
          'scope_keys',
          'actor_id',
          'expires_at',
        ])
        .where('key_id', '=', keyId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();

      if (!existingRow) {
        return consoleNotFound(c);
      }

      // Revoke old key
      await db
        .updateTable('sync_api_keys')
        .set({ revoked_at: now })
        .where('key_id', '=', keyId)
        .execute();

      // Create new key with same properties
      const newKeyId = generateKeyId();
      const keyType = existingRow.key_type as ApiKeyType;
      const secretKey = generateSecretKey(keyType);
      const keyHash = await hashApiKey(secretKey);
      const keyPrefix = secretKey.slice(0, 12);

      const scopeKeys = options.dialect.dbToArray(existingRow.scope_keys);

      await db
        .insertInto('sync_api_keys')
        .values({
          key_id: newKeyId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          name: existingRow.name,
          key_type: keyType,
          scope_keys: options.dialect.arrayToDb(scopeKeys),
          actor_id: existingRow.actor_id ?? null,
          created_at: now,
          expires_at: existingRow.expires_at,
          last_used_at: null,
          revoked_at: null,
        })
        .execute();

      logSyncEvent({
        event: 'console.rotate_api_key',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        oldKeyId: keyId,
        newKeyId,
      });

      const key: ConsoleApiKey = {
        keyId: newKeyId,
        keyPrefix,
        name: existingRow.name,
        keyType,
        scopeKeys,
        actorId: existingRow.actor_id ?? null,
        createdAt: now,
        expiresAt: existingRow.expires_at ?? null,
        lastUsedAt: null,
        revokedAt: null,
      };

      const response: ConsoleApiKeyCreateResponse = {
        key,
        secretKey,
      };

      return c.json(response, 200);
    }
  );

  // -----------------------------------------------------------------------
  // Storage endpoints
  // -----------------------------------------------------------------------
  const bucket = options.blobBucket;

  routes.get(
    '/storage',
    describeConsoleRoute({
      summary: 'List storage items',
      responses: {
        200: {
          description: 'Paginated list of storage items',
          content: {
            'application/json': {
              schema: resolver(ConsoleBlobListResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', ConsoleBlobListQuerySchema),
    async (c) => {
      if (!bucket) {
        return blobStorageNotConfigured(c);
      }

      const { prefix, cursor, limit } = c.req.valid('query');
      const listed = await bucket.list({
        prefix: prefix || undefined,
        cursor: cursor || undefined,
        limit,
      });

      return c.json(
        {
          items: listed.objects.map((obj) => ({
            key: obj.key,
            size: obj.size,
            uploaded: obj.uploaded.toISOString(),
            httpMetadata: obj.httpMetadata?.contentType
              ? { contentType: obj.httpMetadata.contentType }
              : undefined,
          })),
          truncated: listed.truncated,
          cursor: listed.cursor ?? null,
        },
        200
      );
    }
  );

  routes.get(
    '/storage/:key{.+}/download',
    describeConsoleRoute({
      summary: 'Download a storage item',
      responses: {
        200: { description: 'Storage item contents' },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Blob not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      if (!bucket) {
        return blobStorageNotConfigured(c);
      }

      const key = decodeURIComponent(c.req.param('key'));
      const object = await bucket.get(key);
      if (!object) {
        return consoleRouteError(c, 404, 'blob.not_found');
      }

      const headers = new Headers();
      headers.set('Content-Length', String(object.size));
      headers.set(
        'Content-Type',
        object.httpMetadata?.contentType ?? 'application/octet-stream'
      );
      const filename = key.split('/').pop() || key;
      headers.set(
        'Content-Disposition',
        `attachment; filename="${filename.replace(/"/g, '\\"')}"`
      );

      return new Response(object.body as ReadableStream, {
        status: 200,
        headers,
      });
    }
  );

  routes.delete(
    '/storage/:key{.+}',
    describeConsoleRoute({
      summary: 'Delete a storage item',
      responses: {
        200: {
          description: 'Storage item deleted',
          content: {
            'application/json': {
              schema: resolver(ConsoleBlobDeleteResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      if (!bucket) {
        return blobStorageNotConfigured(c);
      }

      const key = decodeURIComponent(c.req.param('key'));
      await bucket.delete(key);
      return c.json({ deleted: true }, 200);
    }
  );

  return routes;
}

function measureWebSocketMessageBytes(data: unknown): number {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data).byteLength;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.size;
  }
  return new TextEncoder().encode(String(data)).byteLength;
}

// ===========================================================================
// API Key Utilities
// ===========================================================================

function generateKeyId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function generateSecretKey(keyType: ApiKeyType): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );
  return `sk_${keyType}_${random}`;
}

async function hashApiKey(secretKey: string): Promise<string> {
  return sha256Hex(secretKey);
}

/**
 * Creates a simple token-based authenticator for local development.
 * The token can be set via SYNC_CONSOLE_TOKEN env var or passed directly.
 */
export function createTokenAuthenticator(
  token?: string
): (c: Context) => Promise<ConsoleAuthResult | null> {
  const expectedToken = (token ?? process.env.SYNC_CONSOLE_TOKEN)?.trim() ?? '';

  return async (c: Context) => {
    if (!expectedToken) return null;

    const bearerToken = parseBearerToken(c.req.header('Authorization'));
    if (bearerToken === expectedToken) {
      return { consoleUserId: 'token' };
    }

    return null;
  };
}
