/**
 * @syncular/dialect-bun-sqlite - Bun SQLite dialect for sync
 *
 * Provides a Kysely dialect for bun:sqlite.
 */

import { Database } from 'bun:sqlite';
import { Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';

export interface BunSqliteOptions {
  /** Path to SQLite database file, or ':memory:' for in-memory */
  path: string;
}

/**
 * Create a Kysely instance with Bun SQLite dialect.
 *
 * @example
 * const db = createBunSqliteDb<MyDb>({ path: ':memory:' });
 * // or
 * const db = createBunSqliteDb<MyDb>({ path: './data.db' });
 */
export function createBunSqliteDb<T>(options: BunSqliteOptions): Kysely<T> {
  const database = new Database(options.path);

  return new Kysely<T>({
    dialect: new BunSqliteDialect({ database }),
  });
}

/**
 * Create the Bun SQLite dialect directly.
 *
 * @example
 * const dialect = createBunSqliteDialect({ path: ':memory:' });
 * const db = new Kysely<MyDb>({ dialect });
 */
export function createBunSqliteDialect(
  options: BunSqliteOptions
): BunSqliteDialect {
  const database = new Database(options.path);
  return new BunSqliteDialect({ database });
}
