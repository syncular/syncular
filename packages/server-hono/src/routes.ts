/**
 * @syncular/server-hono - Sync routes for Hono
 *
 * Provides:
 * - POST /pull  (commit stream + optional bootstrap snapshots)
 * - POST /push  (commit ingestion)
 * - GET  /snapshot-chunks/:chunkId (download encoded snapshot chunks)
 * - GET  /realtime (optional WebSocket "wake up" notifications)
 */

import {
  createSyncTimer,
  ErrorResponseSchema,
  logSyncEvent,
  SyncPullRequestSchema,
  SyncPullResponseSchema,
  SyncPushRequestSchema,
  SyncPushResponseSchema,
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
  maybeCompactChanges,
  maybePruneSync,
  type PruneOptions,
  type PullResult,
  pull,
  pushCommit,
  readSnapshotChunk,
  recordClientCursor,
  TableRegistry,
} from '@syncular/server';
import type { Context } from 'hono';
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
import { createWebSocketConnection, WebSocketConnectionManager } from './ws';

/**
 * WeakMaps for storing Hono-instance-specific data without augmenting the type.
 */
const wsConnectionManagerMap = new WeakMap<Hono, WebSocketConnectionManager>();
const realtimeUnsubscribeMap = new WeakMap<Hono, () => void>();

export interface SyncAuthResult {
  actorId: string;
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

  if (wsConnectionManager && realtimeBroadcaster) {
    const unsubscribe = realtimeBroadcaster.subscribe(
      (event: SyncRealtimeEvent) => {
        void handleRealtimeEvent(event).catch(() => {});
      }
    );

    realtimeUnsubscribeMap.set(routes, unsubscribe);
  }

  // -------------------------------------------------------------------------
  // Request event recording (for console inspector)
  // -------------------------------------------------------------------------

