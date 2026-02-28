/**
 * @syncular/demo - Client schema migration
 *
 * Runs versioned migrations from migrations.ts with tracking.
 */

import { dropClientSyncSchema, ensureClientSyncSchema } from '@syncular/client';
import { runMigrations } from '@syncular/migrations';
import type { Kysely } from 'kysely';
import type { ClientDb } from './types.generated';

/**
 * @syncular/demo - Client database migrations
 *
 * Version-tracked migrations that define the client schema.
 * Types are generated from these migrations using @syncular/typegen.
 */

import { defineMigrations } from '@syncular/migrations';

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

/** @public Used by scripts/generate-types.ts */
export const clientMigrations = defineMigrations<ClientDb>({
  v1: async (db) => {
    // Create tasks table
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    // Add index for user_id lookups
    await db.schema
      .createIndex('idx_tasks_user_id')
      .on('tasks')
      .columns(['user_id'])
      .execute();

    // Create shared_tasks table (shared scope for E2EE key-share demo)
    await db.schema
      .createTable('shared_tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('share_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('owner_id', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    await db.schema
      .createIndex('idx_shared_tasks_share_id')
      .on('shared_tasks')
      .columns(['share_id'])
      .execute();

    // Large catalog table (read-only demo; loaded via chunked snapshots)
    await db.schema
      .createTable('catalog_items')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    // Patient notes table (symmetric E2EE demo with per-patient scopes)
    await db.schema
      .createTable('patient_notes')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('patient_id', 'text', (col) => col.notNull())
      .addColumn('note', 'text', (col) => col.notNull())
      .addColumn('created_by', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    await db.schema
      .createIndex('idx_patient_notes_patient_id')
      .on('patient_notes')
      .columns(['patient_id'])
      .execute();
  },

  v2: async (db) => {
    // Add image column to tasks (stores JSON BlobRef)
    await db.schema.alterTable('tasks').addColumn('image', 'text').execute();
  },

  v3: async (db) => {
    // Add Yjs state column for CRDT-backed task titles
    await db.schema
      .alterTable('tasks')
      .addColumn('title_yjs_state', 'text')
      .execute();
  },
});

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
