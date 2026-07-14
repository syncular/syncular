import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  analyzeSyqlSemantics,
  buildSyqlModuleGraph,
  emitQueriesDartModule,
  emitQueriesKotlinModule,
  emitQueriesModule,
  emitQueriesSwiftModule,
  type IrDocument,
  lowerSyqlQuery,
  type QueryDb,
  type QuerySyqlExecutionPlan,
  type QuerySyqlStatement,
  serializeQueryIr,
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
        { name: 'status', type: 'string', nullable: true },
        { name: 'created_at', type: 'integer', nullable: false },
        { name: 'assignee_id', type: 'string', nullable: true },
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

const sqlite = new Database(':memory:');
sqlite.run(synthesizeDdl(IR));
const db: QueryDb = {
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

sqlite.run(`
  insert into todos (id, list_id, status, created_at, assignee_id) values
    ('t1', 'l1', null,   100, null),
    ('t2', 'l1', 'open', 200, 'u1'),
    ('t3', 'l1', 'done', 300, null),
    ('t4', 'l1', 'open', 400, 'u2'),
    ('t5', 'l2', 'open', 500, null)
`);

const SOURCE = `query findTodos(
  listId,
  status?: string | null,
  range?(start: integer, end: integer),
  unassigned?: switch,
) {
  sql {
    select id, status, created_at from todos
    where @scope(todos.list_id = :listId)
      and when(status) { status is :status }
      and when(range) { created_at between :start and :end }
      and when(unassigned) { assignee_id is null }
  }
  sort sortBy default newest {
    newest { created_at desc, id desc }
    oldest { created_at asc, id asc }
  }
  page pageSize default 20 max 50;
  identity by id;
}`;

function validated() {
  const root = resolve('/virtual/syql-lowering');
  const file = resolve(root, 'find.syql');
  const graph = buildSyqlModuleGraph(root, ['find.syql'], (candidate) =>
    candidate === file ? SOURCE : undefined,
  );
  const program = validateSyqlProgram(analyzeSyqlSemantics(graph), IR, db, {
    naming: 'camel',
    targets: ['ts'],
  });
  return program.queries[0] as NonNullable<(typeof program.queries)[number]>;
}

interface Environment {
  readonly mask: number;
  readonly sort: 'newest' | 'oldest';
  readonly status: string | null;
  readonly pageSize?: number;
}

function statementFor(
  plan: QuerySyqlExecutionPlan,
  environment: Environment,
): QuerySyqlStatement {
  const statement = plan.statements.find(
    (candidate) =>
      candidate.sortProfile === environment.sort &&
      (plan.backend === 'neutralize' ||
        candidate.activationMask === environment.mask),
  );
  if (statement === undefined) throw new Error('statement missing');
  return statement;
}

function rows(
  plan: QuerySyqlExecutionPlan,
  environment: Environment,
): unknown[] {
  const statement = statementFor(plan, environment);
  const active = new Set(
    plan.activationControls.filter(
      (_, index) => (environment.mask & (2 ** index)) !== 0,
    ),
  );
  const values = statement.binds.map((bind) => {
    if (bind.kind === 'condition-active') {
      return bind.controls.every((control) => active.has(control)) ? 1 : 0;
    }
    if (bind.kind === 'page') return environment.pageSize ?? 20;
    if (bind.kind === 'value') {
      if (bind.input === 'listId') return 'l1';
      if (bind.input === 'status') return environment.status;
    }
    if (bind.kind === 'group-member') {
      if (bind.member === 'start') return 150;
      if (bind.member === 'end') return 450;
    }
    return null;
  });
  const statementHandle = sqlite.prepare(statement.positionalSql);
  try {
    return statementHandle.all(...values);
  } finally {
    statementHandle.finalize();
  }
}

describe('revision-1 SYQL lowering', () => {
  test('serializes a target-neutral public input and physical-plan boundary', () => {
    const lowered = lowerSyqlQuery(validated(), IR, db, {
      naming: 'camel',
      targets: ['ts'],
      backend: 'auto',
    });
    expect(lowered.selected.backend).toBe('neutralize');
    expect(lowered.analysis.syql?.revision).toBe(1);
    expect(lowered.analysis.syql?.inputs).toEqual([
      {
        kind: 'value',
        name: 'listId',
        langName: 'listId',
        type: 'string',
        nullable: false,
        required: true,
      },
      {
        kind: 'value',
        name: 'status',
        langName: 'status',
        type: 'string',
        nullable: true,
        required: false,
      },
      {
        kind: 'group',
        name: 'range',
        langName: 'range',
        members: [
          {
            name: 'start',
            langName: 'start',
            type: 'integer',
            nullable: false,
          },
          {
            name: 'end',
            langName: 'end',
            type: 'integer',
            nullable: false,
          },
        ],
      },
      {
        kind: 'switch',
        name: 'unassigned',
        langName: 'unassigned',
        default: false,
      },
      {
        kind: 'sort',
        name: 'sortBy',
        langName: 'sortBy',
        defaultProfile: 'newest',
        profiles: [
          { name: 'newest', langName: 'newest' },
          { name: 'oldest', langName: 'oldest' },
        ],
      },
      {
        kind: 'page',
        name: 'pageSize',
        langName: 'pageSize',
        defaultSize: 20,
        maxSize: 50,
      },
    ]);
    expect(lowered.neutralized.statements).toHaveLength(2);
    expect(lowered.enumerated?.statements).toHaveLength(16);
    expect(lowered.neutralized.statements[0]?.sql).toContain(
      'case when :__syqlActive0 = 0 then 1',
    );
    expect(lowered.neutralized.statements[0]?.sql).not.toContain(
      ':status is null or',
    );
    expect(
      lowered.analysis.syql?.inputs.some((input) =>
        input.name.startsWith('__syql'),
      ),
    ).toBe(false);
    expect(lowered.analysis.reactive.rowKey).toEqual(['id']);
    const serialized = JSON.parse(serializeQueryIr([lowered.analysis]));
    expect(serialized.queryIrVersion).toBe(3);
    expect(serialized.queries[0].syql.plan.backend).toBe('neutralize');
    expect(serialized.queries[0].syql.inputs[1]).toMatchObject({
      name: 'status',
      nullable: true,
      required: false,
    });
  });

  test('neutralized and enumerated backends execute equivalently', () => {
    const lowered = lowerSyqlQuery(validated(), IR, db, {
      naming: 'camel',
      targets: ['ts'],
      backend: 'neutralize',
    });
    const enumerated = lowered.enumerated as QuerySyqlExecutionPlan;
    for (let mask = 0; mask < 8; mask += 1) {
      for (const sort of ['newest', 'oldest'] as const) {
        const environment = { mask, sort, status: null };
        expect(rows(lowered.neutralized, environment)).toEqual(
          rows(enumerated, environment),
        );
      }
    }
    // Bit zero is status. Present(null) must activate `status IS NULL`, while
    // absence leaves the predicate inactive even though both bind null.
    expect(
      rows(enumerated, { mask: 0, sort: 'oldest', status: null }),
    ).toHaveLength(4);
    expect(rows(enumerated, { mask: 1, sort: 'oldest', status: null })).toEqual(
      [{ id: 't1', status: null, createdAt: 100 }],
    );
  });

  test('forced variants selects the finite matrix and page remains a bind', () => {
    const lowered = lowerSyqlQuery(
      validated(),
      IR,
      db,
      { naming: 'camel', targets: ['ts'] },
      { backend: 'variants' },
    );
    expect(lowered.selected.backend).toBe('variants');
    expect(
      lowered.selected.statements.every((statement) =>
        statement.binds.some((bind) => bind.kind === 'page'),
      ),
    ).toBe(true);
    expect(
      rows(lowered.selected, {
        mask: 0,
        sort: 'newest',
        status: null,
        pageSize: 2,
      }),
    ).toHaveLength(2);
  });

  test('every emitter consumes the same selected plan and public shape', () => {
    const query = lowerSyqlQuery(validated(), IR, db, {
      naming: 'camel',
      targets: ['ts', 'swift', 'kotlin', 'dart'],
      backend: 'neutralize',
    }).analysis;
    const ts = emitQueriesModule([query], 'sha256:test', 1);
    const swift = emitQueriesSwiftModule(
      [query],
      'sha256:test',
      1,
      'TestSchema',
    );
    const kotlin = emitQueriesKotlinModule(
      [query],
      'sha256:test',
      1,
      'dev.syncular.test',
      'TestSchema',
    );
    const dart = emitQueriesDartModule([query], 'sha256:test', 1);

    expect(() =>
      new Bun.Transpiler({ loader: 'ts' }).transformSync(ts),
    ).not.toThrow();
    expect(ts).toContain('status?: SyqlPresent<string | null>');
    expect(ts).toContain('start: bigint');
    expect(ts).toContain('SYQL_RUNTIME_INVALID_PAGE');
    expect(swift).toContain('SyncularQueryPresence<String?>');
    expect(swift).toContain('public let start: Int64');
    expect(kotlin).toContain('SyncularQueryPresence<String?>');
    expect(kotlin).toContain('val start: Long');
    expect(dart).toContain('SyqlQueryPresence<String?>');
    for (const output of [ts, swift, kotlin, dart]) {
      expect(output).toContain(
        query.syql?.plan.statements[0]?.positionalSql as string,
      );
      expect(output).toContain('invalid generated SYQL statement index');
    }
  });
});
