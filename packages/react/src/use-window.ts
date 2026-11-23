import {
  canonicalValue,
  type WindowBase,
  windowComplete,
} from '@syncular/client';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useReactiveStore } from './use-client';

export interface UseWindowResult {
  readonly units: readonly string[];
  readonly pending: readonly string[];
  /** The pending values whose unit the server revoked (`sync.scope_revoked`). */
  readonly revoked: readonly string[];
  /** False until the first read of the window state returns; `units` is
   * empty before it whatever the window holds. */
  readonly loaded: boolean;
  /** Update this component's claim; the store applies the union of all claims. */
  readonly setWindow: (units: readonly string[]) => Promise<void>;
  readonly isComplete: (unit: string) => boolean;
}

export interface UseRetainedWindowResult {
  /** True until the retained working set has reached the core window. */
  readonly isPending: boolean;
  /** Registration failure, if the host rejects the window change. */
  readonly error: Error | undefined;
}

/**
 * Retain a known working set for the lifetime of this component. Retention
 * composes with generated query coverage and other owners; cleanup releases
 * only this hook's claim. Ordinary selected queries still claim themselves.
 */
/** One object per outcome, so a claim replacement that ends where it started
 * (pending, then an immediate ready) keeps the state identity React compares. */
const RETAINED_PENDING: UseRetainedWindowResult = Object.freeze({
  isPending: true,
  error: undefined,
});
const RETAINED_READY: UseRetainedWindowResult = Object.freeze({
  isPending: false,
  error: undefined,
});

export function useRetainedWindow(
  base: WindowBase,
  units: readonly string[],
): UseRetainedWindowResult {
  const store = useReactiveStore();
  const baseIdentity = canonicalValue(base);
  const unitsIdentity = canonicalValue([...new Set(units)].sort());
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- canonical identities represent the complete values
  const stableBase = useMemo(() => base, [baseIdentity]);
  // oxlint-disable react-hooks/exhaustive-deps -- unitsIdentity represents the normalized unit set
  const stableUnits = useMemo(
    () => [...new Set(units)].sort(),
    [unitsIdentity],
  );
  // oxlint-enable react-hooks/exhaustive-deps
  const [state, setState] =
    useState<UseRetainedWindowResult>(RETAINED_PENDING);

  useEffect(() => {
    let active = true;
    setState(RETAINED_PENDING);
    const retention = store.retainWindow(stableBase, stableUnits);
    void retention.ready.then(
      () => {
        if (active) setState(RETAINED_READY);
      },
      (caught: unknown) => {
        if (!active) return;
        setState({
          isPending: false,
          error: caught instanceof Error ? caught : new Error(String(caught)),
        });
      },
    );
    return () => {
      active = false;
      // An unmounted component has nowhere to show a failed release; the next
      // claim on the base applies it again.
      retention.release().catch(() => {});
    };
  }, [stableBase, stableUnits, store]);

  return state;
}

export function useWindow(base: WindowBase): UseWindowResult {
  const store = useReactiveStore();
  const owner = useRef(Symbol('useWindow'));
  const baseIdentity = canonicalValue(base);
  // Window bases are value objects commonly recreated during render. Preserve
  // the prior object while its canonical value is unchanged.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- baseIdentity represents the complete value
  const stableBase = useMemo(() => base, [baseIdentity]);
  const entry = useMemo(() => store.window(stableBase), [store, stableBase]);
  const state = useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );

  useEffect(
    () => () => {
      store.releaseWindowClaims(owner.current).catch(() => {});
    },
    [stableBase, store],
  );

  const setWindow = useCallback(
    (units: readonly string[]) =>
      store.setWindowClaim(owner.current, stableBase, units),
    [stableBase, store],
  );
  const isComplete = useCallback(
    (unit: string) => windowComplete(state, unit),
    [state],
  );
  return {
    units: state.units,
    pending: state.pending,
    revoked: state.revoked,
    loaded: state.loaded,
    setWindow,
    isComplete,
  };
}
