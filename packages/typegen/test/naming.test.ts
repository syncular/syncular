/**
 * The pinned §12 naming map (DESIGN-queries.md): snake→camel vectors,
 * collision/keyword/Dart-underscore hard errors, the "preserve" identity —
 * and the §5 projection lowering that makes runtime keys the language names
 * (AS-aliasing, star expansion, author-alias respect).
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  analyzeQuery,
  buildNamingMap,
  type IrDocument,
  type QueryDb,
  serializeQueryIr,
  snakeToCamel,
  synthesizeDdl,
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
      indexes: [],
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
      indexes: [],
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
      'SELECT id, list_id AS listId, created_at AS createdAt FROM todos',
    );
    expect(q.columns.map((c) => [c.name, c.langName])).toEqual([
      ['id', 'id'],
      ['list_id', 'listId'],
      ['created_at', 'createdAt'],
    ]);
    // Exact typing survives the alias (plain-ref resolution on the lowered SQL).
    expect(q.columns[2]).toMatchObject({ type: 'integer', fidelity: 'exact' });
  });

  test('an author-written alias is the SQL-truth name and convention-maps', () => {
    const q = camel('SELECT max(created_at) AS last_seen FROM todos');
    expect(q.sql).toBe('SELECT max(created_at) AS lastSeen FROM todos');
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
      'SELECT id, list_id AS listId, title, created_at AS createdAt FROM todos',
    );
  });

  test('qualified t.* expands through the alias', () => {
    const q = camel(
      'SELECT t.* FROM todos t JOIN lists l ON l.id = t.list_id WHERE l.owner_id = :ownerId',
    );
    expect(q.sql).toContain('t.list_id AS listId');
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
      'WITH recent AS (SELECT created_at FROM todos) SELECT created_at AS createdAt FROM recent',
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
    const q = camel("SELECT 'a, b' AS tag_text, id FROM todos");
    expect(q.sql).toBe("SELECT 'a, b' AS tagText, id FROM todos");
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
      'SELECT id, created_at AS createdAt FROM todos WHERE list_id = :listId',
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
