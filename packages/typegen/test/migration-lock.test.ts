import { describe, expect, test } from 'bun:test';
import type { MigrationInput } from '../src/generate';
import {
  buildMigrationLock,
  LEGACY_MIGRATION_LOCK_FORMAT_VERSION,
  parseMigrationLock,
  serializeMigrationLock,
} from '../src/migration-lock';

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
