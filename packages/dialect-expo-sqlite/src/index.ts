/**
 * @syncular/dialect-expo-sqlite - Expo SQLite dialect for sync
 *
 * Provides a Kysely dialect for Expo's SQLite module (expo-sqlite)
 * with SerializePlugin for automatic JSON serialization/deserialization.
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 *
 * Implements a custom Kysely Driver that wraps expo-sqlite's sync API
 * into the promise-based interface Kysely expects.
 */

import { SerializePlugin } from '@syncular/core';
import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from 'kysely';
import {
  CompiledQuery,
  Kysely,
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
 * Create a Kysely instance with Expo SQLite dialect and SerializePlugin.
 *
 * @example
 * import { openDatabaseSync } from 'expo-sqlite';
 *
 * const db = createExpoSqliteDb<MyDb>({
 *   name: 'myapp.db',
 *   openDatabaseSync,
 * });
 *
 * // Or with an existing database instance:
 * const database = openDatabaseSync('myapp.db');
 * const db = createExpoSqliteDb<MyDb>({ database });
 */
export function createExpoSqliteDb<T>(options: ExpoSqliteOptions): Kysely<T> {
  return new Kysely<T>({
    dialect: createExpoSqliteDialect(options),
    plugins: [new SerializePlugin()],
  });
}

/**
 * Create the Expo SQLite dialect directly (without SerializePlugin).
 */
export function createExpoSqliteDialect(
  options: ExpoSqliteOptions
): ExpoSqliteDialect {
  return new ExpoSqliteDialect(options);
}

/**
 * Create a SerializePlugin instance.
 */
export function createSerializePlugin(): SerializePlugin {
  return new SerializePlugin();
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

  constructor(options: ExpoSqliteOptions) {
    this.#options = options;
  }

  async init(): Promise<void> {
    this.#db = this.#resolveDatabase();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new ExpoSqliteConnection(this.#db!);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    _settings: TransactionSettings
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {
    // Single-connection model — nothing to release.
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

    // Determine if this is a SELECT / RETURNING query
    const isSelect = /^\s*(select|pragma|explain|with)\b/i.test(sql);

    if (isSelect) {
      const rows = this.#db.getAllSync<R>(sql, params);
      return { rows: rows ?? [] };
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
