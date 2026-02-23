/**
 * @syncular/client-react - React bindings (typed)
 *
 * Use `createSyncularReact<DB>()` to create a SyncProvider + hooks that are
 * typed to your application's DB schema.
 */

export type { AsyncInitRegistry } from './async-init-registry';
export { createAsyncInitRegistry } from './async-init-registry';
export type {
  ConflictResolution,
  FluentMutation,
  MutationInput,
  MutationResult,
  MutationsHook,
  OutboxCommit,
  SyncContextValue,
  SyncProviderProps,
  SyncStatus,
  UseConflictsResult,
  UseMutationOptions,
  UseMutationResult,
  UseMutationsOptions,
  UseOutboxResult,
  UsePresenceResult,
  UsePresenceWithJoinOptions,
  UsePresenceWithJoinResult,
  UseQueryOptions,
  UseQueryResult,
  UseResolveConflictOptions,
  UseResolveConflictResult,
  UseSyncConnectionResult,
  UseSyncEngineResult,
  UseSyncInspectorOptions,
  UseSyncInspectorResult,
  UseSyncProgressOptions,
  UseSyncProgressResult,
  UseSyncQueryOptions,
  UseSyncQueryResult,
  UseSyncStatusOptions,
  UseSyncSubscriptionResult,
  UseSyncSubscriptionsOptions,
  UseSyncSubscriptionsResult,
  UseTransportHealthResult,
} from './createSyncularReact';
// Re-export core client types for convenience.
export { createSyncularReact } from './createSyncularReact';
export type { UseCachedAsyncValueOptions } from './use-cached-async-value';
export {
  clearCachedAsyncValues,
  invalidateCachedAsyncValue,
  useCachedAsyncValue,
} from './use-cached-async-value';
export type {
  SyncGroupChannel,
  SyncGroupChannelSnapshot,
  SyncGroupStatus,
  UseSyncGroupResult,
} from './useSyncGroup';
export { useSyncGroup } from './useSyncGroup';
