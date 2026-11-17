/**
 * §5.11 typegen: `encryptedColumns` flips the wire type to `bytes` and
 * records `encrypted` + `declaredType` in the IR; the hard generate-time
 * errors (encrypted scope/crdt/pk/unknown column) fire.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  analyzeQueries,
  buildIr,
  checkOutputs,
  generate,
  type Manifest,
  type MigrationInput,
  parseManifest,
  TypegenError,
} from '../src';

const MIGRATIONS: MigrationInput[] = [
  {
    name: '0001_initial',
    sql: `CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      body TEXT NOT NULL,
      amount INTEGER,
      doc CRDT
    )`,
  },
];

function manifest(encryptedColumns: string[]): Manifest {
  return parseManifest({
    manifestVersion: 1,
    schemaVersions: [{ version: 1, through: '0001_initial' }],
    tables: [
      {
        name: 'notes',
        scopes: ['project:{project_id}'],
        encryptedColumns,
      },
    ],
  });
}

function expectFail(fn: () => unknown, pattern: RegExp): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TypegenError);
  expect((error as TypegenError).message).toMatch(pattern);
}

describe('§5.11 encryptedColumns → IR', () => {
  test('flips wire type to bytes, records encrypted + declaredType', () => {
    const ir = buildIr(manifest(['body', 'amount']), MIGRATIONS);
    const notes = ir.tables.find((t) => t.name === 'notes');
    const body = notes?.columns.find((c) => c.name === 'body');
    const amount = notes?.columns.find((c) => c.name === 'amount');
    expect(body?.type).toBe('bytes');
    expect(body?.encrypted).toBe(true);
    expect(body?.declaredType).toBe('string');
    expect(amount?.type).toBe('bytes');
    expect(amount?.encrypted).toBe(true);
    expect(amount?.declaredType).toBe('integer');
    // a non-encrypted column is untouched
    const project = notes?.columns.find((c) => c.name === 'project_id');
    expect(project?.type).toBe('string');
    expect(project?.encrypted).toBeUndefined();
  });

  test('no encryptedColumns ⇒ byte-identical IR (no metadata)', () => {
    const ir = buildIr(manifest([]), MIGRATIONS);
    const body = ir.tables[0]?.columns.find((c) => c.name === 'body');
    expect(body?.type).toBe('string');
    expect(body?.encrypted).toBeUndefined();
    expect(body?.declaredType).toBeUndefined();
  });

  test('named queries expose decrypted app types, nullable for a sealed row', () => {
    const ir = buildIr(manifest(['body', 'amount']), MIGRATIONS);
    const [query] = analyzeQueries(ir, [
      {
        file: 'encrypted-note.sql',
        sql: 'SELECT id, body, amount FROM notes WHERE id = :id',
      },
    ]);
    expect(query?.columns).toMatchObject([
      { name: 'id', type: 'string', nullable: false, fidelity: 'exact' },
      { name: 'body', type: 'string', nullable: true, fidelity: 'exact' },
      { name: 'amount', type: 'integer', nullable: true, fidelity: 'exact' },
    ]);
  });

  test('binds compared to encrypted columns use decrypted application types', () => {
    const ir = buildIr(manifest(['body', 'amount']), MIGRATIONS);
    const [query] = analyzeQueries(ir, [
      {
        file: 'encrypted-note-lookup.sql',
        sql: `-- allow scan notes: an encrypted column cannot carry an index
SELECT id FROM notes WHERE body = :body AND amount = :amount`,
      },
    ]);
    expect(query?.params).toMatchObject([
      { name: 'body', type: 'string', source: 'inferred' },
      { name: 'amount', type: 'integer', source: 'inferred' },
    ]);
  });

  test('encrypted declared strings remain eligible for client-local FTS', () => {
    const migrations: MigrationInput[] = [
      {
        ...MIGRATIONS[0]!,
        sql: `${MIGRATIONS[0]!.sql};
          CREATE VIRTUAL TABLE notes_fts USING fts5(
            body,
            content=notes,
            tokenize='unicode61 remove_diacritics 2'
          )`,
      },
    ];
    const ir = buildIr(manifest(['body']), migrations);
    expect(ir.tables[0]?.ftsIndexes).toEqual([
      {
        name: 'notes_fts',
        columns: ['body'],
        tokenize: 'unicode61 remove_diacritics 2',
      },
    ]);
  });

  test('hard error: unknown column', () => {
    expectFail(
      () => buildIr(manifest(['nope']), MIGRATIONS),
      /encryptedColumns names unknown column "nope"/,
    );
  });

  test('hard error: encrypted primary key', () => {
    expectFail(
      () => buildIr(manifest(['id']), MIGRATIONS),
      /primary key "id" cannot be encrypted/,
    );
  });

  test('hard error: encrypted scope column', () => {
    expectFail(
      () => buildIr(manifest(['project_id']), MIGRATIONS),
      /scope column "project_id" cannot be encrypted/,
    );
  });

  test('hard error: encrypted index column, unique or not', () => {
    for (const unique of ['UNIQUE ', '']) {
      let error: unknown;
      try {
        buildIr(manifest(['body']), [
          {
            name: '0001_initial',
            sql: `${MIGRATIONS[0]?.sql};
            CREATE ${unique}INDEX idx_notes_body ON notes (project_id, body)`,
          },
        ]);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: 'typegen.encrypted_index_column',
        details: { table: 'notes', index: 'idx_notes_body', column: 'body' },
      });
    }
  });

  test('hard error: encrypted crdt column', () => {
    expectFail(
      () => buildIr(manifest(['doc']), MIGRATIONS),
      /crdt column "doc" cannot be encrypted/,
    );
  });
});

describe('§5.11 sealed apply in generated read types', () => {
  const SEALED = join(import.meta.dir, 'fixtures', 'sealed');
  const output = (basename: string): string => {
    const found = generate(SEALED).outputs.find((candidate) =>
      candidate.path.endsWith(`/${basename}`),
    );
    if (found === undefined) throw new Error(`no output ${basename}`);
    return found.content;
  };

  test('the sealed fixture goldens are fresh', () => {
    expect(checkOutputs(generate(SEALED))).toEqual([]);
  });

  test('a NOT NULL encrypted column reads nullable and writes required', () => {
    const module = output('syncular.generated.ts');
    expect(module).toContain(
      'export interface PatientsRow {\n  id: string;\n  clinicId: string;\n  givenNames: string | null;',
    );
    expect(module).toContain(
      'export interface PatientsInsert {\n  id: string;\n  clinicId: string;\n  givenNames: string;',
    );
    expect(module).toContain('  ward: string;\n}');
    expect(output('syncular.queries.ts')).toContain(
      "{ name: 'givenNames', type: 'string', nullable: true }, { name: 'ward', type: 'string', nullable: false }, { name: 'sealedKey', type: 'string', nullable: true }",
    );
    expect(output('syncular.queries.rs')).toContain(
      '        pub given_names: Option<String>,\n        pub ward: String,\n        pub sealed_key: Option<String>,',
    );
    expect(output('Syncular.generated.kt')).toContain(
      '    val givenNames: String?,\n    val notes: String?,\n    val ward: String,',
    );
    expect(output('Syncular.queries.kt')).toContain(
      '    val givenNames: String?,\n    val ward: String,\n    val sealedKey: String?,',
    );
  });

  test('an aliased _sync_sealed_key reads as a nullable string', () => {
    const ir = buildIr(manifest(['body']), MIGRATIONS);
    const [query] = analyzeQueries(ir, [
      {
        file: 'sealed-notes.sql',
        sql: `SELECT id, _sync_sealed_key AS sealed_key FROM notes WHERE _sync_sealed_key IS NOT NULL`,
      },
    ]);
    expect(query?.columns[1]).toMatchObject({
      name: 'sealed_key',
      langName: 'sealedKey',
      type: 'string',
      nullable: true,
      fidelity: 'exact',
    });
    expect(query?.tables).toEqual(['notes']);
  });

  for (const [label, select] of [
    ['un-aliased', '_sync_sealed_key'],
    ['aliased to a _sync_ name', '_sync_sealed_key AS _sync_key'],
  ] as const) {
    test(`an ${label} marker is a reserved result column`, () => {
      const ir = buildIr(manifest(['body']), MIGRATIONS);
      let error: unknown;
      try {
        analyzeQueries(ir, [
          { file: 'q.sql', sql: `SELECT id, ${select} FROM notes` },
        ]);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypegenError);
      expect(error).toMatchObject({ code: 'typegen.reserved_result_column' });
    });
  }

  test('the marker on a table without encrypted columns fails', () => {
    const ir = buildIr(manifest([]), MIGRATIONS);
    let error: unknown;
    try {
      analyzeQueries(ir, [
        {
          file: 'q.sql',
          sql: 'SELECT n.id FROM notes AS n WHERE n._sync_sealed_key IS NULL',
        },
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'typegen.sealed_key_unencrypted',
      details: { query: 'q' },
    });
    expect(() =>
      analyzeQueries(ir, [
        {
          file: 'q.syql',
          sql: 'query q() { select id, _sync_sealed_key as sealed_key from notes; }',
        },
      ]),
    ).toThrow(
      /_sync_sealed_key` exists only on a table with an encrypted column/,
    );
  });
});
