import type { BlobRef, SyncAuthLeaseIssueRequest } from '@syncular/core';
import { createSyncularV2Database, type SyncularV2Database } from './database';
import type { MutationsApi } from './mutations';
import type {
  CreateSyncularV2DatabaseOptions,
  SyncularV2AuthLeaseRecord,
  SyncularV2BlobUploadQueueStats,
  SyncularV2Client,
  SyncularV2ClientEventMap,
  SyncularV2ClientEventSink,
  SyncularV2ClientEventType,
  SyncularV2ConflictResolution,
  SyncularV2ConflictStats,
  SyncularV2ConflictSummary,
  SyncularV2ConnectionState,
  SyncularV2DiagnosticSnapshot,
  SyncularV2DiagnosticEvent,
  SyncularV2LifecycleState,
  SyncularV2OutboxStats,
  SyncularV2PresenceEntry,
  SyncularV2PresenceSink,
  SyncularV2RealtimeConnectionState,
  SyncularV2RealtimeOptions,
  SyncularV2SubscriptionSpec,
  SyncularV2SyncRequestOptions,
  SyncularV2SyncResult,
} from './types';

export interface SyncularV2ClientLifecycleOptions {
  autoStart?: boolean;
  initialSync?: boolean;
  realtime?: boolean | SyncularV2RealtimeOptions;
  syncOnRealtimeConnect?: boolean;
  pollIntervalMs?: number | false;
}

export interface CreateSyncularV2ClientOptions
  extends Omit<CreateSyncularV2DatabaseOptions, 'realtime'> {
  subscriptions?: readonly SyncularV2SubscriptionSpec[];
  lifecycle?: SyncularV2ClientLifecycleOptions;
  realtime?: boolean | SyncularV2RealtimeOptions;
}

