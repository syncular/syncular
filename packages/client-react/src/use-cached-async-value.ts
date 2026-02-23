import { useEffect, useRef, useState } from 'react';
import { createAsyncInitRegistry } from './async-init-registry';

const cachedAsyncValueRegistry = createAsyncInitRegistry<unknown, unknown>();

const EMPTY_DEPS: readonly unknown[] = Object.freeze([]);
const DEFAULT_KEY = 'default';

export interface UseCachedAsyncValueOptions<TKey = unknown> {
  /**
   * Stable cache key shared across component instances.
   * Defaults to the callback function identity.
   */
  key?: TKey;
  /**
   * Additional dependencies that should re-run the callback.
   */
  deps?: readonly unknown[];
}

/**
 * Resolve an async value with a process-wide cache outside component state.
 * Returns the resolved value and error tuple: [value, error].
 */
export function useCachedAsyncValue<TValue>(
  run: () => Promise<TValue> | TValue,
  options?: UseCachedAsyncValueOptions
): readonly [TValue | null, Error | null] {
  const [value, setValue] = useState<TValue | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const runRef = useRef(run);
  runRef.current = run;

  const key = options?.key ?? DEFAULT_KEY;
  const deps = options?.deps ?? EMPTY_DEPS;

  useEffect(() => {
    let cancelled = false;
    setValue(null);
    setError(null);

    void cachedAsyncValueRegistry
      .run(key, () => runRef.current())
      .then((resolved) => {
        if (cancelled) return;
        setValue(resolved as TValue);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      });

    return () => {
      cancelled = true;
    };
  }, [key, ...deps]);

  return [value, error] as const;
}

export function invalidateCachedAsyncValue(key: unknown): void {
  cachedAsyncValueRegistry.invalidate(key);
}

export function clearCachedAsyncValues(): void {
  cachedAsyncValueRegistry.clear();
}
