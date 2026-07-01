/**
 * @syncular/server/hono - Console route helpers shared across route modules.
 *
 * Extracted from console/routes.ts without behavior changes.
 */

import {
  createSyncularErrorResponse,
  type ScopeValues,
  type StoredScopes,
  type SyncularErrorCode,
  sha256Hex,
} from '@syncular/core';
import { coerceNumber, parseJsonValue } from '@syncular/server';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  type ApiKeyType,
  ApiKeyTypeSchema,
  type ConsoleBrowserPreviewFailureArtifact,
  ConsoleBrowserPreviewFailureArtifactSchema,
  type ConsoleBrowserPreviewFailureIngest,
  type ConsoleClientDiagnosticCodeSummary,
  type ConsoleClientDiagnosticFreshnessState,
  type ConsoleClientDiagnosticHealthSeverity,
  type ConsoleClientDiagnosticIngest,
  type ConsoleClientDiagnosticRecord,
  type ConsoleCloudflareRuntimeFailureArtifact,
  ConsoleCloudflareRuntimeFailureArtifactSchema,
  type ConsoleCloudflareRuntimeFailureIngest,
  ConsoleHandlerSchema,
  ConsolePaginationQuerySchema,
  ConsolePartitionedPaginationQuerySchema,
  ConsolePartitionQuerySchema,
  type ConsoleRequestEvent,
  type ConsoleRequestEventResponseSummary,
  type ConsoleRowInvestigationRealtimeEvidence,
  type ConsoleRowInvestigationRequestEvidence,
  type ConsoleRowInvestigationScopeEligibility,
  type ConsoleRowInvestigationSnapshotEvidence,
  type ConsoleRowInvestigationSubscriptionEvidence,
  type LatencyPercentiles,
  type TimeseriesBucket,
} from '../schemas';

export function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function includesSearchTerm(
  value: string | null | undefined,
  searchTerm: string | null
): boolean {
  if (!searchTerm) return true;
  if (!value) return false;
  return value.toLowerCase().includes(searchTerm);
}

