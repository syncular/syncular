/** RFC 0005 client-local FTS5 projections. */
import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  compileClientSchema,
  dropAndRecreateSyncedTables,
  ensureLocalSchema,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';

const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'catalogue_codes',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'release_id', type: 'string', nullable: false },
        { name: 'code', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['release:{release_id}'],
      ftsIndexes: [
        {
          name: 'catalogue_codes_fts',
          columns: ['code', 'title'],
          tokenize: 'unicode61 remove_diacritics 2',
        },
      ],
    },
  ],
};

function search(db: BunClientDatabase, query: string): string[] {
  return db
    .query(
      `SELECT c.id FROM catalogue_codes_fts f
       JOIN catalogue_codes c
         ON CAST(c.id AS TEXT) = f._syncular_source_id
       WHERE catalogue_codes_fts MATCH ? ORDER BY c.id`,
      [query],
    )
    .map((row) => String(row.id));
}

describe('RFC 0005 local FTS5 projections', () => {
  test('initial build and insert/update/delete stay transactionally current', () => {
    const db = new BunClientDatabase();
    const compiled = compileClientSchema(SCHEMA);
    // Simulate content created before a newly-added projection is ensured.
    db.exec(
      `CREATE TABLE catalogue_codes(id TEXT PRIMARY KEY, release_id TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, _sync_version INTEGER NOT NULL DEFAULT 0)`,
    );
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    ensureLocalSchema(db, compiled);
    expect(search(db, 'cholera')).toEqual(['c1']);

    const insertTrigger = db.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_ai'",
    )[0]?.sql;
    const replaceGuard = db.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_bi'",
    )[0]?.sql;
    expect(String(insertTrigger)).not.toContain('DELETE FROM');
    expect(String(replaceGuard)).toContain('BEFORE INSERT');
    expect(String(replaceGuard)).toContain('WHEN EXISTS');

    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Typhoid fever')`,
    );
    expect(search(db, 'typhoid')).toEqual(['c2']);

    // REPLACE is intentionally covered: the indexed BEFORE INSERT guard owns
    // cleanup without scanning FTS for every clean insert or depending on
    // SQLite firing DELETE triggers for REPLACE.
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Paratyphoid')`,
    );
    expect(search(db, '"typhoid fever"')).toEqual([]);
    expect(search(db, 'paratyphoid')).toEqual(['c2']);

    expect(() =>
      db.exec(
        `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Must fail')`,
      ),
    ).toThrow();
    expect(search(db, 'paratyphoid')).toEqual(['c2']);

    db.exec(
      `UPDATE catalogue_codes SET title='Enteric infection' WHERE id='c2'`,
    );
    expect(search(db, 'paratyphoid')).toEqual([]);
    expect(search(db, 'enteric')).toEqual(['c2']);

    db.exec(`DELETE FROM catalogue_codes WHERE id='c2'`);
    expect(search(db, 'enteric')).toEqual([]);
  });

  test('ensure is idempotent and schema reset recreates a working projection', () => {
    const db = new BunClientDatabase();
    const compiled = compileClientSchema(SCHEMA);
    ensureLocalSchema(db, compiled);
    db.exec('DROP TRIGGER catalogue_codes_fts_bi');
    db.exec('DROP TRIGGER catalogue_codes_fts_ai');
    db.exec(
      `CREATE TRIGGER catalogue_codes_fts_ai AFTER INSERT ON catalogue_codes BEGIN
        DELETE FROM catalogue_codes_fts WHERE _syncular_source_id = CAST(new.id AS TEXT);
        INSERT INTO catalogue_codes_fts (_syncular_source_id, code, title)
          VALUES (CAST(new.id AS TEXT), new.code, new.title);
      END`,
    );
    ensureLocalSchema(db, compiled);
    expect(
      String(
        db.query(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_ai'",
        )[0]?.sql,
      ),
    ).not.toContain('DELETE FROM');
    expect(
      db.query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_bi'",
      ),
    ).toHaveLength(1);
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    expect(search(db, 'cholera')).toEqual(['c1']);
    db.transaction(() => dropAndRecreateSyncedTables(db, compiled));
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Typhoid')`,
    );
    expect(search(db, 'typhoid')).toEqual(['c2']);
  });

  test('clean bulk inserts do not scan the growing FTS projection', () => {
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compileClientSchema(SCHEMA));
    const insert = db.db.query(
      'INSERT INTO catalogue_codes(id, release_id, code, title) VALUES (?, ?, ?, ?)',
    );
    const startedAt = performance.now();
    db.transaction(() => {
      for (let index = 0; index < 20_000; index += 1) {
        insert.run(
          `c${index}`,
          'r1',
          `C${String(index).padStart(5, '0')}`,
          `Synthetic title ${index}`,
        );
      }
    });
    const elapsedMs = performance.now() - startedAt;
    expect(search(db, '"synthetic" "19999"')).toEqual(['c19999']);
    expect(elapsedMs).toBeLessThan(2_500);
  });

  test('encrypted declared-string columns feed only the local plaintext projection', () => {
    const table = SCHEMA.tables[0];
    if (table === undefined) throw new Error('fixture table missing');
    const encrypted: ClientSchema = {
      version: 1,
      tables: [
        {
          ...table,
          columns: table.columns.map((column) =>
            column.name === 'title'
              ? {
                  ...column,
                  type: 'bytes' as const,
                  encrypted: true,
                  declaredType: 'string' as const,
                }
              : column,
          ),
        },
      ],
    };
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compileClientSchema(encrypted));
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Encrypted local identity')`,
    );
    expect(search(db, 'identity')).toEqual(['c1']);
  });

  test('compile fails loudly for unsafe or unsupported definitions', () => {
    const table = SCHEMA.tables[0];
    if (table === undefined) throw new Error('fixture table missing');
    const withFts = (ftsIndexes: NonNullable<typeof table.ftsIndexes>) =>
      compileClientSchema({
        version: 1,
        tables: [{ ...table, ftsIndexes }],
      });
    expect(() =>
      withFts([
        { name: 'bad', columns: ['release_id', 'nope'], tokenize: 'unicode61' },
      ]),
    ).toThrow(/unknown column "nope"/);
    expect(() =>
      withFts([{ name: 'bad', columns: ['title'], tokenize: 'custom' }]),
    ).toThrow(/not allowlisted/);
  });
});
