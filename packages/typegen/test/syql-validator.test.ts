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

describe('revision-1 SYQL schema/SQL validation', () => {
  test('validates a complete reactive, conditional, sorted, paged query', () => {
    const result = validate(`query listTodos(
      listId,
      status?,
      cursor?(start: integer, end: integer),
      includeUnassigned?: switch,
    ) {
      sql {
        select id, title, created_at from todos
        where @cover(todos.list_id = :listId)
          and when(status) { status is :status }
          and when(cursor, includeUnassigned) {
            created_at between :start and :end
          }
      }
      sort sortBy default newest {
        newest { created_at desc, id desc }
        oldest { created_at asc, id asc }
      }
      page pageSize default 50 max 200;
      identity by id;
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
        sql {
          select id from todos
          where id = 'x' or when(status) { status = :status }
        }
      }`),
    );
    expect(underOr.code).toBe('SYQL6001_INVALID_PLACEMENT');

    const parenthesized = frontendError(() =>
      validate(`query q(status?) {
        sql {
          select id from todos
          where (when(status) { status = :status })
        }
      }`),
    );
    expect(parenthesized.code).toBe('SYQL6001_INVALID_PLACEMENT');

    const inHaving = frontendError(() =>
      validate(`query q(listId) {
        sql {
          select list_id from todos group by list_id
          having @scope(todos.list_id = :listId)
        }
      }`),
    );
    expect(inHaving.code).toBe('SYQL6001_INVALID_PLACEMENT');
  });

  test('derives reactive facts only from constructive directives', () => {
    const fallback = validate(`query q(listId) {
      sql { select id from todos where list_id = :listId }
    }`).queries[0];
    expect(fallback?.reactive.dependencies).toEqual([
      { table: 'todos', scopes: [] },
    ]);
    expect(fallback?.reactive.coverage).toEqual([]);

    const scoped = validate(`query q(listId) {
      sql {
        select id from todos where @scope(todos.list_id = :listId)
      }
    }`).queries[0];
    expect(scoped?.reactive.dependencies[0]?.scopes[0]?.params).toEqual([
      'listId',
    ]);
    expect(scoped?.reactive.coverage).toEqual([]);

    const covered = validate(`query q(roomId, left, right) {
      sql {
        select id from messages
        where @cover(
          messages.thread_id in (:left, :right),
          messages.room_id = :roomId
        )
      }
      identity by id;
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

  test('rejects incomplete, non-scope, optional, and alias-ambiguous directives', () => {
    const incomplete = frontendError(() =>
      validate(`query q(threadId) {
        sql {
          select id from messages
          where @cover(messages.thread_id = :threadId)
        }
      }`),
    );
    expect(incomplete.code).toBe('SYQL6005_INVALID_REACTIVE_DIRECTIVE');

    const nonScope = frontendError(() =>
      validate(`query q(id) {
        sql { select id from todos where @scope(todos.id = :id) }
      }`),
    );
    expect(nonScope.code).toBe('SYQL6005_INVALID_REACTIVE_DIRECTIVE');

    const optional = frontendError(() =>
      validate(`query q(listId?) {
        sql {
          select id from todos
          where when(listId) { @scope(todos.list_id = :listId) }
        }
      }`),
    );
    expect(optional.code).toBe('SYQL3006_FORBIDDEN_TEMPLATE_NODE');

    const wrongAlias = frontendError(() =>
      validate(`query q(listId) {
        sql {
          select t.id from todos as t
          where @scope(todos.list_id = :listId)
        }
      }`),
    );
    expect(wrongAlias.code).toBe('SYQL6005_INVALID_REACTIVE_DIRECTIVE');

    const nullableScope = frontendError(() =>
      validate(`query q(listId: string | null) {
        sql {
          select id from todos where @scope(todos.list_id = :listId)
        }
      }`),
    );
    expect(nullableScope.code).toBe('SYQL6005_INVALID_REACTIVE_DIRECTIVE');
  });

  test('a partially scoped self-join falls back table-wide', () => {
    const query = validate(`query q(listId) {
      sql {
        select a.id as leftId, b.id as rightId
        from todos as a join todos as b on a.list_id = b.list_id
        where @scope(a.list_id = :listId)
      }
    }`).queries[0];
    expect(query?.reactive.dependencies).toEqual([
      { table: 'todos', scopes: [] },
    ]);
    expect(query?.reactive.coverage).toEqual([]);
    expect(query?.identity).toBeUndefined();
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
          `query q() { sql { select id, ${expression} as value from todos } }`,
        ),
      );
      expect(error.code).toBe('SYQL6003_NONDETERMINISTIC_SQL');
    }
  });

  test('uses all SQL evidence for types and accepts explicit uninferrable types', () => {
    const conflict = frontendError(() =>
      validate(`query q(value) {
        sql {
          select id from todos
          where title = :value and position = :value
        }
      }`),
    );
    expect(conflict.code).toBe('SYQL6004_TYPE_CONFLICT');

    const explicit = validate(`query q(label: string) {
      sql { select :label as label, id from todos }
    }`).queries[0];
    expect(explicit?.bindTypes.get('label')?.base).toBe('string');
  });

  test('distinguishes outer sort/page conflicts from nested clauses', () => {
    const orderConflict = frontendError(() =>
      validate(`query q() {
        sql { select id from todos order by id }
        sort sortBy default byId { byId { id asc } }
      }`),
    );
    expect(orderConflict.code).toBe('SYQL6006_INVALID_SORT');

    const pageConflict = frontendError(() =>
      validate(`query q() {
        sql { select id from todos order by id limit 10 }
        page pageSize default 5 max 10;
      }`),
    );
    expect(pageConflict.code).toBe('SYQL6007_INVALID_PAGE');

    const nested = validate(`query q() {
      sql {
        select id from todos
        where id in (select id from todos order by id limit 1)
      }
      sort sortBy default byId { byId { id asc } }
    }`);
    expect(nested.queries[0]?.sort?.defaultProfile).toBe('byId');
  });

  test('requires deterministic identity suffixes for bounded queries', () => {
    const missingIdentity = frontendError(() =>
      validate(`query q() {
        sql { select title from todos }
        sort sortBy default byTitle { byTitle { title asc } }
        page pageSize default 10 max 20;
      }`),
    );
    expect(missingIdentity.code).toBe('SYQL6006_INVALID_SORT');

    const unstable = frontendError(() =>
      validate(`query q() {
        sql { select id, created_at from todos }
        sort sortBy default newest { newest { created_at desc } }
        page pageSize default 10 max 20;
        identity by id;
      }`),
    );
    expect(unstable.code).toBe('SYQL6006_INVALID_SORT');

    const randomSort = frontendError(() =>
      validate(`query q() {
        sql { select id from todos }
        sort sortBy default shuffled { shuffled { random() } }
        identity by id;
      }`),
    );
    expect(randomSort.code).toBe('SYQL6003_NONDETERMINISTIC_SQL');
  });

  test('proves or conservatively omits result identity', () => {
    const inferred = validate(
      'query q() { sql { select id, title from todos } }',
    ).queries[0];
    expect(inferred?.identity).toEqual(['id']);

    const nullable = frontendError(() =>
      validate(`query q() {
        sql { select id, status from todos }
        identity by status;
      }`),
    );
    expect(nullable.code).toBe('SYQL6008_INVALID_IDENTITY');

    const noPrimary = frontendError(() =>
      validate(`query q() {
        sql { select id, title from todos }
        identity by title;
      }`),
    );
    expect(noPrimary.code).toBe('SYQL6008_INVALID_IDENTITY');
  });

  test('wraps SQLite reference failures in stable SYQL diagnostics', () => {
    const error = frontendError(() =>
      validate('query q() { sql { select missing from todos } }'),
    );
    expect(error.code).toBe('SYQL6002_INVALID_SQL');
    expect(error.message).toContain('no such column');
  });
});
