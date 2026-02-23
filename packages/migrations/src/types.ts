/**
 * @syncular/migrations - Type definitions
 */

import type { Kysely } from 'kysely';

/**
 * A single migration function that modifies the database schema.
 */
export type MigrationFn<DB = unknown> = (db: Kysely<DB>) => Promise<void>;

/**
 * A reversible migration definition.
 */
export interface ReversibleMigrationDefinition<DB = unknown> {
  /** Apply schema/data changes for this version. */
  up: MigrationFn<DB>;
  /** Revert schema/data changes for this version. */
  down?: MigrationFn<DB>;
}

/**
 * A migration definition can be a single "up" function or
 * an object with explicit up/down handlers.
 */
export type MigrationDefinition<DB = unknown> =
  | MigrationFn<DB>
  | ReversibleMigrationDefinition<DB>;

/**
 * Record of versioned migrations keyed by version string (e.g., 'v1', 'v2').
 */
export type MigrationRecord<DB = unknown> = Record<
  string,
  MigrationDefinition<DB>
>;

/**
 * Parsed migration with version number and handlers.
 */
export interface ParsedMigration<DB = unknown> {
  version: number;
  name: string;
  /** Up migration function. */
  up: MigrationFn<DB>;
  /** Optional down migration function. */
  down?: MigrationFn<DB>;
}

/**
 * Result of defineMigrations() - contains migrations and metadata.
 */
export interface DefinedMigrations<DB = unknown> {
  /** Sorted list of migrations */
  migrations: ParsedMigration<DB>[];
  /** Current (latest) schema version */
  currentVersion: number;
  /** Get migration by version number */
  getMigration(version: number): ParsedMigration<DB> | undefined;
}

/**
 * Migration state row stored in the tracking table.
 */
export interface MigrationStateRow {
  version: number;
  name: string;
  applied_at: string;
  checksum: string;
}

/**
 * Options for running migrations.
 */
export interface RunMigrationsOptions<DB = unknown> {
  /** Kysely database instance */
  db: Kysely<DB>;
  /** Defined migrations from defineMigrations() */
  migrations: DefinedMigrations<DB>;
  /** Name of the tracking table (default: 'sync_migration_state') */
  trackingTable?: string;
  /** What to do when a migration's checksum doesn't match. Default: 'error' */
  onChecksumMismatch?: 'error' | 'reset';
  /** Called before clearing tracking state and re-running migrations.
   *  Use this to drop application tables so migrations can recreate them. */
  beforeReset?: (db: Kysely<DB>) => Promise<void>;
}

/**
 * Result of running migrations.
 */
export interface RunMigrationsResult {
  /** Versions that were applied in this run */
  applied: number[];
  /** Current schema version after migration */
  currentVersion: number;
  /** True if a checksum mismatch triggered a full reset */
  wasReset: boolean;
}

/**
 * Options for migrating to an explicit target version.
 */
export interface RunMigrationsToVersionOptions<DB = unknown>
  extends RunMigrationsOptions<DB> {
  /** Target schema version (0..migrations.currentVersion). */
  targetVersion: number;
}

/**
 * Result of migrating to an explicit target version.
 */
export interface RunMigrationsToVersionResult extends RunMigrationsResult {
  /** Versions that were reverted in this run, highest to lowest. */
  reverted: number[];
}
