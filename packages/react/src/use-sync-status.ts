/**
 * `useSyncStatus` — the client's operational status: outbox depth,
 * upgrading (§7.4.5), leaseState (§7.3.5), schemaFloor (§1.6), and
 * syncNeeded (§8.4). Status is derived by polling the normalized accessors
 * after every apply batch (invalidation is the natural "something changed"
 * signal) plus an initial read; `refresh()` re-reads on demand.
 *
 * `online` is not a protocol concept the client exposes directly (§1.3
 * transport-owned), so it is reported as `undefined` unless a future
 * accessor lands — the hook surfaces what the core actually knows, never a
 * guessed value.
 */

import type { LeaseState, SchemaFloor } from '@syncular/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSyncClient } from './use-client';

export interface SyncStatus {
  /** Pending outbox commits (unpushed local writes). */
  readonly outbox: number;
  /** §7.4.5: a schema-bump reset + first re-bootstrap is in flight. */
  readonly upgrading: boolean;
  /** §7.3.5: opaque auth-lease state, or undefined. */
  readonly leaseState: LeaseState | undefined;
  /** §1.6: server-declared schema floor (syncing stopped), or undefined. */
  readonly schemaFloor: SchemaFloor | undefined;
  /** §8.4: the host loop should run a pull soon. */
  readonly syncNeeded: boolean;
  /** True until the first status read resolves. */
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

const INITIAL: Omit<SyncStatus, 'refresh'> = {
  outbox: 0,
  upgrading: false,
  leaseState: undefined,
  schemaFloor: undefined,
  syncNeeded: false,
  isLoading: true,
};

export function useSyncStatus(): SyncStatus {
  const client = useSyncClient();
  const [state, setState] = useState(INITIAL);
  // `refresh` re-reads through a ref set by the effect (identity-stable, no
  // tick state — biome-clean deps).
  const readRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => readRef.current(), []);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      Promise.all([
        client.pendingCommits(),
        client.upgrading(),
        client.leaseState(),
        client.schemaFloor(),
        client.syncNeeded(),
      ])
        .then(([pending, upgrading, leaseState, schemaFloor, syncNeeded]) => {
          if (cancelled) return;
          setState({
            outbox: pending.length,
            upgrading,
            leaseState,
            schemaFloor,
            syncNeeded,
            isLoading: false,
          });
        })
        .catch(() => {
          if (!cancelled) setState((s) => ({ ...s, isLoading: false }));
        });
    };
    readRef.current = read;
    read();
    // Re-read on every apply batch — the "state changed" edge.
    const unsubscribe = client.onInvalidate(read);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  return { ...state, refresh };
}
