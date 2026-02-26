/**
 * @syncular/server-hono - Sync routes for Hono
 *
 * Provides:
 * - POST /      (combined push + pull in one round-trip)
 * - GET  /snapshot-chunks/:chunkId (download encoded snapshot chunks)
 * - GET  /realtime (optional WebSocket "wake up" notifications)
 */

import {
  captureSyncException,
  countSyncMetric,
  createSyncTimer,
  distributionSyncMetric,
  ErrorResponseSchema,
  logSyncEvent,
  SyncCombinedRequestSchema,
  SyncCombinedResponseSchema,
  SyncPushRequestSchema,
} from '@syncular/core';
import type {
  ScopeCacheBackend,
  ServerSyncDialect,
  ServerTableHandler,
  SnapshotChunkStorage,
  SqlFamily,
  SyncCoreDb,
  SyncRealtimeBroadcaster,
  SyncRealtimeEvent,
  SyncServerAuth,
} from '@syncular/server';
import {
  type CompactOptions,
  createServerHandlerCollection,
  InvalidSubscriptionScopeError,
  type PruneOptions,
  type PullResult,
  pull,
  pushCommit,
  readSnapshotChunk,
  recordClientCursor,
} from '@syncular/server';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import type { UpgradeWebSocket } from 'hono/ws';
import { describeRoute, resolver, validator as zValidator } from 'hono-openapi';
import {
  type Kysely,
  type SelectQueryBuilder,
  type SqlBool,
  sql,
} from 'kysely';
import { z } from 'zod';
import {
  createRateLimiter,
  DEFAULT_SYNC_RATE_LIMITS,
  type SyncRateLimitConfig,
} from './rate-limit';
import {
  createWebSocketConnection,
  type WebSocketConnection,
  WebSocketConnectionManager,
} from './ws';

/**
 * WeakMaps for storing Hono-instance-specific data without augmenting the type.
 */
const wsConnectionManagerMap = new WeakMap<Hono, WebSocketConnectionManager>();
const realtimeUnsubscribeMap = new WeakMap<Hono, () => void>();

export interface SyncAuthResult extends SyncServerAuth {}

/**
 * WebSocket configuration for realtime sync.
 *
 * Note: this endpoint is only a "wake up" mechanism; clients must still pull.
 */
export interface SyncWebSocketConfig {
  enabled?: boolean;
  /**
   * Runtime-provided WebSocket upgrader (e.g. from `hono/bun`'s `createBunWebSocket()`).
   */
  upgradeWebSocket?: UpgradeWebSocket;
  heartbeatIntervalMs?: number;
  /**
   * Maximum number of concurrent WebSocket connections across the entire process.
   * Default: 5000
   */
  maxConnectionsTotal?: number;
  /**
   * Maximum number of concurrent WebSocket connections per clientId.
   * Default: 3
   */
  maxConnectionsPerClient?: number;
}

export interface SyncRoutesConfigWithRateLimit {
  /**
   * Max commits per pull request.
   * Default: 100
   */
  maxPullLimitCommits?: number;
  /**
   * Max subscriptions per pull request.
   * Default: 200
   */
  maxSubscriptionsPerPull?: number;
  /**
   * Max snapshot rows per snapshot page.
   * Default: 5000
   */
  maxPullLimitSnapshotRows?: number;
  /**
   * Max snapshot pages per subscription per pull response.
   * Default: 10
   */
  maxPullMaxSnapshotPages?: number;
  /**
   * Max operations per pushed commit.
   * Default: 200
   */
  maxOperationsPerPush?: number;
  /**
   * Rate limiting configuration.
   * Set to false to disable all rate limiting.
   */
  rateLimit?: SyncRateLimitConfig | false;
  /**
   * WebSocket realtime configuration.
   */
  websocket?: SyncWebSocketConfig;

  /**
   * Optional pruning configuration. When enabled, the server periodically prunes
   * old commit history based on active client cursors.
   */
  prune?: {
    /** Minimum time between prune runs. Default: 5 minutes. */
    minIntervalMs?: number;
    /** Pruning watermark options. */
    options?: PruneOptions;
  };

  /**
   * Optional compaction configuration. When enabled, the server periodically
   * compacts older change history to reduce storage.
   */
  compact?: {
    /** Minimum time between compaction runs. Default: 30 minutes. */
    minIntervalMs?: number;
    /** Compaction options. */
    options?: CompactOptions;
  };

  /**
   * Optional multi-instance realtime broadcaster.
   * When provided, instances publish/subscribe commit wakeups via the broadcaster.
   */
  realtime?: {
    broadcaster: SyncRealtimeBroadcaster;
    /** Optional stable instance id (useful in tests). */
    instanceId?: string;
  };
}

export interface CreateSyncRoutesOptions<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
> {
  db: Kysely<DB>;
  dialect: ServerSyncDialect<F>;
  handlers: ServerTableHandler<DB, Auth>[];
  authenticate: (c: Context) => Promise<Auth | null>;
  sync?: SyncRoutesConfigWithRateLimit;
  wsConnectionManager?: WebSocketConnectionManager;
  /**
   * Optional snapshot chunk storage adapter.
   * When provided, stores snapshot chunk bodies in external storage
   * (S3, R2, etc.) instead of inline in the database.
   */
  chunkStorage?: SnapshotChunkStorage;
  /**
   * Optional scope cache backend for resolveScopes() results.
   * Request-local memoization is always applied for every pull.
   */
  scopeCache?: ScopeCacheBackend;
  /**
   * Optional live emitter for console websocket activity feed.
   * When provided, sync lifecycle events are published to `/console/events/live`.
   */
  consoleLiveEmitter?: {
    emit(event: {
      type: 'push' | 'pull' | 'commit' | 'client_update';
      timestamp: string;
      data: Record<string, unknown>;
    }): void;
  };
}

// ============================================================================
// Route Schemas
// ============================================================================

const snapshotChunkParamsSchema = z.object({
  chunkId: z.string().min(1),
});

const MAX_REQUEST_PAYLOAD_SNAPSHOT_BYTES = 128 * 1024;

type TraceContext = {
  traceId: string | null;
  spanId: string | null;
};

