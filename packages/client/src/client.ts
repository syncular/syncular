import type { BlobRef, SyncAuthLeaseIssueRequest } from '@syncular/core';
import type { SyncularDatabase } from './database';
import { isSyncularOfflineError } from './errors';
import type { MutationsApi } from './mutations';
import { browserSyncularNetworkStatusSource } from './network';
import type {
  SyncularAuthLeaseRecord,
  SyncularBlobUploadQueueProcessOptions,
  SyncularBlobUploadQueueStats,
  SyncularClientEventSink,
  SyncularClientEventType,
  SyncularConflictResolution,
  SyncularConflictStats,
  SyncularConflictSummary,
  SyncularConnectionState,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
  SyncularLifecycleState,
  SyncularNetworkStatusSource,
  SyncularOutboxStats,
  SyncularPresenceEntry,
  SyncularPresenceSink,
  SyncularRealtimeConnectionState,
  SyncularRealtimeOptions,
  SyncularRuntimeClient,
  SyncularSubscriptionSpec,
  SyncularSyncRequestOptions,
  SyncularSyncResult,
} from './types';

export interface SyncularClientLifecycleOptions {
  initialSync?: boolean;
  realtime?: boolean | SyncularRealtimeOptions;
  syncOnRealtimeConnect?: boolean;
  pollIntervalMs?: number | false;
  network?: SyncularNetworkStatusSource | false;
  subscriptions?: readonly SyncularSubscriptionSpec[];
}

export interface SyncularClientStatus {
  lifecycle: SyncularLifecycleState;
  connection: SyncularConnectionState;
  outbox: SyncularOutboxStats | null;
  conflicts: SyncularConflictStats | null;
  isConnected: boolean;
  isSyncing: boolean;
  hasPendingMutations: boolean;
  hasConflicts: boolean;
  requiresAction: boolean;
}

export interface SyncularBlobClientLike {
  getUploadQueueStats(): Promise<SyncularBlobUploadQueueStats>;
  processUploadQueue(
    options?: SyncularBlobUploadQueueProcessOptions
  ): Promise<{ uploaded: number; failed: number }>;
  retrieve(ref: BlobRef): Promise<Uint8Array>;
}

export interface SyncularPresenceClientLike {
  get<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularPresenceEntry<TMetadata>[];
  join(scopeKey: string, metadata?: Record<string, unknown>): void;
  leave(scopeKey: string): void;
  updateMetadata(scopeKey: string, metadata: Record<string, unknown>): void;
  onChange<TMetadata = Record<string, unknown>>(
    listener: SyncularPresenceSink<TMetadata>
  ): () => void;
}

export interface SyncularConflictsClientLike {
  list(): Promise<SyncularConflictSummary[]>;
  retryKeepLocal(id: string): Promise<string>;
  resolve(id: string, resolution: SyncularConflictResolution): Promise<void>;
}

export interface SyncularClientLike<DB> {
  db: SyncularDatabase<DB>['db'];
  dialect?: SyncularDatabase<DB>['dialect'] | unknown;
  mutations: MutationsApi<DB, any>;
  leasedMutations: MutationsApi<DB, any>;
  blobs: SyncularBlobClientLike;
  on<T extends SyncularClientEventType>(
    event: T,
    listener: SyncularClientEventSink<T>
  ): () => void;
  getStatus(): SyncularClientStatus;
  setSubscriptions(
    subscriptions: readonly SyncularSubscriptionSpec[]
  ): Promise<void>;
  resumeFromBackground(
    options?: SyncularSyncRequestOptions
  ): Promise<SyncularSyncResult>;
  schemaReadiness: SyncularDatabase<DB>['schemaReadiness'];
  issueAuthLease(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularAuthLeaseRecord>;
  upsertAuthLease(lease: SyncularAuthLeaseRecord): Promise<void>;
  authLease(leaseId: string): Promise<SyncularAuthLeaseRecord | null>;
  activeAuthLeases(
    actorId?: string | null,
    nowMs?: number
  ): Promise<SyncularAuthLeaseRecord[]>;
  diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot>;
  presence: SyncularPresenceClientLike;
  conflicts: SyncularConflictsClientLike;
  start(): Promise<void>;
  stop(): Promise<void>;
  sync(): Promise<SyncularSyncResult>;
  close(): Promise<void>;
}

type LifecycleClient = Pick<
  SyncularRuntimeClient,
  | 'addDiagnosticListener'
  | 'connectionState'
  | 'forceSubscriptionsBootstrap'
  | 'setSubscriptions'
  | 'startRealtime'
  | 'stopRealtime'
  | 'syncOnce'
>;

type QueuedSyncWaiter = {
  resolve(result: SyncularSyncResult): void;
  reject(error: unknown): void;
};

export function getSyncularClientStatus(
  client: Pick<SyncularRuntimeClient, 'connectionState' | 'lifecycleState'>
): SyncularClientStatus {
  const lifecycle = client.lifecycleState();
  const connection = client.connectionState();
  const outbox = lifecycle.outbox ?? null;
  const conflicts = lifecycle.conflicts ?? null;
  return {
    lifecycle,
    connection,
    outbox,
    conflicts,
    isConnected: connection.realtime === 'connected' && !connection.closed,
    isSyncing:
      lifecycle.phase === 'syncing' || lifecycle.phase === 'recovering',
    hasPendingMutations: (outbox?.pending ?? 0) + (outbox?.sending ?? 0) > 0,
    hasConflicts: (conflicts?.unresolved ?? 0) > 0,
    requiresAction: lifecycle.requiresAction,
  };
}

export class SyncularClientLifecycle {
  #started = false;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #unsubscribeDiagnostics: (() => void) | undefined;
  #unsubscribeNetwork: (() => void) | undefined;
  #syncInFlight: Promise<SyncularSyncResult> | undefined;
  #queuedSyncWaiters: QueuedSyncWaiter[] = [];
  #hasConnectedRealtime = false;
  #realtimeStarted = false;
  readonly #network: SyncularNetworkStatusSource | undefined;

