import type { SyncClientLike } from './client';

export type SyncClientResourceSnapshot =
  | { readonly phase: 'pending' }
  | { readonly phase: 'ready'; readonly client: SyncClientLike }
  | { readonly phase: 'error'; readonly error: Error };

export interface SyncClientResource {
  readonly kind: 'syncular-client-resource';
  subscribe(listener: () => void): () => void;
  getSnapshot(): SyncClientResourceSnapshot;
  dispose(): Promise<void>;
}

export function createSyncClientResource(
  factory: () => SyncClientLike | Promise<SyncClientLike>,
): SyncClientResource {
  const listeners = new Set<() => void>();
  let snapshot: SyncClientResourceSnapshot = { phase: 'pending' };
  let disposed = false;
  let closed = false;
  const initialized = Promise.resolve()
    .then(factory)
    .then(
      async (client) => {
        if (disposed) {
          const close = (client as { close?: () => void | Promise<void> })
            .close;
          if (close !== undefined && !closed) {
            closed = true;
            await close.call(client);
          }
          return;
        }
        snapshot = { phase: 'ready', client };
        for (const listener of listeners) listener();
      },
      (error: unknown) => {
        if (disposed) return;
        snapshot = {
          phase: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        };
        for (const listener of listeners) listener();
      },
    );

  return {
    kind: 'syncular-client-resource',
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await initialized;
      if (snapshot.phase === 'ready' && !closed) {
        const close = (
          snapshot.client as { close?: () => void | Promise<void> }
        ).close;
        if (close !== undefined) {
          closed = true;
          await close.call(snapshot.client);
        }
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
