/**
 * @syncular/client - Core sync engine
 *
 * Event-driven sync engine that manages push/pull cycles, connection state,
 * and provides a clean API for framework bindings to consume.
 */

import {
  captureSyncException,
  countSyncMetric,
  distributionSyncMetric,
  isRecord,
  type SyncChange,
  type SyncPullResponse,
  type SyncPullSubscriptionResponse,
  type SyncSubscriptionRequest,
  SyncTransportError,
  startSyncSpan,
} from '@syncular/core';
import { type Kysely, sql, type Transaction } from 'kysely';
import { getClientHandler } from '../handlers/collection';
import { ensureClientSyncSchema } from '../migrate';
import { syncPushOnce } from '../push-engine';
import type {
  ConflictResultStatus,
  OutboxCommitStatus,
  SyncClientDb,
} from '../schema';
import {
  DEFAULT_SYNC_STATE_ID,
  getSubscriptionState as readSubscriptionState,
  listSubscriptionStates as readSubscriptionStates,
  type SubscriptionState,
} from '../subscription-state';
import { syncOnce } from '../sync-loop';
import type {
  ConflictInfo,
  OutboxStats,
  PresenceEntry,
  RealtimeTransportLike,
  SubscriptionProgress,
  SyncAwaitBootstrapOptions,
  SyncAwaitPhaseOptions,
  SyncConnectionState,
  SyncDiagnostics,
  SyncEngineConfig,
  SyncEngineState,
  SyncError,
  SyncEventListener,
  SyncEventPayloads,
  SyncEventType,
  SyncInspectorEvent,
  SyncInspectorOptions,
  SyncInspectorSnapshot,
  SyncProgress,
  SyncRepairOptions,
  SyncResetOptions,
  SyncResetResult,
  SyncResult,
  SyncTransportMode,
  TransportHealth,
} from './types';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000;
const EXPONENTIAL_FACTOR = 2;
const REALTIME_RECONNECT_CATCHUP_DELAY_MS = 500;
const DEFAULT_AWAIT_TIMEOUT_MS = 60_000;
const DEFAULT_INSPECTOR_EVENT_LIMIT = 100;
const MAX_INSPECTOR_EVENT_LIMIT = 500;

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

function createSyncError(args: {
  code: SyncError['code'];
  message: string;
  cause?: Error;
  retryable?: boolean;
  httpStatus?: number;
  subscriptionId?: string;
  stateId?: string;
}): SyncError {
  return {
    code: args.code,
    message: args.message,
    cause: args.cause,
    timestamp: Date.now(),
    retryable: args.retryable ?? false,
    httpStatus: args.httpStatus,
    subscriptionId: args.subscriptionId,
    stateId: args.stateId,
  };
}

function classifySyncFailure(error: unknown): {
  code: SyncError['code'];
  message: string;
  cause: Error;
  retryable: boolean;
  httpStatus?: number;
} {
  const cause = error instanceof Error ? error : new Error(String(error));
  const message = cause.message || 'Sync failed';
  const normalized = message.toLowerCase();

  if (cause instanceof SyncTransportError) {
    if (cause.status === 401 || cause.status === 403) {
      return {
        code: 'AUTH_FAILED',
        message,
        cause,
        retryable: false,
        httpStatus: cause.status,
      };
    }

    if (
      cause.status === 404 &&
      normalized.includes('snapshot') &&
      normalized.includes('chunk')
    ) {
      return {
        code: 'SNAPSHOT_CHUNK_NOT_FOUND',
        message,
        cause,
        retryable: false,
        httpStatus: cause.status,
      };
    }

    if (
      cause.status !== undefined &&
      (cause.status >= 500 || cause.status === 408 || cause.status === 429)
    ) {
      return {
        code: 'NETWORK_ERROR',
        message,
        cause,
        retryable: true,
        httpStatus: cause.status,
      };
    }

    return {
      code: 'SYNC_ERROR',
      message,
      cause,
      retryable: false,
      httpStatus: cause.status,
    };
  }

  if (
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('timeout') ||
    normalized.includes('offline')
  ) {
    return {
      code: 'NETWORK_ERROR',
      message,
      cause,
      retryable: true,
    };
  }

  if (normalized.includes('conflict')) {
    return {
      code: 'CONFLICT',
      message,
      cause,
      retryable: false,
    };
  }

  return {
    code: 'SYNC_ERROR',
    message,
    cause,
    retryable: false,
  };
}

function resolveSyncTriggerLabel(
  trigger?: 'ws' | 'local' | 'poll'
): 'ws' | 'local' | 'poll' | 'auto' {
  return trigger ?? 'auto';
}

function serializeInspectorValue(value: unknown): unknown {
  const encoded = JSON.stringify(value, (_key, nextValue) => {
    if (nextValue instanceof Error) {
      return {
        name: nextValue.name,
        message: nextValue.message,
        stack: nextValue.stack,
      };
    }
    if (typeof nextValue === 'bigint') {
      return nextValue.toString();
    }
    return nextValue;
  });

  if (!encoded) return null;
  return JSON.parse(encoded) as unknown;
}

