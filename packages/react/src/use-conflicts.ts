/**
 * `useConflicts` — the accumulated conflict records (§6.2/§6.5) and
 * rejections (§6.3) the client has surfaced. Re-read after every apply
 * batch (a push result lands through the same choke point) plus on mount.
 */

import type { ConflictRecord, RejectionRecord } from '@syncular/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSyncClient } from './use-client';

export interface UseConflictsResult {
  readonly conflicts: readonly ConflictRecord[];
  readonly rejections: readonly RejectionRecord[];
  readonly refresh: () => void;
}

export function useConflicts(): UseConflictsResult {
  const client = useSyncClient();
  const [conflicts, setConflicts] = useState<readonly ConflictRecord[]>([]);
  const [rejections, setRejections] = useState<readonly RejectionRecord[]>([]);
  const readRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => readRef.current(), []);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      Promise.all([client.conflicts(), client.rejections()])
        .then(([c, r]) => {
          if (cancelled) return;
          setConflicts(c);
          setRejections(r);
        })
        .catch(() => {
          /* transient read failure — the next batch re-reads */
        });
    };
    readRef.current = read;
    read();
    const unsubscribe = client.onInvalidate(read);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  return { conflicts, rejections, refresh };
}
