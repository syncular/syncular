/**
 * @syncular/dialect-better-sqlite3 - better-sqlite3 dialect for sync
 *
 * Provides a Kysely dialect for better-sqlite3 (Node.js).
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

export interface BetterSqlite3PathOptions {
  /** Path to SQLite database file, or ':memory:' for in-memory */
  path: string;
}

export interface BetterSqlite3InstanceOptions {
  /** An existing better-sqlite3 Database instance */
  database: BetterSqlite3Database;
}

export type BetterSqlite3Options =
  | BetterSqlite3PathOptions
  | BetterSqlite3InstanceOptions;

/**
 * Create a Kysely instance with better-sqlite3 dialect.
 *
 * @example
 * const db = createBetterSqlite3Db<MyDb>({ path: './data.db' });
 * const db = createBetterSqlite3Db<MyDb>({ path: ':memory:' });
 *
 * // Existing instance
 * import Database from 'better-sqlite3';
 * const db = createBetterSqlite3Db<MyDb>({ database: new Database(':memory:') });
 */
export function createBetterSqlite3Db<T>(
  options: BetterSqlite3Options
): Kysely<T> {
  return new Kysely<T>({
    dialect: createBetterSqlite3Dialect(options),
  });
}

/**
 * Create the better-sqlite3 dialect directly.
 */
export function createBetterSqlite3Dialect(
  options: BetterSqlite3Options
): SqliteDialect {
  const database =
    'database' in options ? options.database : new Database(options.path);
  return new SqliteDialect({ database });
}
