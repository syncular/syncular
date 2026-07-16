import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  analyzeSyqlSemantics,
  buildSyqlModuleGraph,
  type IrDocument,
  type QueryDb,
  SyqlFrontendError,
  synthesizeDdl,
  validateSyqlProgram,
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
        { name: 'status', type: 'string', nullable: true },
        { name: 'position', type: 'integer', nullable: false },
        { name: 'created_at', type: 'integer', nullable: false },
        { name: 'assignee_id', type: 'string', nullable: true },
      ],
      scopes: [
        { pattern: 'list:{list_id}', variable: 'list_id', column: 'list_id' },
      ],
      indexes: [],
      ftsIndexes: [
        { name: 'todos_fts', columns: ['title'], tokenize: 'unicode61' },
      ],
      extensions: {},
    },
    {
      name: 'messages',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'room_id', type: 'string', nullable: false },
        { name: 'thread_id', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      scopes: [
        { pattern: 'room:{room_id}', variable: 'room_id', column: 'room_id' },
        {
          pattern: 'thread:{thread_id}',
          variable: 'thread_id',
          column: 'thread_id',
        },
      ],
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
      const statement = sqlite.prepare(sql);
      try {
        const columnNames = statement.columnNames;
        (statement as unknown as { all: () => unknown[] }).all();
        const declaredTypes = (
          statement as unknown as { declaredTypes: (string | null)[] }
        ).declaredTypes;
        const paramsCount = (statement as unknown as { paramsCount: number })
          .paramsCount;
        return { columnNames, declaredTypes, paramsCount };
      } finally {
        statement.finalize();
      }
    },
  };
}

const db = makeDb();
const root = resolve('/virtual/syql-validator');

function validate(source: string) {
  const file = resolve(root, 'query.syql');
  const graph = buildSyqlModuleGraph(root, ['query.syql'], (candidate) =>
    candidate === file ? source : undefined,
  );
  return validateSyqlProgram(analyzeSyqlSemantics(graph), IR, db, {
    naming: 'camel',
    targets: ['ts'],
  });
}

function frontendError(run: () => unknown): SyqlFrontendError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SyqlFrontendError);
    return error as SyqlFrontendError;
  }
  throw new Error('expected a SyqlFrontendError');
}

