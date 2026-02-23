/**
 * @syncular/client - Unified Client class
 *
 * Single entry point for offline-first sync with:
 * - Built-in mutations API
 * - Optional blob support
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
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { ensureClientBlobSchema } from './blobs/migrate';
import { SyncEngine } from './engine/SyncEngine';
import type {
  ConflictInfo,
  OutboxStats,
  PresenceEntry,
  SubscriptionProgress,
  SyncAwaitBootstrapOptions,
  SyncAwaitPhaseOptions,
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
import type { SyncClientPlugin } from './plugins/types';
import type { SyncClientDb } from './schema';
import type { SubscriptionState } from './subscription-state';

// ============================================================================
// Types
// ============================================================================

/**
 * Pluggable client-side blob storage adapter.
 * Implementations handle platform-specific binary storage (OPFS, Expo FileSystem, etc.)
 * Metadata is stored separately in the main SQLite db.
 */
export interface ClientBlobStorage {
  /** Write blob data from bytes or stream */
  write(
    hash: string,
    data: Uint8Array | ReadableStream<Uint8Array>
  ): Promise<void>;

  /** Read blob data, null if not found */
  read(hash: string): Promise<Uint8Array | null>;

  /** Read blob data as stream, null if not found */
  readStream?(hash: string): Promise<ReadableStream<Uint8Array> | null>;

  /** Delete blob data */
  delete(hash: string): Promise<void>;

  /** Check if blob exists in storage */
  exists(hash: string): Promise<boolean>;

  /** Get total storage usage in bytes (for cache management) */
  getUsage?(): Promise<number>;

  /** Clear all blobs (for cache reset) */
  clear?(): Promise<void>;
}

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
  subscriptions: Array<{
    id: string;
    table: string;
    scopes?: Record<string, string | string[]>;
    params?: Record<string, unknown>;
  }>;

  /** Optional: Local blob storage adapter (enables blob support) */
  blobStorage?: ClientBlobStorage;

  /** Optional: Sync plugins */
  plugins?: SyncClientPlugin[];

  /** Optional: Enable realtime transport mode */
  realtimeEnabled?: boolean;

  /** Optional: Polling interval in milliseconds (default: 10000) */
  pollIntervalMs?: number;

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

interface BlobStoreOptions {
  /** MIME type of the blob */
  mimeType?: string;
  /** Upload immediately vs queue for later */
  immediate?: boolean;
}

export interface BlobClient {
  /** Store a blob locally and queue for upload */
  store(
    data: Blob | File | Uint8Array,
    options?: BlobStoreOptions
  ): Promise<BlobRef>;

  /** Retrieve a blob (from local storage or fetch from server) */
  retrieve(ref: BlobRef): Promise<Uint8Array>;

  /** Check if blob is available locally */
  isLocal(hash: string): Promise<boolean>;

  /** Preload blobs for offline use */
  preload(refs: BlobRef[]): Promise<void>;

  /** Process pending uploads */
  processUploadQueue(): Promise<{ uploaded: number; failed: number }>;

  /** Get upload queue statistics */
  getUploadQueueStats(): Promise<{
    pending: number;
    uploading: number;
    failed: number;
  }>;

  /** Get cache statistics */
  getCacheStats(): Promise<{ count: number; totalBytes: number }>;

  /** Prune cache to free space */
  pruneCache(maxBytes?: number): Promise<number>;

  /** Clear all cached blobs */
  clearCache(): Promise<void>;
}

export interface MigrationInfo {
  /** Whether sync schema is migrated */
  syncMigrated: boolean;
  /** Whether blob schema is migrated */
  blobsMigrated: boolean;
}

