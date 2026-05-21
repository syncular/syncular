import type { BlobRef } from '@syncular/core';
import type { CompiledQuery, Kysely } from 'kysely';
import {
  createContext,
  createElement,
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
import {
  type CreateSyncularV2ClientOptions,
  createSyncularClient,
  type SyncularClientLike,
} from './client';
import type {
  MutationReceipt,
  MutationsApi,
  TableMutations,
} from './mutations';
import type {
  SyncularV2BlobUploadQueueStats,
  SyncularV2ChangedRow,
  SyncularV2ClientEventMap,
  SyncularV2ClientEventType,
  SyncularV2ConflictStats,
  SyncularV2ConnectionState,
  SyncularV2OutboxStats,
  SyncularV2PresenceEntry,
  SyncularV2RowsChangedEvent,
} from './types';

export type SyncularReactStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SyncProviderProps<DB> {
  children?: ReactNode;
  client?: SyncularClientLike<DB>;
  options?: CreateSyncularV2ClientOptions;
  optionsKey?: unknown;
  destroyOnUnmount?: boolean;
  onClient?: (client: SyncularClientLike<DB>) => void;
  onError?: (error: unknown) => void;
}

export interface SyncContextValue {
  status: SyncularReactStatus;
  error: unknown;
}

export interface SyncQueryContext<DB> {
  db: Kysely<DB>;
  selectFrom: Kysely<DB>['selectFrom'];
}

export interface UseSyncQueryOptions {
  enabled?: boolean;
  deps?: readonly unknown[];
  keyField?: string;
  watchTables?: readonly string[];
  tables?: readonly string[];
  pollIntervalMs?: number;
  staleAfterMs?: number;
  structuralSharing?: boolean;
  refreshOnDataChange?: boolean;
  loadingOnRefresh?: boolean;
  transitionUpdates?: boolean;
}

export interface UseSyncQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  isStale: boolean;
  lastSyncAt: number | null;
  refetch: () => Promise<void>;
}

export interface UseQueryOptions {
  enabled?: boolean;
  deps?: readonly unknown[];
  keyField?: string;
}

export interface UseQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export type MutationInput =
  | {
      rowId: string;
      op: 'delete';
      payload?: null;
      baseVersion?: number | null;
    }
  | {
      rowId: string;
      op: 'upsert';
      payload?: Record<string, unknown> | null;
      baseVersion?: number | null;
    };

export type MutationResult = MutationReceipt;

export interface FluentMutation {
  update: (
    rowId: string,
    payload: Record<string, unknown>,
    options?: { baseVersion?: number | null }
  ) => Promise<MutationResult>;
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

export interface UseMutationOptions<TTable extends string> {
  table: TTable;
  syncImmediately?: boolean;
  onSuccess?: (result: MutationResult) => void;
  onError?: (error: Error) => void;
}

export interface UseMutationResult {
  mutate: FluentMutation;
  mutateMany: (inputs: readonly MutationInput[]) => Promise<MutationResult>;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

export type SyncMode = 'background' | 'await' | false;

export interface UseMutationsOptions {
  sync?: SyncMode;
  onSuccess?: (result: MutationReceipt & { opCount: number }) => void;
  onError?: (error: Error) => void;
}

export type MutationsHook<DB> = MutationsApi<DB, { sync?: SyncMode }> & {
  readonly $isPending: boolean;
  readonly $error: Error | null;
  $reset: () => void;
};

export interface UseRowsChangedOptions {
  tables?: readonly string[];
  enabled?: boolean;
}

export interface UsePresenceResult<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  presence: SyncularV2PresenceEntry<TMetadata>[];
  isLoading: boolean;
}

export interface UsePresenceWithJoinOptions<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  metadata?: TMetadata;
  autoJoin?: boolean;
  enabled?: boolean;
}

export interface UsePresenceWithJoinResult<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends UsePresenceResult<TMetadata> {
  updateMetadata: (metadata: TMetadata) => void;
  join: (metadata?: TMetadata) => void;
  leave: () => void;
  isJoined: boolean;
}

