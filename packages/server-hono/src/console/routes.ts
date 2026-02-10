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
import type {
  ServerSyncDialect,
  ServerTableHandler,
  SyncCoreDb,
} from '@syncular/server';
import {
  compactChanges,
  computePruneWatermarkCommitSeq,
  pruneSync,
  readSyncStats,
} from '@syncular/server';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { UpgradeWebSocket } from 'hono/ws';
import { describeRoute, resolver, validator as zValidator } from 'hono-openapi';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { WebSocketConnectionManager } from '../ws';
import {
  type ApiKeyType,
  ApiKeyTypeSchema,
  type ConsoleApiKey,
  ConsoleApiKeyCreateRequestSchema,
  type ConsoleApiKeyCreateResponse,
  ConsoleApiKeyCreateResponseSchema,
  ConsoleApiKeyRevokeResponseSchema,
  ConsoleApiKeySchema,
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
  type ConsolePaginatedResponse,
  ConsolePaginatedResponseSchema,
  ConsolePaginationQuerySchema,
  type ConsolePruneEventsResult,
  ConsolePruneEventsResultSchema,
  type ConsolePrunePreview,
  ConsolePrunePreviewSchema,
  type ConsolePruneResult,
  ConsolePruneResultSchema,
  type ConsoleRequestEvent,
  ConsoleRequestEventSchema,
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

export interface ConsoleAuthResult {
  /** Identifier for the console user (for audit logging). */
  consoleUserId?: string;
}

/**
 * Listener for console live events (SSE streaming).
 */
export type ConsoleEventListener = (event: LiveEvent) => void;

/**
 * Console event emitter for broadcasting live events.
 */
export interface ConsoleEventEmitter {
  /** Add a listener for live events */
  addListener(listener: ConsoleEventListener): void;
  /** Remove a listener */
  removeListener(listener: ConsoleEventListener): void;
  /** Emit an event to all listeners */
  emit(event: LiveEvent): void;
}

/**
 * Create a simple console event emitter for broadcasting live events.
 */
export function createConsoleEventEmitter(): ConsoleEventEmitter {
  const listeners = new Set<ConsoleEventListener>();

  return {
    addListener(listener: ConsoleEventListener) {
      listeners.add(listener);
    },
    removeListener(listener: ConsoleEventListener) {
      listeners.delete(listener);
    },
    emit(event: LiveEvent) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Ignore errors in listeners
        }
      }
    },
  };
}

export interface CreateConsoleRoutesOptions<
  DB extends SyncCoreDb = SyncCoreDb,
