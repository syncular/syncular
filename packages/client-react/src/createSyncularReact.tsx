/**
 * @syncular/client-react - Typed React factory
 *
 * Creates a SyncProvider + hooks that are typed to the application's DB schema.
 *
 * Usage:
 *   const syncular = createSyncularReact<MyDb>();
 *   const { SyncProvider, useSyncQuery } = syncular;
 */

import type {
  ClientSyncConfig,
  MutationReceipt,
  MutationsApi,
  MutationsCommitFn,
  MutationsTx,
  OutboxCommitMeta,
  PushResultInfo,
  SubscriptionState,
  SyncAwaitBootstrapOptions,
  SyncAwaitPhaseOptions,
  SyncClientDb,
  SyncClientPlugin,
  SyncDiagnostics,
  SyncInspectorOptions,
  SyncInspectorSnapshot,
  SyncOperation,
  SyncProgress,
  SyncRepairOptions,
  SyncResetOptions,
  SyncResetResult,
  SyncTransport,
  TransportHealth,
} from '@syncular/client';
import {
  type ConflictInfo,
  createMutationsApi,
  createOutboxCommit,
  createQueryContext,
  enqueueOutboxCommit,
  FingerprintCollector,
  type OutboxStats,
  type PresenceEntry,
  type QueryContext,
  resolveConflict as resolveConflictDb,
  type SyncConnectionState,
  SyncEngine,
  type SyncEngineConfig,
  type SyncEngineState,
  type SyncError,
  type SyncResult,
  type SyncTransportMode,
} from '@syncular/client';
import { type Kysely, sql } from 'kysely';
import {
  createContext,
  type ReactNode,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ExecutableQuery<TResult> = {
  execute: () => Promise<TResult>;
};

function isExecutableQuery<TResult>(
  value: unknown
): value is ExecutableQuery<TResult> {
  if (!isRecord(value)) return false;
  return typeof value.execute === 'function';
}

function isPresenceMetadataEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (!(key in right)) return false;
    if (!Object.is(left[key], right[key])) return false;
  }

  return true;
}

const SYNC_PROGRESS_REFRESH_EVENTS = [
  'sync:start',
  'sync:complete',
  'sync:error',
  'bootstrap:start',
  'bootstrap:progress',
  'bootstrap:complete',
] as const;

const SYNC_INSPECTOR_REFRESH_EVENTS = [
  'sync:start',
  'sync:complete',
  'sync:error',
  'bootstrap:start',
  'bootstrap:progress',
  'bootstrap:complete',
  'connection:change',
  'outbox:change',
  'data:change',
] as const;

const SYNC_SUBSCRIPTION_REFRESH_EVENTS = [
  'sync:complete',
  'sync:error',
  'bootstrap:start',
  'bootstrap:progress',
  'bootstrap:complete',
] as const;

export interface SyncContextValue<DB extends SyncClientDb> {
  engine: SyncEngine<DB>;
  db: Kysely<DB>;
  transport: SyncTransport;
  handlers: ClientSyncConfig<DB, { actorId: string }>['handlers'];
}

export interface SyncProviderProps<
  DB extends SyncClientDb,
  Identity extends { actorId: string },
> {
  db: Kysely<DB>;
  transport: SyncTransport;
  sync: ClientSyncConfig<DB, Identity>;
  identity: Identity;
  clientId?: string | null;
  limitCommits?: number;
  limitSnapshotRows?: number;
  maxSnapshotPages?: number;
  dedupeRows?: boolean;
  stateId?: string;
  pollIntervalMs?: number;
  maxRetries?: number;
  migrate?: (db: Kysely<DB>) => Promise<void>;
  onMigrationError?: (error: Error) => void;
  realtimeEnabled?: boolean;
  realtimeFallbackPollMs?: number;
  onError?: (error: SyncError) => void;
  onConflict?: (conflict: ConflictInfo) => void;
  onPushResult?: (result: PushResultInfo) => void;
  onDataChange?: (scopes: string[]) => void;
  /**
   * Debounce window (ms) for coalescing remote/synced `data:change` events.
   * - default: `10`
   * - `0`/`false`: emit immediately (disable debounce)
   * - `>0`: merge scopes and emit once per window
   */
  dataChangeDebounceMs?: number | false;
  /**
   * Debounce override while sync is actively running.
   * Falls back to `dataChangeDebounceMs` when omitted.
   */
  dataChangeDebounceMsWhenSyncing?: number | false;
  /**
   * Debounce override while connection is reconnecting.
   * Falls back to `dataChangeDebounceMsWhenSyncing` (if syncing) and then
   * `dataChangeDebounceMs` when omitted.
   */
  dataChangeDebounceMsWhenReconnecting?: number | false;
  plugins?: SyncClientPlugin[];
  /** Custom SHA-256 hash function (for platforms without crypto.subtle, e.g. React Native) */
  sha256?: (bytes: Uint8Array) => Promise<string>;
  autoStart?: boolean;
  renderWhileStarting?: boolean;
  children: ReactNode;
}

export interface UseSyncEngineResult {
  state: SyncEngineState;
  sync: () => Promise<SyncResult>;
  reconnect: () => void;
  disconnect: () => void;
  start: () => Promise<void>;
  resetLocalState: () => void;
  getTransportHealth: () => Readonly<TransportHealth>;
  getProgress: () => Promise<SyncProgress>;
  getDiagnostics: () => Promise<SyncDiagnostics>;
  getInspectorSnapshot: (
    options?: SyncInspectorOptions
  ) => Promise<SyncInspectorSnapshot>;
  listSubscriptionStates: (args?: {
    stateId?: string;
    table?: string;
    status?: 'active' | 'revoked';
  }) => Promise<SubscriptionState[]>;
  getSubscriptionState: (
    subscriptionId: string,
    options?: { stateId?: string }
  ) => Promise<SubscriptionState | null>;
  reset: (options: SyncResetOptions) => Promise<SyncResetResult>;
  repair: (options: SyncRepairOptions) => Promise<SyncResetResult>;
  awaitPhase: (
    phase: SyncProgress['channelPhase'],
    options?: SyncAwaitPhaseOptions
  ) => Promise<SyncProgress>;
  awaitBootstrapComplete: (
    options?: SyncAwaitBootstrapOptions
  ) => Promise<SyncProgress>;
}

export interface SyncStatus {
  enabled: boolean;
  isOnline: boolean;
  isSyncing: boolean;
  lastSyncAt: number | null;
  lastSyncAgeMs: number | null;
  isStale: boolean;
  pendingCount: number;
  error: SyncError | null;
  isRetrying: boolean;
  retryCount: number;
}

export interface UseSyncStatusOptions {
  /**
   * Mark status as stale when `Date.now() - lastSyncAt` exceeds this value.
   * If omitted, `isStale` is always false.
   */
  staleAfterMs?: number;
}

export interface UseSyncConnectionResult {
  state: SyncConnectionState;
  mode: SyncTransportMode;
  isConnected: boolean;
  isReconnecting: boolean;
  reconnect: () => void;
  disconnect: () => void;
}

export interface UseTransportHealthResult {
  health: TransportHealth;
}

