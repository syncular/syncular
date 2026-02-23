/**
 * @syncular/dialect-sqlite3 - node-sqlite3 dialect for sync
 *
 * Provides a Kysely dialect for the callback-based `sqlite3` npm package
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 *
 * Implements a custom Kysely Driver that wraps sqlite3's callback API
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
import sqlite3 from 'sqlite3';

export interface Sqlite3PathOptions {
  /** Path to SQLite database file, or ':memory:' for in-memory */
  path: string;
}

export interface Sqlite3InstanceOptions {
  /** An existing sqlite3.Database instance */
  database: sqlite3.Database;
}

export type Sqlite3Options = Sqlite3PathOptions | Sqlite3InstanceOptions;

/**
 * Create a Kysely instance with node-sqlite3 dialect.
 *
 * @example
 * const db = createSqlite3Db<MyDb>({ path: './data.db' });
 * const db = createSqlite3Db<MyDb>({ path: ':memory:' });
 */
export function createSqlite3Db<T>(options: Sqlite3Options): Kysely<T> {
  return new Kysely<T>({
    dialect: createSqlite3Dialect(options),
  });
}

/**
 * Create the sqlite3 dialect directly.
 */
export function createSqlite3Dialect(options: Sqlite3Options): Sqlite3Dialect {
  return new Sqlite3Dialect(options);
}

// ---------------------------------------------------------------------------
// Kysely Dialect implementation for node-sqlite3
// ---------------------------------------------------------------------------

class Sqlite3Dialect implements Dialect {
  readonly #options: Sqlite3Options;

  constructor(options: Sqlite3Options) {
    this.#options = options;
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new Sqlite3Driver(this.#options);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class Sqlite3Driver implements Driver {
  readonly #options: Sqlite3Options;
  #db: sqlite3.Database | undefined;

  constructor(options: Sqlite3Options) {
    this.#options = options;
  }

  async init(): Promise<void> {
    this.#db = await this.#resolveDatabase();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new Sqlite3Connection(this.#db!);
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
      await new Promise<void>((resolve, reject) => {
        this.#db!.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  async #resolveDatabase(): Promise<sqlite3.Database> {
    if ('database' in this.#options) {
      return this.#options.database;
    }
    const path = this.#options.path;
    return new Promise<sqlite3.Database>((resolve, reject) => {
      const db = new sqlite3.Database(path, (err) => {
        if (err) reject(err);
        else resolve(db);
      });
    });
  }
}

class Sqlite3Connection implements DatabaseConnection {
  readonly #db: sqlite3.Database;

  constructor(db: sqlite3.Database) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const params = [...parameters];

    const hasReturning = /\breturning\b/i.test(sql);
    const isSelectLike = /^\s*(select|pragma|explain|with)\b/i.test(sql);
    const isInsert = /^\s*(insert|replace)\b/i.test(sql);

    if (isSelectLike || hasReturning) {
      return new Promise<QueryResult<R>>((resolve, reject) => {
        this.#db.all(sql, params, (err: Error | null, rows: R[]) => {
          if (err) return reject(err);
          const normalizedRows = rows ?? [];
          resolve({
            rows: normalizedRows,
            ...(hasReturning
              ? { numAffectedRows: BigInt(normalizedRows.length) }
              : {}),
          });
        });
      });
    }

    // For INSERT, UPDATE, DELETE — use run() to get lastID and changes
    return new Promise<QueryResult<R>>((resolve, reject) => {
      this.#db.run(sql, params, function (err: Error | null) {
        if (err) return reject(err);
        resolve({
          rows: [],
          numAffectedRows: BigInt(this.changes),
          ...(isInsert ? { insertId: BigInt(this.lastID) } : {}),
        });
      });
    });
  }

  streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('sqlite3 driver does not support streaming');
  }
}
