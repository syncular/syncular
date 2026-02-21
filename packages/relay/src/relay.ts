/**
 * @syncular/relay - Relay Server
 *
 * An edge relay server that acts as a local server to nearby clients
 * while simultaneously acting as a client to the main server.
 *
 * Enables offline-first architectures where local network devices
 * continue syncing when internet is lost.
 */

import type { ScopeValues, SyncTransport } from '@syncular/core';
import type {
  ServerHandlerCollection,
  ServerSyncDialect,
  SyncServerAuth,
} from '@syncular/server';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { ForwardEngine } from './client-role/forward-engine';
import { PullEngine } from './client-role/pull-engine';
import { SequenceMapper } from './client-role/sequence-mapper';
import { ensureRelaySchema } from './migrate';
import { ModeManager, type RelayMode } from './mode-manager';
import { RelayRealtime } from './realtime';
import type { ForwardConflictEntry, RelayDatabase } from './schema';

type RelayAuth = SyncServerAuth;

/**
 * Events emitted by the relay server.
 */
export interface RelayEvents {
  modeChange: (mode: RelayMode) => void;
  forwardConflict: (conflict: ForwardConflictEntry) => void;
  error: (error: Error) => void;
}

/**
 * Configuration options for creating a relay server.
 */
export interface RelayServerOptions<DB extends RelayDatabase = RelayDatabase> {
  /** Kysely database instance */
  db: Kysely<DB>;
  /** Server sync dialect (e.g., SQLite or Postgres) */
  dialect: ServerSyncDialect;
  /** Transport for communicating with the main server */
  mainServerTransport: SyncTransport;
  /** Client ID used when communicating with the main server */
  mainServerClientId: string;
  /** Actor ID used when communicating with the main server */
  mainServerActorId: string;
  /** Tables this relay subscribes to from the main server */
  tables: string[];
  /** Scope values for subscriptions to the main server */
  scopes: ScopeValues;
  /** Handler registry for handling operations */
  handlers: ServerHandlerCollection<DB, RelayAuth>;
  /** Optional: WebSocket heartbeat interval in milliseconds (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Optional: Forward engine retry interval in milliseconds (default: 5000) */
  forwardRetryIntervalMs?: number;
  /** Optional: Pull engine interval in milliseconds (default: 10000) */
  pullIntervalMs?: number;
  /** Optional: Health check interval in milliseconds (default: 30000) */
  healthCheckIntervalMs?: number;
  /** Optional: Prune interval in milliseconds (default: 3600000 = 1 hour). Set to 0 to disable. */
  pruneIntervalMs?: number;
  /** Optional: Maximum age of completed relay data before pruning (default: 604800000 = 7 days) */
  pruneMaxAgeMs?: number;
}

/**
 * Result of relay data pruning.
 */
export interface PruneRelayResult {
  deletedMappings: number;
  deletedOutbox: number;
  deletedConflicts: number;
}

type EventHandler<K extends keyof RelayEvents> = RelayEvents[K];

/**
 * Relay server that acts as an edge relay between local clients and a main server.
 *
 * @example
 * ```typescript
 * import { createRelayServer } from '@syncular/relay';
 * import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
 *
 * const relay = createRelayServer({
 *   db: sqliteDb,
 *   dialect: createSqliteServerDialect(),
 *   mainServerTransport: createHttpTransport({ baseUrl: 'https://main.example.com/sync' }),
 *   mainServerClientId: 'relay-branch-001',
 *   mainServerActorId: 'relay-service',
 *   tables: ['tasks', 'projects'],
 *   scopes: { project_id: 'acme' },
 *   handlers: shapeRegistry,
 * });
 *
 * // Mount routes for local clients
 * app.route('/sync', await relay.getRoutes());
 *
 * // Start background sync with main
 * await relay.start();
 *
 * // Events
 * relay.on('modeChange', (mode) => console.log(mode));
 * relay.on('forwardConflict', (conflict) => handleConflict(conflict));
 * ```
 */
export class RelayServer<DB extends RelayDatabase = RelayDatabase> {
  private readonly db: Kysely<DB>;
  private readonly dialect: ServerSyncDialect;
  private readonly mainServerTransport: SyncTransport;
  private readonly mainServerClientId: string;
  private readonly mainServerActorId: string;
  private readonly tables: string[];
  private readonly scopes: ScopeValues;
  private readonly handlers: ServerHandlerCollection<DB, RelayAuth>;

