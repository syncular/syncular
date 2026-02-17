/**
 * Migration adapter for the generated Syncular demo.
 */

import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import { getSchemaVersion, runMigrations } from '@syncular/migrations';
import type { Kysely } from 'kysely';
import { demoMigrations, type AppServerDb } from '../src/shared/db';

function createDb(): Kysely<AppServerDb> {
  return createBunSqliteDb<AppServerDb>({ path: './data/server.sqlite' });
}

export const <%= it.ADAPTER_EXPORT %> = {
  async status() {
    const db = createDb();
    try {
      const currentVersion = await getSchemaVersion(
        db,
        'sync_server_migration_state'
      );
      const targetVersion = demoMigrations.currentVersion;
      const pendingVersions = demoMigrations.migrations
        .map((migration) => migration.version)
        .filter((version) => version > currentVersion);

      return {
        currentVersion,
        targetVersion,
        pendingVersions,
        trackingTable: 'sync_server_migration_state',
      };
    } finally {
      await db.destroy();
    }
  },

  async up(options: {
    onChecksumMismatch: 'error' | 'reset';
    dryRun: boolean;
  }) {
    const db = createDb();
    try {
      const currentVersion = await getSchemaVersion(
        db,
        'sync_server_migration_state'
      );

      if (options.dryRun) {
        const pendingVersions = demoMigrations.migrations
          .map((migration) => migration.version)
          .filter((version) => version > currentVersion);

        return {
          appliedVersions: pendingVersions,
          currentVersion,
          wasReset: false,
          dryRun: true,
        };
      }

      const result = await runMigrations({
        db,
        migrations: demoMigrations,
        trackingTable: 'sync_server_migration_state',
        onChecksumMismatch: options.onChecksumMismatch,
      });

      return {
        appliedVersions: result.applied,
        currentVersion: result.currentVersion,
        wasReset: result.wasReset,
        dryRun: false,
      };
    } finally {
      await db.destroy();
    }
  },
};
