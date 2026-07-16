/**
 * `ClientDatabase` on @sqlite.org/sqlite-wasm (Direction decision 2,
 * 2026-07-03). Two modes, no ladder between them:
 *
 * - `openPersistentWasmDatabase(name)` — THE persistent browser mode:
 *   OPFS via the `opfs-sahpool` VFS, restricted to Web Worker contexts
 *   because the whole client core runs in a worker by design. SAHPool
 *   needs **no COOP/COEP headers and no SharedArrayBuffer** (it is built
 *   on `FileSystemSyncAccessHandle`, not the Atomics-based `opfs` VFS
 *   proxy — the COOP/COEP requirement documented by sqlite-wasm applies
 *   only to `oo1.OpfsDb`, which this binding no longer uses). Browsers
 *   without OPFS are unsupported (support floor ~2023+): the factory
 *   fails loud. Never IndexedDB, never a silent in-memory fallback.
 * - `openWasmDatabase()` — EXPLICIT ephemeral: an in-memory database for
 *   tests, demos and SSR. Nothing survives a reload, on purpose.
 *
 * A thin binding over the sqlite3 `oo1` API: opening is async (wasm
 * init), everything after is synchronous like every other
 * `ClientDatabase`. Browser-only — exercised by the demo, never imported
 * by bun tests (subpath export `@syncular/client/wasm`).
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  assertImageAlias,
  type ClientDatabase,
  runTransaction,
  type SqlRow,
  type SqlValue,
} from './database';
import {
  ClientSyncError,
  STORAGE_BUSY_CODE,
  STORAGE_UNAVAILABLE_CODE,
} from './errors';

/** Structural view of the sqlite3 oo1 surface this binding uses. */
interface Oo1Database {
  /** Native db handle, used by `sqlite3_deserialize` (§5.3 image import). */
  readonly pointer?: number;
  exec(options: {
    sql: string;
    bind?: readonly unknown[];
    rowMode: 'object';
    resultRows: unknown[];
  }): unknown;
  close(): void;
}

interface SahPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => Oo1Database;
}

interface Sqlite3Static {
  oo1: {
    DB: new (filename: string, flags?: string) => Oo1Database;
  };
  capi: {
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_READONLY: number;
    sqlite3_deserialize(
      db: number,
      schema: string,
      data: number,
      dataLength: number,
      bufferLength: number,
      flags: number,
    ): number;
  };
  wasm: {
    allocFromTypedArray(bytes: Uint8Array): number;
  };
  installOpfsSAHPoolVfs(options: {
    name?: string;
    directory?: string;
    initialCapacity?: number;
    forceReinitIfPreviouslyFailed?: boolean;
  }): Promise<SahPoolUtil>;
}

function coerceParams(params: readonly SqlValue[]): unknown[] {
  return params.map((value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

class WasmClientDatabase implements ClientDatabase {
  readonly #db: Oo1Database;
  readonly #sqlite3: Sqlite3Static;
  #tx = { depth: 0 };

  constructor(db: Oo1Database, sqlite3: Sqlite3Static) {
    this.#db = db;
    this.#sqlite3 = sqlite3;
  }

  exec(sql: string, params: readonly SqlValue[] = []): void {
    this.#db.exec({
      sql,
      ...(params.length > 0 ? { bind: coerceParams(params) } : {}),
      rowMode: 'object',
      resultRows: [],
    });
  }

  query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    const resultRows: unknown[] = [];
    this.#db.exec({
      sql,
      ...(params.length > 0 ? { bind: coerceParams(params) } : {}),
      rowMode: 'object',
      resultRows,
    });
    return resultRows as SqlRow[];
  }

  transaction<T>(fn: () => T): T {
    return runTransaction(this.#tx, (sql) => this.exec(sql), fn);
  }

  /**
   * §5.3 image import at near-file-copy speed: attach an empty in-memory
   * schema, then `sqlite3_deserialize` the image bytes into it (the
   * documented sqlite-wasm import path — no OPFS round-trip, no SQL-level
   * row shuttling before the single INSERT…SELECT the caller runs).
   */
  withSqliteImage<T>(bytes: Uint8Array, alias: string, fn: () => T): T {
    assertImageAlias(alias);
    const pointer = this.#db.pointer;
    if (pointer === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'sqlite-wasm database exposes no native handle for image import',
      );
    }
    const { capi, wasm } = this.#sqlite3;
    this.exec(`ATTACH ':memory:' AS ${alias}`);
    try {
      const data = wasm.allocFromTypedArray(bytes);
      const rc = capi.sqlite3_deserialize(
        pointer,
        alias,
        data,
        bytes.length,
        bytes.length,
        // FREEONCLOSE: sqlite owns the allocation; READONLY: images are
        // immutable inputs (§5.1).
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_READONLY,
      );
      if (rc !== 0) {
        throw new ClientSyncError(
          'sync.invalid_request',
          `sqlite3_deserialize failed with code ${rc} (§5.3)`,
        );
      }
      return fn();
    } finally {
      this.exec(`DETACH ${alias}`);
    }
  }

  close(): void {
    this.#db.close();
  }
}

let sqlite3Init: Promise<Sqlite3Static> | undefined;