export interface UseSyncConnectionResult {
  state: SyncularV2ConnectionState;
  isConnected: boolean;
  isReconnecting: boolean;
  reconnect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export interface UseBlobUploadQueueResult {
  stats: SyncularV2BlobUploadQueueStats | null;
  refresh(): Promise<void>;
  process(): Promise<{ uploaded: number; failed: number }>;
}

type ReactContextInternal<DB> = {
  client: SyncularClientLike<DB> | null;
  status: SyncularReactStatus;
  error: unknown;
};

type ExecutableQuery<TResult> = {
  execute(): Promise<TResult>;
  compile?: () => CompiledQuery;
};

type SyncQueryFn<DB, TResult> = (
  ctx: SyncQueryContext<DB>
) => ExecutableQuery<TResult> | Promise<TResult> | TResult;

type KnownTableKey<DB> = string extends keyof DB
  ? string
  : Extract<keyof DB, string>;

type AnyTableMutations = TableMutations<
  Record<string, Record<string, unknown>>,
  string
>;

export function createSyncularReact<DB>() {
  const Context = createContext<ReactContextInternal<DB> | null>(null);

  function SyncProvider(
    props: SyncProviderProps<DB>
  ): ReturnType<typeof createElement> {
    const {
      children,
      client: providedClient,
      destroyOnUnmount,
      onClient,
      onError,
      options,
      optionsKey,
    } = props;
    const optionsRef = useLatest(options);
    const onClientRef = useLatest(onClient);
    const onErrorRef = useLatest(onError);
    const lifecycleKey = optionsKey;
    const [value, setValue] = useState<ReactContextInternal<DB>>({
      client: providedClient ?? null,
      status: providedClient ? 'ready' : options ? 'loading' : 'idle',
      error: null,
    });

    useEffect(() => {
      void lifecycleKey;
      let cancelled = false;
      let ownedClient: SyncularClientLike<DB> | null = null;

      if (providedClient) {
        setValue({ client: providedClient, status: 'ready', error: null });
        onClientRef.current?.(providedClient);
        return () => {
          if (destroyOnUnmount) {
            void providedClient.destroy().catch(() => undefined);
          }
        };
      }

      const currentOptions = optionsRef.current;
      if (!currentOptions) {
        setValue({ client: null, status: 'idle', error: null });
        return undefined;
      }

      setValue((previous) => ({
        client: previous.client,
        status: 'loading',
        error: null,
      }));
      void createSyncularClient<DB>(currentOptions)
        .then((client) => {
          if (cancelled) {
            void client.destroy().catch(() => undefined);
            return;
          }
          ownedClient = client;
          setValue({ client, status: 'ready', error: null });
          onClientRef.current?.(client);
        })
        .catch((error) => {
          if (cancelled) return;
          setValue({ client: null, status: 'error', error });
          onErrorRef.current?.(error);
        });

      return () => {
        cancelled = true;
        if (ownedClient) void ownedClient.destroy().catch(() => undefined);
      };
    }, [
      destroyOnUnmount,
      lifecycleKey,
      onClientRef,
      onErrorRef,
      optionsRef,
      providedClient,
    ]);

    return createElement(Context.Provider, { value, children });
  }

  function useSyncContext(): SyncContextValue {
    const value = useContext(Context);
    if (!value) throw new Error('SyncProvider is required for Syncular hooks.');
    return { status: value.status, error: value.error };
  }

  function useClient(): SyncularClientLike<DB> {
    const value = useContext(Context);
    if (!value) throw new Error('SyncProvider is required for Syncular hooks.');
    if (!value.client) {
      if (value.status === 'error') throw value.error;
      throw new Error('Syncular client is not ready yet.');
    }
    return value.client;
  }

  function useSyncConnection(): UseSyncConnectionResult {
    const client = useClient();
    const state = useSyncExternalStore(
      useCallback(
        (notify) => client.on('lifecycleChanged', () => notify()),
        [client]
      ),
      useCallback(() => client.getStatus().connection, [client]),
      useCallback(() => client.getStatus().connection, [client])
    );
    return {
      state,
      isConnected: state.realtime === 'connected' && !state.closed,
      isReconnecting: state.realtime === 'connecting',
      reconnect: client.start,
      disconnect: client.stop,
    };
  }

  function useSyncEvent<T extends SyncularV2ClientEventType>(
    event: T,
    listener: (payload: SyncularV2ClientEventMap[T]) => void,
    enabled = true
  ): void {
    const client = useClient();
    const listenerRef = useLatest(listener);
    useEffect(() => {
      if (!enabled) return undefined;
      return client.on(event, (payload) => listenerRef.current(payload));
    }, [client, enabled, event, listenerRef]);
  }

  function useRowsChanged(
    listener: (event: SyncularV2RowsChangedEvent) => void,
    options: UseRowsChangedOptions = {}
  ): void {
    const listenerRef = useLatest(listener);
    useSyncEvent(
      'rowsChanged',
      (event) => {
        const tables = options.tables == null ? null : new Set(options.tables);
        if (tables && !event.changedTables.some((table) => tables.has(table))) {
          return;
        }
        listenerRef.current(event);
      },
      options.enabled !== false
    );
  }

  function useSyncQuery<TResult>(
    query: SyncQueryFn<DB, TResult>,
    options: UseSyncQueryOptions = {}
  ): UseSyncQueryResult<TResult> {
    const client = useClient();
    const queryRef = useLatest(query);
    const optionsRef = useLatest(options);
    const enabled = options.enabled !== false;
    const deps = options.deps ?? [];
    const tables = options.watchTables ?? options.tables;
    const tablesRef = useLatest(tables);
    const tablesKey = stableStringListKey(tables);
    const watchedTables = useMemo(() => {
      void tablesKey;
      return tablesRef.current == null ? null : new Set(tablesRef.current);
    }, [tablesKey, tablesRef]);
    const [data, setData] = useState<TResult | undefined>(undefined);
    const [isLoading, setIsLoading] = useState(enabled);
    const [error, setError] = useState<Error | null>(null);
    const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

    const execute = useCallback(async () => {
      if (!enabled) return;
      if (optionsRef.current.loadingOnRefresh !== false) setIsLoading(true);
      setError(null);
      try {
        const result = await executeSyncQuery(client.db, queryRef.current);
        const publish = () => {
          setData((previous) =>
            shareQueryResult(
              previous,
              result,
              optionsRef.current.keyField ?? 'id',
              optionsRef.current.structuralSharing !== false
            )
          );
          setLastSyncAt(Date.now());
          setIsLoading(false);
        };
        if (optionsRef.current.transitionUpdates === false) {
          publish();
        } else {
          startTransition(publish);
        }
      } catch (caught) {
        setError(toError(caught));
        setIsLoading(false);
      }
    }, [client, enabled, optionsRef, queryRef]);

    useEffect(() => {
      if (!enabled) {
        setIsLoading(false);
        return undefined;
      }
      void execute();
      if (!options.pollIntervalMs || options.pollIntervalMs <= 0) {
        return undefined;
      }
      const timer = setInterval(() => {
        void execute();
      }, options.pollIntervalMs);
      return () => clearInterval(timer);
    }, [enabled, execute, options.pollIntervalMs, ...deps]);

    useEffect(() => {
      if (!enabled || options.refreshOnDataChange === false) return undefined;
      return client.on('rowsChanged', (event) => {
        if (
          watchedTables &&
          !event.changedTables.some((table) => watchedTables.has(table))
        ) {
          return;
        }
        void execute();
      });
    }, [client, enabled, execute, options.refreshOnDataChange, watchedTables]);

    return {
      data,
      isLoading,
      error,
      isStale:
        options.staleAfterMs != null &&
        lastSyncAt != null &&
        Date.now() - lastSyncAt > options.staleAfterMs,
      lastSyncAt,
      refetch: execute,
    };
  }

  function useQuery<TResult>(
    query: SyncQueryFn<DB, TResult>,
    options: UseQueryOptions = {}
  ): UseQueryResult<TResult> {
    const result = useSyncQuery(query, {
      ...options,
      refreshOnDataChange: false,
      loadingOnRefresh: true,
    });
    return {
      data: result.data,
      isLoading: result.isLoading,
      error: result.error,
      refetch: result.refetch,
    };
  }

  function useMutation<TTable extends KnownTableKey<DB> & string>(
    options: UseMutationOptions<TTable>
  ): UseMutationResult {
    const client = useClient();
    const optionsRef = useLatest(options);
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const reset = useCallback(() => setError(null), []);

    const run = useCallback(
      async (operation: () => Promise<MutationReceipt>) => {
        setIsPending(true);
        setError(null);
        try {
          const result = await operation();
          if (optionsRef.current.syncImmediately !== false) {
            await client.sync();
          }
          optionsRef.current.onSuccess?.(result);
          return result;
        } catch (caught) {
          const nextError = toError(caught);
          setError(nextError);
          optionsRef.current.onError?.(nextError);
          throw nextError;
        } finally {
          setIsPending(false);
        }
      },
      [client, optionsRef]
    );

    const mutate = useMemo<FluentMutation>(() => {
      const table = client.mutations.$table(options.table);
      return {
        update: (rowId, payload, mutationOptions) =>
          run(() => table.update(rowId, payload, mutationOptions)),
        upsert: (rowId, payload, mutationOptions) =>
          run(() => table.upsert(rowId, payload, mutationOptions)),
        delete: (rowId, mutationOptions) =>
          run(() => table.delete(rowId, mutationOptions)),
      };
    }, [client, options.table, run]);

    const mutateMany = useCallback(
      (inputs: readonly MutationInput[]) =>
        run(async () => {
          const { commit } = await client.mutations.$commit(async (tx) => {
            const table = tx[optionsRef.current.table]!;
            for (const input of inputs) {
              if (input.op === 'delete') {
                await table.delete(input.rowId, {
                  baseVersion: input.baseVersion,
                });
              } else {
                await table.upsert(input.rowId, input.payload ?? {}, {
                  baseVersion: input.baseVersion,
                });
              }
            }
          });
          return commit;
        }),
      [client, optionsRef, run]
    );

    return { mutate, mutateMany, isPending, error, reset };
  }

  function useMutations(options: UseMutationsOptions = {}): MutationsHook<DB> {
    const client = useClient();
    const optionsRef = useLatest(options);
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const reset = useCallback(() => setError(null), []);

    const run = useCallback(
      async <TResult extends MutationReceipt>(
        operation: () => Promise<TResult>,
        opCount: number,
        syncOverride?: SyncMode
      ) => {
        setIsPending(true);
        setError(null);
        try {
          const result = await operation();
          const syncMode =
            syncOverride ?? optionsRef.current.sync ?? 'background';
          if (syncMode === 'await') {
            await client.sync();
          } else if (syncMode === 'background') {
            void client.sync().catch(() => undefined);
          }
          optionsRef.current.onSuccess?.({ ...result, opCount });
          return result;
        } catch (caught) {
          const nextError = toError(caught);
          setError(nextError);
          optionsRef.current.onError?.(nextError);
          throw nextError;
        } finally {
          setIsPending(false);
        }
      },
      [client, optionsRef]
    );

    return useMemo(
      () =>
        new Proxy(
          {},
          {
            get(_target, prop) {
              if (prop === 'then') return undefined;
              if (prop === '$isPending') return isPending;
              if (prop === '$error') return error;
              if (prop === '$reset') return reset;
              if (prop === '$table') {
                return (table: string) =>
                  wrapMutationsTable(client, table, run);
              }
              if (prop === '$commit') {
                return async <TResult>(
                  fn: Parameters<MutationsApi<DB>['$commit']>[0],
                  commitOptions?: { sync?: SyncMode }
                ) => {
                  let callbackResult: TResult | undefined;
                  const commit = await run(
                    async () => {
                      const result = await client.mutations.$commit(fn);
                      callbackResult = result.result as TResult;
                      return result.commit;
                    },
                    0,
                    commitOptions?.sync
                  );
                  return { result: callbackResult as TResult, commit };
                };
              }
              if (typeof prop !== 'string') return undefined;
              return wrapMutationsTable(client, prop, run);
            },
          }
        ) as MutationsHook<DB>,
      [client, error, isPending, reset, run]
    );
  }

  function useOutboxStats(): SyncularV2OutboxStats | null {
    const [stats, setStats] = useState<SyncularV2OutboxStats | null>(null);
    useSyncEvent('outboxChanged', setStats);
    return stats;
  }

  function useConflictStats(): SyncularV2ConflictStats | null {
    const [stats, setStats] = useState<SyncularV2ConflictStats | null>(null);
    useSyncEvent('conflictsChanged', setStats);
    return stats;
  }

  function usePresence<
    TMetadata extends Record<string, unknown> = Record<string, unknown>,
  >(
    scopeKey: string,
    options: { enabled?: boolean } = {}
  ): UsePresenceResult<TMetadata> {
    const client = useClient();
    const enabled = options.enabled !== false;
    const [presence, setPresence] = useState<
      SyncularV2PresenceEntry<TMetadata>[]
    >([]);
    const [isLoading, setIsLoading] = useState(enabled);

    useEffect(() => {
      if (!enabled) {
        setPresence([]);
        setIsLoading(false);
        return undefined;
      }
      setPresence(client.presence.get<TMetadata>(scopeKey));
      setIsLoading(false);
      return client.presence.onChange<TMetadata>((event) => {
        if (event.scopeKey === scopeKey) setPresence(event.presence);
      });
    }, [client, enabled, scopeKey]);

    return { presence, isLoading };
  }

  function usePresenceWithJoin<
    TMetadata extends Record<string, unknown> = Record<string, unknown>,
  >(
    scopeKey: string,
    options: UsePresenceWithJoinOptions<TMetadata> = {}
  ): UsePresenceWithJoinResult<TMetadata> {
    const client = useClient();
    const metadataRef = useLatest(options.metadata);
    const enabled = options.enabled !== false;
    const base = usePresence<TMetadata>(scopeKey, { enabled });
    const [isJoined, setIsJoined] = useState(false);

    const join = useCallback(
      (metadata?: TMetadata) => {
        client.presence.join(scopeKey, metadata);
        setIsJoined(true);
      },
      [client, scopeKey]
    );
    const leave = useCallback(() => {
      client.presence.leave(scopeKey);
      setIsJoined(false);
    }, [client, scopeKey]);
    const updateMetadata = useCallback(
      (metadata: TMetadata) => {
        client.presence.updateMetadata(scopeKey, metadata);
      },
      [client, scopeKey]
    );

    useEffect(() => {
      if (!enabled || options.autoJoin === false) return undefined;
      join(metadataRef.current);
      return () => leave();
    }, [enabled, join, leave, metadataRef, options.autoJoin]);

    return { ...base, updateMetadata, join, leave, isJoined };
  }

  function useBlobUploadQueue(): UseBlobUploadQueueResult {
    const client = useClient();
    const [stats, setStats] = useState<SyncularV2BlobUploadQueueStats | null>(
      null
    );
    const refresh = useCallback(async () => {
      setStats(await client.blobs.getUploadQueueStats());
    }, [client]);
    const process = useCallback(async () => {
      const result = await client.blobs.processUploadQueue();
      await refresh();
      return result;
    }, [client, refresh]);

    useEffect(() => {
      void refresh().catch(() => undefined);
      return client.on('blobUploadCompleted', () => {
        void refresh().catch(() => undefined);
      });
    }, [client, refresh]);

    return { stats, refresh, process };
  }

  function useBlob(ref: BlobRef | null | undefined): Uint8Array | null {
    const client = useClient();
    const [data, setData] = useState<Uint8Array | null>(null);
    useEffect(() => {
      let disposed = false;
      if (!ref) {
        setData(null);
        return undefined;
      }
      void client.blobs.retrieve(ref).then((next) => {
        if (!disposed) setData(next);
      });
      return () => {
        disposed = true;
      };
    }, [client, ref]);
    return data;
  }

  return {
    SyncProvider,
    useBlob,
    useBlobUploadQueue,
    useConflictStats,
    useMutation,
    useMutations,
    useOutboxStats,
    usePresence,
    usePresenceWithJoin,
    useQuery,
    useRowsChanged,
    useSyncConnection,
    useSyncContext,
    useSyncQuery,
  };
}

async function executeSyncQuery<DB, TResult>(
  db: Kysely<DB>,
  query: SyncQueryFn<DB, TResult>
): Promise<TResult> {
  const ctx: SyncQueryContext<DB> = {
    db,
    selectFrom: db.selectFrom.bind(db) as Kysely<DB>['selectFrom'],
  };
  const result = await Promise.resolve(query(ctx));
  if (isExecutableQuery<TResult>(result)) return await result.execute();
  return result;
}

function isExecutableQuery<TResult>(
  value: unknown
): value is ExecutableQuery<TResult> {
  return isRecord(value) && typeof value.execute === 'function';
}

function wrapMutationsTable<DB>(
  client: SyncularClientLike<DB>,
  table: string,
  run: <TResult extends MutationReceipt>(
    operation: () => Promise<TResult>,
    opCount: number,
    syncOverride?: SyncMode
  ) => Promise<TResult>
): AnyTableMutations {
  const tableApi = client.mutations.$table(table);
  return {
    insert: (values) => run(() => tableApi.insert(values), 1),
    insertMany: (rows) => run(() => tableApi.insertMany(rows), rows.length),
    update: (id, patch, options) =>
      run(() => tableApi.update(id, patch, options), 1),
    delete: (id, options) => run(() => tableApi.delete(id, options), 1),
    upsert: (id, patch, options) =>
      run(() => tableApi.upsert(id, patch, options), 1),
  };
}

function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function stableStringListKey(values: readonly string[] | undefined): string {
  return values == null ? '' : values.join('\u0001');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function shareQueryResult<TResult>(
  previous: TResult | undefined,
  next: TResult,
  keyField: string,
  enabled: boolean
): TResult {
  if (!enabled || previous === undefined) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    return shareArrayResult(previous, next, keyField) as TResult;
  }
  if (
    isRecord(previous) &&
    isRecord(next) &&
    shallowEqualRecords(previous, next)
  ) {
    return previous;
  }
  return next;
}

function shareArrayResult<T>(previous: T[], next: T[], keyField: string): T[] {
  if (previous.length === 0 || next.length === 0) return next;
  const previousByKey = new Map<string, T>();
  for (const item of previous) {
    const key = keyedValue(item, keyField);
    if (key == null) return next;
    previousByKey.set(key, item);
  }

  let changed = previous.length !== next.length;
  const shared = next.map((item, index) => {
    const key = keyedValue(item, keyField);
    const previousItem = key == null ? undefined : previousByKey.get(key);
    if (
      previousItem !== undefined &&
      isRecord(previousItem) &&
      isRecord(item) &&
      shallowEqualRecords(previousItem, item)
    ) {
      if (!Object.is(previousItem, previous[index])) changed = true;
      return previousItem;
    }
    if (!Object.is(item, previous[index])) changed = true;
    return item;
  });

  return changed ? shared : previous;
}

function keyedValue(value: unknown, keyField: string): string | null {
  if (!isRecord(value)) return null;
  const key = value[keyField];
  return key == null ? null : String(key);
}

function shallowEqualRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!(key in right) || !Object.is(left[key], right[key])) return false;
  }
  return true;
}

export function changedRowsForTable(
  event: SyncularV2RowsChangedEvent,
  table: string
): SyncularV2ChangedRow[] {
  return event.changedRows.filter((row) => row.table === table);
}
