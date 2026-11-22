/**
 * §7.4.3 table generations: a table keeps its generation across a schema
 * version when no migration names it and its declaration is unchanged; any
 * change to its shape or scopes, or a migration naming it, bumps it. Index
 * and FTS5 projection statements name no table.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  buildIr,
  generate,
  type IrDocument,
  type MigrationInput,
  parseManifest,
  TypegenError,
} from '../src';

const V1: MigrationInput = {
  name: '0001_initial',
  sql: `CREATE TABLE catalog (id TEXT PRIMARY KEY, shelf_id TEXT NOT NULL, title TEXT NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, shelf_id TEXT NOT NULL, body TEXT NOT NULL, owner_id TEXT);`,
};

function build(
  next: string,
  notesScopes: unknown[] = ['shelf:{shelf_id}'],
): IrDocument {
  return buildIr(
    parseManifest({
      manifestVersion: 1,
      schemaVersions: [
        { version: 1, through: '0001_initial' },
        { version: 2, through: '0002_next' },
      ],
      tables: [
        { name: 'catalog', scopes: ['shelf:{shelf_id}'] },
        { name: 'notes', scopes: notesScopes },
      ],
    }),
    [V1, { name: '0002_next', sql: next }],
  );
}

function generations(ir: IrDocument): Record<string, string | undefined> {
  return Object.fromEntries(ir.tables.map((t) => [t.name, t.generation]));
}

const BASE = generations(build('CREATE INDEX idx_notes_body ON notes (body)'));

describe('table generations', () => {
  test('every table carries a 32-hex generation', () => {
    for (const generation of Object.values(BASE))
      expect(generation).toMatch(/^[0-9a-f]{32}$/);
  });

  test('a table no migration names keeps its generation', () => {
    const ir = build('ALTER TABLE notes ADD COLUMN pinned BOOLEAN');
    expect(generations(ir).catalog).toBe(BASE.catalog);
    expect(generations(ir).notes).not.toBe(BASE.notes);
  });

  test('a column change bumps the generation', () => {
    const ir = build('ALTER TABLE catalog ADD COLUMN price REAL');
    expect(generations(ir).catalog).not.toBe(BASE.catalog);
  });

  test('a scope change bumps the generation', () => {
    const ir = build('CREATE INDEX idx_notes_body ON notes (body)', [
      'shelf:{shelf_id}',
      'owner:{owner_id}',
    ]);
    expect(generations(ir).notes).not.toBe(BASE.notes);
    expect(generations(ir).catalog).toBe(BASE.catalog);
  });

  test('an index change keeps the generation', () => {
    // Declared indexes reconcile in place: an index-only migration names no
    // table and the index list stays out of the hash.
    const ir = build('CREATE UNIQUE INDEX idx_notes_shelf ON notes (shelf_id)');
    expect(generations(ir)).toEqual(BASE);
    expect(ir.tables[1]?.indexes).toEqual([
      { name: 'idx_notes_shelf', columns: ['shelf_id'], unique: true },
    ]);
    const dropped = build(
      'CREATE INDEX idx_notes_body ON notes (body); DROP INDEX idx_notes_body',
    );
    expect(generations(dropped)).toEqual(BASE);
    expect(dropped.tables[1]?.indexes).toEqual([]);
  });

  test('an fts5 migration becomes a built-in projection and keeps the generation', () => {
    const ir = build(
      "CREATE VIRTUAL TABLE notes_fts USING fts5(body, content = notes, tokenize = 'porter unicode61')",
    );
    expect(generations(ir)).toEqual(BASE);
    expect(ir.tables[1]?.localProjections).toEqual([
      {
        name: 'notes_fts',
        generation: expect.stringMatching(/^[0-9a-f]{32}$/),
        columns: [{ name: 'body', declaredType: 'string', source: 'body' }],
        fts: { tokenize: 'porter unicode61', columns: ['body'] },
      },
    ]);
  });

  test('in a mixed migration the ALTER changes the generation and the index does not', () => {
    const altered = build('ALTER TABLE notes ADD COLUMN pinned BOOLEAN');
    const mixed = build(
      'ALTER TABLE notes ADD COLUMN pinned BOOLEAN; CREATE INDEX idx_notes_pinned ON notes (pinned); CREATE INDEX idx_catalog_title ON catalog (title)',
    );
    expect(generations(mixed).notes).not.toBe(BASE.notes);
    expect(generations(mixed).notes).toBe(generations(altered).notes);
    expect(generations(mixed).catalog).toBe(BASE.catalog);
    expect(
      mixed.tables.map((table) => table.indexes.map((i) => i.name)),
    ).toEqual([['idx_catalog_title'], ['idx_notes_pinned']]);
  });

  test('a migration that names a table without changing it bumps it', () => {
    const ir = build(
      'CREATE INDEX idx_notes_body ON notes (body); ALTER TABLE notes ADD COLUMN catalog TEXT',
    );
    // `catalog` appears as a column name: the attribution is token-based and
    // errs toward a reset.
    expect(generations(ir).catalog).not.toBe(BASE.catalog);
  });

  test('a migration that only UPDATEs a table is refused, so it never keeps rows', () => {
    expect(() =>
      build("UPDATE catalog SET title = 'x' WHERE shelf_id = 's1'"),
    ).toThrow(TypegenError);
  });
});

test('0.102.0 changed the 0.101.0 generation of exactly the tables with an index or FTS', () => {
  // The golden fixtures' generations as typegen 0.101.0 emitted them.
  const released: Record<string, string> = {
    tasks: '243810361624f6ed9d828938a22f4429',
    docs: '71fd58d27b5d1b5388ce8888473f8e1d',
    doc_revisions: 'd9a19878f3172c1072258fe4dd071a37',
    patients: '14985731ce0d72ecf985becf53831183',
  };
  const tables = ['basic', 'sealed'].flatMap(
    (fixture) => generate(join(import.meta.dir, 'fixtures', fixture)).ir.tables,
  );
  expect(tables.map((table) => table.name).sort()).toEqual(
    Object.keys(released).sort(),
  );
  for (const table of tables)
    expect([table.name, table.generation !== released[table.name]]).toEqual([
      table.name,
      table.indexes.length > 0 || (table.localProjections?.length ?? 0) > 0,
    ]);
});
