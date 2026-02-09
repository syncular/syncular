/**
 * @syncular/dialect-bun-sqlite - Bun SQLite dialect for sync
 *
 * Provides a Kysely dialect for bun:sqlite with SerializePlugin
 * for automatic JSON serialization/deserialization.
 */

import { Database } from 'bun:sqlite';
import { SerializePlugin } from '@syncular/core';
import { Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';

export interface BunSqliteOptions {
  /** Path to SQLite database file, or ':memory:' for in-memory */
  path: string;
}

/**
 * Create a Kysely instance with Bun SQLite dialect and SerializePlugin.
 *
 * The SerializePlugin automatically handles JSON serialization/deserialization
 * for object values, so you can work with JS objects directly.
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
    plugins: [new SerializePlugin()],
  });
}

/**
 * Create the Bun SQLite dialect directly (without SerializePlugin).
 *
 * @example
 * const dialect = createBunSqliteDialect({ path: ':memory:' });
 * const db = new Kysely<MyDb>({ dialect, plugins: [new SerializePlugin()] });
 */
export function createBunSqliteDialect(
  options: BunSqliteOptions
): BunSqliteDialect {
  const database = new Database(options.path);
  return new BunSqliteDialect({ database });
}

/**
 * Create a SerializePlugin instance.
 */
export function createSerializePlugin(): SerializePlugin {
  return new SerializePlugin();
}