  private readonly modeManager: ModeManager;
  private readonly sequenceMapper: SequenceMapper<DB>;
  private readonly forwardEngine: ForwardEngine<DB>;
  private readonly pullEngine: PullEngine<DB>;
  private readonly realtime: RelayRealtime;

  private readonly eventHandlers = new Map<
    string,
    Set<(...args: never[]) => unknown>
  >();

  private readonly pruneIntervalMs: number;
  private readonly pruneMaxAgeMs: number;
  private lastPruneAtMs = 0;
  private pruneInFlight: Promise<PruneRelayResult> | null = null;

  private started = false;
  private schemaInitialized = false;
  private routes: Hono | null = null;
  private routesPromise: Promise<Hono> | null = null;

  constructor(options: RelayServerOptions<DB>) {
    this.db = options.db;
    this.dialect = options.dialect;
    this.mainServerTransport = options.mainServerTransport;
    this.mainServerClientId = options.mainServerClientId;
    this.mainServerActorId = options.mainServerActorId;
    this.tables = options.tables;
    this.scopes = options.scopes;
    this.handlers = options.handlers;

    this.pruneIntervalMs = options.pruneIntervalMs ?? 3600000;
    this.pruneMaxAgeMs = options.pruneMaxAgeMs ?? 7 * 24 * 60 * 60 * 1000;

    // Initialize mode manager
    this.modeManager = new ModeManager({
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? 30000,
      onModeChange: (mode) => this.emit('modeChange', mode),
    });

    // Initialize sequence mapper
    this.sequenceMapper = new SequenceMapper({
      db: this.db,
    });

    // Initialize realtime manager for local clients
    this.realtime = new RelayRealtime({
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30000,
    });

    // Initialize forward engine (forwards local commits to main)
    this.forwardEngine = new ForwardEngine({
      db: this.db,
      transport: this.mainServerTransport,
      clientId: this.mainServerClientId,
      sequenceMapper: this.sequenceMapper,
      retryIntervalMs: options.forwardRetryIntervalMs ?? 5000,
      onConflict: (conflict) => this.emit('forwardConflict', conflict),
      onError: (error) => this.emit('error', error),
    });

    // Initialize pull engine (pulls changes from main)
    this.pullEngine = new PullEngine({
      db: this.db,
      dialect: this.dialect,
      transport: this.mainServerTransport,
      clientId: this.mainServerClientId,
      tables: this.tables,
      scopes: this.scopes,
      handlers: this.handlers,
      sequenceMapper: this.sequenceMapper,
      realtime: this.realtime,
      intervalMs: options.pullIntervalMs ?? 10000,
      onError: (error) => this.emit('error', error),
      onPullComplete: async () => {
        await this.maybePruneRelay();
      },
    });
  }

