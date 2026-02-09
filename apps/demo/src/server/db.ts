/**
 * @syncular/demo - Server database setup
 *
 * Uses PGlite (in-memory Postgres) for the server database.
 */

import { createPgliteDb } from '@syncular/dialect-pglite';
import { runMigrations } from '@syncular/migrations';
import {
  ensureSyncSchema,
  type SyncBlobDb,
  type SyncCoreDb,
} from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import type { Kysely } from 'kysely';
import type { ClientDb } from '../client/types.generated';
import { serverMigrations } from './migrations';

/**
 * Server database schema - extends client types with server infrastructure.
 */
export interface ServerDb extends SyncCoreDb, SyncBlobDb, ClientDb {}

/**
 * Create and initialize the server database
 */
export async function createServerDb(): Promise<{
  db: Kysely<ServerDb>;
  dialect: ReturnType<typeof createPostgresServerDialect>;
}> {
  const db = createPgliteDb<ServerDb>();
  const dialect = createPostgresServerDialect();

  // Create sync infrastructure tables
  await ensureSyncSchema(db, dialect);

  // Run versioned migrations
  await runMigrations({
    db,
    migrations: serverMigrations,
    trackingTable: 'sync_server_migration_state',
  });

  return { db, dialect };
}
