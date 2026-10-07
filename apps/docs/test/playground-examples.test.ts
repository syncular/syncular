// Every playground example goes through the worker's path: the browser
// compiler boundary, SQLite WASM seeded with the demo's Release board rows,
// and the generated-runtime statement selection and binds.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, test } from 'bun:test';
import { compileSyqlSource } from '../../../packages/typegen/src/syql-browser';
import {
  BOARD_SCHEMA,
  BOARD_SEED,
  EXAMPLE_GROUPS,
  PLAYGROUND_EXAMPLES,
} from '../src/playground/examples';
import type { PlaygroundQuery } from '../src/playground/protocol';
import {
  bindStatement,
  executeStatement,
  openPlaygroundDatabase,
  type PlaygroundDatabase,
  type PlaygroundParams,
  PlaygroundRunError,
  playgroundDiagnostic,
  serializeQuery,
} from '../src/playground/runtime';

let db: PlaygroundDatabase;

beforeAll(async () => {
  db = openPlaygroundDatabase(
    await sqlite3InitModule(),
    BOARD_SCHEMA,
    BOARD_SEED,
  );
});

function compile(source: string): PlaygroundQuery {
  const result = compileSyqlSource(source, BOARD_SCHEMA, db.queryDb);
  expect(result.queries).toHaveLength(1);
  const lowered = result.queries[0];
  if (lowered === undefined) throw new Error('no compiled query');
  return serializeQuery(lowered);
}

function run(query: PlaygroundQuery, params: PlaygroundParams) {
  const { statement, values } = bindStatement(query, params);
  return executeStatement(db.database, statement.positionalSql, values);
}

