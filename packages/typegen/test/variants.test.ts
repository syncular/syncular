/**
 * The §7 variant-enumeration backend (Q4): 2^N checked statements, one per
 * combination of provided optional groups, semantically identical to the
 * default neutralization backend BY EXECUTION — every combination runs
 * against both backends over seeded data and must return identical rows.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  analyzeSyqlFile,
  emitQueriesModule,
  type IrDocument,
  type QueryDb,
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
const NAMING = { naming: 'camel' as const, targets: ['ts' as const] };

const FILE = `
  query find(listId, status?, from+to?, unassigned?: flag) variants
    limit max 10 default 10
  {
    select id from todos
    where list_id = :listId
      and status = :status
      and created_at between :from and :to
      and if (:unassigned) { assignee_id is null }
    order by created_at, id
  }
`;

// Seed rows spanning every dimension.
const seed = sqlite.prepare(
  `INSERT INTO todos (id, list_id, title, status, done, created_at, assignee_id)
   VALUES (?, 'l1', ?, ?, 0, ?, ?)`,
);
seed.run('t1', 'a', 'open', 100, null);
seed.run('t2', 'b', 'done', 200, 'u1');
seed.run('t3', 'c', 'open', 300, null);
seed.run('t4', 'd', null, 400, 'u2');

const [q] = analyzeSyqlFile('variants.syql', FILE, IR, db, NAMING);
if (q === undefined || q.variants === undefined) {
  throw new Error('variants missing');
}

describe('§7 variant enumeration', () => {
  test('2^N variants, each a checked statement with its own param set', () => {
    // 3 groups: status, from+to (one group), unassigned → 8 variants.
    expect(q.variantGroups?.map((g) => g.key)).toEqual([
      'status',
      'from',
      'unassigned',
    ]);
    expect(q.variants).toHaveLength(8);
    const none = q.variants?.[0];
    expect(none?.when).toEqual([]);
    expect(none?.params).toEqual(['listId', 'limit']);
    const all = q.variants?.[7];
    expect(all?.when).toEqual(['status', 'from', 'unassigned']);
    expect(all?.params).toEqual(['listId', 'status', 'from', 'to', 'limit']);
    // A provided-variant conjunct is RAW — no neutralization guard.
    expect(all?.sql).toContain('status = :status');
    expect(all?.sql).not.toContain(':status is null');
  });

  test('EVERY combination: variant results ≡ neutralization results', () => {
    interface Combo {
      status: string | null;
      from: number | null;
      to: number | null;
      unassigned: boolean;
    }
    const combos: Combo[] = [];
    for (const status of [null, 'open']) {
      for (const range of [
        [null, null],
        [150, 350],
      ] as const) {
        for (const unassigned of [false, true]) {
          combos.push({
            status,
            from: range[0],
            to: range[1],
            unassigned,
          });
        }
      }
    }
    const run = (sql: string, binds: unknown[]): string[] => {
      const stmt = sqlite.prepare(sql);
      const rows = stmt.all(...(binds as never[])) as { id: string }[];
      stmt.finalize();
      return rows.map((r) => r.id);
    };
    for (const combo of combos) {
      // Neutralization: bind every param (guards neutralize the absent).
      const neutral = run(q.positionalSql, [
        'l1',
        combo.status,
        combo.from,
        combo.to,
        combo.unassigned,
        null, // limit → SQL-side default
      ]);
      // Variant: dispatch by provided-ness, bind only that variant's params.
      let mask = 0;
      if (combo.status !== null) mask |= 1;
      if (combo.from !== null && combo.to !== null) mask |= 2;
      if (combo.unassigned) mask |= 4;
      const variant = q.variants?.[mask];
      if (variant === undefined) throw new Error(`no variant ${mask}`);
      const values: Record<string, unknown> = {
        listId: 'l1',
        status: combo.status,
        from: combo.from,
        to: combo.to,
        limit: null,
      };
      const byMask = run(
        variant.positionalSql,
        variant.params.map((name) => values[name]),
      );
      expect(byMask).toEqual(neutral);
    }
  });

  test('the generated TS dispatches on the bitmask', () => {
    const module = emitQueriesModule([q], 'sha256:test', 1);
    expect(module).toContain('const findVariants:');
    expect(module).toContain('(params?.status ?? null) !== null) mask |= 1');
    expect(module).toContain(
      '(params?.from ?? null) !== null && (params?.to ?? null) !== null) mask |= 2',
    );
    expect(module).toContain('params?.unassigned === true) mask |= 4');
    expect(module).toContain(
      'sqlFor: (params: FindParams) => findSelectVariant(params).sql',
    );
  });

  test('variants + orderBy knob is a loud conflict', () => {
    expect(() =>
      analyzeSyqlFile(
        'bad.syql',
        `query q(listId, status?) variants orderBy created_at default created_at {
           select id from todos where list_id = :listId and status = :status
         }`,
        IR,
        db,
        NAMING,
      ),
    ).toThrow(/cannot combine/);
  });

  test('variants without any optional param is a loud error', () => {
    expect(() =>
      analyzeSyqlFile(
        'bad.syql',
        `query q(listId) variants {
           select id from todos where list_id = :listId
         }`,
        IR,
        db,
        NAMING,
      ),
    ).toThrow(/at least one optional param/);
  });

  test('more than 8 optional groups is a loud error', () => {
    const params = Array.from({ length: 9 }, (_, i) => `p${i}?`).join(', ');
    const preds = Array.from(
      { length: 9 },
      (_, i) => `and if (:p${i}) { done = 0 }`,
    ).join('\n         ');
    expect(() =>
      analyzeSyqlFile(
        'bad.syql',
        `query q(listId, ${params.replace(/\?/g, '?: flag')}) variants {
           select id from todos
           where list_id = :listId
         ${preds}
         }`,
        IR,
        db,
        NAMING,
      ),
    ).toThrow(/design smell/);
  });
});
