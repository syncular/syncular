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

import { logSyncEvent } from '@syncular/core';
import type { SqlFamily, SyncCoreDb, SyncServerAuth } from '@syncular/server';
import {
  compactChanges,
  computePruneWatermarkCommitSeq,
  notifyExternalDataChange,
  pruneSync,
  readSyncStats,
} from '@syncular/server';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { describeRoute, resolver, validator as zValidator } from 'hono-openapi';
import { type Generated, type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
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
  ConsoleClientSchema,
  type ConsoleCommitDetail,
  ConsoleCommitDetailSchema,
  type ConsoleCommitListItem,
  ConsoleCommitListItemSchema,
  type ConsoleCompactResult,
  ConsoleCompactResultSchema,
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
  ConsoleRequestEventSchema,
  type ConsoleRequestPayload,
  ConsoleRequestPayloadSchema,
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

function coerceNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint')
    return Number.isFinite(Number(value)) ? Number(value) : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

function parseJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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

// ============================================================================
// Route Schemas
// ============================================================================

const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const commitSeqParamSchema = z.object({ seq: z.coerce.number().int() });
const clientIdParamSchema = z.object({ id: z.string().min(1) });
const eventIdParamSchema = z.object({ id: z.coerce.number().int() });
const apiKeyIdParamSchema = z.object({ id: z.string().min(1) });

const eventsQuerySchema = ConsolePartitionedPaginationQuerySchema.extend({
  eventType: z.enum(['push', 'pull']).optional(),
  actorId: z.string().optional(),
  clientId: z.string().optional(),
  requestId: z.string().optional(),
  traceId: z.string().optional(),
  outcome: z.string().optional(),
});

const commitDetailQuerySchema = ConsolePartitionQuerySchema;
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
const DEFAULT_AUTO_EVENTS_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

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

export function createConsoleRoutes<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
  F extends SqlFamily = SqlFamily,
>(options: CreateConsoleRoutesOptions<DB, Auth, F>): Hono {
  const routes = new Hono();

  routes.onError((error, context) => {
    const message =
      error instanceof Error ? error.message : 'Unknown console error';
    console.error('[console] route error', error);
    return context.json(
      {
        error: 'CONSOLE_ROUTE_ERROR',
        message,
      },
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

  type SyncOperationEventRow = Selectable<SyncOperationEventsTable>;

  interface ConsoleDb extends SyncCoreDb {
    sync_request_events: SyncRequestEventsTable;
    sync_request_payloads: SyncRequestPayloadsTable;
    sync_operation_events: SyncOperationEventsTable;
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
  const autoEventsPruneIntervalMs = readNonNegativeInteger(
    options.maintenance?.autoPruneIntervalMs,
    DEFAULT_AUTO_EVENTS_PRUNE_INTERVAL_MS
  );
  let lastEventsPruneRunAt = 0;

  // Ensure console schema exists before handlers query console tables.
  const consoleSchemaReadyPromise = (
    options.consoleSchemaReady ??
    options.dialect.ensureConsoleSchema?.(options.db) ??
    Promise.resolve()
  ).catch((err) => {
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
      return c.json({ error: 'CONSOLE_SCHEMA_UNAVAILABLE' }, 503);
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

  // Auth middleware
  const requireAuth = async (c: Context): Promise<ConsoleAuthResult | null> => {
    const auth = await options.authenticate(c);
    if (!auth) {
      return null;
    }
    return auth;
  };

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
    eventType: row.event_type === 'push' ? 'push' : 'pull',
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
    tables: options.dialect.dbToArray(row.tables),
    errorMessage: row.error_message ?? null,
    payloadRef: row.payload_ref ?? null,
    createdAt: row.created_at ?? '',
  });

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

  type PruneEventsRunResult = {
    requestEventsDeleted: number;
    operationEventsDeleted: number;
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

  const pruneConsoleEvents = async (): Promise<PruneEventsRunResult> => {
    const requestEventsDeletedByAge = await pruneRequestEventsByAge();
    const requestEventsDeletedByCount = await pruneRequestEventsByCount();
    const requestEventsDeleted =
      requestEventsDeletedByAge + requestEventsDeletedByCount;

    const operationEventsDeletedByAge = await pruneOperationEventsByAge();
    const operationEventsDeletedByCount = await pruneOperationEventsByCount();
    const operationEventsDeleted =
      operationEventsDeletedByAge + operationEventsDeletedByCount;

    const payloadSnapshotsDeleted = await deleteUnreferencedPayloadSnapshots();
    const totalDeleted = requestEventsDeleted + operationEventsDeleted;

    return {
      requestEventsDeleted,
      operationEventsDeleted,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);
      const { partitionId } = c.req.valid('query');

      const stats: SyncStats = await readSyncStats(options.db, {
        partitionId,
      });

      logSyncEvent({
        event: 'console.stats',
        consoleUserId: auth.consoleUserId,
      });

      return c.json(stats, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /stats/timeseries
  // -------------------------------------------------------------------------

  routes.get(
    '/stats/timeseries',
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
            error_count: unknown;
            avg_latency_ms: unknown;
          }>`
            select
              strftime(${bucketFormat}, created_at) as bucket,
              sum(case when event_type = 'push' then 1 else 0 end) as push_count,
              sum(case when event_type = 'pull' then 1 else 0 end) as pull_count,
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
            const errorCount = coerceNumber(row.error_count) ?? 0;
            const avgLatencyMs = coerceNumber(row.avg_latency_ms);
            const rowEventCount = pushCount + pullCount;

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
            error_count: unknown;
            avg_latency_ms: unknown;
          }>`
            select
              date_trunc(${interval}, created_at::timestamptz) as bucket,
              count(*) filter (where event_type = 'push') as push_count,
              count(*) filter (where event_type = 'pull') as pull_count,
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
            const errorCount = coerceNumber(row.error_count) ?? 0;
            const avgLatencyMs = coerceNumber(row.avg_latency_ms);
            const rowEventCount = pushCount + pullCount;

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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
          const eventType = row.event_type === 'push' ? 'push' : 'pull';
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        table,
        outcome,
        search,
        from,
        to,
      } = c.req.valid('query');

      const items: ConsoleTimelineItem[] = [];
      const normalizedSearchTerm = search?.trim().toLowerCase() || null;
      const normalizedTable = table?.trim() || null;

      if (
        view !== 'events' &&
        !eventType &&
        !outcome &&
        !requestId &&
        !traceId
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

        const commitRows = await commitsQuery.execute();
        for (const row of commitRows) {
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
        if (traceId) {
          eventsQuery = eventsQuery.where('trace_id', '=', traceId);
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

        const eventRows = await eventsQuery.execute();
        for (const row of eventRows) {
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
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /commits
  // -------------------------------------------------------------------------

  routes.get(
    '/commits',
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        return c.json({ error: 'NOT_FOUND' }, 404);
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

      const changes: ConsoleChange[] = changeRows.map((row) => ({
        changeId: coerceNumber(row.change_id) ?? 0,
        table: row.table ?? '',
        rowId: row.row_id ?? '',
        op: row.op === 'delete' ? 'delete' : 'upsert',
        rowJson:
          typeof row.row_json === 'string'
            ? (() => {
                try {
                  return JSON.parse(row.row_json);
                } catch {
                  return row.row_json;
                }
              })()
            : row.row_json,
        rowVersion: coerceNumber(row.row_version),
        scopes:
          typeof row.scopes === 'string'
            ? JSON.parse(row.scopes || '{}')
            : (row.scopes ?? {}),
      }));

      const commit: ConsoleCommitDetail = {
        commitSeq: coerceNumber(commitRow.commit_seq) ?? 0,
        actorId: commitRow.actor_id ?? '',
        clientId: commitRow.client_id ?? '',
        clientCommitId: commitRow.client_commit_id ?? '',
        createdAt: commitRow.created_at ?? '',
        changeCount: coerceNumber(commitRow.change_count) ?? 0,
        affectedTables: Array.isArray(commitRow.affected_tables)
          ? commitRow.affected_tables
          : typeof commitRow.affected_tables === 'string'
            ? JSON.parse(commitRow.affected_tables || '[]')
            : [],
        changes,
      };

      return c.json(commit, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /clients
  // -------------------------------------------------------------------------

  routes.get(
    '/clients',
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
          eventType: 'push' | 'pull';
          outcome: string;
          transportPath: 'direct' | 'relay';
        }
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

          const eventType = row.event_type === 'push' ? 'push' : 'pull';

          latestEventsByClientId.set(clientId, {
            createdAt: row.created_at ?? '',
            eventType,
            outcome: row.outcome ?? '',
            transportPath: row.transport_path === 'relay' ? 'relay' : 'direct',
          });
        }
      }

      const items: ConsoleClient[] = rows.map((row) => {
        const clientId = row.client_id ?? '';
        const cursor = coerceNumber(row.cursor) ?? 0;
        const latestEvent = latestEventsByClientId.get(clientId);
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
  // GET /handlers
  // -------------------------------------------------------------------------

  routes.get(
    '/handlers',
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const watermarkCommitSeq = await computePruneWatermarkCommitSeq(
        options.db,
        options.prune
      );

      // Count commits that would be deleted
      const countRow = await db
        .selectFrom('sync_commits')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('commit_seq', '<=', watermarkCommitSeq)
        .executeTakeFirst();

      const commitsToDelete = coerceNumber(countRow?.count) ?? 0;

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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const watermarkCommitSeq = await computePruneWatermarkCommitSeq(
        options.db,
        options.prune
      );

      const deletedCommits = await pruneSync(options.db, {
        watermarkCommitSeq,
        keepNewestCommits: options.prune?.keepNewestCommits,
      });

      logSyncEvent({
        event: 'console.prune',
        consoleUserId: auth.consoleUserId,
        deletedCommits,
        watermarkCommitSeq,
      });
      await recordOperationEvent({
        operationType: 'prune',
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const fullHistoryHours = options.compact?.fullHistoryHours ?? 24 * 7;

      const deletedChanges = await compactChanges(options.db, {
        dialect: options.dialect,
        options: { fullHistoryHours },
      });

      logSyncEvent({
        event: 'console.compact',
        consoleUserId: auth.consoleUserId,
        deletedChanges,
        fullHistoryHours,
      });
      await recordOperationEvent({
        operationType: 'compact',
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const body = c.req.valid('json');

      const result = await notifyExternalDataChange({
        db: options.db,
        dialect: options.dialect,
        tables: body.tables,
        partitionId: body.partitionId,
      });

      logSyncEvent({
        event: 'console.notify_data_change',
        consoleUserId: auth.consoleUserId,
        tables: body.tables,
        commitSeq: result.commitSeq,
        deletedChunks: result.deletedChunks,
      });
      await recordOperationEvent({
        operationType: 'notify_data_change',
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        consoleUserId: auth.consoleUserId,
        clientId,
        evicted,
      });
      await recordOperationEvent({
        operationType: 'evict_client',
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const {
        limit,
        offset,
        partitionId,
        eventType,
        actorId,
        clientId,
        requestId,
        traceId,
        outcome,
      } = c.req.valid('query');

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
      if (traceId) {
        query = query.where('trace_id', '=', traceId);
        countQuery = countQuery.where('trace_id', '=', traceId);
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
      }
    >();

    const closeUnauthenticated = (ws: WebSocketLike) => {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'UNAUTHENTICATED' }));
      } catch {
        // ignore send errors
      }
      ws.close(4001, 'Unauthenticated');
    };

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

    routes.get(
      '/events/live',
      upgradeWebSocket(async (c) => {
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
            const state = {
              listener: null,
              heartbeatInterval: null,
              authTimeout: null,
              isAuthenticated: false,
            } as {
              listener: ConsoleEventListener | null;
              heartbeatInterval: ReturnType<typeof setInterval> | null;
              authTimeout: ReturnType<typeof setTimeout> | null;
              isAuthenticated: boolean;
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

            if (initialAuth) {
              startAuthenticatedSession();
              return;
            }

            state.authTimeout = setTimeout(() => {
              const current = wsState.get(ws);
              if (!current || current.isAuthenticated) {
                return;
              }
              closeUnauthenticated(ws);
              cleanup(ws);
            }, 5_000);
          },
          async onMessage(event, ws) {
            const state = wsState.get(ws);
            if (!state || state.isAuthenticated) {
              return;
            }

            if (typeof event.data !== 'string') {
              closeUnauthenticated(ws);
              cleanup(ws);
              return;
            }

            let token = '';
            try {
              const parsed = JSON.parse(event.data) as {
                type?: unknown;
                token?: unknown;
              };
              if (
                parsed.type === 'auth' &&
                typeof parsed.token === 'string' &&
                parsed.token.trim().length > 0
              ) {
                token = parsed.token;
              }
            } catch {
              // Ignore parse errors and close as unauthenticated below.
            }

            if (!token) {
              closeUnauthenticated(ws);
              cleanup(ws);
              return;
            }

            const auth = await authenticateWithBearer(token);
            const currentState = wsState.get(ws);
            if (!currentState || currentState.isAuthenticated) {
              return;
            }
            if (!auth) {
              closeUnauthenticated(ws);
              cleanup(ws);
              return;
            }

            currentState.isAuthenticated = true;
            if (currentState.authTimeout) {
              clearTimeout(currentState.authTimeout);
              currentState.authTimeout = null;
            }

            const listener: ConsoleEventListener = (liveEvent) => {
              if (partitionId) {
                const eventPartitionId = liveEvent.data.partitionId;
                if (
                  typeof eventPartitionId !== 'string' ||
                  eventPartitionId !== partitionId
                ) {
                  return;
                }
              }
              try {
                ws.send(JSON.stringify(liveEvent));
              } catch {
                // Connection closed
              }
            };

            emitter.addListener(listener);
            currentState.listener = listener;

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
            currentState.heartbeatInterval = heartbeatInterval;
          },
          onClose(_event, ws) {
            cleanup(ws);
          },
          onError(_event, ws) {
            cleanup(ws);
          },
        };
      })
    );
  }

  // -------------------------------------------------------------------------
  // GET /events/:id - Single event detail
  // -------------------------------------------------------------------------

  routes.get(
    '/events/:id',
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        return c.json({ error: 'NOT_FOUND' }, 404);
      }

      return c.json(mapRequestEvent(row), 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /events/:id/payload - payload snapshot detail (if retained)
  // -------------------------------------------------------------------------

  routes.get(
    '/events/:id/payload',
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        return c.json({ error: 'NOT_FOUND' }, 404);
      }

      const payloadRef = eventRow.payload_ref;
      if (!payloadRef) {
        return c.json(
          { error: 'NOT_FOUND', message: 'No payload snapshot recorded' },
          404
        );
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
        return c.json(
          { error: 'NOT_FOUND', message: 'Payload snapshot not available' },
          404
        );
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const res = await db.deleteFrom('sync_request_events').executeTakeFirst();

      const deletedCount = Number(res?.numDeletedRows ?? 0);
      const payloadDeletedCount = await deleteUnreferencedPayloadSnapshots();

      logSyncEvent({
        event: 'console.clear_events',
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const pruneResult = await runEventsPrune();
      const deletedCount = pruneResult.totalDeleted;

      logSyncEvent({
        event: 'console.prune_events',
        consoleUserId: auth.consoleUserId,
        deletedCount,
        requestEventsDeleted: pruneResult.requestEventsDeleted,
        operationEventsDeleted: pruneResult.operationEventsDeleted,
        payloadDeletedCount: pruneResult.payloadSnapshotsDeleted,
      });

      const result: ConsolePruneEventsResult = { deletedCount };
      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /api-keys - List all API keys
  // -------------------------------------------------------------------------

  routes.get(
    '/api-keys',
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        return c.json({ error: 'NOT_FOUND' }, 404);
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const body = c.req.valid('json');
      const keyIds = [...new Set(body.keyIds.map((keyId) => keyId.trim()))]
        .filter((keyId) => keyId.length > 0)
        .slice(0, 200);

      if (keyIds.length === 0) {
        return c.json(
          { error: 'INVALID_REQUEST', message: 'No API key IDs provided' },
          400
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
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        return c.json({ error: 'NOT_FOUND' }, 404);
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
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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
        return c.json({ error: 'NOT_FOUND' }, 404);
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
        consoleUserId: auth.consoleUserId,
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      if (!bucket) {
        return c.json({ error: 'BLOB_STORAGE_NOT_CONFIGURED' }, 501);
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      if (!bucket) {
        return c.json({ error: 'BLOB_STORAGE_NOT_CONFIGURED' }, 501);
      }

      const key = decodeURIComponent(c.req.param('key'));
      const object = await bucket.get(key);
      if (!object) {
        return c.json({ error: 'BLOB_NOT_FOUND' }, 404);
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
    describeRoute({
      tags: ['console'],
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
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      if (!bucket) {
        return c.json({ error: 'BLOB_STORAGE_NOT_CONFIGURED' }, 501);
      }

      const key = decodeURIComponent(c.req.param('key'));
      await bucket.delete(key);
      return c.json({ deleted: true }, 200);
    }
  );

  return routes;
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
  const encoder = new TextEncoder();
  const data = encoder.encode(secretKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join('');
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

    const authHeader = c.req.header('Authorization')?.trim();
    if (authHeader?.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7).trim();
      if (bearerToken === expectedToken) {
        return { consoleUserId: 'token' };
      }
    }

    return null;
  };
}
