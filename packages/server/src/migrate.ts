/**
 * @syncular/server - Schema setup
 */

import type { Kysely } from 'kysely';
import type { ServerSyncDialect } from './dialect/types';
import type { SyncCoreDb } from './schema';

/**
 * Ensures the sync schema exists in the database.
 * Safe to call multiple times (idempotent).
 *
 * @typeParam DB - Your database type that extends SyncCoreDb
 */
export async function ensureSyncSchema<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  dialect: ServerSyncDialect
): Promise<void> {
  await dialect.ensureSyncSchema(db);
}
