/**
 * @syncular/client - Unified Client class
 *
 * Single entry point for offline-first sync with:
 * - Built-in mutations API
 * - Automatic migrations
 * - Event-driven state management
 * - Conflict handling with events
 */

import type {
  BlobRef,
  ColumnCodecDialect,
  ColumnCodecSource,
  SyncTransport,
} from '@syncular/core';
import { countSyncMetric } from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { SyncEngine } from './engine/SyncEngine';
import type {
  ConflictInfo,
  OutboxStats,
  PresenceEntry,
  PushResultInfo,
  SubscriptionProgress,
  SyncAwaitBootstrapOptions,
  SyncAwaitPhaseOptions,
  SyncBootstrapStatus,
  SyncBootstrapStatusOptions,
  SyncClientSubscription,
  SyncDiagnostics,
  SyncEngineState,
  SyncInspectorOptions,
  SyncInspectorSnapshot,
  SyncProgress,
  SyncRepairOptions,
  SyncResetOptions,
  SyncResetResult,
  SyncResult,
  TransportHealth,
} from './engine/types';
import type { ClientHandlerCollection } from './handlers/collection';
import { ensureClientSyncSchema } from './migrate';
import {
  createMutationsApi,
  createOutboxCommit,
  type MutationsApi,
} from './mutations';
import { withDefaultClientPlugins } from './plugins';
import type {
  SyncClientFeatureRegistry,
  SyncClientPlugin,
  SyncClientPluginLifecycleContext,
} from './plugins/types';
import type { SyncClientDb } from './schema';
import type { SubscriptionState } from './subscription-state';

// ============================================================================
// Types
// ============================================================================

export interface ClientOptions<DB extends SyncClientDb> {
  /** Kysely database instance */
  db: Kysely<DB>;

  /** Transport for server communication (includes sync and blob operations) */
  transport: SyncTransport;

  /** Table handlers for applying snapshots and changes */
  tableHandlers: ClientHandlerCollection<DB>;

  /** Unique client identifier (e.g., device ID) */
  clientId: string;

  /** Current actor/user identifier */
  actorId: string;

  /** Subscriptions to sync */
  subscriptions: SyncClientSubscription[];

  /** Optional: Sync plugins */
  plugins?: SyncClientPlugin[];

  /** Optional: Enable realtime transport mode */
  realtimeEnabled?: boolean;

  /** Optional: Polling interval in milliseconds (default: 10000) */
  pollIntervalMs?: number;

  /** Optional: Deduplicate rows in pull responses on the server */
  dedupeRows?: boolean;

  /**
   * Optional: Debounce window (ms) for coalescing remote/synced `data:change` events.
   * - default: `10`
   * - `0`/`false`: emit immediately (disable debounce)
   * - `>0`: merge scopes and emit once per window
   */
  dataChangeDebounceMs?: number | false;
  /**
   * Optional: Debounce override while sync is actively running.
   * Falls back to `dataChangeDebounceMs` when omitted.
   */
  dataChangeDebounceMsWhenSyncing?: number | false;
  /**
   * Optional: Debounce override while connection is reconnecting.
   * Falls back to `dataChangeDebounceMsWhenSyncing` (if syncing) and then
   * `dataChangeDebounceMs` when omitted.
   */
  dataChangeDebounceMsWhenReconnecting?: number | false;

  /** Optional: State ID for multi-tenant scenarios */
  stateId?: string;

  /** Optional: ID column name (default: 'id') */
  idColumn?: string;

  /** Optional: Version column name (default: 'server_version') */
  versionColumn?: string;

  /** Optional: Columns to omit from sync */
  omitColumns?: string[];

  /** Optional: Column codec resolver */
  codecs?: ColumnCodecSource;

  /** Optional: Codec dialect override (default: 'sqlite') */
  codecDialect?: ColumnCodecDialect;
}

export interface ClientState {
  /** Client ID */
  clientId: string;
  /** Actor ID */
  actorId: string;
  /** Whether sync is enabled (actorId and clientId are set) */
  enabled: boolean;
  /** Whether a sync is currently in progress */
  isSyncing: boolean;
  /** Connection state */
  connectionState: 'connected' | 'connecting' | 'disconnected' | 'reconnecting';
  /** Last successful sync timestamp */
  lastSyncAt: number | null;
  /** Current error if any */
  error: { code: string; message: string } | null;
  /** Outbox statistics */
  outbox: OutboxStats;
}

