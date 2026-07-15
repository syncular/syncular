import type { CommitOutcome } from '@syncular/client';
import { useCallback, useSyncExternalStore } from 'react';
import { useReactiveStore } from './use-client';

export interface UseCommitOutcomesResult {
  readonly outcomes: readonly CommitOutcome[];
  readonly isLoading: boolean;
  readonly error: Error | undefined;
  readonly refresh: () => void;
}

/**
 * Durable newest-first commit history. It updates from the exact
 * `outcomesChanged` transaction event, including resolution transitions.
 */
export function useCommitOutcomes(): UseCommitOutcomesResult {
  const entry = useReactiveStore().outcomes;
  const snapshot = useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );
  const refresh = useCallback(() => entry.refresh(), [entry]);
  return {
    outcomes: snapshot.outcomes,
    isLoading: snapshot.isLoading,
    error: snapshot.error,
    refresh,
  };
}
