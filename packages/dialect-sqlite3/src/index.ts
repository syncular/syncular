/**
 * @syncular/dialect-sqlite3 - node-sqlite3 dialect for sync
 *
 * Provides a Kysely dialect for the callback-based `sqlite3` npm package.
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 */

import type {
  CompiledQuery,
  DatabaseConnection,
  Dialect,
  QueryResult,
} from 'kysely';
import { BaseSqliteDialect, BaseSqliteDriver } from 'kysely-generic-sqlite';
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
 * Create the sqlite3 dialect directly.
 */
export function createSqlite3Dialect(options: Sqlite3Options): Dialect {
  return new BaseSqliteDialect(() => new Sqlite3Driver(options));
}

class Sqlite3Driver extends BaseSqliteDriver {
  #db: sqlite3.Database | undefined;

  constructor(options: Sqlite3Options) {
    super(async () => {
      this.#db = await resolveSqlite3Database(options);
      this.conn = new Sqlite3Connection(this.#db);
    });
  }

  async destroy(): Promise<void> {
    const db = this.#db;
    this.#db = undefined;
    if (!db) return;

    await new Promise<void>((resolve, reject) => {
      db.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

async function resolveSqlite3Database(
  options: Sqlite3Options
): Promise<sqlite3.Database> {
  if ('database' in options) {
    return options.database;
  }

  return new Promise<sqlite3.Database>((resolve, reject) => {
    const db = new sqlite3.Database(options.path, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(db);
    });
  });
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
          if (err) {
            reject(err);
            return;
          }

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

    return new Promise<QueryResult<R>>((resolve, reject) => {
      this.#db.run(sql, params, function onRun(err: Error | null) {
        if (err) {
          reject(err);
          return;
        }

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
