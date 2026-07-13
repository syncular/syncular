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
 * - `units` is the current windowed-in set, `pending` the subset whose
 *   bootstrap has not yet landed (re-read on mount and whenever the base's
 *   table is invalidated — a deferred eviction draining, a re-entry
 *   bootstrapping, or a bootstrap completing all update the verdict).
 * - `isComplete(unit)` is the per-value verdict: registered AND
 *   bootstrap-complete. A live query whose scope footprint includes a
 *   non-`isComplete` unit is a **window miss or still loading** — widen,
 *   wait, or show partial, never claim complete. Between `setWindow` and
 *   the unit's bootstrap landing the verdict is `false` (the local replica
 *   is empty or partial there — never a false "empty" render).
 */
import {
  type WindowBase,
  type WindowState,
  windowComplete,
} from '@syncular/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSyncClient } from './use-client';

export interface UseWindowResult {
  /** The scope values currently windowed-in for this base. */
  readonly units: readonly string[];
  /** Registered units whose bootstrap has not yet completed (§4.8). */
  readonly pending: readonly string[];
  /** Set the live units (widen/shrink diff, §4.8). */
  readonly setWindow: (units: readonly string[]) => Promise<void>;
  /** True iff `unit` is windowed-in AND bootstrapped (answerable, I3). */
  readonly isComplete: (unit: string) => boolean;
}

const EMPTY: WindowState = { units: [], pending: [] };

export function useWindow(base: WindowBase): UseWindowResult {
  const client = useSyncClient();
  const [state, setState] = useState<WindowState>(EMPTY);

  // A stable key so the effects re-run only when the base identity changes,
  // not on every render's fresh object. The latest `base` is read via a ref
  // inside the closures (the useRawSql pattern), so the dep list stays on
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
        .then((next) => {
          if (!cancelled) setState(next);
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
      // reconciles against the registry (e.g. a pinned unit lingering). The
      // optimistic update MUST NOT claim completeness: a unit stays (or
      // becomes) pending unless the previous snapshot already had it
      // complete — entering units are mid-bootstrap until the re-read
      // confirms otherwise (§4.8: registration ≠ completeness).
      setState((prev) => ({
        units: next,
        pending: next.filter((unit) => !windowComplete(prev, unit)),
      }));
      return result;
    },
    [client],
  );

  const isComplete = useCallback(
    (unit: string) => windowComplete(state, unit),
    [state],
  );

  return { units: state.units, pending: state.pending, setWindow, isComplete };
}