export interface SyncularV2ManagedClient<DB> extends SyncularV2Database<DB> {
  start(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
  sync(): Promise<SyncularV2SyncResult>;
}

export interface SyncularClientStatus {
  lifecycle: SyncularV2LifecycleState;
  connection: SyncularV2ConnectionState;
  outbox: SyncularV2OutboxStats | null;
  conflicts: SyncularV2ConflictStats | null;
  isConnected: boolean;
  isSyncing: boolean;
  hasPendingMutations: boolean;
  hasConflicts: boolean;
  requiresAction: boolean;
}

export interface SyncularClient<DB> extends SyncularV2ManagedClient<DB> {
  on<T extends SyncularV2ClientEventType>(
    event: T,
    listener: SyncularV2ClientEventSink<T>
  ): () => void;
  getStatus(): SyncularClientStatus;
  setSubscriptions(
    subscriptions: readonly SyncularV2SubscriptionSpec[]
  ): Promise<void>;
  resumeFromBackground(
    options?: SyncularV2SyncRequestOptions
  ): Promise<SyncularV2SyncResult>;
  issueAuthLease(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularV2AuthLeaseRecord>;
  upsertAuthLease(lease: SyncularV2AuthLeaseRecord): Promise<void>;
  authLease(leaseId: string): Promise<SyncularV2AuthLeaseRecord | null>;
  activeAuthLeases(
    actorId?: string | null,
    nowMs?: number
  ): Promise<SyncularV2AuthLeaseRecord[]>;
  diagnosticSnapshot(): Promise<SyncularV2DiagnosticSnapshot>;
  presence: SyncularPresenceClientLike;
  conflicts: SyncularConflictsClientLike;
}

export interface SyncularBlobClientLike {
  getUploadQueueStats(): Promise<SyncularV2BlobUploadQueueStats>;
  processUploadQueue(): Promise<{ uploaded: number; failed: number }>;
  retrieve(ref: BlobRef): Promise<Uint8Array>;
}

export interface SyncularPresenceClientLike {
  get<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularV2PresenceEntry<TMetadata>[];
  join(scopeKey: string, metadata?: Record<string, unknown>): void;
  leave(scopeKey: string): void;
  updateMetadata(scopeKey: string, metadata: Record<string, unknown>): void;
  onChange<TMetadata = Record<string, unknown>>(
    listener: SyncularV2PresenceSink<TMetadata>
  ): () => void;
}

export interface SyncularConflictsClientLike {
  list(): Promise<SyncularV2ConflictSummary[]>;
  retryKeepLocal(id: string): Promise<string>;
  resolve(id: string, resolution: SyncularV2ConflictResolution): Promise<void>;
}

export interface SyncularClientLike<DB> {
  db: SyncularV2Database<DB>['db'];
  dialect?: SyncularV2Database<DB>['dialect'] | unknown;
  mutations: MutationsApi<DB, any>;
  leasedMutations: MutationsApi<DB, any>;
  blobs: SyncularBlobClientLike;
  on<T extends SyncularV2ClientEventType>(
    event: T,
    listener: SyncularV2ClientEventSink<T>
  ): () => void;
  getStatus(): SyncularClientStatus;
  setSubscriptions(
    subscriptions: readonly SyncularV2SubscriptionSpec[]
  ): Promise<void>;
  resumeFromBackground(
    options?: SyncularV2SyncRequestOptions
  ): Promise<SyncularV2SyncResult>;
  issueAuthLease(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularV2AuthLeaseRecord>;
  upsertAuthLease(lease: SyncularV2AuthLeaseRecord): Promise<void>;
  authLease(leaseId: string): Promise<SyncularV2AuthLeaseRecord | null>;
  activeAuthLeases(
    actorId?: string | null,
    nowMs?: number
  ): Promise<SyncularV2AuthLeaseRecord[]>;
  diagnosticSnapshot(): Promise<SyncularV2DiagnosticSnapshot>;
  presence: SyncularPresenceClientLike;
  conflicts: SyncularConflictsClientLike;
  start(): Promise<void>;
  stop(): Promise<void>;
  sync(): Promise<SyncularV2SyncResult>;
  destroy(): Promise<void>;
}

export type SyncularClientEventType = SyncularV2ClientEventType;
export type SyncularClientEventMap = SyncularV2ClientEventMap;

type LifecycleClient = Pick<
  SyncularV2Client,
  | 'addDiagnosticListener'
  | 'connectionState'
  | 'forceSubscriptionsBootstrap'
  | 'setSubscriptions'
  | 'startRealtime'
  | 'stopRealtime'
  | 'syncOnce'
>;

export async function createSyncularClient<DB>(
  options: CreateSyncularV2ClientOptions
): Promise<SyncularClient<DB>> {
  const { lifecycle, realtime, subscriptions, ...databaseOptions } = options;
  const database = await createSyncularV2Database<DB>({
    ...databaseOptions,
    realtime: false,
  });
  const controller = new SyncularV2ClientLifecycle(database.client, {
    subscriptions,
    realtime: lifecycle?.realtime ?? realtime ?? true,
    initialSync: lifecycle?.initialSync,
    syncOnRealtimeConnect: lifecycle?.syncOnRealtimeConnect,
    pollIntervalMs: lifecycle?.pollIntervalMs,
  });
  const closeDatabase = database.close.bind(database);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await controller.stop();
    } finally {
      await closeDatabase();
    }
  };

