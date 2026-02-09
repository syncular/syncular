/**
 * @syncular/dialect-d1 - Cloudflare D1 dialect for sync
 *
 * Provides a Kysely dialect for Cloudflare D1 with SerializePlugin
 * for automatic JSON serialization/deserialization.
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { SerializePlugin } from '@syncular/core';
import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';

/**
 * Create a Kysely instance with Cloudflare D1 dialect and SerializePlugin.
 *
 * @example
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const db = createD1Db<MyDb>(env.DB);
 *     const dialect = createSqliteServerDialect();
 *     await ensureSyncSchema(db, dialect);
 *     // ...
 *   }
 * };
 */
export function createD1Db<T>(database: D1Database): Kysely<T> {
  return new Kysely<T>({
    dialect: createD1Dialect(database),
    plugins: [new SerializePlugin()],
  });
}

/**
 * Create the D1 dialect directly (without SerializePlugin).
 */
export function createD1Dialect(database: D1Database): D1Dialect {
  return new D1Dialect({ database });
}

export function createSerializePlugin(): SerializePlugin {
  return new SerializePlugin();
}
