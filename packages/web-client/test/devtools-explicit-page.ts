import { SyncClient } from '../src/client';
import { registerDevtools } from '../src/devtools';
import { openWasmDatabase } from '../src/wasm-database';
import { OPFS_SCHEMA } from './opfs-bootstrap-fixture';

declare global {
  interface Window {
    directRegistryProbe(): Promise<{
      readonly registryPresent: boolean;
      readonly rows: readonly unknown[];
      readonly scopes: readonly unknown[];
      readonly entriesAfterClose: number | null;
    }>;
  }
}

window.directRegistryProbe = async () => {
  const database = await openWasmDatabase();
  const client = new SyncClient({
    database,
    schema: OPFS_SCHEMA,
    clientId: 'production-direct',
    transport: async () => {
      throw new Error('fixture transport is not used');
    },
    devtools: registerDevtools,
  });
  let observed: {
    readonly registryPresent: boolean;
    readonly rows: readonly unknown[];
    readonly scopes: readonly unknown[];
  };
  try {
    await client.start();
    client.subscribe({
      id: 'direct-scope',
      table: 'catalogue',
      scopes: { project_id: ['p1'] },
    });
    client.mutate([
      {
        table: 'catalogue',
        op: 'upsert',
        values: { id: 'local-direct', project_id: 'p1', title: 'private' },
      },
    ]);
    observed = {
      registryPresent: '__SYNCULAR__' in globalThis,
      rows: client.query('SELECT id, title FROM catalogue'),
      scopes: client.subscriptions(),
    };
  } finally {
    await client.close();
    database.close();
  }
  const registry = (globalThis as { __SYNCULAR__?: { clients: unknown[] } })
    .__SYNCULAR__;
  return { ...observed, entriesAfterClose: registry?.clients.length ?? null };
};
