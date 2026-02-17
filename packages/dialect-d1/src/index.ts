/**
 * @syncular/dialect-d1 - Cloudflare D1 dialect for sync
 *
 * Provides a Kysely dialect for Cloudflare D1.
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';

/**
 * Create a Kysely instance with Cloudflare D1 dialect.
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
  });
}

/**
 * Create the D1 dialect directly.
 */
export function createD1Dialect(database: D1Database): D1Dialect {
  return new D1Dialect({ database });
}
