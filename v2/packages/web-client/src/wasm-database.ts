/**
 * `ClientDatabase` on @sqlite.org/sqlite-wasm with OPFS (REVISE B3).
 *
 * A thin binding over the sqlite3 `oo1` API: opening is async (wasm init),
 * everything after is synchronous like every other `ClientDatabase`.
 * Browser-only — exercised in B6, never imported by bun tests (subpath
 * export `@syncular-v2/web-client/wasm`). When OPFS is unavailable (no
 * COOP/COEP, non-worker context without sahpool) the factory falls back to
 * a transient in-memory database unless `requirePersistence` is set.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  type ClientDatabase,
  runTransaction,
  type SqlRow,
  type SqlValue,
} from './database';
import { ClientSyncError } from './errors';

/** Structural view of the sqlite3 oo1 surface this binding uses. */
interface Oo1Database {
  exec(options: {
    sql: string;
    bind?: readonly unknown[];
    rowMode: 'object';
    resultRows: unknown[];
  }): unknown;
  close(): void;
}

interface Sqlite3Static {
  oo1: {
    DB: new (filename: string, flags?: string) => Oo1Database;
    OpfsDb?: new (filename: string, flags?: string) => Oo1Database;
  };
}

export interface WasmDatabaseOptions {
  /** OPFS filename (default `syncular.db`). */
  readonly filename?: string;
  /** Throw instead of silently falling back to in-memory storage. */
  readonly requirePersistence?: boolean;
}

function coerceParams(params: readonly SqlValue[]): unknown[] {
  return params.map((value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

class WasmClientDatabase implements ClientDatabase {
  readonly #db: Oo1Database;
  #tx = { depth: 0 };

  constructor(db: Oo1Database) {
    this.#db = db;
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

  close(): void {
    this.#db.close();
  }
}

/**
 * Initialize sqlite-wasm and open the database, preferring the OPFS VFS
 * when the environment provides it.
 */
export async function openWasmDatabase(
  options?: WasmDatabaseOptions,
): Promise<ClientDatabase> {
  const filename = options?.filename ?? 'syncular.db';
  const init = sqlite3InitModule as unknown as (config?: {
    print?: (...args: unknown[]) => void;
    printErr?: (...args: unknown[]) => void;
  }) => Promise<unknown>;
  const sqlite3 = (await init({
    print: () => {},
    printErr: () => {},
  })) as Sqlite3Static;
  if (sqlite3.oo1.OpfsDb !== undefined) {
    return new WasmClientDatabase(new sqlite3.oo1.OpfsDb(filename, 'c'));
  }
  if (options?.requirePersistence === true) {
    throw new ClientSyncError(
      'sync.invalid_request',
      'OPFS is unavailable in this context and requirePersistence is set',
    );
  }
  return new WasmClientDatabase(new sqlite3.oo1.DB(':memory:', 'c'));
}
