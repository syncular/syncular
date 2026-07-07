/**
 * The `.syql` frontend (DESIGN-queries.md §3–§7): parsing, fragment splice
 * with optional-param propagation, auto-guarded conjuncts + the `if`
 * primitive, the B1 placement validator, knobs, and the dual-frontend
 * equivalence contract (§1: same query in `.sql` and `.syql` → identical IR
 * below the frontend).
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  analyzeQuery,
  analyzeSyqlFile,
  emitQueriesModule,
  type IrDocument,
  parseSyqlFile,
  type QueryDb,
  serializeQueryIr,
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
        { name: 'status', type: 'string', nullable: true },
        { name: 'done', type: 'boolean', nullable: false },
        { name: 'position', type: 'integer', nullable: false },
        { name: 'created_at', type: 'integer', nullable: false },
        { name: 'assignee_id', type: 'string', nullable: true },
        { name: 'archived_at', type: 'integer', nullable: true },
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
const NAMING = { naming: 'camel' as const, targets: ['ts' as const] };
const analyzeSyql = (content: string) =>
  analyzeSyqlFile('todos.syql', content, IR, db, NAMING);

describe('parseSyqlFile — the container grammar', () => {
  test('queries + fragments, signatures, knobs', () => {
    const file = parseSyqlFile(
      'x.syql',
      `
      -- a comment between declarations is fine
      fragment visibleIn(listId) {
        list_id = :listId and archived_at is null
      }

      query listTodos(listId, status?, from+to?, unassigned?: flag)
        orderBy position | created_at | title default position
        limit max 200 default 50
      {
        select id, title from todos where @visibleIn(:listId)
      }
      `,
    );
    expect(file.fragments.map((f) => f.name)).toEqual(['visibleIn']);
    const q = file.queries[0];
    expect(q?.name).toBe('listTodos');
    expect(q?.params).toEqual([
      { name: 'listId', optional: false, flag: false },
      { name: 'status', optional: true, flag: false },
      { name: 'from', optional: true, group: 'from', flag: false },
      { name: 'to', optional: true, group: 'from', flag: false },
      { name: 'unassigned', optional: true, flag: true },
    ]);
    expect(q?.orderBy).toEqual({
      allowed: ['position', 'created_at', 'title'],
      defaultColumn: 'position',
      defaultDir: 'asc',
    });
    expect(q?.limit).toEqual({ max: 200, default: 50 });
  });

  test('a non-flag annotation is rejected', () => {
    expect(() =>
      parseSyqlFile('x.syql', 'query q(a?: string) { select 1 }'),
    ).toThrow(/`: flag` is the only param annotation/);
  });

  test('a required group is rejected (groups are optional by nature)', () => {
    expect(() =>
      parseSyqlFile('x.syql', 'query q(from+to) { select 1 }'),
    ).toThrow(/must be optional/);
  });

  test('an orderBy default outside the allowlist is rejected', () => {
    expect(() =>
      parseSyqlFile('x.syql', 'query q() orderBy a | b default c { select 1 }'),
    ).toThrow(/not in the allowlist/);
  });
});

describe('lowering — auto-guards, if, fragments (§4/§7 neutralization)', () => {
  test('an optional conjunct lowers to (:p is null or (…))', () => {
    const [q] = analyzeSyql(`
      query byStatus(listId, status?) {
        select id, title from todos
        where list_id = :listId
          and status = :status
      }
    `);
    expect(q?.sql).toContain('where list_id = :listId');
    expect(q?.sql).toContain('(:status is null or (status = :status))');
    expect(q?.params).toEqual([
      {
        name: 'listId',
        langName: 'listId',
        type: 'string',
        source: 'inferred',
      },
      {
        name: 'status',
        langName: 'status',
        type: 'string',
        source: 'inferred',
        optional: true,
      },
    ]);
  });

  test('a from+to group guards on BOTH params (BETWEEN stays one conjunct)', () => {
    const [q] = analyzeSyql(`
      query inRange(listId, from+to?) {
        select id from todos
        where list_id = :listId
          and created_at between :from and :to
      }
    `);
    expect(q?.sql).toContain(
      '(:from is null or :to is null or (created_at between :from and :to))',
    );
    // BETWEEN typing: both endpoints take created_at's integer type.
    expect(q?.params.map((p) => [p.name, p.type, p.optional ?? false])).toEqual(
      [
        ['listId', 'string', false],
        ['from', 'integer', true],
        ['to', 'integer', true],
      ],
    );
  });

  test('a flag guards via if — and binds as a boolean truth test', () => {
    const [q] = analyzeSyql(`
      query unassignedOnly(listId, unassigned?: flag) {
        select id from todos
        where list_id = :listId
          and if (:unassigned) { assignee_id is null }
      }
    `);
    expect(q?.sql).toContain(
      '(coalesce(:unassigned, 0) = 0 or (assignee_id is null))',
    );
    const flag = q?.params.find((p) => p.name === 'unassigned');
    expect(flag).toMatchObject({ type: 'boolean', flag: true, optional: true });
  });

  test('a fragment splices with param renaming + optional propagation', () => {
    const [q] = analyzeSyql(`
      fragment visibleIn(l) {
        list_id = :l and archived_at is null
      }
      fragment search(q?) {
        title like '%' || :q || '%'
      }
      query listTodos(listId) {
        select id, title from todos
        where @visibleIn(:listId)
          and @search(:needle)
      }
    `);
    // visibleIn's :l renamed to :listId; search's :q renamed to :needle.
    expect(q?.sql).toContain('(list_id = :listId and archived_at is null)');
    expect(q?.sql).toContain(
      "(:needle is null or ((title like '%' || :needle || '%')))",
    );
    // :needle was INJECTED into the signature as optional (from `q?`).
    const needle = q?.params.find((p) => p.name === 'needle');
    expect(needle).toMatchObject({ optional: true, type: 'string' });
  });

  test('B1: an optional param under an OR is a loud error', () => {
    expect(() =>
      analyzeSyql(`
        query bad(listId, status?) {
          select id from todos
          where list_id = :listId
            and (status = :status or done = 1)
        }
      `),
    ).toThrow(/sits under an OR/);
  });

  test('B1: an optional param inside a subquery is a loud error', () => {
    expect(() =>
      analyzeSyql(`
        query bad(listId, other?) {
          select id from todos
          where list_id = :listId
            and id in (select id from todos where list_id = :other)
        }
      `),
    ).toThrow(/inside a subquery/);
  });

  test('B1: an optional param outside the WHERE is a loud error', () => {
    expect(() =>
      analyzeSyql(`
        query bad(listId, label?) {
          select id, :label as tag from todos where list_id = :listId
        }
      `),
    ).toThrow(/outside the WHERE clause/);
  });

  test('a flag in a plain predicate is a loud error', () => {
    expect(() =>
      analyzeSyql(`
        query bad(listId, f?: flag) {
          select id from todos where list_id = :listId and done = :f
        }
      `),
    ).toThrow(/cannot appear in a predicate/);
  });

  test('a declared-but-unused param is a loud error', () => {
    expect(() =>
      analyzeSyql(`
        query bad(listId, ghost?) {
          select id from todos where list_id = :listId
        }
      `),
    ).toThrow(/declared but never used/);
  });
});

describe('knobs (§6)', () => {
  const FILE = `
    query page(listId, before?)
      orderBy created_at | position default created_at desc
      limit max 100 default 50
    {
      select id, title, created_at from todos
      where list_id = :listId
        and created_at < :before
    }
  `;

  test('orderBy + limit lower to a checked default tail + a bound limit', () => {
    const [q] = analyzeSyql(FILE);
    // :before repeats (guard + predicate), so the whole statement uses
    // SQLite's numbered form — one bound value per DISTINCT param.
    expect(q?.positionalSql).toBe(
      `${q?.positionalSqlBase} order by created_at desc limit min(coalesce(?3, 50), 100)`,
    );
    expect(q?.positionalSqlBase).toContain('(?2 is null or (created_at < ?2))');
    expect(q?.orderBy).toEqual({
      allowed: [
        { name: 'created_at', langName: 'createdAt' },
        { name: 'position', langName: 'position' },
      ],
      defaultColumn: 'created_at',
      defaultDir: 'desc',
    });
    expect(q?.limit).toEqual({ max: 100, default: 50 });
    // The keyset param stays an ordinary auto-guarded optional (§6: no
    // offset knob — pagination is keyset).
    expect(q?.sql).toContain('(:before is null or (created_at < :before))');
    // The limit bind is positionally LAST.
    expect(q?.params[q.params.length - 1]?.name).toBe('limit');
  });

  test('an unknown orderBy column is rejected BY SQLITE at generate time', () => {
    expect(() =>
      analyzeSyql(`
        query q(listId) orderBy nope default nope {
          select id from todos where list_id = :listId
        }
      `),
    ).toThrow(/orderBy column "nope" rejected by SQLite/);
  });

  test('a body ORDER BY + an orderBy knob is a conflict', () => {
    expect(() =>
      analyzeSyql(`
        query q(listId) orderBy position default position {
          select id from todos where list_id = :listId order by id
        }
      `),
    ).toThrow(/one or the other/);
  });

  test('the generated TS composes from the baked allowlist', () => {
    const queries = analyzeSyql(FILE);
    const module = emitQueriesModule(queries, 'sha256:test', 1);
    expect(module).toContain(
      "const pageOrderColumns = { createdAt: 'created_at', position: 'position' } as const;",
    );
    expect(module).toContain("orderBy?: 'createdAt' | 'position';");
    expect(module).toContain("dir?: 'asc' | 'desc';");
    expect(module).toContain('limit?: number;');
    // The default + clamp live IN the SQL; the runtime binds limit ?? null.
    expect(module).toContain('params.limit ?? null');
    expect(module).toContain('limit min(coalesce(?3, 50), 100)');
    expect(module).toContain('sqlFor:');
  });
});

describe('the lowered SQL actually runs (neutralization semantics)', () => {
  const sqlite = new Database(':memory:');
  sqlite.run(synthesizeDdl(IR));
  const insert = sqlite.prepare(
    `INSERT INTO todos (id, list_id, title, status, done, position, created_at, assignee_id, archived_at)
     VALUES (?, 'l1', ?, ?, 0, ?, ?, ?, NULL)`,
  );
  insert.run('t1', 'alpha', 'open', 1, 100, null);
  insert.run('t2', 'beta', 'done', 2, 200, 'u1');
  insert.run('t3', 'alpha two', 'open', 3, 300, null);

  const [q] = analyzeSyqlFile(
    'runtime.syql',
    `query find(listId, status?, needle?, unassigned?: flag)
       orderBy created_at | position default created_at desc
       limit max 2 default 2
     {
       select id from todos
       where list_id = :listId
         and status = :status
         and title like '%' || :needle || '%'
         and if (:unassigned) { assignee_id is null }
     }`,
    IR,
    db,
    NAMING,
  );
  if (q === undefined) throw new Error('unreachable');

  // Mirrors the generated runner: base + selected order + limit tail.
  const run = (
    binds: (string | number | null)[],
    orderColumn = 'created_at',
    dir = 'desc',
  ): string[] => {
    const sql = `${q.positionalSqlBase} order by ${orderColumn} ${dir}${q.positionalLimitTail ?? ''}`;
    const stmt = sqlite.prepare(sql);
    const rows = stmt.all(...binds) as { id: string }[];
    stmt.finalize();
    return rows.map((r) => r.id);
  };

  // Positional binds: listId ?1, status ?2, needle ?3, unassigned ?4, limit ?5.
  test('all optionals omitted → newest two (limit default clamps the page)', () => {
    expect(run(['l1', null, null, null, null])).toEqual(['t3', 't2']);
  });
  test('a provided optional applies its conjunct', () => {
    expect(run(['l1', 'done', null, null, null])).toEqual(['t2']);
  });
  test('the flag applies its if-guard only when true', () => {
    expect(run(['l1', null, null, 1, null])).toEqual(['t3', 't1']);
    expect(run(['l1', null, null, 0, null])).toEqual(['t3', 't2']);
  });
  test('the needle search composes with other guards', () => {
    expect(run(['l1', null, 'alpha', null, null])).toEqual(['t3', 't1']);
  });
  test('limit binds and clamps to max', () => {
    expect(run(['l1', null, null, null, 1])).toEqual(['t3']);
    expect(run(['l1', null, null, null, 99])).toEqual(['t3', 't2']); // clamped to 2
  });
  test('an orderBy variant selects a different checked column', () => {
    expect(run(['l1', null, null, null, null], 'position', 'asc')).toEqual([
      't1',
      't2',
    ]);
  });
});

describe('dual-frontend equivalence (§1)', () => {
  test('the same static query in .sql and .syql yields identical IR below the frontend', () => {
    const sqlUnit = analyzeQuery(
      'list-by-status.sql',
      'select id, title, created_at from todos where list_id = :listId and status = :status',
      IR,
      db,
      NAMING,
    );
    const [syqlUnit] = analyzeSyqlFile(
      'list-by-status.syql',
      `query listByStatus(listId, status) {
         select id, title, created_at from todos where list_id = :listId and status = :status
       }`,
      IR,
      db,
      NAMING,
    );
    // Frontend-owned fields differ (name/file/sourceSql); everything below
    // the IR boundary must be byte-identical.
    const normalize = (json: string) =>
      JSON.parse(json.replace(/"listByStatus"/g, '"listByStatus"')) as {
        queries: Record<string, unknown>[];
      };
    const a = normalize(
      serializeQueryIr([{ ...sqlUnit, name: 'x', file: 'f', sourceSql: 's' }]),
    );
    const b = normalize(
      serializeQueryIr([
        {
          ...(syqlUnit as NonNullable<typeof syqlUnit>),
          name: 'x',
          file: 'f',
          sourceSql: 's',
        },
      ]),
    );
    expect(a).toEqual(b);
  });
});
