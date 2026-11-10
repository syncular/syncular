/**
 * The pinned naming map: snake→camel vectors,
 * collision/keyword/Dart-underscore hard errors, the "preserve" identity —
 * and the §5 projection lowering that makes runtime keys the language names
 * (AS-aliasing, star expansion, author-alias respect).
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  analyzeQuery,
  buildIr,
  buildNamingMap,
  buildRustNamingMap,
  type IrDocument,
  parseManifest,
  type QueryDb,
  rustPascalCase,
  rustSnakeCase,
  serializeQueryIr,
  snakeToCamel,
  synthesizeDdl,
  validateSchemaIdentifiers,
} from '../src';

describe('snakeToCamel — the pinned §12 algorithm', () => {
  const VECTORS: readonly [string, string][] = [
    ['created_at', 'createdAt'],
    ['col_2', 'col2'],
    ['user_id', 'userId'],
    ['_internal', '_internal'],
    ['__foo_bar', '__fooBar'],
    ['row_', 'row_'],
    ['id_url', 'idUrl'], // no acronym awareness
    ['api_key', 'apiKey'],
    ['title', 'title'], // single word: identity
    ['alreadyCamel', 'alreadyCamel'],
    ['a__b', 'aB'], // doubled underscore: empty segment drops
    ['_lead_and_trail_', '_leadAndTrail_'],
    ['count(*)', 'count(*)'], // expression-shaped: pass-through
    ['done + 1', 'done + 1'],
  ];
  for (const [input, expected] of VECTORS) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(snakeToCamel(input)).toBe(expected);
    });
  }
});

describe('Rust naming', () => {
  const VECTORS: readonly [string, string][] = [
    ['createdAt', 'created_at'],
    ['URLValue', 'url_value'],
    ['idURL', 'id_url'],
    ['col2Value', 'col2_value'],
    ['already_snake', 'already_snake'],
    ['a__b', 'a_b'],
    ['__leadAndTrail_', '__lead_and_trail_'],
  ];
  for (const [input, expected] of VECTORS) {
    test(`${input} -> ${expected}`, () => {
      expect(rustSnakeCase(input)).toBe(expected);
    });
  }

  test('generates UpperCamelCase type names', () => {
    expect(rustPascalCase('listTodos')).toBe('ListTodos');
    expect(rustPascalCase('URLValue')).toBe('UrlValue');
  });

  test('rejects Rust keywords and post-conversion collisions', () => {
    expect(() => buildRustNamingMap(['type'], 'q.sql', 'projection')).toThrow(
      /reserved word on the rust target/,
    );
    expect(() =>
      buildRustNamingMap(['fooBar', 'foo_bar'], 'q.sql', 'projection'),
    ).toThrow(/both map to "foo_bar"/);
  });

  test('rejects expression-shaped projection names', () => {
    expect(() =>
      buildRustNamingMap(['count(*)'], 'q.sql', 'projection'),
    ).toThrow(/cannot be emitted as a Rust identifier/);
  });
});

describe('buildNamingMap — §12 hard errors', () => {
  test('two SQL names mapping to one language name is an error', () => {
    expect(() =>
      buildNamingMap(['col_2', 'col2'], 'camel', 'q.sql', 'projection', ['ts']),
    ).toThrow(/both map to "col2"/);
  });
  test('a mapped name hitting a target keyword is an error naming the target', () => {
    expect(() =>
      buildNamingMap(['class'], 'camel', 'q.sql', 'projection', ['dart']),
    ).toThrow(/reserved word on the dart target/);
  });
  test('a keyword on an UNREQUESTED target passes', () => {
    // `val` is a Kotlin keyword but no kotlin output is generated here.
    expect(() =>
      buildNamingMap(['val'], 'camel', 'q.sql', 'projection', ['ts']),
    ).not.toThrow();
  });
  test('a leading underscore on the dart target is an error', () => {
    expect(() =>
      buildNamingMap(['_hidden'], 'camel', 'q.sql', 'projection', ['dart']),
    ).toThrow(/library-private on the dart target/);
  });
  test('"preserve" is the identity map and skips the hazards', () => {
    const map = buildNamingMap(
      ['col_2', 'col2', 'class'],
      'preserve',
      'q.sql',
      'projection',
      ['dart'],
    );
    expect(map).toEqual([
      { sqlName: 'col_2', langName: 'col_2' },
      { sqlName: 'col2', langName: 'col2' },
      { sqlName: 'class', langName: 'class' },
    ]);
  });
});

describe('validateSchemaIdentifiers — every target, every naming mode', () => {
  const tablesOf = (sql: string, names: readonly string[]) =>
    buildIr(
      parseManifest({
        manifestVersion: 1,
        schemaVersions: [{ version: 1, through: '0001_initial' }],
        tables: names.map((name) => ({ name, scopes: ['p:{id}'] })),
      }),
      [{ name: '0001_initial', sql }],
    ).tables;
  const failure = (run: () => void): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  test('tables mapping to one generated type name collide', () => {
    const tables = tablesOf(
      'CREATE TABLE foo_bar (id TEXT PRIMARY KEY); CREATE TABLE foo__bar (id TEXT PRIMARY KEY)',
      ['foo_bar', 'foo__bar'],
    );
    expect(
      failure(() =>
        validateSchemaIdentifiers(tables, 'preserve', ['ts'], 'syncular.json'),
      ),
    ).toMatchObject({
      code: 'typegen.identifier_collision',
      details: { names: ['foo_bar', 'foo__bar'] },
    });
  });

  test('table and column names differing only in case are duplicates', () => {
    const tables = tablesOf(
      'CREATE TABLE Items2 (id TEXT PRIMARY KEY); CREATE TABLE ITEMS2 (id TEXT PRIMARY KEY)',
      ['Items2', 'ITEMS2'],
    );
    expect(
      failure(() =>
        validateSchemaIdentifiers(tables, 'camel', ['ts'], 'syncular.json'),
      ),
    ).toMatchObject({
      code: 'typegen.duplicate_identifier',
      details: { names: ['Items2', 'ITEMS2'] },
    });
    const columns = tablesOf('CREATE TABLE t (id TEXT PRIMARY KEY, ID TEXT)', [
      't',
    ]);
    expect(
      failure(() =>
        validateSchemaIdentifiers(columns, 'camel', ['ts'], 'syncular.json'),
      ),
    ).toMatchObject({
      code: 'typegen.duplicate_identifier',
      details: { table: 't', names: ['id', 'ID'] },
    });
  });

  test('"preserve" still checks native targets, which always emit camelCase', () => {
    const collision = tablesOf(
      'CREATE TABLE t (id TEXT PRIMARY KEY, user_id TEXT, userId TEXT)',
      ['t'],
    );
    expect(() =>
      validateSchemaIdentifiers(collision, 'preserve', ['ts'], 'syncular.json'),
    ).not.toThrow();
    expect(
      failure(() =>
        validateSchemaIdentifiers(
          collision,
          'preserve',
          ['ts', 'swift'],
          'syncular.json',
        ),
      ),
    ).toMatchObject({
      code: 'typegen.identifier_collision',
      details: { target: 'swift', names: ['user_id', 'userId'] },
    });
    const keyword = tablesOf('CREATE TABLE t (id TEXT PRIMARY KEY, fun TEXT)', [
      't',
    ]);
    expect(
      failure(() =>
        validateSchemaIdentifiers(
          keyword,
          'preserve',
          ['ts', 'kotlin'],
          'syncular.json',
        ),
      ),
    ).toMatchObject({
      code: 'typegen.reserved_identifier',
      details: { target: 'kotlin', table: 't', column: 'fun', emitted: 'fun' },
    });
  });
});

// -- §5 projection lowering ---------------------------------------------------

const IR: IrDocument = {
  irVersion: 1,
  schemaVersion: 1,
  schemaVersions: [{ version: 1, migrations: ['0001'] }],
  tables: [
    {
      name: 'todos',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'created_at', type: 'integer', nullable: false },
      ],
      scopes: [
        { pattern: 'list:{list_id}', variable: 'list_id', column: 'list_id' },
      ],
      references: [],
      indexes: [],
      ftsIndexes: [],
      extensions: {},
    },
    {
      name: 'lists',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'owner_id', type: 'string', nullable: false },
      ],
      scopes: [
        {
          pattern: 'owner:{owner_id}',
          variable: 'owner_id',
          column: 'owner_id',
        },
      ],
      references: [],
      indexes: [],
      ftsIndexes: [],
      extensions: {},
    },
  ],
  subscriptions: [],
  extensions: {},
};

function makeDb(): QueryDb {
  const sqlite = new Database(':memory:');
  sqlite.run(synthesizeDdl(IR));
  return {
    analyze(sql: string) {
      const stmt = sqlite.prepare(sql);
      const columnNames = stmt.columnNames;
      (stmt as unknown as { all: () => unknown[] }).all();
      const declaredTypes = (
        stmt as unknown as { declaredTypes: (string | null)[] }
      ).declaredTypes;
      const paramsCount = (stmt as unknown as { paramsCount: number })
        .paramsCount;
      stmt.finalize();
      return { columnNames, declaredTypes, paramsCount };
    },
  };
}

const db = makeDb();
const camel = (sql: string) =>
  analyzeQuery('q.sql', sql, IR, db, { naming: 'camel', targets: ['ts'] });
const preserve = (sql: string) =>
  analyzeQuery('q.sql', sql, IR, db, { naming: 'preserve', targets: ['ts'] });

describe('projection lowering (§5 AS-aliasing)', () => {
  test('snake refs gain AS aliases; camel-clean refs stay verbatim', () => {
    const q = camel('SELECT id, list_id, created_at FROM todos');
    expect(q.sql).toBe(
      'SELECT id, list_id AS "listId", created_at AS "createdAt" FROM todos',
    );
    expect(q.columns.map((c) => [c.name, c.langName])).toEqual([
      ['id', 'id'],
      ['list_id', 'listId'],
      ['created_at', 'createdAt'],
    ]);
    // Exact typing survives the alias (plain-ref resolution on the lowered SQL).
    expect(q.columns[2]).toMatchObject({ type: 'integer', fidelity: 'exact' });
  });

  test('emitted aliases are double-quoted so Postgres preserves their case', () => {
    // A snake_case column and an explicitly aliased expression both get a
    // quoted alias: Postgres folds an unquoted alias to lower case.
    expect(camel('SELECT list_id FROM todos').sql).toBe(
      'SELECT list_id AS "listId" FROM todos',
    );
    expect(camel('SELECT count(*) AS row_count FROM todos').sql).toBe(
      'SELECT count(*) AS "rowCount" FROM todos',
    );
  });

  test('an author-written alias is the SQL-truth name and convention-maps', () => {
    const q = camel(
      'SELECT CAST(max(created_at) AS INTEGER) AS last_seen FROM todos',
    );
    expect(q.sql).toBe(
      'SELECT CAST(max(created_at) AS INTEGER) AS "lastSeen" FROM todos',
    );
    expect(q.columns[0]).toMatchObject({
      name: 'last_seen',
      langName: 'lastSeen',
    });
  });

  test('a query needing no rewrite is byte-identical', () => {
    const src = 'SELECT id, title FROM todos';
    expect(camel(src).sql).toBe(src);
  });

  test('bare * expands to the single FROM table (schema-pinned projection)', () => {
    const q = camel('SELECT * FROM todos');
    expect(q.sql).toBe(
      'SELECT id, list_id AS "listId", title, created_at AS "createdAt" FROM todos',
    );
  });

  test('qualified t.* expands through the alias', () => {
    const q = camel(
      'SELECT t.* FROM todos t JOIN lists l ON l.id = t.list_id WHERE l.owner_id = :ownerId',
    );
    expect(q.sql).toContain('t.list_id AS "listId"');
    expect(q.columns.map((c) => c.langName)).toEqual([
      'id',
      'listId',
      'title',
      'createdAt',
    ]);
  });

  test('bare * over two tables is a loud error', () => {
    expect(() =>
      camel('SELECT * FROM todos t JOIN lists l ON l.id = t.list_id'),
    ).toThrow(/cannot expand a bare `\*` over 2 tables/);
  });

  test('a CTE body is untouched; the outer projection lowers', () => {
    const q = camel(
      'WITH recent AS (SELECT created_at FROM todos) SELECT created_at FROM recent',
    );
    expect(q.sql).toBe(
      'WITH recent AS (SELECT created_at FROM todos) SELECT created_at AS "createdAt" FROM recent',
    );
    // The CTE's inner FROM still pins the invalidation set.
    expect(q.tables).toEqual(['todos']);
  });

  test('a projection collision (two names, one camel) is a loud error', () => {
    expect(() => camel('SELECT list_id, 1 AS listId FROM todos')).toThrow(
      /both map to "listId"/,
    );
  });

  test('params get language names through the same map', () => {
    const q = camel('SELECT id FROM todos WHERE list_id = :list_id');
    expect(q.params).toEqual([
      {
        name: 'list_id',
        langName: 'listId',
        type: 'string',
        source: 'inferred',
      },
    ]);
  });

  test('"preserve" leaves the SQL and every name untouched', () => {
    const src = 'SELECT id, list_id, created_at FROM todos';
    const q = preserve(src);
    expect(q.sql).toBe(src);
    expect(q.columns.every((c) => c.langName === c.name)).toBe(true);
  });

  test('string literals in the projection survive verbatim', () => {
    const q = camel("SELECT CAST('a, b' AS TEXT) AS tag_text, id FROM todos");
    expect(q.sql).toBe(
      'SELECT CAST(\'a, b\' AS TEXT) AS "tagText", id FROM todos',
    );
  });
});

describe('QueryIR serialization is deterministic', () => {
  test('two runs are byte-identical and carry both name forms', () => {
    const q = camel('SELECT id, created_at FROM todos WHERE list_id = :listId');
    const a = serializeQueryIr([q]);
    const b = serializeQueryIr([q]);
    expect(a).toBe(b);
    const doc = JSON.parse(a);
    expect(doc.queries[0].sourceSql).toBe(
      'SELECT id, created_at FROM todos WHERE list_id = :listId',
    );
    expect(doc.queries[0].sql).toBe(
      'SELECT id, created_at AS "createdAt" FROM todos WHERE list_id = :listId',
    );
    expect(doc.queries[0].columns[1]).toEqual({
      name: 'created_at',
      langName: 'createdAt',
      type: 'integer',
      nullable: false,
      fidelity: 'exact',
      origin: {
        table: 'todos',
        column: 'created_at',
      },
    });
  });
});
