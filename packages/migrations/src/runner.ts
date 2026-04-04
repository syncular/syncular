/**
 * @syncular/migrations - Migration runner
 */

import {
  DISABLED_MIGRATION_CHECKSUM,
  DISABLED_MIGRATION_CHECKSUM_ALGORITHM,
  getLegacyMigrationChecksum,
  getMigrationChecksum,
  getMigrationChecksumAlgorithm,
  inferMigrationChecksumDialect,
  LEGACY_SOURCE_MIGRATION_CHECKSUM_ALGORITHM,
  SQL_TRACE_MIGRATION_CHECKSUM_ALGORITHM,
} from './checksum';
import { DEFAULT_MIGRATION_TRACKING_TABLE } from './naming';
import {
  clearAppliedMigrations,
  ensureTrackingTable,
  getAppliedMigrations,
  recordAppliedMigration,
  removeAppliedMigration,
} from './tracking';
import type {
  DefinedMigrations,
  MigrationChecksumAlgorithm,
  MigrationChecksumDialect,
  ParsedMigration,
  RunMigrationsOptions,
  RunMigrationsResult,
  RunMigrationsToVersionOptions,
  RunMigrationsToVersionResult,
} from './types';

const migrationRunQueues = new Map<string, Promise<void>>();

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyExistsSchemaError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes('already exists') ||
    (message.includes('relation') && message.includes('exists'))
  );
}

function isDeterministicMigration<DB>(migration: ParsedMigration<DB>): boolean {
  return migration.checksum === 'deterministic';
}

function getDeterministicMigrations<DB>(
  migrations: DefinedMigrations<DB>
): ParsedMigration<DB>[] {
  return migrations.migrations.filter(isDeterministicMigration);
}

function requireChecksumDialect<DB>(
  options: RunMigrationsOptions<DB>
): MigrationChecksumDialect {
  const dialect = inferMigrationChecksumDialect(options.db);

  if (dialect) {
    return dialect;
  }

  throw new Error(
    'Deterministic migration checksums are not supported for this runtime or dialect. ' +
      'Set `checksum: "disabled"` on these migrations if they must run without checksum validation.'
  );
}

async function getStoredChecksumForMigration<DB>(
  options: RunMigrationsOptions<DB>,
  migration: ParsedMigration<DB>,
  dialect: MigrationChecksumDialect | null
): Promise<string> {
  if (migration.checksum === 'disabled') {
    return DISABLED_MIGRATION_CHECKSUM;
  }

  const resolvedDialect = dialect ?? requireChecksumDialect(options);
  const checksum = await getMigrationChecksum(
    options.migrations,
    migration,
    resolvedDialect
  );

  if (!checksum) {
    throw new Error(
      `Migration v${migration.version} (${migration.name}) is configured for deterministic checksums but did not produce one.`
    );
  }

  return checksum;
}

async function getChecksumForAlgorithm<DB>(
  options: RunMigrationsOptions<DB>,
  migration: ParsedMigration<DB>,
  algorithm: MigrationChecksumAlgorithm,
  dialect: MigrationChecksumDialect | null
): Promise<string> {
  if (algorithm === DISABLED_MIGRATION_CHECKSUM_ALGORITHM) {
    return DISABLED_MIGRATION_CHECKSUM;
  }

  if (algorithm === LEGACY_SOURCE_MIGRATION_CHECKSUM_ALGORITHM) {
    return getLegacyMigrationChecksum(migration);
  }

  if (algorithm === SQL_TRACE_MIGRATION_CHECKSUM_ALGORITHM) {
    return await getStoredChecksumForMigration(options, migration, dialect);
  }

  throw new Error(`Unsupported migration checksum algorithm: ${algorithm}`);
}

async function runWithMigrationQueue<T>(
  queueKey: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = migrationRunQueues.get(queueKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  migrationRunQueues.set(queueKey, tail);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (migrationRunQueues.get(queueKey) === tail) {
      migrationRunQueues.delete(queueKey);
    }
  }
}

/**
 * Run pending migrations and track their state.
 *
 * @example
 * ```typescript
 * import { defineMigrations, runMigrations } from '@syncular/migrations';
 *
 * const migrations = defineMigrations({
 *   v1: {
 *     up: async (db) => { ... },
 *     down: async (db) => { ... },
 *   },
 *   v2: {
 *     up: async (db) => { ... },
 *     down: async (db) => { ... },
 *   },
 * });
 *
 * const result = await runMigrations({
 *   db,
 *   migrations,
 *   trackingTable: 'sync_migration_state', // optional
 * });
 *
 * console.log(`Applied versions: ${result.applied.join(', ')}`);
 * console.log(`Current version: ${result.currentVersion}`);
 * ```
 */
export async function runMigrations<DB>(
  options: RunMigrationsOptions<DB>
): Promise<RunMigrationsResult> {
  const result = await runMigrationsToVersion({
    ...options,
    targetVersion: options.migrations.currentVersion,
  });
  return {
    applied: result.applied,
    currentVersion: result.currentVersion,
    wasReset: result.wasReset,
  };
}

/**
 * Migrate to an explicit target version, supporting both up and down paths.
 */
