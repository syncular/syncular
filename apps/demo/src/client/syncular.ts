import {
  SyncularClientError,
  type SyncularClientLike,
  type SyncularCommandHistory,
  type SyncularLiveQueries,
  type SyncularNetworkStatusSource,
} from '@syncular/client';
import type { Selectable } from 'kysely';
import {
  createSyncularAppDatabase,
  type SyncularAppDatabase,
  type SyncularAppDb,
} from '../generated/syncular.generated';

export type DemoPaneName = 'left' | 'right';

/**
 * Kysely-style database schema for the React hooks. Columns the database
 * defaults (like the server-assigned `server_version`) are emitted as
 * Kysely `Generated<>` columns, so `useMutations().tasks.insert(...)` does
 * not require them.
 */
export type DemoDb = SyncularAppDb;

export type DemoTask = Selectable<DemoDb['tasks']>;

/**
 * The managed client surface that `@syncular/client/react` consumes, plus live
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
 * database (persisted in IndexedDB); `createSyncularAppDatabase` installs the
 * generated schema, registers the default subscriptions, and starts the sync
 * lifecycle (HTTP sync + WebSocket realtime) before resolving.
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
    realtime: {
      params: { token: demoToken },
      initialReconnectDelayMs: 500,
      maxReconnectDelayMs: 5_000,
    },
    pollIntervalMs: false,
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

  return {
    name,
    client: withDemoNetworkToggle(database, network),
    history: database.commandHistory,
  };
}

/**
 * The generated database already satisfies the `SyncularClientLike` surface
 * that `@syncular/client/react`'s `SyncProvider` expects. The demo only layers its
 * controllable network source on top: `useSyncConnection().reconnect/
 * disconnect` map to `start`/`stop`, and flipping the network source as well
 * keeps mutation-triggered auto-sync from leaking through while a pane is
 * "offline".
 */
function withDemoNetworkToggle(
  database: SyncularAppDatabase,
  network: DemoNetworkSource
): DemoSyncClient {
  // The cast bridges the generated mutations interface, which does not
  // declare the structural `$table` helper the hooks type against.
  const client = database as unknown as DemoSyncClient;
  return {
    ...client,
    start: async () => {
      network.setOnline(true);
      await database.start();
    },
    stop: async () => {
      network.setOnline(false);
      await database.stop();
    },
    sync: () =>
      network.isOnline() ? database.sync() : Promise.reject(demoOfflineError()),
  };
}