type ClientEventType =
  | 'sync:start'
  | 'sync:complete'
  | 'sync:live'
  | 'sync:error'
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
  'data:change': { scopes: string[]; timestamp: number };
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
  private emittedConflictIds = new Set<string>();
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

  /** Blob client (only available if blobStorage configured) */
  public readonly blobs: BlobClient | undefined;

  constructor(options: ClientOptions<DB>) {
    this.options = options;

    // Create mutations API
    const commitFn = createOutboxCommit({
      db: options.db,
      idColumn: options.idColumn ?? 'id',
      versionColumn: options.versionColumn ?? 'server_version',
      omitColumns: options.omitColumns ?? [],
      codecs: options.codecs,
      codecDialect: options.codecDialect,
    });
    this.mutations = createMutationsApi(commitFn) as MutationsApi<DB>;

    // Create blob client if storage provided
    if (options.blobStorage && options.transport.blobs) {
      this.blobs = this.createBlobClient(
        options.blobStorage,
        options.transport
      );
    }
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
    if (this.options.blobStorage) {
      await ensureClientBlobSchema(this.options.db);
    }

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
  updateSubscriptions(
    subscriptions: Array<{
      id: string;
      table: string;
      scopes?: Record<string, string | string[]>;
      params?: Record<string, unknown>;
    }>
  ): void {
    this.options.subscriptions = subscriptions;
    if (this.engine) {
      this.engine.updateSubscriptions(
        subscriptions.map((s) => ({
          id: s.id,
          table: s.table,
          scopes: s.scopes ?? {},
          params: s.params ?? {},
        }))
      );
    }
  }

  /**
   * Get current subscriptions.
   */
  getSubscriptions(): Array<{
    id: string;
    table: string;
    scopes: Record<string, string | string[]>;
    params: Record<string, unknown>;
  }> {
    return this.options.subscriptions.map((s) => ({
      id: s.id,
      table: s.table,
      scopes: s.scopes ?? {},
      params: s.params ?? {},
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

    this.emittedConflictIds.delete(id);
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
    // Check if sync tables exist
    let syncMigrated = false;
    try {
      await this.options.db
        .selectFrom('sync_outbox_commits')
        .selectAll()
        .limit(1)
        .execute();
      syncMigrated = true;
    } catch {
      syncMigrated = false;
    }

    // Check if blob tables exist
    let blobsMigrated = false;
    try {
      await this.options.db
        .selectFrom('sync_blob_cache')
        .selectAll()
        .limit(1)
        .execute();
      blobsMigrated = true;
    } catch {
      blobsMigrated = false;
    }

    return { syncMigrated, blobsMigrated };
  }

  /**
   * Static: Check if migrations are needed.
   */
  static async checkMigrations<DB extends SyncClientDb>(
    db: Kysely<DB>
  ): Promise<{
    needsMigration: boolean;
    syncMigrated: boolean;
    blobsMigrated: boolean;
  }> {
    let syncMigrated = false;
    let blobsMigrated = false;

    try {
      await db.selectFrom('sync_outbox_commits').selectAll().limit(1).execute();
      syncMigrated = true;
    } catch {
      syncMigrated = false;
    }

    try {
      await db.selectFrom('sync_blob_cache').selectAll().limit(1).execute();
      blobsMigrated = true;
    } catch {
      blobsMigrated = false;
    }

    return {
      needsMigration: !syncMigrated,
      syncMigrated,
      blobsMigrated,
    };
  }

  /**
   * Static: Run migrations.
   */
  static async migrate<DB extends SyncClientDb>(
    db: Kysely<DB>,
    options?: { blobs?: boolean }
  ): Promise<void> {
    await ensureClientSyncSchema(db);
    if (options?.blobs) {
      await ensureClientBlobSchema(db);
    }
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

      // Check for new conflicts after sync error
      this.checkForNewConflicts();
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

  private async checkForNewConflicts(): Promise<void> {
    const conflicts = await this.getConflicts();
    const activeIds = new Set(conflicts.map((conflict) => conflict.id));

    for (const id of this.emittedConflictIds) {
      if (!activeIds.has(id)) {
        this.emittedConflictIds.delete(id);
      }
    }

    for (const conflict of conflicts) {
      if (this.emittedConflictIds.has(conflict.id)) {
        continue;
      }
      this.emittedConflictIds.add(conflict.id);
      this.emit('conflict:new', conflict);
    }
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

  private createBlobClient(
    storage: ClientBlobStorage,
    transport: SyncTransport
  ): BlobClient {
    const db = this.options.db;
    const blobs = transport.blobs!;
    const staleUploadingTimeoutMs = 30_000;
    const maxUploadRetries = 3;

    return {
      async store(data, options) {
        const bytes = await toUint8Array(data);
        const mimeType =
          data instanceof Blob
            ? data.type
            : (options?.mimeType ?? 'application/octet-stream');

        // Compute hash
        const hashHex = await computeSha256Hex(bytes);
        const hash = `sha256:${hashHex}`;

        // Store locally
        await storage.write(hash, bytes);

        // Store metadata
        const now = Date.now();
        await sql`
          insert into ${sql.table('sync_blob_cache')} (
            ${sql.join([
              sql.ref('hash'),
              sql.ref('size'),
              sql.ref('mime_type'),
              sql.ref('cached_at'),
              sql.ref('last_accessed_at'),
              sql.ref('encrypted'),
              sql.ref('key_id'),
              sql.ref('body'),
            ])}
          ) values (
            ${sql.join([
              sql.val(hash),
              sql.val(bytes.length),
              sql.val(mimeType),
              sql.val(now),
              sql.val(now),
              sql.val(0),
              sql.val(null),
              sql.val(bytes),
            ])}
          )
          on conflict (${sql.ref('hash')}) do nothing
        `.execute(db);

        // Queue for upload or upload immediately
        if (options?.immediate) {
          // Initiate upload
          const initResult = await blobs.initiateUpload({
            hash,
            size: bytes.length,
            mimeType,
          });

          if (!initResult.exists && initResult.uploadUrl) {
            // Upload to presigned URL
            const uploadResponse = await fetch(initResult.uploadUrl, {
              method: initResult.uploadMethod ?? 'PUT',
              body: bytes.buffer as ArrayBuffer,
              headers: initResult.uploadHeaders,
            });

            if (!uploadResponse.ok) {
              throw new Error(`Upload failed: ${uploadResponse.statusText}`);
            }

            // Complete upload
            await blobs.completeUpload(hash);
          }
        } else {
          // Queue for later upload
          await sql`
            insert into ${sql.table('sync_blob_outbox')} (
              ${sql.join([
                sql.ref('hash'),
                sql.ref('size'),
                sql.ref('mime_type'),
                sql.ref('status'),
                sql.ref('created_at'),
                sql.ref('updated_at'),
                sql.ref('attempt_count'),
                sql.ref('error'),
                sql.ref('encrypted'),
                sql.ref('key_id'),
                sql.ref('body'),
              ])}
            ) values (
              ${sql.join([
                sql.val(hash),
                sql.val(bytes.length),
                sql.val(mimeType),
                sql.val('pending'),
                sql.val(now),
                sql.val(now),
                sql.val(0),
                sql.val(null),
                sql.val(0),
                sql.val(null),
                sql.val(bytes),
              ])}
            )
            on conflict (${sql.ref('hash')}) do nothing
          `.execute(db);
        }

        return {
          hash,
          size: bytes.length,
          mimeType,
        };
      },

      async retrieve(ref) {
        // Check local storage first
        const local = await storage.read(ref.hash);
        if (local) {
          // Update access time
          await sql`
            update ${sql.table('sync_blob_cache')}
            set ${sql.ref('last_accessed_at')} = ${sql.val(Date.now())}
            where ${sql.ref('hash')} = ${sql.val(ref.hash)}
          `.execute(db);
          return local;
        }

        // Fetch from server
        const { url } = await blobs.getDownloadUrl(ref.hash);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Download failed: ${response.statusText}`);
        }

        const bytes = new Uint8Array(await response.arrayBuffer());

        // Cache locally
        await storage.write(ref.hash, bytes);
        const now = Date.now();
        await sql`
          insert into ${sql.table('sync_blob_cache')} (
            ${sql.join([
              sql.ref('hash'),
              sql.ref('size'),
              sql.ref('mime_type'),
              sql.ref('cached_at'),
              sql.ref('last_accessed_at'),
              sql.ref('encrypted'),
              sql.ref('key_id'),
              sql.ref('body'),
            ])}
          ) values (
            ${sql.join([
              sql.val(ref.hash),
              sql.val(bytes.length),
              sql.val(ref.mimeType),
              sql.val(now),
              sql.val(now),
              sql.val(0),
              sql.val(null),
              sql.val(bytes),
            ])}
          )
          on conflict (${sql.ref('hash')}) do nothing
        `.execute(db);

        return bytes;
      },

      async isLocal(hash) {
        return storage.exists(hash);
      },

      async preload(refs) {
        await Promise.all(refs.map((ref) => this.retrieve(ref)));
      },

      async processUploadQueue() {
        let uploaded = 0;
        let failed = 0;
        const now = Date.now();
        const staleThreshold = now - staleUploadingTimeoutMs;

        await sql`
          update ${sql.table('sync_blob_outbox')}
          set
            ${sql.ref('status')} = ${sql.val('failed')},
            ${sql.ref('attempt_count')} = ${sql.ref('attempt_count')} + ${sql.val(
              1
            )},
            ${sql.ref('error')} = ${sql.val(
              'Upload timed out while in uploading state'
            )},
            ${sql.ref('updated_at')} = ${sql.val(now)}
          where ${sql.ref('status')} = ${sql.val('uploading')}
            and ${sql.ref('updated_at')} < ${sql.val(staleThreshold)}
            and ${sql.ref('attempt_count')} + ${sql.val(1)} >= ${sql.val(
              maxUploadRetries
            )}
        `.execute(db);

        await sql`
          update ${sql.table('sync_blob_outbox')}
          set
            ${sql.ref('status')} = ${sql.val('pending')},
            ${sql.ref('attempt_count')} = ${sql.ref('attempt_count')} + ${sql.val(
              1
            )},
            ${sql.ref('error')} = ${sql.val(
              'Upload timed out while in uploading state; retrying'
            )},
            ${sql.ref('updated_at')} = ${sql.val(now)}
          where ${sql.ref('status')} = ${sql.val('uploading')}
            and ${sql.ref('updated_at')} < ${sql.val(staleThreshold)}
            and ${sql.ref('attempt_count')} + ${sql.val(1)} < ${sql.val(
              maxUploadRetries
            )}
        `.execute(db);

        const pendingResult = await sql<{
          hash: string;
          size: number;
          mime_type: string;
          body: Uint8Array | null;
          attempt_count: number;
        }>`
          select
            ${sql.ref('hash')},
            ${sql.ref('size')},
            ${sql.ref('mime_type')},
            ${sql.ref('body')},
            ${sql.ref('attempt_count')}
          from ${sql.table('sync_blob_outbox')}
          where ${sql.ref('status')} = ${sql.val('pending')}
            and ${sql.ref('attempt_count')} < ${sql.val(maxUploadRetries)}
          limit ${sql.val(10)}
        `.execute(db);
        const pending = pendingResult.rows;

        for (const item of pending) {
          const nextAttemptCount = item.attempt_count + 1;
          try {
            // Mark as uploading
            await sql`
              update ${sql.table('sync_blob_outbox')}
              set
                ${sql.ref('status')} = ${sql.val('uploading')},
                ${sql.ref('attempt_count')} = ${sql.val(nextAttemptCount)},
                ${sql.ref('error')} = ${sql.val(null)},
                ${sql.ref('updated_at')} = ${sql.val(Date.now())}
              where ${sql.ref('hash')} = ${sql.val(item.hash)}
                and ${sql.ref('status')} = ${sql.val('pending')}
            `.execute(db);

            // Initiate upload
            const initResult = await blobs.initiateUpload({
              hash: item.hash,
              size: item.size,
              mimeType: item.mime_type,
            });

            if (!initResult.exists && initResult.uploadUrl && item.body) {
              const uploadBody = new ArrayBuffer(item.body.byteLength);
              new Uint8Array(uploadBody).set(item.body);

              // Upload
              const uploadResponse = await fetch(initResult.uploadUrl, {
                method: initResult.uploadMethod ?? 'PUT',
                body: uploadBody,
                headers: initResult.uploadHeaders,
              });

              if (!uploadResponse.ok) {
                throw new Error(`Upload failed: ${uploadResponse.statusText}`);
              }

              // Complete
              const completeResult = await blobs.completeUpload(item.hash);
              if (!completeResult.ok) {
                throw new Error(
                  completeResult.error ?? 'Failed to complete blob upload'
                );
              }
            }

            // Mark as complete
            await sql`
              delete from ${sql.table('sync_blob_outbox')}
              where ${sql.ref('hash')} = ${sql.val(item.hash)}
            `.execute(db);

            uploaded++;
          } catch (err) {
            const nextStatus =
              nextAttemptCount >= maxUploadRetries ? 'failed' : 'pending';

            await sql`
              update ${sql.table('sync_blob_outbox')}
              set
                ${sql.ref('status')} = ${sql.val(nextStatus)},
                ${sql.ref('error')} = ${sql.val(
                  err instanceof Error ? err.message : 'Unknown error'
                )},
                ${sql.ref('updated_at')} = ${sql.val(Date.now())}
              where ${sql.ref('hash')} = ${sql.val(item.hash)}
            `.execute(db);

            if (nextStatus === 'failed') {
              failed++;
            }
          }
        }

        return { uploaded, failed };
      },

      async getUploadQueueStats() {
        const rowsResult = await sql<{
          status: string;
          count: number | bigint;
        }>`
          select
            ${sql.ref('status')} as status,
            count(${sql.ref('hash')}) as count
          from ${sql.table('sync_blob_outbox')}
          group by ${sql.ref('status')}
        `.execute(db);

        const stats = { pending: 0, uploading: 0, failed: 0 };
        for (const row of rowsResult.rows) {
          if (row.status === 'pending') stats.pending = Number(row.count);
          if (row.status === 'uploading') stats.uploading = Number(row.count);
          if (row.status === 'failed') stats.failed = Number(row.count);
        }
        return stats;
      },

      async getCacheStats() {
        const result = await sql<{
          count: number | bigint;
          totalBytes: number | bigint | null;
        }>`
          select
            count(${sql.ref('hash')}) as count,
            sum(${sql.ref('size')}) as totalBytes
          from ${sql.table('sync_blob_cache')}
        `.execute(db);
        const row = result.rows[0];

        return {
          count: Number(row?.count ?? 0),
          totalBytes: Number(row?.totalBytes ?? 0),
        };
      },

      async pruneCache(maxBytes) {
        if (!maxBytes) return 0;

        // Get current size
        const stats = await this.getCacheStats();
        if (stats.totalBytes <= maxBytes) return 0;

        // Get oldest entries to delete
        const toFree = stats.totalBytes - maxBytes;
        let freed = 0;

        const oldEntriesResult = await sql<{ hash: string; size: number }>`
          select ${sql.ref('hash')}, ${sql.ref('size')}
          from ${sql.table('sync_blob_cache')}
          order by ${sql.ref('last_accessed_at')} asc
        `.execute(db);
        const oldEntries = oldEntriesResult.rows;

        for (const entry of oldEntries) {
          if (freed >= toFree) break;

          await storage.delete(entry.hash);
          await sql`
            delete from ${sql.table('sync_blob_cache')}
            where ${sql.ref('hash')} = ${sql.val(entry.hash)}
          `.execute(db);
          freed += entry.size;
        }

        return freed;
      },

      async clearCache() {
        if (storage.clear) {
          await storage.clear();
        } else {
          // Delete each entry individually
          const entriesResult = await sql<{ hash: string }>`
            select ${sql.ref('hash')}
            from ${sql.table('sync_blob_cache')}
          `.execute(db);

          for (const entry of entriesResult.rows) {
            await storage.delete(entry.hash);
          }
        }

        await sql`delete from ${sql.table('sync_blob_cache')}`.execute(db);
      },
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function toUint8Array(
  data: Blob | File | Uint8Array
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data;
  }
  const buffer = await data.arrayBuffer();
  return new Uint8Array(buffer);
}

async function computeSha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    data.buffer as ArrayBuffer
  );
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