function example(id: string) {
  const found = PLAYGROUND_EXAMPLES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no example ${id}`);
  return found;
}

/** Plan facts each compiling example demonstrates. `deps` lists the tables
 * whose invalidation is table-wide; every other table is scope-keyed. */
const PLANS: Record<
  string,
  {
    readonly backend: 'variants' | 'neutralize';
    readonly statements: number;
    readonly identity?: readonly string[];
    readonly coverage: readonly string[];
    readonly tableWide: readonly string[];
    readonly rows: number;
  }
> = {
  'column-cards': {
    backend: 'variants',
    statements: 1,
    identity: ['id'],
    coverage: [],
    tableWide: [],
    rows: 3,
  },
  predicate: {
    backend: 'variants',
    statements: 1,
    identity: ['id'],
    coverage: [],
    tableWide: [],
    rows: 1,
  },
  'sort-limit': {
    backend: 'variants',
    statements: 3,
    identity: ['id'],
    coverage: [],
    tableWide: [],
    rows: 5,
  },
  optional: {
    backend: 'neutralize',
    statements: 1,
    identity: ['id'],
    coverage: [],
    tableWide: [],
    rows: 2,
  },
  record: {
    backend: 'variants',
    statements: 2,
    identity: ['id'],
    coverage: [],
    tableWide: [],
    rows: 6,
  },
  'subquery-filter': {
    backend: 'variants',
    statements: 2,
    coverage: [],
    tableWide: ['card_labels'],
    rows: 3,
  },
  'assignee-join': {
    backend: 'variants',
    statements: 1,
    coverage: [],
    tableWide: ['members'],
    rows: 12,
  },
  'label-join': {
    backend: 'variants',
    statements: 1,
    coverage: [],
    tableWide: ['card_labels', 'labels'],
    rows: 3,
  },
  'comment-thread': {
    backend: 'variants',
    statements: 1,
    coverage: [],
    tableWide: ['members'],
    rows: 2,
  },
  'column-totals': {
    backend: 'variants',
    statements: 1,
    coverage: [],
    tableWide: [],
    rows: 4,
  },
  'assignee-load': {
    backend: 'variants',
    statements: 2,
    coverage: [],
    tableWide: ['members'],
    rows: 2,
  },
  'label-usage': {
    backend: 'variants',
    statements: 1,
    coverage: [],
    tableWide: ['card_labels'],
    rows: 6,
  },
  'top-estimates': {
    backend: 'variants',
    statements: 1,
    identity: ['id'],
    coverage: [],
    tableWide: [],
    rows: 5,
  },
  'rank-in-column': {
    backend: 'variants',
    statements: 1,
    coverage: [],
    tableWide: ['cards'],
    rows: 12,
  },
  'sync-board': {
    backend: 'variants',
    statements: 1,
    identity: ['id'],
    coverage: ['cards'],
    tableWide: [],
    rows: 12,
  },
  'sync-join': {
    backend: 'variants',
    statements: 1,
    coverage: ['cards', 'comments'],
    tableWide: [],
    rows: 13,
  },
  'sync-in': {
    backend: 'variants',
    statements: 1,
    identity: ['id'],
    coverage: ['cards'],
    tableWide: [],
    rows: 24,
  },
};

describe('SYQL playground examples', () => {
  test('every example has a known group, a unique id, and one expectation', () => {
    const ids = PLAYGROUND_EXAMPLES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of PLAYGROUND_EXAMPLES) {
      expect(EXAMPLE_GROUPS.map(({ id }) => id)).toContain(item.group);
      expect(item.fails === undefined).toBe(item.id in PLANS);
      expect(item.fails === undefined).toBe(item.params !== undefined);
    }
    for (const group of EXAMPLE_GROUPS) {
      expect(ids.some((id) => example(id).group === group.id)).toBe(true);
    }
  });

  for (const item of PLAYGROUND_EXAMPLES) {
    const plan = PLANS[item.id];
    if (plan === undefined) {
      test(`${item.title} fails closed with ${item.fails}`, () => {
        let thrown: unknown;
        try {
          compileSyqlSource(item.source, BOARD_SCHEMA, db.queryDb);
        } catch (error) {
          thrown = error;
        }
        const diagnostic = playgroundDiagnostic(thrown);
        expect(diagnostic.code).toBe(item.fails ?? '');
        expect(diagnostic.line).toBeGreaterThan(0);
        expect(diagnostic.remedy).toBeString();
      });
      continue;
    }
    test(`${item.title} compiles and runs on the demo seed`, () => {
      const query = compile(item.source);
      expect(query.backend).toBe(plan.backend);
      expect(query.statements).toHaveLength(plan.statements);
      expect(query.identity).toEqual(plan.identity);
      expect(query.coverage.map(({ table }) => table)).toEqual([
        ...plan.coverage,
      ]);
      expect(
        query.dependencies
          .filter(({ scopes }) => scopes.length === 0)
          .map(({ table }) => table),
      ).toEqual([...plan.tableWide]);
      for (const statement of query.statements) {
        expect(statement.positionalSql).not.toContain(':');
      }
      const result = run(query, item.params ?? {});
      expect(result.columns).toEqual(query.columns.map(({ name }) => name));
      expect(result.rows).toHaveLength(plan.rows);
    });
  }
});

describe('SYQL playground runtime', () => {
  test('returns the demo rows the board shows', () => {
    const totals = run(compile(example('column-totals').source), {
      boardId: 'web',
    });
    expect(totals.rows).toEqual([
      ['backlog', 4, 18],
      ['doing', 3, 10],
      ['done', 3, 14],
      ['review', 2, 6],
    ]);
    const thread = run(compile(example('comment-thread').source), {
      boardId: 'mobile',
      cardId: 'c-mobile-17',
    });
    expect(thread.rows.map((row) => row[1])).toEqual(['Ben', 'Dev']);
  });

  test('selects the statement for the active controls and sort profile', () => {
    const optional = compile(example('optional').source);
    expect(run(optional, { boardId: 'web' }).rows).toHaveLength(12);
    expect(
      run(optional, { boardId: 'web', columnId: 'review' }).rows,
    ).toHaveLength(2);
    expect(
      run(optional, { boardId: 'web', assigneeId: null }).rows,
    ).toHaveLength(2);
    expect(
      run(optional, {
        boardId: 'web',
        created: { start: 0, end: Number.MAX_SAFE_INTEGER },
        columnId: 'done',
      }).rows,
    ).toHaveLength(3);

    const sorted = compile(example('sort-limit').source);
    const titles = run(sorted, {
      boardId: 'web',
      sortBy: 'title',
      pageSize: 2,
    });
    expect(titles.rows.map((row) => row[1])).toEqual([
      'Cache the pricing API responses',
      'CSV export for invoices',
    ]);
    expect(run(sorted, { boardId: 'web' }).rows).toHaveLength(10);
  });

  test('rejects invalid public inputs before SQLite runs', () => {
    const sorted = compile(example('sort-limit').source);
    const code = (params: PlaygroundParams) => {
      try {
        bindStatement(sorted, params);
      } catch (error) {
        if (error instanceof PlaygroundRunError) return error.code;
        throw error;
      }
      return undefined;
    };
    expect(code({})).toBe('SYQL_RUNTIME_MISSING_REQUIRED_INPUT');
    expect(code({ boardId: 'web', pageSize: 51 })).toBe(
      'SYQL_RUNTIME_INVALID_LIMIT',
    );
    expect(code({ boardId: 'web', sortBy: 'oldest' })).toBe(
      'SYQL_RUNTIME_INVALID_SORT',
    );
    expect(code({ boardId: 'web' })).toBeUndefined();
  });
});
