/**
 * Browser storage durability for the origin that owns Syncular's OPFS
 * database. Persistence is requested by the page because `persist()` is a
 * Window-only API and browsers may evaluate the request against user
 * engagement.
 */
export type BrowserStoragePersistence =
  | { readonly state: 'persistent' }
  | {
      readonly state: 'best-effort';
      readonly reason:
        | 'not-granted'
        | 'unavailable'
        | 'check-failed'
        | 'request-failed';
    };

/** Check whether the current origin is protected from automatic eviction. */
export async function checkBrowserStoragePersistence(): Promise<BrowserStoragePersistence> {
  const storage =
    typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (storage === undefined || typeof storage.persisted !== 'function') {
    return { state: 'best-effort', reason: 'unavailable' };
  }
  try {
    return (await storage.persisted())
      ? { state: 'persistent' }
      : { state: 'best-effort', reason: 'not-granted' };
  } catch {
    return { state: 'best-effort', reason: 'check-failed' };
  }
}

/**
 * Request eviction-resistant storage for the current origin. Call this from a
 * user action near the first important offline write. A best-effort result is
 * an explicit durability state; the OPFS database remains usable.
 */
export async function requestBrowserStoragePersistence(): Promise<BrowserStoragePersistence> {
  const storage =
    typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (storage === undefined || typeof storage.persist !== 'function') {
    return { state: 'best-effort', reason: 'unavailable' };
  }
  try {
    return (await storage.persist())
      ? { state: 'persistent' }
      : { state: 'best-effort', reason: 'not-granted' };
  } catch {
    return { state: 'best-effort', reason: 'request-failed' };
  }
}