export async function runMigrationsToVersion<DB>(
  options: RunMigrationsToVersionOptions<DB>
): Promise<RunMigrationsToVersionResult> {
  const { db, migrations, targetVersion } = options;
  const trackingTable =
    options.trackingTable ?? DEFAULT_MIGRATION_TRACKING_TABLE;
  const onChecksumMismatch = options.onChecksumMismatch ?? 'error';
  const beforeReset = options.beforeReset;
  if (!Number.isInteger(targetVersion) || targetVersion < 0) {
    throw new Error(
      `Invalid target version ${targetVersion}. Target version must be an integer >= 0.`
    );
  }
  if (targetVersion > migrations.currentVersion) {
    throw new Error(
      `Invalid target version ${targetVersion}. Maximum defined version is ${migrations.currentVersion}.`
    );
  }

  // Serialize migration runs per tracking table to avoid duplicate CREATE TABLE
  // races when startup paths invoke migrations concurrently (e.g. React StrictMode).
  return runWithMigrationQueue(`tracking:${trackingTable}`, async () => {
    // Ensure tracking table exists
    await ensureTrackingTable(db, trackingTable);

    // Get already applied migrations
    let applied = await getAppliedMigrations(db, trackingTable);
    let appliedByVersion = new Map(applied.map((m) => [m.version, m]));

    const appliedVersions: number[] = [];
    const revertedVersions: number[] = [];
    let wasReset = false;
    let recoveredFromSchemaConflict = false;
    const deterministicMigrations = getDeterministicMigrations(migrations);
    const checksumDialect =
      deterministicMigrations.length > 0
        ? requireChecksumDialect(options)
        : null;

    // Check for checksum mismatches up-front when reset mode is enabled
    if (onChecksumMismatch === 'reset' && applied.length > 0) {
      let hasMismatch = false;

      for (const migration of deterministicMigrations) {
        const existing = appliedByVersion.get(migration.version);
        if (!existing) {
          continue;
        }

        const currentChecksum = await getChecksumForAlgorithm(
          options,
          migration,
          existing.checksum_algorithm,
          checksumDialect
        );
        if (existing.checksum !== currentChecksum) {
          hasMismatch = true;
          break;
        }
      }

      if (hasMismatch) {
        // Let caller drop application tables first
        await options.beforeReset?.(db);
        // Clear tracking state so all migrations re-run
        await clearAppliedMigrations(db, trackingTable);
        wasReset = true;

        // Refresh applied list (now empty)
        applied = await getAppliedMigrations(db, trackingTable);
        appliedByVersion = new Map(applied.map((m) => [m.version, m]));
      }
    }

    for (const migration of migrations.migrations) {
      const existing = appliedByVersion.get(migration.version);
      if (!existing) {
        continue;
      }

      if (migration.checksum === 'disabled') {
        continue;
      }

      const currentChecksum = await getChecksumForAlgorithm(
        options,
        migration,
        existing.checksum_algorithm,
        checksumDialect
      );

      if (existing.checksum !== currentChecksum) {
        throw new Error(
          `Migration v${migration.version} (${migration.name}) has changed since it was applied. ` +
            `Stored checksum ${existing.checksum} is not compatible with current checksum ${currentChecksum}. ` +
            'Migrations must not be modified after being applied.'
        );
      }
    }

    const currentVersion =
      applied.length > 0 ? applied[applied.length - 1]!.version : 0;

    if (targetVersion > currentVersion) {
      for (let index = 0; index < migrations.migrations.length; index += 1) {
        const migration = migrations.migrations[index]!;
        if (migration.version <= currentVersion) {
          continue;
        }
        if (migration.version > targetVersion) {
          break;
        }

        try {
          await migration.up(db);
        } catch (error) {
          const canRecoverFromConflict =
            onChecksumMismatch === 'reset' &&
            typeof beforeReset === 'function' &&
            !recoveredFromSchemaConflict &&
            isAlreadyExistsSchemaError(error);

          if (!canRecoverFromConflict) {
            throw error;
          }

          // Recover once from partially-applied state where app tables exist
          // but migration tracking rows were not committed.
          await beforeReset(db);
          await clearAppliedMigrations(db, trackingTable);
          wasReset = true;
          recoveredFromSchemaConflict = true;
          applied = await getAppliedMigrations(db, trackingTable);
          appliedByVersion = new Map(applied.map((m) => [m.version, m]));
          appliedVersions.length = 0;
          index = -1;
          continue;
        }

        const checksum = await getStoredChecksumForMigration(
          options,
          migration,
          checksumDialect
        );

        await recordAppliedMigration(db, trackingTable, {
          version: migration.version,
          name: migration.name,
          checksum,
          checksum_algorithm: getMigrationChecksumAlgorithm(migration),
        });
        appliedVersions.push(migration.version);
      }
    } else if (targetVersion < currentVersion) {
      for (
        let version = currentVersion;
        version > targetVersion;
        version -= 1
      ) {
        const migration = migrations.getMigration(version);
        if (!migration) {
          throw new Error(
            `Cannot revert migration v${version}: migration is not defined in current migration set.`
          );
        }
        await migration.down(db);
        await removeAppliedMigration(db, trackingTable, version);
        revertedVersions.push(version);
      }
    }

    return {
      applied: appliedVersions,
      reverted: revertedVersions,
      currentVersion: targetVersion,
      wasReset,
    };
  });
}

/**
 * Get the current schema version without running any migrations.
 */
export async function getSchemaVersion<DB>(
  db: import('kysely').Kysely<DB>,
  trackingTable?: string
): Promise<number> {
  const tableName = trackingTable ?? DEFAULT_MIGRATION_TRACKING_TABLE;
  const applied = await getAppliedMigrations(db, tableName);
  if (applied.length === 0) return 0;
  return applied[applied.length - 1]!.version;
}
