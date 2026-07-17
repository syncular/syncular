/**
 * `SyncProvider` — supplies a `SyncClient` or `SyncClientHandle` to the
 * hook tree through React context. One provider per client; the hooks read
 * the normalized facade. Written with `createElement` (no JSX) so the whole
 * package typechecks under the repo's `.ts`-only root tsconfig with no jsx
 * setting — the bindings are plain function components either way.
 */
import {
  ClientSyncError,
  ReactiveClientStore,
  type SyncAvailability,
} from '@syncular/client';
import {
  createContext,
  createElement,
  type ReactNode,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  type NormalizedClient,
  normalizeClient,
  type SyncClientLike,
} from './client';
import { isSyncClientResource, type SyncClientResource } from './resource';

export const SyncContext = createContext<NormalizedClient | undefined>(
  undefined,
);
export const SyncStoreContext = createContext<ReactiveClientStore | undefined>(
  undefined,
);

export interface SyncProviderProps {
  /** A `SyncClient` (direct) or `SyncClientHandle` (worker) — both satisfy it. */
  readonly client: SyncClientLike | SyncClientResource;
  readonly children?: ReactNode;
  readonly fallback?: ReactNode;
  readonly renderError?: (
    error: Error,
    retry: () => Promise<void>,
  ) => ReactNode;
  readonly renderBoundary?: (
    state: SyncBoundaryState,
    actions: SyncBoundaryActions,
  ) => ReactNode;
}

export type SyncBoundaryState =
  | { readonly state: 'starting' }
  | {
      readonly state: 'startup-error';
      readonly error: Error;
      readonly retryable: boolean;
    }
  | Exclude<SyncAvailability, { readonly state: 'ready' }>;

export interface SyncBoundaryActions {
  readonly retry?: () => Promise<void>;
}

interface ClientRecord {
  readonly normalized: NormalizedClient;
  readonly store: ReactiveClientStore;
  refs: number;
}

const stores = new WeakMap<object, ClientRecord>();

function recordFor(client: SyncClientLike): ClientRecord {
  const key = client as object;
  let record = stores.get(key);
  if (record === undefined) {
    const normalized = normalizeClient(client);
    record = {
      normalized,
      store: new ReactiveClientStore(normalized),
      refs: 0,
    };
    stores.set(key, record);
  }
  return record;
}

interface ReadySyncProviderProps {
  readonly client: SyncClientLike;
  readonly children?: ReactNode;
  readonly renderBoundary?: SyncProviderProps['renderBoundary'];
  readonly retry?: () => Promise<void>;
}

function ReadySyncProvider(props: ReadySyncProviderProps): ReactNode {
  const record = useMemo(() => recordFor(props.client), [props.client]);
  const { normalized, store } = record;
  const status = useSyncExternalStore(
    store.status.subscribe,
    store.status.getSnapshot,
    store.status.getSnapshot,
  );
  useEffect(() => {
    record.refs += 1;
    store.start();
    return () => {
      record.refs -= 1;
      queueMicrotask(() => {
        if (record.refs === 0) store.dispose();
      });
    };
  }, [record, store]);
  if (props.renderBoundary !== undefined) {
    if (status.isLoading) {
      return props.renderBoundary(
        { state: 'starting' },
        props.retry === undefined ? {} : { retry: props.retry },
      );
    }
    const availability = store.availabilitySnapshot();
    if (availability.state !== 'ready') {
      return props.renderBoundary(
        availability,
        props.retry === undefined ? {} : { retry: props.retry },
      );
    }
  }
  return createElement(
    SyncContext.Provider,
    { value: normalized },
    createElement(SyncStoreContext.Provider, { value: store }, props.children),
  );
}

const noSubscribe = (): (() => void) => () => {};

export function SyncProvider(props: SyncProviderProps): ReactNode {
  const resource = isSyncClientResource(props.client)
    ? props.client
    : undefined;
  const readySnapshot = useMemo(
    () =>
      resource === undefined
        ? ({ phase: 'ready', client: props.client as SyncClientLike } as const)
        : undefined,
    [props.client, resource],
  );
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? noSubscribe,
    resource?.getSnapshot ??
      (() => readySnapshot as NonNullable<typeof readySnapshot>),
    resource?.getSnapshot ??
      (() => readySnapshot as NonNullable<typeof readySnapshot>),
  );
  if (snapshot.phase === 'pending') {
    if (props.renderBoundary !== undefined) {
      return props.renderBoundary(
        { state: 'starting' },
        resource === undefined ? {} : { retry: resource.retry },
      );
    }
    return props.fallback ?? null;
  }
  if (snapshot.phase === 'error') {
    if (props.renderBoundary !== undefined) {
      return props.renderBoundary(
        {
          state: 'startup-error',
          error: snapshot.error,
          retryable:
            snapshot.error instanceof ClientSyncError
              ? snapshot.error.retryable
              : false,
        },
        resource === undefined ? {} : { retry: resource.retry },
      );
    }
    if (props.renderError !== undefined && resource !== undefined)
      return props.renderError(snapshot.error, resource.retry);
    throw snapshot.error;
  }
  return createElement(
    ReadySyncProvider,
    {
      client: snapshot.client,
      ...(props.renderBoundary !== undefined
        ? { renderBoundary: props.renderBoundary }
        : {}),
      ...(resource !== undefined ? { retry: resource.retry } : {}),
    },
    props.children,
  );
}
