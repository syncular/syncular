import type { BlobRef } from '@syncular/core';
import type { CompiledQuery } from 'kysely';
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  createSyncularV2Client,
  type CreateSyncularV2ClientOptions,
  type SyncularV2ManagedClient,
} from './client';
import type {
  SyncularV2BlobUploadQueueStats,
  SyncularV2ChangedRow,
  SyncularV2ClientEventMap,
  SyncularV2ClientEventType,
  SyncularV2ConflictStats,
  SyncularV2ConnectionState,
  SyncularV2LiveQueryChange,
  SyncularV2OutboxStats,
  SyncularV2PresenceEntry,
  SyncularV2RowsChangedEvent,
} from './types';

export type SyncularV2ReactStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SyncularV2ReactProviderProps<DB> {
  children?: ReactNode;
  client?: SyncularV2ManagedClient<DB>;
  options?: CreateSyncularV2ClientOptions;
  optionsKey?: unknown;
  destroyOnUnmount?: boolean;
  onClient?: (client: SyncularV2ManagedClient<DB>) => void;
  onError?: (error: unknown) => void;
}

export interface SyncularV2ReactContextValue<DB> {
  client: SyncularV2ManagedClient<DB> | null;
  status: SyncularV2ReactStatus;
  error: unknown;
}

export interface UseSyncularV2LiveQueryOptions {
  tables?: readonly string[];
  enabled?: boolean;
  deps?: readonly unknown[];
}

export interface UseSyncularV2LiveQueryResult<
  Row extends Record<string, unknown>,
> {
  rows: Row[];
  change: SyncularV2LiveQueryChange<Row> | null;
  isLoading: boolean;
  error: unknown;
}

export interface UseSyncularV2RowsChangedOptions {
  tables?: readonly string[];
  enabled?: boolean;
}

export interface UseSyncularV2PresenceOptions<TMetadata> {
  scopeKey: string;
  metadata?: TMetadata;
  join?: boolean;
  enabled?: boolean;
}

export interface UseSyncularV2PresenceResult<TMetadata> {
  members: SyncularV2PresenceEntry<TMetadata>[];
  updateMetadata(metadata: TMetadata): void;
  leave(): void;
  join(metadata?: TMetadata): void;
}

export interface UseSyncularV2MutationOptions<Result> {
  onSuccess?: (result: Result) => void;
  onError?: (error: unknown) => void;
}

export interface UseSyncularV2MutationResult<Args extends unknown[], Result> {
  mutate(...args: Args): Promise<Result>;
  isPending: boolean;
  error: unknown;
}

export interface UseSyncularV2BlobUploadQueueResult {
  stats: SyncularV2BlobUploadQueueStats | null;
  refresh(): Promise<void>;
  process(): Promise<{ uploaded: number; failed: number }>;
}

type QueryLike = { compile(): CompiledQuery };

type SyncularV2ReactContextInternal =
  SyncularV2ReactContextValue<unknown> | null;

