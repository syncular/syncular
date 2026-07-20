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

/**
 * Raw projection hits WITHOUT the source-table join, so an orphaned entry
 * for a REPLACE-displaced row (a ghost) is visible to the assertion.
 */
function rawFtsHits(db: BunClientDatabase, query: string): string[] {
  return db
    .query(
      `SELECT _syncular_source_id AS sid FROM catalogue_codes_fts
       WHERE catalogue_codes_fts MATCH ? ORDER BY sid`,
      [query],
    )
    .map((row) => String(row.sid));
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

  test('REPLACE displacing a different-PK row via a secondary unique index leaves no ghost hit', () => {
    const schema: ClientSchema = {
      version: 1,
      tables: [
        {
          ...(SCHEMA.tables[0] as NonNullable<(typeof SCHEMA.tables)[0]>),
          indexes: [
            {
              name: 'catalogue_codes_code_unique',
              columns: ['code'],
              unique: true,
            },
          ],
        },
      ],
    };
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compileClientSchema(schema));
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Typhoid')`,
    );
    // Different PK, same unique `code`: REPLACE displaces c1 without firing
    // a DELETE trigger for it. The BEFORE INSERT guard cleans its FTS entry.
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c9', 'r1', 'A01', 'Smallpox')`,
    );
    expect(
      db.query(`SELECT id FROM catalogue_codes ORDER BY id`).map((r) => r.id),
    ).toEqual(['c2', 'c9']);
    expect(rawFtsHits(db, 'cholera')).toEqual([]);
    expect(rawFtsHits(db, 'smallpox')).toEqual(['c9']);
    expect(search(db, 'typhoid')).toEqual(['c2']);

    // One REPLACE displacing through BOTH paths at once: pk c2 plus c9's
    // unique code. Both projection entries are cleaned.
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'A01', 'Measles')`,
    );
    expect(
      db.query(`SELECT id FROM catalogue_codes ORDER BY id`).map((r) => r.id),
    ).toEqual(['c2']);
    expect(rawFtsHits(db, 'typhoid')).toEqual([]);
    expect(rawFtsHits(db, 'smallpox')).toEqual([]);
    expect(search(db, 'measles')).toEqual(['c2']);
  });

  test('multi-column unique displacement cleans exactly the displaced row', () => {
    const schema: ClientSchema = {
      version: 1,
      tables: [
        {
          ...(SCHEMA.tables[0] as NonNullable<(typeof SCHEMA.tables)[0]>),
          indexes: [
            {
              name: 'catalogue_codes_release_code_unique',
              columns: ['release_id', 'code'],
              unique: true,
            },
          ],
        },
      ],
    };
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compileClientSchema(schema));
    // Same code in two releases coexists under the composite unique key.
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r2', 'A01', 'Typhoid')`,
    );
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c9', 'r1', 'A01', 'Smallpox')`,
    );
    expect(
      db.query(`SELECT id FROM catalogue_codes ORDER BY id`).map((r) => r.id),
    ).toEqual(['c2', 'c9']);
    expect(rawFtsHits(db, 'cholera')).toEqual([]);
    // The r2 row matches only one of the two unique columns and survives.
    expect(search(db, 'typhoid')).toEqual(['c2']);
    expect(search(db, 'smallpox')).toEqual(['c9']);
  });

  test('reopening an upgraded database regenerates the unique-aware guard', () => {
    const schema: ClientSchema = {
      version: 1,
      tables: [
        {
          ...(SCHEMA.tables[0] as NonNullable<(typeof SCHEMA.tables)[0]>),
          indexes: [
            {
              name: 'catalogue_codes_code_unique',
              columns: ['code'],
              unique: true,
            },
          ],
        },
      ],
    };
    const compiled = compileClientSchema(schema);
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compiled);
    // Simulate a database written by the pk-only guard generation.
    db.exec('DROP TRIGGER catalogue_codes_fts_bi');
    db.exec(
      `CREATE TRIGGER catalogue_codes_fts_bi BEFORE INSERT ON catalogue_codes
       WHEN EXISTS (SELECT 1 FROM catalogue_codes WHERE id = new.id) BEGIN
         DELETE FROM catalogue_codes_fts WHERE _syncular_source_id = CAST(new.id AS TEXT);
       END`,
    );
    // Every open re-ensures the schema, which drops and recreates the
    // triggers — the upgraded database picks up the unique-aware guard.
    ensureLocalSchema(db, compiled);
    const guard = String(
      db.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_bi'",
      )[0]?.sql,
    );
    expect(guard).toContain('IN (SELECT');
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c9', 'r1', 'A01', 'Smallpox')`,
    );
    expect(rawFtsHits(db, 'cholera')).toEqual([]);
    expect(search(db, 'smallpox')).toEqual(['c9']);
  });

  test('UPDATE OR REPLACE displacing a different-PK row leaves no ghost hit', () => {
    const UNIQUE_SCHEMA: ClientSchema = {
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
          indexes: [
            { name: 'catalogue_codes_code', columns: ['code'], unique: true },
          ],
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
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compileClientSchema(UNIQUE_SCHEMA));

    // The migration recreates the BEFORE UPDATE guard for the unique index.
    expect(
      db.query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='catalogue_codes_fts_bu'",
      ),
    ).toHaveLength(1);

    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Typhoid fever')`,
    );
    expect(search(db, 'cholera')).toEqual(['c1']);
    expect(search(db, '"typhoid fever"')).toEqual(['c2']);

    // Moving c2's code onto c1's unique 'A01' displaces c1 via the unique
    // index (OR REPLACE deletes c1). c1's projection entry must go with it.
    db.exec(
      `UPDATE OR REPLACE catalogue_codes SET code='A01', title='Merged entry' WHERE id='c2'`,
    );

    expect(db.query('SELECT id FROM catalogue_codes ORDER BY id')).toEqual([
      { id: 'c2' },
    ]);
    // No ghost: c1's old text is no longer searchable.
    expect(search(db, 'cholera')).toEqual([]);
    expect(search(db, '"typhoid fever"')).toEqual([]);
    // c2 reflects its new values exactly once.
    expect(search(db, 'merged')).toEqual(['c2']);
    expect(search(db, 'A01')).toEqual(['c2']);
    // The projection has exactly one row (no orphaned c1 entry).
    expect(
      db.query('SELECT COUNT(*) AS n FROM catalogue_codes_fts')[0]?.n,
    ).toBe(1);
  });

  test('clean bulk inserts do not scan the growing FTS projection', () => {
    // The scanning control arm is O(rows^2) by construction; 1,500 rows keeps
    // it near two seconds (a decisive >3x margin over the linear clean arm)
    // while staying well under the harness deadline.
    const rows = 1_500;
    const bulkInsertMs = (db: BunClientDatabase): number => {
      const insert = db.db.query(
        'INSERT INTO catalogue_codes(id, release_id, code, title) VALUES (?, ?, ?, ?)',
      );
      const startedAt = performance.now();
      db.transaction(() => {
        for (let index = 0; index < rows; index += 1) {
          insert.run(
            `c${index}`,
            'r1',
            `C${String(index).padStart(5, '0')}`,
            `Synthetic title ${index}`,
          );
        }
      });
      return performance.now() - startedAt;
    };

    const clean = new BunClientDatabase();
    ensureLocalSchema(clean, compileClientSchema(SCHEMA));
    const cleanMs = bulkInsertMs(clean);
    expect(search(clean, '"synthetic" "1499"')).toEqual(['c1499']);

    // Comparative bound: an insert trigger that deletes by source id scans
    // the whole projection per row. The clean triggers must stay decisively
    // faster than that hazard on the same machine — a wall-clock cap here
    // would flake on loaded CI.
    const scanning = new BunClientDatabase();
    ensureLocalSchema(scanning, compileClientSchema(SCHEMA));
    scanning.exec('DROP TRIGGER catalogue_codes_fts_ai');
    scanning.exec(
      `CREATE TRIGGER catalogue_codes_fts_ai AFTER INSERT ON catalogue_codes BEGIN
        DELETE FROM catalogue_codes_fts WHERE _syncular_source_id = CAST(new.id AS TEXT);
        INSERT INTO catalogue_codes_fts (_syncular_source_id, code, title)
          VALUES (CAST(new.id AS TEXT), new.code, new.title);
      END`,
    );
    const scanningMs = bulkInsertMs(scanning);
    expect(cleanMs * 3).toBeLessThan(scanningMs);
  }, 20_000);

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
