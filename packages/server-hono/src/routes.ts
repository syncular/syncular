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
  createSyncTimer,
  ErrorResponseSchema,
  logSyncEvent,
  SyncCombinedRequestSchema,
  SyncCombinedResponseSchema,
  SyncPushRequestSchema,
} from '@syncular/core';
import type {
  ServerSyncDialect,
  ServerTableHandler,
  SnapshotChunkStorage,
  SyncCoreDb,
  SyncRealtimeBroadcaster,
  SyncRealtimeEvent,
} from '@syncular/server';
import {
  type CompactOptions,
  InvalidSubscriptionScopeError,
  type PruneOptions,
  type PullResult,
  pull,
  pushCommit,
  readSnapshotChunk,
  recordClientCursor,
  TableRegistry,
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

export interface SyncAuthResult {
  actorId: string;
  partitionId?: string;
}

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

export interface CreateSyncRoutesOptions<DB extends SyncCoreDb = SyncCoreDb> {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  handlers: ServerTableHandler<DB>[];
  authenticate: (c: Context) => Promise<SyncAuthResult | null>;
  sync?: SyncRoutesConfigWithRateLimit;
  wsConnectionManager?: WebSocketConnectionManager;
  /**
   * Optional snapshot chunk storage adapter.
   * When provided, stores snapshot chunk bodies in external storage
   * (S3, R2, etc.) instead of inline in the database.
   */
  chunkStorage?: SnapshotChunkStorage;
}

// ============================================================================
// Route Schemas
// ============================================================================

const snapshotChunkParamsSchema = z.object({
  chunkId: z.string().min(1),
});

export function createSyncRoutes<DB extends SyncCoreDb = SyncCoreDb>(
  options: CreateSyncRoutesOptions<DB>
): Hono {
  const routes = new Hono();
  routes.onError((error, c) => {
    captureSyncException(error, {
      event: 'sync.route.unhandled',
      method: c.req.method,
      path: c.req.path,
    });
    return c.text('Internal Server Error', 500);
  });
  const handlerRegistry = new TableRegistry<DB>();
  for (const handler of options.handlers) {
    handlerRegistry.register(handler);
  }
  const config = options.sync ?? {};
  const maxPullLimitCommits = config.maxPullLimitCommits ?? 100;
  const maxSubscriptionsPerPull = config.maxSubscriptionsPerPull ?? 200;
  const maxPullLimitSnapshotRows = config.maxPullLimitSnapshotRows ?? 5000;
  const maxPullMaxSnapshotPages = config.maxPullMaxSnapshotPages ?? 10;
  const maxOperationsPerPush = config.maxOperationsPerPush ?? 200;

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

  type RequestEvent = {
    eventType: 'push' | 'pull';
    actorId: string;
    clientId: string;
    transportPath: 'direct' | 'relay';
    statusCode: number;
    outcome: string;
    durationMs: number;
    commitSeq?: number | null;
    operationCount?: number | null;
    rowCount?: number | null;
    tables?: string[];
    errorMessage?: string | null;
  };

  const recordRequestEvent = async (event: RequestEvent) => {
    const tablesValue = options.dialect.arrayToDb(event.tables ?? []);
    await sql`
      INSERT INTO sync_request_events (
        event_type, actor_id, client_id, status_code, outcome,
        duration_ms, commit_seq, operation_count, row_count,
        tables, error_message, transport_path
      ) VALUES (
        ${event.eventType}, ${event.actorId}, ${event.clientId},
        ${event.statusCode}, ${event.outcome}, ${event.durationMs},
        ${event.commitSeq ?? null}, ${event.operationCount ?? null},
        ${event.rowCount ?? null}, ${tablesValue}, ${event.errorMessage ?? null},
        ${event.transportPath}
      )
    `.execute(options.db);
  };

  const recordRequestEventInBackground = (event: RequestEvent): void => {
    void recordRequestEvent(event).catch((error) => {
      logAsyncFailureOnce('sync.request_event_record_failed', {
        event: 'sync.request_event_record_failed',
        userId: event.actorId,
        clientId: event.clientId,
        requestEventType: event.eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const authCache = new WeakMap<Context, Promise<SyncAuthResult | null>>();
  const getAuth = (c: Context): Promise<SyncAuthResult | null> => {
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

      let pushResponse:
        | undefined
        | Awaited<ReturnType<typeof pushCommit>>['response'];
      let pullResponse: undefined | PullResult['response'];

      // --- Push phase ---
      if (body.push) {
        const pushOps = body.push.operations ?? [];
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
          actorId: auth.actorId,
          partitionId,
          request: {
            clientId,
            clientCommitId: body.push.clientCommitId,
            operations: body.push.operations,
            schemaVersion: body.push.schemaVersion,
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

        recordRequestEventInBackground({
          eventType: 'push',
          actorId: auth.actorId,
          clientId,
          transportPath: readTransportPath(c),
          statusCode: 200,
          outcome: pushed.response.status,
          durationMs: pushDurationMs,
          commitSeq: pushed.response.commitSeq,
          operationCount: pushOps.length,
          tables: pushed.affectedTables,
        });

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
            body.pull.maxSnapshotPages ?? 1,
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
            actorId: auth.actorId,
            partitionId,
            request,
            chunkStorage: options.chunkStorage,
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
        }).catch((error) => {
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

        recordRequestEventInBackground({
          eventType: 'pull',
          actorId: auth.actorId,
          clientId,
          transportPath: readTransportPath(c),
          statusCode: 200,
          outcome: 'applied',
          durationMs: pullDurationMs,
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

          unregister = wsConnectionManager.register(conn, initialScopeKeys);
          conn.sendHeartbeat();
        },
        onClose(_evt, _ws) {
          unregister?.();
          unregister = null;
          connRef = null;
          logSyncEvent({
            event: 'sync.realtime.disconnect',
            userId: auth.actorId,
          });
        },
        onError(_evt, _ws) {
          unregister?.();
          unregister = null;
          connRef = null;
          logSyncEvent({
            event: 'sync.realtime.disconnect',
            userId: auth.actorId,
          });
        },
        onMessage(evt, _ws) {
          if (!connRef) return;
          try {
            const raw =
              typeof evt.data === 'string' ? evt.data : String(evt.data);
            const msg = JSON.parse(raw);
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'push') {
              void handleWsPush(
                msg,
                connRef,
                auth.actorId,
                partitionId,
                clientId
              );
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
    actorId: string,
    partitionId: string,
    clientId: string
  ): Promise<void> {
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    if (!requestId) return;

    try {
      // Validate the push payload
      const parsed = SyncPushRequestSchema.omit({ clientId: true }).safeParse(
        msg
      );
      if (!parsed.success) {
        conn.sendPushResponse({
          requestId,
          ok: false,
          status: 'rejected',
          results: [
            { opIndex: 0, status: 'error', error: 'Invalid push payload' },
          ],
        });
        return;
      }

      const pushOps = parsed.data.operations ?? [];
      if (pushOps.length > maxOperationsPerPush) {
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
        return;
      }

      const timer = createSyncTimer();

      const pushed = await pushCommit({
        db: options.db,
        dialect: options.dialect,
        handlers: handlerRegistry,
        actorId,
        partitionId,
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

      recordRequestEventInBackground({
        eventType: 'push',
        actorId,
        clientId,
        transportPath: conn.transportPath,
        statusCode: 200,
        outcome: pushed.response.status,
        durationMs: pushDurationMs,
        commitSeq: pushed.response.commitSeq,
        operationCount: pushOps.length,
        tables: pushed.affectedTables,
      });

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

      conn.sendPushResponse({
        requestId,
        ok: pushed.response.ok,
        status: pushed.response.status,
        commitSeq: pushed.response.commitSeq,
        results: pushed.response.results,
      });
    } catch (err) {
      captureSyncException(err, {
        event: 'sync.realtime.push_failed',
        requestId,
        clientId,
        actorId,
        partitionId,
      });
      const message =
        err instanceof Error ? err.message : 'Internal server error';
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
