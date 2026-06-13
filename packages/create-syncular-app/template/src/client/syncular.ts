import type { SyncularClientLike, SyncularLiveQueries } from '@syncular/client';
import type { Selectable } from 'kysely';
import {
  createSyncularAppDatabase,
  type SyncularAppDb,
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
 * Opens the local database (SQLite persisted in IndexedDB). The generated
 * factory installs the app schema, registers the default subscriptions, and
 * starts the sync lifecycle (HTTP sync + WebSocket realtime) before
 * resolving, so the returned client is ready for the React hooks.
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
    realtime: {
      params: { token: appToken },
      initialReconnectDelayMs: 500,
      maxReconnectDelayMs: 5_000,
    },
  });

  // The cast bridges the generated mutations interface, which does not
  // declare the structural `$table` helper the hooks type against.
  return database as unknown as AppSyncClient;
}
