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
  dispose(): Promise<void>;
}

export function createSyncClientResource(
  factory: () => SyncClientLike | Promise<SyncClientLike>,
): SyncClientResource {
  const listeners = new Set<() => void>();
  let snapshot: SyncClientResourceSnapshot = { phase: 'pending' };
  let disposed = false;
  let closed = false;
  let initialized: Promise<void>;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const closeClient = async (client: SyncClientLike): Promise<void> => {
    const close = (client as { close?: () => void | Promise<void> }).close;
    if (close !== undefined && !closed) {
      closed = true;
      await close.call(client);
    }
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
          if (disposed) {
            await closeClient(client);
            return;
          }
          snapshot = { phase: 'ready', client };
          notify();
        },
        (error: unknown) => {
          if (disposed) return;
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
      if (disposed || snapshot.phase !== 'error') return initialized;
      initialized = initialize(true);
      return initialized;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await initialized;
      if (snapshot.phase === 'ready' && !closed) {
        await closeClient(snapshot.client);
      }
      listeners.clear();
    },
  };
}

export function isSyncClientResource(
  value: SyncClientLike | SyncClientResource,
): value is SyncClientResource {
  return (value as { kind?: unknown }).kind === 'syncular-client-resource';
}
