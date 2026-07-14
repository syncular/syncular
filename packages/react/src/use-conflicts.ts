import type { ConflictRecord, RejectionRecord } from '@syncular/client';
import { useCallback, useSyncExternalStore } from 'react';
import { useReactiveStore } from './use-client';

export interface UseConflictsResult {
  readonly conflicts: readonly ConflictRecord[];
  readonly rejections: readonly RejectionRecord[];
  readonly isLoading: boolean;
  readonly error: Error | undefined;
  readonly refresh: () => void;
}

export function useConflicts(): UseConflictsResult {
  const entry = useReactiveStore().conflicts;
  const snapshot = useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );
  const refresh = useCallback(() => entry.refresh(), [entry]);
  return {
    conflicts: snapshot.conflicts as readonly ConflictRecord[],
    rejections: snapshot.rejections as readonly RejectionRecord[],
    isLoading: snapshot.isLoading,
    error: snapshot.error,
    refresh,
  };
}
