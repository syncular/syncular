import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { MigrationInput } from '../src/generate';
import {
  buildMigrationLock,
  LEGACY_MIGRATION_LOCK_FORMAT_VERSION,
  type MigrationLock,
  type MigrationLockV2,
  parseMigrationLock,
  serializeMigrationLock,
  validateMigrationLock,
} from '../src/migration-lock';

function sha256(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function cumulativeMigrations(count: number): MigrationInput[] {
  const migrations: MigrationInput[] = [
    {
      name: '0001_initial',
      sql: 'CREATE TABLE items (id TEXT PRIMARY KEY, value_1 TEXT);\n',
    },
  ];
  for (let index = 2; index <= count; index++) {
    migrations.push({
      name: `${String(index).padStart(4, '0')}_add_value_${index}`,
      sql: `ALTER TABLE items ADD COLUMN value_${index} TEXT;\n`,
    });
  }
  return migrations;
}

describe('compact immutable migration lock', () => {
  test('100 cumulative migrations grow linearly instead of repeating every schema snapshot', () => {
    const fifty = cumulativeMigrations(50);
    const hundred = cumulativeMigrations(100);
    const compactFifty = serializeMigrationLock(buildMigrationLock(fifty));
    const compactHundred = serializeMigrationLock(buildMigrationLock(hundred));
    const legacyHundred = serializeMigrationLock(
      buildMigrationLock(hundred, LEGACY_MIGRATION_LOCK_FORMAT_VERSION),
    );

    expect(JSON.parse(compactHundred).migrations).toHaveLength(100);
    expect(JSON.parse(compactHundred).head.tables[0].columns).toHaveLength(101);
    expect(compactHundred.length).toBeLessThan(compactFifty.length * 2.5);
    expect(compactHundred.length).toBeLessThan(legacyHundred.length / 10);
    expect(serializeMigrationLock(parseMigrationLock(compactHundred))).toBe(
      compactHundred,
    );
  });

  test('locked history replays checks adopted after it deployed; appended migrations enforce them', () => {
    // This history locked before the nullable-ADD-COLUMN and ASCII rules
    // existed, so replaying it must keep succeeding forever.
    const migrations: MigrationInput[] = [
      {
        name: '0001_initial',
        sql: 'CREATE TABLE items (id TEXT PRIMARY KEY);\n',
      },
      {
        name: '0002_required_kind',
        sql: 'ALTER TABLE items ADD COLUMN kind TEXT NOT NULL;\n',
      },
    ];
    const locked: MigrationLock = {
      formatVersion: 2,
      migrations: migrations.map((migration) => ({
        name: migration.name,
        sha256: sha256(migration.sql),
      })),
      head: {
        tables: [
          {
            name: 'items',
            primaryKey: 'id',
            columns: [
              { name: 'id', type: 'string', nullable: false },
              { name: 'kind', type: 'string', nullable: false },
            ],
          },
        ],
      },
    };
    expect(() => validateMigrationLock(locked, migrations)).not.toThrow();

    const appended: MigrationInput[] = [
      ...migrations,
      {
        name: '0003_more',
        sql: 'ALTER TABLE items ADD COLUMN extra TEXT NOT NULL;\n',
      },
    ];
    expect(() => validateMigrationLock(locked, appended)).toThrow(
      'added column "extra" must be nullable',
    );
  });

  test('head snapshots sort tables by code point for byte-determinism', () => {
    const lock = buildMigrationLock([
      {
        name: '0001_initial',
        sql: 'CREATE TABLE Zebra (id TEXT PRIMARY KEY);\nCREATE TABLE apple (id TEXT PRIMARY KEY);\n',
      },
    ]) as MigrationLockV2;
    // Code-point order puts ASCII uppercase ahead of lowercase.
    expect(lock.head.tables.map((table) => table.name)).toEqual([
      'Zebra',
      'apple',
    ]);
  });

  test('format 2 fails structurally when its canonical head is absent', () => {
    expect(() =>
      parseMigrationLock(
        JSON.stringify({
          formatVersion: 2,
          migrations: [
            {
              name: '0001_initial',
              sha256: 'a'.repeat(64),
            },
          ],
        }),
      ),
    ).toThrow('head must be an object');
  });
});
