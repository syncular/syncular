/**
 * @syncular/client - Sync migrations (SQLite reference)
 */

import type { Kysely } from 'kysely';
import type { SyncClientDb } from './schema';

/**
 * Ensures the client sync schema exists in the database.
 * Safe to call multiple times (idempotent).
 *
 * @typeParam DB - Your database type that extends SyncClientDb
 */
export async function ensureClientSyncSchema<DB extends SyncClientDb>(
  db: Kysely<DB>
): Promise<void> {
  // Schema builder doesn't need typed access - operates on raw SQL.
  await db.schema
    .createTable('sync_subscription_state')
    .ifNotExists()
    .addColumn('state_id', 'text', (col) => col.notNull())
    .addColumn('subscription_id', 'text', (col) => col.notNull())
    .addColumn('table', 'text', (col) => col.notNull())
    .addColumn('scopes_json', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('params_json', 'text', (col) => col.notNull())
    .addColumn('cursor', 'bigint', (col) => col.notNull())
    .addColumn('bootstrap_state_json', 'text')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('created_at', 'bigint', (col) => col.notNull())
    .addColumn('updated_at', 'bigint', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('sync_outbox_commits')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('client_commit_id', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('operations_json', 'text', (col) => col.notNull())
    .addColumn('last_response_json', 'text')
    .addColumn('error', 'text')
    .addColumn('created_at', 'bigint', (col) => col.notNull())
    .addColumn('updated_at', 'bigint', (col) => col.notNull())
    .addColumn('attempt_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('acked_commit_seq', 'bigint')
    .addColumn('schema_version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createTable('sync_conflicts')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('outbox_commit_id', 'text', (col) => col.notNull())
    .addColumn('client_commit_id', 'text', (col) => col.notNull())
    .addColumn('op_index', 'integer', (col) => col.notNull())
    .addColumn('result_status', 'text', (col) => col.notNull())
    .addColumn('message', 'text', (col) => col.notNull())
    .addColumn('code', 'text')
    .addColumn('server_version', 'bigint')
    .addColumn('server_row_json', 'text')
    .addColumn('created_at', 'bigint', (col) => col.notNull())
    .addColumn('resolved_at', 'bigint')
    .addColumn('resolution', 'text')
    .execute();

  await db.schema
    .createIndex('idx_sync_subscription_state_state_sub')
    .ifNotExists()
    .on('sync_subscription_state')
    .columns(['state_id', 'subscription_id'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_sync_subscription_state_state')
    .ifNotExists()
    .on('sync_subscription_state')
    .columns(['state_id', 'updated_at'])
    .execute();

  await db.schema
    .createIndex('idx_sync_outbox_commits_client_commit_id')
    .ifNotExists()
    .on('sync_outbox_commits')
    .columns(['client_commit_id'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_sync_outbox_commits_status_created_at')
    .ifNotExists()
    .on('sync_outbox_commits')
    .columns(['status', 'created_at'])
    .execute();

  await db.schema
    .createIndex('idx_sync_outbox_commits_status_updated_at')
    .ifNotExists()
    .on('sync_outbox_commits')
    .columns(['status', 'updated_at', 'created_at'])
    .execute();

  await db.schema
    .createIndex('idx_sync_conflicts_outbox_commit')
    .ifNotExists()
    .on('sync_conflicts')
    .columns(['outbox_commit_id'])
    .execute();

  await db.schema
    .createIndex('idx_sync_conflicts_resolved_at')
    .ifNotExists()
    .on('sync_conflicts')
    .columns(['resolved_at'])
    .execute();
}

/**
 * Drops the client sync schema from the database.
 *
 * @typeParam DB - Your database type that extends SyncClientDb
 */
export async function dropClientSyncSchema<DB extends SyncClientDb>(
  db: Kysely<DB>
): Promise<void> {
  await db.schema.dropTable('sync_conflicts').ifExists().execute();
  await db.schema.dropTable('sync_outbox_commits').ifExists().execute();
  await db.schema.dropTable('sync_subscription_state').ifExists().execute();
}
