/**
 * @syncular/dialect-react-native-nitro-sqlite - React Native Nitro SQLite dialect for sync
 *
 * Provides a Kysely dialect for React Native Nitro SQLite (react-native-nitro-sqlite)
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 *
 * Implements a custom Kysely Driver that wraps react-native-nitro-sqlite's API
 * into the promise-based interface Kysely expects.
 */

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
import type {
  NitroSQLiteConnection,
  NitroSQLiteConnectionOptions,
  SQLiteValue,
} from 'react-native-nitro-sqlite';

/** Function type for open from react-native-nitro-sqlite */
type OpenNitroSqlite = (
  options: NitroSQLiteConnectionOptions
) => NitroSQLiteConnection;

interface NitroSqliteNameOptions {
  /** Database name (will be stored in app's document directory) */
  name: string;
  /** The open function from react-native-nitro-sqlite */
  open: OpenNitroSqlite;
  /** Optional database location */
  location?: string;
}

interface NitroSqliteInstanceOptions {
  /** An existing nitro-sqlite database instance */
  database: NitroSQLiteConnection;
}

export type NitroSqliteOptions =
  | NitroSqliteNameOptions
  | NitroSqliteInstanceOptions;

/**
 * Create a Kysely instance with React Native Nitro SQLite dialect.
 *
 * @example
 * import { open } from 'react-native-nitro-sqlite';
 *
 * const db = createNitroSqliteDb<MyDb>({
 *   name: 'myapp.db',
 *   open,
 * });
 *
 * // Or with an existing database instance:
 * const database = open({ name: 'myapp.db' });
 * const db = createNitroSqliteDb<MyDb>({ database });
 */
export function createNitroSqliteDb<T>(options: NitroSqliteOptions): Kysely<T> {
  return new Kysely<T>({
    dialect: createNitroSqliteDialect(options),
  });
}

/**
 * Create the Nitro SQLite dialect directly.
 */
export function createNitroSqliteDialect(
  options: NitroSqliteOptions
): NitroSqliteDialect {
  return new NitroSqliteDialect(options);
}

// ---------------------------------------------------------------------------
// Kysely Dialect implementation for react-native-nitro-sqlite
// ---------------------------------------------------------------------------

class NitroSqliteDialect implements Dialect {
  readonly #options: NitroSqliteOptions;

  constructor(options: NitroSqliteOptions) {
    this.#options = options;
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new NitroSqliteDriver(this.#options);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class NitroSqliteDriver implements Driver {
  readonly #options: NitroSqliteOptions;
  #db: NitroSQLiteConnection | undefined;

  constructor(options: NitroSqliteOptions) {
    this.#options = options;
  }

  async init(): Promise<void> {
    this.#db = this.#resolveDatabase();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new NitroSqliteConnection(this.#db!);
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
      this.#db.close();
    }
  }

  #resolveDatabase(): NitroSQLiteConnection {
    if ('database' in this.#options) {
      return this.#options.database;
    }
    return this.#options.open({
      name: this.#options.name,
      location: this.#options.location,
    });
  }
}

class NitroSqliteConnection implements DatabaseConnection {
  readonly #db: NitroSQLiteConnection;

  constructor(db: NitroSQLiteConnection) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const params = parameters as SQLiteValue[];

    const hasReturning = /\breturning\b/i.test(sql);
    const isSelectLike = /^\s*(select|pragma|explain|with)\b/i.test(sql);

    // Execute the query
    const result = this.#db.execute(sql, params);

    if (isSelectLike || hasReturning) {
      const rows = (result.results ?? []) as R[];
      return {
        rows,
        ...(hasReturning ? { numAffectedRows: BigInt(rows.length) } : {}),
      };
    }

    // For INSERT, UPDATE, DELETE — return affected rows info
    return {
      rows: [],
      numAffectedRows: BigInt(result.rowsAffected ?? 0),
      insertId: BigInt(result.insertId ?? 0),
    };
  }

  streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(
      'react-native-nitro-sqlite driver does not support streaming'
    );
  }
}
