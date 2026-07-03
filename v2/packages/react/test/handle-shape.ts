/**
 * A `SyncClientHandle`-SHAPED adapter over a real `SyncClient`: every
 * accessor is an async METHOD (not a getter), every mutation returns a
 * promise, and events are forwarded — exactly the divergent surface the
 * real worker handle presents. Wrapping the real client this way lets the
 * parity test run the SAME hooks against the handle's shape WITHOUT standing
 * up a worker + HTTP server, while still exercising the normalizer's
 * getter-vs-method / sync-vs-promise collapse (the real risk in "works
 * against BOTH cores"). The real end-to-end worker path is covered by
 * web-client's worker-rpc test, which proves the handle forwards these same
 * events.
 */
import type { SqlValue, SyncClient } from '@syncular-v2/web-client';
import type { SyncClientLike } from '../src/client';

export function handleShapeOf(client: SyncClient): SyncClientLike {
  return {
    onInvalidate: (listener) => client.onInvalidate(listener),
    onPresence: (listener) => client.onPresence(listener),
    // query is async on the handle (RPC round-trip).
    query: (sql: string, params?: readonly SqlValue[]) =>
      Promise.resolve(client.query(sql, params)),
    mutate: (mutations) => Promise.resolve(client.mutate(mutations)),
    // Getters on SyncClient become async methods on the handle.
    conflicts: () => Promise.resolve(client.conflicts),
    rejections: () => Promise.resolve(client.rejections),
    schemaFloor: () => Promise.resolve(client.schemaFloor),
    leaseState: () => Promise.resolve(client.leaseState),
    upgrading: () => Promise.resolve(client.upgrading),
    syncNeeded: () => Promise.resolve(client.syncNeeded),
    pendingCommits: () => Promise.resolve(client.pendingCommits()),
    presence: (scopeKey) => Promise.resolve(client.presence(scopeKey)),
    setPresence: (scopeKey, doc) =>
      Promise.resolve(client.setPresence(scopeKey, doc)),
  };
}