export interface Conflict {
  id: string;
  table: string;
  rowId: string;
  opIndex: number;
  localPayload: Record<string, unknown> | null;
  serverPayload: Record<string, unknown> | null;
  serverVersion: number | null;
  message: string;
  code: string | null;
  createdAt: number;
}

export interface ConflictResolution {
  strategy: 'keep-local' | 'keep-server' | 'custom';
  payload?: Record<string, unknown>;
}

export interface MigrationInfo {
  syncMigrated: boolean;
}

type ClientEventType =
  | 'sync:start'
  | 'sync:complete'
  | 'sync:live'
  | 'sync:error'
  | 'push:result'
  | 'bootstrap:start'
  | 'bootstrap:progress'
  | 'bootstrap:complete'
  | 'connection:change'
  | 'data:change'
  | 'outbox:change'
  | 'conflict:new'
  | 'conflict:resolved'
  | 'blob:upload:complete'
  | 'blob:upload:error'
  | 'presence:change';

type ClientEventPayloads = {
  'sync:start': { timestamp: number };
  'sync:complete': SyncResult;
  'sync:live': { timestamp: number };
  'sync:error': { code: string; message: string };
  'push:result': PushResultInfo;
  'bootstrap:start': {
    timestamp: number;
    stateId: string;
    subscriptionId: string;
  };
  'bootstrap:progress': {
    timestamp: number;
    stateId: string;
    subscriptionId: string;
    progress: SubscriptionProgress;
  };
  'bootstrap:complete': {
    timestamp: number;
    stateId: string;
    subscriptionId: string;
    durationMs: number;
  };
  'connection:change': { previous: string; current: string };
  'data:change': {
    scopes: string[];
    timestamp: number;
    source: 'local' | 'remote';
  };
  'outbox:change': OutboxStats;
  'conflict:new': Conflict;
  'conflict:resolved': Conflict;
  'blob:upload:complete': BlobRef;
  'blob:upload:error': { hash: string; error: string };
  'presence:change': { scopeKey: string; presence: PresenceEntry[] };
};

type ClientEventHandler<E extends ClientEventType> = (
  payload: ClientEventPayloads[E]
) => void;

// ============================================================================
// Client Class
// ============================================================================

/**
 * Unified sync client.
 *
 * @example
 * ```typescript
 * import { Client } from '@syncular/client';
 * import { createHttpTransport } from '@syncular/transport-http';
 *
 * const client = new Client({
 *   db,
 *   transport: createHttpTransport({ baseUrl: '/api/sync', getHeaders }),
 *   tableHandlers,
 *   clientId: 'device-123',
 *   actorId: 'user-456',
 *   subscriptions: [{ id: 'tasks', table: 'tasks', scopes: { user_id: 'user-456' } }],
 * });
 *
 * await client.start();
 *
 * // Mutations
 * await client.mutations.tasks.insert({ title: 'New task' });
 *
 * // Events
 * client.on('sync:complete', () => console.log('synced'));
 * ```
 */
export class Client<DB extends SyncClientDb = SyncClientDb> {
  private readonly options: ClientOptions<DB>;
  private engine: SyncEngine<DB> | null = null;
  private started = false;
  private destroyed = false;
  private readonly pluginFeatures = new Map<
    keyof SyncClientFeatureRegistry & string,
    SyncClientFeatureRegistry[keyof SyncClientFeatureRegistry & string]
  >();
  private eventListeners = new Map<
    ClientEventType,
    Set<ClientEventHandler<any>>
  >();
  private outboxStats: OutboxStats = {
    pending: 0,
    sending: 0,
    failed: 0,
    acked: 0,
    total: 0,
  };

  /** Mutations API (always available) */
  public readonly mutations: MutationsApi<DB>;

  constructor(options: ClientOptions<DB>) {
    const plugins = withDefaultClientPlugins(options.plugins);
    this.options = { ...options, plugins };

    // Create mutations API
    const baseCommitFn = createOutboxCommit({
      db: this.options.db,
      idColumn: this.options.idColumn ?? 'id',
      versionColumn: this.options.versionColumn ?? 'server_version',
      omitColumns: this.options.omitColumns ?? [],
      codecs: this.options.codecs,
      codecDialect: this.options.codecDialect,
      plugins: this.options.plugins,
      actorId: this.options.actorId,
      clientId: this.options.clientId,
    });
    const commitFn: typeof baseCommitFn = async (fn, options) => {
      const outcome = await baseCommitFn(fn, options);
      this.scheduleLocalSyncAfterMutation();
      return outcome;
    };
    this.mutations = createMutationsApi(commitFn) as MutationsApi<DB>;
    this.setupPluginFeatures();
  }

