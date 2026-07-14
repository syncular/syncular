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
export function useRetainedWindow(
  base: WindowBase,
  units: readonly string[],
): UseRetainedWindowResult {
  const store = useReactiveStore();
  const baseIdentity = canonicalValue(base);
  const unitsIdentity = canonicalValue([...new Set(units)].sort());
  // biome-ignore lint/correctness/useExhaustiveDependencies: canonical identities represent the complete values
  const stableBase = useMemo(() => base, [baseIdentity]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: unitsIdentity represents the normalized unit set
  const stableUnits = useMemo(
    () => [...new Set(units)].sort(),
    [unitsIdentity],
  );
  const [state, setState] = useState<UseRetainedWindowResult>({
    isPending: true,
    error: undefined,
  });

  useEffect(() => {
    let active = true;
    setState((current) =>
      current.isPending && current.error === undefined
        ? current
        : { isPending: true, error: undefined },
    );
    const retention = store.retainWindow(stableBase, stableUnits);
    void retention.ready.then(
      () => {
        if (active) setState({ isPending: false, error: undefined });
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
      retention.release();
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: baseIdentity represents the complete value
  const stableBase = useMemo(() => base, [baseIdentity]);
  const entry = useMemo(() => store.window(stableBase), [store, stableBase]);
  const state = useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );

  useEffect(() => () => store.releaseWindowClaims(owner.current), [store]);

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
    setWindow,
    isComplete,
  };
}
