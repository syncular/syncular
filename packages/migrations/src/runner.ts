/**
 * @syncular/migrations - Migration runner
 */

import { getMigrationChecksum } from './define';
import {
  clearAppliedMigrations,
  ensureTrackingTable,
  getAppliedMigrations,
  recordAppliedMigration,
} from './tracking';
import type { RunMigrationsOptions, RunMigrationsResult } from './types';

const DEFAULT_TRACKING_TABLE = 'sync_migration_state';
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
 *   v1: async (db) => { ... },
 *   v2: async (db) => { ... },
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
  const { db, migrations } = options;
  const trackingTable = options.trackingTable ?? DEFAULT_TRACKING_TABLE;
  const onChecksumMismatch = options.onChecksumMismatch ?? 'error';
  const beforeReset = options.beforeReset;

  // Serialize migration runs per tracking table to avoid duplicate CREATE TABLE
  // races when startup paths invoke migrations concurrently (e.g. React StrictMode).
  return runWithMigrationQueue(`tracking:${trackingTable}`, async () => {
    // Ensure tracking table exists
    await ensureTrackingTable(db, trackingTable);

    // Get already applied migrations
    let applied = await getAppliedMigrations(db, trackingTable);
    let appliedByVersion = new Map(applied.map((m) => [m.version, m]));

    const appliedVersions: number[] = [];
    let wasReset = false;
    let recoveredFromSchemaConflict = false;

    // Check for checksum mismatches up-front when reset mode is enabled
    if (onChecksumMismatch === 'reset' && applied.length > 0) {
      const hasMismatch = migrations.migrations.some((migration) => {
        const existing = appliedByVersion.get(migration.version);
        if (!existing) return false;
        return existing.checksum !== getMigrationChecksum(migration);
      });

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

    for (let index = 0; index < migrations.migrations.length; index += 1) {
      const migration = migrations.migrations[index]!;
      const existing = appliedByVersion.get(migration.version);

      if (existing) {
        // Migration already applied - verify checksum hasn't changed
        const currentChecksum = getMigrationChecksum(migration);
        if (existing.checksum !== currentChecksum) {
          throw new Error(
            `Migration v${migration.version} (${migration.name}) has changed since it was applied. ` +
              `Expected checksum ${existing.checksum}, got ${currentChecksum}. ` +
              'Migrations must not be modified after being applied.'
          );
        }
        continue;
      }

      // Run the migration
      try {
        await migration.fn(db);
      } catch (error) {
        const canRecoverFromConflict =
          onChecksumMismatch === 'reset' &&
          typeof beforeReset === 'function' &&
          !recoveredFromSchemaConflict &&
          isAlreadyExistsSchemaError(error);

        if (!canRecoverFromConflict) {
          throw error;
        }

        // Recover once from partially-applied state where app tables exist but
        // migration tracking rows were not committed.
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

      // Record it as applied
      await recordAppliedMigration(db, trackingTable, {
        version: migration.version,
        name: migration.name,
        checksum: getMigrationChecksum(migration),
      });

      appliedVersions.push(migration.version);
    }

    return {
      applied: appliedVersions,
      currentVersion: migrations.currentVersion,
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
  const tableName = trackingTable ?? DEFAULT_TRACKING_TABLE;
  const applied = await getAppliedMigrations(db, tableName);
  if (applied.length === 0) return 0;
  return applied[applied.length - 1]!.version;
}
