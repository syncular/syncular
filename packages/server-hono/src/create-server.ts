/**
 * Simplified server factory for Hono
 *
 * Breaking changes from legacy createSyncRoutes:
 * - sync contract instead of top-level handlers/authenticate
 * - Combined sync + console routes in one call
 */

import type {
  ServerSyncConfig,
  ServerSyncDialect,
  SnapshotChunkStorage,
  SqlFamily,
  SyncCoreDb,
} from '@syncular/server';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Kysely } from 'kysely';
import {
  createConsoleEventEmitter,
  createConsoleRoutes,
  createTokenAuthenticator,
} from './console/routes';
import type {
  ConsoleEventEmitter,
  ConsoleSharedOptions,
} from './console/types';
import {
  createSyncRoutes,
  getSyncWebSocketConnectionManager,
  type SyncAuthResult,
  type SyncRoutesConfigWithRateLimit,
} from './routes';

export interface SyncServerOptions<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
> {
  /** Kysely database instance */
  db: Kysely<DB>;

  /** Server sync dialect */
  dialect: ServerSyncDialect<F>;

  /** Sync contract with auth + table handlers */
  sync: ServerSyncConfig<DB, Auth>;

  /** Snapshot chunk storage (external body storage, e.g. R2/S3) */
  chunkStorage?: SnapshotChunkStorage;

  /** Sync route configuration */
  routes?: SyncRoutesConfigWithRateLimit;

  /** WebSocket upgrader for realtime */
  upgradeWebSocket?: UpgradeWebSocket;

  /**
   * Console configuration for dashboard/monitoring.
   * Omit or set to false to disable console routes.
   */
  console?:
    | false
    | ({
        /** Console bearer token for authentication (required unless SYNC_CONSOLE_TOKEN is set) */
        token?: string;
      } & ConsoleSharedOptions);
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
 * // With sync contract
 * const { syncRoutes } = createSyncServer({
 *   db,
 *   dialect,
 *   sync,
 * });
 *
 * // With custom handlers
 * const { syncRoutes, consoleRoutes } = createSyncServer({
 *   db,
 *   dialect,
 *   sync,
 *   console: { token: process.env.CONSOLE_TOKEN },
 * });
 * ```
 */
export function createSyncServer<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(options: SyncServerOptions<DB, Auth, F>): SyncServerResult {
  const {
    db,
    dialect,
    sync,
    chunkStorage,
    routes,
    upgradeWebSocket,
    console: consoleConfig,
  } = options;

  if (sync.handlers.length === 0) {
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
    handlers: sync.handlers,
    authenticate: async (context): Promise<Auth | null> =>
      sync.authenticate(context.req.raw),
    chunkStorage,
    consoleLiveEmitter: consoleEventEmitter,
    sync: {
      ...routes,
      websocket: upgradeWebSocket
        ? {
            enabled: true,
            upgradeWebSocket,
            ...(routes?.websocket?.heartbeatIntervalMs !== undefined && {
              heartbeatIntervalMs: routes.websocket.heartbeatIntervalMs,
            }),
            ...(routes?.websocket?.maxConnectionsTotal !== undefined && {
              maxConnectionsTotal: routes.websocket.maxConnectionsTotal,
            }),
            ...(routes?.websocket?.maxConnectionsPerClient !== undefined && {
              maxConnectionsPerClient: routes.websocket.maxConnectionsPerClient,
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
    handlers: sync.handlers,
    authenticate: createTokenAuthenticator(consoleToken),
    corsOrigins: resolvedConsoleConfig.corsOrigins ?? '*',
    eventEmitter: consoleEventEmitter,
    wsConnectionManager: getSyncWebSocketConnectionManager(syncRoutes),
    metrics: resolvedConsoleConfig.metrics,
    blobBucket: resolvedConsoleConfig.blobBucket,
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
