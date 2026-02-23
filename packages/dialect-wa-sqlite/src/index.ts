/**
 * @syncular/dialect-wa-sqlite - wa-sqlite dialect for sync
 *
 * Provides a Kysely dialect for wa-sqlite (browser SQLite via WebAssembly).
 * Uses kysely-wasqlite-worker for running SQL in a web worker with OPFS or IndexedDB storage.
 */

import { Kysely } from 'kysely';
import { GenericSqliteDialect } from 'kysely-generic-sqlite';
import {
  createSqliteExecutor,
  defaultCreateDatabaseFn,
  type InitData,
  WaSqliteWorkerDialect,
  type WaSqliteWorkerDialectConfig,
} from 'kysely-wasqlite-worker';

export interface WaSqliteOptions
  extends Omit<WaSqliteWorkerDialectConfig, 'fileName'> {
  /** Database filename for persistence (defaults to 'diego.sqlite') */
  fileName?: string;
}

export interface WaSqliteMainThreadOptions {
  /** Database filename for persistence (defaults to 'diego.sqlite') */
  fileName?: string;
  /** Prefer OPFS storage when available (defaults to true) */
  useOPFS?: boolean;
  /** WASM URL override */
  url?: string;
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

function toMainThreadInitData(options?: WaSqliteMainThreadOptions): InitData {
  return {
    fileName: options?.fileName ?? 'diego.sqlite',
    useOPFS: options?.useOPFS ?? true,
    url: options?.url,
  };
}

/**
 * Create a Kysely instance with wa-sqlite running in the current thread.
 *
 * Useful when nested Worker support is unavailable (for example, in
 * ServiceWorker runtimes).
 */
export function createWaSqliteMainThreadDb<T>(
  options?: WaSqliteMainThreadOptions
): Kysely<T> {
  const initData = toMainThreadInitData(options);
  return new Kysely<T>({
    dialect: new GenericSqliteDialect(async () =>
      createSqliteExecutor(await defaultCreateDatabaseFn(initData))
    ),
  });
}

/**
 * Create the wa-sqlite main-thread dialect directly.
 */
export function createWaSqliteMainThreadDialect(
  options?: WaSqliteMainThreadOptions
): GenericSqliteDialect {
  const initData = toMainThreadInitData(options);
  return new GenericSqliteDialect(async () =>
    createSqliteExecutor(await defaultCreateDatabaseFn(initData))
  );
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
