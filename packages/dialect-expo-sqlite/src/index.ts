/**
 * @syncular/dialect-expo-sqlite - Expo SQLite dialect for sync
 *
 * Provides a Kysely dialect for Expo's SQLite module (expo-sqlite)
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 *
 * Implements a custom Kysely Driver that wraps expo-sqlite's sync API
 * into the promise-based interface Kysely expects. All operations are
 * serialized through a single connection to prevent "database is locked"
 * errors from concurrent access on the native handle.
 */

import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from 'kysely';
import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';

export type ExpoSqliteBindValue = null | string | number | Uint8Array;

export type ExpoSqliteBindParams = ExpoSqliteBindValue[];

export interface ExpoSqliteRunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface ExpoSqliteDatabaseLike {
  getAllSync<R>(sql: string, params: ExpoSqliteBindParams): R[];
  getAllSync<R>(sql: string, ...params: readonly ExpoSqliteBindValue[]): R[];
  runSync(sql: string, params: ExpoSqliteBindParams): ExpoSqliteRunResult;
  runSync(
    sql: string,
    ...params: readonly ExpoSqliteBindValue[]
  ): ExpoSqliteRunResult;
  closeSync(): void;
}

/** Function type for openDatabaseSync from expo-sqlite */
type OpenDatabaseSync = (name: string) => ExpoSqliteDatabaseLike;

interface ExpoSqliteNameOptions {
  /** Database name (will be stored in app's document directory) */
  name: string;
  /** The openDatabaseSync function from expo-sqlite */
  openDatabaseSync: OpenDatabaseSync;
}

interface ExpoSqliteInstanceOptions {
  /** An existing expo-sqlite database instance */
  database: ExpoSqliteDatabaseLike;
}

export type ExpoSqliteOptions =
  | ExpoSqliteNameOptions
  | ExpoSqliteInstanceOptions;

/**
 * Create the Expo SQLite dialect directly.
 */
export function createExpoSqliteDialect(
  options: ExpoSqliteOptions
): ExpoSqliteDialect {
  return new ExpoSqliteDialect(options);
}

// ---------------------------------------------------------------------------
// Simple async mutex — serializes all DB access on a single native handle.
// ---------------------------------------------------------------------------

class Mutex {
  #queue: Array<() => void> = [];
  #locked = false;

  async acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.#queue.push(resolve);
    });
  }

  release(): void {
    const next = this.#queue.shift();
    if (next) {
      next();
    } else {
      this.#locked = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Kysely Dialect implementation for expo-sqlite
// ---------------------------------------------------------------------------

class ExpoSqliteDialect implements Dialect {
  readonly #options: ExpoSqliteOptions;

  constructor(options: ExpoSqliteOptions) {
    this.#options = options;
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new ExpoSqliteDriver(this.#options);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class ExpoSqliteDriver implements Driver {
  readonly #options: ExpoSqliteOptions;
  #db: ExpoSqliteDatabaseLike | undefined;
  #connection: ExpoSqliteConnection | undefined;
  readonly #mutex = new Mutex();

  constructor(options: ExpoSqliteOptions) {
    this.#options = options;
  }

  async init(): Promise<void> {
    this.#db = this.#resolveDatabase();
    // Enable WAL mode for better concurrency (allows concurrent reads
    // while writing, prevents "database is locked" errors during sync).
    this.#db.runSync('PRAGMA journal_mode = WAL', []);
    // Wait up to 5s for locks to clear instead of failing immediately.
    this.#db.runSync('PRAGMA busy_timeout = 5000', []);
    this.#connection = new ExpoSqliteConnection(this.#db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#mutex.acquire();
    return this.#connection!;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    _settings: TransactionSettings
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin immediate'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {
    this.#mutex.release();
  }

  async destroy(): Promise<void> {
    if (this.#db) {
      this.#db.closeSync();
    }
  }

  #resolveDatabase(): ExpoSqliteDatabaseLike {
    if ('database' in this.#options) {
      return this.#options.database;
    }
    return this.#options.openDatabaseSync(this.#options.name);
  }
}

class ExpoSqliteConnection implements DatabaseConnection {
  readonly #db: ExpoSqliteDatabaseLike;

  constructor(db: ExpoSqliteDatabaseLike) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const params = [...parameters] as ExpoSqliteBindParams;

    const hasReturning = /\breturning\b/i.test(sql);
    const isSelectLike = /^\s*(select|pragma|explain|with)\b/i.test(sql);

    if (isSelectLike || hasReturning) {
      const rows = this.#db.getAllSync<R>(sql, params);
      const normalizedRows = rows ?? [];
      return {
        rows: normalizedRows,
        ...(hasReturning
          ? { numAffectedRows: BigInt(normalizedRows.length) }
          : {}),
      };
    }

    // For INSERT, UPDATE, DELETE — use runSync to get lastInsertRowId and changes
    const result: ExpoSqliteRunResult = this.#db.runSync(sql, params);
    return {
      rows: [],
      numAffectedRows: BigInt(result.changes),
      insertId: BigInt(result.lastInsertRowId),
    };
  }

  streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('expo-sqlite driver does not support streaming');
  }
}