function serializeInspectorRecord(value: unknown): Record<string, unknown> {
  const serialized = serializeInspectorValue(value);
  if (isRecord(serialized)) {
    return serialized;
  }
  return { value: serialized };
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
  private realtimeCatchupTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private hasRealtimeConnectedOnce = false;
  private transportHealth: TransportHealth = {
    mode: 'disconnected',
    connected: false,
    lastSuccessfulPollAt: null,
    lastRealtimeMessageAt: null,
    fallbackReason: null,
  };
  private activeBootstrapSubscriptions = new Set<string>();
  private bootstrapStartedAt = new Map<string, number>();
  private inspectorEvents: SyncInspectorEvent[] = [];
  private nextInspectorEventId = 1;

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
    this.transportHealth = {
      mode: this.state.transportMode === 'polling' ? 'polling' : 'disconnected',
      connected: false,
      lastSuccessfulPollAt: null,
      lastRealtimeMessageAt: null,
      fallbackReason: null,
    };
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
      this.config.realtimeEnabled !== false &&
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
   * Get transport health details (realtime/polling/fallback).
   */
  getTransportHealth(): Readonly<TransportHealth> {
    return this.transportHealth;
  }

  /**
   * Get subscription state metadata for the current profile.
   */
  async listSubscriptionStates(args?: {
    stateId?: string;
    table?: string;
    status?: 'active' | 'revoked';
  }): Promise<SubscriptionState[]> {
    return readSubscriptionStates(this.config.db, {
      stateId: args?.stateId ?? this.getStateId(),
      table: args?.table,
      status: args?.status,
    });
  }

  /**
   * Get a single subscription state by id.
   */
  async getSubscriptionState(
    subscriptionId: string,
    options?: { stateId?: string }
  ): Promise<SubscriptionState | null> {
    return readSubscriptionState(this.config.db, {
      stateId: options?.stateId ?? this.getStateId(),
      subscriptionId,
    });
  }

  /**
   * Get normalized progress for all active subscriptions in this state profile.
   */
  async getProgress(): Promise<SyncProgress> {
    const subscriptions = await this.listSubscriptionStates();
    const progress = subscriptions.map((sub) =>
      this.mapSubscriptionToProgress(sub)
    );

    const channelPhase = this.resolveChannelPhase(progress);
    const hasSubscriptions = progress.length > 0;
    const basePercent = hasSubscriptions
      ? Math.round(
          progress.reduce((sum, item) => sum + item.progressPercent, 0) /
            progress.length
        )
      : this.state.lastSyncAt !== null
        ? 100
        : 0;

    const progressPercent =
      channelPhase === 'live'
        ? 100
        : Math.max(0, Math.min(100, Math.trunc(basePercent)));

    return {
      channelPhase,
      progressPercent,
      subscriptions: progress,
    };
  }

  /**
   * Wait until the channel reaches a target phase.
   */
  async awaitPhase(
    phase: SyncProgress['channelPhase'],
    options: SyncAwaitPhaseOptions = {}
  ): Promise<SyncProgress> {
    const timeoutMs = Math.max(
      0,
      options.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS
    );
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const progress = await this.getProgress();

      if (progress.channelPhase === phase) {
        return progress;
      }

      if (progress.channelPhase === 'error') {
        const message = this.state.error?.message ?? 'Sync entered error state';
        throw new Error(
          `[SyncEngine.awaitPhase] Failed while waiting for "${phase}": ${message}`
        );
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `[SyncEngine.awaitPhase] Timed out after ${timeoutMs}ms waiting for phase "${phase}"`
        );
      }

      await this.waitForProgressSignal(remainingMs);
    }
  }

  /**
   * Wait until bootstrap finishes for a state or a specific subscription.
   */
  async awaitBootstrapComplete(
    options: SyncAwaitBootstrapOptions = {}
  ): Promise<SyncProgress> {
    const timeoutMs = Math.max(
      0,
      options.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS
    );
    const stateId = options.stateId ?? this.getStateId();
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const states = await this.listSubscriptionStates({ stateId });
      const relevantStates =
        options.subscriptionId === undefined
          ? states
          : states.filter(
              (state) => state.subscriptionId === options.subscriptionId
            );

      const hasPendingBootstrap = relevantStates.some(
        (state) => state.status === 'active' && state.bootstrapState !== null
      );

      if (!hasPendingBootstrap) {
        return this.getProgress();
      }

      if (this.state.error) {
        throw new Error(
          `[SyncEngine.awaitBootstrapComplete] Failed while waiting for bootstrap completion: ${this.state.error.message}`
        );
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const target =
          options.subscriptionId === undefined
            ? `state "${stateId}"`
            : `subscription "${options.subscriptionId}" in state "${stateId}"`;

        throw new Error(
          `[SyncEngine.awaitBootstrapComplete] Timed out after ${timeoutMs}ms waiting for ${target}`
        );
      }

      await this.waitForProgressSignal(remainingMs);
    }
  }

  /**
   * Get a diagnostics snapshot suitable for debug UIs and bug reports.
   */
  async getDiagnostics(): Promise<SyncDiagnostics> {
    const [subscriptions, progress, outbox, conflicts] = await Promise.all([
      this.listSubscriptionStates(),
      this.getProgress(),
      this.refreshOutboxStats({ emit: false }),
      this.getConflicts(),
    ]);

    return {
      timestamp: Date.now(),
      state: this.state,
      transport: this.transportHealth,
      progress,
      outbox,
      conflictCount: conflicts.length,
      subscriptions,
    };
  }

  /**
   * Get a serializable inspector snapshot for app debug UIs and support tooling.
   */
  async getInspectorSnapshot(
    options: SyncInspectorOptions = {}
  ): Promise<SyncInspectorSnapshot> {
    const diagnostics = await this.getDiagnostics();
    const requestedLimit = options.eventLimit ?? DEFAULT_INSPECTOR_EVENT_LIMIT;
    const eventLimit = Math.max(
      0,
      Math.min(MAX_INSPECTOR_EVENT_LIMIT, requestedLimit)
    );
    const recentEvents =
      eventLimit === 0 ? [] : this.inspectorEvents.slice(-eventLimit);

    return {
      version: 1,
      generatedAt: Date.now(),
      diagnostics: serializeInspectorRecord(diagnostics),
      recentEvents,
    };
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

  private getStateId(): string {
    return this.config.stateId ?? DEFAULT_SYNC_STATE_ID;
  }

  private makeBootstrapKey(stateId: string, subscriptionId: string): string {
    return `${stateId}:${subscriptionId}`;
  }

  private updateTransportHealth(partial: Partial<TransportHealth>): void {
    this.transportHealth = {
      ...this.transportHealth,
      ...partial,
    };
    this.emit('state:change', {});
  }

  private waitForProgressSignal(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const cleanups: Array<() => void> = [];
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        for (const cleanup of cleanups) cleanup();
        resolve();
      };

      const listen = (event: SyncEventType) => {
        cleanups.push(this.on(event, finish));
      };

      listen('sync:start');
      listen('sync:complete');
      listen('sync:error');
      listen('sync:live');
      listen('bootstrap:start');
      listen('bootstrap:progress');
      listen('bootstrap:complete');

      const timeoutId = setTimeout(finish, Math.max(1, timeoutMs));
    });
  }

  private mapSubscriptionToProgress(
    subscription: SubscriptionState
  ): SubscriptionProgress {
    if (subscription.status === 'revoked') {
      return {
        stateId: subscription.stateId,
        id: subscription.subscriptionId,
        table: subscription.table,
        phase: 'error',
        progressPercent: 0,
        startedAt: subscription.createdAt,
        completedAt: subscription.updatedAt,
        lastErrorCode: 'SUBSCRIPTION_REVOKED',
        lastErrorMessage: 'Subscription is revoked',
      };
    }

    if (subscription.bootstrapState) {
      const tableCount = Math.max(0, subscription.bootstrapState.tables.length);
      const tableIndex = Math.max(0, subscription.bootstrapState.tableIndex);
      const tablesProcessed = Math.min(tableCount, tableIndex);
      const progressPercent =
        tableCount === 0
          ? 0
          : Math.max(
              0,
              Math.min(100, Math.round((tablesProcessed / tableCount) * 100))
            );

      return {
        stateId: subscription.stateId,
        id: subscription.subscriptionId,
        table: subscription.table,
        phase: 'bootstrapping',
        progressPercent,
        tablesProcessed,
        tablesTotal: tableCount,
        startedAt: this.bootstrapStartedAt.get(
          this.makeBootstrapKey(
            subscription.stateId,
            subscription.subscriptionId
          )
        ),
      };
    }

    if (this.state.error) {
      return {
        stateId: subscription.stateId,
        id: subscription.subscriptionId,
        table: subscription.table,
        phase: 'error',
        progressPercent: subscription.cursor >= 0 ? 100 : 0,
        startedAt: subscription.createdAt,
        lastErrorCode: this.state.error.code,
        lastErrorMessage: this.state.error.message,
      };
    }

    if (this.state.isSyncing) {
      return {
        stateId: subscription.stateId,
        id: subscription.subscriptionId,
        table: subscription.table,
        phase: 'catching_up',
        progressPercent: subscription.cursor >= 0 ? 90 : 0,
        startedAt: subscription.createdAt,
      };
    }

    if (subscription.cursor >= 0 || this.state.lastSyncAt !== null) {
      return {
        stateId: subscription.stateId,
        id: subscription.subscriptionId,
        table: subscription.table,
        phase: 'live',
        progressPercent: 100,
        startedAt: subscription.createdAt,
        completedAt: subscription.updatedAt,
      };
    }

    return {
      stateId: subscription.stateId,
      id: subscription.subscriptionId,
      table: subscription.table,
      phase: 'idle',
      progressPercent: 0,
      startedAt: subscription.createdAt,
    };
  }

  private resolveChannelPhase(
    subscriptions: SubscriptionProgress[]
  ): SyncProgress['channelPhase'] {
    if (this.state.error) return 'error';
    if (subscriptions.some((sub) => sub.phase === 'error')) return 'error';
    if (subscriptions.some((sub) => sub.phase === 'bootstrapping')) {
      return 'bootstrapping';
    }
    if (this.state.isSyncing) {
      return this.state.lastSyncAt === null ? 'starting' : 'catching_up';
    }
    if (this.state.lastSyncAt !== null) return 'live';
    return 'idle';
  }

  private deriveProgressFromPullSubscription(
    sub: SyncPullSubscriptionResponse
  ): SubscriptionProgress {
    const stateId = this.getStateId();
    const key = this.makeBootstrapKey(stateId, sub.id);
    const startedAt = this.bootstrapStartedAt.get(key);

    if (sub.status === 'revoked') {
      return {
        stateId,
        id: sub.id,
        phase: 'error',
        progressPercent: 0,
        startedAt,
        completedAt: Date.now(),
        lastErrorCode: 'SUBSCRIPTION_REVOKED',
        lastErrorMessage: 'Subscription is revoked',
      };
    }

    if (sub.bootstrap && sub.bootstrapState) {
      const tableCount = Math.max(0, sub.bootstrapState.tables.length);
      const tableIndex = Math.max(0, sub.bootstrapState.tableIndex);
      const tablesProcessed = Math.min(tableCount, tableIndex);
      const progressPercent =
        tableCount === 0
          ? 0
          : Math.max(
              0,
              Math.min(100, Math.round((tablesProcessed / tableCount) * 100))
            );

      return {
        stateId,
        id: sub.id,
        phase: 'bootstrapping',
        progressPercent,
        tablesProcessed,
        tablesTotal: tableCount,
        startedAt,
      };
    }

    return {
      stateId,
      id: sub.id,
      phase: this.state.isSyncing ? 'catching_up' : 'live',
      progressPercent: this.state.isSyncing ? 90 : 100,
      startedAt,
      completedAt: this.state.isSyncing ? undefined : Date.now(),
    };
  }

  private handleBootstrapLifecycle(response: SyncPullResponse): void {
    const stateId = this.getStateId();
    const now = Date.now();
    const seenKeys = new Set<string>();

    for (const sub of response.subscriptions ?? []) {
      const key = this.makeBootstrapKey(stateId, sub.id);
      seenKeys.add(key);
      const isBootstrapping = sub.bootstrap === true;
      const wasBootstrapping = this.activeBootstrapSubscriptions.has(key);

      if (isBootstrapping && !wasBootstrapping) {
        this.activeBootstrapSubscriptions.add(key);
        this.bootstrapStartedAt.set(key, now);
        this.emit('bootstrap:start', {
          timestamp: now,
          stateId,
          subscriptionId: sub.id,
        });
      }

      if (isBootstrapping) {
        this.emit('bootstrap:progress', {
          timestamp: now,
          stateId,
          subscriptionId: sub.id,
          progress: this.deriveProgressFromPullSubscription(sub),
        });
      }

      if (!isBootstrapping && wasBootstrapping) {
        const startedAt = this.bootstrapStartedAt.get(key) ?? now;
        this.activeBootstrapSubscriptions.delete(key);
        this.bootstrapStartedAt.delete(key);
        this.emit('bootstrap:complete', {
          timestamp: now,
          stateId,
          subscriptionId: sub.id,
          durationMs: Math.max(0, now - startedAt),
        });
      }
    }

    for (const key of Array.from(this.activeBootstrapSubscriptions)) {
      if (seenKeys.has(key)) continue;
      if (!key.startsWith(`${stateId}:`)) continue;
      const subscriptionId = key.slice(stateId.length + 1);
      if (!subscriptionId) continue;

      const startedAt = this.bootstrapStartedAt.get(key) ?? now;
      this.activeBootstrapSubscriptions.delete(key);
      this.bootstrapStartedAt.delete(key);
      this.emit('bootstrap:complete', {
        timestamp: now,
        stateId,
        subscriptionId,
        durationMs: Math.max(0, now - startedAt),
      });
    }

    if (this.activeBootstrapSubscriptions.size === 0 && !this.state.error) {
      this.emit('sync:live', { timestamp: now });
    }
  }

  private async resolveResetTargets(
    options: SyncResetOptions
  ): Promise<SubscriptionState[]> {
    const stateId = options.stateId ?? this.getStateId();

    if (options.scope === 'all') {
      return readSubscriptionStates(this.config.db);
    }

    if (options.scope === 'state') {
      return readSubscriptionStates(this.config.db, { stateId });
    }

    const subscriptionIds = options.subscriptionIds ?? [];
    if (subscriptionIds.length === 0) {
      throw new Error(
        '[SyncEngine.reset] subscriptionIds is required when scope="subscription"'
      );
    }

    const allInState = await readSubscriptionStates(this.config.db, {
      stateId,
    });
    const wanted = new Set(subscriptionIds);
    return allInState.filter((state) => wanted.has(state.subscriptionId));
  }

  private async clearSyncedTablesForReset(
    trx: Transaction<DB>,
    options: SyncResetOptions,
    targets: SubscriptionState[]
  ): Promise<string[]> {
    const clearedTables: string[] = [];

    if (!options.clearSyncedTables) {
      return clearedTables;
    }

    if (options.scope === 'all') {
      for (const handler of this.config.handlers) {
        await handler.clearAll({ trx, scopes: {} });
        clearedTables.push(handler.table);
      }
      return clearedTables;
    }

    const seen = new Set<string>();
    for (const target of targets) {
      const handler = getClientHandler(this.config.handlers, target.table);
      if (!handler) continue;

      const key = `${target.table}:${JSON.stringify(target.scopes)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      await handler.clearAll({ trx, scopes: target.scopes });
      clearedTables.push(target.table);
    }

    return clearedTables;
  }

  async reset(options: SyncResetOptions): Promise<SyncResetResult> {
    const resetOptions: SyncResetOptions = {
      clearOutbox: false,
      clearConflicts: false,
      clearSyncedTables: false,
      ...options,
    };
    const targets = await this.resolveResetTargets(resetOptions);
    const stateId = resetOptions.stateId ?? this.getStateId();

    this.stop();

    const result = await this.config.db.transaction().execute(async (trx) => {
      const clearedTables = await this.clearSyncedTablesForReset(
        trx,
        resetOptions,
        targets
      );

      let deletedSubscriptionStates = 0;
      if (resetOptions.scope === 'all') {
        const res = await sql`
          delete from ${sql.table('sync_subscription_state')}
        `.execute(trx);
        deletedSubscriptionStates = Number(res.numAffectedRows ?? 0);
      } else if (resetOptions.scope === 'state') {
        const res = await sql`
          delete from ${sql.table('sync_subscription_state')}
          where ${sql.ref('state_id')} = ${sql.val(stateId)}
        `.execute(trx);
        deletedSubscriptionStates = Number(res.numAffectedRows ?? 0);
      } else {
        const subscriptionIds = resetOptions.subscriptionIds ?? [];
        const res = await sql`
          delete from ${sql.table('sync_subscription_state')}
          where
            ${sql.ref('state_id')} = ${sql.val(stateId)}
            and ${sql.ref('subscription_id')} in (${sql.join(
              subscriptionIds.map((id) => sql.val(id))
            )})
        `.execute(trx);
        deletedSubscriptionStates = Number(res.numAffectedRows ?? 0);
      }

      let deletedOutboxCommits = 0;
      if (resetOptions.clearOutbox) {
        const res = await sql`
          delete from ${sql.table('sync_outbox_commits')}
        `.execute(trx);
        deletedOutboxCommits = Number(res.numAffectedRows ?? 0);
      }

      let deletedConflicts = 0;
      if (resetOptions.clearConflicts) {
        const res = await sql`
          delete from ${sql.table('sync_conflicts')}
        `.execute(trx);
        deletedConflicts = Number(res.numAffectedRows ?? 0);
      }

      return {
        deletedSubscriptionStates,
        deletedOutboxCommits,
        deletedConflicts,
        clearedTables,
      };
    });

    if (resetOptions.scope === 'all') {
      this.activeBootstrapSubscriptions.clear();
      this.bootstrapStartedAt.clear();
    } else {
      for (const target of targets) {
        const key = this.makeBootstrapKey(
          target.stateId,
          target.subscriptionId
        );
        this.activeBootstrapSubscriptions.delete(key);
        this.bootstrapStartedAt.delete(key);
      }
    }

    this.resetLocalState();
    await this.refreshOutboxStats();
    this.updateState({ error: null });

    return result;
  }

  async repair(options: SyncRepairOptions): Promise<SyncResetResult> {
    if (options.mode !== 'rebootstrap-missing-chunks') {
      throw new Error(
        `[SyncEngine.repair] Unsupported repair mode: ${options.mode}`
      );
    }

    return this.reset({
      scope: options.subscriptionIds ? 'subscription' : 'state',
      stateId: options.stateId,
      subscriptionIds: options.subscriptionIds,
      clearOutbox: options.clearOutbox ?? false,
      clearConflicts: options.clearConflicts ?? false,
      clearSyncedTables: true,
    });
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
    this.inspectorEvents.push({
      id: this.nextInspectorEventId++,
      event,
      timestamp: Date.now(),
      payload: serializeInspectorRecord(payload),
    });
    if (this.inspectorEvents.length > MAX_INSPECTOR_EVENT_LIMIT) {
      this.inspectorEvents.splice(
        0,
        this.inspectorEvents.length - MAX_INSPECTOR_EVENT_LIMIT
      );
    }

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

    // Run migrations before first sync.
    if (!this.migrated) {
      // Best-effort: push pending commits before user migration, because
      // app migrations may reset tables and discard unsynced local writes.
      if (this.config.migrate) {
        try {
          const hasOutbox = await sql`
            select 1 from ${sql.table('sync_outbox_commits')} limit 1
          `
            .execute(this.config.db)
            .then((r) => r.rows.length > 0)
            .catch(() => false);

          if (hasOutbox) {
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
          // Best-effort: continue even if pre-migration push fails.
        }
      }

      try {
        if (this.config.migrate) {
          await this.config.migrate(this.config.db);
        }
        await ensureClientSyncSchema(this.config.db);
        this.migrated = true;
      } catch (err) {
        const migrationError =
          err instanceof Error ? err : new Error(String(err));
        this.config.onMigrationError?.(migrationError);
        const error = createSyncError({
          code: 'MIGRATION_FAILED',
          message: 'Migration failed',
          cause: migrationError,
          retryable: false,
          stateId: this.getStateId(),
        });
        this.updateState({
          isSyncing: false,
          error,
        });
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
    if (this.realtimeCatchupTimeoutId) {
      clearTimeout(this.realtimeCatchupTimeoutId);
      this.realtimeCatchupTimeoutId = null;
    }
  }

  /**
   * Trigger a manual sync
   */
  async sync(opts?: {
    trigger?: 'ws' | 'local' | 'poll';
  }): Promise<SyncResult> {
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
        error: createSyncError({
          code: 'SYNC_ERROR',
          message: 'Sync not enabled',
          retryable: false,
          stateId: this.getStateId(),
        }),
      };
    }

    this.syncPromise = this.performSyncLoop(opts?.trigger);
    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  private async performSyncLoop(
    trigger?: 'ws' | 'local' | 'poll'
  ): Promise<SyncResult> {
    let lastResult: SyncResult = {
      success: false,
      pushedCommits: 0,
      pullRounds: 0,
      pullResponse: { ok: true, subscriptions: [] },
      error: createSyncError({
        code: 'SYNC_ERROR',
        message: 'Sync not started',
        retryable: false,
        stateId: this.getStateId(),
      }),
    };

    do {
      this.syncRequestedWhileRunning = false;
      lastResult = await this.performSyncOnce(trigger);
      // After the first iteration, clear trigger context
      trigger = undefined;
      // If the sync failed, let retry logic handle backoff instead of tight looping.
      if (!lastResult.success) break;
    } while (
      this.syncRequestedWhileRunning &&
      !this.isDestroyed &&
      this.isEnabled()
    );

    return lastResult;
  }

  private async performSyncOnce(
    trigger?: 'ws' | 'local' | 'poll'
  ): Promise<SyncResult> {
    const timestamp = Date.now();
    const startedAtMs = timestamp;
    const triggerLabel = resolveSyncTriggerLabel(trigger);
    this.updateState({ isSyncing: true });
    this.emit('sync:start', { timestamp });
    countSyncMetric('sync.client.sync.attempts', 1, {
      attributes: { trigger: triggerLabel },
    });

    try {
      const pullApplyTimestamp = Date.now();
      const result = await startSyncSpan(
        {
          name: 'sync.client.sync',
          op: 'sync.client.sync',
          attributes: { trigger: triggerLabel },
        },
        () =>
          syncOnce(
            this.config.db,
            this.config.transport,
            this.config.handlers,
            {
              clientId: this.config.clientId!,
              actorId: this.config.actorId ?? undefined,
              plugins: this.config.plugins,
              subscriptions: this.config
                .subscriptions as SyncSubscriptionRequest[],
              limitCommits: this.config.limitCommits,
              limitSnapshotRows: this.config.limitSnapshotRows,
              maxSnapshotPages: this.config.maxSnapshotPages,
              stateId: this.config.stateId,
              sha256: this.config.sha256,
              trigger,
            }
          )
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
      this.updateTransportHealth({
        lastSuccessfulPollAt: Date.now(),
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
      this.handleBootstrapLifecycle(result.pullResponse);

      // Refresh outbox stats (fire-and-forget — don't block sync:complete)
      this.refreshOutboxStats().catch((error) => {
        console.warn(
          '[SyncEngine] Failed to refresh outbox stats after sync:',
          error
        );
      });

      const durationMs = Math.max(0, Date.now() - startedAtMs);
      countSyncMetric('sync.client.sync.results', 1, {
        attributes: {
          trigger: triggerLabel,
          status: 'success',
        },
      });
      distributionSyncMetric('sync.client.sync.duration_ms', durationMs, {
        unit: 'millisecond',
        attributes: {
          trigger: triggerLabel,
          status: 'success',
        },
      });
      distributionSyncMetric(
        'sync.client.sync.pushed_commits',
        result.pushedCommits,
        {
          attributes: { trigger: triggerLabel },
        }
      );
      distributionSyncMetric(
        'sync.client.sync.pull_rounds',
        result.pullRounds,
        {
          attributes: { trigger: triggerLabel },
        }
      );

      return syncResult;
    } catch (err) {
      const classified = classifySyncFailure(err);
      const error = createSyncError({
        code: classified.code,
        message: classified.message,
        cause: classified.cause,
        retryable: classified.retryable,
        httpStatus: classified.httpStatus,
        stateId: this.getStateId(),
      });

      this.updateState({
        isSyncing: false,
        error,
        retryCount: this.state.retryCount + 1,
        isRetrying: false,
      });

      this.handleError(error);

      const durationMs = Math.max(0, Date.now() - startedAtMs);
      countSyncMetric('sync.client.sync.results', 1, {
        attributes: {
          trigger: triggerLabel,
          status: 'error',
        },
      });
      distributionSyncMetric('sync.client.sync.duration_ms', durationMs, {
        unit: 'millisecond',
        attributes: {
          trigger: triggerLabel,
          status: 'error',
        },
      });
      captureSyncException(err, {
        event: 'sync.client.sync',
        trigger: triggerLabel,
      });

      // Schedule retry if under max retries
      const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
      if (error.retryable && this.state.retryCount < maxRetries) {
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

  /**
   * Apply changes delivered inline over WebSocket for instant UI updates.
   * Returns true if changes were applied and cursor updated successfully,
   * false if anything failed (caller should fall back to HTTP sync).
   */
  private async applyWsDeliveredChanges(
    changes: SyncChange[],
    cursor: number
  ): Promise<boolean> {
    try {
      await this.config.db.transaction().execute(async (trx) => {
        for (const change of changes) {
          const handler = getClientHandler(this.config.handlers, change.table);
          if (!handler) {
            throw new Error(
              `Missing client table handler for WS change table "${change.table}"`
            );
          }
          await handler.applyChange({ trx }, change);
        }

        // Update subscription cursors
        const stateId = this.config.stateId ?? 'default';
        await sql`
          update ${sql.table('sync_subscription_state')}
          set ${sql.ref('cursor')} = ${sql.val(cursor)}
          where ${sql.ref('state_id')} = ${sql.val(stateId)}
            and ${sql.ref('cursor')} < ${sql.val(cursor)}
        `.execute(trx);
      });

      // Update mutation timestamps BEFORE emitting data:change so that
      // React hooks re-querying the DB see fresh fingerprints immediately.
      const now = Date.now();
      for (const change of changes) {
        if (!change.table || !change.row_id) continue;
        if (change.op === 'delete') {
          this.mutationTimestamps.delete(`${change.table}:${change.row_id}`);
        } else {
          this.bumpMutationTimestamp(change.table, change.row_id, now);
        }
      }

      // Emit data change for immediate UI update
      const changedTables = [...new Set(changes.map((c) => c.table))];
      if (changedTables.length > 0) {
        this.emit('data:change', {
          scopes: changedTables,
          timestamp: Date.now(),
        });
        this.config.onDataChange?.(changedTables);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Handle WS-delivered changes: apply them and decide whether to skip HTTP pull.
   * Falls back to full HTTP sync when conditions require it.
   */
  private async handleWsDelivery(
    changes: SyncChange[],
    cursor: number
  ): Promise<void> {
    // If a sync is already in-flight, let it handle everything
    if (this.syncPromise) {
      countSyncMetric('sync.client.ws.delivery.events', 1, {
        attributes: { path: 'inflight_sync' },
      });
      this.triggerSyncInBackground(
        { trigger: 'ws' },
        'ws delivery with in-flight sync'
      );
      return;
    }

    // If there are pending outbox commits, need to push via HTTP
    if (this.state.pendingCount > 0) {
      countSyncMetric('sync.client.ws.delivery.events', 1, {
        attributes: { path: 'pending_outbox' },
      });
      this.triggerSyncInBackground(
        { trigger: 'ws' },
        'ws delivery with pending outbox'
      );
      return;
    }

    // If afterPull plugins exist, inline WS changes may require transforms
    // (e.g. decryption). Fall back to HTTP sync and do not apply inline payload.
    const hasAfterPullPlugins = this.config.plugins?.some(
      (p) => typeof p.afterPull === 'function'
    );
    if (hasAfterPullPlugins) {
      countSyncMetric('sync.client.ws.delivery.events', 1, {
        attributes: { path: 'after_pull_plugins' },
      });
      this.triggerSyncInBackground(
        { trigger: 'ws' },
        'ws delivery with afterPull plugins'
      );
      return;
    }

    // Apply changes + update cursor
    const inlineApplyStartedAtMs = Date.now();
    const applied = await this.applyWsDeliveredChanges(changes, cursor);
    const inlineApplyDurationMs = Math.max(
      0,
      Date.now() - inlineApplyStartedAtMs
    );
    distributionSyncMetric(
      'sync.client.ws.inline_apply.duration_ms',
      inlineApplyDurationMs,
      {
        unit: 'millisecond',
      }
    );

    if (!applied) {
      countSyncMetric('sync.client.ws.delivery.events', 1, {
        attributes: { path: 'inline_fallback' },
      });
      this.triggerSyncInBackground(
        { trigger: 'ws' },
        'ws inline apply fallback'
      );
      return;
    }

    // All clear — skip HTTP pull entirely
    countSyncMetric('sync.client.ws.delivery.events', 1, {
      attributes: { path: 'inline_applied' },
    });
    this.updateState({
      lastSyncAt: Date.now(),
      error: null,
      retryCount: 0,
      isRetrying: false,
    });
    this.updateTransportHealth({
      mode: 'realtime',
      connected: true,
      fallbackReason: null,
      lastSuccessfulPollAt: Date.now(),
    });

    this.emit('sync:complete', {
      timestamp: Date.now(),
      pushedCommits: 0,
      pullRounds: 0,
      pullResponse: { ok: true, subscriptions: [] },
    });
    this.emit('sync:live', { timestamp: Date.now() });

    this.refreshOutboxStats().catch((error) => {
      console.warn(
        '[SyncEngine] Failed to refresh outbox stats after WS apply:',
        error
      );
    });
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
        this.triggerSyncInBackground(undefined, 'retry timer');
      }
    }, delay);
  }

  private handleError(error: SyncError): void {
    this.emit('sync:error', error);
    this.config.onError?.(error);
  }

  private triggerSyncInBackground(
    opts?: { trigger?: 'ws' | 'local' | 'poll' },
    reason = 'background'
  ): void {
    void this.sync(opts).catch((error) => {
      console.error(
        `[SyncEngine] Unexpected sync failure during ${reason}:`,
        error
      );
    });
  }

  private setupPolling(): void {
    this.stopPolling();

    const interval = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollerId = setInterval(() => {
      if (!this.state.isSyncing && !this.isDestroyed) {
        this.triggerSyncInBackground(undefined, 'polling interval');
      }
    }, interval);

    this.setConnectionState('connected');
    this.updateTransportHealth({
      mode: 'polling',
      connected: true,
      fallbackReason: null,
    });
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
    this.updateTransportHealth({
      mode: 'disconnected',
      connected: false,
      fallbackReason: null,
    });

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
          this.updateTransportHealth({
            lastRealtimeMessageAt: Date.now(),
          });
          countSyncMetric('sync.client.ws.events', 1, {
            attributes: { type: 'sync' },
          });
          const hasInlineChanges =
            Array.isArray(event.data.changes) && event.data.changes.length > 0;
          const cursor = event.data.cursor;

          if (hasInlineChanges && typeof cursor === 'number') {
            // WS delivered changes + cursor — may skip HTTP pull
            this.handleWsDelivery(event.data.changes as SyncChange[], cursor);
          } else {
            // Cursor-only wake-up or no cursor — must HTTP sync
            countSyncMetric('sync.client.ws.delivery.events', 1, {
              attributes: { path: 'cursor_wakeup' },
            });
            this.triggerSyncInBackground({ trigger: 'ws' }, 'ws cursor wakeup');
          }
        }
      },
      (state) => {
        switch (state) {
          case 'connected': {
            const wasConnectedBefore = this.hasRealtimeConnectedOnce;
            this.hasRealtimeConnectedOnce = true;
            this.setConnectionState('connected');
            this.updateTransportHealth({
              mode: 'realtime',
              connected: true,
              fallbackReason: null,
            });
            this.stopFallbackPolling();
            this.triggerSyncInBackground(undefined, 'realtime connected state');
            if (wasConnectedBefore) {
              this.scheduleRealtimeReconnectCatchupSync();
            }
            break;
          }
          case 'connecting':
            this.setConnectionState('connecting');
            this.updateTransportHealth({
              mode: 'disconnected',
              connected: false,
            });
            break;
          case 'disconnected':
            this.setConnectionState('reconnecting');
            this.updateTransportHealth({
              mode: 'disconnected',
              connected: false,
            });
            this.startFallbackPolling();
            break;
        }
      }
    );
  }

  private stopRealtime(): void {
    if (this.realtimeCatchupTimeoutId) {
      clearTimeout(this.realtimeCatchupTimeoutId);
      this.realtimeCatchupTimeoutId = null;
    }
    if (this.realtimePresenceUnsub) {
      this.realtimePresenceUnsub();
      this.realtimePresenceUnsub = null;
    }
    if (this.realtimeDisconnect) {
      this.realtimeDisconnect();
      this.realtimeDisconnect = null;
    }
    this.stopFallbackPolling();
    this.updateTransportHealth({
      mode: 'disconnected',
      connected: false,
    });
  }

  private scheduleRealtimeReconnectCatchupSync(): void {
    if (this.realtimeCatchupTimeoutId) {
      clearTimeout(this.realtimeCatchupTimeoutId);
    }

    this.realtimeCatchupTimeoutId = setTimeout(() => {
      this.realtimeCatchupTimeoutId = null;

      if (this.isDestroyed || !this.isEnabled()) return;
      if (this.state.connectionState !== 'connected') return;

      this.triggerSyncInBackground(undefined, 'realtime reconnect catchup');
    }, REALTIME_RECONNECT_CATCHUP_DELAY_MS);
  }

  private startFallbackPolling(): void {
    if (this.fallbackPollerId) return;

    const interval = this.config.realtimeFallbackPollMs ?? 30_000;
    this.updateTransportHealth({
      mode: 'polling',
      connected: false,
      fallbackReason: 'network',
    });
    this.fallbackPollerId = setInterval(() => {
      if (!this.state.isSyncing && !this.isDestroyed) {
        this.triggerSyncInBackground(undefined, 'realtime fallback poll');
      }
    }, interval);
  }

  private stopFallbackPolling(): void {
    if (this.fallbackPollerId) {
      clearInterval(this.fallbackPollerId);
      this.fallbackPollerId = null;
    }
    this.updateTransportHealth({ fallbackReason: null });
  }

  /**
   * Clear all in-memory mutation state and emit data:change so UI re-renders.
   * Call this after deleting local data (e.g. reset flow) so that React hooks
   * recompute fingerprints from scratch instead of seeing stale timestamps.
   */
  resetLocalState(): void {
    const tables = [...this.tableMutationTimestamps.keys()];
    this.mutationTimestamps.clear();
    this.tableMutationTimestamps.clear();

    if (tables.length > 0) {
      this.emit('data:change', {
        scopes: tables,
        timestamp: Date.now(),
      });
      this.config.onDataChange?.(tables);
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
      this.triggerSyncInBackground(undefined, 'reconnect');
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
    this.triggerSyncInBackground(undefined, 'subscription update');
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
    const handlers = this.config.handlers;
    const affectedTables = new Set<string>();
    const now = Date.now();

    await db.transaction().execute(async (trx) => {
      for (const input of inputs) {
        const handler = getClientHandler(handlers, input.table);
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
