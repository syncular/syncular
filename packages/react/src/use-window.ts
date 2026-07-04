/**
 * `useWindow(base)` — the windowed-sync surface for a component
 * (SPEC.md §4.8 / DESIGN-eviction.md W1, I3). It manages the live window
 * units for a base and exposes the **completeness oracle**: which scope
 * values are held locally in full, so a consumer can render "this data may
 * be partial" honestly instead of silently serving a partial replica as
 * complete.
 *
 * - `setWindow(units)` swaps the live set (added units bootstrap via the
 *   image lane; removed units are evicted, fused with unsubscription).
 * - `units` is the current windowed-in set (re-read on mount and whenever
 *   the base's table is invalidated — so a deferred eviction draining, or
 *   a re-entry bootstrapping, updates the verdict).
 * - `isComplete(unit)` is the per-value verdict: a live query whose scope
 *   footprint includes a non-`isComplete` unit is a **window miss** — widen
 *   or show partial, never claim complete.
 */
import type { WindowBase } from '@syncular-v2/web-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSyncClient } from './use-client';

export interface UseWindowResult {
  /** The scope values currently windowed-in for this base. */
  readonly units: readonly string[];
  /** Set the live units (widen/shrink diff, §4.8). */
  readonly setWindow: (units: readonly string[]) => Promise<void>;
  /** True iff `unit` is windowed-in (answerable in full locally, I3). */
  readonly isComplete: (unit: string) => boolean;
}

export function useWindow(base: WindowBase): UseWindowResult {
  const client = useSyncClient();
  const [units, setUnits] = useState<readonly string[]>([]);

  // A stable key so the effects re-run only when the base identity changes,
  // not on every render's fresh object. The latest `base` is read via a ref
  // inside the closures (the useSyncQuery pattern), so the dep list stays on
  // primitive keys.
  const baseKey = `${base.table} ${base.variable} ${JSON.stringify(
    base.fixedScopes ?? {},
  )} ${base.params ?? ''}`;
  const baseRef = useRef(base);
  baseRef.current = base;

  // `baseKey` re-keys the effect without being read in the body (biome cannot
  // see the ref indirection) — the dep list is pinned deliberately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: baseKey re-keys the effect for a fresh base object
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      Promise.resolve(client.windowState(baseRef.current))
        .then((state) => {
          if (!cancelled) setUnits(state.units);
        })
        .catch(() => {
          /* transient — the next invalidation re-reads */
        });
    };
    read();
    // Re-read when the base's table changes locally: a deferred eviction
    // (E1) completing or a re-entry bootstrapping both invalidate it.
    const unsubscribe = client.onInvalidate((event) => {
      if (event.tables.has(baseRef.current.table)) read();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, baseKey]);

  const setWindow = useCallback(
    (next: readonly string[]) => {
      const result = Promise.resolve(client.setWindow(baseRef.current, next));
      // Optimistically reflect the new set; the invalidation-driven re-read
      // reconciles against the registry (e.g. a pinned unit lingering).
      setUnits(next);
      return result;
    },
    [client],
  );

  const isComplete = useCallback(
    (unit: string) => units.includes(unit),
    [units],
  );

  return { units, setWindow, isComplete };
}