  const recordRequestEvent = async (event: {
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
  }) => {
    try {
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
    } catch {
      // Silently ignore - event recording should not block sync
    }
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
          const auth = await options.authenticate(c);
          return auth?.actorId ?? null;
        },
      });
    };

    const pullLimiter = createAuthBasedRateLimiter(pullRateLimit);
    if (pullLimiter) routes.use('/pull', pullLimiter);

    const pushLimiter = createAuthBasedRateLimiter(pushRateLimit);
    if (pushLimiter) routes.use('/push', pushLimiter);
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
  // POST /pull
  // -------------------------------------------------------------------------

  routes.post(
    '/pull',
    describeRoute({
      tags: ['sync'],
      summary: 'Pull commits and snapshots',
      description:
        'Pull commits and optional bootstrap snapshots for subscriptions',
      responses: {
        200: {
          description: 'Successful pull response',
          content: {
            'application/json': { schema: resolver(SyncPullResponseSchema) },
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
    zValidator('json', SyncPullRequestSchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const body = c.req.valid('json');

      const timer = createSyncTimer();

      if (body.subscriptions.length > maxSubscriptionsPerPull) {
        return c.json(
          {
            error: 'INVALID_REQUEST',
            message: `Too many subscriptions (max ${maxSubscriptionsPerPull})`,
          },
          400
        );
      }

      // Guardrail: unique subscription ids in a single request.
      const seenSubscriptionIds = new Set<string>();
      for (const sub of body.subscriptions) {
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
        clientId: body.clientId,
        limitCommits: clampInt(body.limitCommits ?? 50, 1, maxPullLimitCommits),
        limitSnapshotRows: clampInt(
          body.limitSnapshotRows ?? 1000,
          1,
          maxPullLimitSnapshotRows
        ),
        maxSnapshotPages: clampInt(
          body.maxSnapshotPages ?? 1,
          1,
          maxPullMaxSnapshotPages
        ),
        dedupeRows: body.dedupeRows === true,
        subscriptions: body.subscriptions.map((sub) => ({
          id: sub.id,
          shape: sub.shape,
          scopes: (sub.scopes ?? {}) as Record<string, string | string[]>,
          params: sub.params as Record<string, unknown>,
          cursor: Math.max(-1, sub.cursor),
          bootstrapState: sub.bootstrapState ?? null,
        })),
      };

      let pullResult: PullResult;
      try {
        pullResult = await pull({
          db: options.db,
          dialect: options.dialect,
          shapes: handlerRegistry,
          actorId: auth.actorId,
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

      await recordClientCursor(options.db, options.dialect, {
        clientId: request.clientId,
        actorId: auth.actorId,
        cursor: pullResult.clientCursor,
        effectiveScopes: pullResult.effectiveScopes,
      });

      // Update WebSocket manager with effective scopes for this client.
      // Realtime wake-ups are best-effort; correctness always comes from pull+cursors.
      wsConnectionManager?.updateClientScopeKeys(
        request.clientId,
        scopeValuesToScopeKeys(pullResult.effectiveScopes)
      );

      const pruneCfg = config.prune;
      if (pruneCfg) {
        const deletedCommits = await maybePruneSync(options.db, {
          minIntervalMs: pruneCfg.minIntervalMs ?? 5 * 60 * 1000,
          options: pruneCfg.options,
        });
        if (deletedCommits > 0) {
          logSyncEvent({
            event: 'sync.prune',
            userId: auth.actorId,
            deletedCommits,
          });
        }
      }

      const compactCfg = config.compact;
      if (compactCfg) {
        const deletedChanges = await maybeCompactChanges(options.db, {
          dialect: options.dialect,
          minIntervalMs: compactCfg.minIntervalMs ?? 30 * 60 * 1000,
          options: {
            fullHistoryHours: compactCfg.options?.fullHistoryHours ?? 24 * 7,
          },
        });
        if (deletedChanges > 0) {
          logSyncEvent({
            event: 'sync.compact',
            userId: auth.actorId,
            deletedChanges,
          });
        }
      }

      const rowCount = pullResult.response.subscriptions.reduce(
        (sum: number, s) => {
          if (s.bootstrap) {
            return (
              sum +
              (s.snapshots ?? []).reduce(
                (ss: number, snap) => ss + (snap.rows?.length ?? 0),
                0
              )
            );
          }
          return (
            sum +
            s.commits.reduce(
              (cs: number, commit) => cs + commit.changes.length,
              0
            )
          );
        },
        0
      );

      const bootstrapCount = pullResult.response.subscriptions.filter(
        (s) => s.bootstrap
      ).length;
      const activeCount = pullResult.response.subscriptions.filter(
        (s) => s.status === 'active'
      ).length;

      const pullDurationMs = timer();

      logSyncEvent({
        event: 'sync.pull',
        userId: auth.actorId,
        durationMs: pullDurationMs,
        rowCount,
        subscriptionCount: pullResult.response.subscriptions.length,
        activeSubscriptionCount: activeCount,
        bootstrapCount,
        effectiveTableCount: Object.keys(pullResult.effectiveScopes).length,
        clientCursor: pullResult.clientCursor,
      });

      // Record event for console inspector (non-blocking)
      recordRequestEvent({
        eventType: 'pull',
        actorId: auth.actorId,
        clientId: request.clientId,
        transportPath: readTransportPath(c),
        statusCode: 200,
        outcome:
          bootstrapCount > 0 ? 'applied' : rowCount > 0 ? 'applied' : 'cached',
        durationMs: pullDurationMs,
        rowCount,
        tables: Object.keys(pullResult.effectiveScopes),
      });

      return c.json(pullResult.response, 200);
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
          description: 'Snapshot chunk data (gzip-compressed NDJSON)',
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
      const auth = await options.authenticate(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const { chunkId } = c.req.valid('param');

      const chunk = await readSnapshotChunk(options.db, chunkId, {
        chunkStorage: options.chunkStorage,
      });
      if (!chunk) return c.json({ error: 'NOT_FOUND' }, 404);

      const nowIso = new Date().toISOString();
      if (chunk.expiresAt <= nowIso) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }

      // Note: Snapshot chunks are created during authorized pull requests
      // and have opaque IDs that expire. Additional authorization is handled
      // at the pull layer via shape-level resolveScopes.

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
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': String(chunk.body.length),
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
  // POST /push
  // -------------------------------------------------------------------------

  routes.post(
    '/push',
    describeRoute({
      tags: ['sync'],
      summary: 'Push a commit',
      description: 'Push a client commit with operations to the server',
      responses: {
        200: {
          description: 'Successful push response',
          content: {
            'application/json': { schema: resolver(SyncPushResponseSchema) },
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
    zValidator('json', SyncPushRequestSchema),
    async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const body = c.req.valid('json');

      if (body.operations.length > maxOperationsPerPush) {
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
        shapes: handlerRegistry,
        actorId: auth.actorId,
        request: body,
      });

      const pushDurationMs = timer();

      logSyncEvent({
        event: 'sync.push',
        userId: auth.actorId,
        durationMs: pushDurationMs,
        operationCount: body.operations.length,
        status: pushed.response.status,
        commitSeq: pushed.response.commitSeq,
      });

      // Record event for console inspector (non-blocking)
      recordRequestEvent({
        eventType: 'push',
        actorId: auth.actorId,
        clientId: body.clientId,
        transportPath: readTransportPath(c),
        statusCode: 200,
        outcome: pushed.response.status,
        durationMs: pushDurationMs,
        commitSeq: pushed.response.commitSeq,
        operationCount: body.operations.length,
        tables: pushed.affectedTables,
      });

      if (
        wsConnectionManager &&
        pushed.response.ok === true &&
        pushed.response.status === 'applied' &&
        typeof pushed.response.commitSeq === 'number'
      ) {
        const scopeKeys = await readCommitScopeKeys(
          options.db,
          pushed.response.commitSeq
        );

        if (scopeKeys.length > 0) {
          wsConnectionManager.notifyScopeKeys(
            scopeKeys,
            pushed.response.commitSeq,
            {
              excludeClientIds: [body.clientId],
            }
          );

          if (realtimeBroadcaster) {
            realtimeBroadcaster
              .publish({
                type: 'commit',
                commitSeq: pushed.response.commitSeq,
                scopeKeys,
                sourceInstanceId: instanceId,
              })
              .catch(() => {});
          }
        }
      }

      return c.json(pushed.response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /realtime (optional WebSocket wake-ups)
  // -------------------------------------------------------------------------

  if (wsConnectionManager && websocketConfig?.enabled) {
    routes.get('/realtime', async (c) => {
      const auth = await options.authenticate(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

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

        initialScopeKeys = scopeValuesToScopeKeys(parsed);
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
            if (
              !msg ||
              typeof msg !== 'object' ||
              msg.type !== 'presence' ||
              !msg.scopeKey
            )
              return;

            const scopeKey = String(msg.scopeKey);

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
    const scopeKeys =
      event.scopeKeys && event.scopeKeys.length > 0
        ? event.scopeKeys
        : await readCommitScopeKeys(options.db, commitSeq);

    if (scopeKeys.length === 0) return;
    wsConnectionManager.notifyScopeKeys(scopeKeys, commitSeq);
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

async function readCommitScopeKeys<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  commitSeq: number
): Promise<string[]> {
  // Read scopes from the JSONB column and convert to scope strings
  const rowsResult = await sql<{ scopes: unknown }>`
    select scopes
    from ${sql.table('sync_changes')}
    where commit_seq = ${commitSeq}
  `.execute(db);
  const rows = rowsResult.rows;

  const scopeKeys = new Set<string>();

  for (const row of rows) {
    const scopes =
      typeof row.scopes === 'string' ? JSON.parse(row.scopes) : row.scopes;

    for (const k of scopeValuesToScopeKeys(scopes)) {
      scopeKeys.add(k);
    }
  }

  return Array.from(scopeKeys);
}
