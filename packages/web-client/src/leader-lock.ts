/**
 * Multi-tab ownership seam: exactly one core instance owns the
 * local database. Browsers use Web Locks; tests use the no-op single-owner
 * lock or an injected exclusive lock.
 */
export interface LeaderLease {
  release(): void | Promise<void>;
  /**
   * Resolves when another context took this lease with
   * {@link LeaderLock.steal}. The holder no longer owns the lock and must stop
   * writing. Absent for locks that cannot be stolen.
   */
  readonly lost?: Promise<void>;
}

export interface LeaderLock {
  /** Resolves when this instance holds leadership for `name`. */
  acquire(name: string): Promise<LeaderLease>;
  /**
   * Resolves immediately: the lease when leadership was free, `undefined`
   * when another owner holds it. The worker handle uses this so a second
   * tab gets a clear not-leader state instead of blocking forever.
   */
  tryAcquire?(name: string): Promise<LeaderLease | undefined>;
  /**
   * Takes `name` from its current holder at once; the holder's lease reports
   * `lost`. Waiting requests stay queued behind the new holder.
   */
  steal?(name: string): Promise<LeaderLease>;
}

/** Single-owner environments (tests, dedicated workers): always leader. */
export function singleOwnerLock(): LeaderLock {
  return {
    acquire: () => Promise.resolve({ release: () => {} }),
    tryAcquire: () => Promise.resolve({ release: () => {} }),
  };
}

/**
 * Web Locks leader election: resolves once the exclusive lock is granted
 * and holds it until the lease is released (tab close releases it
 * implicitly, letting the next tab take over). A `steal` from another
 * context rejects the holder's request with `AbortError`, which resolves the
 * holder's `lost`.
 */
export function webLocksLeaderLock(locks?: LockManager): Required<LeaderLock> {
  const manager = locks ?? navigator.locks;
  const request = (
    name: string,
    options: LockOptions,
  ): Promise<LeaderLease | undefined> =>
    new Promise((resolveRequest, rejectRequest) => {
      let granted = false;
      let markLost = (): void => {};
      const lost = new Promise<void>((resolve) => {
        markLost = resolve;
      });
      manager
        .request(name, options, (lock) => {
          // `ifAvailable` grants `null` instead of waiting (Web Locks).
          if (lock === null) {
            resolveRequest(undefined);
            return undefined;
          }
          granted = true;
          return new Promise<void>((resolveHold) => {
            resolveRequest({ release: () => resolveHold(), lost });
          });
        })
        .catch((error: unknown) => {
          if (
            granted &&
            error instanceof DOMException &&
            error.name === 'AbortError'
          ) {
            markLost();
            return;
          }
          rejectRequest(error);
        });
    });
  const held = async (
    name: string,
    options: LockOptions,
  ): Promise<LeaderLease> => {
    const lease = await request(name, options);
    if (lease === undefined)
      throw new Error('a waiting lock request returned no lock');
    return lease;
  };
  return {
    acquire: (name) => held(name, { mode: 'exclusive' }),
    tryAcquire: (name) =>
      request(name, { mode: 'exclusive', ifAvailable: true }),
    steal: (name) => held(name, { mode: 'exclusive', steal: true }),
  };
}
