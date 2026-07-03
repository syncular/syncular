/**
 * Multi-tab ownership seam (REVISE B3): exactly one core instance owns the
 * local database. The interface is the whole B3 deliverable — cross-tab
 * follower fanout is post-gate. Browsers use Web Locks; tests use the
 * no-op single-owner lock.
 */
export interface LeaderLease {
  release(): void | Promise<void>;
}

export interface LeaderLock {
  /** Resolves when this instance holds leadership for `name`. */
  acquire(name: string): Promise<LeaderLease>;
  /**
   * Resolves immediately: the lease when leadership was free, `undefined`
   * when another owner holds it. The worker handle uses this so a second
   * tab gets a clear not-leader state instead of blocking forever
   * (followers are post-gate, TODO 3.2).
   */
  tryAcquire?(name: string): Promise<LeaderLease | undefined>;
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
 * implicitly, letting the next tab take over).
 */
export function webLocksLeaderLock(locks?: LockManager): LeaderLock {
  const manager = locks ?? navigator.locks;
  return {
    acquire: (name) =>
      new Promise<LeaderLease>((resolveAcquire, rejectAcquire) => {
        manager
          .request(
            name,
            { mode: 'exclusive' },
            () =>
              new Promise<void>((resolveHold) => {
                resolveAcquire({ release: () => resolveHold() });
              }),
          )
          .catch((error: unknown) => rejectAcquire(error));
      }),
    tryAcquire: (name) =>
      new Promise<LeaderLease | undefined>((resolveTry, rejectTry) => {
        manager
          .request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
            // `ifAvailable` grants `null` instead of waiting (Web Locks).
            if (lock === null) {
              resolveTry(undefined);
              return undefined;
            }
            return new Promise<void>((resolveHold) => {
              resolveTry({ release: () => resolveHold() });
            });
          })
          .catch((error: unknown) => rejectTry(error));
      }),
  };
}
