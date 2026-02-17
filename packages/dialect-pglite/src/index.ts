/**
 * @syncular/dialect-pglite - PGlite dialect for sync
 *
 * Provides a Kysely dialect for PGlite (in-memory/browser Postgres).
 * Uses kysely-pglite-dialect under the hood.
 */

import { PGlite } from '@electric-sql/pglite';
import { live, type PGliteWithLive } from '@electric-sql/pglite/live';
import { Kysely } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';

export interface PgliteOptions {
  /** Optional data directory for persistence */
  dataDir?: string;

  /** Preloaded PGlite fs bundle (avoids runtime network fetches in the browser). */
  fsBundle?: Blob | File;

  /** Precompiled wasm module (avoids runtime network fetches in the browser). */
  wasmModule?: WebAssembly.Module;

  /** Optional data dir archive to initialize from (tar). */
  loadDataDir?: Blob | File;

  /** Optional initial memory (bytes). */
  initialMemory?: number;
}

/**
 * Extended Kysely instance that exposes the raw PGlite instance.
 * Use this type when you need access to PGlite's native features like live queries.
 */
export interface PgliteDb<T> extends Kysely<T> {
  /** Access raw PGlite instance for live queries */
  readonly pglite: PGliteWithLive;
}

/**
 * Create a Kysely instance with PGlite dialect.
 * Synchronous version - database may not be fully ready immediately.
 *
 * Note: This version does NOT include the live extension or expose the raw PGlite instance.
 * For live query support, use createPgliteDbAsync() instead.
 *
 * @example
 * const db = createPgliteDb<MyDb>(); // In-memory
 * const db = createPgliteDb<MyDb>({ dataDir: './pgdata' }); // Persistent
 */
export function createPgliteDb<T>(options?: PgliteOptions): Kysely<T> {
  const database = options ? new PGlite(options) : new PGlite();
  return new Kysely<T>({
    dialect: new PGliteDialect(database),
  });
}

/**
 * Create a Kysely instance with PGlite dialect, waiting for database to be ready.
 * Async version - ensures database is fully initialized before returning.
 * Includes the live extension for reactive queries.
 *
 * @example
 * const db = await createPgliteDbAsync<MyDb>(); // In-memory
 * const db = await createPgliteDbAsync<MyDb>({ dataDir: 'idb://mydb' }); // Persistent
 * // Access raw PGlite for live queries:
 * db.pglite.live.incrementalQuery(...)
 */
export async function createPgliteDbAsync<T>(
  options?: PgliteOptions
): Promise<PgliteDb<T>> {
  const database = await PGlite.create({
    ...options,
    extensions: { live },
  });

  const db = new Kysely<T>({
    dialect: new PGliteDialect(database),
  });

  // Attach raw instance for live query access using Object.defineProperty
  // to properly define the readonly property
  Object.defineProperty(db, 'pglite', {
    value: database,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  return db as PgliteDb<T>;
}

/**
 * Create the PGlite dialect directly.
 */
export function createPgliteDialect(options?: PgliteOptions): PGliteDialect {
  const database = options ? new PGlite(options) : new PGlite();
  return new PGliteDialect(database);
}
// Re-export types for convenience

export function getPgliteAssetPaths(): {
  fsBundlePath: string;
  wasmPath: string;
} {
  const entry = import.meta.resolve('@electric-sql/pglite');

  return {
    fsBundlePath: new URL('./pglite.data', entry).pathname,
    wasmPath: new URL('./pglite.wasm', entry).pathname,
  };
}
