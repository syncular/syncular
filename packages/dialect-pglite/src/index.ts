/**
 * @syncular/dialect-pglite - PGlite dialect for sync
 *
 * Provides a Kysely dialect for PGlite (in-memory/browser Postgres).
 * Uses kysely-pglite-dialect under the hood.
 */

import { PGlite } from '@electric-sql/pglite';
import { live, type PGliteWithLive } from '@electric-sql/pglite/live';
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
 * Create the PGlite dialect directly.
 */
export function createPgliteDialect(options?: PgliteOptions): PGliteDialect {
  const database = options ? new PGlite(options) : new PGlite();
  return new PGliteDialect(database);
}

export interface PgliteDialectWithLive {
  dialect: PGliteDialect;
  pglite: PGliteWithLive;
}

/**
 * Create a PGlite dialect with fully initialized live-enabled instance.
 */
export async function createPgliteDialectWithLive(
  options?: PgliteOptions
): Promise<PgliteDialectWithLive> {
  const pglite = await PGlite.create({
    ...options,
    extensions: { live },
  });
  return {
    dialect: new PGliteDialect(pglite),
    pglite,
  };
}

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
