/**
 * @syncular/dialect-wa-sqlite - wa-sqlite dialect for sync
 *
 * Provides a Kysely dialect for wa-sqlite (browser SQLite via WebAssembly).
 * Uses kysely-wasqlite-worker for running SQL in a web worker with OPFS or IndexedDB storage.
 */

import { SerializePlugin } from '@syncular/core';
import { Kysely } from 'kysely';
import {
  WaSqliteWorkerDialect,
  type WaSqliteWorkerDialectConfig,
} from 'kysely-wasqlite-worker';

export interface WaSqliteOptions
  extends Omit<WaSqliteWorkerDialectConfig, 'fileName'> {
  /** Database filename for persistence (defaults to 'diego.sqlite') */
  fileName?: string;
}

function toDialectConfig(
  options?: WaSqliteOptions
): WaSqliteWorkerDialectConfig {
  return {
    fileName: options?.fileName ?? 'diego.sqlite',
    ...options,
  };
}

/**
 * Create a Kysely instance with wa-sqlite dialect.
 *
 * @example
 * // In-memory database
 * const db = createWaSqliteDb<MyDb>();
 *
 * // OPFS-persisted database
 * const db = createWaSqliteDb<MyDb>({
 *   fileName: 'mydb.sqlite',
 * });
 */
export function createWaSqliteDb<T>(options?: WaSqliteOptions): Kysely<T> {
  return new Kysely<T>({
    dialect: new WaSqliteWorkerDialect(toDialectConfig(options)),
    plugins: [new SerializePlugin()],
  });
}

/**
 * Create the wa-sqlite dialect directly.
 */
export function createWaSqliteDialect(
  options?: WaSqliteOptions
): WaSqliteWorkerDialect {
  return new WaSqliteWorkerDialect(toDialectConfig(options));
}

export function createSerializePlugin(): SerializePlugin {
  return new SerializePlugin();
}

export function getWaSqliteWorkerEntrypointPaths(): {
  moduleWorkerPath: string;
} {
  return {
    moduleWorkerPath: new URL('./worker-module.ts', import.meta.url).pathname,
  };
}

export function getWaSqliteWasmPaths(): {
  asyncWasmPath: string;
  syncWasmPath: string;
} {
  return {
    asyncWasmPath: new URL(
      import.meta.resolve('@subframe7536/sqlite-wasm/wasm-async')
    ).pathname,
    syncWasmPath: new URL(import.meta.resolve('@subframe7536/sqlite-wasm/wasm'))
      .pathname,
  };
}
