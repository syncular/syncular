import { useContext } from 'react';
import type { NormalizedClient } from './client';
import { SyncContext } from './provider';

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