function initSqlite3(): Promise<Sqlite3Static> {
  if (sqlite3Init === undefined) {
    const init = sqlite3InitModule as unknown as (config?: {
      print?: (...args: unknown[]) => void;
      printErr?: (...args: unknown[]) => void;
    }) => Promise<unknown>;
    sqlite3Init = init({
      print: () => {},
      printErr: () => {},
    }) as Promise<Sqlite3Static>;
  }
  return sqlite3Init;
}

/**
 * EXPLICIT ephemeral mode: an in-memory sqlite-wasm database. For tests,
 * demos and SSR only — nothing persists. The persistent mode is
 * `openPersistentWasmDatabase` inside a worker; there is no fallback from
 * one to the other (Direction decision 2).
 */
export async function openWasmDatabase(): Promise<ClientDatabase> {
  const sqlite3 = await initSqlite3();
  return new WasmClientDatabase(new sqlite3.oo1.DB(':memory:', 'c'), sqlite3);
}

export interface PersistentWasmDatabaseOptions {
  /**
   * OPFS directory holding this database's SAH pool (default
   * `.syncular/<name>`). One pool per concurrent user: the sahpool VFS
   * forbids two live instances on the same directory, so two cores on one
   * origin (e.g. the demo's two panes) need distinct names/directories.
   */
  readonly directory?: string;
  /** Initial SAH pool capacity (sqlite-wasm default: 6). */
  readonly initialCapacity?: number;
}

function inWorkerContext(): boolean {
  const scope = globalThis as { WorkerGlobalScope?: unknown };
  return (
    typeof scope.WorkerGlobalScope === 'function' &&
    globalThis instanceof (scope.WorkerGlobalScope as new () => object)
  );
}

/** One registered VFS per pool directory, reused across opens. */
const sahPools = new Map<string, Promise<SahPoolUtil>>();

function opfsSahPoolError(error: unknown, directory: string): ClientSyncError {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  if (
    normalized.includes('missing required opfs apis') ||
    normalized.includes('opfs api is too old')
  ) {
    return new ClientSyncError(
      STORAGE_UNAVAILABLE_CODE,
      `Persistent OPFS storage is unavailable: ${detail}`,
    );
  }
  return new ClientSyncError(
    STORAGE_BUSY_CODE,
    'Could not acquire the persistent OPFS storage directory ' +
      `${JSON.stringify(directory)}. Another live engine may still own its ` +
      'SAH pool, or the browser may still be releasing it after a reload. ' +
      'Close the other instance or retry after a short delay; do not delete ' +
      `or rename the directory. Underlying error: ${detail}`,
    true,
  );
}

/**
 * THE persistent browser mode: a named database on OPFS via the
 * `opfs-sahpool` VFS. Worker-context only — not because SAHPool requires
 * it (it uses `FileSystemSyncAccessHandle`, no `Atomics.wait`, and could
 * technically run on the main thread), but because the persistent mode IS
 * whole-core-in-a-worker (REVISE Direction decision 2, 2026-07-03) and
 * this factory enforces that decision. No COOP/COEP headers required.
 *
 * Support floor: no OPFS → a loud `ClientSyncError`, never a fallback.
 */
export async function openPersistentWasmDatabase(
  name: string,
  options?: PersistentWasmDatabaseOptions,
): Promise<ClientDatabase> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new ClientSyncError(
      'sync.invalid_request',
      `invalid persistent database name ${JSON.stringify(name)}`,
    );
  }
  if (!inWorkerContext()) {
    throw new ClientSyncError(
      'sync.invalid_request',
      'openPersistentWasmDatabase() must run inside a Web Worker: the ' +
        'persistent mode is whole-core-in-a-worker by design (Direction ' +
        'decision 2, 2026-07-03). Use the worker handle from the main ' +
        'thread, or openWasmDatabase() for explicitly ephemeral state.',
    );
  }
  const storage = (
    globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }
  ).navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') {
    throw new ClientSyncError(
      STORAGE_UNAVAILABLE_CODE,
      'OPFS is unavailable in this browser — the syncular support floor ' +
        'requires OPFS (~2023+ browsers). There is no IndexedDB or ' +
        'in-memory fallback for persistent mode.',
    );
  }
  const sqlite3 = await initSqlite3();
  const directory = options?.directory ?? `.syncular/${name}`;
  let pool = sahPools.get(directory);
  if (pool === undefined) {
    pool = sqlite3
      .installOpfsSAHPoolVfs({
        // VFS registration names must be unique per directory.
        name: `syncular-sahpool-${directory.replace(/[^A-Za-z0-9]+/g, '-')}`,
        directory,
        // sqlite-wasm caches a rejected initialization promise by VFS name.
        // Syncular removes its own rejected entry below, so allow a later
        // open in the same worker to make a real attempt as well.
        forceReinitIfPreviouslyFailed: true,
        ...(options?.initialCapacity !== undefined
          ? { initialCapacity: options.initialCapacity }
          : {}),
      })
      .catch((error: unknown) => {
        sahPools.delete(directory);
        throw opfsSahPoolError(error, directory);
      });
    sahPools.set(directory, pool);
  }
  const util = await pool;
  return new WasmClientDatabase(new util.OpfsSAHPoolDb(`/${name}.db`), sqlite3);
}
