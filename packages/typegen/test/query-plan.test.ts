// The generate-time query plan check (docs/SYQL.md §14.5): each finding kind,
// its code and details, and the acknowledgement rules for .sql and .syql.
import { describe, expect, test } from 'bun:test';
import {
  analyzeQueries,
  type IrDocument,
  type IrTable,
  SyqlFrontendError,
  TypegenError,
} from '../src';

function table(
  name: string,
  columns: readonly string[],
  indexes: IrTable['indexes'] = [],
): IrTable {
  return {
    name,
    primaryKey: 'id',
    columns: ['id', ...columns].map((column) => ({
      name: column,
      type: 'string',
      nullable: false,
    })),
    scopes: [],
    references: [],
    indexes,
    ftsIndexes: [],
    extensions: {},
  };
}

const IR: IrDocument = {
  irVersion: 1,
  schemaVersion: 1,
  schemaVersions: [{ version: 1, migrations: ['0001'] }],
  tables: [
    table(
      'lists',
      ['owner_id'],
      [{ name: 'idx_lists_owner', columns: ['owner_id'], unique: false }],
    ),
    table('todos', ['list_id', 'title']),
    table('tags', ['todo_id', 'label']),
    table('a', ['b_id']),
    table('b', ['c_id']),
    table('c', ['d_id']),
    table('d', ['e_id']),
    table('e', []),
  ],
  subscriptions: [],
  extensions: {},
};

function failure(file: string, sql: string): TypegenError {
  try {
    analyzeQueries(IR, [{ file, sql }]);
  } catch (error) {
    if (error instanceof TypegenError) return error;
    throw error;
  }
  throw new Error('generation passed');
}

describe('query plan findings', () => {
  test('a scan of a filtered table names the columns whose index removes it', () => {
    const error = failure(
      'todos-in-list.sql',
      'SELECT id, title FROM todos WHERE list_id = :listId ORDER BY id',
    );
    expect(error.code).toBe('typegen.query_scan');
    expect(error.message).not.toContain('list_id');
    expect(error.details).toEqual({
      query: 'todosInList',
      file: 'todos-in-list.sql',
      statement: 0,
      sql: 'SELECT id, title FROM todos WHERE list_id = ? ORDER BY id',
      table: 'todos',
      columns: ['list_id'],
      plan: ['SCAN todos USING INDEX sqlite_autoindex_todos_1'],
    });
  });

  test('a join constraint without an index builds an automatic index', () => {
    const error = failure(
      'labelled.sql',
      'SELECT t.id FROM todos t JOIN tags g ON g.label = t.title',
    );
    expect(error.code).toBe('typegen.query_automatic_index');
    expect(error.details).toEqual({
      query: 'labelled',
      file: 'labelled.sql',
      statement: 0,
      sql: 'SELECT t.id FROM todos t JOIN tags g ON g.label = t.title',
      table: 'tags',
      columns: ['label'],
      plan: ['SCAN t', 'SEARCH g USING AUTOMATIC COVERING INDEX (label=?)'],
    });
  });

  test('a read with no WHERE and no LIMIT is unbounded', () => {
    const error = failure('all-titles.sql', 'SELECT id, title FROM todos');
    expect(error.code).toBe('typegen.query_unbounded');
    expect(error.details).toEqual({
      query: 'allTitles',
      file: 'all-titles.sql',
      statement: 0,
      sql: 'SELECT id, title FROM todos',
      table: 'todos',
      plan: ['SCAN todos'],
    });
    // A LIMIT bounds the same read; a searched table reads no scan at all.
    expect(
      analyzeQueries(IR, [
        { file: 'some.sql', sql: 'SELECT id FROM todos LIMIT 10' },
        {
          file: 'owned.sql',
          sql: 'SELECT id FROM lists WHERE owner_id = :ownerId',
        },
      ]),
    ).toHaveLength(2);
  });

  test('a query over more than four tables re-runs on any of them', () => {
    const error = failure(
      'chain.sql',
      `-- allow unbounded a: test chain
SELECT a.id FROM a
JOIN b ON b.id = a.b_id JOIN c ON c.id = b.c_id
JOIN d ON d.id = c.d_id JOIN e ON e.id = d.e_id`,
    );
    expect(error.code).toBe('typegen.query_many_tables');
    expect(error.details).toEqual({
      query: 'chain',
      file: 'chain.sql',
      tables: ['a', 'b', 'c', 'd', 'e'],
    });
  });
});

