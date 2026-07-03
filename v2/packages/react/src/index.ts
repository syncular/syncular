/**
 * @syncular-v2/react — React bindings with fine-grained live queries
 * (TODO 3.1 / DESIGN-eviction I1–I4). Works against BOTH `SyncClient`
 * (direct) and `SyncClientHandle` (worker) through one normalized client
 * interface. React 18+ (react is a peer dependency); no other runtime deps.
 *
 * See README.md for the invalidation granularity truth and the `tables`
 * option.
 */
export type {
  NormalizedClient,
  SyncClientLike,
} from './client';
export { inferTables } from './infer-tables';
export { SyncContext, SyncProvider, type SyncProviderProps } from './provider';
export { useSyncClient } from './use-client';
export { type UseConflictsResult, useConflicts } from './use-conflicts';
export { type UseMutationResult, useMutation } from './use-mutation';
export { usePresence } from './use-presence';
export {
  type UseSyncQueryOptions,
  type UseSyncQueryResult,
  useSyncQuery,
} from './use-sync-query';
export { type SyncStatus, useSyncStatus } from './use-sync-status';
