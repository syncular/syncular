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

    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Typhoid fever')`,
    );
    expect(search(db, 'typhoid')).toEqual(['c2']);

    // REPLACE is intentionally covered: the stable source-key cleanup does
    // not depend on SQLite firing DELETE triggers for REPLACE.
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Paratyphoid')`,
    );
    expect(search(db, '"typhoid fever"')).toEqual([]);
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
    ensureLocalSchema(db, compiled);
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
