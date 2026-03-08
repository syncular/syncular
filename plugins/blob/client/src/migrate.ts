import type { Kysely } from 'kysely';

export async function ensureClientBlobSchema<DB>(
  db: Kysely<DB>
): Promise<void> {
  await db.schema
    .createTable('sync_blob_cache')
    .ifNotExists()
    .addColumn('hash', 'text', (col) => col.primaryKey())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('body', 'blob', (col) => col.notNull())
    .addColumn('encrypted', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('key_id', 'text')
    .addColumn('cached_at', 'bigint', (col) => col.notNull())
    .addColumn('last_accessed_at', 'bigint', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_sync_blob_cache_last_accessed')
    .ifNotExists()
    .on('sync_blob_cache')
    .columns(['last_accessed_at'])
    .execute();

  await db.schema
    .createTable('sync_blob_outbox')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('hash', 'text', (col) => col.notNull().unique())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('body', 'blob', (col) => col.notNull())
    .addColumn('encrypted', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('key_id', 'text')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('attempt_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('error', 'text')
    .addColumn('created_at', 'bigint', (col) => col.notNull())
    .addColumn('updated_at', 'bigint', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_sync_blob_outbox_status')
    .ifNotExists()
    .on('sync_blob_outbox')
    .columns(['status', 'created_at'])
    .execute();
}

export async function dropClientBlobSchema<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.dropTable('sync_blob_outbox').ifExists().execute();
  await db.schema.dropTable('sync_blob_cache').ifExists().execute();
}
