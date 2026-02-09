/**
 * @syncular/client - Core sync engine
 *
 * Event-driven sync engine that manages push/pull cycles, connection state,
 * and provides a clean API for framework bindings to consume.
 */

import type {
  SyncChange,
  SyncPullResponse,
  SyncSubscriptionRequest,
} from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import { syncPushOnce } from '../push-engine';
import type {
  ConflictResultStatus,
  OutboxCommitStatus,
  SyncClientDb,
} from '../schema';
import { syncOnce } from '../sync-loop';
import type {
  ConflictInfo,
  OutboxStats,
  PresenceEntry,
  RealtimeTransportLike,
  SyncConnectionState,
  SyncEngineConfig,
  SyncEngineState,
  SyncError,
  SyncEventListener,
  SyncEventPayloads,
  SyncEventType,
  SyncResult,
  SyncTransportMode,
} from './types';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000;
const EXPONENTIAL_FACTOR = 2;

function calculateRetryDelay(attemptIndex: number): number {
  return Math.min(
    INITIAL_RETRY_DELAY_MS * EXPONENTIAL_FACTOR ** attemptIndex,
    MAX_RETRY_DELAY_MS
  );
}

function isRealtimeTransport(
  transport: unknown
): transport is RealtimeTransportLike {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as RealtimeTransportLike).connect === 'function'
  );
}