export function createSyncularV2React<DB>() {
  const Context = createContext<SyncularV2ReactContextInternal>(null);

  function SyncularProvider(
    props: SyncularV2ReactProviderProps<DB>
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
    const [value, setValue] = useState<SyncularV2ReactContextValue<DB>>({
      client: providedClient ?? null,
      status: providedClient ? 'ready' : options ? 'loading' : 'idle',
      error: null,
    });

    useEffect(() => {
      let cancelled = false;
      let ownedClient: SyncularV2ManagedClient<DB> | null = null;

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
      void createSyncularV2Client<DB>(currentOptions)
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
      onClientRef,
      onErrorRef,
      optionsKey,
      optionsRef,
      providedClient,
    ]);

    return createElement(Context.Provider, {
      value: value as SyncularV2ReactContextInternal,
      children,
    });
  }

  function useSyncularContext(): SyncularV2ReactContextValue<DB> {
    const value = useContext(Context);
    if (!value) {
      throw new Error('SyncularProvider is required for Rust client React hooks.');
    }
    return value as SyncularV2ReactContextValue<DB>;
  }

  function useSyncularClient(): SyncularV2ManagedClient<DB> {
    const { client, status, error } = useSyncularContext();
    if (!client) {
      if (status === 'error') throw error;
      throw new Error('Syncular Rust client is not ready yet.');
    }
    return client;
  }

  function useSyncularConnection(): SyncularV2ConnectionState {
    const client = useSyncularClient();
    return useSyncExternalStore(
      useCallback(
        (notify) => client.client.addDiagnosticListener(() => notify()),
        [client]
      ),
      useCallback(() => client.client.connectionState(), [client]),
      useCallback(() => client.client.connectionState(), [client])
    );
  }

  function useSyncularEvent<T extends SyncularV2ClientEventType>(
    event: T,
    listener: (payload: SyncularV2ClientEventMap[T]) => void,
    enabled = true
  ): void {
    const client = useSyncularClient();
    const listenerRef = useLatest(listener);
    useEffect(() => {
      if (!enabled) return undefined;
      return client.client.addEventListener(event, (payload) =>
        listenerRef.current(payload)
      );
    }, [client, enabled, event, listenerRef]);
  }

  function useLiveQuery<Row extends Record<string, unknown>>(
    query: QueryLike | (() => QueryLike),
    options: UseSyncularV2LiveQueryOptions = {}
  ): UseSyncularV2LiveQueryResult<Row> {
    const client = useSyncularClient();
    const enabled = options.enabled !== false;
    const queryRef = useLatest(query);
    const tablesRef = useLatest(options.tables);
    const deps = options.deps ?? [];
    const tablesKey = stableStringListKey(options.tables);
    const [rows, setRows] = useState<Row[]>([]);
    const [change, setChange] = useState<SyncularV2LiveQueryChange<Row> | null>(
      null
    );
    const [isLoading, setIsLoading] = useState(enabled);
    const [error, setError] = useState<unknown>(null);

    useEffect(() => {
      if (!enabled) {
        setIsLoading(false);
        return undefined;
      }
      let disposed = false;
      let unsubscribe: (() => void) | undefined;
      setIsLoading(true);
      setError(null);
      const currentQuery = queryRef.current;
      const resolvedQuery =
        typeof currentQuery === 'function' ? currentQuery() : currentQuery;
      void client
        .live<Row>(resolvedQuery, {
          tables: tablesRef.current,
          onChange(nextRows, nextChange) {
            if (disposed) return;
            setRows(nextRows);
            setChange(nextChange);
            setIsLoading(false);
          },
        })
        .then((subscription) => {
          if (disposed) {
            subscription.unsubscribe();
            return;
          }
          unsubscribe = subscription.unsubscribe;
        })
        .catch((caught) => {
          if (disposed) return;
          setError(caught);
          setIsLoading(false);
        });

      return () => {
        disposed = true;
        unsubscribe?.();
      };
    }, [client, enabled, queryRef, tablesKey, tablesRef, ...deps]);

    return { rows, change, isLoading, error };
  }

  function useRowsChanged(
    listener: (event: SyncularV2RowsChangedEvent) => void,
    options: UseSyncularV2RowsChangedOptions = {}
  ): void {
    const tables = options.tables == null ? null : new Set(options.tables);
    useSyncularEvent(
      'rowsChanged',
      (event) => {
        if (
          tables &&
          !event.changedTables.some((table) => tables.has(table))
        ) {
          return;
        }
        listener(event);
      },
      options.enabled !== false
    );
  }

  function useOutboxStats(): SyncularV2OutboxStats | null {
    const [stats, setStats] = useState<SyncularV2OutboxStats | null>(null);
    useSyncularEvent('outboxChanged', setStats);
    return stats;
  }

  function useConflictStats(): SyncularV2ConflictStats | null {
    const [stats, setStats] = useState<SyncularV2ConflictStats | null>(null);
    useSyncularEvent('conflictsChanged', setStats);
    return stats;
  }

  function usePresence<TMetadata extends Record<string, unknown>>(
    options: UseSyncularV2PresenceOptions<TMetadata>
  ): UseSyncularV2PresenceResult<TMetadata> {
    const client = useSyncularClient();
    const enabled = options.enabled !== false;
    const [members, setMembers] = useState<
      SyncularV2PresenceEntry<TMetadata>[]
    >(() =>
      enabled
        ? client.client.getPresence<TMetadata>(options.scopeKey)
        : []
    );
    const metadataRef = useLatest(options.metadata);

    const refresh = useCallback(() => {
      setMembers(client.client.getPresence<TMetadata>(options.scopeKey));
    }, [client, options.scopeKey]);

    useEffect(() => {
      if (!enabled) {
        setMembers([]);
        return undefined;
      }
      refresh();
      return client.client.addPresenceListener<TMetadata>((event) => {
        if (event.scopeKey === options.scopeKey) setMembers(event.presence);
      });
    }, [client, enabled, options.scopeKey, refresh]);

    useEffect(() => {
      if (!enabled || options.join === false) return undefined;
      client.client.joinPresence(options.scopeKey, metadataRef.current);
      refresh();
      return () => {
        client.client.leavePresence(options.scopeKey);
        refresh();
      };
    }, [client, enabled, metadataRef, options.join, options.scopeKey, refresh]);

    const updateMetadata = useCallback(
      (metadata: TMetadata) => {
        client.client.updatePresenceMetadata(options.scopeKey, metadata);
        refresh();
      },
      [client, options.scopeKey, refresh]
    );
    const leave = useCallback(() => {
      client.client.leavePresence(options.scopeKey);
      refresh();
    }, [client, options.scopeKey, refresh]);
    const join = useCallback(
      (metadata?: TMetadata) => {
        client.client.joinPresence(options.scopeKey, metadata);
        refresh();
      },
      [client, options.scopeKey, refresh]
    );

    return { members, updateMetadata, leave, join };
  }

  function useMutation<Args extends unknown[], Result>(
    mutation: (
      client: SyncularV2ManagedClient<DB>,
      ...args: Args
    ) => Promise<Result>,
    options: UseSyncularV2MutationOptions<Result> = {}
  ): UseSyncularV2MutationResult<Args, Result> {
    const client = useSyncularClient();
    const mutationRef = useLatest(mutation);
    const optionsRef = useLatest(options);
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<unknown>(null);

    const mutate = useCallback(
      async (...args: Args) => {
        setIsPending(true);
        setError(null);
        try {
          const result = await mutationRef.current(client, ...args);
          optionsRef.current.onSuccess?.(result);
          return result;
        } catch (caught) {
          setError(caught);
          optionsRef.current.onError?.(caught);
          throw caught;
        } finally {
          setIsPending(false);
        }
      },
      [client, mutationRef, optionsRef]
    );

    return { mutate, isPending, error };
  }

  function useBlobUploadQueue(): UseSyncularV2BlobUploadQueueResult {
    const client = useSyncularClient();
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
      return client.client.addEventListener('blobUploadCompleted', () => {
        void refresh().catch(() => undefined);
      });
    }, [client, refresh]);

    return { stats, refresh, process };
  }

  function useBlob(ref: BlobRef | null | undefined): Uint8Array | null {
    const client = useSyncularClient();
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
    SyncularProvider,
    useBlob,
    useBlobUploadQueue,
    useConflictStats,
    useLiveQuery,
    useMutation,
    useOutboxStats,
    usePresence,
    useRowsChanged,
    useSyncularClient,
    useSyncularConnection,
    useSyncularContext,
    useSyncularEvent,
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

export function changedRowsForTable(
  event: SyncularV2RowsChangedEvent,
  table: string
): SyncularV2ChangedRow[] {
  return event.changedRows.filter((row) => row.table === table);
}
