/**
 * @syncular/demo - Client schema migration
 *
 * Runs versioned client migrations with tracking.
 */

import { dropClientSyncSchema, ensureClientSyncSchema } from '@syncular/client';
import { runMigrations } from '@syncular/migrations';
import type { Kysely } from 'kysely';
import { clientMigrations } from './migrations';
import { migrationChecksums } from './migrate.checksums.generated';
import type { ClientDb } from './types.generated';

const DEFAULT_CLIENT_MIGRATION_TIMEOUT_MS = 20_000;

interface MigrateClientDbWithTimeoutOptions {
  timeoutMs?: number;
  clientStoreKey?: string;
}

class ClientDbInitializationTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly clientStoreKey?: string;

  constructor(timeoutMs: number, clientStoreKey?: string) {
    const scope = clientStoreKey ? ` (${clientStoreKey})` : '';
    super(
      `Client database initialization timed out after ${timeoutMs}ms${scope}. ` +
        'This usually means wa-sqlite worker startup failed or never replied. ' +
        'Check browser support for module workers and Web Locks.'
    );
    this.name = 'ClientDbInitializationTimeoutError';
    this.timeoutMs = timeoutMs;
    this.clientStoreKey = clientStoreKey;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createError());
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Migrate the client database schema
 */
async function migrateClientDb(db: Kysely<ClientDb>): Promise<void> {
  // Create sync infrastructure tables
  await ensureClientSyncSchema(db);

  // Run versioned migrations with auto-reset on checksum mismatch
  await runMigrations({
    db,
    migrations: clientMigrations,
    checksums: migrationChecksums,
    onChecksumMismatch: 'reset',
    beforeReset: async (db) => {
      // Drop app tables so migrations can recreate them
      for (const table of [
        'tasks',
        'shared_tasks',
        'catalog_items',
        'patient_notes',
      ]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
      // Drop and recreate sync schema
      await dropClientSyncSchema(db);
      await ensureClientSyncSchema(db);
    },
  });
}

export async function migrateClientDbWithTimeout(
  db: Kysely<ClientDb>,
  options?: MigrateClientDbWithTimeoutOptions
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLIENT_MIGRATION_TIMEOUT_MS;
  await withTimeout(
    migrateClientDb(db),
    timeoutMs,
    () =>
      new ClientDbInitializationTimeoutError(timeoutMs, options?.clientStoreKey)
  );
}

const RESET_TABLES = [
  'tasks',
  'shared_tasks',
  'catalog_items',
  'patient_notes',
  'sync_conflicts',
  'sync_outbox_commits',
  'sync_subscription_state',
] as const;

/**
 * Reset local demo data while keeping schema/migrations intact.
 * Useful when the backend has been reset and local cursors/outbox are stale.
 */
export async function resetClientData(db: Kysely<ClientDb>): Promise<void> {
  for (const table of RESET_TABLES) {
    await db.deleteFrom(table as any).execute();
  }
}