  // ===========================================================================
  // Identity Getters
  // ===========================================================================

  /** Client ID */
  get clientId(): string {
    return this.options.clientId;
  }

  /** Actor ID */
  get actorId(): string {
    return this.options.actorId;
  }

  /** Database instance */
  get db(): Kysely<DB> {
    return this.options.db;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start the client.
   * Runs migrations and starts sync engine.
   */
  async start(): Promise<void> {
    if (this.destroyed) {
      throw new Error('Client has been destroyed');
    }
    if (this.started) {
      return;
    }

    // Run migrations
    await ensureClientSyncSchema(this.options.db);
    await this.runPluginMigrations();

    // Create and start engine
    this.engine = new SyncEngine({
      db: this.options.db,
      transport: this.options.transport,
      handlers: this.options.tableHandlers,
      clientId: this.options.clientId,
      actorId: this.options.actorId,
      subscriptions: this.options.subscriptions.map((s) => ({
        id: s.id,
        table: s.table,
        scopes: s.scopes ?? {},
        params: s.params ?? {},
      })),
      plugins: this.options.plugins,
      realtimeEnabled: this.options.realtimeEnabled,
      pollIntervalMs: this.options.pollIntervalMs,
      dedupeRows: this.options.dedupeRows,
      dataChangeDebounceMs: this.options.dataChangeDebounceMs,
      dataChangeDebounceMsWhenSyncing:
        this.options.dataChangeDebounceMsWhenSyncing,
      dataChangeDebounceMsWhenReconnecting:
        this.options.dataChangeDebounceMsWhenReconnecting,
      stateId: this.options.stateId,
      migrate: undefined, // We already ran migrations
    });

    // Wire up engine events to client events
    this.wireEngineEvents();

    await this.engine.start();
    this.started = true;
  }

  /**
   * Stop the client (can be restarted).
   */
  stop(): void {
    this.engine?.stop();
  }

  /**
   * Destroy the client (cannot be restarted).
   */
  destroy(): void {
    this.engine?.destroy();
    const ctx = this.createPluginLifecycleContext();
    for (const plugin of this.options.plugins ?? []) {
      plugin.destroy?.(ctx);
    }
    this.eventListeners.clear();
    this.destroyed = true;
  }

  // ===========================================================================
  // Sync
  // ===========================================================================

  /**
   * Trigger a manual sync.
   */
  async sync(): Promise<SyncResult> {
    if (!this.engine) {
      throw new Error('Client not started');
    }
    return this.engine.sync();
  }

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  /**
   * Update subscriptions.
   */
  updateSubscriptions(subscriptions: SyncClientSubscription[]): void {
    this.options.subscriptions = subscriptions;
    if (this.engine) {
      this.engine.updateSubscriptions(
        subscriptions.map((subscription) => ({
          ...subscription,
          scopes: subscription.scopes ?? {},
          params: subscription.params ?? {},
        }))
      );
    }
  }

  /**
   * Get current subscriptions.
   */
  getSubscriptions(): SyncClientSubscription[] {
    return this.options.subscriptions.map((s) => ({
      id: s.id,
      table: s.table,
      scopes: s.scopes ?? {},
      params: s.params ?? {},
      bootstrapState: s.bootstrapState,
      bootstrapPhase: s.bootstrapPhase,
    }));
  }

  /**
   * List persisted subscription metadata rows.
   */
  async listSubscriptionStates(args?: {
    stateId?: string;
    table?: string;
    status?: 'active' | 'revoked';
  }): Promise<SubscriptionState[]> {
    if (!this.engine) return [];
    return this.engine.listSubscriptionStates(args);
  }

  /**
   * Read one persisted subscription metadata row.
   */
  async getSubscriptionState(
    subscriptionId: string,
    options?: { stateId?: string }
  ): Promise<SubscriptionState | null> {
    if (!this.engine) return null;
    return this.engine.getSubscriptionState(subscriptionId, options);
  }

  // ===========================================================================
  // State
  // ===========================================================================

  /**
   * Get current client state.
   */
  getState(): ClientState {
    const engineState =
      this.engine?.getState() ?? this.createInitialEngineState();
    return {
      clientId: this.options.clientId,
      actorId: this.options.actorId,
      enabled: engineState.enabled,
      isSyncing: engineState.isSyncing,
      connectionState: engineState.connectionState,
      lastSyncAt: engineState.lastSyncAt,
      error: engineState.error
        ? { code: engineState.error.code, message: engineState.error.message }
        : null,
      outbox: this.outboxStats,
    };
  }

  /**
   * Get current transport health details.
   */
  getTransportHealth(): TransportHealth | null {
    if (!this.engine) return null;
    return this.engine.getTransportHealth();
  }

  /**
   * Get computed sync progress across subscriptions.
   */
  async getProgress(): Promise<SyncProgress | null> {
    if (!this.engine) return null;
    return this.engine.getProgress();
  }

  /**
   * Get bootstrap readiness for the configured blocking phase or a selected subset.
   */
  async getBootstrapStatus(
    options?: SyncBootstrapStatusOptions
  ): Promise<SyncBootstrapStatus | null> {
    if (!this.engine) return null;
    return this.engine.getBootstrapStatus(options);
  }

  /**
   * Get a diagnostics snapshot for support/debug flows.
   */
  async getDiagnostics(): Promise<SyncDiagnostics | null> {
    if (!this.engine) return null;
    return this.engine.getDiagnostics();
  }

  /**
   * Get a serializable inspector snapshot for in-app debug tooling.
   */
  async getInspectorSnapshot(
    options?: SyncInspectorOptions
  ): Promise<SyncInspectorSnapshot | null> {
    if (!this.engine) return null;
    return this.engine.getInspectorSnapshot(options);
  }

  /**
   * Reset local sync metadata (and optionally synced app rows/outbox/conflicts).
   */
  async reset(options: SyncResetOptions): Promise<SyncResetResult> {
    if (!this.engine) {
      return {
        deletedSubscriptionStates: 0,
        deletedOutboxCommits: 0,
        deletedConflicts: 0,
        clearedTables: [],
      };
    }
    return this.engine.reset(options);
  }

  /**
   * Run a built-in repair flow for common corruption scenarios.
   */
  async repair(options: SyncRepairOptions): Promise<SyncResetResult> {
    if (!this.engine) {
      return {
        deletedSubscriptionStates: 0,
        deletedOutboxCommits: 0,
        deletedConflicts: 0,
        clearedTables: [],
      };
    }
    return this.engine.repair(options);
  }

  /**
   * Wait until the channel reaches a target phase.
   */
  async awaitPhase(
    phase: SyncProgress['channelPhase'],
    options: SyncAwaitPhaseOptions = {}
  ): Promise<SyncProgress | null> {
    if (!this.engine) return null;
    return this.engine.awaitPhase(phase, options);
  }

  /**
   * Wait until bootstrap completes for the default state or a specific subscription.
   */
  async awaitBootstrapComplete(
    options: SyncAwaitBootstrapOptions = {}
  ): Promise<SyncProgress | null> {
    if (!this.engine) return null;
    return this.engine.awaitBootstrapComplete(options);
  }

  /**
   * Subscribe to state changes (for useSyncExternalStore).
   */
  subscribe(callback: () => void): () => void {
    if (!this.engine) {
      // Return no-op unsubscribe before engine is started
      return () => {};
    }
    return this.engine.subscribe(callback);
  }

  /**
   * Subscribe to state changes with selector-based equality filtering.
   */
  subscribeSelector<T>(
    selector: () => T,
    callback: () => void,
    isEqual?: (previous: T, next: T) => boolean
  ): () => void {
    if (!this.engine) {
      return () => {};
    }
    return this.engine.subscribeSelector(selector, callback, isEqual);
  }

  // ===========================================================================
  // Events
  // ===========================================================================

  /**
   * Subscribe to client events.
   */
  on<E extends ClientEventType>(
    event: E,
    handler: ClientEventHandler<E>
  ): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler);

