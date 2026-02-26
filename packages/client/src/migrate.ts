/**
 * @syncular/client - Sync migrations (SQLite reference)
 */

import { type Kysely, sql } from 'kysely';
import type { SyncClientDb } from './schema';

type SyncInternalTable =
  | 'sync_subscription_state'
  | 'sync_outbox_commits'
  | 'sync_conflicts';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingTableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('no such table') ||
    (normalized.includes('relation') && normalized.includes('does not exist'))
  );
}

function isMissingColumnError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('no such column') ||
    (normalized.includes('column') && normalized.includes('does not exist'))
  );
}

function isDuplicateColumnError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('duplicate column name') ||
    (normalized.includes('column') && normalized.includes('already exists'))
  );
}

async function getColumnNames<DB extends SyncClientDb>(
  db: Kysely<DB>,
  tableName: SyncInternalTable
): Promise<Set<string> | null> {
  try {
    const sqlite = await sql<{ name: string }>`
      select name from pragma_table_info(${sql.val(tableName)})
    `.execute(db);
    return new Set(sqlite.rows.map((row) => String(row.name)));
  } catch {
    // Not SQLite or pragma unavailable.
  }

  try {
    const postgres = await sql<{ name: string }>`
      select column_name as name
      from information_schema.columns
      where table_name = ${sql.val(tableName)}
    `.execute(db);
    return new Set(postgres.rows.map((row) => String(row.name)));
  } catch {
    // Introspection unavailable; caller falls back to probing.
  }

  return null;
}

async function hasColumn<DB extends SyncClientDb>(
  db: Kysely<DB>,
  tableName: SyncInternalTable,
  columnName: string
): Promise<boolean> {
  const columns = await getColumnNames(db, tableName);
  if (columns) {
    return columns.has(columnName);
  }

  try {
    await sql`select ${sql.ref(columnName)} from ${sql.table(tableName)} limit 1`.execute(
      db
    );
    return true;
  } catch (error) {
    const message = toErrorMessage(error);
    if (isMissingTableError(message) || isMissingColumnError(message)) {
      return false;
    }
    throw error;
  }
}

async function addColumnIfMissing<DB extends SyncClientDb>(
  db: Kysely<DB>,
  tableName: SyncInternalTable,
  columnName: string,
  addColumn: () => Promise<void>
): Promise<void> {
  if (await hasColumn(db, tableName, columnName)) {
    return;
  }
  try {
    await addColumn();
  } catch (error) {
    const message = toErrorMessage(error);
    if (isDuplicateColumnError(message)) {
      return;
    }
    throw error;
  }
}

async function ensureClientSyncSchemaCompat<DB extends SyncClientDb>(
  db: Kysely<DB>
): Promise<void> {
  const hasTableColumn = await hasColumn(
    db,
    'sync_subscription_state',
    'table'
  );
  if (
    !hasTableColumn &&
    (await hasColumn(db, 'sync_subscription_state', 'shape'))
  ) {
    try {
      await sql`alter table ${sql.table('sync_subscription_state')} rename column ${sql.ref('shape')} to ${sql.ref('table')}`.execute(
        db
      );
    } catch {
      await addColumnIfMissing(
        db,
        'sync_subscription_state',
        'table',
        async () => {
          await db.schema
            .alterTable('sync_subscription_state')
            .addColumn('table', 'text', (col) => col.notNull().defaultTo(''))
            .execute();
        }
      );
      await sql`update ${sql.table('sync_subscription_state')}
        set ${sql.ref('table')} = ${sql.ref('shape')}
        where ${sql.ref('table')} = ${sql.val('')}`.execute(db);
    }
  }

  await addColumnIfMissing(
    db,
    'sync_subscription_state',
    'bootstrap_state_json',
    async () => {
      await db.schema
        .alterTable('sync_subscription_state')
        .addColumn('bootstrap_state_json', 'text')
        .execute();
    }
  );

  await addColumnIfMissing(
    db,
    'sync_outbox_commits',
    'schema_version',
    async () => {
      await db.schema
        .alterTable('sync_outbox_commits')
        .addColumn('schema_version', 'integer', (col) =>
          col.notNull().defaultTo(1)
        )
        .execute();
    }
  );

  await addColumnIfMissing(db, 'sync_conflicts', 'resolved_at', async () => {
    await db.schema
      .alterTable('sync_conflicts')
      .addColumn('resolved_at', 'bigint')
      .execute();
  });

  await addColumnIfMissing(db, 'sync_conflicts', 'resolution', async () => {
    await db.schema
      .alterTable('sync_conflicts')
      .addColumn('resolution', 'text')
      .execute();
  });

  await db.schema
    .createIndex('idx_sync_outbox_commits_status_updated_at')
    .ifNotExists()
    .on('sync_outbox_commits')
    .columns(['status', 'updated_at', 'created_at'])
    .execute();
}

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

  // Apply framework-managed compatibility upgrades for legacy sync tables.
  await ensureClientSyncSchemaCompat(db);

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
