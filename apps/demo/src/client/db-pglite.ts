/**
 * @syncular/demo - PGlite client factory
 *
 * Uses PGlite with IndexedDB persistence for browser Postgres.
 */

import { createPgliteDbAsync } from '@syncular/dialect-pglite';
import type { Kysely } from 'kysely';
import type { ClientDb } from './types.generated';

let assetsPromise: Promise<{
  fsBundle: Blob;
  wasmModule: WebAssembly.Module;
}> | null = null;

async function loadPgliteAssets(): Promise<{
  fsBundle: Blob;
  wasmModule: WebAssembly.Module;
}> {
  if (assetsPromise) return assetsPromise;

  assetsPromise = (async () => {
    const dataUrl = `${window.location.origin}/__demo/pglite/pglite.data`;
    const wasmUrl = `${window.location.origin}/__demo/pglite/pglite.wasm`;

    const [fsBundleBuffer, wasmBuffer] = await Promise.all([
      fetch(dataUrl).then(async (r) => {
        if (!r.ok) {
          throw new Error(
            `Failed to fetch pglite.data: ${r.status} ${r.statusText}`
          );
        }
        return await r.arrayBuffer();
      }),
      fetch(wasmUrl).then(async (r) => {
        if (!r.ok) {
          throw new Error(
            `Failed to fetch pglite.wasm: ${r.status} ${r.statusText}`
          );
        }
        return await r.arrayBuffer();
      }),
    ]);

    const fsBundle = new Blob([fsBundleBuffer]);
    const wasmModule = await WebAssembly.compile(wasmBuffer);

    return { fsBundle, wasmModule };
  })();

  return assetsPromise;
}

/**
 * Create a PGlite client database (async to wait for database ready).
 */
export async function createPgliteClient(
  dataDir?: string
): Promise<Kysely<ClientDb>> {
  const { fsBundle, wasmModule } = await loadPgliteAssets();
  const db = await createPgliteDbAsync<ClientDb>({
    dataDir: dataDir ?? 'idb://sync-demo-pglite',
    fsBundle,
    wasmModule,
  });
  return db;
}