describe('SYQL schema/SQL validation', () => {
  test('validates a complete reactive, conditional, sorted, limited query', () => {
    const result = validate(`sync query listTodos(
      listId,
      status?,
      cursor?: { start: integer, end: integer },
      includeUnassigned: bool = false,
    ) {

        select id, title, created_at from todos
        where todos.list_id = :listId
          and when(status) { status is :status }
          and when(cursor, includeUnassigned) {
            created_at between :start and :end
          }

      order by sortBy default newest {
        newest: created_at desc, id desc ;
        oldest: created_at asc, id asc ;
      }
      limit pageSize default 50 max 200;
    }`);
    const query = result.queries[0];
    expect(query?.bindTypes.get('listId')?.base).toBe('string');
    expect(query?.bindTypes.get('status')?.base).toBe('string');
    expect(query?.referenceSql).toContain('order by created_at desc, id desc');
    expect(query?.referenceSql).toEndWith('limit 50');
    expect(query?.reactive.dependencies).toMatchObject([
      {
        table: 'todos',
        scopes: [{ variable: 'list_id', params: ['listId'] }],
      },
    ]);
    expect(query?.reactive.coverage).toMatchObject([
      { table: 'todos', variable: 'list_id', units: ['listId'] },
    ]);
    expect(query?.identity).toEqual(['id']);
    expect(query?.reactive.rowKey).toEqual(['id']);
  });

  test('requires embedded nodes to be whole outer conjuncts', () => {
    const underOr = frontendError(() =>
      validate(`query q(status?) {

          select id from todos
          where id = 'x' or when(status) { status = :status }
        ;
      }`),
    );
    expect(underOr.code).toBe('SYQL6001_INVALID_PLACEMENT');

    const parenthesized = frontendError(() =>
      validate(`query q(status?) {

          select id from todos
          where (when(status) { status = :status })
        ;
      }`),
    );
    expect(parenthesized.code).toBe('SYQL6001_INVALID_PLACEMENT');
  });

  test('infers exact dependencies from ordinary scope predicates', () => {
    const fallback = validate(`query q(listId) {
       select id from todos where list_id = :listId ;
    }`).queries[0];
    expect(fallback?.reactive.dependencies[0]?.scopes[0]?.params).toEqual([
      'listId',
    ]);
    expect(fallback?.reactive.coverage).toEqual([]);

    const scoped = validate(`query q(listId) {

        select id from todos where todos.list_id = :listId
      ;
    }`).queries[0];
    expect(scoped?.reactive.dependencies[0]?.scopes[0]?.params).toEqual([
      'listId',
    ]);
    expect(scoped?.reactive.coverage).toEqual([]);

    const covered =
      validate(`sync query q(roomId, left, right) by messages.thread_id {

        select id from messages
        where messages.thread_id in (:left, :right) and messages.room_id = :roomId
      ;
    }`).queries[0];
    expect(covered?.reactive.coverage).toEqual([
      {
        table: 'messages',
        variable: 'thread_id',
        units: ['left', 'right'],
        fixedScopes: [{ variable: 'room_id', params: ['roomId'] }],
      },
    ]);
  });

  test('rejects sync queries whose coverage cannot be proven', () => {
    const incomplete = frontendError(() =>
      validate(`sync query q(threadId) by messages.thread_id {

          select id from messages
          where messages.thread_id = :threadId
        ;
      }`),
    );
    expect(incomplete.code).toBe('SYQL6005_INVALID_SYNC_QUERY');

    const nonScope = frontendError(() =>
      validate(`sync query q(id) {
         select id from todos where todos.id = :id ;
      }`),
    );
    expect(nonScope.code).toBe('SYQL6005_INVALID_SYNC_QUERY');

    const optional = frontendError(() =>
      validate(`sync query q(listId?) {

          select id from todos
          where when(listId) { todos.list_id = :listId }
        ;
      }`),
    );
    expect(optional.code).toBe('SYQL6005_INVALID_SYNC_QUERY');

    const nullableScope = frontendError(() =>
      validate(`sync query q(listId: string | null) {

          select id from todos where todos.list_id = :listId
        ;
      }`),
    );
    expect(nullableScope.code).toBe('SYQL6005_INVALID_SYNC_QUERY');
  });

  test('a partially scoped self-join falls back table-wide', () => {
    const query = validate(`query q(listId) {

        select a.id as leftId, b.id as rightId
        from todos as a join todos as b on a.list_id = b.list_id
        where a.list_id = :listId
      ;
    }`).queries[0];
    expect(query?.reactive.dependencies).toEqual([
      { table: 'todos', scopes: [] },
    ]);
    expect(query?.reactive.coverage).toEqual([]);
    expect(query?.identity).toBeUndefined();
  });

  test('rejects unsafe scope proofs and falls back conservatively', () => {
    for (const predicate of [
      "title = 'other' or todos.list_id = :listId",
      "todos.list_id = :listId or title = 'other'",
      'not (todos.list_id = :listId)',
      "todos.list_id in (:listId, 'fixed')",
    ]) {
      const query = validate(`query q(listId) {
        select id from todos where ${predicate};
      }`).queries[0];
      expect(query?.reactive.dependencies).toEqual([
        { table: 'todos', scopes: [] },
      ]);
    }

    const nested = validate(`query q(listId) {
      select id from todos
      where exists (
        select 1 from messages
        where messages.room_id = :listId
      );
    }`).queries[0];
    expect(nested?.reactive.dependencies).toEqual([
      { table: 'messages', scopes: [] },
      { table: 'todos', scopes: [] },
    ]);
  });

  test('does not allow one side of a self-join to claim sync coverage', () => {
    const error = frontendError(() =>
      validate(`sync query q(listId) by a.list_id {
        select a.id as leftId, b.id as rightId
        from todos as a join todos as b on a.list_id = b.list_id
        where a.list_id = :listId;
      }`),
    );
    expect(error.code).toBe('SYQL6005_INVALID_SYNC_QUERY');
  });

  test('rejects nondeterministic snapshot-external SQL', () => {
    for (const expression of [
      'random()',
      'current_timestamp',
      "datetime('now')",
      'last_insert_rowid()',
    ]) {
      const error = frontendError(() =>
        validate(
          `query q() {  select id, ${expression} as value from todos ; }`,
        ),
      );
      expect(error.code).toBe('SYQL6003_NONDETERMINISTIC_SQL');
    }
  });

  test('enforces the portable SQLite 3.46.0 function and collation profile', () => {
    const accepted = validate(`query q() {

        select id,
          lower(title) as folded,
          json_extract('{"value": 1}', '$.value') as extracted,
          iif(status is null, 'none', status) as normalized
        from todos
        order by title collate nocase, id
      ;
    }`).queries[0];
    expect(accepted?.analysis.columns.map((column) => column.name)).toEqual([
      'id',
      'folded',
      'extracted',
      'normalized',
    ]);

    for (const expression of [
      "unistr('\\u0041')",
      'sqrt(position)',
      "load_extension('extension')",
      "iif(status is null, 'none')",
    ]) {
      const error = frontendError(() =>
        validate(
          `query q() {  select id, ${expression} as value from todos ; }`,
        ),
      );
      expect(error.code).toBe('SYQL6002_INVALID_SQL');
      expect(error.message).toContain('SQLite 3.46.0');
    }

    for (const expression of ['date()', "strftime('%Y')"]) {
      const error = frontendError(() =>
        validate(
          `query q() {  select id, ${expression} as value from todos ; }`,
        ),
      );
      expect(error.code).toBe('SYQL6003_NONDETERMINISTIC_SQL');
    }

    const collation = frontendError(() =>
      validate(`query q() {
         select id from todos order by title collate unicode, id ;
      }`),
    );
    expect(collation.code).toBe('SYQL6002_INVALID_SQL');
  });

  test('allows FTS5 auxiliary functions only with a declared FTS projection', () => {
    const accepted = validate(`query searchTodos() {
      select todos_fts._syncular_source_id as source_id, t.id,
        bm25(todos_fts) as rank,
        highlight(todos_fts, 0, '<mark>', '</mark>') as highlighted,
        snippet(todos_fts, 0, '<mark>', '</mark>', ' … ', 12) as excerpt
      from todos_fts
      join todos t on t.id = todos_fts._syncular_source_id
      where 0
      order by rank, todos_fts._syncular_source_id asc, t.id asc
      limit 25;
    }`).queries[0];
    expect(accepted?.analysis.columns.map((column) => column.name)).toEqual([
      'source_id',
      'id',
      'rank',
      'highlighted',
      'excerpt',
    ]);
    expect(accepted?.identity).toEqual(['sourceId', 'id']);

    const missingFtsIdentity = frontendError(() =>
      validate(`query searchTodos() {
        select t.id, bm25(todos_fts) as rank
        from todos_fts
        join todos t on t.id = todos_fts._syncular_source_id
        where 0
        order by rank, t.id asc
        limit 25;
      }`),
    );
    expect(missingFtsIdentity.code).toBe('SYQL6006_INVALID_SORT');

    const rejected = frontendError(() =>
      validate(`query q() {
        select id, bm25(todos) as rank from todos order by id asc;
      }`),
    );
    expect(rejected.code).toBe('SYQL6002_INVALID_SQL');
    expect(rejected.message).toContain('schema-declared FTS5 projection');
  });

  test('uses all SQL evidence for types and accepts explicit uninferrable types', () => {
    const conflict = frontendError(() =>
      validate(`query q(value) {

          select id from todos
          where title = :value and position = :value
        ;
      }`),
    );
    expect(conflict.code).toBe('SYQL6004_TYPE_CONFLICT');

    const explicit = validate(`query q(label: string) {
       select :label as label, id from todos ;
    }`).queries[0];
    expect(explicit?.bindTypes.get('label')?.base).toBe('string');
  });

  test('distinguishes outer sort/limit conflicts from nested clauses', () => {
    const orderConflict = frontendError(() =>
      validate(`query q() {
         select id from todos order by id
        order by sortBy default byId { byId: id asc ; };
      }`),
    );
    expect(orderConflict.code).toBe('SYQL6006_INVALID_SORT');

    const limitConflict = frontendError(() =>
      validate(`query q() {
         select id from todos order by id limit 10
        limit pageSize default 5 max 10;
      }`),
    );
    expect(limitConflict.code).toBe('SYQL6007_INVALID_LIMIT');

    const nested = validate(`query q() {

        select id from todos
        where id in (select id from todos order by id)

      order by sortBy default byId { byId: id asc ; };
    }`);
    expect(nested.queries[0]?.sort?.defaultProfile).toBe('byId');
  });

  test('rejects nested bounds and windows without a local total-order proof', () => {
    for (const sql of [
      'select id from todos where id in (select id from todos order by id limit 1)',
      'select id from todos where id in (select id from todos order by id offset 1)',
      'select id, row_number() over (order by id) as rank from todos',
    ]) {
      const error = frontendError(() => validate(`query q() {  ${sql} ; }`));
      expect(error.code).toBe('SYQL6003_NONDETERMINISTIC_SQL');
    }
  });

  test('requires deterministic identity suffixes for bounded queries', () => {
    const missingIdentity = frontendError(() =>
      validate(`query q() {
         select title from todos
        order by sortBy default byTitle { byTitle: title asc ; }
        limit pageSize default 10 max 20;
      }`),
    );
    expect(missingIdentity.code).toBe('SYQL6006_INVALID_SORT');

    const unstable = frontendError(() =>
      validate(`query q() {
         select id, created_at from todos
        order by sortBy default newest { newest: created_at desc ; }
        limit pageSize default 10 max 20;
      }`),
    );
    expect(unstable.code).toBe('SYQL6006_INVALID_SORT');

    const randomSort = frontendError(() =>
      validate(`query q() {
         select id from todos
        order by sortBy default shuffled { shuffled: random() ; };
      }`),
    );
    expect(randomSort.code).toBe('SYQL6003_NONDETERMINISTIC_SQL');
  });

  test('infers result identity and conservatively omits it', () => {
    const inferred = validate('query q() {  select id, title from todos ; }')
      .queries[0];
    expect(inferred?.identity).toEqual(['id']);

    const aliased = validate(
      'query q() { select id as todoId, status from todos; }',
    ).queries[0];
    expect(aliased?.identity).toEqual(['todoId']);

    const noPrimary = validate('query q() { select title, status from todos; }')
      .queries[0];
    expect(noPrimary?.identity).toBeUndefined();
  });

  test('types an explicitly aliased local server version for concurrency', () => {
    const query = validate(
      'query q() { select id, _sync_version as server_version from todos; }',
    ).queries[0];
    expect(query?.analysis.columns[1]).toMatchObject({
      name: 'server_version',
      langName: 'serverVersion',
      type: 'integer',
      nullable: false,
      fidelity: 'exact',
    });
  });

  test('wraps SQLite reference failures in stable SYQL diagnostics', () => {
    const error = frontendError(() =>
      validate('query q() {  select missing from todos ; }'),
    );
    expect(error.code).toBe('SYQL6002_INVALID_SQL');
    expect(error.message).toContain('no such column');
  });
});
