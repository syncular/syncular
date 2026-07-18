/**
 * @syncular/react — React bindings with fine-grained live queries
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
// `normalizeClient` is the runtime facade the hooks consume; exported so
// alternate hosts (e.g. `@syncular/tauri`) can assert shape-parity against
// the exact normalizer the bindings use.
export { normalizeClient } from './client';
export { inferTables } from './infer-tables';
export {
  type SyncBoundaryActions,
  type SyncBoundaryState,
  SyncContext,
  SyncProvider,
  type SyncProviderProps,
  SyncStoreContext,
} from './provider';
export {
  createSyncClientResource,
  isSyncClientResource,
  type SyncClientResource,
  type SyncClientResourceSnapshot,
} from './resource';
export { useReactiveStore, useSyncClient } from './use-client';
export {
  type UseCommitOutcomesResult,
  useCommitOutcomes,
} from './use-commit-outcomes';
export { type UseConflictsResult, useConflicts } from './use-conflicts';
export {
  type UseDiagnosticsOptions,
  type UseDiagnosticsResult,
  useDiagnostics,
} from './use-diagnostics';
export {
  type SyncTableDescriptor,
  type UseMutationOptions,
  type UseMutationResult,
  type UseTableMutationResult,
  useMutation,
} from './use-mutation';
export { usePresence } from './use-presence';
export {
  type NamedQueryDescriptor,
  useQuery,
} from './use-query';
export {
  type UseRawSqlOptions,
  type UseRawSqlResult,
  useRawSql,
} from './use-raw-sql';
export { type SyncStatus, useSyncStatus } from './use-sync-status';
export {
  type UseRetainedWindowResult,
  type UseWindowResult,
  useRetainedWindow,
  useWindow,
} from './use-window';
export {
  type RetainedSyncularResource,
  retainViteSyncClientResource,
  type ViteSyncClientResourceResult,
} from './vite-hmr';