  const managed = {
    ...database,
    on: (event, listener) => database.client.addEventListener(event, listener),
    getStatus: () => getSyncularClientStatus(database.client),
    setSubscriptions: (nextSubscriptions) =>
      database.client.setSubscriptions(nextSubscriptions),
    resumeFromBackground: (syncOptions) =>
      database.client.resumeFromBackground(syncOptions),
    issueAuthLease: (request) => database.client.issueAuthLease(request),
    upsertAuthLease: (lease) => database.client.upsertAuthLease(lease),
    authLease: (leaseId) => database.client.authLease(leaseId),
    activeAuthLeases: (actorId, nowMs) =>
      database.client.activeAuthLeases(actorId, nowMs),
    diagnosticSnapshot: () => database.client.diagnosticSnapshot(),
    presence: {
      get: (scopeKey) => database.client.getPresence(scopeKey),
      join: (scopeKey, metadata) =>
        database.client.joinPresence(scopeKey, metadata),
      leave: (scopeKey) => database.client.leavePresence(scopeKey),
      updateMetadata: (scopeKey, metadata) =>
        database.client.updatePresenceMetadata(scopeKey, metadata),
      onChange: (listener) => database.client.addPresenceListener(listener),
    },
    conflicts: {
      list: () => database.client.conflictSummaries(),
      retryKeepLocal: (id) => database.client.retryConflictKeepLocal(id),
      resolve: (id, resolution) =>
        database.client.resolveConflict(id, resolution),
    },
    start: () => controller.start(),
    stop: () => controller.stop(),
    sync: () => controller.sync(),
    close,
    destroy: close,
  } satisfies SyncularClient<DB>;

  if (lifecycle?.autoStart !== false) {
    await managed.start();
  }

  return managed;
}

function getSyncularClientStatus(
  client: Pick<SyncularV2Client, 'connectionState' | 'lifecycleState'>
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

export class SyncularV2ClientLifecycle {
  #started = false;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #unsubscribeDiagnostics: (() => void) | undefined;
  #syncInFlight: Promise<SyncularV2SyncResult> | undefined;
  #syncAgain = false;
  #hasConnectedRealtime = false;

  constructor(
    private readonly client: LifecycleClient,
    private readonly options: {
      subscriptions?: readonly SyncularV2SubscriptionSpec[];
      realtime?: boolean | SyncularV2RealtimeOptions;
      initialSync?: boolean;
      syncOnRealtimeConnect?: boolean;
      pollIntervalMs?: number | false;
    } = {}
  ) {}

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#hasConnectedRealtime =
      this.client.connectionState().realtime === 'connected';
    this.#unsubscribeDiagnostics = this.client.addDiagnosticListener((event) =>
      this.#handleDiagnostic(event)
    );
    try {
      if (this.options.subscriptions) {
        await this.client.setSubscriptions(this.options.subscriptions);
      }
      if (this.options.initialSync !== false) {
        await this.sync();
      }
      if (this.options.realtime !== false) {
        await this.client.startRealtime(this.options.realtime);
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
    this.#syncAgain = false;
    if (this.options.realtime !== false) {
      await this.client.stopRealtime();
    }
  }

  async sync(): Promise<SyncularV2SyncResult> {
    if (this.#syncInFlight) {
      this.#syncAgain = true;
      return this.#syncInFlight;
    }
    this.#syncInFlight = this.client.syncOnce().finally(() => {
      this.#syncInFlight = undefined;
      if (this.#syncAgain && this.#started) {
        this.#syncAgain = false;
        void this.sync().catch(() => undefined);
      }
    });
    return this.#syncInFlight;
  }

  #handleDiagnostic(event: SyncularV2DiagnosticEvent): void {
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
    const state = event.details.state as SyncularV2RealtimeConnectionState;
    if (state !== 'connected') return;
    const wasReconnect = this.#hasConnectedRealtime;
    this.#hasConnectedRealtime = true;
    const shouldSync =
      this.options.syncOnRealtimeConnect !== false &&
      (wasReconnect || this.options.initialSync === false);
    if (!shouldSync) return;
    void this.sync().catch(() => undefined);
  }

  #startPolling(): void {
    const interval = this.options.pollIntervalMs;
    if (interval === false || interval === undefined || interval <= 0) return;
    this.#pollTimer = setInterval(() => {
      void this.sync().catch(() => undefined);
    }, interval);
  }

  #stopPolling(): void {
    if (!this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }
}
