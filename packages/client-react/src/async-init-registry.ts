/**
 * Shared async initialization registry.
 *
 * Deduplicates concurrent (and subsequent) initialization calls by key.
 * Failed initializations are evicted automatically so retries can run.
 */

export interface AsyncInitRegistry<TKey, TValue> {
  /**
   * Run (or join) the initializer associated with a key.
   * - First caller executes `init`.
   * - Concurrent/future callers receive the same promise.
   * - If `init` rejects, the key is evicted.
   */
  run(key: TKey, init: () => Promise<TValue> | TValue): Promise<TValue>;

  /**
   * Forget a single key so a subsequent `run` executes again.
   */
  invalidate(key: TKey): void;

  /**
   * Forget all cached entries.
   */
  clear(): void;
}

export function createAsyncInitRegistry<TKey, TValue>(): AsyncInitRegistry<
  TKey,
  TValue
> {
  const cache = new Map<TKey, Promise<TValue>>();

  function run(
    key: TKey,
    init: () => Promise<TValue> | TValue
  ): Promise<TValue> {
    const cached = cache.get(key);
    if (cached) return cached;

    const next = Promise.resolve().then(init);
    cache.set(key, next);
    void next.catch(() => {
      if (cache.get(key) === next) {
        cache.delete(key);
      }
    });
    return next;
  }

  return {
    run,
    invalidate(key: TKey) {
      cache.delete(key);
    },
    clear() {
      cache.clear();
    },
  };
}
