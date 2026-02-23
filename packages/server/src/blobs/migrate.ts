/**
 * @syncular/server - Blob storage migrations
 *
 * These migrations are separate from core sync migrations because
 * blob storage is optional and may use external storage (S3/R2).
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { SyncBlobDb, SyncBlobUploadsDb } from './types';

/**
 * Ensures the blob uploads tracking schema exists.
 * This table is required for the blob manager regardless of storage backend.
 *
 * For PostgreSQL.
 */
async function ensureBlobUploadsSchemaPostgres<DB extends SyncBlobUploadsDb>(
  db: Kysely<DB>
): Promise<void> {
  await db.schema
    .createTable('sync_blob_uploads')
    .ifNotExists()
    .addColumn('hash', 'text', (col) => col.primaryKey())
    .addColumn('size', 'bigint', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('actor_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('completed_at', 'timestamptz')
    .execute();

  await db.schema
    .createIndex('idx_sync_blob_uploads_status')
    .ifNotExists()
    .on('sync_blob_uploads')
    .columns(['status'])
    .execute();

  await db.schema
    .createIndex('idx_sync_blob_uploads_expires_at')
    .ifNotExists()
    .on('sync_blob_uploads')
    .columns(['expires_at'])
    .execute();
}

/**
 * Ensures the blob uploads tracking schema exists.
 * This table is required for the blob manager regardless of storage backend.
 *
 * For SQLite.
 */
async function ensureBlobUploadsSchemasSqlite<DB extends SyncBlobUploadsDb>(
  db: Kysely<DB>
): Promise<void> {
  await db.schema
    .createTable('sync_blob_uploads')
    .ifNotExists()
    .addColumn('hash', 'text', (col) => col.primaryKey())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('actor_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`)
    )
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .addColumn('completed_at', 'text')
    .execute();

  await db.schema
    .createIndex('idx_sync_blob_uploads_status')
    .ifNotExists()
    .on('sync_blob_uploads')
    .columns(['status'])
    .execute();

  await db.schema
    .createIndex('idx_sync_blob_uploads_expires_at')
    .ifNotExists()
    .on('sync_blob_uploads')
    .columns(['expires_at'])
    .execute();
}

/**
 * Ensures the blob storage schema exists (for database adapter).
 * Only needed if using the database blob storage adapter.
 *
 * For PostgreSQL.
 */
export async function ensureBlobStorageSchemaPostgres<DB extends SyncBlobDb>(
  db: Kysely<DB>
): Promise<void> {
  // First ensure uploads table
  await ensureBlobUploadsSchemaPostgres(db);

  // Then create blobs table
  await db.schema
    .createTable('sync_blobs')
    .ifNotExists()
    .addColumn('hash', 'text', (col) => col.primaryKey())
    .addColumn('size', 'bigint', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('body', 'bytea', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .execute();
}

/**
 * Ensures the blob storage schema exists (for database adapter).
 * Only needed if using the database blob storage adapter.
 *
 * For SQLite.
 */
export async function ensureBlobStorageSchemaSqlite<DB extends SyncBlobDb>(
  db: Kysely<DB>
): Promise<void> {
  // First ensure uploads table
  await ensureBlobUploadsSchemasSqlite(db);

  // Then create blobs table
  await db.schema
    .createTable('sync_blobs')
    .ifNotExists()
    .addColumn('hash', 'text', (col) => col.primaryKey())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('body', 'blob', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`)
    )
    .execute();
}

/**
 * Drops the blob schema from the database.
 */
export async function dropBlobSchema<DB extends SyncBlobDb>(
  db: Kysely<DB>
): Promise<void> {
  await db.schema.dropTable('sync_blobs').ifExists().execute();
  await db.schema.dropTable('sync_blob_uploads').ifExists().execute();
}
