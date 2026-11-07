import type { SyncClientLike } from './client';

export type SyncClientResourceSnapshot =
  | { readonly phase: 'pending' }
  | { readonly phase: 'ready'; readonly client: SyncClientLike }
  | { readonly phase: 'error'; readonly error: Error };

export interface SyncClientResource {
  readonly kind: 'syncular-client-resource';
  subscribe(listener: () => void): () => void;
  getSnapshot(): SyncClientResourceSnapshot;
  /** Re-run a failed initialization attempt. Pending/ready calls are no-ops. */
  retry(): Promise<void>;
  /**
   * Wait for initialization, then close the client. Every call returns the
   * same promise, so concurrent and repeated calls observe one outcome.
   */
  dispose(): Promise<void>;
}

export function createSyncClientResource(
  factory: () => SyncClientLike | Promise<SyncClientLike>,
): SyncClientResource {
  const listeners = new Set<() => void>();
  let snapshot: SyncClientResourceSnapshot = { phase: 'pending' };
  let disposing: Promise<void> | undefined;
  let initialized: Promise<void>;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const closeClient = async (client: SyncClientLike): Promise<void> => {
    const close = (client as { close?: () => void | Promise<void> }).close;
    if (close !== undefined) await close.call(client);
  };

  const initialize = (publishPending: boolean): Promise<void> => {
    if (publishPending) {
      snapshot = { phase: 'pending' };
      notify();
    }
    return Promise.resolve()
      .then(factory)
      .then(
        async (client) => {
          if (disposing !== undefined) {
            await closeClient(client);
            return;
          }
          snapshot = { phase: 'ready', client };
          notify();
        },
        (error: unknown) => {
          if (disposing !== undefined) return;
          snapshot = {
            phase: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          };
          notify();
        },
      );
  };

  initialized = initialize(false);

  return {
    kind: 'syncular-client-resource',
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    retry() {
      if (disposing !== undefined || snapshot.phase !== 'error') {
        return initialized;
      }
      initialized = initialize(true);
      return initialized;
    },
    dispose() {
      disposing ??= (async () => {
        await initialized;
        if (snapshot.phase === 'ready') await closeClient(snapshot.client);
        listeners.clear();
      })();
      return disposing;
    },
  };
}

export function isSyncClientResource(
  value: SyncClientLike | SyncClientResource,
): value is SyncClientResource {
  return (value as { kind?: unknown }).kind === 'syncular-client-resource';
}
