import { createPgliteClient } from './db-pglite';
import { createSqliteClient } from './db-sqlite';
import { migrateClientDbWithTimeout, resetClientData } from './migrate';

type DemoClientStoreDriver = 'sqlite' | 'pglite';

interface DemoClientStoreConfig {
  key: string;
  driver: DemoClientStoreDriver;
  location: string;
}

export const DEMO_CLIENT_STORES = {
  splitSqlite: {
    key: 'split-sqlite',
    driver: 'sqlite',
    location: 'demo-tasks-v5.sqlite',
  },
  splitPglite: {
    key: 'split-pglite',
    driver: 'pglite',
    location: 'idb://sync-demo-pglite-v5',
  },
  crdtYjsSqlite: {
    key: 'crdt-yjs-sqlite',
    driver: 'sqlite',
    location: 'demo-crdt-yjs-v1.sqlite',
  },
  crdtYjsPglite: {
    key: 'crdt-yjs-pglite',
    driver: 'pglite',
    location: 'idb://sync-demo-crdt-yjs-pglite-v1',
  },
  mediaUploaderSqlite: {
    key: 'media-uploader-sqlite',
    driver: 'sqlite',
    location: 'demo-media-v1.sqlite',
  },
  mediaReceiverPglite: {
    key: 'media-receiver-pglite',
    driver: 'pglite',
    location: 'idb://sync-demo-media-pglite-v1',
  },
  keyshareAliceSqlite: {
    key: 'keyshare-alice-sqlite',
    driver: 'sqlite',
    location: 'demo-keyshare-v3.sqlite',
  },
  keyshareBobPglite: {
    key: 'keyshare-bob-pglite',
    driver: 'pglite',
    location: 'idb://sync-demo-keyshare-pglite-v3',
  },
  symmetricDesignerSqlite: {
    key: 'symmetric-designer-sqlite',
    driver: 'sqlite',
    location: 'demo-symmetric-designer.sqlite',
  },
  symmetricDeveloperPglite: {
    key: 'symmetric-developer-pglite',
    driver: 'pglite',
    location: 'idb://sync-demo-symmetric-developer',
  },
  symmetricViewerSqlite: {
    key: 'symmetric-viewer-sqlite',
    driver: 'sqlite',
    location: 'demo-symmetric-viewer.sqlite',
  },
  catalogSqlite: {
    key: 'catalog-sqlite',
    driver: 'sqlite',
    location: 'demo-catalog-v2.sqlite',
  },
} as const satisfies Record<string, DemoClientStoreConfig>;

type DemoClientStore =
  (typeof DEMO_CLIENT_STORES)[keyof typeof DEMO_CLIENT_STORES];

const ALL_DEMO_CLIENT_STORES: readonly DemoClientStore[] =
  Object.values(DEMO_CLIENT_STORES);

const DEMO_LOCAL_STORAGE_KEYS = [
  'sync-demo:split-screen:client-seed-v1',
  'sync-demo:crdt-yjs:client-seed-v1',
  'sync-demo:keyshare:owner-key-v3',
] as const;

export interface ActiveClientResetOptions {
  reconnect: boolean;
}

type ActiveClientResetter = (
  options: ActiveClientResetOptions
) => Promise<void>;

const activeClientResetters = new Map<string, ActiveClientResetter>();

export function registerActiveDemoClientResetter(
  clientKey: string,
  resetter: ActiveClientResetter
): () => void {
  activeClientResetters.set(clientKey, resetter);
  return () => {
    const registered = activeClientResetters.get(clientKey);
    if (registered === resetter) {
      activeClientResetters.delete(clientKey);
    }
  };
}

function formatResetErrors(errors: readonly string[]): string {
  return errors.join('; ');
}

async function resetStoreData(store: DemoClientStore): Promise<void> {
  if (store.driver === 'sqlite') {
    const db = createSqliteClient(store.location);
    await migrateClientDbWithTimeout(db, { clientStoreKey: store.key });
    await resetClientData(db);
    await db.destroy();
    return;
  }

  const db = await createPgliteClient(store.location);
  await migrateClientDbWithTimeout(db, { clientStoreKey: store.key });
  await resetClientData(db);
  await db.destroy();
}

async function resetAllDemoLocalData(): Promise<void> {
  const errors: string[] = [];
  const activeEntries = Array.from(activeClientResetters.entries());
  const activeKeys = new Set(activeEntries.map(([clientKey]) => clientKey));

  for (const [clientKey, resetter] of activeEntries) {
    try {
      await resetter({ reconnect: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${clientKey}: ${message}`);
    }
  }

  for (const store of ALL_DEMO_CLIENT_STORES) {
    if (activeKeys.has(store.key)) continue;
    try {
      await resetStoreData(store);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${store.key}: ${message}`);
    }
  }

  try {
    for (const key of DEMO_LOCAL_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore localStorage unavailability/failures.
  }

  if (errors.length > 0) {
    throw new Error(formatResetErrors(errors));
  }
}

async function resetDemoBackendData(): Promise<void> {
  const response = await fetch('/api/demo/reset-all', {
    method: 'POST',
  });
  if (response.ok) return;

  let bodyText: string | null = null;
  try {
    bodyText = await response.text();
  } catch {
    bodyText = null;
  }

  throw new Error(
    bodyText && bodyText.trim().length > 0
      ? bodyText
      : `Backend reset failed (${response.status})`
  );
}

export async function resetAllDemoData(): Promise<void> {
  await resetDemoBackendData();
  await resetAllDemoLocalData();
}
