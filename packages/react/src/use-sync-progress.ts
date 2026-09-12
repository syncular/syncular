import type { SyncProgress, SyncProgressListener } from '@syncular/client';
import { useCallback, useSyncExternalStore } from 'react';

/** Live work snapshots; completion refers to one round (SPEC §7.6). */
export function useSyncProgress(client: {
  onProgress(listener: SyncProgressListener): () => void;
  progressSnapshot(): SyncProgress | undefined;
}): SyncProgress | undefined {
  const subscribe = useCallback(
    (notify: () => void) => client.onProgress(notify),
    [client],
  );
  const snapshot = useCallback(() => client.progressSnapshot(), [client]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
