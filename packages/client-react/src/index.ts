/**
 * @syncular/client-react - React bindings (typed)
 *
 * Use `createSyncularReact<DB>()` to create a SyncProvider + hooks that are
 * typed to your application's DB schema.
 */

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
  UseSyncQueryOptions,
  UseSyncQueryResult,
} from './createSyncularReact';
// Re-export core client types for convenience.
export { createSyncularReact } from './createSyncularReact';
