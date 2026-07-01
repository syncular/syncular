import {
  getSyncularBrowserDeploymentPreflight,
  type SyncularRuntimeArtifactCandidate,
} from '@syncular/client';
import SyncularWorker from '@syncular/client/worker?worker';
import type { Selectable } from 'kysely';
import {
  createSyncularAppDatabase,
  type SyncularAppDatabase,
  type SyncularAppDb,
  syncularGeneratedRequiredRuntimeFeatures,
  syncularGeneratedSchemaVersion,
} from '../generated/syncular.generated';

/**
 * Kysely-style database schema for the React hooks. Columns the database
 * defaults (like the server-assigned `server_version`) are emitted as
 * Kysely `Generated<>` columns, so `useMutations().tasks.insert(...)` does
 * not require them.
 */
export type AppDb = SyncularAppDb;

export type Task = Selectable<AppDb['tasks']>;

export {
  syncularGeneratedRequiredRuntimeFeatures,
  syncularGeneratedSchemaVersion,
};

/** The managed client surface that `@syncular/client/react` consumes. */
export type AppSyncClient = SyncularAppDatabase;

/**
 * Demo auth: the starter server accepts this static token and maps it to a
 * single user. Replace with your real auth (and pass the signed-in user's id
 * as `actorId`).
 */
export const appActorId = 'demo-user';
const appToken = 'demo-user';
const defaultClientId = 'web';
export const syncularStarterRuntimeArtifacts = [
  {
    name: 'core',
    features: syncularGeneratedRequiredRuntimeFeatures,
    wasmGlueUrl: '/syncular/wasm-core/syncular.js',
    wasmUrl: '/syncular/wasm-core/syncular_bg.wasm',
  },
] as const satisfies readonly SyncularRuntimeArtifactCandidate[];

function createSyncularStarterWorker() {
  return new SyncularWorker();
}

const syncBaseUrl =
  import.meta.env.VITE_SYNCULAR_SYNC_URL ?? 'http://127.0.0.1:4100/sync';

function currentClientId(): string {
  if (typeof window === 'undefined') return defaultClientId;
  const requested = new URLSearchParams(window.location.search).get(
    'syncularClientId'
  );
  if (!requested) return defaultClientId;
  const normalized = requested.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return normalized || defaultClientId;
}

/**
 * Opens the local database (SQLite persisted in IndexedDB). The generated
 * factory installs the app schema, registers the default subscriptions, and
 * starts the sync lifecycle (HTTP sync + WebSocket realtime) before
 * resolving, so the returned client is ready for the React hooks.
 */
export async function openAppClient(): Promise<AppSyncClient> {
  const clientId = currentClientId();
  const fileName =
    clientId === defaultClientId
      ? 'syncular-app-v1.sqlite'
      : `syncular-app-v1-${clientId}.sqlite`;
  const preflight = await getSyncularBrowserDeploymentPreflight({
    requiredRuntimeFeatures: syncularGeneratedRequiredRuntimeFeatures,
    runtimeArtifacts: syncularStarterRuntimeArtifacts,
    storage: 'indexedDb',
    minimumQuotaBytes: 50 * 1024 * 1024,
  });
  if (preflight.status === 'not-ready') {
    throw new Error(
      `Syncular browser preflight failed (${preflight.support.tier}): ${preflight.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.code)
        .join(', ')}`
    );
  }

  const database = await createSyncularAppDatabase({
    config: {
      baseUrl: syncBaseUrl,
      actorId: appActorId,
      clientId,
      fileName,
      storage: 'indexedDb',
    },
    worker: createSyncularStarterWorker,
    runtimeArtifacts: syncularStarterRuntimeArtifacts,
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

  return database;
}
