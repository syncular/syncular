import type {
  MigrationChecksumAlgorithm,
  MigrationChecksums,
  ParsedMigration,
} from './types';

export const DISABLED_MIGRATION_CHECKSUM = '__syncular_checksum_disabled__';
export const SQL_TRACE_MIGRATION_CHECKSUM_ALGORITHM = 'sql_trace_v1';
export const DISABLED_MIGRATION_CHECKSUM_ALGORITHM = 'disabled';

export function getStoredDeterministicChecksum<DB>(
  migration: ParsedMigration<DB>,
  checksums: MigrationChecksums | undefined
): string {
  if (migration.checksum === 'disabled') {
    return DISABLED_MIGRATION_CHECKSUM;
  }

  if (!checksums) {
    throw new Error(
      `Migration v${migration.version} (${migration.name}) requires generated checksums. ` +
        'Generate a checksum manifest with @syncular/typegen and pass it to runMigrations({ checksums }).'
    );
  }

  const checksum = checksums[String(migration.version)];

  if (!checksum) {
    throw new Error(
      `Missing generated checksum for migration v${migration.version} (${migration.name}). ` +
        'Regenerate the checksum manifest before running migrations.'
    );
  }

  return checksum;
}

export function getMigrationChecksumAlgorithm<DB>(
  migration: ParsedMigration<DB>,
  checksums: MigrationChecksums | undefined
): MigrationChecksumAlgorithm {
  if (migration.checksum === 'disabled') {
    return DISABLED_MIGRATION_CHECKSUM_ALGORITHM;
  }

  if (!checksums) {
    throw new Error(
      `Migration v${migration.version} (${migration.name}) requires generated checksums. ` +
        'Generate a checksum manifest with @syncular/typegen and pass it to runMigrations({ checksums }).'
    );
  }

  return SQL_TRACE_MIGRATION_CHECKSUM_ALGORITHM;
}