export interface UseSyncProgressOptions {
  /**
   * Polling interval while bootstrapping.
   * Set to 0 to disable interval refresh.
   */
  pollIntervalMs?: number;
}

export interface UseSyncProgressResult {
  progress: SyncProgress | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export interface UseSyncInspectorOptions {
  /**
   * Polling interval for refreshing inspector snapshots.
   * Set to 0 to disable interval refresh.
   */
  pollIntervalMs?: number;
  /**
   * Max number of recent events in the snapshot.
   */
  eventLimit?: number;
}

export interface UseSyncInspectorResult {
  snapshot: SyncInspectorSnapshot | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export interface UseSyncSubscriptionsOptions {
  stateId?: string;
  table?: string;
  status?: 'active' | 'revoked';
}

export interface UseSyncSubscriptionsResult {
  subscriptions: SubscriptionState[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export interface UseSyncSubscriptionResult {
  subscription: SubscriptionState | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export interface UseConflictsResult {
  conflicts: ConflictInfo[];
  count: number;
  hasConflicts: boolean;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export interface UseNewConflictsOptions {
  /**
   * Max number of buffered conflict notifications kept in memory.
   * Oldest notifications are dropped once the buffer reaches this size.
   */
  maxBuffered?: number;
}

export interface UseNewConflictsResult {
  conflicts: ConflictInfo[];
  latest: ConflictInfo | null;
  count: number;
  clear: () => void;
  dismiss: (conflictId: string) => void;
}

export type ConflictResolution = 'accept' | 'reject' | 'merge';

export interface UseResolveConflictResult {
  resolve: (
    conflictId: string,
    resolution: ConflictResolution,
    mergedData?: Record<string, unknown>
  ) => Promise<void>;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

export interface UseResolveConflictOptions {
  onSuccess?: (conflictId: string) => void;
  onError?: (error: Error) => void;
  syncAfterResolve?: boolean;
}

export interface UseSyncQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  isStale: boolean;
  lastSyncAt: number | null;
  refetch: () => Promise<void>;
}

interface UseSyncQueryMetrics {
  executions: number;
  coalescedRefreshes: number;
  skippedDataUpdates: number;
  lastDurationMs: number | null;
}

export interface UseSyncQueryOptions {
  enabled?: boolean;
  deps?: unknown[];
  keyField?: string;
  watchTables?: string[];
  pollIntervalMs?: number;
  staleAfterMs?: number;
  /**
   * If true (default), non-urgent hook state updates are scheduled in
   * `startTransition` to keep UI interactions responsive under bursty sync.
   */
  transitionUpdates?: boolean;
  /**
   * Optional low-overhead instrumentation callback for query executions.
   */
  onMetrics?: (metrics: UseSyncQueryMetrics) => void;
}

export interface UseQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export interface UseQueryOptions {
  enabled?: boolean;
  deps?: unknown[];
  keyField?: string;
}

export type MutationInput<TTable extends string> =
  | {
      table?: TTable;
      rowId: string;
      op: 'delete';
      payload?: null;
      baseVersion?: number | null;
    }
  | {
      table?: TTable;
      rowId: string;
      op: 'upsert';
      payload?: Record<string, unknown> | null;
      baseVersion?: number | null;
    };

export interface MutationResult {
  commitId: string;
  clientCommitId: string;
}

export interface FluentMutation<TTable extends string> {
  (input: MutationInput<TTable>): Promise<MutationResult>;
  upsert: (
    rowId: string,
    payload: Record<string, unknown>,
    options?: { baseVersion?: number | null }
  ) => Promise<MutationResult>;
  delete: (
    rowId: string,
    options?: { baseVersion?: number | null }
  ) => Promise<MutationResult>;
}

export interface UseMutationResult<TTable extends string> {
  mutate: FluentMutation<TTable>;
  mutateMany: (inputs: Array<MutationInput<TTable>>) => Promise<MutationResult>;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

export interface UseMutationOptions<TTable extends string> {
  table: TTable;
  syncImmediately?: boolean;
  onSuccess?: (result: MutationResult) => void;
  onError?: (error: Error) => void;
}

type SyncMode = 'background' | 'await' | false;

export interface UseMutationsOptions {
  sync?: SyncMode;
  versionColumn?: string | null;
  onSuccess?: (result: MutationReceipt & { opCount: number }) => void;
  onError?: (error: Error) => void;
}

export type MutationsHook<DB extends SyncClientDb> = MutationsApi<
  DB,
  { sync?: SyncMode }
> & {
  $isPending: boolean;
  $error: Error | null;
  $reset: () => void;
};

export interface OutboxCommit {
  id: string;
  clientCommitId: string;
  status: 'pending' | 'sending' | 'acked' | 'failed';
  operationsCount: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  attemptCount: number;
}

export interface UseOutboxResult {
  stats: OutboxStats;
  pending: OutboxCommit[];
  failed: OutboxCommit[];
  hasUnsent: boolean;
  isLoading: boolean;
  refresh: () => Promise<void>;
  clearFailed: () => Promise<number>;
  clearAll: () => Promise<number>;
}

interface UseOutboxMetrics {
  refreshes: number;
  coalescedRefreshes: number;
  lastDurationMs: number | null;
}

interface UseOutboxOptions {
  /**
   * If true (default), non-urgent outbox state updates are scheduled in
   * `startTransition` to reduce render contention during sync bursts.
   */
  transitionUpdates?: boolean;
  /**
   * Optional low-overhead instrumentation callback for outbox refreshes.
   */
  onMetrics?: (metrics: UseOutboxMetrics) => void;
}

export interface UsePresenceResult<TMetadata = Record<string, unknown>> {
  presence: PresenceEntry<TMetadata>[];
  isLoading: boolean;
}

export interface UsePresenceWithJoinOptions<
  TMetadata = Record<string, unknown>,
> {
  metadata?: TMetadata;
  autoJoin?: boolean;
}

export interface UsePresenceWithJoinResult<TMetadata = Record<string, unknown>>
  extends UsePresenceResult<TMetadata> {
  updateMetadata: (metadata: TMetadata) => void;
  join: (metadata?: TMetadata) => void;
  leave: () => void;
  isJoined: boolean;
}

export function createSyncularReact<
  DB extends SyncClientDb,
  Identity extends { actorId: string } = { actorId: string },
>() {
  const SyncContext = createContext<SyncContextValue<DB> | null>(null);

  function SyncProvider({
    db,
    transport,
    sync,
    identity,
    clientId,
    limitCommits,
    limitSnapshotRows,
    maxSnapshotPages,
    dedupeRows,
    stateId,
    pollIntervalMs,
    maxRetries,
    migrate,
    onMigrationError,
    realtimeEnabled,
    realtimeFallbackPollMs,
    onError,
    onConflict,
    onPushResult,
    onDataChange,
    dataChangeDebounceMs,
    dataChangeDebounceMsWhenSyncing,
    dataChangeDebounceMsWhenReconnecting,
    plugins,
    sha256,
    autoStart = true,
    renderWhileStarting = true,
    children,
  }: SyncProviderProps<DB, Identity>): ReactNode {
    const resolvedSubscriptions = useMemo(
      () => sync.subscriptions(identity),
      [sync, identity]
    );

    const config = useMemo<SyncEngineConfig<DB>>(
      () => ({
        db,
        transport,
        handlers: sync.handlers,
        actorId: identity.actorId,
        clientId,
        subscriptions: resolvedSubscriptions,
        limitCommits,
        limitSnapshotRows,
        maxSnapshotPages,
        dedupeRows,
        stateId,
        pollIntervalMs,
        maxRetries,
        migrate,
        onMigrationError,
        realtimeEnabled,
        realtimeFallbackPollMs,
        onError,
        onConflict,
        onPushResult,
        onDataChange,
        dataChangeDebounceMs,
        dataChangeDebounceMsWhenSyncing,
        dataChangeDebounceMsWhenReconnecting,
        plugins,
        sha256,
      }),
      [
        db,
        transport,
        sync,
        identity,
        clientId,
        resolvedSubscriptions,
        limitCommits,
        limitSnapshotRows,
        maxSnapshotPages,
        dedupeRows,
        stateId,
        pollIntervalMs,
        maxRetries,
        migrate,
        onMigrationError,
        realtimeEnabled,
        realtimeFallbackPollMs,
        onError,
        onConflict,
        onPushResult,
        onDataChange,
        dataChangeDebounceMs,
        dataChangeDebounceMsWhenSyncing,
        dataChangeDebounceMsWhenReconnecting,
        plugins,
        sha256,
      ]
    );

    const [engine] = useState(() => new SyncEngine(config));

    const [initialProps] = useState(() => ({
      actorId: identity.actorId,
      clientId,
      db,
      transport,
      sync,
    }));

    useEffect(() => {
      const changedProps: string[] = [];
      if (identity.actorId !== initialProps.actorId)
        changedProps.push('actorId');
      if (clientId !== initialProps.clientId) changedProps.push('clientId');
      if (db !== initialProps.db) changedProps.push('db');
      if (transport !== initialProps.transport) changedProps.push('transport');
      if (sync !== initialProps.sync) changedProps.push('sync');

      if (changedProps.length > 0) {
        const message =
          `[SyncProvider] Critical props changed after mount: ${changedProps.join(', ')}. ` +
          'This is not supported and may cause undefined behavior. ' +
          'Use a React key prop to force remount, e.g., ' +
          `<SyncProvider key={userId} ...> or <SyncProvider key={identity.actorId + ':' + clientId} ...>`;

        console.error(message);
        if (process.env.NODE_ENV === 'development') {
          console.warn(
            '[SyncProvider] In development, consider using React StrictMode ' +
              'to help detect these issues early.'
          );
        }
      }
    }, [identity, clientId, db, transport, sync, initialProps]);

    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
      let cancelled = false;

      if (!autoStart) {
        setIsReady(true);
        return () => {
          cancelled = true;
          engine.stop();
        };
      }

      engine
        .start()
        .then(() => {
          if (!cancelled) setIsReady(true);
        })
        .catch((err) => {
          console.error('[SyncProvider] Engine start failed:', err);
          if (!cancelled) setIsReady(true);
        });

      return () => {
        cancelled = true;
        engine.stop();
      };
    }, [engine, autoStart]);

    useEffect(() => {
      if (isReady && resolvedSubscriptions.length > 0) {
        engine.updateSubscriptions(resolvedSubscriptions);
      }
    }, [engine, isReady, resolvedSubscriptions]);

    const value = useMemo<SyncContextValue<DB>>(
      () => ({
        engine,
        db,
        transport,
        handlers: sync.handlers,
      }),
      [engine, db, transport, sync]
    );

    if (!isReady && renderWhileStarting === false) {
      return null;
    }

    return (
      <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
    );
  }

  function useSyncContext(): SyncContextValue<DB> {
    const context = useContext(SyncContext);
    if (!context) {
      throw new Error('useSyncContext must be used within a SyncProvider');
    }
    return context;
  }

  function useEngine(): SyncEngine<DB> {
    return useSyncContext().engine;
  }

  function useEngineStateSnapshot(): SyncEngineState {
    const engine = useEngine();
    const subscribe = useCallback(
      (callback: () => void) => {
        return engine.subscribe(callback);
      },
      [engine]
    );
    const getSnapshot = useCallback(() => engine.getState(), [engine]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  function useSyncEngine(): UseSyncEngineResult {
    const engine = useEngine();
    const state = useEngineStateSnapshot();

    const sync = useCallback(() => engine.sync(), [engine]);
    const reconnect = useCallback(() => engine.reconnect(), [engine]);
    const disconnect = useCallback(() => engine.disconnect(), [engine]);
    const start = useCallback(() => engine.start(), [engine]);
    const resetLocalState = useCallback(
      () => engine.resetLocalState(),
      [engine]
    );
    const getTransportHealth = useCallback(
      () => engine.getTransportHealth(),
      [engine]
    );
    const getProgress = useCallback(() => engine.getProgress(), [engine]);
    const getDiagnostics = useCallback(() => engine.getDiagnostics(), [engine]);
    const getInspectorSnapshot = useCallback(
      (options?: SyncInspectorOptions) => engine.getInspectorSnapshot(options),
      [engine]
    );
    const listSubscriptionStates = useCallback(
      (args?: {
        stateId?: string;
        table?: string;
        status?: 'active' | 'revoked';
      }) => engine.listSubscriptionStates(args),
      [engine]
    );
    const getSubscriptionState = useCallback(
      (subscriptionId: string, options?: { stateId?: string }) =>
        engine.getSubscriptionState(subscriptionId, options),
      [engine]
    );
    const reset = useCallback(
      (options: SyncResetOptions) => engine.reset(options),
      [engine]
    );
    const repair = useCallback(
      (options: SyncRepairOptions) => engine.repair(options),
      [engine]
    );
    const awaitPhase = useCallback(
      (phase: SyncProgress['channelPhase'], options?: SyncAwaitPhaseOptions) =>
        engine.awaitPhase(phase, options),
      [engine]
    );
    const awaitBootstrapComplete = useCallback(
      (options?: SyncAwaitBootstrapOptions) =>
        engine.awaitBootstrapComplete(options),
      [engine]
    );

    return {
      state,
      sync,
      reconnect,
      disconnect,
      start,
      resetLocalState,
      getTransportHealth,
      getProgress,
      getDiagnostics,
      getInspectorSnapshot,
      listSubscriptionStates,
      getSubscriptionState,
      reset,
      repair,
      awaitPhase,
      awaitBootstrapComplete,
    };
  }

  function useSyncStatus(options: UseSyncStatusOptions = {}): SyncStatus {
    const { staleAfterMs } = options;
    const state = useEngineStateSnapshot();

    const [staleClock, setStaleClock] = useState<number>(Date.now());

    useEffect(() => {
      if (staleAfterMs === undefined || staleAfterMs <= 0) return;

      const intervalMs = Math.min(
        1000,
        Math.max(100, Math.floor(staleAfterMs / 2))
      );
      const timer = setInterval(() => {
        setStaleClock(Date.now());
      }, intervalMs);

      return () => clearInterval(timer);
    }, [staleAfterMs]);

    return useMemo<SyncStatus>(() => {
      const now = staleAfterMs !== undefined ? staleClock : Date.now();
      const lastSyncAgeMs =
        state.lastSyncAt === null ? null : Math.max(0, now - state.lastSyncAt);
      const isStale =
        staleAfterMs !== undefined && staleAfterMs > 0
          ? state.lastSyncAt === null || (lastSyncAgeMs ?? 0) > staleAfterMs
          : false;

      return {
        enabled: state.enabled,
        isOnline: state.connectionState === 'connected',
        isSyncing: state.isSyncing,
        lastSyncAt: state.lastSyncAt,
        lastSyncAgeMs,
        isStale,
        pendingCount: state.pendingCount,
        error: state.error,
        isRetrying: state.isRetrying,
        retryCount: state.retryCount,
      };
    }, [state, staleAfterMs, staleClock]);
  }

  function useSyncConnection(): UseSyncConnectionResult {
    const engine = useEngine();
    const engineState = useEngineStateSnapshot();

    const reconnect = useCallback(() => engine.reconnect(), [engine]);
    const disconnect = useCallback(() => engine.disconnect(), [engine]);

    return useMemo(
      () => ({
        state: engineState.connectionState,
        mode: engineState.transportMode,
        isConnected: engineState.connectionState === 'connected',
        isReconnecting: engineState.connectionState === 'reconnecting',
        reconnect,
        disconnect,
      }),
      [
        engineState.connectionState,
        engineState.transportMode,
        reconnect,
        disconnect,
      ]
    );
  }

  function useTransportHealth(): UseTransportHealthResult {
    const engine = useEngine();

    const getSnapshot = useCallback(
      () => engine.getTransportHealth(),
      [engine]
    );
    const health = useSyncExternalStore(
      useCallback(
        (callback) => {
          return engine.subscribeSelector(getSnapshot, callback);
        },
        [engine, getSnapshot]
      ),
      getSnapshot,
      getSnapshot
    );

    return useMemo(() => ({ health }), [health]);
  }

  type SyncEngineEventName = Parameters<SyncEngine<DB>['on']>[0];

  function useAsyncEngineResource<T>(options: {
    initialValue: T;
    load: () => Promise<T>;
    refreshOn: readonly SyncEngineEventName[];
    pollIntervalMs?: number;
    shouldPoll?: (value: T) => boolean;
    transitionUpdates?: boolean;
  }): {
    value: T;
    isLoading: boolean;
    error: Error | null;
    refresh: () => Promise<void>;
  } {
    const engine = useEngine();
    const {
      initialValue,
      load,
      refreshOn,
      pollIntervalMs,
      shouldPoll,
      transitionUpdates = true,
    } = options;

    const loadRef = useRef(load);
    loadRef.current = load;

    const [value, setValue] = useState(initialValue);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const loadedRef = useRef(false);
    const versionRef = useRef(0);
    const inFlightRefreshRef = useRef<Promise<void> | null>(null);
    const refreshQueuedRef = useRef(false);
    const applyUpdate = useCallback(
      (update: () => void) => {
        if (transitionUpdates) {
          startTransition(update);
          return;
        }
        update();
      },
      [transitionUpdates]
    );

    const refreshOnce = useCallback(async () => {
      const version = ++versionRef.current;
      const isCurrent = () => version === versionRef.current;

      if (!loadedRef.current) {
        setIsLoading(true);
      }

      try {
        const next = await loadRef.current();
        if (!isCurrent()) return;
        applyUpdate(() => {
          setValue(next);
          setError(null);
        });
      } catch (err) {
        if (!isCurrent()) return;
        applyUpdate(() => {
          setError(err instanceof Error ? err : new Error(String(err)));
        });
      } finally {
        if (isCurrent()) {
          loadedRef.current = true;
          applyUpdate(() => {
            setIsLoading(false);
          });
        }
      }
    }, [applyUpdate]);

    const refresh = useCallback(async () => {
      refreshQueuedRef.current = true;
      if (inFlightRefreshRef.current) {
        await inFlightRefreshRef.current;
        return;
      }

      const runLoop = async () => {
        while (refreshQueuedRef.current) {
          refreshQueuedRef.current = false;
          await refreshOnce();
        }
      };

      const inFlight = runLoop().finally(() => {
        inFlightRefreshRef.current = null;
      });
      inFlightRefreshRef.current = inFlight;
      await inFlight;
    }, [refreshOnce]);

    useEffect(() => {
      void refresh();
    }, [refresh]);

    useEffect(() => {
      if (refreshOn.length === 0) return;
      const unsubscribers = refreshOn.map((eventName) =>
        engine.on(eventName, refresh)
      );
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    }, [engine, refresh, refreshOn]);

    useEffect(() => {
      if (pollIntervalMs === undefined || pollIntervalMs <= 0) return;
      if (shouldPoll && !shouldPoll(value)) return;
      const timer = setInterval(() => {
        void refresh();
      }, pollIntervalMs);
      return () => clearInterval(timer);
    }, [pollIntervalMs, refresh, shouldPoll, value]);

    return { value, isLoading, error, refresh };
  }

  function useSyncProgress(
    options: UseSyncProgressOptions = {}
  ): UseSyncProgressResult {
    const engine = useEngine();
    const { pollIntervalMs = 500 } = options;
    const {
      value: progress,
      isLoading,
      error,
      refresh,
    } = useAsyncEngineResource<SyncProgress | null>({
      initialValue: null,
      load: () => engine.getProgress(),
      refreshOn: SYNC_PROGRESS_REFRESH_EVENTS,
      pollIntervalMs,
      shouldPoll: (value) => value?.channelPhase === 'bootstrapping',
    });

    return useMemo(
      () => ({
        progress,
        isLoading,
        error,
        refresh,
      }),
      [progress, isLoading, error, refresh]
    );
  }

  function useSyncInspector(
    options: UseSyncInspectorOptions = {}
  ): UseSyncInspectorResult {
    const engine = useEngine();
    const { pollIntervalMs = 2_000, eventLimit } = options;
    const {
      value: snapshot,
      isLoading,
      error,
      refresh,
    } = useAsyncEngineResource<SyncInspectorSnapshot | null>({
      initialValue: null,
      load: () => engine.getInspectorSnapshot({ eventLimit }),
      refreshOn: SYNC_INSPECTOR_REFRESH_EVENTS,
      pollIntervalMs,
    });

    return useMemo(
      () => ({
        snapshot,
        isLoading,
        error,
        refresh,
      }),
      [snapshot, isLoading, error, refresh]
    );
  }

  function useSyncSubscriptions(
    options: UseSyncSubscriptionsOptions = {}
  ): UseSyncSubscriptionsResult {
    const engine = useEngine();
    const { stateId, table, status } = options;
    const {
      value: subscriptions,
      isLoading,
      error,
      refresh,
    } = useAsyncEngineResource<SubscriptionState[]>({
      initialValue: [],
      load: () =>
        engine.listSubscriptionStates({
          stateId,
          table,
          status,
        }),
      refreshOn: SYNC_SUBSCRIPTION_REFRESH_EVENTS,
    });

    return useMemo(
      () => ({
        subscriptions,
        isLoading,
        error,
        refresh,
      }),
      [subscriptions, isLoading, error, refresh]
    );
  }

  function useSyncSubscription(
    subscriptionId: string,
    options: { stateId?: string } = {}
  ): UseSyncSubscriptionResult {
    const engine = useEngine();
    const { stateId } = options;
    const {
      value: subscription,
      isLoading,
      error,
      refresh,
    } = useAsyncEngineResource<SubscriptionState | null>({
      initialValue: null,
      load: () =>
        engine.getSubscriptionState(subscriptionId, {
          stateId,
        }),
      refreshOn: SYNC_SUBSCRIPTION_REFRESH_EVENTS,
    });

    return useMemo(
      () => ({
        subscription,
        isLoading,
        error,
        refresh,
      }),
      [subscription, isLoading, error, refresh]
    );
  }

  function useConflicts(): UseConflictsResult {
    const engine = useEngine();
    const {
      value: conflicts,
      isLoading,
      refresh,
    } = useAsyncEngineResource<ConflictInfo[]>({
      initialValue: [],
      load: () => engine.getConflicts(),
      refreshOn: ['sync:complete', 'sync:error', 'conflict:new'],
    });

    return useMemo(
      () => ({
        conflicts,
        count: conflicts.length,
        hasConflicts: conflicts.length > 0,
        isLoading,
        refresh,
      }),
      [conflicts, isLoading, refresh]
    );
  }

  function useNewConflicts(
    options: UseNewConflictsOptions = {}
  ): UseNewConflictsResult {
    const engine = useEngine();
    const maxBuffered = Math.max(1, Math.min(500, options.maxBuffered ?? 100));
    const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);

    useEffect(() => {
      setConflicts([]);
      const unsubscribe = engine.on('conflict:new', (conflict) => {
        setConflicts((previous) => {
          if (previous.some((item) => item.id === conflict.id)) {
            return previous;
          }
          const next = [...previous, conflict];
          const overflow = next.length - maxBuffered;
          return overflow > 0 ? next.slice(overflow) : next;
        });
      });
      return unsubscribe;
    }, [engine, maxBuffered]);

    const clear = useCallback(() => {
      setConflicts([]);
    }, []);

    const dismiss = useCallback((conflictId: string) => {
      setConflicts((previous) =>
        previous.filter((conflict) => conflict.id !== conflictId)
      );
    }, []);

    return useMemo(
      () => ({
        conflicts,
        latest: conflicts[conflicts.length - 1] ?? null,
        count: conflicts.length,
        clear,
        dismiss,
      }),
      [conflicts, clear, dismiss]
    );
  }

  function useResolveConflict(
    options: UseResolveConflictOptions = {}
  ): UseResolveConflictResult {
    const { onSuccess, onError, syncAfterResolve = true } = options;
    const { db } = useSyncContext();
    const engine = useEngine();

    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const resolve = useCallback(
      async (
        conflictId: string,
        resolution: ConflictResolution,
        mergedData?: Record<string, unknown>
      ): Promise<void> => {
        setIsPending(true);
        setError(null);

        try {
          let resolutionStr: string;
          if (resolution === 'merge' && mergedData) {
            resolutionStr = `merge:${JSON.stringify(mergedData)}`;
          } else {
            resolutionStr = resolution;
          }

          await resolveConflictDb(db, {
            id: conflictId,
            resolution: resolutionStr,
          });

          onSuccess?.(conflictId);

          if (syncAfterResolve) {
            engine.sync().catch((err) => {
              console.warn(
                '[useResolveConflict] Sync after resolve failed:',
                err
              );
            });
          }
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          setError(e);
          onError?.(e);
          throw e;
        } finally {
          setIsPending(false);
        }
      },
      [db, engine, syncAfterResolve, onSuccess, onError]
    );

    const reset = useCallback(() => {
      setError(null);
    }, []);

    return useMemo(
      () => ({
        resolve,
        isPending,
        error,
        reset,
      }),
      [resolve, isPending, error, reset]
    );
  }

  function useSyncQuery<TResult>(
    queryFn: (
      ctx: QueryContext<DB>
    ) => ExecutableQuery<TResult> | Promise<TResult>,
    options: UseSyncQueryOptions = {}
  ): UseSyncQueryResult<TResult> {
    const {
      enabled = true,
      deps = [],
      keyField = 'id',
      watchTables = [],
      pollIntervalMs,
      staleAfterMs,
      transitionUpdates = true,
      onMetrics,
    } = options;
    const { db } = useSyncContext();
    const engine = useEngine();
    const watchTablesSet = useMemo(() => new Set(watchTables), [watchTables]);

    const queryFnRef = useRef<typeof queryFn>(queryFn);
    queryFnRef.current = queryFn;

    const [data, setData] = useState<TResult | undefined>(undefined);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [lastSyncAt, setLastSyncAt] = useState<number | null>(
      () => engine.getState().lastSyncAt
    );
    const [staleClock, setStaleClock] = useState<number>(Date.now());

    const versionRef = useRef(0);
    const watchedScopesRef = useRef<Set<string>>(new Set());
    const fingerprintCollectorRef = useRef(new FingerprintCollector());
    const previousFingerprintRef = useRef<string>('');
    const hasLoadedRef = useRef(false);
    const inFlightQueryRef = useRef<Promise<void> | null>(null);
    const queryQueuedRef = useRef(false);
    const queuedUrgentRefreshRef = useRef(false);
    const metricsRef = useRef<UseSyncQueryMetrics>({
      executions: 0,
      coalescedRefreshes: 0,
      skippedDataUpdates: 0,
      lastDurationMs: null,
    });
    const onMetricsRef = useRef(onMetrics);
    onMetricsRef.current = onMetrics;
    const emitMetrics = useCallback(() => {
      onMetricsRef.current?.({ ...metricsRef.current });
    }, []);
    const applyUpdate = useCallback(
      (update: () => void, options: { urgent?: boolean } = {}) => {
        if (transitionUpdates && options.urgent !== true) {
          startTransition(update);
          return;
        }
        update();
      },
      [transitionUpdates]
    );

    const executeQueryOnce = useCallback(
      async (options: { urgentUpdates?: boolean } = {}) => {
        const urgentUpdates = options.urgentUpdates === true;
        const startedAt = Date.now();
        metricsRef.current.executions += 1;
        if (!enabled) {
          if (previousFingerprintRef.current !== 'disabled') {
            previousFingerprintRef.current = 'disabled';
          }
          const snapshotLastSyncAt = engine.getState().lastSyncAt;
          applyUpdate(
            () => {
              setData(undefined);
              setLastSyncAt(snapshotLastSyncAt);
              setIsLoading(false);
            },
            { urgent: urgentUpdates }
          );
          hasLoadedRef.current = true;
          metricsRef.current.lastDurationMs = Date.now() - startedAt;
          emitMetrics();
          return;
        }

        const version = ++versionRef.current;

        try {
          if (!hasLoadedRef.current) {
            setIsLoading(true);
          }

          fingerprintCollectorRef.current.clear();
          const scopeCollector = new Set<string>();
          const ctx = createQueryContext(
            db,
            scopeCollector,
            fingerprintCollectorRef.current,
            engine,
            keyField
          );

          const fnResult = queryFnRef.current(ctx);
          const result = isExecutableQuery<TResult>(fnResult)
            ? await fnResult.execute()
            : await fnResult;

          if (version === versionRef.current) {
            watchedScopesRef.current = scopeCollector;
            const snapshotLastSyncAt = engine.getState().lastSyncAt;

            const fingerprint = fingerprintCollectorRef.current.getCombined();
            const didFingerprintChange =
              fingerprint !== previousFingerprintRef.current ||
              fingerprint === '';
            if (didFingerprintChange) {
              previousFingerprintRef.current = fingerprint;
            } else {
              metricsRef.current.skippedDataUpdates += 1;
            }

            applyUpdate(
              () => {
                setLastSyncAt(snapshotLastSyncAt);
                if (didFingerprintChange) {
                  setData(result);
                }
                setError(null);
              },
              { urgent: urgentUpdates }
            );
          }
        } catch (err) {
          if (version === versionRef.current) {
            applyUpdate(
              () => {
                setError(err instanceof Error ? err : new Error(String(err)));
              },
              { urgent: urgentUpdates }
            );
          }
        } finally {
          if (version === versionRef.current) {
            applyUpdate(
              () => {
                setIsLoading(false);
              },
              { urgent: urgentUpdates }
            );
            hasLoadedRef.current = true;
            metricsRef.current.lastDurationMs = Date.now() - startedAt;
            emitMetrics();
          }
        }
      },
      [db, enabled, engine, keyField, applyUpdate, emitMetrics]
    );

    const executeQuery = useCallback(
      async (options: { urgentUpdates?: boolean } = {}) => {
        const urgentUpdates = options.urgentUpdates === true;
        queryQueuedRef.current = true;
        if (urgentUpdates) {
          queuedUrgentRefreshRef.current = true;
        }
        if (inFlightQueryRef.current) {
          metricsRef.current.coalescedRefreshes += 1;
          emitMetrics();
          await inFlightQueryRef.current;
          return;
        }

        const runLoop = async () => {
          while (queryQueuedRef.current) {
            queryQueuedRef.current = false;
            const runWithUrgentUpdates = queuedUrgentRefreshRef.current;
            queuedUrgentRefreshRef.current = false;
            await executeQueryOnce({
              urgentUpdates: runWithUrgentUpdates,
            });
          }
        };

        const inFlight = runLoop().finally(() => {
          inFlightQueryRef.current = null;
        });
        inFlightQueryRef.current = inFlight;
        await inFlight;
      },
      [executeQueryOnce, emitMetrics]
    );

    useEffect(() => {
      executeQuery();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [executeQuery, ...deps]);

    const getLastSyncAtSnapshot = useCallback(
      () => engine.getState().lastSyncAt,
      [engine]
    );
    useEffect(() => {
      const unsubscribe = engine.subscribeSelector(
        getLastSyncAtSnapshot,
        () => {
          const snapshotLastSyncAt = getLastSyncAtSnapshot();
          applyUpdate(() => {
            setLastSyncAt(snapshotLastSyncAt);
          });
        }
      );
      return unsubscribe;
    }, [engine, getLastSyncAtSnapshot, applyUpdate]);

    useEffect(() => {
      if (!enabled) return;

      const unsubscribe = engine.on('data:change', (event) => {
        const changedScopes = event.scopes ?? [];
        const watchedScopes = watchedScopesRef.current;
        const hasDynamicFilter = watchedScopes.size > 0;
        const hasTableFilter = watchTablesSet.size > 0;

        if (hasDynamicFilter || hasTableFilter) {
          const matchesDynamic = changedScopes.some((scope) =>
            watchedScopes.has(scope)
          );
          const matchesConfigured = changedScopes.some((scope) =>
            watchTablesSet.has(scope)
          );

          if (!matchesDynamic && !matchesConfigured) {
            return;
          }
        }

        void executeQuery({ urgentUpdates: event.source === 'local' });
      });

      return unsubscribe;
    }, [engine, enabled, executeQuery, watchTablesSet]);

    useEffect(() => {
      if (!enabled) return;
      if (pollIntervalMs === undefined || pollIntervalMs <= 0) return;

      const timer = setInterval(() => {
        void executeQuery();
      }, pollIntervalMs);

      return () => clearInterval(timer);
    }, [enabled, pollIntervalMs, executeQuery]);

    useEffect(() => {
      if (staleAfterMs === undefined || staleAfterMs <= 0) return;

      const intervalMs = Math.min(
        1000,
        Math.max(100, Math.floor(staleAfterMs / 2))
      );
      const timer = setInterval(() => {
        setStaleClock(Date.now());
      }, intervalMs);

      return () => clearInterval(timer);
    }, [staleAfterMs]);

    const refetch = useCallback(async () => {
      await executeQuery();
    }, [executeQuery]);

    return useMemo(() => {
      const now = staleAfterMs !== undefined ? staleClock : Date.now();
      const isStale =
        staleAfterMs !== undefined && staleAfterMs > 0
          ? lastSyncAt === null || now - lastSyncAt > staleAfterMs
          : false;

      return {
        data,
        isLoading,
        error,
        isStale,
        lastSyncAt,
        refetch,
      };
    }, [data, isLoading, error, staleAfterMs, staleClock, lastSyncAt, refetch]);
  }

  function useQuery<TResult>(
    queryFn: (
      ctx: QueryContext<DB>
    ) => ExecutableQuery<TResult> | Promise<TResult>,
    options: UseQueryOptions = {}
  ): UseQueryResult<TResult> {
    const { enabled = true, deps = [], keyField = 'id' } = options;
    const { db } = useSyncContext();
    const engine = useEngine();

    const queryFnRef = useRef<typeof queryFn>(queryFn);
    queryFnRef.current = queryFn;

    const [data, setData] = useState<TResult | undefined>(undefined);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const versionRef = useRef(0);
    const fingerprintCollectorRef = useRef(new FingerprintCollector());
    const previousFingerprintRef = useRef<string>('');

    const executeQuery = useCallback(async () => {
      if (!enabled) {
        setData(undefined);
        setIsLoading(false);
        return;
      }

      const version = ++versionRef.current;

      try {
        setIsLoading(true);

        fingerprintCollectorRef.current.clear();
        const scopeCollector = new Set<string>();
        const ctx = createQueryContext(
          db,
          scopeCollector,
          fingerprintCollectorRef.current,
          engine,
          keyField
        );

        const fnResult = queryFnRef.current(ctx);
        const result = isExecutableQuery<TResult>(fnResult)
          ? await fnResult.execute()
          : await fnResult;

        if (version === versionRef.current) {
          const fingerprint = fingerprintCollectorRef.current.getCombined();
          if (
            fingerprint !== previousFingerprintRef.current ||
            fingerprint === ''
          ) {
            previousFingerprintRef.current = fingerprint;
            setData(result);
          }
          setError(null);
        }
      } catch (err) {
        if (version === versionRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (version === versionRef.current) {
          setIsLoading(false);
        }
      }
    }, [db, enabled, engine, keyField]);

    useEffect(() => {
      executeQuery();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [executeQuery, ...deps]);

    const refetch = useCallback(async () => {
      await executeQuery();
    }, [executeQuery]);

    return useMemo(
      () => ({
        data,
        isLoading,
        error,
        refetch,
      }),
      [data, isLoading, error, refetch]
    );
  }

  function useMutation<TTable extends keyof DB & string>(
    options: UseMutationOptions<TTable>
  ): UseMutationResult<TTable> {
    const { table, syncImmediately = true, onSuccess, onError } = options;
    const { db } = useSyncContext();
    const engine = useEngine();

    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const enqueue = useCallback(
      async (inputs: Array<MutationInput<TTable>>): Promise<MutationResult> => {
        setIsPending(true);
        setError(null);

        try {
          for (const input of inputs) {
            if (input.table !== undefined && input.table !== table) {
              throw new Error(
                `[useMutation] MutationInput.table must match hook table "${table}" (got "${input.table}")`
              );
            }
          }

          const operations: SyncOperation[] = inputs.map((input) => ({
            scope: table,
            table: table,
            row_id: input.rowId,
            op: input.op,
            payload: input.op === 'delete' ? null : (input.payload ?? null),
            base_version: input.baseVersion ?? null,
          }));

          const result = await enqueueOutboxCommit(db, { operations });

          const mutationResult: MutationResult = {
            commitId: result.id,
            clientCommitId: result.clientCommitId,
          };

          await engine.applyLocalMutation(
            inputs.map((input) => ({
              table,
              rowId: input.rowId,
              op: input.op,
              payload: input.op === 'delete' ? null : (input.payload ?? null),
            }))
          );

          onSuccess?.(mutationResult);

          if (syncImmediately) {
            engine.sync().catch((err) => {
              console.warn('[useMutation] Background sync failed:', err);
            });
          }

          return mutationResult;
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          setError(e);
          onError?.(e);
          throw e;
        } finally {
          setIsPending(false);
        }
      },
      [db, engine, table, syncImmediately, onSuccess, onError]
    );

    const mutateLegacy = useCallback(
      async (input: MutationInput<TTable>): Promise<MutationResult> => {
        return enqueue([input]);
      },
      [enqueue]
    );

    const upsert = useCallback(
      async (
        rowId: string,
        payload: Record<string, unknown>,
        opts?: { baseVersion?: number | null }
      ): Promise<MutationResult> => {
        return enqueue([
          {
            table,
            rowId,
            op: 'upsert',
            payload,
            baseVersion: opts?.baseVersion,
          },
        ]);
      },
      [enqueue, table]
    );

    const deleteRow = useCallback(
      async (
        rowId: string,
        opts?: { baseVersion?: number | null }
      ): Promise<MutationResult> => {
        return enqueue([
          {
            table,
            rowId,
            op: 'delete',
            baseVersion: opts?.baseVersion,
          },
        ]);
      },
      [enqueue, table]
    );

    const mutate = useMemo(() => {
      const fn = mutateLegacy as FluentMutation<TTable>;
      fn.upsert = upsert;
      fn.delete = deleteRow;
      return fn;
    }, [mutateLegacy, upsert, deleteRow]);

    const reset = useCallback(() => {
      setError(null);
    }, []);

    return useMemo(
      () => ({
        mutate,
        mutateMany: enqueue,
        isPending,
        error,
        reset,
      }),
      [mutate, enqueue, isPending, error, reset]
    );
  }

  function useMutations(options: UseMutationsOptions = {}): MutationsHook<DB> {
    const { db } = useSyncContext();
    const engine = useEngine();

    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const reset = useCallback(() => {
      setError(null);
    }, []);

    const versionColumn = options.versionColumn ?? 'server_version';
    const defaultSync = options.sync ?? 'background';
    const onSuccess = options.onSuccess;
    const onError = options.onError;

    const baseCommit = useMemo(
      () =>
        createOutboxCommit<DB>({
          db,
          versionColumn,
          plugins: engine.getPlugins(),
          actorId: engine.getActorId() ?? undefined,
          clientId: engine.getClientId() ?? undefined,
        }),
      [db, engine, versionColumn]
    );

    const commit = useCallback<
      MutationsCommitFn<DB, OutboxCommitMeta, { sync?: SyncMode }>
    >(
      async <R,>(
        fn: (tx: MutationsTx<DB>) => Promise<R> | R,
        commitOptions?: { sync?: SyncMode }
      ) => {
        setIsPending(true);
        setError(null);

        try {
          const { result, receipt, meta } = await baseCommit(fn);

          const localMutations =
            meta.localMutations.length > 0
              ? meta.localMutations
              : meta.operations
                  .map((operation) => {
                    const rowId = operation.row_id;
                    if (!operation.table || !rowId) return null;
                    return {
                      table: operation.table,
                      rowId,
                      op: operation.op === 'delete' ? 'delete' : 'upsert',
                    } as const;
                  })
                  .filter(
                    (
                      mutation
                    ): mutation is {
                      table: string;
                      rowId: string;
                      op: 'upsert' | 'delete';
                    } => mutation !== null
                  );

          engine.recordLocalMutations(localMutations);
          void engine.refreshOutboxStats();

          onSuccess?.({
            commitId: receipt.commitId,
            clientCommitId: receipt.clientCommitId,
            opCount: meta.operations.length,
          });

          const syncMode = commitOptions?.sync ?? defaultSync;
          if (syncMode) {
            const syncPromise = engine.sync();
            if (syncMode === 'await') {
              await syncPromise;
            } else {
              syncPromise.catch((err) => {
                console.warn('[useMutations] Background sync failed:', err);
              });
            }
          }

          return { result, receipt, meta };
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          setError(e);
          onError?.(e);
          throw e;
        } finally {
          setIsPending(false);
        }
      },
      [baseCommit, defaultSync, engine, onError, onSuccess]
    );

    const api = useMemo(() => createMutationsApi(commit), [commit]);

    return useMemo(
      () =>
        Object.assign(api, {
          $isPending: isPending,
          $error: error,
          $reset: reset,
        }),
      [api, error, isPending, reset]
    );
  }

  function useOutbox(options: UseOutboxOptions = {}): UseOutboxResult {
    const { db } = useSyncContext();
    const engine = useEngine();
    const { transitionUpdates = true, onMetrics } = options;

    const [stats, setStats] = useState<OutboxStats>({
      pending: 0,
      sending: 0,
      failed: 0,
      acked: 0,
      total: 0,
    });
    const [pending, setPending] = useState<OutboxCommit[]>([]);
    const [failed, setFailed] = useState<OutboxCommit[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const inFlightRefreshRef = useRef<Promise<void> | null>(null);
    const refreshQueuedRef = useRef(false);
    const metricsRef = useRef<UseOutboxMetrics>({
      refreshes: 0,
      coalescedRefreshes: 0,
      lastDurationMs: null,
    });
    const onMetricsRef = useRef(onMetrics);
    onMetricsRef.current = onMetrics;
    const emitMetrics = useCallback(() => {
      onMetricsRef.current?.({ ...metricsRef.current });
    }, []);
    const applyUpdate = useCallback(
      (update: () => void) => {
        if (transitionUpdates) {
          startTransition(update);
          return;
        }
        update();
      },
      [transitionUpdates]
    );

    const refreshOnce = useCallback(async () => {
      const startedAt = Date.now();
      metricsRef.current.refreshes += 1;
      try {
        setIsLoading(true);

        const newStats = await engine.refreshOutboxStats({ emit: false });

        const rowsResult = await sql<{
          id: string;
          client_commit_id: string;
          status: OutboxCommit['status'];
          operations_json: string;
          error: string | null;
          created_at: number;
          updated_at: number;
          attempt_count: number;
        }>`
	          select
	            ${sql.ref('id')},
	            ${sql.ref('client_commit_id')},
	            ${sql.ref('status')},
	            ${sql.ref('operations_json')},
	            ${sql.ref('error')},
	            ${sql.ref('created_at')},
	            ${sql.ref('updated_at')},
	            ${sql.ref('attempt_count')}
	          from ${sql.table('sync_outbox_commits')}
	          where ${sql.ref('status')} in (${sql.join([
              sql.val('pending'),
              sql.val('failed'),
            ])})
	          order by ${sql.ref('created_at')} asc
	        `.execute(db);
        const rows = rowsResult.rows;

        const commits: OutboxCommit[] = rows.map((row) => {
          let operationsCount = 0;
          try {
            const ops =
              typeof row.operations_json === 'string'
                ? JSON.parse(row.operations_json)
                : row.operations_json;
            operationsCount = Array.isArray(ops) ? ops.length : 0;
          } catch {
            operationsCount = 0;
          }

          return {
            id: row.id,
            clientCommitId: row.client_commit_id,
            status: row.status,
            operationsCount,
            error: row.error,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            attemptCount: Number(row.attempt_count),
          };
        });

        const nextPending = commits.filter((c) => c.status === 'pending');
        const nextFailed = commits.filter((c) => c.status === 'failed');
        applyUpdate(() => {
          setStats(newStats);
          setPending(nextPending);
          setFailed(nextFailed);
        });
      } catch (err) {
        console.error('[useOutbox] Failed to refresh:', err);
      } finally {
        applyUpdate(() => {
          setIsLoading(false);
        });
        metricsRef.current.lastDurationMs = Date.now() - startedAt;
        emitMetrics();
      }
    }, [db, engine, applyUpdate, emitMetrics]);

    const refresh = useCallback(async () => {
      refreshQueuedRef.current = true;
      if (inFlightRefreshRef.current) {
        metricsRef.current.coalescedRefreshes += 1;
        emitMetrics();
        await inFlightRefreshRef.current;
        return;
      }

      const runLoop = async () => {
        while (refreshQueuedRef.current) {
          refreshQueuedRef.current = false;
          await refreshOnce();
        }
      };

      const inFlight = runLoop().finally(() => {
        inFlightRefreshRef.current = null;
      });
      inFlightRefreshRef.current = inFlight;
      await inFlight;
    }, [refreshOnce, emitMetrics]);

    useEffect(() => {
      refresh();
    }, [refresh]);

    useEffect(() => {
      const unsubscribe = engine.on('outbox:change', () => {
        refresh();
      });
      return unsubscribe;
    }, [engine, refresh]);

    const hasUnsent = stats.pending > 0 || stats.failed > 0;

    const clearFailed = useCallback(async () => {
      const count = await engine.clearFailedCommits();
      await refresh();
      return count;
    }, [engine, refresh]);

    const clearAll = useCallback(async () => {
      const count = await engine.clearAllCommits();
      await refresh();
      return count;
    }, [engine, refresh]);

    return useMemo(
      () => ({
        stats,
        pending,
        failed,
        hasUnsent,
        isLoading,
        refresh,
        clearFailed,
        clearAll,
      }),
      [
        stats,
        pending,
        failed,
        hasUnsent,
        isLoading,
        refresh,
        clearFailed,
        clearAll,
      ]
    );
  }

  function usePresence<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): UsePresenceResult<TMetadata> {
    const engine = useEngine();
    const [presence, setPresence] = useState<PresenceEntry<TMetadata>[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
      const initial = engine.getPresence<TMetadata>(scopeKey);
      setPresence(initial);
      setIsLoading(false);

      const unsubscribe = engine.on('presence:change', (event) => {
        if (event.scopeKey === scopeKey) {
          setPresence(event.presence as PresenceEntry<TMetadata>[]);
        }
      });

      return unsubscribe;
    }, [engine, scopeKey]);

    return { presence, isLoading };
  }

  function usePresenceWithJoin<TMetadata = Record<string, unknown>>(
    scopeKey: string,
    options: UsePresenceWithJoinOptions<TMetadata> = {}
  ): UsePresenceWithJoinResult<TMetadata> {
    const { metadata: initialMetadata, autoJoin = true } = options;
    const engine = useEngine();
    const { presence, isLoading } = usePresence<TMetadata>(scopeKey);
    const [isJoined, setIsJoined] = useState(false);
    const previousMetadataRef = useRef<TMetadata | undefined>(initialMetadata);
    const autoJoinMetadataRef = useRef<TMetadata | undefined>(initialMetadata);

    const join = useCallback(
      (metadata?: TMetadata) => {
        engine.joinPresence(
          scopeKey,
          metadata as Record<string, unknown> | undefined
        );
        setIsJoined(true);
      },
      [engine, scopeKey]
    );

    const leave = useCallback(() => {
      engine.leavePresence(scopeKey);
      setIsJoined(false);
    }, [engine, scopeKey]);

    const updateMetadata = useCallback(
      (metadata: TMetadata) => {
        engine.updatePresenceMetadata(
          scopeKey,
          metadata as Record<string, unknown>
        );
      },
      [engine, scopeKey]
    );

    useEffect(() => {
      autoJoinMetadataRef.current = initialMetadata;
    }, [initialMetadata]);

    useEffect(() => {
      if (autoJoin) {
        const metadata = autoJoinMetadataRef.current;
        join(metadata);
        previousMetadataRef.current = metadata;
      }

      return () => {
        leave();
      };
    }, [autoJoin, join, leave]);

    useEffect(() => {
      if (!autoJoin || !isJoined) {
        previousMetadataRef.current = initialMetadata;
        return;
      }

      if (initialMetadata === undefined) {
        previousMetadataRef.current = initialMetadata;
        return;
      }

      if (
        isPresenceMetadataEqual(previousMetadataRef.current, initialMetadata)
      ) {
        return;
      }

      previousMetadataRef.current = initialMetadata;
      updateMetadata(initialMetadata);
    }, [autoJoin, initialMetadata, isJoined, updateMetadata]);

    return {
      presence,
      isLoading,
      updateMetadata,
      join,
      leave,
      isJoined,
    };
  }

  return {
    SyncProvider,
    useSyncContext,
    useEngine,
    useSyncEngine,
    useSyncStatus,
    useSyncConnection,
    useTransportHealth,
    useSyncProgress,
    useSyncInspector,
    useSyncSubscriptions,
    useSyncSubscription,
    useSyncQuery,
    useQuery,
    useMutation,
    useMutations,
    useOutbox,
    useConflicts,
    useNewConflicts,
    useResolveConflict,
    usePresence,
    usePresenceWithJoin,
  } as const;
}