function createSyncError(
  code: SyncError['code'],
  message: string,
  cause?: Error
): SyncError {
  return {
    code,
    message,
    cause,
    timestamp: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sync engine that orchestrates push/pull cycles with proper lifecycle management.
 *
 * Key features:
 * - Event-driven architecture (no global mutable state)
 * - Proper error handling (no silent catches)
 * - Lifecycle managed by framework bindings
 * - Type-safe event subscriptions
 * - Presence tracking support
 */
type AnyEventListener = (payload: SyncEventPayloads[SyncEventType]) => void;

export class SyncEngine<DB extends SyncClientDb = SyncClientDb> {
  private config: SyncEngineConfig<DB>;
  private state: SyncEngineState;
  private listeners: Map<SyncEventType, Set<AnyEventListener>>;
  private pollerId: ReturnType<typeof setInterval> | null = null;
  private fallbackPollerId: ReturnType<typeof setInterval> | null = null;
  private realtimeDisconnect: (() => void) | null = null;
  private realtimePresenceUnsub: (() => void) | null = null;
  private isDestroyed = false;
  private migrated = false;
  private syncPromise: Promise<SyncResult> | null = null;
  private syncRequestedWhileRunning = false;
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /**
   * In-memory map tracking local mutation timestamps by rowId.
   * Used for efficient fingerprint-based rerender optimization.
   * Key format: `${table}:${rowId}`, Value: timestamp (Date.now())
   */
  private mutationTimestamps = new Map<string, number>();

  /**
   * In-memory map tracking table-level mutation timestamps.
   * Used for coarse invalidation during large bootstrap snapshots to avoid
   * storing timestamps for every row.
   */
  private tableMutationTimestamps = new Map<string, number>();

  /**
   * In-memory presence state by scope key.
   * Updated via realtime presence events.
   */
  private presenceByScopeKey = new Map<string, PresenceEntry[]>();

  constructor(config: SyncEngineConfig<DB>) {
    this.config = config;
    this.listeners = new Map();
    this.state = this.createInitialState();
  }

  /**
   * Get mutation timestamp for a row (used by query hooks for fingerprinting).
   * Returns 0 if row has no recorded mutation timestamp.
   */
  getMutationTimestamp(table: string, rowId: string): number {
    const rowTs = this.mutationTimestamps.get(`${table}:${rowId}`) ?? 0;
    const tableTs = this.tableMutationTimestamps.get(table) ?? 0;
    return Math.max(rowTs, tableTs);
  }

  /**
   * Get presence entries for a scope key.
   * Returns empty array if no presence data for the scope.
   */
  getPresence<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): PresenceEntry<TMetadata>[] {
    return (this.presenceByScopeKey.get(scopeKey) ??
      []) as PresenceEntry<TMetadata>[];
  }

  /**
   * Update presence for a scope key (called by realtime transport).
   * Emits presence:change event for listeners.
   */
  updatePresence(scopeKey: string, presence: PresenceEntry[]): void {
    this.presenceByScopeKey.set(scopeKey, presence);
    this.emit('presence:change', { scopeKey, presence });
  }

  /**
   * Join presence for a scope key.
   * Sends via transport (if available) and updates local state optimistically.
   */
  joinPresence(scopeKey: string, metadata?: Record<string, unknown>): void {
    if (isRealtimeTransport(this.config.transport)) {
      const transport = this.config.transport as RealtimeTransportLike;
      transport.sendPresenceJoin?.(scopeKey, metadata);
    }
    // Optimistic local update
    this.handlePresenceEvent({
      action: 'join',
      scopeKey,
      clientId: this.config.clientId!,
      actorId: this.config.actorId!,
      metadata,
    });
  }

  /**
   * Leave presence for a scope key.
   */
  leavePresence(scopeKey: string): void {
    if (isRealtimeTransport(this.config.transport)) {
      const transport = this.config.transport as RealtimeTransportLike;
      transport.sendPresenceLeave?.(scopeKey);
    }
    this.handlePresenceEvent({
      action: 'leave',
      scopeKey,
      clientId: this.config.clientId!,
      actorId: this.config.actorId!,
    });
  }

  /**
   * Update presence metadata for a scope key.
   */
  updatePresenceMetadata(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void {
    if (isRealtimeTransport(this.config.transport)) {
      const transport = this.config.transport as RealtimeTransportLike;
      transport.sendPresenceUpdate?.(scopeKey, metadata);
    }
    this.handlePresenceEvent({
      action: 'update',
      scopeKey,
      clientId: this.config.clientId!,
      actorId: this.config.actorId!,
      metadata,
    });
  }

  /**
   * Handle a single presence event (join/leave/update).
   * Updates the in-memory presence state and emits change event.
   */
  handlePresenceEvent(event: {
    action: 'join' | 'leave' | 'update';
    scopeKey: string;
    clientId: string;
    actorId: string;
    metadata?: Record<string, unknown>;
  }): void {
    const current = this.presenceByScopeKey.get(event.scopeKey) ?? [];

    let updated: PresenceEntry[];
    switch (event.action) {
      case 'join':
        // Add new entry (remove existing if present to update)
        updated = [
          ...current.filter((e) => e.clientId !== event.clientId),
          {
            clientId: event.clientId,
            actorId: event.actorId,
            joinedAt: Date.now(),
            metadata: event.metadata,
          },
        ];
        break;
      case 'leave':
        updated = current.filter((e) => e.clientId !== event.clientId);
        break;
      case 'update':
        updated = current.map((e) =>
          e.clientId === event.clientId ? { ...e, metadata: event.metadata } : e
        );
        break;
    }

    this.presenceByScopeKey.set(event.scopeKey, updated);
    this.emit('presence:change', {
      scopeKey: event.scopeKey,
      presence: updated,
    });
  }

  private createInitialState(): SyncEngineState {
    const enabled = this.isEnabled();
    return {
      enabled,
      isSyncing: false,
      connectionState: enabled ? 'disconnected' : 'disconnected',
      transportMode: this.detectTransportMode(),
      lastSyncAt: null,
      error: null,
      pendingCount: 0,
      retryCount: 0,
      isRetrying: false,
    };
  }

  private isEnabled(): boolean {
    const { actorId, clientId } = this.config;
    return (
      typeof actorId === 'string' &&
      actorId.length > 0 &&
      typeof clientId === 'string' &&
      clientId.length > 0
    );
  }

  private detectTransportMode(): SyncTransportMode {
    if (
      this.config.realtimeEnabled &&
      isRealtimeTransport(this.config.transport)
    ) {
      return 'realtime';
    }
    return 'polling';
  }

  /**
   * Get current engine state.
   * Returns the same object reference to avoid useSyncExternalStore infinite loops.
   */
  getState(): Readonly<SyncEngineState> {
    return this.state;
  }

  /**
   * Get database instance
   */
  getDb(): Kysely<DB> {
    return this.config.db;
  }

  /**
   * Get current actor id (sync scoping).
   */
  getActorId(): string | null | undefined {
    return this.config.actorId;
  }

  /**
   * Get current client id (device/app install id).
   */
  getClientId(): string | null | undefined {
    return this.config.clientId;
  }

  /**
   * Subscribe to sync events
   */
  on<T extends SyncEventType>(
    event: T,
    listener: SyncEventListener<T>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const wrapped: AnyEventListener = (payload) => {
      listener(payload as SyncEventPayloads[T]);
    };
    this.listeners.get(event)!.add(wrapped);

    return () => {
      this.listeners.get(event)?.delete(wrapped);
    };
  }

  /**
   * Subscribe to any state change (for useSyncExternalStore)
   */
  subscribe(callback: () => void): () => void {
    // Subscribe to state:change which is emitted by updateState()
    return this.on('state:change', callback);
  }

  private emit<T extends SyncEventType>(
    event: T,
    payload: SyncEventPayloads[T]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        try {
          listener(payload);
        } catch (err) {
          console.error(`[SyncEngine] Error in ${event} listener:`, err);
        }
      }
    }
  }

  private updateState(partial: Partial<SyncEngineState>): void {
    this.state = { ...this.state, ...partial };
    // Emit state:change to notify useSyncExternalStore subscribers
    this.emit('state:change', {});
  }

  private setConnectionState(state: SyncConnectionState): void {
    const previous = this.state.connectionState;
    if (previous !== state) {
      this.updateState({ connectionState: state });
      this.emit('connection:change', { previous, current: state });
    }
  }

  /**
   * Start the sync engine
   */
  async start(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('SyncEngine has been destroyed');
    }

    if (!this.isEnabled()) {
      this.updateState({ enabled: false });
      return;
    }

    this.updateState({ enabled: true });

    // Run migration if provided
    if (this.config.migrate && !this.migrated) {
      // Best-effort: push any pending outbox commits before migration
      // (migration may reset the DB, so we try to save unsynced changes)
      try {
        const hasOutbox = await sql`
          select 1 from ${sql.table('sync_outbox_commits')} limit 1
        `
          .execute(this.config.db)
          .then((r) => r.rows.length > 0)
          .catch(() => false);

        if (hasOutbox) {
          // Push all pending commits (best effort)
          let pushed = true;
          while (pushed) {
            const result = await syncPushOnce(
              this.config.db,
              this.config.transport,
              {
                clientId: this.config.clientId!,
                actorId: this.config.actorId ?? undefined,
                plugins: this.config.plugins,
              }
            );
            pushed = result.pushed;
          }
        }
      } catch {
        // Best-effort: if push fails (network down, table missing), continue
      }

      try {
        await this.config.migrate(this.config.db);
        this.migrated = true;
      } catch (err) {
        const migrationError =
          err instanceof Error ? err : new Error(String(err));
        this.config.onMigrationError?.(migrationError);
        const error = createSyncError(
          'SYNC_ERROR',
          'Migration failed',
          migrationError
        );
        this.handleError(error);
        return;
      }
    }

    // Setup transport-specific handling
    if (this.state.transportMode === 'realtime') {
      this.setupRealtime();
    } else {
      this.setupPolling();
    }

    // Initial sync
    await this.sync();
  }

  /**
   * Stop the sync engine (cleanup without destroy)
   */
  stop(): void {
    this.stopPolling();
    this.stopRealtime();
    this.setConnectionState('disconnected');
  }

  /**
   * Destroy the engine (cannot be restarted)
   */
  destroy(): void {
    this.stop();
    this.listeners.clear();
    this.isDestroyed = true;

    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
  }

  /**
   * Trigger a manual sync
   */
  async sync(): Promise<SyncResult> {
    // Dedupe concurrent sync calls
    if (this.syncPromise) {
      // A sync is already in-flight; queue one more run so we don't miss
      // mutations enqueued during the current cycle (important in realtime mode).
      this.syncRequestedWhileRunning = true;
      return this.syncPromise;
    }

    if (
      !this.isEnabled() ||
      this.isDestroyed ||
      this.state.connectionState === 'disconnected'
    ) {
      return {
        success: false,
        pushedCommits: 0,
        pullRounds: 0,
        pullResponse: { ok: true, subscriptions: [] },
        error: createSyncError('SYNC_ERROR', 'Sync not enabled'),
      };
    }

    this.syncPromise = this.performSyncLoop();
    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  private async performSyncLoop(): Promise<SyncResult> {
    let lastResult: SyncResult = {
      success: false,
      pushedCommits: 0,
      pullRounds: 0,
      pullResponse: { ok: true, subscriptions: [] },
      error: createSyncError('SYNC_ERROR', 'Sync not started'),
    };

    do {
      this.syncRequestedWhileRunning = false;
      lastResult = await this.performSyncOnce();
      // If the sync failed, let retry logic handle backoff instead of tight looping.
      if (!lastResult.success) break;
    } while (
      this.syncRequestedWhileRunning &&
      !this.isDestroyed &&
      this.isEnabled()
    );

    return lastResult;
  }

  private async performSyncOnce(): Promise<SyncResult> {
    const timestamp = Date.now();
    this.updateState({ isSyncing: true });
    this.emit('sync:start', { timestamp });

    try {
      const pullApplyTimestamp = Date.now();
      const result = await syncOnce(
        this.config.db,
        this.config.transport,
        this.config.shapes,
        {
          clientId: this.config.clientId!,
          actorId: this.config.actorId ?? undefined,
          plugins: this.config.plugins,
          subscriptions: this.config.subscriptions as SyncSubscriptionRequest[],
          limitCommits: this.config.limitCommits,
          limitSnapshotRows: this.config.limitSnapshotRows,
          maxSnapshotPages: this.config.maxSnapshotPages,
          stateId: this.config.stateId,
        }
      );

      const syncResult: SyncResult = {
        success: true,
        pushedCommits: result.pushedCommits,
        pullRounds: result.pullRounds,
        pullResponse: result.pullResponse,
      };

      // Update fingerprint mutation timestamps for server-applied changes so wa-sqlite
      // query hooks rerender on remote changes (not just local mutations).
      this.recordMutationTimestampsFromPullResponse(
        result.pullResponse,
        pullApplyTimestamp
      );

      this.updateState({
        isSyncing: false,
        lastSyncAt: Date.now(),
        error: null,
        retryCount: 0,
        isRetrying: false,
      });

      this.emit('sync:complete', {
        timestamp: Date.now(),
        pushedCommits: result.pushedCommits,
        pullRounds: result.pullRounds,
        pullResponse: result.pullResponse,
      });

      // Emit data change for any tables that had changes
      const changedTables = this.extractChangedTables(result.pullResponse);
      if (changedTables.length > 0) {
        this.emit('data:change', {
          scopes: changedTables,
          timestamp: Date.now(),
        });
        this.config.onDataChange?.(changedTables);
      }

      // Refresh outbox stats
      await this.refreshOutboxStats();

      return syncResult;
    } catch (err) {
      const error = createSyncError(
        'SYNC_ERROR',
        err instanceof Error ? err.message : 'Sync failed',
        err instanceof Error ? err : undefined
      );

      this.updateState({
        isSyncing: false,
        error,
        retryCount: this.state.retryCount + 1,
        isRetrying: false,
      });

      this.handleError(error);

      // Schedule retry if under max retries
      const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
      if (this.state.retryCount < maxRetries) {
        this.scheduleRetry();
      }

      return {
        success: false,
        pushedCommits: 0,
        pullRounds: 0,
        pullResponse: { ok: true, subscriptions: [] },
        error,
      };
    }
  }

  private extractChangedTables(response: SyncPullResponse): string[] {
    const tables = new Set<string>();
    for (const sub of response.subscriptions ?? []) {
      // Extract tables from snapshots
      for (const snapshot of sub.snapshots ?? []) {
        if (snapshot.table) {
          tables.add(snapshot.table);
        }
      }
      // Extract tables from commits
      for (const commit of sub.commits ?? []) {
        for (const change of commit.changes ?? []) {
          if (change.table) {
            tables.add(change.table);
          }
        }
      }
    }

    return Array.from(tables);
  }

  private timestampCounter = 0;

  private nextPreciseTimestamp(now: number): number {
    // Use sub-millisecond precision by combining timestamp with atomic counter
    // This prevents race conditions in concurrent mutations while maintaining
    // millisecond-level compatibility with existing code.
    return now + (this.timestampCounter++ % 1000) / 1000;
  }

  private bumpMutationTimestamp(
    table: string,
    rowId: string,
    now: number
  ): void {
    const key = `${table}:${rowId}`;
    const preciseNow = this.nextPreciseTimestamp(now);
    const prev = this.mutationTimestamps.get(key) ?? 0;
    this.mutationTimestamps.set(key, Math.max(preciseNow, prev + 0.001));
  }

  private bumpTableMutationTimestamp(table: string, now: number): void {
    const preciseNow = this.nextPreciseTimestamp(now);
    const prev = this.tableMutationTimestamps.get(table) ?? 0;
    this.tableMutationTimestamps.set(table, Math.max(preciseNow, prev + 0.001));
  }

  /**
   * Record local mutations that were already applied to the DB.
   *
   * This updates in-memory mutation timestamps (for fingerprint-based rerenders),
   * and emits a single `data:change` event for the affected tables.
   *
   * This is intentionally separate from applyLocalMutation() so callers that
   * perform their own DB transactions (e.g. `useMutations`) can still keep UI
   * updates correct without double-writing.
   */
  recordLocalMutations(
    inputs: Array<{
      table: string;
      rowId: string;
      op: 'upsert' | 'delete';
    }>,
    now = Date.now()
  ): void {
    const affectedTables = new Set<string>();

    for (const input of inputs) {
      if (!input.table || !input.rowId) continue;
      affectedTables.add(input.table);

      if (input.op === 'delete') {
        this.mutationTimestamps.delete(`${input.table}:${input.rowId}`);
        continue;
      }

      this.bumpMutationTimestamp(input.table, input.rowId, now);
    }

    if (affectedTables.size > 0) {
      this.emit('data:change', {
        scopes: Array.from(affectedTables),
        timestamp: Date.now(),
      });
      this.config.onDataChange?.(Array.from(affectedTables));
    }
  }

  private recordMutationTimestampsFromPullResponse(
    response: SyncPullResponse,
    now: number
  ): void {
    for (const sub of response.subscriptions ?? []) {
      // Mark snapshot tables as changed so bootstrap/resnapshot updates
      // propagate without storing per-row timestamps for massive snapshots.
      for (const snapshot of sub.snapshots ?? []) {
        if (!snapshot.table) continue;
        this.bumpTableMutationTimestamp(snapshot.table, now);
      }

      for (const commit of sub.commits ?? []) {
        for (const change of commit.changes ?? []) {
          const table = change.table;
          const rowId = change.row_id;
          if (!table || !rowId) continue;

          if (change.op === 'delete') {
            this.mutationTimestamps.delete(`${table}:${rowId}`);
          } else {
            this.bumpMutationTimestamp(table, rowId, now);
          }
        }
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
    }

    const delay = calculateRetryDelay(this.state.retryCount);
    this.updateState({ isRetrying: true });

    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = null;
      if (!this.isDestroyed) {
        this.sync();
      }
    }, delay);
  }

  private handleError(error: SyncError): void {
    this.emit('sync:error', error);
    this.config.onError?.(error);
  }

  private setupPolling(): void {
    this.stopPolling();

    const interval = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollerId = setInterval(() => {
      if (!this.state.isSyncing && !this.isDestroyed) {
        this.sync();
      }
    }, interval);

    this.setConnectionState('connected');
  }

  private stopPolling(): void {
    if (this.pollerId) {
      clearInterval(this.pollerId);
      this.pollerId = null;
    }
  }

  private setupRealtime(): void {
    if (!isRealtimeTransport(this.config.transport)) {
      console.warn(
        '[SyncEngine] realtimeEnabled=true but transport does not support realtime. Falling back to polling.'
      );
      this.updateState({ transportMode: 'polling' });
      this.setupPolling();
      return;
    }

    this.setConnectionState('connecting');

    const transport = this.config.transport as RealtimeTransportLike;

    // Wire up presence events if transport supports them
    if (transport.onPresenceEvent) {
      this.realtimePresenceUnsub = transport.onPresenceEvent((event) => {
        if (event.action === 'snapshot' && event.entries) {
          this.updatePresence(event.scopeKey, event.entries);
        } else if (
          event.action === 'join' ||
          event.action === 'leave' ||
          event.action === 'update'
        ) {
          this.handlePresenceEvent({
            action: event.action,
            scopeKey: event.scopeKey,
            clientId: event.clientId ?? '',
            actorId: event.actorId ?? '',
            metadata: event.metadata,
          });
        }
      });
    }

    this.realtimeDisconnect = transport.connect(
      { clientId: this.config.clientId! },
      (event) => {
        if (event.event === 'sync') {
          this.sync();
        }
      },
      (state) => {
        switch (state) {
          case 'connected':
            this.setConnectionState('connected');
            this.stopFallbackPolling();
            this.sync();
            break;
          case 'connecting':
            this.setConnectionState('connecting');
            break;
          case 'disconnected':
            this.setConnectionState('reconnecting');
            this.startFallbackPolling();
            break;
        }
      }
    );
  }

  private stopRealtime(): void {
    if (this.realtimePresenceUnsub) {
      this.realtimePresenceUnsub();
      this.realtimePresenceUnsub = null;
    }
    if (this.realtimeDisconnect) {
      this.realtimeDisconnect();
      this.realtimeDisconnect = null;
    }
    this.stopFallbackPolling();
  }

  private startFallbackPolling(): void {
    if (this.fallbackPollerId) return;

    const interval = this.config.realtimeFallbackPollMs ?? 30_000;
    this.fallbackPollerId = setInterval(() => {
      if (!this.state.isSyncing && !this.isDestroyed) {
        this.sync();
      }
    }, interval);
  }

  private stopFallbackPolling(): void {
    if (this.fallbackPollerId) {
      clearInterval(this.fallbackPollerId);
      this.fallbackPollerId = null;
    }
  }

  /**
   * Reconnect
   */
  reconnect(): void {
    if (this.isDestroyed || !this.isEnabled()) return;

    if (
      this.state.transportMode === 'realtime' &&
      isRealtimeTransport(this.config.transport)
    ) {
      // If we previously disconnected, we need to re-register callbacks via connect().
      if (!this.realtimeDisconnect) {
        this.setupRealtime();
      } else {
        this.config.transport.reconnect();
      }
      return;
    }

    // Polling mode: restart the poller and trigger a sync immediately.
    if (this.state.transportMode === 'polling') {
      this.setupPolling();
      // Trigger sync in background - errors are handled internally by sync()
      this.sync().catch((err) => {
        console.error('Unexpected error during reconnect sync:', err);
      });
    }
  }

  /**
   * Disconnect (pause syncing)
   */
  disconnect(): void {
    this.stop();
  }

  /**
   * Refresh outbox statistics
   */
  async refreshOutboxStats(options?: { emit?: boolean }): Promise<OutboxStats> {
    const db = this.config.db;

    const res = await sql<{ status: OutboxCommitStatus; count: number }>`
      select
        ${sql.ref('status')},
        count(${sql.ref('id')}) as ${sql.ref('count')}
      from ${sql.table('sync_outbox_commits')}
      group by ${sql.ref('status')}
    `.execute(db);
    const rows = res.rows;

    const stats: OutboxStats = {
      pending: 0,
      sending: 0,
      failed: 0,
      acked: 0,
      total: 0,
    };

    for (const row of rows) {
      const count = Number(row.count);
      switch (row.status) {
        case 'pending':
          stats.pending = count;
          break;
        case 'sending':
          stats.sending = count;
          break;
        case 'failed':
          stats.failed = count;
          break;
        case 'acked':
          stats.acked = count;
          break;
      }
      stats.total += count;
    }

    this.updateState({ pendingCount: stats.pending + stats.failed });
    if (options?.emit !== false) {
      this.emit('outbox:change', {
        pendingCount: stats.pending,
        sendingCount: stats.sending,
        failedCount: stats.failed,
        ackedCount: stats.acked,
      });
    }

    return stats;
  }

  /**
   * Get pending conflicts with operation details from outbox
   */
  async getConflicts(): Promise<ConflictInfo[]> {
    // Join with outbox to get operation details
    const res = await sql<{
      id: string;
      outbox_commit_id: string;
      client_commit_id: string;
      op_index: number;
      result_status: ConflictResultStatus;
      message: string;
      code: string | null;
      server_version: number | null;
      server_row_json: string | null;
      created_at: number;
      operations_json: string;
    }>`
      select
        ${sql.ref('c.id')},
        ${sql.ref('c.outbox_commit_id')},
        ${sql.ref('c.client_commit_id')},
        ${sql.ref('c.op_index')},
        ${sql.ref('c.result_status')},
        ${sql.ref('c.message')},
        ${sql.ref('c.code')},
        ${sql.ref('c.server_version')},
        ${sql.ref('c.server_row_json')},
        ${sql.ref('c.created_at')},
        ${sql.ref('oc.operations_json')}
      from ${sql.table('sync_conflicts')} as ${sql.ref('c')}
      inner join ${sql.table('sync_outbox_commits')} as ${sql.ref('oc')}
        on ${sql.ref('oc.id')} = ${sql.ref('c.outbox_commit_id')}
      where ${sql.ref('c.resolved_at')} is null
      order by ${sql.ref('c.created_at')} desc
    `.execute(this.config.db);
    const rows = res.rows;

    return rows.map((row) => {
      // Extract operation details from outbox
      let table = '';
      let rowId = '';
      let localPayload: Record<string, unknown> | null = null;

      if (row.operations_json) {
        try {
          const operations: unknown = JSON.parse(row.operations_json);
          if (Array.isArray(operations)) {
            const op = operations[row.op_index];
            if (isRecord(op)) {
              if (typeof op.table === 'string') table = op.table;
              if (typeof op.row_id === 'string') rowId = op.row_id;
              localPayload =
                op.payload === null
                  ? null
                  : isRecord(op.payload)
                    ? op.payload
                    : null;
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      return {
        id: row.id,
        outboxCommitId: row.outbox_commit_id,
        clientCommitId: row.client_commit_id,
        opIndex: row.op_index,
        resultStatus: row.result_status,
        message: row.message,
        code: row.code,
        serverVersion: row.server_version,
        serverRowJson: row.server_row_json,
        createdAt: row.created_at,
        table,
        rowId,
        localPayload,
      };
    });
  }

  /**
   * Update subscriptions dynamically
   */
  updateSubscriptions(
    subscriptions: Array<Omit<SyncSubscriptionRequest, 'cursor'>>
  ): void {
    this.config.subscriptions = subscriptions;
    // Trigger a sync to apply new subscriptions
    this.sync();
  }

  /**
   * Apply local mutations immediately to the database and emit change events.
   * Used for instant UI updates before the sync cycle completes.
   */
  async applyLocalMutation(
    inputs: Array<{
      table: string;
      rowId: string;
      op: 'upsert' | 'delete';
      payload?: Record<string, unknown> | null;
    }>
  ): Promise<void> {
    const db = this.config.db;
    const shapes = this.config.shapes;
    const affectedTables = new Set<string>();
    const now = Date.now();

    await db.transaction().execute(async (trx) => {
      for (const input of inputs) {
        const handler = shapes.get(input.table);
        if (!handler) continue;

        affectedTables.add(input.table);

        const change: SyncChange = {
          table: input.table,
          row_id: input.rowId,
          op: input.op,
          scopes: {},
          // For delete ops, row_json should be null; for upserts, default to empty object
          row_json: input.op === 'delete' ? null : (input.payload ?? {}),
          // null indicates local optimistic change (no server version yet)
          row_version: null,
        };

        await handler.applyChange({ trx }, change);
      }
    });

    // Track mutation timestamps for fingerprint-based rerender optimization (in-memory only)
    this.recordLocalMutations(
      inputs
        .filter((i) => affectedTables.has(i.table))
        .map((i) => ({ table: i.table, rowId: i.rowId, op: i.op })),
      now
    );
  }

  /**
   * Clear failed commits from the outbox.
   * Use this to discard commits that keep failing (e.g., version conflicts).
   */
  async clearFailedCommits(): Promise<number> {
    const db = this.config.db;

    const res = await sql`
      delete from ${sql.table('sync_outbox_commits')}
      where ${sql.ref('status')} = ${sql.val('failed')}
    `.execute(db);
    const count = Number(res.numAffectedRows ?? 0);

    await this.refreshOutboxStats();
    return count;
  }

  /**
   * Clear all pending and failed commits from the outbox.
   * Use this to reset the outbox completely (e.g., for testing).
   */
  async clearAllCommits(): Promise<number> {
    const db = this.config.db;

    const res = await sql`
      delete from ${sql.table('sync_outbox_commits')}
      where ${sql.ref('status')} in (${sql.join([
        sql.val('pending'),
        sql.val('failed'),
      ])})
    `.execute(db);
    const count = Number(res.numAffectedRows ?? 0);

    await this.refreshOutboxStats();
    return count;
  }
}