    return () => {
      this.eventListeners.get(event)?.delete(handler);
    };
  }

  private emit<E extends ClientEventType>(
    event: E,
    payload: ClientEventPayloads[E]
  ): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch (err) {
          console.error(`[Client] Error in ${event} listener:`, err);
        }
      }
    }
  }

  private setupPluginFeatures(): void {
    const ctx = this.createPluginLifecycleContext();
    for (const plugin of this.options.plugins ?? []) {
      plugin.setup?.(ctx);
    }
  }

  private async runPluginMigrations(): Promise<void> {
    const ctx = this.createPluginLifecycleContext();
    for (const plugin of this.options.plugins ?? []) {
      if (plugin.migrate) {
        await plugin.migrate(ctx);
      }
    }
  }

  private createPluginLifecycleContext(): SyncClientPluginLifecycleContext<DB> {
    return {
      actorId: this.options.actorId,
      clientId: this.options.clientId,
      db: this.options.db,
      transport: this.options.transport,
      defineFeature: (name, value) => {
        this.defineFeature(name, value);
      },
      emit: (event, payload) => {
        this.emitPluginEvent(event, payload);
      },
    };
  }

  private defineFeature<Name extends keyof SyncClientFeatureRegistry & string>(
    name: Name,
    value: SyncClientFeatureRegistry[Name]
  ): void {
    if (this.pluginFeatures.has(name)) {
      throw new Error(`Client feature "${name}" is already registered`);
    }

    this.pluginFeatures.set(name, value);
    Object.defineProperty(this, name, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }

  private emitPluginEvent(event: string, payload: object): void {
    this.emit(
      event as ClientEventType,
      payload as ClientEventPayloads[ClientEventType]
    );
  }

  private scheduleLocalSyncAfterMutation(): void {
    if (!this.started || !this.engine || this.destroyed) {
      return;
    }

    const engineState = this.engine.getState();
    if (
      engineState.isRetrying ||
      engineState.connectionState === 'disconnected'
    ) {
      return;
    }

    void this.engine.sync({ trigger: 'local' }).catch((error) => {
      console.error(
        '[Client] Unexpected background sync failure after local mutation:',
        error
      );
    });
  }

  // ===========================================================================
  // Conflicts
  // ===========================================================================

  /**
   * Get pending conflicts.
   */
  async getConflicts(): Promise<Conflict[]> {
    if (!this.engine) {
      return [];
    }
    const conflicts = await this.engine.getConflicts();
    return conflicts.map((c) => this.mapConflictInfo(c));
  }

  /**
   * Resolve a conflict.
   */
  async resolveConflict(
    id: string,
    resolution: ConflictResolution
  ): Promise<void> {
    const { resolveConflict } = await import('./conflicts');
    const pendingBeforeResolve = await this.getConflicts();
    const resolvedConflict = pendingBeforeResolve.find((c) => c.id === id);

    // For 'keep-local' and 'keep-server', we just mark it resolved
    // For 'custom', we would need to apply the payload - but that requires
    // creating a new mutation, which the user should do separately
    const resolutionStr =
      resolution.strategy === 'custom'
        ? `custom:${JSON.stringify(resolution.payload)}`
        : resolution.strategy;

    await resolveConflict(this.options.db, { id, resolution: resolutionStr });

    countSyncMetric('sync.conflicts.resolved', 1, {
      attributes: {
        strategy: resolution.strategy,
      },
    });

    if (resolvedConflict) {
      this.emit('conflict:resolved', resolvedConflict);
    }
  }

  // ===========================================================================
  // Outbox
  // ===========================================================================

  /**
   * Get outbox statistics.
   */
  async getOutboxStats(): Promise<OutboxStats> {
    if (!this.engine) {
      return this.outboxStats;
    }
    this.outboxStats = await this.engine.refreshOutboxStats({ emit: false });
    return this.outboxStats;
  }

  /**
   * Clear failed commits from outbox.
   */
  async clearFailedCommits(): Promise<number> {
    if (!this.engine) {
      return 0;
    }
    return this.engine.clearFailedCommits();
  }

  /**
   * Retry failed commits.
   */
  async retryFailedCommits(): Promise<number> {
    // Mark failed commits as pending and trigger sync
    const result = await sql`
      update ${sql.table('sync_outbox_commits')}
      set
        ${sql.ref('status')} = ${sql.val('pending')},
        ${sql.ref('attempt_count')} = ${sql.val(0)},
        ${sql.ref('error')} = ${sql.val(null)}
      where ${sql.ref('status')} = ${sql.val('failed')}
    `.execute(this.options.db);

    const count = Number(result.numAffectedRows ?? 0n);
    if (count > 0 && this.engine) {
      await this.engine.refreshOutboxStats();
      await this.engine.sync();
    }
    return count;
  }

  // ===========================================================================
  // Presence
  // ===========================================================================

  /**
   * Get presence for a scope.
   */
  getPresence<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): PresenceEntry<TMetadata>[] {
    if (!this.engine) {
      return [];
    }
    return this.engine.getPresence<TMetadata>(scopeKey);
  }

  /**
   * Join presence for a scope key.
   */
  joinPresence(scopeKey: string, metadata?: Record<string, unknown>): void {
    this.engine?.joinPresence(scopeKey, metadata);
  }

  /**
   * Leave presence for a scope key.
   */
  leavePresence(scopeKey: string): void {
    this.engine?.leavePresence(scopeKey);
  }

  /**
   * Update presence metadata for a scope key.
   */
  updatePresenceMetadata(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void {
    this.engine?.updatePresenceMetadata(scopeKey, metadata);
  }

  // ===========================================================================
  // Migration Info
  // ===========================================================================

  /**
   * Get migration info.
   */
  async getMigrationInfo(): Promise<MigrationInfo> {
    let syncMigrated = false;
    try {
      await sql`
        select 1
        from ${sql.table('sync_outbox_commits')}
        limit 1
      `.execute(this.options.db);
      syncMigrated = true;
    } catch {
      syncMigrated = false;
    }

    return { syncMigrated };
  }

  /**
   * Static: Check if migrations are needed.
   */
  static async checkMigrations<DB extends SyncClientDb>(
    db: Kysely<DB>
  ): Promise<{
    needsMigration: boolean;
    syncMigrated: boolean;
  }> {
    let syncMigrated = false;

    try {
      await sql`
        select 1
        from ${sql.table('sync_outbox_commits')}
        limit 1
      `.execute(db);
      syncMigrated = true;
    } catch {
      syncMigrated = false;
    }

    return {
      needsMigration: !syncMigrated,
      syncMigrated,
    };
  }

  /**
   * Static: Run migrations.
   */
  static async migrate<DB extends SyncClientDb>(db: Kysely<DB>): Promise<void> {
    await ensureClientSyncSchema(db);
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private createInitialEngineState(): SyncEngineState {
    return {
      enabled: false,
      isSyncing: false,
      connectionState: 'disconnected',
      transportMode: 'polling',
      lastSyncAt: null,
      error: null,
      pendingCount: 0,
      retryCount: 0,
      isRetrying: false,
    };
  }

  private wireEngineEvents(): void {
    if (!this.engine) return;

    this.engine.on('sync:start', (payload) => {
      this.emit('sync:start', payload);
    });

    this.engine.on('sync:complete', (payload) => {
      this.emit('sync:complete', {
        success: true,
        pushedCommits: payload.pushedCommits,
        pullRounds: payload.pullRounds,
        pullResponse: payload.pullResponse,
      });
    });

    this.engine.on('sync:live', (payload) => {
      this.emit('sync:live', payload);
    });

    this.engine.on('sync:error', (error) => {
      this.emit('sync:error', { code: error.code, message: error.message });
    });

    this.engine.on('push:result', (payload) => {
      this.emit('push:result', payload);
    });

    this.engine.on('conflict:new', (payload) => {
      this.emit('conflict:new', this.mapConflictInfo(payload));
    });

    this.engine.on('bootstrap:start', (payload) => {
      this.emit('bootstrap:start', payload);
    });

    this.engine.on('bootstrap:progress', (payload) => {
      this.emit('bootstrap:progress', payload);
    });

    this.engine.on('bootstrap:complete', (payload) => {
      this.emit('bootstrap:complete', payload);
    });

    this.engine.on('connection:change', (payload) => {
      this.emit('connection:change', payload);
    });

    this.engine.on('data:change', (payload) => {
      this.emit('data:change', payload);
    });

    this.engine.on('outbox:change', (payload) => {
      this.outboxStats = {
        pending: payload.pendingCount,
        sending: payload.sendingCount,
        failed: payload.failedCount,
        acked: payload.ackedCount ?? 0,
        total:
          payload.pendingCount +
          payload.sendingCount +
          payload.failedCount +
          (payload.ackedCount ?? 0),
      };
      this.emit('outbox:change', this.outboxStats);
    });

    this.engine.on('presence:change', (payload) => {
      this.emit('presence:change', payload);
    });
  }

  private mapConflictInfo(info: ConflictInfo): Conflict {
    let serverPayload: Record<string, unknown> | null = null;
    if (info.serverRowJson) {
      try {
        serverPayload = JSON.parse(info.serverRowJson);
      } catch {
        serverPayload = null;
      }
    }

    return {
      id: info.id,
      table: info.table,
      rowId: info.rowId,
      opIndex: info.opIndex,
      localPayload: info.localPayload,
      serverPayload,
      serverVersion: info.serverVersion,
      message: info.message,
      code: info.code,
      createdAt: info.createdAt,
    };
  }
}

type SyncClientFeatureAccessors = {
  [K in keyof SyncClientFeatureRegistry]: SyncClientFeatureRegistry[K];
};

export interface Client extends SyncClientFeatureAccessors {}