function createOpaqueId(prefix: string): string {
  const randomPart =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomPart}`;
}

function readRequestId(c: Context): string {
  const headerRequestId = c.req.header('x-request-id')?.trim();
  if (headerRequestId) return headerRequestId;
  return createOpaqueId('req');
}

function parseW3cTraceparent(
  traceparent: string | null | undefined
): TraceContext | null {
  if (!traceparent) return null;
  const parsed = traceparent.trim();
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(parsed);
  if (!match) return null;
  const traceId = match[1]?.toLowerCase() ?? null;
  const spanId = match[2]?.toLowerCase() ?? null;
  if (!traceId || !spanId) return null;
  return { traceId, spanId };
}

function parseSentryTraceHeader(
  sentryTrace: string | null | undefined
): TraceContext | null {
  if (!sentryTrace) return null;
  const parsed = sentryTrace.trim();
  const match = /^([0-9a-f]{32})-([0-9a-f]{16})(?:-[01])?$/i.exec(parsed);
  if (!match) return null;
  const traceId = match[1]?.toLowerCase() ?? null;
  const spanId = match[2]?.toLowerCase() ?? null;
  if (!traceId || !spanId) return null;
  return { traceId, spanId };
}

function readTraceContext(c: Context): TraceContext {
  const traceparent = parseW3cTraceparent(c.req.header('traceparent'));
  if (traceparent) return traceparent;

  const sentryTrace = parseSentryTraceHeader(c.req.header('sentry-trace'));
  if (sentryTrace) return sentryTrace;

  return { traceId: null, spanId: null };
}

function readStringField(
  data: Record<string, unknown>,
  key: string
): string | null {
  const value = data[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readTraceContextFromMessage(
  msg: Record<string, unknown>
): TraceContext {
  const directTraceId =
    readStringField(msg, 'traceId') ?? readStringField(msg, 'trace_id');
  const directSpanId =
    readStringField(msg, 'spanId') ?? readStringField(msg, 'span_id');
  if (directTraceId || directSpanId) {
    return { traceId: directTraceId, spanId: directSpanId };
  }

  const traceparent =
    readStringField(msg, 'traceparent') ?? readStringField(msg, 'traceParent');
  const parsedTraceparent = parseW3cTraceparent(traceparent);
  if (parsedTraceparent) return parsedTraceparent;

  const sentryTrace =
    readStringField(msg, 'sentry-trace') ??
    readStringField(msg, 'sentryTrace') ??
    readStringField(msg, 'sentry_trace');
  const parsedSentryTrace = parseSentryTraceHeader(sentryTrace);
  if (parsedSentryTrace) return parsedSentryTrace;

  return { traceId: null, spanId: null };
}

function normalizeResponseStatus(statusCode: number, outcome: string): string {
  if (statusCode >= 500) return 'server_error';
  if (statusCode >= 400) return 'client_error';
  if (statusCode >= 300) return 'redirect';
  if (statusCode >= 200) {
    if (outcome === 'error' || outcome === 'rejected') return 'failure';
    return 'success';
  }
  return 'unknown';
}

function firstPushErrorCode(results: unknown): string | null {
  if (!Array.isArray(results)) return null;
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const status = Reflect.get(result, 'status');
    if (status !== 'error') continue;
    const code = Reflect.get(result, 'code');
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return null;
}

function summarizeScopeValues(
  scopes: Record<string, string | string[]>
): Record<string, string | string[]> | null {
  const summary: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(scopes)) {
    if (typeof value === 'string') {
      summary[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const normalized = value
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 20);
      summary[key] = normalized;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function summarizePullResponse(response: PullResult['response']): {
  subscriptions: Array<{
    id: string;
    status: 'active' | 'revoked';
    bootstrap: boolean;
    nextCursor: number;
    commitCount: number;
    changeCount: number;
    snapshotCount: number;
    snapshotRowCount: number;
  }>;
} {
  return {
    subscriptions: response.subscriptions.map((subscription) => {
      const changeCount = subscription.commits.reduce(
        (totalChanges, commit) => totalChanges + commit.changes.length,
        0
      );
      const snapshotCount = subscription.snapshots?.length ?? 0;
      const snapshotRowCount =
        subscription.snapshots?.reduce(
          (totalRows, snapshot) => totalRows + snapshot.rows.length,
          0
        ) ?? 0;

      return {
        id: subscription.id,
        status: subscription.status,
        bootstrap: subscription.bootstrap,
        nextCursor: subscription.nextCursor,
        commitCount: subscription.commits.length,
        changeCount,
        snapshotCount,
        snapshotRowCount,
      };
    }),
  };
}

function countPullRows(response: PullResult['response']): number {
  return response.subscriptions.reduce((totalRows, subscription) => {
    const commitRows = subscription.commits.reduce(
      (totalChanges, commit) => totalChanges + commit.changes.length,
      0
    );
    const snapshotRows =
      subscription.snapshots?.reduce(
        (totalSnapshotRows, snapshot) =>
          totalSnapshotRows + snapshot.rows.length,
        0
      ) ?? 0;
    return totalRows + commitRows + snapshotRows;
  }, 0);
}

function encodePayloadSnapshot(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_REQUEST_PAYLOAD_SNAPSHOT_BYTES) {
      return serialized;
    }
    return JSON.stringify({
      truncated: true,
      originalSizeBytes: serialized.length,
      preview: serialized.slice(0, MAX_REQUEST_PAYLOAD_SNAPSHOT_BYTES),
    });
  } catch {
    return JSON.stringify({
      truncated: false,
      serializationError: 'Could not serialize payload snapshot',
    });
  }
}

function emitConsoleLiveEvent(
  emitter:
    | {
        emit(event: {
          type: 'push' | 'pull' | 'commit' | 'client_update';
          timestamp: string;
          data: Record<string, unknown>;
        }): void;
      }
    | undefined,
  type: 'push' | 'pull' | 'commit' | 'client_update',
  data: Record<string, unknown> | (() => Record<string, unknown>)
): void {
  if (!emitter) return;
  emitter.emit({
    type,
    timestamp: new Date().toISOString(),
    data: typeof data === 'function' ? data() : data,
  });
}

export function createSyncRoutes<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(options: CreateSyncRoutesOptions<DB, Auth, F>): Hono {
  const routes = new Hono();
  routes.onError((error, c) => {
    captureSyncException(error, {
      event: 'sync.route.unhandled',
      method: c.req.method,
      path: c.req.path,
    });
    return c.text('Internal Server Error', 500);
  });
  const handlerRegistry = createServerHandlerCollection(options.handlers);
  const config = options.sync ?? {};
  const maxPullLimitCommits = config.maxPullLimitCommits ?? 100;
  const maxSubscriptionsPerPull = config.maxSubscriptionsPerPull ?? 200;
  const maxPullLimitSnapshotRows = config.maxPullLimitSnapshotRows ?? 5000;
  const maxPullMaxSnapshotPages = config.maxPullMaxSnapshotPages ?? 10;
  const maxOperationsPerPush = config.maxOperationsPerPush ?? 200;
  const consoleLiveEmitter = options.consoleLiveEmitter;
  const shouldEmitConsoleLiveEvents = consoleLiveEmitter !== undefined;
  const shouldRecordRequestEvents = shouldEmitConsoleLiveEvents;

  // -------------------------------------------------------------------------
  // Optional WebSocket manager (scope-key based wake-ups)
  // -------------------------------------------------------------------------

  const websocketConfig = config.websocket;
  if (websocketConfig?.enabled && !websocketConfig.upgradeWebSocket) {
    throw new Error(
      'sync.websocket.enabled requires sync.websocket.upgradeWebSocket'
    );
  }

  const wsConnectionManager = websocketConfig?.enabled
    ? (options.wsConnectionManager ??
      new WebSocketConnectionManager({
        heartbeatIntervalMs: websocketConfig.heartbeatIntervalMs ?? 30_000,
      }))
    : null;

  if (wsConnectionManager) {
    wsConnectionManagerMap.set(routes, wsConnectionManager);
  }

  // -------------------------------------------------------------------------
  // Multi-instance realtime broadcaster (optional)
  // -------------------------------------------------------------------------

  const realtimeBroadcaster = config.realtime?.broadcaster ?? null;
  const instanceId =
    config.realtime?.instanceId ??
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const loggedAsyncFailureKeys = new Set<string>();
  const logAsyncFailureOnce = (
    key: string,
    event: {
      event: string;
      error: string;
      [key: string]: unknown;
    }
  ) => {
    if (loggedAsyncFailureKeys.has(key)) return;
    loggedAsyncFailureKeys.add(key);
    logSyncEvent(event);
  };

  if (wsConnectionManager && realtimeBroadcaster) {
    const unsubscribe = realtimeBroadcaster.subscribe(
      (event: SyncRealtimeEvent) => {
        void handleRealtimeEvent(event).catch((error) => {
          logAsyncFailureOnce('sync.realtime.broadcast_delivery_failed', {
            event: 'sync.realtime.broadcast_delivery_failed',
            error: error instanceof Error ? error.message : String(error),
            sourceEventType: event.type,
          });
        });
      }
    );

    realtimeUnsubscribeMap.set(routes, unsubscribe);
  }

  // -------------------------------------------------------------------------
  // Request event recording (for console inspector)
  // -------------------------------------------------------------------------

  type RequestPayloadSnapshot = {
    request: unknown;
    response: unknown;
  };

  type RequestEvent = {
    partitionId: string;
    requestId: string;
    traceId?: string | null;
    spanId?: string | null;
    eventType: 'push' | 'pull';
    syncPath: 'http-combined' | 'ws-push';
    actorId: string;
    clientId: string;
    transportPath: 'direct' | 'relay';
    statusCode: number;
    outcome: string;
    responseStatus: string;
    durationMs: number;
    errorCode?: string | null;
    commitSeq?: number | null;
    operationCount?: number | null;
    rowCount?: number | null;
    subscriptionCount?: number | null;
    scopesSummary?: Record<string, string | string[]> | null;
    tables?: string[];
    errorMessage?: string | null;
    payloadRef?: string | null;
    payloadSnapshot?: RequestPayloadSnapshot | null;
  };

  const recordRequestEvent = async (event: RequestEvent) => {
    let payloadRef = event.payloadRef ?? null;
    if (event.payloadSnapshot) {
      const nextPayloadRef = payloadRef ?? createOpaqueId('payload');
      const nowIso = new Date().toISOString();

      try {
        await sql`
          INSERT INTO sync_request_payloads (
            payload_ref, partition_id, request_payload, response_payload, created_at
          ) VALUES (
            ${nextPayloadRef}, ${event.partitionId},
            ${encodePayloadSnapshot(event.payloadSnapshot.request)},
            ${encodePayloadSnapshot(event.payloadSnapshot.response)},
            ${nowIso}
          )
          ON CONFLICT (payload_ref) DO UPDATE SET
            partition_id = EXCLUDED.partition_id,
            request_payload = EXCLUDED.request_payload,
            response_payload = EXCLUDED.response_payload,
            created_at = EXCLUDED.created_at
        `.execute(options.db);
        payloadRef = nextPayloadRef;
      } catch (error) {
        payloadRef = null;
        logAsyncFailureOnce('sync.request_payload_record_failed', {
          event: 'sync.request_payload_record_failed',
          userId: event.actorId,
          clientId: event.clientId,
          requestEventType: event.eventType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const tablesValue = options.dialect.arrayToDb(event.tables ?? []);
    const scopesSummaryValue = event.scopesSummary
      ? JSON.stringify(event.scopesSummary)
      : null;

    await sql`
      INSERT INTO sync_request_events (
        partition_id, request_id, trace_id, span_id,
        event_type, sync_path, actor_id, client_id, transport_path,
        status_code, outcome, response_status, error_code,
        duration_ms, commit_seq, operation_count, row_count, subscription_count,
        scopes_summary, tables, error_message, payload_ref
      ) VALUES (
        ${event.partitionId}, ${event.requestId}, ${event.traceId ?? null},
        ${event.spanId ?? null}, ${event.eventType}, ${event.syncPath},
        ${event.actorId}, ${event.clientId}, ${event.transportPath},
        ${event.statusCode}, ${event.outcome}, ${event.responseStatus},
        ${event.errorCode ?? null}, ${event.durationMs}, ${event.commitSeq ?? null},
        ${event.operationCount ?? null}, ${event.rowCount ?? null},
        ${event.subscriptionCount ?? null}, ${scopesSummaryValue}, ${tablesValue},
        ${event.errorMessage ?? null}, ${payloadRef}
      )
    `.execute(options.db);
  };

  const recordRequestEventInBackground = (
    event: RequestEvent | (() => RequestEvent)
  ): void => {
    if (!shouldRecordRequestEvents) return;

    const resolvedEvent = typeof event === 'function' ? event() : event;

    void recordRequestEvent(resolvedEvent).catch((error) => {
      logAsyncFailureOnce('sync.request_event_record_failed', {
        event: 'sync.request_event_record_failed',
        userId: resolvedEvent.actorId,
        clientId: resolvedEvent.clientId,
        requestEventType: resolvedEvent.eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const authCache = new WeakMap<Context, Promise<Auth | null>>();
  const getAuth = (c: Context): Promise<Auth | null> => {
    const cached = authCache.get(c);
    if (cached) return cached;
    const pending = options.authenticate(c);
    authCache.set(c, pending);
    return pending;
  };

  // -------------------------------------------------------------------------
  // Rate limiting (optional)
  // -------------------------------------------------------------------------

  const rateLimitConfig = config.rateLimit;
  if (rateLimitConfig !== false) {
    const pullRateLimit =
      rateLimitConfig?.pull ?? DEFAULT_SYNC_RATE_LIMITS.pull;
    const pushRateLimit =
      rateLimitConfig?.push ?? DEFAULT_SYNC_RATE_LIMITS.push;

    const createAuthBasedRateLimiter = (
      limitConfig: Omit<SyncRateLimitConfig['pull'], never> | false | undefined
    ) => {
      if (limitConfig === false || !limitConfig) return null;
      return createRateLimiter({
        ...limitConfig,
        keyGenerator: async (c) => {
          const auth = await getAuth(c);
          return auth?.actorId ?? null;
        },
      });
    };

    const pullLimiter = createAuthBasedRateLimiter(pullRateLimit);
    const pushLimiter = createAuthBasedRateLimiter(pushRateLimit);

    const syncRateLimiter: MiddlewareHandler = async (c, next) => {
      if (!pullLimiter && !pushLimiter) return next();

      let shouldApplyPull = pullLimiter !== null;
      let shouldApplyPush = pushLimiter !== null;

      if (pullLimiter && pushLimiter && c.req.method === 'POST') {
        try {
          const parsed = await c.req.raw.clone().json();
          if (parsed !== null && typeof parsed === 'object') {
            shouldApplyPull = Reflect.get(parsed, 'pull') !== undefined;
            shouldApplyPush = Reflect.get(parsed, 'push') !== undefined;
          }
        } catch {
          // Keep default behavior and apply both limiters when payload parsing fails.
        }
      }

      if (pullLimiter && shouldApplyPull && pushLimiter && shouldApplyPush) {
        return pullLimiter(c, async () => {
          const pushResult = await pushLimiter(c, next);
          if (pushResult instanceof Response) {
            c.res = pushResult;
          }
        });
      }
      if (pullLimiter && shouldApplyPull) {
        return pullLimiter(c, next);
      }
      if (pushLimiter && shouldApplyPush) {
        return pushLimiter(c, next);
      }

      return next();
    };

    routes.use('/', syncRateLimiter);
  }

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  routes.get('/health', (c) => {
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /  (combined push + pull in one round-trip)
  // -------------------------------------------------------------------------

  routes.post(
    '/',
    describeRoute({
      tags: ['sync'],
      summary: 'Combined push and pull',
      description:
        'Perform push and/or pull in a single request to reduce round-trips',
      responses: {
        200: {
          description: 'Combined sync response',
          content: {
            'application/json': {
              schema: resolver(SyncCombinedResponseSchema),
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
    zValidator('json', SyncCombinedRequestSchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);
      const partitionId = auth.partitionId ?? 'default';

      const body = c.req.valid('json');
      const clientId = body.clientId;
      const requestId = readRequestId(c);
      const traceContext = readTraceContext(c);

      let pushResponse:
        | undefined
        | Awaited<ReturnType<typeof pushCommit>>['response'];
      let pullResponse: undefined | PullResult['response'];

      // --- Push phase ---
      if (body.push) {
        const pushBody = body.push;
        const pushOps = pushBody.operations ?? [];
        if (pushOps.length > maxOperationsPerPush) {
          return c.json(
            {
              error: 'TOO_MANY_OPERATIONS',
              message: `Maximum ${maxOperationsPerPush} operations per push`,
            },
            400
          );
        }

        const timer = createSyncTimer();

        const pushed = await pushCommit({
          db: options.db,
          dialect: options.dialect,
          handlers: handlerRegistry,
          auth,
          request: {
            clientId,
            clientCommitId: pushBody.clientCommitId,
            operations: pushBody.operations,
            schemaVersion: pushBody.schemaVersion,
          },
        });

        const pushDurationMs = timer();

        logSyncEvent({
          event: 'sync.push',
          userId: auth.actorId,
          durationMs: pushDurationMs,
          operationCount: pushOps.length,
          status: pushed.response.status,
          commitSeq: pushed.response.commitSeq,
        });

        recordRequestEventInBackground(() => ({
          partitionId,
          requestId,
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          eventType: 'push',
          syncPath: 'http-combined',
          actorId: auth.actorId,
          clientId,
          transportPath: readTransportPath(c),
          statusCode: 200,
          outcome: pushed.response.status,
          responseStatus: normalizeResponseStatus(200, pushed.response.status),
          durationMs: pushDurationMs,
          errorCode: firstPushErrorCode(pushed.response.results),
          commitSeq: pushed.response.commitSeq,
          operationCount: pushOps.length,
          tables: pushed.affectedTables,
          payloadSnapshot: {
            request: {
              clientId,
              clientCommitId: pushBody.clientCommitId,
              schemaVersion: pushBody.schemaVersion,
              operations: pushBody.operations,
            },
            response: pushed.response,
          },
        }));
        emitConsoleLiveEvent(consoleLiveEmitter, 'push', () => ({
          partitionId,
          requestId,
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          actorId: auth.actorId,
          clientId,
          transportPath: readTransportPath(c),
          syncPath: 'http-combined',
          outcome: pushed.response.status,
          statusCode: 200,
          durationMs: pushDurationMs,
          commitSeq: pushed.response.commitSeq ?? null,
          operationCount: pushOps.length,
          tables: pushed.affectedTables,
        }));

        // WS notifications
        if (
          wsConnectionManager &&
          pushed.response.ok === true &&
          pushed.response.status === 'applied' &&
          typeof pushed.response.commitSeq === 'number'
        ) {
          const scopeKeys = applyPartitionToScopeKeys(
            partitionId,
            pushed.scopeKeys
          );
          if (scopeKeys.length > 0) {
            wsConnectionManager.notifyScopeKeys(
              scopeKeys,
              pushed.response.commitSeq,
              {
                excludeClientIds: [clientId],
                changes: pushed.emittedChanges,
              }
            );

            if (realtimeBroadcaster) {
              realtimeBroadcaster
                .publish({
                  type: 'commit',
                  commitSeq: pushed.response.commitSeq,
                  partitionId,
                  scopeKeys,
                  sourceInstanceId: instanceId,
                })
                .catch((error) => {
                  logAsyncFailureOnce(
                    'sync.realtime.broadcast_publish_failed',
                    {
                      event: 'sync.realtime.broadcast_publish_failed',
                      userId: auth.actorId,
                      clientId,
                      error:
                        error instanceof Error ? error.message : String(error),
                    }
                  );
                });
            }
          }
        }

        if (
          pushed.response.ok === true &&
          pushed.response.status === 'applied' &&
          typeof pushed.response.commitSeq === 'number'
        ) {
          emitConsoleLiveEvent(consoleLiveEmitter, 'commit', () => ({
            partitionId,
            commitSeq: pushed.response.commitSeq,
            actorId: auth.actorId,
            clientId,
            affectedTables: pushed.affectedTables,
          }));
        }

        pushResponse = pushed.response;
      }

      // --- Pull phase ---
      if (body.pull) {
        if (body.pull.subscriptions.length > maxSubscriptionsPerPull) {
          return c.json(
            {
              error: 'INVALID_REQUEST',
              message: `Too many subscriptions (max ${maxSubscriptionsPerPull})`,
            },
            400
          );
        }

        const seenSubscriptionIds = new Set<string>();
        for (const sub of body.pull.subscriptions) {
          const id = sub.id;
          if (seenSubscriptionIds.has(id)) {
            return c.json(
              {
                error: 'INVALID_REQUEST',
                message: `Duplicate subscription id: ${id}`,
              },
              400
            );
          }
          seenSubscriptionIds.add(id);
        }

        const request = {
          clientId,
          limitCommits: clampInt(
            body.pull.limitCommits ?? 50,
            1,
            maxPullLimitCommits
          ),
          limitSnapshotRows: clampInt(
            body.pull.limitSnapshotRows ?? 1000,
            1,
            maxPullLimitSnapshotRows
          ),
          maxSnapshotPages: clampInt(
            body.pull.maxSnapshotPages ?? 4,
            1,
            maxPullMaxSnapshotPages
          ),
          dedupeRows: body.pull.dedupeRows === true,
          subscriptions: body.pull.subscriptions.map((sub) => ({
            id: sub.id,
            table: sub.table,
            scopes: (sub.scopes ?? {}) as Record<string, string | string[]>,
            params: sub.params as Record<string, unknown>,
            cursor: Math.max(-1, sub.cursor),
            bootstrapState: sub.bootstrapState ?? null,
          })),
        };

        const timer = createSyncTimer();

        let pullResult: PullResult;
        try {
          pullResult = await pull({
            db: options.db,
            dialect: options.dialect,
            handlers: handlerRegistry,
            auth,
            request,
            chunkStorage: options.chunkStorage,
            scopeCache: options.scopeCache,
          });
        } catch (err) {
          if (err instanceof InvalidSubscriptionScopeError) {
            return c.json(
              { error: 'INVALID_SUBSCRIPTION', message: err.message },
              400
            );
          }
          throw err;
        }

        // Fire-and-forget bookkeeping
        void recordClientCursor(options.db, options.dialect, {
          partitionId,
          clientId,
          actorId: auth.actorId,
          cursor: pullResult.clientCursor,
          effectiveScopes: pullResult.effectiveScopes,
        })
          .then(() => {
            emitConsoleLiveEvent(consoleLiveEmitter, 'client_update', () => ({
              action: 'cursor_recorded',
              partitionId,
              actorId: auth.actorId,
              clientId,
              cursor: pullResult.clientCursor,
            }));
          })
          .catch((error) => {
            logAsyncFailureOnce('sync.client_cursor_record_failed', {
              event: 'sync.client_cursor_record_failed',
              userId: auth.actorId,
              clientId,
              error: error instanceof Error ? error.message : String(error),
            });
          });

        wsConnectionManager?.updateClientScopeKeys(
          clientId,
          applyPartitionToScopeKeys(
            partitionId,
            scopeValuesToScopeKeys(pullResult.effectiveScopes)
          )
        );

        const pullDurationMs = timer();

        logSyncEvent({
          event: 'sync.pull',
          userId: auth.actorId,
          durationMs: pullDurationMs,
          subscriptionCount: pullResult.response.subscriptions.length,
          clientCursor: pullResult.clientCursor,
        });

        recordRequestEventInBackground(() => {
          const pullRowCount = shouldRecordRequestEvents
            ? countPullRows(pullResult.response)
            : null;
          const scopesSummary = shouldRecordRequestEvents
            ? summarizeScopeValues(pullResult.effectiveScopes)
            : null;
          const payloadSnapshot = shouldRecordRequestEvents
            ? {
                request: {
                  clientId,
                  limitCommits: request.limitCommits,
                  limitSnapshotRows: request.limitSnapshotRows,
                  maxSnapshotPages: request.maxSnapshotPages,
                  dedupeRows: request.dedupeRows,
                  subscriptions: request.subscriptions.map((subscription) => ({
                    id: subscription.id,
                    table: subscription.table,
                    scopes: subscription.scopes,
                    cursor: subscription.cursor,
                    bootstrapState: subscription.bootstrapState,
                  })),
                },
                response: summarizePullResponse(pullResult.response),
              }
            : null;

          return {
            partitionId,
            requestId,
            traceId: traceContext.traceId,
            spanId: traceContext.spanId,
            eventType: 'pull',
            syncPath: 'http-combined',
            actorId: auth.actorId,
            clientId,
            transportPath: readTransportPath(c),
            statusCode: 200,
            outcome: 'applied',
            responseStatus: normalizeResponseStatus(200, 'applied'),
            durationMs: pullDurationMs,
            rowCount: pullRowCount,
            subscriptionCount: request.subscriptions.length,
            scopesSummary,
            payloadSnapshot,
          };
        });
        emitConsoleLiveEvent(consoleLiveEmitter, 'pull', () => {
          const pullRowCount = shouldEmitConsoleLiveEvents
            ? countPullRows(pullResult.response)
            : null;
          return {
            partitionId,
            requestId,
            traceId: traceContext.traceId,
            spanId: traceContext.spanId,
            actorId: auth.actorId,
            clientId,
            transportPath: readTransportPath(c),
            syncPath: 'http-combined',
            outcome: 'applied',
            statusCode: 200,
            durationMs: pullDurationMs,
            rowCount: pullRowCount,
            subscriptionCount: request.subscriptions.length,
            clientCursor: pullResult.clientCursor,
          };
        });

        pullResponse = pullResult.response;
      }

      return c.json(
        {
          ok: true as const,
          ...(pushResponse ? { push: pushResponse } : {}),
          ...(pullResponse ? { pull: pullResponse } : {}),
        },
        200
      );
    }
  );

  // -------------------------------------------------------------------------
  // GET /snapshot-chunks/:chunkId
  // -------------------------------------------------------------------------

  routes.get(
    '/snapshot-chunks/:chunkId',
    describeRoute({
      tags: ['sync'],
      summary: 'Download snapshot chunk',
      description: 'Download an encoded bootstrap snapshot chunk',
      responses: {
        200: {
          description: 'Snapshot chunk data (gzip-compressed framed JSON rows)',
          content: {
            'application/octet-stream': {
              schema: resolver(z.string()),
            },
          },
        },
        304: {
          description: 'Not modified (cached)',
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        403: {
          description: 'Forbidden',
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
    zValidator('param', snapshotChunkParamsSchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);
      const partitionId = auth.partitionId ?? 'default';

      const { chunkId } = c.req.valid('param');

      const chunk = await readSnapshotChunk(options.db, chunkId, {
        chunkStorage: options.chunkStorage,
      });
      if (!chunk) return c.json({ error: 'NOT_FOUND' }, 404);
      if (chunk.partitionId !== partitionId) {
        return c.json({ error: 'FORBIDDEN' }, 403);
      }

      const nowIso = new Date().toISOString();
      if (chunk.expiresAt <= nowIso) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }

      // Note: Snapshot chunks are created during authorized pull requests
      // and have opaque IDs that expire. Additional authorization is handled
      // at the pull layer via table-level resolveScopes.

      const etag = `"sha256:${chunk.sha256}"`;
      const ifNoneMatch = c.req.header('if-none-match');
      if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'private, max-age=0',
            Vary: 'Authorization',
          },
        });
      }

      return new Response(chunk.body as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'gzip',
          'Content-Length': String(chunk.byteLength),
          ETag: etag,
          'Cache-Control': 'private, max-age=0',
          Vary: 'Authorization',
          'X-Sync-Chunk-Id': chunk.chunkId,
          'X-Sync-Chunk-Sha256': chunk.sha256,
          'X-Sync-Chunk-Encoding': chunk.encoding,
          'X-Sync-Chunk-Compression': chunk.compression,
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /realtime (optional WebSocket wake-ups)
  // -------------------------------------------------------------------------

  if (wsConnectionManager && websocketConfig?.enabled) {
    routes.get('/realtime', async (c) => {
      const auth = await getAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);
      const partitionId = auth.partitionId ?? 'default';

      const clientId = c.req.query('clientId');
      if (!clientId || typeof clientId !== 'string') {
        return c.json(
          {
            error: 'INVALID_REQUEST',
            message: 'clientId query param is required',
          },
          400
        );
      }
      const realtimeTransportPath = readTransportPath(
        c,
        c.req.query('transportPath')
      );

      // Load last-known effective scopes for this client (best-effort).
      // Keeps /realtime lightweight and avoids sending large subscription payloads over the URL.
      let initialScopeKeys: string[] = [];
      try {
        const cursorsQ = options.db.selectFrom(
          'sync_client_cursors'
        ) as SelectQueryBuilder<
          DB,
          'sync_client_cursors',
          // biome-ignore lint/complexity/noBannedTypes: Kysely uses `{}` as the initial "no selected columns yet" marker.
          {}
        >;

        const row = await cursorsQ
          .selectAll()
          .where(sql<SqlBool>`partition_id = ${partitionId}`)
          .where(sql<SqlBool>`client_id = ${clientId}`)
          .executeTakeFirst();

        if (row && row.actor_id !== auth.actorId) {
          return c.json({ error: 'FORBIDDEN' }, 403);
        }

        const raw = row?.effective_scopes;
        let parsed: unknown = raw;
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
        }

        initialScopeKeys = applyPartitionToScopeKeys(
          partitionId,
          scopeValuesToScopeKeys(parsed)
        );
      } catch {
        // ignore; realtime is best-effort
      }

      const maxConnectionsTotal = websocketConfig.maxConnectionsTotal ?? 5000;
      const maxConnectionsPerClient =
        websocketConfig.maxConnectionsPerClient ?? 3;

      if (
        maxConnectionsTotal > 0 &&
        wsConnectionManager.getTotalConnections() >= maxConnectionsTotal
      ) {
        logSyncEvent({
          event: 'sync.realtime.rejected',
          userId: auth.actorId,
          reason: 'max_total',
        });
        return c.json({ error: 'WEBSOCKET_CONNECTION_LIMIT_TOTAL' }, 429);
      }

      if (
        maxConnectionsPerClient > 0 &&
        wsConnectionManager.getConnectionCount(clientId) >=
          maxConnectionsPerClient
      ) {
        logSyncEvent({
          event: 'sync.realtime.rejected',
          userId: auth.actorId,
          reason: 'max_per_client',
        });
        return c.json({ error: 'WEBSOCKET_CONNECTION_LIMIT_CLIENT' }, 429);
      }

      logSyncEvent({ event: 'sync.realtime.connect', userId: auth.actorId });

      let unregister: (() => void) | null = null;
      let connRef: ReturnType<typeof createWebSocketConnection> | null = null;
      const connectionCountBeforeUpgrade =
        wsConnectionManager.getConnectionCount(clientId);
      let sessionStartedAtMs: number | null = null;
      let sessionEnded = false;

      const finishRealtimeSession = (reason: 'closed' | 'error') => {
        if (sessionEnded) return;
        sessionEnded = true;
        if (sessionStartedAtMs === null) {
          return;
        }
        const durationMs = Math.max(0, Date.now() - sessionStartedAtMs);
        countSyncMetric('sync.sessions.ended', 1, {
          attributes: {
            transportPath: realtimeTransportPath,
            reason,
          },
        });
        distributionSyncMetric('sync.sessions.duration_ms', durationMs, {
          unit: 'millisecond',
          attributes: {
            transportPath: realtimeTransportPath,
            reason,
          },
        });
      };

      const upgradeWebSocket = websocketConfig.upgradeWebSocket;
      if (!upgradeWebSocket) {
        return c.json({ error: 'WEBSOCKET_NOT_CONFIGURED' }, 500);
      }

      return upgradeWebSocket(c, {
        onOpen(_evt, ws) {
          const conn = createWebSocketConnection(ws, {
            actorId: auth.actorId,
            clientId,
            transportPath: realtimeTransportPath,
          });
          connRef = conn;
          sessionStartedAtMs = Date.now();
          countSyncMetric('sync.sessions.started', 1, {
            attributes: {
              transportPath: realtimeTransportPath,
            },
          });
          if (connectionCountBeforeUpgrade > 0) {
            countSyncMetric('sync.transport.reconnects', 1, {
              attributes: {
                transportPath: realtimeTransportPath,
                source: 'server',
              },
            });
          }

          unregister = wsConnectionManager.register(conn, initialScopeKeys);
          conn.sendHeartbeat();
          emitConsoleLiveEvent(consoleLiveEmitter, 'client_update', () => ({
            action: 'realtime_connected',
            actorId: auth.actorId,
            clientId,
            partitionId,
            transportPath: realtimeTransportPath,
            scopeCount: initialScopeKeys.length,
          }));
        },
        onClose(_evt, _ws) {
          unregister?.();
          unregister = null;
          connRef = null;
          finishRealtimeSession('closed');
          logSyncEvent({
            event: 'sync.realtime.disconnect',
            userId: auth.actorId,
          });
          emitConsoleLiveEvent(consoleLiveEmitter, 'client_update', () => ({
            action: 'realtime_disconnected',
            actorId: auth.actorId,
            clientId,
            partitionId,
          }));
        },
        onError(_evt, _ws) {
          unregister?.();
          unregister = null;
          connRef = null;
          finishRealtimeSession('error');
          logSyncEvent({
            event: 'sync.realtime.disconnect',
            userId: auth.actorId,
          });
          emitConsoleLiveEvent(consoleLiveEmitter, 'client_update', () => ({
            action: 'realtime_error',
            actorId: auth.actorId,
            clientId,
            partitionId,
          }));
        },
        onMessage(evt, _ws) {
          if (!connRef) return;
          try {
            const raw =
              typeof evt.data === 'string' ? evt.data : String(evt.data);
            const msg = JSON.parse(raw);
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'push') {
              void handleWsPush(msg, connRef, auth, clientId);
              return;
            }

            if (msg.type !== 'presence' || !msg.scopeKey) return;

            const scopeKey = normalizeScopeKeyForPartition(
              partitionId,
              String(msg.scopeKey)
            );
            if (!scopeKey) return;

            switch (msg.action) {
              case 'join':
                if (
                  !wsConnectionManager.joinPresence(
                    clientId,
                    scopeKey,
                    msg.metadata
                  )
                ) {
                  logSyncEvent({
                    event: 'sync.realtime.presence.rejected',
                    userId: auth.actorId,
                    reason: 'scope_not_authorized',
                    scopeKey,
                  });
                  return;
                }
                // Send presence snapshot back to the joining client
                {
                  const entries = wsConnectionManager.getPresence(scopeKey);
                  connRef.sendPresence({
                    action: 'snapshot',
                    scopeKey,
                    entries,
                  });
                }
                break;
              case 'leave':
                wsConnectionManager.leavePresence(clientId, scopeKey);
                break;
              case 'update':
                if (
                  !wsConnectionManager.updatePresenceMetadata(
                    clientId,
                    scopeKey,
                    msg.metadata ?? {}
                  ) &&
                  !wsConnectionManager.isClientSubscribedToScopeKey(
                    clientId,
                    scopeKey
                  )
                ) {
                  logSyncEvent({
                    event: 'sync.realtime.presence.rejected',
                    userId: auth.actorId,
                    reason: 'scope_not_authorized',
                    scopeKey,
                  });
                }
                break;
            }
          } catch {
            // Ignore malformed messages
          }
        },
      });
    });
  }

  return routes;

  async function handleRealtimeEvent(event: SyncRealtimeEvent): Promise<void> {
    if (!wsConnectionManager) return;
    if (event.type !== 'commit') return;
    if (event.sourceInstanceId && event.sourceInstanceId === instanceId) return;

    const commitSeq = event.commitSeq;
    const partitionId = event.partitionId ?? 'default';
    const scopeKeys =
      event.scopeKeys && event.scopeKeys.length > 0
        ? event.scopeKeys
        : await readCommitScopeKeys(options.db, commitSeq, partitionId);

    if (scopeKeys.length === 0) return;
    wsConnectionManager.notifyScopeKeys(scopeKeys, commitSeq);
  }

  async function handleWsPush(
    msg: Record<string, unknown>,
    conn: WebSocketConnection,
    auth: Auth,
    clientId: string
  ): Promise<void> {
    const actorId = auth.actorId;
    const partitionId = auth.partitionId ?? 'default';
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    if (!requestId) return;
    const traceContext = readTraceContextFromMessage(msg);
    const timer = createSyncTimer();

    try {
      // Validate the push payload
      const parsed = SyncPushRequestSchema.omit({ clientId: true }).safeParse(
        msg
      );
      if (!parsed.success) {
        const invalidDurationMs = timer();
        conn.sendPushResponse({
          requestId,
          ok: false,
          status: 'rejected',
          results: [
            { opIndex: 0, status: 'error', error: 'Invalid push payload' },
          ],
        });
        recordRequestEventInBackground(() => ({
          partitionId,
          requestId,
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          eventType: 'push',
          syncPath: 'ws-push',
          actorId,
          clientId,
          transportPath: conn.transportPath,
          statusCode: 400,
          outcome: 'rejected',
          responseStatus: normalizeResponseStatus(400, 'rejected'),
          durationMs: invalidDurationMs,
          errorCode: 'INVALID_PUSH_PAYLOAD',
          errorMessage: 'Invalid push payload',
          payloadSnapshot: {
            request: msg,
            response: {
              ok: false,
              status: 'rejected',
              reason: 'invalid_push_payload',
            },
          },
        }));
        emitConsoleLiveEvent(consoleLiveEmitter, 'push', () => ({
          partitionId,
          requestId,
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          actorId,
          clientId,
          transportPath: conn.transportPath,
          syncPath: 'ws-push',
          outcome: 'rejected',
          statusCode: 400,
          durationMs: invalidDurationMs,
          errorCode: 'INVALID_PUSH_PAYLOAD',
        }));
        return;
      }

      const pushOps = parsed.data.operations ?? [];
      if (pushOps.length > maxOperationsPerPush) {
        const rejectedDurationMs = timer();
        conn.sendPushResponse({
          requestId,
          ok: false,
          status: 'rejected',
          results: [
            {
              opIndex: 0,
              status: 'error',
              error: `Maximum ${maxOperationsPerPush} operations per push`,
            },
          ],
        });
        recordRequestEventInBackground(() => ({
          partitionId,
          requestId,
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          eventType: 'push',
          syncPath: 'ws-push',
          actorId,
          clientId,
          transportPath: conn.transportPath,
          statusCode: 400,
          outcome: 'rejected',
          responseStatus: normalizeResponseStatus(400, 'rejected'),
          durationMs: rejectedDurationMs,
          errorCode: 'MAX_OPERATIONS_EXCEEDED',
          errorMessage: `Maximum ${maxOperationsPerPush} operations per push`,
          operationCount: pushOps.length,
          payloadSnapshot: {
            request: {
              clientId,
              clientCommitId: parsed.data.clientCommitId,
              schemaVersion: parsed.data.schemaVersion,
              operations: parsed.data.operations,
            },
            response: {
              ok: false,
              status: 'rejected',
              reason: 'max_operations_exceeded',
            },
          },
        }));
        emitConsoleLiveEvent(consoleLiveEmitter, 'push', () => ({
          partitionId,
          requestId,
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          actorId,
          clientId,
          transportPath: conn.transportPath,
          syncPath: 'ws-push',
          outcome: 'rejected',
          statusCode: 400,
          durationMs: rejectedDurationMs,
          operationCount: pushOps.length,
          errorCode: 'MAX_OPERATIONS_EXCEEDED',
        }));
        return;
      }

      const pushed = await pushCommit({
        db: options.db,
        dialect: options.dialect,
        handlers: handlerRegistry,
        auth,
        request: {
          clientId,
          clientCommitId: parsed.data.clientCommitId,
          operations: parsed.data.operations,
          schemaVersion: parsed.data.schemaVersion,
        },
      });

      const pushDurationMs = timer();

      logSyncEvent({
        event: 'sync.push',
        userId: actorId,
        durationMs: pushDurationMs,
        operationCount: pushOps.length,
        status: pushed.response.status,
        commitSeq: pushed.response.commitSeq,
      });

      recordRequestEventInBackground(() => ({
        partitionId,
        requestId,
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        eventType: 'push',
        syncPath: 'ws-push',
        actorId,
        clientId,
        transportPath: conn.transportPath,
        statusCode: 200,
        outcome: pushed.response.status,
        responseStatus: normalizeResponseStatus(200, pushed.response.status),
        durationMs: pushDurationMs,
        errorCode: firstPushErrorCode(pushed.response.results),
        commitSeq: pushed.response.commitSeq,
        operationCount: pushOps.length,
        tables: pushed.affectedTables,
        payloadSnapshot: {
          request: {
            clientId,
            clientCommitId: parsed.data.clientCommitId,
            schemaVersion: parsed.data.schemaVersion,
            operations: parsed.data.operations,
          },
          response: pushed.response,
        },
      }));
      emitConsoleLiveEvent(consoleLiveEmitter, 'push', () => ({
        partitionId,
        requestId,
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        actorId,
        clientId,
        transportPath: conn.transportPath,
        syncPath: 'ws-push',
        outcome: pushed.response.status,
        statusCode: 200,
        durationMs: pushDurationMs,
        commitSeq: pushed.response.commitSeq ?? null,
        operationCount: pushOps.length,
        tables: pushed.affectedTables,
      }));

      const detectedConflicts = pushed.response.results.reduce(
        (count, result) => count + (result.status === 'conflict' ? 1 : 0),
        0
      );
      if (detectedConflicts > 0) {
        countSyncMetric('sync.conflicts.detected', detectedConflicts, {
          attributes: {
            syncPath: 'ws-push',
            transportPath: conn.transportPath,
          },
        });
      }

      // WS notifications to other clients
      if (
        wsConnectionManager &&
        pushed.response.ok === true &&
        pushed.response.status === 'applied' &&
        typeof pushed.response.commitSeq === 'number'
      ) {
        const scopeKeys = applyPartitionToScopeKeys(
          partitionId,
          pushed.scopeKeys
        );
        if (scopeKeys.length > 0) {
          wsConnectionManager.notifyScopeKeys(
            scopeKeys,
            pushed.response.commitSeq,
            {
              excludeClientIds: [clientId],
              changes: pushed.emittedChanges,
            }
          );

          if (realtimeBroadcaster) {
            realtimeBroadcaster
              .publish({
                type: 'commit',
                commitSeq: pushed.response.commitSeq,
                partitionId,
                scopeKeys,
                sourceInstanceId: instanceId,
              })
              .catch((error) => {
                logAsyncFailureOnce('sync.realtime.broadcast_publish_failed', {
                  event: 'sync.realtime.broadcast_publish_failed',
                  userId: actorId,
                  clientId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
        }
      }

      if (
        pushed.response.ok === true &&
        pushed.response.status === 'applied' &&
        typeof pushed.response.commitSeq === 'number'
      ) {
        emitConsoleLiveEvent(consoleLiveEmitter, 'commit', () => ({
          partitionId,
          commitSeq: pushed.response.commitSeq,
          actorId,
          clientId,
          affectedTables: pushed.affectedTables,
        }));
      }

      conn.sendPushResponse({
        requestId,
        ok: pushed.response.ok,
        status: pushed.response.status,
        commitSeq: pushed.response.commitSeq,
        results: pushed.response.results,
      });
    } catch (err) {
      const failedDurationMs = timer();
      captureSyncException(err, {
        event: 'sync.realtime.push_failed',
        requestId,
        clientId,
        actorId,
        partitionId,
      });
      const message =
        err instanceof Error ? err.message : 'Internal server error';
      recordRequestEventInBackground(() => ({
        partitionId,
        requestId,
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        eventType: 'push',
        syncPath: 'ws-push',
        actorId,
        clientId,
        transportPath: conn.transportPath,
        statusCode: 500,
        outcome: 'error',
        responseStatus: normalizeResponseStatus(500, 'error'),
        durationMs: failedDurationMs,
        errorCode: 'INTERNAL_SERVER_ERROR',
        errorMessage: message,
        payloadSnapshot: {
          request: msg,
          response: {
            ok: false,
            status: 'rejected',
            reason: 'internal_server_error',
            message,
          },
        },
      }));
      emitConsoleLiveEvent(consoleLiveEmitter, 'push', () => ({
        partitionId,
        requestId,
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        actorId,
        clientId,
        transportPath: conn.transportPath,
        syncPath: 'ws-push',
        outcome: 'error',
        statusCode: 500,
        durationMs: failedDurationMs,
        errorCode: 'INTERNAL_SERVER_ERROR',
      }));
      conn.sendPushResponse({
        requestId,
        ok: false,
        status: 'rejected',
        results: [{ opIndex: 0, status: 'error', error: message }],
      });
    }
  }
}

export function getSyncWebSocketConnectionManager(
  routes: Hono
): WebSocketConnectionManager | undefined {
  return wsConnectionManagerMap.get(routes);
}

export function getSyncRealtimeUnsubscribe(
  routes: Hono
): (() => void) | undefined {
  return realtimeUnsubscribeMap.get(routes);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readTransportPath(
  c: Context,
  queryValue?: string | null
): 'direct' | 'relay' {
  if (queryValue === 'relay' || queryValue === 'direct') {
    return queryValue;
  }

  const headerValue = c.req.header('x-syncular-transport-path');
  if (headerValue === 'relay' || headerValue === 'direct') {
    return headerValue;
  }

  return 'direct';
}

function scopeValuesToScopeKeys(scopes: unknown): string[] {
  if (!scopes || typeof scopes !== 'object') return [];
  const scopeKeys = new Set<string>();

  for (const [key, value] of Object.entries(scopes)) {
    if (!value) continue;
    const prefix = key.replace(/_id$/, '');

    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v !== 'string') continue;
        if (!v) continue;
        scopeKeys.add(`${prefix}:${v}`);
      }
      continue;
    }

    if (typeof value === 'string') {
      if (!value) continue;
      scopeKeys.add(`${prefix}:${value}`);
      continue;
    }

    // Best-effort: stringify scalars.
    if (typeof value === 'number' || typeof value === 'bigint') {
      scopeKeys.add(`${prefix}:${String(value)}`);
    }
  }

  return Array.from(scopeKeys);
}

function partitionScopeKey(partitionId: string, scopeKey: string): string {
  return `${partitionId}::${scopeKey}`;
}

function applyPartitionToScopeKeys(
  partitionId: string,
  scopeKeys: readonly string[]
): string[] {
  const prefixed = new Set<string>();
  for (const scopeKey of scopeKeys) {
    if (!scopeKey) continue;
    if (scopeKey.startsWith(`${partitionId}::`)) {
      prefixed.add(scopeKey);
      continue;
    }
    prefixed.add(partitionScopeKey(partitionId, scopeKey));
  }
  return Array.from(prefixed);
}

function normalizeScopeKeyForPartition(
  partitionId: string,
  scopeKey: string
): string {
  if (scopeKey.startsWith(`${partitionId}::`)) return scopeKey;
  if (scopeKey.includes('::')) return '';
  return partitionScopeKey(partitionId, scopeKey);
}

async function readCommitScopeKeys<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  commitSeq: number,
  partitionId: string
): Promise<string[]> {
  // Read scopes from the JSONB column and convert to scope strings
  const rowsResult = await sql<{ scopes: unknown }>`
    select scopes
    from ${sql.table('sync_changes')}
    where commit_seq = ${commitSeq}
      and partition_id = ${partitionId}
  `.execute(db);
  const rows = rowsResult.rows;

  const scopeKeys = new Set<string>();

  for (const row of rows) {
    const scopes =
      typeof row.scopes === 'string' ? JSON.parse(row.scopes) : row.scopes;

    for (const k of applyPartitionToScopeKeys(
      partitionId,
      scopeValuesToScopeKeys(scopes)
    )) {
      scopeKeys.add(k);
    }
  }

  return Array.from(scopeKeys);
}