  constructor(
    private readonly client: LifecycleClient,
    private readonly options: SyncularClientLifecycleOptions = {}
  ) {
    this.#network =
      options.network === false
        ? undefined
        : (options.network ?? browserSyncularNetworkStatusSource());
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#hasConnectedRealtime =
      this.client.connectionState().realtime === 'connected';
    this.#realtimeStarted = this.#hasConnectedRealtime;
    this.#unsubscribeDiagnostics = this.client.addDiagnosticListener((event) =>
      this.#handleDiagnostic(event)
    );
    this.#unsubscribeNetwork = this.#subscribeNetworkEvents();
    try {
      if (this.options.subscriptions) {
        await this.client.setSubscriptions(this.options.subscriptions);
      }
      if (this.options.initialSync !== false && this.#isOnline()) {
        await this.#syncForLifecycle();
      }
      if (this.options.realtime !== false && this.#isOnline()) {
        await this.#startRealtimeForLifecycle();
      }
      this.#startPolling();
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#stopPolling();
    this.#unsubscribeDiagnostics?.();
    this.#unsubscribeDiagnostics = undefined;
    this.#unsubscribeNetwork?.();
    this.#unsubscribeNetwork = undefined;
    this.#rejectQueuedSyncWaiters(
      new Error('Syncular lifecycle stopped before queued sync could run')
    );
    if (this.options.realtime !== false) {
      await this.client.stopRealtime();
    }
    this.#realtimeStarted = false;
  }

  async sync(): Promise<SyncularSyncResult> {
    if (this.#syncInFlight) {
      return new Promise((resolve, reject) => {
        this.#queuedSyncWaiters.push({ resolve, reject });
      });
    }
    this.#syncInFlight = this.#startSyncCycle();
    return this.#syncInFlight;
  }

  #startSyncCycle(): Promise<SyncularSyncResult> {
    let sync: Promise<SyncularSyncResult>;
    try {
      sync = Promise.resolve(this.client.syncOnce());
    } catch (error) {
      sync = Promise.reject(error);
    }
    const finish = () => {
      if (this.#syncInFlight === sync) {
        this.#syncInFlight = undefined;
      }
      const waiters = this.#queuedSyncWaiters.splice(0);
      if (waiters.length === 0) return;
      if (!this.#started) {
        const error = new Error(
          'Syncular lifecycle stopped before queued sync could run'
        );
        for (const waiter of waiters) waiter.reject(error);
        return;
      }
      const queued = this.#startSyncCycle();
      this.#syncInFlight = queued;
      queued.then(
        (result) => {
          for (const waiter of waiters) waiter.resolve(result);
        },
        (error) => {
          for (const waiter of waiters) waiter.reject(error);
        }
      );
    };
    void sync.then(finish, finish).catch((error) => {
      this.#rejectQueuedSyncWaiters(error);
    });
    return sync;
  }

  #rejectQueuedSyncWaiters(error: unknown): void {
    const waiters = this.#queuedSyncWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  #handleDiagnostic(event: SyncularDiagnosticEvent): void {
    if (event.source === 'sync' && event.details?.resyncRequired === true) {
      void this.client
        .forceSubscriptionsBootstrap()
        .then(() => this.sync())
        .catch(() => undefined);
      return;
    }
    if (
      event.source !== 'realtime' ||
      event.code !== 'realtime.state' ||
      event.details?.state == null
    ) {
      return;
    }
    const state = event.details.state as SyncularRealtimeConnectionState;
    if (state !== 'connected') return;
    const wasReconnect = this.#hasConnectedRealtime;
    this.#hasConnectedRealtime = true;
    const shouldSync =
      this.options.syncOnRealtimeConnect !== false &&
      (wasReconnect || this.options.initialSync === false);
    if (!shouldSync) return;
    void this.sync().catch(() => undefined);
  }

  #subscribeNetworkEvents(): (() => void) | undefined {
    const network = this.#network;
    if (!network?.addEventListener || !network.removeEventListener) return;
    const handleOnline = () => {
      if (!this.#started) return;
      void this.#resumeOnline().catch(() => undefined);
    };
    network.addEventListener('online', handleOnline);
    return () => {
      network.removeEventListener?.('online', handleOnline);
    };
  }

  async #resumeOnline(): Promise<void> {
    if (!this.#started || !this.#isOnline()) return;
    if (this.options.initialSync !== false) {
      await this.#syncForLifecycle();
    }
    if (this.options.realtime !== false && !this.#realtimeStarted) {
      await this.#startRealtimeForLifecycle();
    }
  }

  async #syncForLifecycle(): Promise<void> {
    try {
      await this.sync();
    } catch (error) {
      if (!isSyncularOfflineError(error)) throw error;
    }
  }

  async #startRealtimeForLifecycle(): Promise<void> {
    try {
      await this.client.startRealtime(this.options.realtime);
      this.#realtimeStarted = true;
    } catch (error) {
      this.#realtimeStarted = false;
      if (!isSyncularOfflineError(error)) throw error;
    }
  }

  #isOnline(): boolean {
    return this.#network?.isOnline() !== false;
  }

  #startPolling(): void {
    const interval = this.options.pollIntervalMs;
    if (interval === false || interval === undefined || interval <= 0) return;
    this.#pollTimer = setInterval(() => {
      if (!this.#isOnline()) return;
      void this.#syncForLifecycle();
    }, interval);
  }

  #stopPolling(): void {
    if (!this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }
}
