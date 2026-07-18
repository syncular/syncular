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
import type { SqlValue, SyncClient } from '@syncular/client';
import type { SyncClientLike } from '../src/client';

export function handleShapeOf(client: SyncClient): SyncClientLike {
  return {
    securityLifecycle: () => Promise.resolve(client.securityLifecycle),
    beginSecurityPreflight: () => client.beginSecurityPreflight(),
    activateSecurity: () => client.activateSecurity(),
    onChange: (listener) => client.onChange(listener),
    onInvalidate: (listener) => client.onInvalidate(listener),
    onPresence: (listener) => client.onPresence(listener),
    // query is async on the handle (RPC round-trip).
    query: (sql: string, params?: readonly SqlValue[]) =>
      Promise.resolve(client.query(sql, params)),
    mutate: (mutations) => Promise.resolve(client.mutate(mutations)),
    patch: (table, rowId, partial, options) =>
      Promise.resolve(client.patch(table, rowId, partial, options)),
    purgeLocalData: (input) => Promise.resolve(client.purgeLocalData(input)),
    querySnapshot: (spec) => Promise.resolve(client.querySnapshot(spec)),
    statusSnapshot: () => Promise.resolve(client.statusSnapshot()),
    // Getters on SyncClient become async methods on the handle.
    conflicts: () => Promise.resolve(client.conflicts),
    rejections: () => Promise.resolve(client.rejections),
    commitOutcome: (clientCommitId) =>
      Promise.resolve(client.commitOutcome(clientCommitId)),
    commitOutcomes: (query) => Promise.resolve(client.commitOutcomes(query)),
    resolveCommitOutcome: (input) =>
      Promise.resolve(client.resolveCommitOutcome(input)),
    schemaFloor: () => Promise.resolve(client.schemaFloor),
    leaseState: () => Promise.resolve(client.leaseState),
    upgrading: () => Promise.resolve(client.upgrading),
    syncNeeded: () => Promise.resolve(client.syncNeeded),
    pendingCommits: () => Promise.resolve(client.pendingCommits()),
    presence: (scopeKey) => Promise.resolve(client.presence(scopeKey)),
    setPresence: (scopeKey, doc) =>
      Promise.resolve(client.setPresence(scopeKey, doc)),
    // §4.8: setWindow is async on the handle; windowState round-trips.
    setWindow: (base, units) => Promise.resolve(client.setWindow(base, units)),
    windowState: (base) => Promise.resolve(client.windowState(base)),
  };
}
