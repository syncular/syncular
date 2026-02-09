import { createSyncularReact } from '@syncular/client-react';
import type { ClientDb } from './types.generated';

export const {
  SyncProvider,
  useConflicts,
  useMutation,
  useMutations,
  useSyncContext,
  useSyncConnection,
  useSyncEngine,
  useSyncQuery,
  useSyncStatus,
} = createSyncularReact<ClientDb>();