> {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  handlers: ServerTableHandler<DB>[];
  /**
   * Authentication function for console requests.
   * Return null to reject the request.
   */
  authenticate: (c: Context) => Promise<ConsoleAuthResult | null>;
  /**
   * CORS origins to allow. Defaults to ['http://localhost:5173', 'https://console.sync.dev'].
   * Set to '*' to allow all origins (not recommended for production).
   */
  corsOrigins?: string[] | '*';
  /**
   * Compaction options (required for /compact endpoint).
   */
  compact?: {
    fullHistoryHours?: number;
  };
  /**
   * Pruning options.
   */
  prune?: {
    activeWindowMs?: number;
    fallbackMaxAgeMs?: number;
    keepNewestCommits?: number;
  };
  /**
   * Event emitter for live console events.
   * If provided along with websocket config, enables the /events/live WebSocket endpoint.
   */
  eventEmitter?: ConsoleEventEmitter;
  /**
   * Shared sync WebSocket connection manager.
   * When provided, `/clients` includes realtime connection state per client.
   */
  wsConnectionManager?: WebSocketConnectionManager;
  /**
   * WebSocket configuration for live events streaming.
   */
  websocket?: {
    enabled?: boolean;
    /**
     * Runtime-provided WebSocket upgrader (e.g. from `hono/bun`'s `createBunWebSocket()`).
     */
    upgradeWebSocket?: UpgradeWebSocket;
    /**
     * Heartbeat interval in milliseconds. Default: 30000
     */
    heartbeatIntervalMs?: number;
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

const eventsQuerySchema = ConsolePaginationQuerySchema.extend({
  eventType: z.enum(['push', 'pull']).optional(),
  actorId: z.string().optional(),
  clientId: z.string().optional(),
  outcome: z.string().optional(),
});

const apiKeysQuerySchema = ConsolePaginationQuerySchema.extend({
  type: ApiKeyTypeSchema.optional(),
});

const handlersResponseSchema = z.object({
  items: z.array(ConsoleHandlerSchema),
});

export function createConsoleRoutes<DB extends SyncCoreDb>(
  options: CreateConsoleRoutesOptions<DB>
): Hono {
  const routes = new Hono();

  interface SyncRequestEventsTable {
    event_id: number;
    event_type: string;
    transport_path: string;
    actor_id: string;
    client_id: string;
    status_code: number;
    outcome: string;
    duration_ms: number;
    commit_seq: number | null;
    operation_count: number | null;
    row_count: number | null;
    tables: unknown;
    error_message: string | null;
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

  interface ConsoleDb extends SyncCoreDb {
    sync_request_events: SyncRequestEventsTable;
    sync_api_keys: SyncApiKeysTable;
  }

  const db = options.db as Pick<
    Kysely<ConsoleDb>,
    'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
  >;

  // Ensure console schema exists (creates sync_request_events table if needed)
  // Run asynchronously - will be ready before first request typically
  options.dialect.ensureConsoleSchema?.(options.db).catch((err) => {
    console.error('[console] Failed to ensure console schema:', err);
  });

  // CORS configuration
  const corsOrigins = options.corsOrigins ?? [
    'http://localhost:5173',
    'https://console.sync.dev',
  ];

  routes.use(
    '*',
    cors({
      origin: corsOrigins === '*' ? '*' : corsOrigins,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['X-Total-Count'],
      credentials: true,
    })
  );

  // Auth middleware
  const requireAuth = async (c: Context): Promise<ConsoleAuthResult | null> => {
    const auth = await options.authenticate(c);
    if (!auth) {
      return null;
    }
    return auth;
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
    async (c) => {
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const stats: SyncStats = await readSyncStats(options.db);

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

      const { interval, range } = c.req.valid('query');

      // Calculate the time range
      const rangeMs = {
        '1h': 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
      }[range];

      const startTime = new Date(Date.now() - rangeMs);

      // Get interval in milliseconds for bucket size
      const intervalMs = {
        minute: 60 * 1000,
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
      }[interval];

      // Query events within the time range
      const events = await db
        .selectFrom('sync_request_events')
        .select(['event_type', 'duration_ms', 'outcome', 'created_at'])
        .where('created_at', '>=', startTime.toISOString())
        .orderBy('created_at', 'asc')
        .execute();

      // Build buckets
      const bucketMap = new Map<
        string,
        {
          pushCount: number;
          pullCount: number;
          errorCount: number;
          totalLatency: number;
          eventCount: number;
        }
      >();

      // Initialize buckets for the entire range
      const bucketCount = Math.ceil(rangeMs / intervalMs);
      for (let i = 0; i < bucketCount; i++) {
        const bucketTime = new Date(
          startTime.getTime() + i * intervalMs
        ).toISOString();
        bucketMap.set(bucketTime, {
          pushCount: 0,
          pullCount: 0,
          errorCount: 0,
          totalLatency: 0,
          eventCount: 0,
        });
      }

      // Populate buckets with event data
      for (const event of events) {
        const eventTime = new Date(event.created_at as string).getTime();
        const bucketIndex = Math.floor(
          (eventTime - startTime.getTime()) / intervalMs
        );
        const bucketTime = new Date(
          startTime.getTime() + bucketIndex * intervalMs
        ).toISOString();

        let bucket = bucketMap.get(bucketTime);
        if (!bucket) {
          bucket = {
            pushCount: 0,
            pullCount: 0,
            errorCount: 0,
            totalLatency: 0,
            eventCount: 0,
          };
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

      // Convert to array and calculate averages
      const buckets: TimeseriesBucket[] = Array.from(bucketMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([timestamp, data]) => ({
          timestamp,
          pushCount: data.pushCount,
          pullCount: data.pullCount,
          errorCount: data.errorCount,
          avgLatencyMs:
            data.eventCount > 0 ? data.totalLatency / data.eventCount : 0,
        }));

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

      const { range } = c.req.valid('query');

      // Calculate the time range
      const rangeMs = {
        '1h': 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
      }[range];

      const startTime = new Date(Date.now() - rangeMs);

      // Get all latencies for push and pull events
      const events = await db
        .selectFrom('sync_request_events')
        .select(['event_type', 'duration_ms'])
        .where('created_at', '>=', startTime.toISOString())
        .execute();

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

      // Calculate percentiles
      const calculatePercentiles = (
        latencies: number[]
      ): LatencyPercentiles => {
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
      };

      const response: LatencyStatsResponse = {
        push: calculatePercentiles(pushLatencies),
        pull: calculatePercentiles(pullLatencies),
        range,
      };

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
    zValidator('query', ConsolePaginationQuerySchema),
    async (c) => {
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const { limit, offset } = c.req.valid('query');

      const [rows, countRow] = await Promise.all([
        db
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
          .orderBy('commit_seq', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        db
          .selectFrom('sync_commits')
          .select(({ fn }) => fn.countAll().as('total'))
          .executeTakeFirst(),
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
    async (c) => {
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const { seq } = c.req.valid('param');

      const commitRow = await db
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
        .where('commit_seq', '=', seq)
        .executeTakeFirst();

      if (!commitRow) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }

      const changeRows = await db
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
        .where('commit_seq', '=', seq)
        .orderBy('change_id', 'asc')
        .execute();

      const changes: ConsoleChange[] = changeRows.map((row) => ({
        changeId: coerceNumber(row.change_id) ?? 0,
        table: row.table ?? '',
        rowId: row.row_id ?? '',
        op: row.op === 'delete' ? 'delete' : 'upsert',
        rowJson: row.row_json,
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
    zValidator('query', ConsolePaginationQuerySchema),
    async (c) => {
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const { limit, offset } = c.req.valid('query');

      const [rows, countRow, maxCommitSeqRow] = await Promise.all([
        db
          .selectFrom('sync_client_cursors')
          .select([
            'client_id',
            'actor_id',
            'cursor',
            'effective_scopes',
            'updated_at',
          ])
          .orderBy('updated_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        db
          .selectFrom('sync_client_cursors')
          .select(({ fn }) => fn.countAll().as('total'))
          .executeTakeFirst(),
        db
          .selectFrom('sync_commits')
          .select(({ fn }) => fn.max('commit_seq').as('max_commit_seq'))
          .executeTakeFirst(),
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
        const recentEventRows = await db
          .selectFrom('sync_request_events')
          .select([
            'client_id',
            'event_type',
            'outcome',
            'created_at',
            'transport_path',
          ])
          .where('client_id', 'in', pagedClientIds)
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

      const result: ConsoleCompactResult = { deletedChanges };
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
    async (c) => {
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const { id: clientId } = c.req.valid('param');

      const res = await db
        .deleteFrom('sync_client_cursors')
        .where('client_id', '=', clientId)
        .executeTakeFirst();

      const evicted = Number(res?.numDeletedRows ?? 0) > 0;

      logSyncEvent({
        event: 'console.evict_client',
        consoleUserId: auth.consoleUserId,
        clientId,
        evicted,
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

      const { limit, offset, eventType, actorId, clientId, outcome } =
        c.req.valid('query');

      let query = db
        .selectFrom('sync_request_events')
        .select([
          'event_id',
          'event_type',
          'transport_path',
          'actor_id',
          'client_id',
          'status_code',
          'outcome',
          'duration_ms',
          'commit_seq',
          'operation_count',
          'row_count',
          'tables',
          'error_message',
          'created_at',
        ]);

      let countQuery = db
        .selectFrom('sync_request_events')
        .select(({ fn }) => fn.countAll().as('total'));

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

      const items: ConsoleRequestEvent[] = rows.map((row) => ({
        eventId: coerceNumber(row.event_id) ?? 0,
        eventType: row.event_type as 'push' | 'pull',
        transportPath: row.transport_path === 'relay' ? 'relay' : 'direct',
        actorId: row.actor_id ?? '',
        clientId: row.client_id ?? '',
        statusCode: coerceNumber(row.status_code) ?? 0,
        outcome: row.outcome ?? '',
        durationMs: coerceNumber(row.duration_ms) ?? 0,
        commitSeq: coerceNumber(row.commit_seq),
        operationCount: coerceNumber(row.operation_count),
        rowCount: coerceNumber(row.row_count),
        tables: options.dialect.dbToArray(row.tables),
        errorMessage: row.error_message ?? null,
        createdAt: row.created_at ?? '',
      }));

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
        listener: ConsoleEventListener;
        heartbeatInterval: ReturnType<typeof setInterval>;
      }
    >();

    routes.get(
      '/events/live',
      upgradeWebSocket(async (c) => {
        // Auth check via query param (WebSocket doesn't support headers easily)
        const token = c.req.query('token');
        const authHeader = c.req.header('Authorization');
        const mockContext = {
          req: {
            header: (name: string) =>
              name === 'Authorization' ? authHeader : undefined,
            query: (name: string) => (name === 'token' ? token : undefined),
          },
        } as Context;

        const auth = await options.authenticate(mockContext);

        return {
          onOpen(_event, ws) {
            if (!auth) {
              ws.send(
                JSON.stringify({ type: 'error', message: 'UNAUTHENTICATED' })
              );
              ws.close(4001, 'Unauthenticated');
              return;
            }

            const listener: ConsoleEventListener = (event) => {
              try {
                ws.send(JSON.stringify(event));
              } catch {
                // Connection closed
              }
            };

            emitter.addListener(listener);

            // Send connected message
            ws.send(
              JSON.stringify({
                type: 'connected',
                timestamp: new Date().toISOString(),
              })
            );

            // Start heartbeat
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

            wsState.set(ws, { listener, heartbeatInterval });
          },
          onClose(_event, ws) {
            const state = wsState.get(ws);
            if (!state) return;
            emitter.removeListener(state.listener);
            clearInterval(state.heartbeatInterval);
            wsState.delete(ws);
          },
          onError(_event, ws) {
            const state = wsState.get(ws);
            if (!state) return;
            emitter.removeListener(state.listener);
            clearInterval(state.heartbeatInterval);
            wsState.delete(ws);
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
    async (c) => {
      const auth = await requireAuth(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const { id: eventId } = c.req.valid('param');

      const row = await db
        .selectFrom('sync_request_events')
        .select([
          'event_id',
          'event_type',
          'transport_path',
          'actor_id',
          'client_id',
          'status_code',
          'outcome',
          'duration_ms',
          'commit_seq',
          'operation_count',
          'row_count',
          'tables',
          'error_message',
          'created_at',
        ])
        .where('event_id', '=', eventId)
        .executeTakeFirst();

      if (!row) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }

      const event: ConsoleRequestEvent = {
        eventId: coerceNumber(row.event_id) ?? 0,
        eventType: row.event_type as 'push' | 'pull',
        transportPath: row.transport_path === 'relay' ? 'relay' : 'direct',
        actorId: row.actor_id ?? '',
        clientId: row.client_id ?? '',
        statusCode: coerceNumber(row.status_code) ?? 0,
        outcome: row.outcome ?? '',
        durationMs: coerceNumber(row.duration_ms) ?? 0,
        commitSeq: coerceNumber(row.commit_seq),
        operationCount: coerceNumber(row.operation_count),
        rowCount: coerceNumber(row.row_count),
        tables: options.dialect.dbToArray(row.tables),
        errorMessage: row.error_message ?? null,
        createdAt: row.created_at ?? '',
      };

      return c.json(event, 200);
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

      logSyncEvent({
        event: 'console.clear_events',
        consoleUserId: auth.consoleUserId,
        deletedCount,
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

      // Prune events older than 7 days or keep max 10000 events
      const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Delete by date first
      const resByDate = await db
        .deleteFrom('sync_request_events')
        .where('created_at', '<', cutoffDate.toISOString())
        .executeTakeFirst();

      let deletedCount = Number(resByDate?.numDeletedRows ?? 0);

      // Then delete oldest if we still have more than 10000 events
      const countRow = await db
        .selectFrom('sync_request_events')
        .select(({ fn }) => fn.countAll().as('total'))
        .executeTakeFirst();

      const total = coerceNumber(countRow?.total) ?? 0;
      const maxEvents = 10000;

      if (total > maxEvents) {
        // Find event_id cutoff to keep only newest maxEvents
        const cutoffRow = await db
          .selectFrom('sync_request_events')
          .select(['event_id'])
          .orderBy('event_id', 'desc')
          .offset(maxEvents)
          .limit(1)
          .executeTakeFirst();

        if (cutoffRow) {
          const cutoffEventId = coerceNumber(cutoffRow.event_id);
          if (cutoffEventId !== null) {
            const resByCount = await db
              .deleteFrom('sync_request_events')
              .where('event_id', '<=', cutoffEventId)
              .executeTakeFirst();

            deletedCount += Number(resByCount?.numDeletedRows ?? 0);
          }
        }
      }

      logSyncEvent({
        event: 'console.prune_events',
        consoleUserId: auth.consoleUserId,
        deletedCount,
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

      const { limit, offset, type: keyType } = c.req.valid('query');

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
  const expectedToken = token ?? process.env.SYNC_CONSOLE_TOKEN;

  return async (c: Context) => {
    if (!expectedToken) {
      // No token configured, allow all requests (not recommended for production)
      return { consoleUserId: 'anonymous' };
    }

    // Check Authorization header
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7);
      if (bearerToken === expectedToken) {
        return { consoleUserId: 'token' };
      }
    }

    // Check query parameter
    const queryToken = c.req.query('token');
    if (queryToken === expectedToken) {
      return { consoleUserId: 'token' };
    }

    return null;
  };
}
