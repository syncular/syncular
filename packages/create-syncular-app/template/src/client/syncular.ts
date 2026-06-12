import {
  getSyncularRuntimeArtifact,
  type MutationsApi,
  SyncularClientLifecycle,
  type SyncularClientLike,
  type SyncularClientStatus,
  type SyncularLiveQueries,
} from '@syncular/client';
import type { Selectable } from 'kysely';
import {
  createSyncularAppDatabase,
  type SyncularAppDatabase,
  type SyncularAppDb,
  taskSubscription,
} from '../generated/syncular.generated';

/**
 * Kysely-style database schema for the React hooks. Columns the database
 * defaults (like the server-assigned `server_version`) are emitted as
 * Kysely `Generated<>` columns, so `useMutations().tasks.insert(...)` does
 * not require them.
 */
export type AppDb = SyncularAppDb;

export type Task = Selectable<AppDb['tasks']>;

/** The managed client surface that `@syncular/react` consumes. */
export type AppSyncClient = SyncularClientLike<AppDb> & SyncularLiveQueries;

/**
 * Demo auth: the starter server accepts this static token and maps it to a
 * single user. Replace with your real auth (and pass the signed-in user's id
 * as `actorId`).
 */
export const appActorId = 'demo-user';
const appToken = 'demo-user';

const syncBaseUrl =
  import.meta.env.VITE_SYNCULAR_SYNC_URL ?? 'http://127.0.0.1:4100/sync';

/**
 * Opens the local database (SQLite persisted in IndexedDB), starts the sync
 * lifecycle (HTTP sync + WebSocket realtime) and adapts the generated
 * database to the `SyncularClientLike` surface the React hooks expect.
 */
export async function openAppClient(): Promise<AppSyncClient> {
  const database = await createSyncularAppDatabase({
    config: {
      baseUrl: syncBaseUrl,
      actorId: appActorId,
      clientId: 'web',
      fileName: 'syncular-app-v1.sqlite',
      storage: 'indexedDb',
    },
    requestTimeoutMs: 15_000,
    getHeaders: async () => ({
      authorization: `Bearer ${appToken}`,
    }),
    runtimeArtifacts: [getSyncularRuntimeArtifact('full')],
    subscriptions: [taskSubscription({ actorId: appActorId })],
  });

  const lifecycle = new SyncularClientLifecycle(database.client, {
    realtime: {
      params: { token: appToken },
      initialReconnectDelayMs: 500,
      maxReconnectDelayMs: 5_000,
    },
    pollIntervalMs: false,
  });

  try {
    await lifecycle.start();
  } catch (error) {
    await database.close();
    throw error;
  }

  return toManagedClient(database, lifecycle);
}

/**
 * Adapts the generated `SyncularAppDatabase` plus a `SyncularClientLifecycle`
 * to the `SyncularClientLike` surface that `@syncular/react`'s
 * `SyncProvider` expects.
 */
function toManagedClient(
  database: SyncularAppDatabase,
  lifecycle: SyncularClientLifecycle
): AppSyncClient {
  const runtime = database.client;
  let closed = false;

  return {
    db: database.db,
    dialect: database.dialect,
    mutations: database.mutations as unknown as MutationsApi<AppDb, undefined>,
    leasedMutations: database.leasedMutations as unknown as MutationsApi<
      AppDb,
      undefined
    >,
    blobs: database.blobs,
    live: database.live.bind(database),
    on: (event, listener) => runtime.addEventListener(event, listener),
    getStatus: () => {
      const lifecycleState = runtime.lifecycleState();
      const connection = runtime.connectionState();
      const outbox = lifecycleState.outbox ?? null;
      const conflicts = lifecycleState.conflicts ?? null;
      return {
        lifecycle: lifecycleState,
        connection,
        outbox,
        conflicts,
        isConnected: connection.realtime === 'connected' && !connection.closed,
        isSyncing:
          lifecycleState.phase === 'syncing' ||
          lifecycleState.phase === 'recovering',
        hasPendingMutations:
          (outbox?.pending ?? 0) + (outbox?.sending ?? 0) > 0,
        hasConflicts: (conflicts?.unresolved ?? 0) > 0,
        requiresAction: lifecycleState.requiresAction,
      } satisfies SyncularClientStatus;
    },
    setSubscriptions: (subscriptions) =>
      runtime.setSubscriptions(subscriptions),
    resumeFromBackground: (options) => runtime.resumeFromBackground(options),
    issueAuthLease: (request) => runtime.issueAuthLease(request),
    upsertAuthLease: (lease) => runtime.upsertAuthLease(lease),
    authLease: (leaseId) => runtime.authLease(leaseId),
    activeAuthLeases: (actorId, nowMs) =>
      runtime.activeAuthLeases(actorId, nowMs),
    diagnosticSnapshot: () => runtime.diagnosticSnapshot(),
    presence: {
      get: (scopeKey) => runtime.getPresence(scopeKey),
      join: (scopeKey, metadata) => runtime.joinPresence(scopeKey, metadata),
      leave: (scopeKey) => runtime.leavePresence(scopeKey),
      updateMetadata: (scopeKey, metadata) =>
        runtime.updatePresenceMetadata(scopeKey, metadata),
      onChange: (listener) => runtime.addPresenceListener(listener),
    },
    conflicts: {
      list: () => runtime.conflictSummaries(),
      retryKeepLocal: (id) => runtime.retryConflictKeepLocal(id),
      resolve: (id, resolution) => runtime.resolveConflict(id, resolution),
    },
    start: () => lifecycle.start(),
    stop: () => lifecycle.stop(),
    sync: () => lifecycle.sync(),
    destroy: async () => {
      if (closed) return;
      closed = true;
      try {
        await lifecycle.stop();
      } finally {
        await database.close();
      }
    },
  };
}
