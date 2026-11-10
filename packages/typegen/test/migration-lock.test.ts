import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { MigrationInput } from '../src/generate';
import type { ManifestSchemaVersion } from '../src/manifest';
import {
  buildMigrationLock,
  type LegacyMigrationLock,
  type MigrationLock,
  parseMigrationLock,
  serializeMigrationLock,
  updateMigrationLock,
  upgradeMigrationLock,
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

/** One schema version per migration, numbered from 1. */
function versionPerMigration(
  migrations: readonly MigrationInput[],
): ManifestSchemaVersion[] {
  return migrations.map((migration, index) => ({
    version: index + 1,
    through: migration.name,
  }));
}

const INITIAL: MigrationInput = {
  name: '0001_initial',
  sql: 'CREATE TABLE items (id TEXT PRIMARY KEY);\n',
};
const ADD_KIND: MigrationInput = {
  name: '0002_add_kind',
  sql: 'ALTER TABLE items ADD COLUMN kind TEXT;\n',
};

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('immutable migration lock', () => {
  test('100 cumulative migrations grow linearly instead of repeating every schema snapshot', () => {
    const fifty = cumulativeMigrations(50);
    const hundred = cumulativeMigrations(100);
    const compactFifty = serializeMigrationLock(
      buildMigrationLock(fifty, versionPerMigration(fifty)),
    );
    const compactHundred = serializeMigrationLock(
      buildMigrationLock(hundred, versionPerMigration(hundred)),
    );

    expect(JSON.parse(compactHundred).migrations).toHaveLength(100);
    expect(JSON.parse(compactHundred).head.tables[0].columns).toHaveLength(101);
    expect(compactHundred.length).toBeLessThan(compactFifty.length * 2.5);
    const parsed = parseMigrationLock(compactHundred);
    if (parsed.formatVersion !== 3) throw new Error('expected format 3');
    expect(serializeMigrationLock(parsed)).toBe(compactHundred);
  });

  test('locked history replays checks adopted after it deployed; appended migrations enforce them', () => {
    // This history locked before the nullable-ADD-COLUMN and ASCII rules
    // existed, so replaying it must keep succeeding forever.
    const migrations: MigrationInput[] = [
      INITIAL,
      {
        name: '0002_required_kind',
        sql: 'ALTER TABLE items ADD COLUMN kind TEXT NOT NULL;\n',
      },
    ];
    const locked: MigrationLock = {
      formatVersion: 3,
      migrations: migrations.map((migration) => ({
        name: migration.name,
        sha256: sha256(migration.sql),
        schemaVersion: 1,
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
    const v1 = { version: 1, through: '0002_required_kind' };
    expect(() => updateMigrationLock(locked, migrations, [v1])).not.toThrow();

    const appended: MigrationInput[] = [
      ...migrations,
      {
        name: '0003_more',
        sql: 'ALTER TABLE items ADD COLUMN extra TEXT NOT NULL;\n',
      },
    ];
    expect(() =>
      updateMigrationLock(locked, appended, [
        v1,
        { version: 2, through: '0003_more' },
      ]),
    ).toThrow('added column "extra" must be nullable');
  });

  test('head snapshots sort tables by code point for byte-determinism', () => {
    const lock = buildMigrationLock(
      [
        {
          name: '0001_initial',
          sql: 'CREATE TABLE Zebra (id TEXT PRIMARY KEY);\nCREATE TABLE apple (id TEXT PRIMARY KEY);\n',
        },
      ],
      [{ version: 1, through: '0001_initial' }],
    );
    // Code-point order puts ASCII uppercase ahead of lowercase.
    expect(lock.head.tables.map((table) => table.name)).toEqual([
      'Zebra',
      'apple',
    ]);
  });

  test('format 3 fails structurally when its canonical head is absent', () => {
    expect(() =>
      parseMigrationLock(
        JSON.stringify({
          formatVersion: 3,
          migrations: [
            {
              name: '0001_initial',
              sha256: 'a'.repeat(64),
              schemaVersion: 1,
            },
          ],
        }),
      ),
    ).toThrow('head must be an object');
  });

  test('format 3 records the schema version of every migration', () => {
    const lock = buildMigrationLock(
      [INITIAL, ADD_KIND],
      [
        { version: 1, through: '0001_initial' },
        { version: 4, through: '0002_add_kind' },
      ],
    );
    expect(
      lock.migrations.map(({ name, schemaVersion }) => [name, schemaVersion]),
    ).toEqual([
      ['0001_initial', 1],
      ['0002_add_kind', 4],
    ]);
  });
});

describe('locked schema versions (§7.4)', () => {
  const locked = buildMigrationLock(
    [INITIAL],
    [{ version: 1, through: '0001_initial' }],
  );

  test('an appended migration cannot join a locked schema version', () => {
    const error = thrown(() =>
      updateMigrationLock(
        locked,
        [INITIAL, ADD_KIND],
        [{ version: 1, through: '0002_add_kind' }],
      ),
    );
    expect(error).toMatchObject({
      code: 'typegen.schema_version_locked',
      details: {
        migration: '0002_add_kind',
        schemaVersion: 1,
        highestLockedVersion: 1,
      },
    });
  });

  test('an appended migration in a new schema version is locked with it', () => {
    const next = updateMigrationLock(
      locked,
      [INITIAL, ADD_KIND],
      [
        { version: 1, through: '0001_initial' },
        { version: 2, through: '0002_add_kind' },
      ],
    );
    expect(next.migrations.map((m) => m.schemaVersion)).toEqual([1, 2]);
  });

  test('a locked migration cannot move to another schema version', () => {
    const error = thrown(() =>
      updateMigrationLock(
        locked,
        [INITIAL],
        [{ version: 2, through: '0001_initial' }],
      ),
    );
    expect(error).toMatchObject({
      code: 'typegen.migration_version_changed',
      details: {
        migration: '0001_initial',
        lockedVersion: 1,
        schemaVersion: 2,
      },
    });
  });

  test('generation refuses a lock without schema versions', () => {
    const legacy: LegacyMigrationLock = {
      formatVersion: 2,
      migrations: [{ name: INITIAL.name, sha256: sha256(INITIAL.sql) }],
    };
    const error = thrown(() =>
      updateMigrationLock(
        legacy,
        [INITIAL],
        [{ version: 1, through: '0001_initial' }],
      ),
    );
    expect(error).toMatchObject({
      code: 'typegen.migration_lock_outdated',
      details: { formatVersion: 2 },
    });
  });

  test('upgrading a legacy lock records versions for the locked prefix only', () => {
    const legacy = parseMigrationLock(
      JSON.stringify({
        formatVersion: 1,
        migrations: [
          { name: INITIAL.name, sha256: sha256(INITIAL.sql), tables: [] },
        ],
      }),
    );
    if (legacy.formatVersion === 3) throw new Error('expected a legacy lock');
    const upgraded = upgradeMigrationLock(
      legacy,
      [INITIAL, ADD_KIND],
      [
        { version: 1, through: '0001_initial' },
        { version: 2, through: '0002_add_kind' },
      ],
    );
    expect(upgraded).toEqual(locked);
  });
});
