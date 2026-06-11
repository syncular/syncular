import {
  getSyncularRuntimeArtifact,
  type MutationsApi,
  SyncularClientError,
  SyncularClientLifecycle,
  type SyncularClientLike,
  type SyncularClientStatus,
  type SyncularCommandHistory,
  type SyncularLiveQueries,
  type SyncularNetworkStatusSource,
} from '@syncular/client';
import type { Generated, Kysely, Selectable } from 'kysely';
import {
  createSyncularAppDatabase,
  type SyncularAppDatabase,
  type TaskRow,
  taskSubscription,
} from '../generated/syncular.generated';

export type DemoPaneName = 'left' | 'right';

/**
 * Kysely-style database schema for the React hooks.
 *
 * NOTE(DX): the generated `SyncularAppDb` types `server_version` as a plain
 * `number`, so Kysely's `Insertable` would force callers to provide it even
 * though the server assigns it. Wrapping it in `Generated<>` here keeps
 * `useMutations().tasks.insert(...)` honest. Ideally codegen would emit
 * Insertable-aware row types directly.
 */
export interface DemoDb {
  tasks: Omit<TaskRow, 'server_version'> & {
    server_version: Generated<number>;
  };
}

export type DemoTask = Selectable<DemoDb['tasks']>;

/**
 * The managed client surface that `@syncular/react` consumes, plus live
 * queries so `useSyncQuery` can subscribe instead of polling.
 */
export type DemoSyncClient = SyncularClientLike<DemoDb> & SyncularLiveQueries;

export interface DemoClientHandle {
  name: DemoPaneName;
  client: DemoSyncClient;
  /** Generated undo/redo history for this pane's local database. */
  history: SyncularCommandHistory;
}

export const demoActorId = 'demo-user';
const demoToken = 'demo-user';
const syncBaseUrl =
  import.meta.env.VITE_SYNCULAR_SYNC_URL ?? 'http://127.0.0.1:4101/sync';
const consoleBaseUrl =
  import.meta.env.VITE_SYNCULAR_CONSOLE_URL ?? 'http://127.0.0.1:4101/console';
const consoleToken =
  import.meta.env.VITE_SYNCULAR_CONSOLE_TOKEN ?? 'demo-console';
const consoleDiagnosticsEnabled =
  import.meta.env.VITE_SYNCULAR_CONSOLE_DIAGNOSTICS !== 'false';
const demoDatabaseFilePrefix = 'syncular-demo-v1';

/**
 * A controllable network status source. The engine consults it before
 * auto-syncing after mutations and when resuming the lifecycle, which is what
 * makes the per-pane "go offline" toggle behave like a real dropped
 * connection instead of just a closed websocket.
 */
interface DemoNetworkSource {
  source: SyncularNetworkStatusSource;
  isOnline(): boolean;
  setOnline(online: boolean): void;
}

function createDemoNetworkSource(): DemoNetworkSource {
  let online = true;
  const listeners = {
    online: new Set<() => void>(),
    offline: new Set<() => void>(),
  };
  return {
    source: {
      isOnline: () => online,
      addEventListener: (type, listener) => {
        listeners[type].add(listener);
      },
      removeEventListener: (type, listener) => {
        listeners[type].delete(listener);
      },
    },
    isOnline: () => online,
    setOnline(next) {
      if (online === next) return;
      online = next;
      for (const listener of listeners[next ? 'online' : 'offline']) {
        listener();
      }
    },
  };
}

function demoOfflineError(): SyncularClientError {
  return new SyncularClientError({
    code: 'sync.offline',
    message: 'The client is offline.',
    category: 'offline',
    retryable: true,
    recommendedAction: 'retryLater',
  });
}

/**
 * Opens one of the two demo clients. Each pane gets its own local SQLite
 * database (persisted in IndexedDB) plus its own sync lifecycle, so the two
 * panes behave like two independent browsers of the same user.
 */
export async function openDemoClient(
  name: DemoPaneName
): Promise<DemoClientHandle> {
  const network = createDemoNetworkSource();
  const database = await createSyncularAppDatabase({
    config: {
      baseUrl: syncBaseUrl,
      actorId: demoActorId,
      clientId: `demo-${name}`,
      fileName: `${demoDatabaseFilePrefix}-${name}.sqlite`,
      storage: 'indexedDb',
    },
    requestTimeoutMs: 15_000,
    getHeaders: async () => ({
      authorization: `Bearer ${demoToken}`,
    }),
    runtimeArtifacts: [getSyncularRuntimeArtifact('full')],
    subscriptions: [taskSubscription({ actorId: demoActorId })],
    sync: {
      rowsChangedDebounceMs: 25,
      mutationSyncDebounceMs: 25,
      network: network.source,
    },
    consoleDiagnostics: consoleDiagnosticsEnabled
      ? {
          baseUrl: consoleBaseUrl,
          token: consoleToken,
          partitionId: 'default',
          debounceMs: 100,
        }
      : false,
  });

  const lifecycle = new SyncularClientLifecycle(database.client, {
    realtime: {
      params: { token: demoToken },
      initialReconnectDelayMs: 500,
      maxReconnectDelayMs: 5_000,
    },
    pollIntervalMs: false,
    network: network.source,
  });

  try {
    await lifecycle.start();
  } catch (error) {
    await database.close();
    throw error;
  }

  return {
    name,
    client: toManagedClient(database, lifecycle, network),
    history: database.commandHistory,
  };
}

/**
 * Adapts the generated `SyncularAppDatabase` to the `SyncularClientLike`
 * surface that `@syncular/react`'s `SyncProvider` expects.
 *
 * NOTE(DX): this should not be necessary. `createSyncularClient` builds this
 * exact wrapper, but only around its own untyped database, and the generated
 * `createSyncularAppDatabase` (which adds schema install, runtime asserts and
 * command history) has no managed-client counterpart. Ideally codegen would
 * emit a `createSyncularAppClient` so apps never write this glue.
 */
function toManagedClient(
  database: SyncularAppDatabase,
  lifecycle: SyncularClientLifecycle,
  network: DemoNetworkSource
): DemoSyncClient {
  const runtime = database.client;
  let closed = false;
  const destroy = async () => {
    if (closed) return;
    closed = true;
    try {
      await lifecycle.stop();
    } finally {
      await database.close();
    }
  };

  return {
    db: database.db as unknown as Kysely<DemoDb>,
    dialect: database.dialect,
    // The generated mutations are command-history aware; the cast widens them
    // back to the structural MutationsApi shape the hooks operate on.
    mutations: database.mutations as unknown as MutationsApi<DemoDb, undefined>,
    leasedMutations: database.leasedMutations as unknown as MutationsApi<
      DemoDb,
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
    // `useSyncConnection().reconnect/disconnect` map to start/stop. Flipping
    // the network source as well keeps mutation-triggered auto-sync from
    // leaking through while a pane is "offline".
    start: async () => {
      network.setOnline(true);
      await lifecycle.start();
    },
    stop: async () => {
      network.setOnline(false);
      await lifecycle.stop();
    },
    sync: () =>
      network.isOnline()
        ? lifecycle.sync()
        : Promise.reject(demoOfflineError()),
    destroy,
  };
}
