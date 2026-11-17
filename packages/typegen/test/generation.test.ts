/**
 * §7.4.3 table generations: a table keeps its generation across a schema
 * version when no migration names it and its declaration is unchanged; any
 * change to its shape, scopes, indexes, or a migration naming it bumps it.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildIr,
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

  test('an index change bumps the generation', () => {
    const ir = build('CREATE INDEX idx_notes_shelf ON notes (shelf_id)');
    expect(generations(ir).notes).not.toBe(BASE.notes);
    const dropped = build(
      'CREATE INDEX idx_notes_body ON notes (body); DROP INDEX idx_notes_body',
    );
    expect(generations(dropped).notes).not.toBe(BASE.notes);
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
