/**
 * @syncular/dialect-bun-sqlite - Bun SQLite dialect for sync
 *
 * Provides a Kysely dialect for bun:sqlite.
 */

import { Database } from 'bun:sqlite';
import { BunSqliteDialect } from 'kysely-bun-sqlite';

export interface BunSqliteOptions {
  /** Path to SQLite database file, or ':memory:' for in-memory */
  path: string;
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
