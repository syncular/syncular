/**
 * Tests for @syncular/migrations
 *
 * Covers:
 * - Whitespace-resilient checksums (normalizeSource)
 * - defineMigrations version parsing and sorting
 * - runMigrations basic flow
 * - Checksum mismatch: error mode (default)
 * - Checksum mismatch: reset mode
 * - clearAppliedMigrations
 * - wasReset result field
 * - beforeReset callback
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  clearAppliedMigrations,
  defineMigrations,
  getAppliedMigrations,
  getMigrationChecksum,
  getSchemaVersion,
  runMigrations,
  runMigrationsToVersion,
} from '@syncular/migrations';
import type { Kysely } from 'kysely';

interface TestDb {
  items: { id: string; name: string };
}

describe('migrations', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
  });

  describe('whitespace-resilient checksums', () => {
    it('produces the same checksum regardless of whitespace formatting', () => {
      // Two functions with identical logic but different formatting
      const migrations1 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      // Same function but with different whitespace
      const migrations2 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      const checksum1 = getMigrationChecksum(migrations1.migrations[0]!);
      const checksum2 = getMigrationChecksum(migrations2.migrations[0]!);

      expect(checksum1).toBe(checksum2);
    });

    it('produces the same checksum when comments differ', () => {
      const migrations1 = defineMigrations<TestDb>({
        v1: async (db) => {
          // Create items table
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      const migrations2 = defineMigrations<TestDb>({
        v1: async (db) => {
          /* Different comment style */
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      const checksum1 = getMigrationChecksum(migrations1.migrations[0]!);
      const checksum2 = getMigrationChecksum(migrations2.migrations[0]!);

      expect(checksum1).toBe(checksum2);
    });

    it('produces different checksums when logic changes', () => {
      const migrations1 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      const migrations2 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text', (col) => col.notNull())
            .execute();
        },
      });

      const checksum1 = getMigrationChecksum(migrations1.migrations[0]!);
      const checksum2 = getMigrationChecksum(migrations2.migrations[0]!);

      expect(checksum1).not.toBe(checksum2);
    });

    it('does not strip // markers inside string literals', () => {
      const migrations1 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text', (col) =>
              col.defaultTo('https://api.one.example/sync')
            )
            .execute();
        },
      });

      const migrations2 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text', (col) =>
              col.defaultTo('https://api.two.example/sync')
            )
            .execute();
        },
      });

      const checksum1 = getMigrationChecksum(migrations1.migrations[0]!);
      const checksum2 = getMigrationChecksum(migrations2.migrations[0]!);

      expect(checksum1).not.toBe(checksum2);
    });

    it('does not strip /* */ markers inside string literals', () => {
      const migrations1 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text', (col) =>
              col.defaultTo('tenant/*one*/scope')
            )
            .execute();
        },
      });

      const migrations2 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text', (col) =>
              col.defaultTo('tenant/*two*/scope')
            )
            .execute();
        },
      });

      const checksum1 = getMigrationChecksum(migrations1.migrations[0]!);
      const checksum2 = getMigrationChecksum(migrations2.migrations[0]!);

      expect(checksum1).not.toBe(checksum2);
    });
  });

  describe('runMigrations', () => {
    it('applies pending migrations and returns applied versions', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      const result = await runMigrations({ db, migrations });

      expect(result.applied).toEqual([1]);
      expect(result.currentVersion).toBe(1);
      expect(result.wasReset).toBe(false);

      // Table should exist
      const rows = await db.selectFrom('items').selectAll().execute();
      expect(rows).toEqual([]);
    });

    it('skips already-applied migrations on second run', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      const result1 = await runMigrations({ db, migrations });
      expect(result1.applied).toEqual([1]);

      const result2 = await runMigrations({ db, migrations });
      expect(result2.applied).toEqual([]);
      expect(result2.wasReset).toBe(false);
    });

    it('serializes concurrent runs for the same tracking table', async () => {
      const dbPath = `/tmp/syncular-migrations-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`;
      const dbA = createDatabase<TestDb>({
        dialect: createBunSqliteDialect({ path: dbPath }),
        family: 'sqlite',
      });
      const dbB = createDatabase<TestDb>({
        dialect: createBunSqliteDialect({ path: dbPath }),
        family: 'sqlite',
      });

      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      try {
        const [resultA, resultB] = await Promise.all([
          runMigrations({ db: dbA, migrations }),
          runMigrations({ db: dbB, migrations }),
        ]);

        const appliedSets = [resultA.applied, resultB.applied].sort(
          (left, right) => right.length - left.length
        );
        expect(appliedSets).toEqual([[1], []]);

        const applied = await getAppliedMigrations(dbA, 'sync_migration_state');
        expect(applied).toHaveLength(1);
      } finally {
        await Promise.all([
          dbA.destroy().catch(() => {}),
          dbB.destroy().catch(() => {}),
        ]);
        await rm(dbPath, { force: true });
      }
    });

    it('throws on checksum mismatch in error mode (default)', async () => {
      const migrations1 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      await runMigrations({ db, migrations: migrations1 });

      // "Modify" the migration (different function body => different checksum)
      const migrations2 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text', (col) => col.notNull())
            .execute();
        },
      });

      await expect(
        runMigrations({ db, migrations: migrations2 })
      ).rejects.toThrow(/has changed since it was applied/);
    });

    it('resets on checksum mismatch when onChecksumMismatch is "reset"', async () => {
      const migrations1 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      await runMigrations({ db, migrations: migrations1 });

      // Insert a row to verify reset drops and recreates the table
      await db
        .insertInto('items')
        .values({ id: '1', name: 'original' })
        .execute();

      // "Modify" the migration
      const migrations2 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text', (col) => col.notNull())
            .execute();
        },
      });

      const result = await runMigrations({
        db,
        migrations: migrations2,
        onChecksumMismatch: 'reset',
        beforeReset: async (db) => {
          await db.schema.dropTable('items').ifExists().execute();
        },
      });

      expect(result.wasReset).toBe(true);
      expect(result.applied).toEqual([1]);

      // Table was recreated (old data gone)
      const rows = await db.selectFrom('items').selectAll().execute();
      expect(rows).toEqual([]);
    });

    it('recovers from pre-existing app tables when reset mode is enabled', async () => {
      await db.schema
        .createTable('items')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text')
        .execute();

      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      const result = await runMigrations({
        db,
        migrations,
        onChecksumMismatch: 'reset',
        beforeReset: async (db) => {
          await db.schema.dropTable('items').ifExists().execute();
        },
      });

      expect(result.wasReset).toBe(true);
      expect(result.applied).toEqual([1]);
    });

    it('calls beforeReset before clearing tracking state', async () => {
      const callOrder: string[] = [];

      const migrations1 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      await runMigrations({ db, migrations: migrations1 });

      const migrations2 = defineMigrations<TestDb>({
        v1: async (db) => {
          callOrder.push('migration-v1');
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text', (col) => col.notNull())
            .execute();
        },
      });

      await runMigrations({
        db,
        migrations: migrations2,
        onChecksumMismatch: 'reset',
        beforeReset: async () => {
          callOrder.push('beforeReset');
          await db.schema.dropTable('items').ifExists().execute();
        },
      });

      expect(callOrder).toEqual(['beforeReset', 'migration-v1']);
    });

    it('does not reset when checksums match even in reset mode', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      await runMigrations({ db, migrations });

      const result = await runMigrations({
        db,
        migrations,
        onChecksumMismatch: 'reset',
      });

      expect(result.wasReset).toBe(false);
      expect(result.applied).toEqual([]);
    });
  });

  describe('clearAppliedMigrations', () => {
    it('removes all rows from the tracking table', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      await runMigrations({ db, migrations });

      const before = await getAppliedMigrations(db, 'sync_migration_state');
      expect(before.length).toBe(1);

      await clearAppliedMigrations(db, 'sync_migration_state');

      const after = await getAppliedMigrations(db, 'sync_migration_state');
      expect(after.length).toBe(0);
    });
  });

  describe('multi-version migrations', () => {
    it('applies multiple versions in order', async () => {
      const applied: number[] = [];

      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          applied.push(1);
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
        v2: async (db) => {
          applied.push(2);
          await db.schema
            .alterTable('items')
            .addColumn('description', 'text')
            .execute();
        },
      });

      const result = await runMigrations({ db, migrations });

      expect(result.applied).toEqual([1, 2]);
      expect(result.currentVersion).toBe(2);
      expect(applied).toEqual([1, 2]);
    });

    it('resets all versions on checksum mismatch in any version', async () => {
      const migrations1 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
        v2: async (db) => {
          await db.schema
            .alterTable('items')
            .addColumn('description', 'text')
            .execute();
        },
      });

      await runMigrations({ db, migrations: migrations1 });

      // Change v1 but keep v2 the same
      const migrations2 = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text', (col) => col.notNull())
            .execute();
        },
        v2: async (db) => {
          await db.schema
            .alterTable('items')
            .addColumn('description', 'text')
            .execute();
        },
      });

      const result = await runMigrations({
        db,
        migrations: migrations2,
        onChecksumMismatch: 'reset',
        beforeReset: async (db) => {
          await db.schema.dropTable('items').ifExists().execute();
        },
      });

      expect(result.wasReset).toBe(true);
      expect(result.applied).toEqual([1, 2]);
    });

    it('supports reversible migration definitions with up/down', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: {
          up: async (db) => {
            await db.schema
              .createTable('items')
              .addColumn('id', 'text', (col) => col.primaryKey())
              .addColumn('name', 'text')
              .execute();
          },
          down: async (db) => {
            await db.schema.dropTable('items').ifExists().execute();
          },
        },
      });

      const upResult = await runMigrationsToVersion({
        db,
        migrations,
        targetVersion: 1,
      });
      expect(upResult.applied).toEqual([1]);
      expect(upResult.reverted).toEqual([]);
      expect(upResult.currentVersion).toBe(1);

      const downResult = await runMigrationsToVersion({
        db,
        migrations,
        targetVersion: 0,
      });
      expect(downResult.applied).toEqual([]);
      expect(downResult.reverted).toEqual([1]);
      expect(downResult.currentVersion).toBe(0);
    });

    it('reverts down migrations in descending order', async () => {
      const order: string[] = [];
      const migrations = defineMigrations<TestDb>({
        v1: {
          up: async (db) => {
            order.push('up-1');
            await db.schema
              .createTable('items')
              .addColumn('id', 'text', (col) => col.primaryKey())
              .addColumn('name', 'text')
              .execute();
          },
          down: async (db) => {
            order.push('down-1');
            await db.schema.dropTable('items').ifExists().execute();
          },
        },
        v2: {
          up: async (db) => {
            order.push('up-2');
            await db.schema
              .createTable('v2_probe')
              .addColumn('id', 'text', (col) => col.primaryKey())
              .execute();
          },
          down: async (db) => {
            order.push('down-2');
            await db.schema.dropTable('v2_probe').ifExists().execute();
          },
        },
      });

      await runMigrations({ db, migrations });
      order.length = 0;

      const result = await runMigrationsToVersion({
        db,
        migrations,
        targetVersion: 0,
      });

      expect(result.reverted).toEqual([2, 1]);
      expect(order).toEqual(['down-2', 'down-1']);
      const applied = await getAppliedMigrations(db, 'sync_migration_state');
      expect(applied).toEqual([]);
    });

    it('throws when a required down migration is missing', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      await runMigrations({ db, migrations });
      await expect(
        runMigrationsToVersion({
          db,
          migrations,
          targetVersion: 0,
        })
      ).rejects.toThrow(/down migration is not defined/);
    });
  });

  describe('defineMigrations sorting', () => {
    it('sorts out-of-order version keys into ascending order', () => {
      const migrations = defineMigrations<TestDb>({
        v3: async (_db) => {
          /* v3 */
        },
        v1: async (_db) => {
          /* v1 */
        },
        v2: async (_db) => {
          /* v2 */
        },
      });
      expect(migrations.migrations.map((m) => m.version)).toEqual([1, 2, 3]);
      expect(migrations.currentVersion).toBe(3);
    });
  });

  describe('runMigrationsToVersion partial', () => {
    it('applies only up to the target version (partial up)', async () => {
      const applied: number[] = [];

      const migrations = defineMigrations<TestDb>({
        v1: {
          up: async (db) => {
            applied.push(1);
            await db.schema
              .createTable('items')
              .addColumn('id', 'text', (col) => col.primaryKey())
              .addColumn('name', 'text')
              .execute();
          },
          down: async (db) => {
            await db.schema.dropTable('items').ifExists().execute();
          },
        },
        v2: {
          up: async (db) => {
            applied.push(2);
            await db.schema
              .alterTable('items')
              .addColumn('description', 'text')
              .execute();
          },
          down: async (db) => {
            await db.schema
              .alterTable('items')
              .dropColumn('description')
              .execute();
          },
        },
        v3: {
          up: async (db) => {
            applied.push(3);
            await db.schema
              .alterTable('items')
              .addColumn('priority', 'integer')
              .execute();
          },
          down: async (db) => {
            await db.schema
              .alterTable('items')
              .dropColumn('priority')
              .execute();
          },
        },
      });

      const result = await runMigrationsToVersion({
        db,
        migrations,
        targetVersion: 2,
      });

      expect(result.applied).toEqual([1, 2]);
      expect(result.reverted).toEqual([]);
      expect(result.currentVersion).toBe(2);
      expect(applied).toEqual([1, 2]);

      // v3 should NOT have been applied
      const appliedRows = await getAppliedMigrations(
        db,
        'sync_migration_state'
      );
      expect(appliedRows.map((r) => r.version)).toEqual([1, 2]);
    });

    it('reverts down to the target version (partial down)', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: {
          up: async (db) => {
            await db.schema
              .createTable('items')
              .addColumn('id', 'text', (col) => col.primaryKey())
              .addColumn('name', 'text')
              .execute();
          },
          down: async (db) => {
            await db.schema.dropTable('items').ifExists().execute();
          },
        },
        v2: {
          up: async (db) => {
            await db.schema
              .alterTable('items')
              .addColumn('description', 'text')
              .execute();
          },
          down: async (db) => {
            await db.schema
              .alterTable('items')
              .dropColumn('description')
              .execute();
          },
        },
        v3: {
          up: async (db) => {
            await db.schema
              .alterTable('items')
              .addColumn('priority', 'integer')
              .execute();
          },
          down: async (db) => {
            await db.schema
              .alterTable('items')
              .dropColumn('priority')
              .execute();
          },
        },
      });

      // Apply all three
      await runMigrations({ db, migrations });

      // Revert from v3 down to v1
      const result = await runMigrationsToVersion({
        db,
        migrations,
        targetVersion: 1,
      });

      expect(result.applied).toEqual([]);
      expect(result.reverted).toEqual([3, 2]);
      expect(result.currentVersion).toBe(1);

      const appliedRows = await getAppliedMigrations(
        db,
        'sync_migration_state'
      );
      expect(appliedRows.map((r) => r.version)).toEqual([1]);
    });

    it('returns a no-op result when already at the target version', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: {
          up: async (db) => {
            await db.schema
              .createTable('items')
              .addColumn('id', 'text', (col) => col.primaryKey())
              .addColumn('name', 'text')
              .execute();
          },
          down: async (db) => {
            await db.schema.dropTable('items').ifExists().execute();
          },
        },
        v2: {
          up: async (db) => {
            await db.schema
              .alterTable('items')
              .addColumn('description', 'text')
              .execute();
          },
          down: async (db) => {
            await db.schema
              .alterTable('items')
              .dropColumn('description')
              .execute();
          },
        },
      });

      // Migrate to v2
      await runMigrationsToVersion({ db, migrations, targetVersion: 2 });

      // Run to v2 again → no-op
      const result = await runMigrationsToVersion({
        db,
        migrations,
        targetVersion: 2,
      });

      expect(result.applied).toEqual([]);
      expect(result.reverted).toEqual([]);
      expect(result.currentVersion).toBe(2);
      expect(result.wasReset).toBe(false);
    });
  });

  describe('getSchemaVersion', () => {
    it('returns 0 for a fresh database', async () => {
      const version = await getSchemaVersion(db, 'sync_migration_state');
      expect(version).toBe(0);
    });

    it('returns the correct version after migrations', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
        v2: async (db) => {
          await db.schema
            .alterTable('items')
            .addColumn('description', 'text')
            .execute();
        },
      });

      await runMigrations({ db, migrations });

      const version = await getSchemaVersion(db, 'sync_migration_state');
      expect(version).toBe(2);
    });
  });

  describe('custom tracking table', () => {
    it('uses a custom tracking table isolated from the default', async () => {
      const migrations = defineMigrations<TestDb>({
        v1: async (db) => {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('name', 'text')
            .execute();
        },
      });

      await runMigrations({
        db,
        migrations,
        trackingTable: 'custom_tracking',
      });

      // Custom table should have the migration recorded
      const customApplied = await getAppliedMigrations(db, 'custom_tracking');
      expect(customApplied).toHaveLength(1);
      expect(customApplied[0]!.version).toBe(1);

      // Default table should be empty (no migrations recorded there)
      const defaultApplied = await getAppliedMigrations(
        db,
        'sync_migration_state'
      );
      expect(defaultApplied).toHaveLength(0);
    });
  });
});
