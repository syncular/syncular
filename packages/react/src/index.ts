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
// `normalizeClient` is the runtime facade the hooks consume; exported so
// alternate hosts (e.g. `@syncular-v2/tauri`) can assert shape-parity against
// the exact normalizer the bindings use.
export { normalizeClient } from './client';
export { inferTables } from './infer-tables';
export { SyncContext, SyncProvider, type SyncProviderProps } from './provider';
export { useSyncClient } from './use-client';
export { type UseConflictsResult, useConflicts } from './use-conflicts';
export { type UseMutationResult, useMutation } from './use-mutation';
export {
  type NamedQueryDescriptor,
  useNamedQuery,
} from './use-named-query';
export { usePresence } from './use-presence';
export {
  type UseSyncQueryOptions,
  type UseSyncQueryResult,
  useSyncQuery,
} from './use-sync-query';
export { type SyncStatus, useSyncStatus } from './use-sync-status';
export { type UseWindowResult, useWindow } from './use-window';
// NOTE: `useTypedQuery` is intentionally NOT re-exported here — it needs the
// `@syncular-v2/kysely` + `kysely` peers. It lives behind the `./typed`
// subpath so apps using only `useSyncQuery` never pull Kysely into their
// bundle. Import it as `@syncular-v2/react/typed`.
