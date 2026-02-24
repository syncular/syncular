/**
 * @syncular/dialect-d1 - Cloudflare D1 dialect for sync
 *
 * Provides a Kysely dialect for Cloudflare D1.
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { D1Dialect } from 'kysely-d1';

/**
 * Create the D1 dialect directly.
 */
export function createD1Dialect(database: D1Database): D1Dialect {
  return new D1Dialect({ database });
}
