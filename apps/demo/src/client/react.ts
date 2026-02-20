import {
  createAsyncInitRegistry,
  createSyncularReact,
  useCachedAsyncValue,
} from '@syncular/client-react';
import type { ClientDb } from './types.generated';

export const {
  SyncProvider,
  useConflicts,
  useMutation,
  useOutbox,
  useMutations,
  useResolveConflict,
  useSyncContext,
  useSyncEngine,
  useSyncStatus,
  useSyncConnection,
  useSyncQuery,
} = createSyncularReact<ClientDb>();

export { createAsyncInitRegistry };
export { useCachedAsyncValue };
