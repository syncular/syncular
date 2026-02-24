/**
 * @syncular/dialect-neon - Neon serverless Postgres dialect for sync
 *
 * Provides a Kysely dialect for Neon serverless Postgres (HTTP).
 * Postgres-compatible — use with @syncular/server-dialect-postgres.
 *
 * Note: Uses Neon's HTTP driver for stateless queries — ideal for
 * serverless/edge environments. Does not support interactive transactions.
 * For transaction support, use Neon's WebSocket pool with Kysely's
 * built-in PostgresDialect instead.
 */

import { neon } from '@neondatabase/serverless';
import { NeonDialect } from 'kysely-neon';

export interface NeonOptions {
  /** Neon Postgres connection string */
  connectionString: string;
}

/**
 * Create the Neon dialect directly.
 */
export function createNeonDialect(options: NeonOptions): NeonDialect {
  return new NeonDialect({
    neon: neon(options.connectionString),
  });
}
