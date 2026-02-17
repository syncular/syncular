/**
 * Simplified server factory for Hono
 *
 * Breaking changes from legacy createSyncRoutes:
 * - handlers: array instead of TableRegistry
 * - Combined sync + console routes in one call
 */

import type {
  ServerSyncDialect,
  ServerTableHandler,
  SnapshotChunkStorage,
  SyncCoreDb,
} from '@syncular/server';
import type { Context } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Kysely } from 'kysely';
import {
  type ConsoleEventEmitter,
  createConsoleEventEmitter,
  createConsoleRoutes,
  createTokenAuthenticator,
} from './console';
import {
  createSyncRoutes,
  getSyncWebSocketConnectionManager,
  type SyncAuthResult,
  type SyncRoutesConfigWithRateLimit,
} from './routes';

export interface SyncServerOptions<DB extends SyncCoreDb = SyncCoreDb> {
  /** Kysely database instance */
  db: Kysely<DB>;

  /** Server sync dialect */
  dialect: ServerSyncDialect;

  /**
   * Table handlers for sync operations.
   */
  handlers: ServerTableHandler<DB>[];

  /** Authentication function - returns actorId or null for unauthenticated */
  authenticate: (c: Context) => Promise<SyncAuthResult | null>;

  /** Snapshot chunk storage (external body storage, e.g. R2/S3) */
  chunkStorage?: SnapshotChunkStorage;

  /** Sync route configuration */
  sync?: SyncRoutesConfigWithRateLimit;

  /** WebSocket upgrader for realtime */
  upgradeWebSocket?: UpgradeWebSocket;

  /**
   * Console configuration for dashboard/monitoring.
   * Omit or set to false to disable console routes.
   */
  console?:
    | false
    | {
        /** Console bearer token for authentication (required unless SYNC_CONSOLE_TOKEN is set) */
        token?: string;
        /** CORS origins (defaults to '*') */
        corsOrigins?: '*' | string[];
        /** Metrics aggregation strategy for console stats endpoints */
        metrics?: {
          aggregationMode?: 'auto' | 'raw' | 'aggregated';
          rawFallbackMaxEvents?: number;
        };
      };
}

export interface SyncServerResult {
  /** Sync routes for Hono */
  syncRoutes: ReturnType<typeof createSyncRoutes>;
  /** Console routes for Hono (if enabled) */
  consoleRoutes?: ReturnType<typeof createConsoleRoutes>;
  /** Console event emitter (if console enabled) */
  consoleEventEmitter?: ConsoleEventEmitter;
}

/**
 * Create a simplified sync server with sync and optional console routes.
 *
 * @example
 * ```typescript
 * // With handlers
 * const { syncRoutes } = createSyncServer({
 *   db,
 *   dialect,
 *   handlers: [tasksHandler, notesHandler],
 *   authenticate: async (c) => {
 *     const userId = c.req.header('x-user-id');
 *     return userId ? { actorId: userId } : null;
 *   },
 * });
 *
 * // With custom handlers
 * const { syncRoutes, consoleRoutes } = createSyncServer({
 *   db,
 *   dialect,
 *   handlers: [tasksHandler, notesHandler],
 *   authenticate: async (c) => {
 *     const userId = c.req.header('x-user-id');
 *     return userId ? { actorId: userId } : null;
 *   },
 *   console: { token: process.env.CONSOLE_TOKEN },
 * });
 * ```
 */
export function createSyncServer<DB extends SyncCoreDb = SyncCoreDb>(
  options: SyncServerOptions<DB>
): SyncServerResult {
  const {
    db,
    dialect,
    handlers,
    authenticate,
    chunkStorage,
    sync,
    upgradeWebSocket,
    console: consoleConfig,
  } = options;

  if (handlers.length === 0) {
    throw new Error('At least one handler must be provided');
  }

  const resolvedConsoleConfig =
    consoleConfig === false || consoleConfig === undefined
      ? undefined
      : consoleConfig;
  const isConsoleEnabled = Boolean(resolvedConsoleConfig);
  const consoleToken = isConsoleEnabled
    ? (resolvedConsoleConfig?.token ?? process.env.SYNC_CONSOLE_TOKEN)
    : undefined;

  if (isConsoleEnabled && !consoleToken) {
    throw new Error(
      'Console is enabled but no token is configured. Set `console.token` or SYNC_CONSOLE_TOKEN.'
    );
  }

  const consoleEventEmitter = isConsoleEnabled
    ? createConsoleEventEmitter()
    : undefined;

  // Create sync routes
  const syncRoutes = createSyncRoutes({
    db,
    dialect,
    handlers,
    authenticate,
    chunkStorage,
    consoleLiveEmitter: consoleEventEmitter,
    sync: {
      ...sync,
      websocket: upgradeWebSocket
        ? {
            enabled: true,
            upgradeWebSocket,
            ...(sync?.websocket?.heartbeatIntervalMs !== undefined && {
              heartbeatIntervalMs: sync.websocket.heartbeatIntervalMs,
            }),
            ...(sync?.websocket?.maxConnectionsTotal !== undefined && {
              maxConnectionsTotal: sync.websocket.maxConnectionsTotal,
            }),
            ...(sync?.websocket?.maxConnectionsPerClient !== undefined && {
              maxConnectionsPerClient: sync.websocket.maxConnectionsPerClient,
            }),
          }
        : { enabled: false },
    },
  });

  // Console is opt-in; disable unless explicitly configured.
  if (!resolvedConsoleConfig) {
    return { syncRoutes };
  }

  const consoleRoutes = createConsoleRoutes({
    db,
    dialect,
    handlers,
    authenticate: createTokenAuthenticator(consoleToken),
    corsOrigins: resolvedConsoleConfig.corsOrigins ?? '*',
    eventEmitter: consoleEventEmitter,
    wsConnectionManager: getSyncWebSocketConnectionManager(syncRoutes),
    metrics: resolvedConsoleConfig.metrics,
    ...(upgradeWebSocket && {
      websocket: {
        enabled: true,
        upgradeWebSocket,
      },
    }),
  });

  return {
    syncRoutes,
    consoleRoutes,
    consoleEventEmitter,
  };
}
