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
  ClientTableRegistry,
  MutationReceipt,
  MutationsApi,
  MutationsCommitFn,
  MutationsTx,
  OutboxCommitMeta,
  SyncClientDb,
  SyncClientPlugin,
  SyncOperation,
  SyncSubscriptionRequest,
  SyncTransport,
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

export interface SyncContextValue<DB extends SyncClientDb> {
  engine: SyncEngine<DB>;
  db: Kysely<DB>;
  transport: SyncTransport;
  handlers: ClientTableRegistry<DB>;
}

export interface SyncProviderProps<DB extends SyncClientDb> {
  db: Kysely<DB>;
  transport: SyncTransport;
  handlers: ClientTableRegistry<DB>;
  actorId?: string | null;
  clientId?: string | null;
  subscriptions?: Array<Omit<SyncSubscriptionRequest, 'cursor'>>;
  limitCommits?: number;
  limitSnapshotRows?: number;
  maxSnapshotPages?: number;
  stateId?: string;
  pollIntervalMs?: number;
  maxRetries?: number;
  migrate?: (db: Kysely<DB>) => Promise<void>;
  onMigrationError?: (error: Error) => void;
  realtimeEnabled?: boolean;
  realtimeFallbackPollMs?: number;
  onError?: (error: SyncError) => void;
  onConflict?: (conflict: ConflictInfo) => void;
  onDataChange?: (scopes: string[]) => void;
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
}

export interface SyncStatus {
  enabled: boolean;
  isOnline: boolean;
  isSyncing: boolean;
  lastSyncAt: number | null;
  pendingCount: number;
  error: SyncError | null;
  isRetrying: boolean;
  retryCount: number;
}

export interface UseSyncConnectionResult {
  state: SyncConnectionState;
  mode: SyncTransportMode;
  isConnected: boolean;
  isReconnecting: boolean;
  reconnect: () => void;
  disconnect: () => void;
}

export interface UseConflictsResult {
  conflicts: ConflictInfo[];
  count: number;
  hasConflicts: boolean;
  isLoading: boolean;
  refresh: () => Promise<void>;
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
  refetch: () => Promise<void>;
}

export interface UseSyncQueryOptions {
  enabled?: boolean;
  deps?: unknown[];
  keyField?: string;
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

export function createSyncularReact<DB extends SyncClientDb>() {
  const SyncContext = createContext<SyncContextValue<DB> | null>(null);

  function SyncProvider({
    db,
    transport,
    handlers,
    actorId,
    clientId,
    subscriptions = [],
    limitCommits,
    limitSnapshotRows,
    maxSnapshotPages,
    stateId,
    pollIntervalMs,
    maxRetries,
    migrate,
    onMigrationError,
    realtimeEnabled,
    realtimeFallbackPollMs,
    onError,
    onConflict,
    onDataChange,
    plugins,
    sha256,
    autoStart = true,
    renderWhileStarting = true,
    children,
  }: SyncProviderProps<DB>): ReactNode {
    const config = useMemo<SyncEngineConfig<DB>>(
      () => ({
        db,
        transport,
        handlers,
        actorId,
        clientId,
        subscriptions,
        limitCommits,
        limitSnapshotRows,
        maxSnapshotPages,
        stateId,
        pollIntervalMs,
        maxRetries,
        migrate,
        onMigrationError,
        realtimeEnabled,
        realtimeFallbackPollMs,
        onError,
        onConflict,
        onDataChange,
        plugins,
        sha256,
      }),
      [
        db,
        transport,
        handlers,
        actorId,
        clientId,
        subscriptions,
        limitCommits,
        limitSnapshotRows,
        maxSnapshotPages,
        stateId,
        pollIntervalMs,
        maxRetries,
        migrate,
        onMigrationError,
        realtimeEnabled,
        realtimeFallbackPollMs,
        onError,
        onConflict,
        onDataChange,
        plugins,
        sha256,
      ]
    );

    const [engine] = useState(() => new SyncEngine(config));

    const [initialProps] = useState(() => ({
      actorId,
      clientId,
      db,
      transport,
      handlers,
    }));

    useEffect(() => {
      const changedProps: string[] = [];
      if (actorId !== initialProps.actorId) changedProps.push('actorId');
      if (clientId !== initialProps.clientId) changedProps.push('clientId');
      if (db !== initialProps.db) changedProps.push('db');
      if (transport !== initialProps.transport) changedProps.push('transport');
      if (handlers !== initialProps.handlers) changedProps.push('handlers');

      if (changedProps.length > 0) {
        const message =
          `[SyncProvider] Critical props changed after mount: ${changedProps.join(', ')}. ` +
          'This is not supported and may cause undefined behavior. ' +
          'Use a React key prop to force remount, e.g., ' +
          `<SyncProvider key={userId} ...> or <SyncProvider key={actorId + ':' + clientId} ...>`;

        console.error(message);
        if (process.env.NODE_ENV === 'development') {
          console.warn(
            '[SyncProvider] In development, consider using React StrictMode ' +
              'to help detect these issues early.'
          );
        }
      }
    }, [actorId, clientId, db, transport, handlers, initialProps]);

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
      if (isReady && subscriptions.length > 0) {
        engine.updateSubscriptions(subscriptions);
      }
    }, [engine, isReady, subscriptions]);