export function parseJsonStringArray(value: unknown): string[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

export { parseScopesSummary } from '../../routes/shared';

export function parseResponseSummary(
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

export function assessScopeEligibility(args: {
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

export function summarizeSubscriptionEvidence(
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

export function summarizeRequestEvidence(
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

export function summarizeSnapshotEvidence(
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

export function summarizeRealtimeEvidence(
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

export function normalizeRequestEventType(
  value: unknown
): 'sync' | 'push' | 'pull' {
  if (value === 'sync' || value === 'push' || value === 'pull') {
    return value;
  }
  return 'pull';
}

export function getClientActivityState(args: {
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

export function findSensitiveDiagnosticField(
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

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function readStringProperty(
  value: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const entry = value?.[key];
  return typeof entry === 'string' && entry.length > 0 ? entry : null;
}

type TimeseriesInterval = 'minute' | 'hour' | 'day';
type TimeseriesRange = '1h' | '6h' | '24h' | '7d' | '30d';

export function rangeToMs(range: TimeseriesRange): number {
  if (range === '1h') return 60 * 60 * 1000;
  if (range === '6h') return 6 * 60 * 60 * 1000;
  if (range === '24h') return 24 * 60 * 60 * 1000;
  if (range === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

export function intervalToMs(interval: TimeseriesInterval): number {
  if (interval === 'minute') return 60 * 1000;
  if (interval === 'hour') return 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

export function intervalToSqliteBucketFormat(
  interval: TimeseriesInterval
): string {
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

export function createEmptyTimeseriesAccumulator(): TimeseriesBucketAccumulator {
  return {
    pushCount: 0,
    pullCount: 0,
    errorCount: 0,
    totalLatency: 0,
    eventCount: 0,
  };
}

export function createTimeseriesBucketMap(args: {
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

export function normalizeBucketTimestamp(value: unknown): string | null {
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

export function finalizeTimeseriesBuckets(
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

export function calculatePercentiles(latencies: number[]): LatencyPercentiles {
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

export function consoleRouteError(
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

export function consoleNotFound(c: Context, message?: string): Response {
  return consoleRouteError(c, 404, 'console.not_found', message);
}

export function blobStorageNotConfigured(c: Context): Response {
  return consoleRouteError(c, 501, 'blob.storage_not_configured');
}

// ============================================================================
// Route Schemas
// ============================================================================

export const commitSeqParamSchema = z.object({ seq: z.coerce.number().int() });
export const rowHistoryParamSchema = z.object({
  table: z.string().min(1),
  rowId: z.string().min(1),
});
export const clientIdParamSchema = z.object({ id: z.string().min(1) });
export const eventIdParamSchema = z.object({ id: z.coerce.number().int() });
export const apiKeyIdParamSchema = z.object({ id: z.string().min(1) });
export const clientDiagnosticsQuerySchema =
  ConsolePartitionedPaginationQuerySchema.extend({
    clientId: z.string().min(1).optional(),
  });
export const clientDiagnosticDetailQuerySchema = ConsolePartitionQuerySchema;
export const clientDiagnosticHistoryQuerySchema =
  ConsolePartitionedPaginationQuerySchema;

export const eventsQuerySchema = ConsolePartitionedPaginationQuerySchema.extend(
  {
    eventType: z.enum(['sync', 'push', 'pull']).optional(),
    actorId: z.string().optional(),
    clientId: z.string().optional(),
    requestId: z.string().optional(),
    traceId: z.string().optional(),
    syncAttemptId: z.string().optional(),
    outcome: z.string().optional(),
  }
);

export const commitDetailQuerySchema = ConsolePartitionQuerySchema;
const rowHistoryQueryBaseSchema = ConsolePartitionQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeCommitSeq: z.coerce.number().int().min(1).optional(),
  afterCommitSeq: z.coerce.number().int().min(1).optional(),
});
export const rowHistoryQuerySchema = rowHistoryQueryBaseSchema.refine(
  (query) =>
    query.beforeCommitSeq === undefined ||
    query.afterCommitSeq === undefined ||
    query.afterCommitSeq < query.beforeCommitSeq,
  {
    message: 'afterCommitSeq must be lower than beforeCommitSeq',
    path: ['afterCommitSeq'],
  }
);
export const rowInvestigationQuerySchema = rowHistoryQueryBaseSchema
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
export const debugExportQuerySchema = ConsolePartitionQuerySchema.extend({
  limitCommits: z.coerce.number().int().min(1).max(200).default(50),
  limitEvents: z.coerce.number().int().min(1).max(500).default(100),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export const eventDetailQuerySchema = ConsolePartitionQuerySchema;
export const evictClientQuerySchema = ConsolePartitionQuerySchema;
const apiKeyStatusSchema = z.enum(['active', 'revoked', 'expiring']);

export const apiKeysQuerySchema = ConsolePaginationQuerySchema.extend({
  type: ApiKeyTypeSchema.optional(),
  status: apiKeyStatusSchema.optional(),
  expiresWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});

export const handlersResponseSchema = z.object({
  items: z.array(ConsoleHandlerSchema),
});

export const DEFAULT_REQUEST_EVENTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_REQUEST_EVENTS_MAX_ROWS = 10_000;
export const DEFAULT_OPERATION_EVENTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_OPERATION_EVENTS_MAX_ROWS = 5_000;
export const DEFAULT_TIMELINE_SCAN_MAX_ROWS = 10_000;
export const DEFAULT_AUTO_EVENTS_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_CLIENT_DIAGNOSTICS_MAX_RECORDS = 500;
export const DEFAULT_CLIENT_DIAGNOSTICS_MAX_JSON_BYTES = 64 * 1024;
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

export function readNonNegativeInteger(
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

export function clientDiagnosticStoreKey(
  partitionId: string,
  clientId: string
) {
  return `${partitionId}\u0000${clientId}`;
}

function compactDiagnosticDetails(
  value: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function truncateDiagnosticText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function browserPreviewArtifactGeneratedAtMs(
  artifact: ConsoleBrowserPreviewFailureArtifact
): number {
  const generatedAt = Date.parse(artifact.generatedAt);
  return Number.isFinite(generatedAt) ? generatedAt : Date.now();
}

function cloudflareRuntimeArtifactGeneratedAtMs(
  artifact: ConsoleCloudflareRuntimeFailureArtifact
): number {
  const generatedAt = Date.parse(artifact.generatedAt);
  return Number.isFinite(generatedAt) ? generatedAt : Date.now();
}

export function buildBrowserPreviewFailureClientDiagnosticIngest(
  payload: ConsoleBrowserPreviewFailureIngest
): ConsoleClientDiagnosticIngest {
  const artifact: ConsoleBrowserPreviewFailureArtifact =
    payload.artifact ??
    ConsoleBrowserPreviewFailureArtifactSchema.parse(payload);
  const probe = artifact.probe;
  const generatedAt = browserPreviewArtifactGeneratedAtMs(artifact);
  const reason = truncateDiagnosticText(artifact.reason, 500);
  const starterTimeline = probe?.starterTimeline ?? null;
  const browserHealth = probe?.browserHealth ?? null;
  const deploymentPreflight = probe?.deploymentPreflight ?? null;
  const browserSupportPolicy = probe?.browserSupportPolicy ?? null;
  const commandTimelineProof = probe?.commandTimelineProof ?? null;
  const supportBundle = probe?.supportBundle ?? null;
  const lifecycleResume = probe?.lifecycleResume ?? null;
  const lifecyclePause = probe?.lifecyclePause ?? null;

  const details = compactDiagnosticDetails({
    artifactSchema: 'create-syncular-app.browser-preview-failure.v1',
    artifactGeneratedAt: artifact.generatedAt,
    reason,
    probeReady: probe?.ready ?? null,
    probeErrorCount: probe?.errors.length ?? 0,
    probeTextExcerptLength: probe?.textExcerpt.length ?? 0,
    markers: probe?.markers ?? null,
    metrics: artifact.metrics,
    browserHealth,
    deploymentPreflight,
    browserSupportPolicy,
    commandTimelineProof,
    supportBundle,
    lifecycleResume,
    lifecyclePause,
    starterTimeline,
  });

  return {
    clientId: payload.clientId,
    actorId: payload.actorId,
    partitionId: payload.partitionId,
    lifecycle: {
      phase: probe?.ready ? 'ready' : 'browser-preview-failure',
      realtime: starterTimeline?.realtimeStatus ?? undefined,
      online: true,
      requiresAction: true,
      pendingRequests: 0,
      lastError: {
        code: 'browser.preview_failure',
        reason,
      },
    },
    snapshot: {
      generatedAt,
      runtime: {
        packageName: '@syncular/client',
        storage: deploymentPreflight?.persistence ?? undefined,
      },
      connection: {
        realtime: starterTimeline?.realtimeStatus ?? undefined,
        pendingRequests: 0,
      },
      subscriptions: [],
      recentDiagnostics: [
        {
          at: generatedAt,
          level: 'error',
          source: 'browser-preview',
          code: 'browser.preview_failure',
          message: 'Browser preview failure artifact ingested.',
          details,
        },
      ],
      recentSyncTimings: [
        compactDiagnosticDetails({
          source: 'browser-preview-smoke',
          artifactCreatedAfterMs: artifact.metrics.artifactCreatedAfterMs,
          assetCheckMs: artifact.metrics.assetCheckMs,
          previewReadyMs: artifact.metrics.previewReadyMs,
          databaseOpenMs: starterTimeline?.databaseOpenMs ?? null,
          schemaReadinessMs: starterTimeline?.schemaReadinessMs ?? null,
          bootstrapReadyMs: starterTimeline?.bootstrapReadyMs ?? null,
          realtimeConnectedMs: starterTimeline?.realtimeConnectedMs ?? null,
          localVisibilityMs: starterTimeline?.localVisibilityMs ?? null,
          supportBundleExportMs: starterTimeline?.supportBundleExportMs ?? null,
          lifecycleResumeCount: lifecycleResume?.count ?? null,
          lifecycleResumeStatus: lifecycleResume?.status ?? null,
          lifecycleResumeReason: lifecycleResume?.reason ?? null,
          lifecycleResumeLockName: lifecycleResume?.lockName ?? null,
          lifecycleResumeLockRequired: lifecycleResume?.lockRequired ?? null,
          lifecycleResumeLockState: lifecycleResume?.lockState ?? null,
          lifecycleResumeLockTimeoutMs: lifecycleResume?.lockTimeoutMs ?? null,
          lifecyclePauseCount: lifecyclePause?.count ?? null,
          lifecyclePauseReason: lifecyclePause?.reason ?? null,
          lifecyclePauseVisibilityState:
            lifecyclePause?.visibilityState ?? null,
          lifecycleShutdownSignalCount:
            lifecyclePause?.shutdownSignalCount ?? null,
        }),
      ],
      bootstrap: compactDiagnosticDetails({
        status: starterTimeline?.bootstrapStatus ?? null,
        readyMs: starterTimeline?.bootstrapReadyMs ?? null,
        supportBundleStatus: supportBundle?.status ?? null,
        supportBundleIssueCount: supportBundle?.issueCount ?? null,
      }),
      transportStats: compactDiagnosticDetails({
        assetCount: artifact.metrics.assetCount,
        jsAssetCount: artifact.metrics.jsAssetCount,
        cssAssetCount: artifact.metrics.cssAssetCount,
        totalAssetBytes: artifact.metrics.totalAssetBytes,
        jsAssetBytes: artifact.metrics.jsAssetBytes,
        cssAssetBytes: artifact.metrics.cssAssetBytes,
        otherAssetBytes: artifact.metrics.otherAssetBytes,
        browserSupportPolicyMarkerInAssets:
          artifact.metrics.browserSupportPolicyMarkerInAssets ?? null,
        browserHealthMarkerInAssets:
          artifact.metrics.browserHealthMarkerInAssets ?? null,
        browserHealthStatus: browserHealth?.status ?? null,
        browserHealthLifecycleStage: browserHealth?.lifecycleStage ?? null,
        browserHealthRecoveryOwner: browserHealth?.recoveryOwner ?? null,
        browserHealthBlockedOperationCount:
          browserHealth?.blockedOperationCount ?? null,
        browserHealthGeneratedMutation:
          browserHealth?.generatedMutation ?? null,
        browserHealthLocalVisibility: browserHealth?.localVisibility ?? null,
        browserHealthSyncNow: browserHealth?.syncNow ?? null,
        browserSupportPolicy: browserSupportPolicy?.policy ?? null,
        browserSupportPolicyStatus: browserSupportPolicy?.status ?? null,
        browserSupportPolicyContext: browserSupportPolicy?.context ?? null,
        browserSupportPolicyExpectedSupportTier:
          browserSupportPolicy?.expectedSupportTier ?? null,
        browserSupportPolicyObservedSupportTier:
          browserSupportPolicy?.observedSupportTier ?? null,
        browserSupportPolicyExpectedPersistence:
          browserSupportPolicy?.expectedPersistence ?? null,
        browserSupportPolicyObservedPersistence:
          browserSupportPolicy?.observedPersistence ?? null,
        browserSupportPolicyPreflightRequired:
          browserSupportPolicy?.preflightRequired ?? null,
        browserSupportPolicyReasonCount:
          browserSupportPolicy?.reasonCount ??
          browserSupportPolicy?.reasonCodes?.length ??
          null,
        browserSupportPolicyFirstReason:
          browserSupportPolicy?.reasonCodes[0] ?? null,
        browserSupportPolicyRequiredEvidenceCount:
          browserSupportPolicy?.requiredEvidenceCount ??
          browserSupportPolicy?.requiredEvidence?.length ??
          null,
        browserSupportPolicyFirstRequiredEvidence:
          browserSupportPolicy?.requiredEvidence[0] ?? null,
        browserSupportPolicyKnownRiskCount:
          browserSupportPolicy?.knownRiskCount ??
          browserSupportPolicy?.knownRisks?.length ??
          null,
        browserSupportPolicyFirstKnownRisk:
          browserSupportPolicy?.knownRisks[0] ?? null,
        browserSupportPolicyNextStepCount:
          browserSupportPolicy?.nextStepCount ??
          browserSupportPolicy?.nextSteps?.length ??
          null,
        browserSupportPolicyFirstNextStep:
          browserSupportPolicy?.nextSteps[0] ?? null,
        commandTimelineComplete: commandTimelineProof?.complete ?? null,
        commandTimelineScopeJoined: commandTimelineProof?.scopeJoined ?? null,
        commandTimelineSubscriptionIdCount:
          commandTimelineProof?.subscriptionIdCount ??
          commandTimelineProof?.subscriptionIds?.length ??
          null,
        commandTimelineFirstSubscriptionId:
          commandTimelineProof?.subscriptionIds[0] ?? null,
        commandTimelineRequestId: commandTimelineProof?.requestId ?? null,
        commandTimelineSyncAttemptId:
          commandTimelineProof?.syncAttemptId ?? null,
        commandTimelineTraceId: commandTimelineProof?.traceId ?? null,
        commandTimelineSpanId: commandTimelineProof?.spanId ?? null,
        commandTimelineRealtimeCursor:
          commandTimelineProof?.realtimeCursor ?? null,
        commandTimelinePullReason: commandTimelineProof?.pullReason ?? null,
        commandTimelineServerCommitSeq:
          commandTimelineProof?.serverCommitSeq ?? null,
        commandTimelineLocalApplyOutboxId:
          commandTimelineProof?.localApplyOutboxId ?? null,
        commandTimelineLocalApplyCommitSeq:
          commandTimelineProof?.localApplyCommitSeq ?? null,
        commandTimelineLocalVisibilityState:
          commandTimelineProof?.localVisibilityState ?? null,
        commandTimelineLocalVisibilitySource:
          commandTimelineProof?.localVisibilitySource ?? null,
        deploymentPreflightMarkerInAssets:
          artifact.metrics.deploymentPreflightMarkerInAssets,
        deploymentPreflightStatus: deploymentPreflight?.status ?? null,
        deploymentPreflightSupportTier:
          deploymentPreflight?.supportTier ?? null,
        deploymentPreflightPersistence:
          deploymentPreflight?.persistence ?? null,
        deploymentPreflightQuotaPressure:
          deploymentPreflight?.quotaPressure ?? null,
        deploymentPreflightAvailableBytes:
          deploymentPreflight?.availableBytes ?? null,
        deploymentPreflightQuotaBytes: deploymentPreflight?.quotaBytes ?? null,
        deploymentPreflightUsageBytes: deploymentPreflight?.usageBytes ?? null,
        deploymentPreflightUsageRatio: deploymentPreflight?.usageRatio ?? null,
        deploymentPreflightMinimumAvailableBytes:
          deploymentPreflight?.minimumAvailableBytes ?? null,
        deploymentPreflightMinimumQuotaBytes:
          deploymentPreflight?.minimumQuotaBytes ?? null,
        serviceWorker: deploymentPreflight?.serviceWorker ?? null,
        serviceWorkerControlled:
          deploymentPreflight?.serviceWorkerControlled ?? null,
        serviceWorkerControllerState:
          deploymentPreflight?.serviceWorkerControllerState ?? null,
        serviceWorkerControllerScriptPath:
          deploymentPreflight?.serviceWorkerControllerScriptPath ?? null,
        lifecycleResumeMarkerInAssets:
          artifact.metrics.lifecycleResumeMarkerInAssets,
        starterTimelineMarkerInAssets:
          artifact.metrics.starterTimelineMarkerInAssets,
        supportBundleMarkerInAssets:
          artifact.metrics.supportBundleMarkerInAssets,
      }),
    },
  };
}

export function buildCloudflareRuntimeFailureClientDiagnosticIngest(
  payload: ConsoleCloudflareRuntimeFailureIngest
): ConsoleClientDiagnosticIngest {
  const artifact: ConsoleCloudflareRuntimeFailureArtifact =
    payload.artifact ??
    ConsoleCloudflareRuntimeFailureArtifactSchema.parse(payload);
  const probe = artifact.probe;
  const generatedAt = cloudflareRuntimeArtifactGeneratedAtMs(artifact);
  const reason = truncateDiagnosticText(artifact.reason, 500);
  const outputExcerpt = truncateDiagnosticText(probe.outputExcerpt, 4000);
  const details = compactDiagnosticDetails({
    artifactSchema: 'framework-import-smokes.cloudflare-runtime-failure.v1',
    artifactGeneratedAt: artifact.generatedAt,
    reason,
    route: probe.route,
    syncRouteBase: probe.syncRouteBase,
    blobRouteBase: probe.blobRouteBase,
    webSocketRoute: probe.webSocketRoute,
    expectedText: truncateDiagnosticText(probe.expectedText, 500),
    port: probe.port,
    exited: probe.exited,
    outputExcerpt,
    outputExcerptLength: probe.outputExcerpt.length,
    blobMetrics: probe.blobMetrics,
  });

  return {
    clientId: payload.clientId,
    actorId: payload.actorId,
    partitionId: payload.partitionId,
    lifecycle: {
      phase: 'cloudflare-runtime-failure',
      realtime: probe.webSocketRoute ? 'unknown' : undefined,
      online: false,
      requiresAction: true,
      pendingRequests: 0,
      lastError: {
        code: 'cloudflare.runtime_failure',
        reason,
      },
    },
    snapshot: {
      generatedAt,
      runtime: {
        packageName: '@syncular/server',
        hostRuntime: 'cloudflare-workers',
        storage: probe.blobRouteBase
          ? 'd1+r2+durable-object'
          : 'd1+durable-object',
      },
      connection: {
        realtime: probe.webSocketRoute ? 'unknown' : undefined,
        pendingRequests: 0,
      },
      subscriptions: [],
      recentDiagnostics: [
        {
          at: generatedAt,
          level: 'error',
          source: 'cloudflare-runtime',
          code: 'cloudflare.runtime_failure',
          message: 'Cloudflare local runtime failure artifact ingested.',
          details,
        },
      ],
      recentSyncTimings: [
        compactDiagnosticDetails({
          source: 'cloudflare-runtime-smoke',
          route: probe.route,
          syncRouteBase: probe.syncRouteBase,
          blobRouteBase: probe.blobRouteBase,
          webSocketRoute: probe.webSocketRoute,
          blobMetrics: probe.blobMetrics,
        }),
      ],
      bootstrap: compactDiagnosticDetails({
        route: probe.route,
        expectedText: truncateDiagnosticText(probe.expectedText, 500),
        exitCode: probe.exited?.code ?? null,
        exitSignal: probe.exited?.signal ?? null,
      }),
      transportStats: compactDiagnosticDetails({
        route: probe.route,
        port: probe.port,
        syncRouteBase: probe.syncRouteBase,
        blobRouteBase: probe.blobRouteBase,
        webSocketRoute: probe.webSocketRoute,
        outputExcerptLength: probe.outputExcerpt.length,
        blobMetricsAttempted: probe.blobMetrics?.attempted ?? null,
        blobContentBytes: probe.blobMetrics?.contentBytes ?? null,
        blobDownloadBytes: probe.blobMetrics?.downloadBytes ?? null,
        blobPartitionedDownloadBytes:
          probe.blobMetrics?.partitionedDownloadBytes ?? null,
      }),
      blobUploadStats: probe.blobMetrics ?? undefined,
    },
  };
}

export function buildClientDiagnosticRecord(
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

export function measureWebSocketMessageBytes(data: unknown): number {
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

export function generateKeyId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateSecretKey(keyType: ApiKeyType): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );
  return `sk_${keyType}_${random}`;
}

export async function hashApiKey(secretKey: string): Promise<string> {
  return sha256Hex(secretKey);
}
