/**
 * Named-query analysis error surface: every rejection is loud and names the
 * fix. The DDL is synthesized from a small IR; the SQLite prepare() is the
 * correctness authority (bad references throw with SQLite's own message).
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  analyzeQuery,
  type IrDocument,
  type QueryDb,
  queryNameFromFile,
  synthesizeDdl,
} from '../src';

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
        { name: 'done', type: 'boolean', nullable: false },
        { name: 'note', type: 'string', nullable: true },
      ],
      scopes: [
        { pattern: 'list:{list_id}', variable: 'list_id', column: 'list_id' },
      ],
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
const analyze = (file: string, sql: string) => analyzeQuery(file, sql, IR, db);

describe('query filename → name', () => {
  test('kebab → camel', () => {
    expect(queryNameFromFile('list-todos.sql')).toBe('listTodos');
    expect(queryNameFromFile('todos.sql')).toBe('todos');
  });
  test('rejects non-kebab filenames', () => {
    expect(() => queryNameFromFile('ListTodos.sql')).toThrow(/kebab-case/);
    expect(() => queryNameFromFile('list_todos.sql')).toThrow(/kebab-case/);
  });
});

describe('SELECT-only', () => {
  test('rejects INSERT loudly, pointing at mutate()', () => {
    expect(() =>
      analyze('bad.sql', "INSERT INTO todos (id) VALUES ('x')"),
    ).toThrow(/SELECT-only/);
  });
  test('rejects a DELETE', () => {
    expect(() => analyze('bad.sql', 'DELETE FROM todos')).toThrow(
      /SELECT-only/,
    );
  });
  test('rejects `;`-separated multiple statements', () => {
    expect(() =>
      analyze('bad.sql', 'SELECT id FROM todos; SELECT title FROM todos'),
    ).toThrow(/exactly one SELECT/);
  });
});

describe('SQLite is the correctness authority', () => {
  test("an unknown column is rejected with SQLite's message", () => {
    expect(() => analyze('bad.sql', 'SELECT nope FROM todos')).toThrow(
      /rejected by SQLite/,
    );
  });
  test('an unknown table is rejected', () => {
    expect(() => analyze('bad.sql', 'SELECT id FROM nope')).toThrow(
      /rejected by SQLite/,
    );
  });
  test('a syntax error is rejected', () => {
    expect(() => analyze('bad.sql', 'SELECT id FRON todos')).toThrow(
      /rejected by SQLite/,
    );
  });
});

describe('parameter typing', () => {
  test('inference from equality against a plain column', () => {
    const q = analyze('q.sql', 'SELECT id FROM todos WHERE list_id = :listId');
    expect(q.params).toEqual([
      { name: 'listId', type: 'string', source: 'inferred' },
    ]);
  });
  test('an un-inferable param demands a comment (loud, names the fix)', () => {
    expect(() => analyze('q.sql', 'SELECT id, :label AS l FROM todos')).toThrow(
      /cannot infer a type for param :label/,
    );
  });
  test('a comment resolves an un-inferable param', () => {
    const q = analyze(
      'q.sql',
      '-- param :label string\nSELECT id, :label AS l FROM todos',
    );
    expect(q.params).toEqual([
      { name: 'label', type: 'string', source: 'comment' },
    ]);
  });
  test('a comment for an unused param is a mistake', () => {
    expect(() =>
      analyze('q.sql', '-- param :ghost string\nSELECT id FROM todos'),
    ).toThrow(/does not use/);
  });
  test('an unknown comment type is rejected', () => {
    expect(() =>
      analyze('q.sql', '-- param :x weird\nSELECT id FROM todos WHERE id = :x'),
    ).toThrow(/unknown type/);
  });
});

describe('column fidelity', () => {
  test('a nullable plain ref stays nullable + exact', () => {
    const q = analyze('q.sql', 'SELECT note FROM todos');
    expect(q.columns[0]).toMatchObject({
      name: 'note',
      type: 'string',
      nullable: true,
      fidelity: 'exact',
    });
  });
  test('a boolean column decodes as boolean (exact)', () => {
    const q = analyze('q.sql', 'SELECT done FROM todos');
    expect(q.columns[0]).toMatchObject({ type: 'boolean', fidelity: 'exact' });
  });
});
