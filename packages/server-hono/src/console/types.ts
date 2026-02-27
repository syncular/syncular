import type {
  ServerSyncDialect,
  ServerTableHandler,
  SqlFamily,
  SyncCoreDb,
  SyncServerAuth,
} from '@syncular/server';
import type { Context } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Kysely } from 'kysely';
import type { WebSocketConnectionManager } from '../ws';
import type { LiveEvent } from './schemas';

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
  /**
   * Replay recent events, optionally constrained by timestamp, partition, and max count.
   */
  replay(options?: {
    since?: string;
    limit?: number;
    partitionId?: string;
  }): LiveEvent[];
}

export interface ConsoleMetricsOptions {
  /**
   * Metrics query strategy for timeseries/latency endpoints.
   * - raw: in-memory processing from raw event rows
   * - aggregated: DB-level aggregation where supported (raw fallback for unsupported paths)
   * - auto: use raw for small windows, aggregated for larger windows
   */
  aggregationMode?: 'auto' | 'raw' | 'aggregated';
  /** Max events for using raw mode when aggregationMode is 'auto'. */
  rawFallbackMaxEvents?: number;
}

export interface ConsoleMaintenanceOptions {
  /**
   * Minimum interval between automatic event-prune runs.
   * Set to 0 to disable automatic pruning.
   * Default: 5 minutes.
   */
  autoPruneIntervalMs?: number;
  /**
   * Max age for request events before pruning.
   * Set to 0 to disable age-based pruning.
   * Default: 7 days.
   */
  requestEventsMaxAgeMs?: number;
  /**
   * Max number of request events to retain.
   * Set to 0 to disable count-based pruning.
   * Default: 10000.
   */
  requestEventsMaxRows?: number;
  /**
   * Max age for operation audit events before pruning.
   * Set to 0 to disable age-based pruning.
   * Default: 30 days.
   */
  operationEventsMaxAgeMs?: number;
  /**
   * Max number of operation audit events to retain.
   * Set to 0 to disable count-based pruning.
   * Default: 5000.
   */
  operationEventsMaxRows?: number;
}

export interface ConsoleBlobObject {
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
}

export interface ConsoleBlobGetResult {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
}

export interface ConsoleBlobHeadResult {
  size: number;
  httpMetadata?: { contentType?: string };
}

export interface ConsoleBlobBucket {
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: ConsoleBlobObject[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<ConsoleBlobGetResult | null>;
  delete(key: string | string[]): Promise<void>;
  head(key: string): Promise<ConsoleBlobHeadResult | null>;
}

export interface ConsoleSharedOptions {
  /**
   * CORS origins to allow. Defaults to ['http://localhost:5173', 'https://console.sync.dev'].
   * Set to '*' to allow all origins (not recommended for production).
   */
  corsOrigins?: string[] | '*';
  metrics?: ConsoleMetricsOptions;
  maintenance?: ConsoleMaintenanceOptions;
  blobBucket?: ConsoleBlobBucket;
}

export interface CreateConsoleRoutesOptions<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
  F extends SqlFamily = SqlFamily,
> extends ConsoleSharedOptions {
  db: Kysely<DB>;
  dialect: ServerSyncDialect<F>;
  handlers: ServerTableHandler<DB, Auth>[];
  /**
   * Authentication function for console requests.
   * Return null to reject the request.
   */
  authenticate: (c: Context) => Promise<ConsoleAuthResult | null>;
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
  /**
   * Optional console schema readiness promise.
   * When provided, routes wait for this promise before querying console tables.
   */
  consoleSchemaReady?: Promise<void>;
}