  /**
   * Subscribe to relay events.
   */
  on<K extends keyof RelayEvents>(
    event: K,
    handler: EventHandler<K>
  ): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers?.delete(handler);
    };
  }

  /**
   * Get the current mode (online/offline/reconnecting).
   */
  getMode(): RelayMode {
    return this.modeManager.getMode();
  }

  /**
   * Get the tables this relay subscribes to.
   */
  getTables(): readonly string[] {
    return this.tables;
  }

  /**
   * Get the scope values for subscriptions.
   */
  getScopes(): ScopeValues {
    return this.scopes;
  }

  /**
   * Get the realtime manager for WebSocket connections.
   */
  getRealtime(): RelayRealtime {
    return this.realtime;
  }

  /**
   * Start the relay server background processes.
   *
   * This initializes the database schema and starts:
   * - Forward engine (sends local commits to main)
   * - Pull engine (receives changes from main)
   * - Mode manager (tracks online/offline state)
   */
  async start(): Promise<void> {
    if (this.started) return;

    // Initialize schema if needed
    if (!this.schemaInitialized) {
      await ensureRelaySchema(this.db, this.dialect);
      this.schemaInitialized = true;
    }

    this.started = true;

    // Start background processes
    this.modeManager.start(async () => {
      // Health check: try an empty pull
      try {
        await this.mainServerTransport.sync({
          clientId: this.mainServerClientId,
          pull: {
            subscriptions: [],
            limitCommits: 1,
          },
        });
        return true;
      } catch {
        return false;
      }
    });

    this.forwardEngine.start();
    this.pullEngine.start();
  }

  /**
   * Stop the relay server background processes.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    this.started = false;
    this.modeManager.stop();
    this.forwardEngine.stop();
    this.pullEngine.stop();
    this.realtime.closeAll();
  }

  /**
   * Manually trigger a forward cycle (useful for testing).
   */
  async forwardOnce(): Promise<boolean> {
    return this.forwardEngine.forwardOnce();
  }

  /**
   * Manually trigger a pull cycle (useful for testing).
   */
  async pullOnce(): Promise<boolean> {
    return this.pullEngine.pullOnce();
  }

  /**
   * Prune old relay data (sequence mappings, forwarded outbox, resolved conflicts).
   */
  async pruneRelay(options?: { maxAgeMs?: number }): Promise<PruneRelayResult> {
    const maxAgeMs = options?.maxAgeMs ?? this.pruneMaxAgeMs;
    const threshold = Date.now() - maxAgeMs;

    const deletedMappings =
      await this.sequenceMapper.pruneOldMappings(maxAgeMs);

    const outboxResult = await sql`
      delete from ${sql.table('relay_forward_outbox')}
      where status in ('forwarded', 'failed')
      and updated_at < ${threshold}
    `.execute(this.db);
    const deletedOutbox = Number(outboxResult.numAffectedRows ?? 0);

    const conflictsResult = await sql`
      delete from ${sql.table('relay_forward_conflicts')}
      where resolved_at is not null
      and resolved_at < ${threshold}
    `.execute(this.db);
    const deletedConflicts = Number(conflictsResult.numAffectedRows ?? 0);

    return { deletedMappings, deletedOutbox, deletedConflicts };
  }

  /**
   * Rate-limited pruning. Skips if called within `pruneIntervalMs` of last prune.
   * Returns zero counts if skipped or if pruning is disabled.
   */
  async maybePruneRelay(): Promise<PruneRelayResult> {
    if (this.pruneIntervalMs <= 0) {
      return { deletedMappings: 0, deletedOutbox: 0, deletedConflicts: 0 };
    }

    const now = Date.now();
    if (now - this.lastPruneAtMs < this.pruneIntervalMs) {
      return { deletedMappings: 0, deletedOutbox: 0, deletedConflicts: 0 };
    }

    if (this.pruneInFlight) return this.pruneInFlight;

    this.pruneInFlight = (async () => {
      try {
        const result = await this.pruneRelay();
        this.lastPruneAtMs = Date.now();
        return result;
      } finally {
        this.pruneInFlight = null;
      }
    })();

    return this.pruneInFlight;
  }

  /**
   * Get Hono routes for local clients.
   *
   * Mount these routes to serve local sync clients:
   * - POST /pull
   * - POST /push
   * - GET /realtime (WebSocket)
   */
  async getRoutes(): Promise<Hono> {
    if (this.routes) return this.routes;
    if (this.routesPromise) return this.routesPromise;

    this.routesPromise = (async () => {
      const { createRelayRoutes } = await import('./server-role');

      const routes = createRelayRoutes({
        db: this.db,
        dialect: this.dialect,
        handlers: this.handlers,
        realtime: this.realtime,
        onCommit: async (localCommitSeq: number, affectedTables: string[]) => {
          this.realtime.notifyScopeKeys(affectedTables, localCommitSeq);
          this.forwardEngine.wakeUp();
        },
      });

      this.routes = routes;
      this.routesPromise = null;
      return routes;
    })();

    return this.routesPromise;
  }

  private emit<K extends keyof RelayEvents>(
    event: K,
    ...args: Parameters<RelayEvents[K]>
  ): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        (handler as (...args: unknown[]) => unknown)(...args);
      } catch (err) {
        console.error(`Error in ${event} handler:`, err);
      }
    }
  }
}

/**
 * Create a new relay server instance.
 */
export function createRelayServer(options: RelayServerOptions): RelayServer {
  return new RelayServer(options);
}
