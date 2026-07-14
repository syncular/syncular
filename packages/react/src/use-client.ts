import type { ReactiveClientStore } from '@syncular/client';
import { useContext } from 'react';
import type { NormalizedClient } from './client';
import { SyncContext, SyncStoreContext } from './provider';

/** Read the normalized client from context; throws outside a `SyncProvider`. */
export function useSyncClient(): NormalizedClient {
  const client = useContext(SyncContext);
  if (client === undefined) {
    throw new Error(
      '@syncular/react: no client in context — wrap your tree in <SyncProvider client={…}>',
    );
  }
  return client;
}

export function useReactiveStore(): ReactiveClientStore {
  const store = useContext(SyncStoreContext);
  if (store === undefined) {
    throw new Error(
      '@syncular/react: no client in context (reactive store unavailable) — wrap your tree in <SyncProvider client={…}>',
    );
  }
  return store;
}