describe('query plan acknowledgements', () => {
  test('a .sql acknowledgement silences exactly its finding', () => {
    const [query] = analyzeQueries(IR, [
      {
        file: 'todos-in-list.sql',
        sql: '-- allow scan todos: a list holds at most 200 todos\nSELECT id FROM todos WHERE list_id = :listId',
      },
    ]);
    expect(query?.acknowledgements).toEqual([
      {
        finding: 'scan',
        table: 'todos',
        reason: 'a list holds at most 200 todos',
      },
    ]);
    // Acknowledging the unbounded read leaves the automatic index reported.
    expect(
      failure(
        'labelled.sql',
        '-- allow unbounded todos: small\nSELECT t.id FROM todos t JOIN tags g ON g.label = t.title',
      ).code,
    ).toBe('typegen.query_automatic_index');
  });

  test('a .syql acknowledgement covers every physical statement', () => {
    const [query] = analyzeQueries(IR, [
      {
        file: 'todos.syql',
        sql: `allow scan todos 'a list holds at most 200 todos'
query todosInList(listId, title?: string) {
  select id from todos
  where todos.list_id = :listId
    and when(title) title = :title
  order by id;
}`,
      },
    ]);
    expect(query?.syql?.plan.statements).toHaveLength(2);
    expect(
      failure(
        'todos.syql',
        `query todosInList(listId) {
  select id from todos where todos.list_id = :listId order by id;
}`,
      ).details,
    ).toMatchObject({ query: 'todosInList', statement: 0, table: 'todos' });
  });

  test('an acknowledgement that matches no finding fails', () => {
    for (const [file, sql] of [
      [
        'owned.sql',
        '-- allow scan lists: stale\nSELECT id FROM lists WHERE owner_id = :ownerId',
      ],
      [
        'owned.syql',
        `allow scan lists 'stale'
query owned(ownerId) { select id from lists where lists.owner_id = :ownerId; }`,
      ],
    ] as const) {
      const error = failure(file, sql);
      expect(error.code).toBe('typegen.query_acknowledgement_unused');
      expect(error.details).toEqual({
        query: 'owned',
        file,
        finding: 'scan',
        table: 'lists',
      });
    }
  });

  test('allow plan acknowledges every finding of a server-run query', () => {
    const sql =
      'SELECT t.id FROM todos t JOIN tags g ON g.label = t.title WHERE t.list_id = :listId';
    for (const [file, source] of [
      ['server.sql', `-- allow plan: registered on the server only\n${sql}`],
      [
        'server.syql',
        `allow plan 'registered on the server only'
query server(listId) {
  select t.id from todos t join tags g on g.label = t.title
  where t.list_id = :listId;
}`,
      ],
    ] as const) {
      const [query] = analyzeQueries(IR, [{ file, sql: source }]);
      expect(query?.acknowledgements).toEqual([
        { finding: 'plan', reason: 'registered on the server only' },
      ]);
    }
    const unused = failure(
      'owned.sql',
      '-- allow plan: stale\nSELECT id FROM lists WHERE owner_id = :ownerId',
    );
    expect(unused.code).toBe('typegen.query_acknowledgement_unused');
    expect(unused.details).toEqual({
      query: 'owned',
      file: 'owned.sql',
      finding: 'plan',
      table: null,
    });
    for (const comment of [
      '-- allow plan todos: server',
      '-- allow plan:   ',
    ]) {
      expect(failure('q.sql', `${comment}\n${sql}`).details).toEqual({
        file: 'q.sql',
        comment,
      });
    }
    expect(
      failure(
        'q.sql',
        `-- allow plan: server\n-- allow scan todos: small\n${sql}`,
      ).code,
    ).toBe('typegen.query_acknowledgement_invalid');
    expect(() =>
      analyzeQueries(IR, [
        {
          file: 'q.syql',
          sql: "allow plan 'server'\nallow scan todos 'small'\nquery q(listId) { select id from todos where todos.list_id = :listId; }",
        },
      ]),
    ).toThrow(SyqlFrontendError);
  });

  test('an acknowledgement without a reason fails', () => {
    for (const comment of [
      '-- allow scan todos',
      '-- allow scan todos:   ',
      '-- allow scan: small',
      '-- allow many_tables todos: small',
    ]) {
      const error = failure(
        'q.sql',
        `${comment}\nSELECT id FROM todos WHERE list_id = :listId`,
      );
      expect(error.code).toBe('typegen.query_acknowledgement_invalid');
      expect(error.details).toEqual({ file: 'q.sql', comment });
    }
    expect(() =>
      analyzeQueries(IR, [
        {
          file: 'q.syql',
          sql: 'allow scan todos\nquery q(listId) { select id from todos where todos.list_id = :listId; }',
        },
      ]),
    ).toThrow(SyqlFrontendError);
    // A comment that only starts with the word allow stays a comment.
    expect(
      failure('q.sql', '-- allow listing\nSELECT id FROM todos').code,
    ).toBe('typegen.query_unbounded');
  });
});

test('many_tables counts the tables an optional .syql branch reads', () => {
  const error = failure(
    'chain.syql',
    `allow unbounded a 'test chain'
query chain(label?: string) {
  select a.id from a
  join b on b.id = a.b_id join c on c.id = b.c_id join d on d.id = c.d_id
  where when(label) a.id in (select e.id from e where e.id = :label);
}`,
  );
  expect(error.code).toBe('typegen.query_many_tables');
  expect(error.details?.tables).toEqual(['a', 'b', 'c', 'd', 'e']);
});
