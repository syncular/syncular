/**
 * @syncular/dialect-libsql - LibSQL/Turso dialect for sync
 *
 * Provides a Kysely dialect for LibSQL/Turso with SerializePlugin
 * for automatic JSON serialization/deserialization.
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 */

import { SerializePlugin } from '@syncular/core';
import { Kysely, SqliteDialect } from 'kysely';
import Database from 'libsql';

type LibsqlNativeOptions = NonNullable<
  ConstructorParameters<typeof Database>[1]
>;

export interface LibsqlOptions {
  /** LibSQL URL or local SQLite filename (e.g. `:memory:` or `./data.db`). */
  url: string;

  /** Auth token for remote databases (e.g. Turso). */
  authToken?: string;

  /**
   * Optional sync URL for embedded replicas.
   *
   * When set, `Database.sync()` is called once during initialization.
   */
  syncUrl?: string;

  /** Pass-through options to libsql-js. */
  nativeOptions?: LibsqlNativeOptions;
}

/**
 * Create a Kysely instance with LibSQL dialect and SerializePlugin.
 *
 * @example
 * // Turso cloud
 * const db = createLibsqlDb<MyDb>({
 *   url: 'libsql://my-db-org.turso.io',
 *   authToken: 'your-token',
 * });
 *
 * // Local file / memory
 * const db = createLibsqlDb<MyDb>({ url: ':memory:' });
 * const db = createLibsqlDb<MyDb>({ url: './data.db' });
 */
export function createLibsqlDb<T>(options: LibsqlOptions): Kysely<T> {
  return new Kysely<T>({
    dialect: createLibsqlDialect(options),
    plugins: [new SerializePlugin()],
  });
}

/**
 * Create the LibSQL dialect directly (without SerializePlugin).
 */
export function createLibsqlDialect(options: LibsqlOptions): SqliteDialect {
  const { url, authToken, syncUrl, nativeOptions } = options;

  const mergedOptions: LibsqlNativeOptions & { authToken?: string } = {
    ...nativeOptions,
    ...(syncUrl ? { syncUrl } : {}),
    ...(authToken ? { authToken } : {}),
  };

  const database = new Database(url, mergedOptions);
  if (syncUrl) {
    database.sync();
  }

  return new SqliteDialect({ database });
}

export function createSerializePlugin(): SerializePlugin {
  return new SerializePlugin();
}