    const value = useMemo<SyncContextValue<DB>>(
      () => ({
        engine,
        db,
        transport,
        handlers,
      }),
      [engine, db, transport, handlers]
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

  function useSyncEngine(): UseSyncEngineResult {
    const engine = useEngine();

    const state = useSyncExternalStore(
      useCallback((callback) => engine.subscribe(callback), [engine]),
      useCallback(() => engine.getState(), [engine]),
      useCallback(() => engine.getState(), [engine])
    );

    const sync = useCallback(() => engine.sync(), [engine]);
    const reconnect = useCallback(() => engine.reconnect(), [engine]);
    const disconnect = useCallback(() => engine.disconnect(), [engine]);
    const start = useCallback(() => engine.start(), [engine]);
    const resetLocalState = useCallback(
      () => engine.resetLocalState(),
      [engine]
    );

    return {
      state,
      sync,
      reconnect,
      disconnect,
      start,
      resetLocalState,
    };
  }

  function useSyncStatus(): SyncStatus {
    const engine = useEngine();

    const state = useSyncExternalStore(
      useCallback((callback) => engine.subscribe(callback), [engine]),
      useCallback(() => engine.getState(), [engine]),
      useCallback(() => engine.getState(), [engine])
    );

    return useMemo<SyncStatus>(
      () => ({
        enabled: state.enabled,
        isOnline: state.connectionState === 'connected',
        isSyncing: state.isSyncing,
        lastSyncAt: state.lastSyncAt,
        pendingCount: state.pendingCount,
        error: state.error,
        isRetrying: state.isRetrying,
        retryCount: state.retryCount,
      }),
      [state]
    );
  }

  function useSyncConnection(): UseSyncConnectionResult {
    const engine = useEngine();

    const engineState = useSyncExternalStore(
      useCallback((callback) => engine.subscribe(callback), [engine]),
      useCallback(() => engine.getState(), [engine]),
      useCallback(() => engine.getState(), [engine])
    );

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

  function useConflicts(): UseConflictsResult {
    const engine = useEngine();

    const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    const refresh = useCallback(async () => {
      try {
        setIsLoading(true);
        const result = await engine.getConflicts();
        setConflicts(result);
      } catch (err) {
        console.error('[useConflicts] Failed to refresh:', err);
      } finally {
        setIsLoading(false);
      }
    }, [engine]);

    useEffect(() => {
      refresh();
    }, [refresh]);

    useEffect(() => {
      const unsubscribe = engine.on('sync:complete', () => {
        refresh();
      });
      return unsubscribe;
    }, [engine, refresh]);

    useEffect(() => {
      const unsubscribe = engine.on('sync:error', () => {
        refresh();
      });
      return unsubscribe;
    }, [engine, refresh]);

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
    const { enabled = true, deps = [], keyField = 'id' } = options;
    const { db } = useSyncContext();
    const engine = useEngine();

    const queryFnRef = useRef<typeof queryFn>(queryFn);
    queryFnRef.current = queryFn;

    const [data, setData] = useState<TResult | undefined>(undefined);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const versionRef = useRef(0);
    const watchedScopesRef = useRef<Set<string>>(new Set());
    const fingerprintCollectorRef = useRef(new FingerprintCollector());
    const previousFingerprintRef = useRef<string>('');
    const hasLoadedRef = useRef(false);

    const executeQuery = useCallback(async () => {
      if (!enabled) {
        if (previousFingerprintRef.current !== 'disabled') {
          previousFingerprintRef.current = 'disabled';
          setData(undefined);
        }
        setIsLoading(false);
        hasLoadedRef.current = true;
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
          hasLoadedRef.current = true;
        }
      }
    }, [db, enabled, engine, keyField]);

    useEffect(() => {
      executeQuery();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [executeQuery, ...deps]);

    useEffect(() => {
      if (!enabled) return;
      const unsubscribe = engine.on('sync:complete', () => {
        executeQuery();
      });
      return unsubscribe;
    }, [engine, enabled, executeQuery]);

    useEffect(() => {
      if (!enabled) return;

      const unsubscribe = engine.on('data:change', (event) => {
        const changedScopes = event.scopes || [];
        const watchedScopes = watchedScopesRef.current;

        if (watchedScopes.size > 0) {
          const hasWatchedScope = changedScopes.some((s) =>
            watchedScopes.has(s)
          );
          if (!hasWatchedScope) return;
        }

        executeQuery();
      });

      return unsubscribe;
    }, [engine, enabled, executeQuery]);

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
        }),
      [db, versionColumn]
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

          engine.recordLocalMutations(meta.localMutations);
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

  function useOutbox(): UseOutboxResult {
    const { db } = useSyncContext();
    const engine = useEngine();

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

    const refresh = useCallback(async () => {
      try {
        setIsLoading(true);

        const newStats = await engine.refreshOutboxStats({ emit: false });
        setStats(newStats);

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

        setPending(commits.filter((c) => c.status === 'pending'));
        setFailed(commits.filter((c) => c.status === 'failed'));
      } catch (err) {
        console.error('[useOutbox] Failed to refresh:', err);
      } finally {
        setIsLoading(false);
      }
    }, [db, engine]);

    useEffect(() => {
      refresh();
    }, [refresh]);

    useEffect(() => {
      const unsubscribe = engine.on('outbox:change', () => {
        refresh();
      });
      return unsubscribe;
    }, [engine, refresh]);

    useEffect(() => {
      const unsubscribe = engine.on('sync:complete', () => {
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
    useSyncQuery,
    useQuery,
    useMutation,
    useMutations,
    useOutbox,
    useConflicts,
    useResolveConflict,
    usePresence,
    usePresenceWithJoin,
  } as const;
}
