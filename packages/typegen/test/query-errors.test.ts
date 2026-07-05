/**
 * Named-query analysis error surface: every rejection is loud and names the
 * fix. The DDL is synthesized from a small IR; the SQLite prepare() is the
 * correctness authority (bad references throw with SQLite's own message).
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  analyzeQueries,
  analyzeQuery,
  analyzeQueryFile,
  type IrDocument,
  type QueryDb,
  queryNameFromFile,
  queryNameFromPath,
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
const analyze = (file: string, sql: string) => analyzeQuery(file, sql, IR, db);

describe('query filename → name', () => {
  test('kebab → camel (flat, unchanged)', () => {
    expect(queryNameFromFile('list-todos.sql')).toBe('listTodos');
    expect(queryNameFromFile('todos.sql')).toBe('todos');
  });
  test('rejects non-kebab filenames', () => {
    expect(() => queryNameFromFile('ListTodos.sql')).toThrow(/kebab-case/);
    expect(() => queryNameFromFile('list_todos.sql')).toThrow(/kebab-case/);
  });
});

describe('recursive path → name', () => {
  test('nested folders join + camelCase (path-derived default)', () => {
    expect(queryNameFromPath('billing/invoices/list.sql')).toBe(
      'billingInvoicesList',
    );
    expect(queryNameFromPath('reporting/tasks-by-priority.sql')).toBe(
      'reportingTasksByPriority',
    );
    // A flat file keeps today's name — back-compat with existing consumers.
    expect(queryNameFromPath('list-todos.sql')).toBe('listTodos');
  });
  test('rejects a bad folder segment loudly (kebab per segment)', () => {
    expect(() => queryNameFromPath('Billing/list.sql')).toThrow(
      /path segment "Billing".*kebab-case/,
    );
    expect(() => queryNameFromPath('billing/List.sql')).toThrow(
      /path segment "List".*kebab-case/,
    );
    expect(() => queryNameFromPath('billing/in_voices/list.sql')).toThrow(
      /path segment "in_voices"/,
    );
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

const analyzeFile = (file: string, sql: string) =>
  analyzeQueryFile(file, sql, IR, db);

describe('multi-statement files', () => {
  test('a single-statement file may omit `-- name:` (path-derived)', () => {
    const qs = analyzeFile('list-todos.sql', 'SELECT id FROM todos');
    expect(qs).toHaveLength(1);
    expect(qs[0]?.name).toBe('listTodos');
  });

  test('two statements each named → two queries, per-statement scope', () => {
    const qs = analyzeFile(
      'reports.sql',
      [
        '-- name: openTodos',
        'SELECT id FROM todos WHERE done = 0;',
        '-- name: todoByList',
        'SELECT id FROM todos WHERE list_id = :listId',
      ].join('\n'),
    );
    expect(qs.map((q) => q.name)).toEqual(['openTodos', 'todoByList']);
    // The :listId param belongs to the SECOND statement only.
    expect(qs[0]?.params).toEqual([]);
    expect(qs[1]?.params).toEqual([
      { name: 'listId', type: 'string', source: 'inferred' },
    ]);
  });

  test('a multi-statement file with a missing `-- name:` errors loudly', () => {
    expect(() =>
      analyzeFile(
        'reports.sql',
        'SELECT id FROM todos;\n-- name: two\nSELECT title FROM todos',
      ),
    ).toThrow(/holds 2 statements.*requires a `-- name:.*` marker/);
  });

  test('the missing-name error names the file + statement position/line', () => {
    expect(() =>
      analyzeFile(
        'reports.sql',
        '-- name: one\nSELECT id FROM todos;\n\nSELECT title FROM todos',
      ),
    ).toThrow(/statement #2 \(line 4/);
  });

  test('a trailing `;` on the last statement is fine (single query)', () => {
    const qs = analyzeFile('one.sql', 'SELECT id FROM todos;');
    expect(qs).toHaveLength(1);
    expect(qs[0]?.name).toBe('one');
  });

  test('a `;` inside a string literal does NOT split statements', () => {
    const qs = analyzeFile('greet.sql', "SELECT id, 'a;b' AS sep FROM todos");
    expect(qs).toHaveLength(1);
  });
});

describe('`-- name:` override validation', () => {
  test('a valid camelCase override renames a single-statement file', () => {
    const qs = analyzeFile(
      'doc-lookup.sql',
      '-- name: findByList\nSELECT id FROM todos WHERE list_id = :listId',
    );
    expect(qs[0]?.name).toBe('findByList');
  });
  test('a non-camelCase override is rejected loudly', () => {
    expect(() =>
      analyzeFile('q.sql', '-- name: Find-By-List\nSELECT id FROM todos'),
    ).toThrow(/must be a camelCase identifier/);
    expect(() =>
      analyzeFile('q.sql', '-- name: find_by_list\nSELECT id FROM todos'),
    ).toThrow(/must be a camelCase identifier/);
    expect(() =>
      analyzeFile('q.sql', '-- name: 9lives\nSELECT id FROM todos'),
    ).toThrow(/must be a camelCase identifier/);
  });
  test('a bare one-word prose comment does NOT rename (marker form only)', () => {
    // `-- todos` is prose, not `-- name: todos` — path default wins.
    const qs = analyzeFile('list-todos.sql', '-- todos\nSELECT id FROM todos');
    expect(qs[0]?.name).toBe('listTodos');
  });
});

describe('global uniqueness (across the whole manifest)', () => {
  test('two files whose names collide error, naming BOTH locations', () => {
    // A path default clashing with another file's `-- name:` override.
    expect(() =>
      analyzeQueries(IR, [
        { file: 'list-todos.sql', sql: 'SELECT id FROM todos' },
        {
          file: 'other.sql',
          sql: '-- name: listTodos\nSELECT id FROM todos',
        },
      ]),
    ).toThrow(/duplicate query name "listTodos".*list-todos\.sql.*other\.sql/);
  });

  test('two statements in one file colliding on override names error', () => {
    expect(() =>
      analyzeQueries(IR, [
        {
          file: 'dup.sql',
          sql: '-- name: same\nSELECT id FROM todos;\n-- name: same\nSELECT title FROM todos',
        },
      ]),
    ).toThrow(/duplicate query name "same".*dup\.sql#1.*dup\.sql#2/);
  });
});
