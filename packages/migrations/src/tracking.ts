/**
 * @syncular/migrations - Migration tracking table helpers
 */

import { type Kysely, sql } from 'kysely';
import { LEGACY_SOURCE_MIGRATION_CHECKSUM_ALGORITHM } from './checksum';
import type { MigrationStateRow } from './types';

function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('duplicate column') ||
    message.includes('already exists') ||
    (message.includes('column') && message.includes('exists'))
  );
}

/**
 * Ensure the migration tracking table exists.
 */
export async function ensureTrackingTable<DB>(
  db: Kysely<DB>,
  tableName: string
): Promise<void> {
  await db.schema
    .createTable(tableName)
    .ifNotExists()
    .addColumn('version', 'integer', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('applied_at', 'text', (col) => col.notNull())
    .addColumn('checksum', 'text', (col) => col.notNull())
    .addColumn('checksum_algorithm', 'text', (col) => col.notNull())
    .execute();

  try {
    await sql`
      alter table ${sql.table(tableName)}
      add column checksum_algorithm text not null default ${sql.raw(`'${LEGACY_SOURCE_MIGRATION_CHECKSUM_ALGORITHM}'`)}
    `.execute(db);
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

/**
 * Get all applied migrations from the tracking table.
 */
export async function getAppliedMigrations<DB, TTableName extends string>(
  db: Kysely<DB>,
  tableName: TTableName
): Promise<MigrationStateRow[]> {
  await ensureTrackingTable(db, tableName);

  const result = await sql<MigrationStateRow>`
    select version, name, applied_at, checksum, checksum_algorithm
    from ${sql.table(tableName)}
    order by version asc
  `.execute(db);

  return result.rows;
}

/**
 * Record a migration as applied in the tracking table.
 */
export async function recordAppliedMigration<DB, TTableName extends string>(
  db: Kysely<DB>,
  tableName: TTableName,
  migration: Omit<MigrationStateRow, 'applied_at'>
): Promise<void> {
  await ensureTrackingTable(db, tableName);

  await sql`
    insert into ${sql.table(tableName)} (
      version,
      name,
      applied_at,
      checksum,
      checksum_algorithm
    )
    values (
      ${migration.version},
      ${migration.name},
      ${new Date().toISOString()},
      ${migration.checksum},
      ${migration.checksum_algorithm}
    )
  `.execute(db);
}

/**
 * Remove one migration row from the tracking table.
 */
export async function removeAppliedMigration<DB, TTableName extends string>(
  db: Kysely<DB>,
  tableName: TTableName,
  version: number
): Promise<void> {
  await ensureTrackingTable(db, tableName);

  await sql`
    delete from ${sql.table(tableName)}
    where version = ${version}
  `.execute(db);
}

/**
 * Clear all rows from the migration tracking table.
 * Used when resetting the database after a checksum mismatch.
 */
export async function clearAppliedMigrations<DB>(
  db: Kysely<DB>,
  tableName: string
): Promise<void> {
  await sql`delete from ${sql.table(tableName)}`.execute(db);
}

/**
 * Get the current schema version from the tracking table.
 * Returns 0 if no migrations have been applied.
 */
export async function getCurrentVersion<DB, TTableName extends string>(
  db: Kysely<DB>,
  tableName: TTableName
): Promise<number> {
  const applied = await getAppliedMigrations(db, tableName);
  if (applied.length === 0) return 0;
  return applied[applied.length - 1]!.version;
}
