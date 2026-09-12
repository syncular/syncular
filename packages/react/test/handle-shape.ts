/**
 * Promise-based snapshot and mutation projection over the real direct client.
 * Hook parity tests exercise the same behavior through both return types;
 * worker-rpc tests cover transport and event forwarding.
 */
import type { SqlValue, SyncClient } from '@syncular/client';
import type { SyncClientLike } from '../src/client';

export function handleShapeOf(client: SyncClient): SyncClientLike {
  return {
    securityLifecycle: () => Promise.resolve(client.securityLifecycle()),
    beginSecurityPreflight: () => client.beginSecurityPreflight(),
    activateSecurity: () => client.activateSecurity(),
    onProgress: (listener) => client.onProgress(listener),
    progressSnapshot: () => client.progressSnapshot(),
    onChange: (listener) => client.onChange(listener),
    onDiagnostics: (listener) => client.onDiagnostics(listener),
    onInvalidate: (listener) => client.onInvalidate(listener),
    onPresence: (listener) => client.onPresence(listener),
    // query is async on the handle (RPC round-trip).
    query: (sql: string, params?: readonly SqlValue[]) =>
      Promise.resolve(client.query(sql, params)),
    mutate: (mutations) => Promise.resolve(client.mutate(mutations)),
    patch: (table, rowId, partial, options) =>
      Promise.resolve(client.patch(table, rowId, partial, options)),
    purgeLocalData: (input) => Promise.resolve(client.purgeLocalData(input)),
    rebootstrapLocalData: (input) =>
      Promise.resolve(client.rebootstrapLocalData(input)),
    querySnapshot: (spec) => Promise.resolve(client.querySnapshot(spec)),
    statusSnapshot: () => Promise.resolve(client.statusSnapshot()),
    diagnosticsSnapshot: (request) =>
      Promise.resolve(client.diagnosticsSnapshot(request)),
    conflicts: () => Promise.resolve(client.conflicts()),
    rejections: () => Promise.resolve(client.rejections()),
    commitOutcome: (clientCommitId) =>
      Promise.resolve(client.commitOutcome(clientCommitId)),
    commitOutcomes: (query) => Promise.resolve(client.commitOutcomes(query)),
    resolveCommitOutcome: (input) =>
      Promise.resolve(client.resolveCommitOutcome(input)),
    pendingCommits: () => Promise.resolve(client.pendingCommits()),
    presence: (scopeKey) => Promise.resolve(client.presence(scopeKey)),
    setPresence: (scopeKey, doc) =>
      Promise.resolve(client.setPresence(scopeKey, doc)),
    // §4.8: setWindow is async on the handle; windowState round-trips.
    setWindow: (base, units) => Promise.resolve(client.setWindow(base, units)),
    windowState: (base) => Promise.resolve(client.windowState(base)),
  };
}
