/**
 * Storage query-cost regressions on all three backends: scope values bind as
 * one parameter (D4), SQLite-family scope scans seek the inverted index (D6),
 * a D1 push reads its rows in one batch (D7), pruning deletes change-scope
 * entries by key (D9), and the admin reads issue one statement per page
 * (D11). Counts are statements and `db.batch` calls, plans come from
 * `EXPLAIN`; nothing measures wall-clock time.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  canonicalScopeJson,
  encodeRow,
  type SegmentRefFrame,
} from '@syncular/core';
import {
  compileSchema,
  countRowsSql,
  D1ServerStorage,
  type D1PreparedStatement,
  handleSegmentDownload,
  type PgExecutor,
  PostgresServerStorage,
  scanRowPageSql,
  type ServerStorage,
  SqliteServerStorage,
  type SqliteStatement,
  type SqliteValue,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { BunSqliteDatabase } from '@syncular/server/sqlite';
import { D1DatabaseDouble } from './d1-double';
import { CONTRACT_SCHEMA } from './storage-contract';
import { deleteSqliteRowScopesSql } from '../src/relational-rows';
import { readLiveWindowPages } from '../src/storage-query';
import {
  makeContext,
  pullFrames,
  pushCommit,
  pushResults,
  section,
  seedTask,
  sync,
  taskRow,
  TEST_LOG_EPOCH,
  TEST_SCHEMA,
  upsert,
} from './helpers';

const PARTITION = 'part-1';
const NOW = 1_750_000_000_000;
const COMPILED = compileSchema(CONTRACT_SCHEMA);
const DOCS_COLUMNS = CONTRACT_SCHEMA.tables[1]!.columns;
const TASKS_COLUMNS = CONTRACT_SCHEMA.tables[0]!.columns;

/** Records every statement text the SQLite storage runs. */
class RecordingSqlite extends BunSqliteDatabase {
  readonly statements: string[] = [];

  override exec(sql: string): void {
    this.statements.push(sql);
    super.exec(sql);
  }

  override run(sql: string, bindings: readonly SqliteValue[] = []) {
    this.statements.push(sql);
    return super.run(sql, bindings);
  }

  override query<Row, Params extends readonly SqliteValue[]>(
    sql: string,
  ): SqliteStatement<Row, Params> {
    this.statements.push(sql);
    return super.query<Row, Params>(sql);
  }
}

/** The D1 double, counting `batch` calls and keeping every batched statement. */
class BatchCountingD1 extends D1DatabaseDouble {
  batches = 0;
  readonly batched: string[] = [];

  constructor(db: Database) {
    super(db);
    this.beforeBatchStatement = (sql) => this.batched.push(sql);
  }

  override async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    this.batches++;
    return super.batch(statements);
  }
}

/** A D1 whose statements reject more bound parameters than the 100 D1 allows. */
class CappedD1 extends D1DatabaseDouble {
  override prepare(query: string): D1PreparedStatement {
    const statement = super.prepare(query);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      if (values.length > 100) throw new Error('D1: too many bound parameters');
      return bind(...values);
    };
    return statement;
  }
}

function countingExecutor(inner: PgExecutor): {
  executor: PgExecutor;
  texts: string[];
} {
  const texts: string[] = [];
  return {
    texts,
    executor: {
      query: (text, params) => {
        texts.push(text);
        return inner.query(text, params);
      },
      transaction: (fn) =>
        inner.transaction((client) =>
          fn({
            query: (text, params) => {
              texts.push(text);
              return client.query(text, params);
            },
          }),
        ),
    },
  };
}

interface Backend {
  readonly storage: ServerStorage;
  /** Statements run since the last call. */
  readonly drain: () => string[];
  /** All rows of a raw query against the backing database. */
  readonly raw: (
    sql: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
  /** The plan of a statement run against the backing database. */
  readonly plan: (
    sql: string,
    params: unknown[],
    settings?: string,
  ) => Promise<string[]>;
}

async function backend(kind: 'sqlite' | 'd1' | 'postgres'): Promise<Backend> {
  if (kind === 'postgres') {
    const db = await PGlite.create();
    const counting = countingExecutor(pgliteExecutor(db));
    const storage = new PostgresServerStorage(counting.executor);
    await storage.ensureSchema(COMPILED);
    counting.texts.length = 0;
    return {
      storage,
      drain: () => counting.texts.splice(0),
      raw: async (sql, params) =>
        (await db.query<Record<string, unknown>>(sql, params)).rows,
      plan: async (sql, params, settings = '') => {
        await db.exec('BEGIN');
        await db.exec(`SET LOCAL enable_seqscan = off;${settings}`);
        const result = await db.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN ${sql}`,
          params,
        );
        await db.exec('COMMIT');
        return result.rows.map((row) => row['QUERY PLAN']);
      },
    };
  }
  const native = new Database(':memory:');
  const planOf = async (sql: string, params: unknown[]) =>
    native
      .query<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as never[]))
      .map((row) => row.detail);
  const raw = async (sql: string, params: unknown[] = []) =>
    native
      .query<Record<string, unknown>, never[]>(sql)
      .all(...(params as never[]));
  if (kind === 'sqlite') {
    const db = new RecordingSqlite(native);
    const storage = new SqliteServerStorage(db);
    await storage.ensureSchema(COMPILED);
    db.statements.length = 0;
    return {
      storage,
      drain: () => db.statements.splice(0),
      raw,
      plan: planOf,
    };
  }
  const double = new BatchCountingD1(native);
  const storage = new D1ServerStorage(double, { pushApplySerialized: true });
  while (!(await storage.migrateSchema(COMPILED)).complete) {}
  let seen = 0;
  return {
    storage,
    // D1 counts statements per execution; a batch is one call of many.
    drain: () => {
      const executed = double.statementsExecuted - seen;
      seen = double.statementsExecuted;
      return new Array<string>(executed).fill('statement');
    },
    raw,
    plan: planOf,
  };
}

const KINDS = ['sqlite', 'd1', 'postgres'] as const;

async function seedCommits(
  storage: ServerStorage,
  count: number,
  scopes: (i: number) => Record<string, string> = () => ({ project_id: 'p1' }),
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const tx = await storage.begin(PARTITION);
    await tx.appendCommit({
      clientId: 'c',
      clientCommitId: `k${i}`,
      actorId: 'a',
      createdAtMs: NOW + i,
      changes: ['a', 'b'].map((suffix) => ({
        table: 'tasks',
        rowId: `r${i}${suffix}`,
        op: 'upsert' as const,
        rowVersion: 1,
        scopes: scopes(i),
        payload: new Uint8Array([i]),
      })),
    });
    await tx.commit();
  }
}

for (const kind of KINDS) {
  test(`${kind} listCommitMetadata and scopeActivity issue one statement per page (D11)`, async () => {
    const { storage, drain } = await backend(kind);
    await seedCommits(storage, 12);
    const statements = async (limit: number) => {
      drain();
      const page = await storage.listCommitMetadata!(PARTITION, {
        afterSeq: 0,
        limit,
        changeSample: 1,
      });
      expect(page).toHaveLength(limit);
      return drain().length;
    };
    const small = await statements(2);
    const large = await statements(12);
    // commit list + grouped change counts + change sample
    expect(small).toBeLessThanOrEqual(3);
    expect(large).toBe(small);
    const [newest] = await storage.listCommitMetadata!(PARTITION, {
      afterSeq: 0,
      limit: 1,
      changeSample: 1,
    });
    expect(newest).toMatchObject({
      commitSeq: 12,
      changeCount: 2,
      tables: ['tasks'],
      sample: [{ table: 'tasks', rowId: 'r11a', op: 'upsert' }],
    });

    const activity = async (limit: number) => {
      drain();
      const page = await storage.scopeActivity!(PARTITION, {
        variable: 'project_id',
        value: 'p1',
        limit,
      });
      expect(page).toHaveLength(limit);
      expect(page[0]).toMatchObject({
        commitSeq: 12,
        table: 'tasks',
        actorId: 'a',
        changeCount: 2,
      });
      return drain().length;
    };
    expect(await activity(2)).toBe(1);
    expect(await activity(12)).toBe(1);
  });

  test(`${kind} listRowsReferencingBlob issues one statement for any reference count (D11)`, async () => {
    const { storage, drain } = await backend(kind);
    const tx = await storage.begin(PARTITION);
    if (tx.setBlobRefs === undefined || !storage.listRowsReferencingBlob) {
      await tx.rollback();
      return;
    }
    const blob = 'sha256:aa';
    for (let i = 0; i < 6; i++) {
      await tx.upsertRow('docs', {
        rowId: `d${i}`,
        serverVersion: 1,
        scopes: { org_id: 'o1', project_id: `p${i}` },
        payload: encodeRow(DOCS_COLUMNS, [`d${i}`, 'o1', `p${i}`]),
      });
      await tx.setBlobRefs(
        'docs',
        `d${i}`,
        i === 0 ? [blob, 'sha256:bb'] : [blob],
      );
    }
    await tx.upsertRow('tasks', {
      rowId: 't1',
      serverVersion: 1,
      scopes: { project_id: 'p9' },
      payload: encodeRow(TASKS_COLUMNS, ['t1', 'p9', null]),
    });
    await tx.setBlobRefs('tasks', 't1', [blob]);
    // A reference whose row is gone is skipped.
    await tx.setBlobRefs('tasks', 'ghost', [blob]);
    await tx.commit();
    drain();
    expect(
      await storage.listRowsReferencingBlob(PARTITION, 'sha256:bb'),
    ).toHaveLength(1);
    const single = drain().length;
    const rows = await storage.listRowsReferencingBlob(PARTITION, blob);
    // D1 adds its readiness gate read to the same batch.
    expect(drain().length).toBe(single);
    expect(single).toBeLessThanOrEqual(2);
    expect(
      rows
        .map((row) => `${row.table}/${row.rowId}`)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual([
      'docs/d0',
      'docs/d1',
      'docs/d2',
      'docs/d3',
      'docs/d4',
      'docs/d5',
      'tasks/t1',
    ]);
    expect(rows.find((row) => row.rowId === 'd3')?.scopes).toEqual({
      org_id: 'o1',
      project_id: 'p3',
    });
  });

  test(`${kind} pruning deletes change-scope entries by the pruned changes' keys (D9)`, async () => {
    const { storage, drain, raw, plan } = await backend(kind);
    await seedCommits(storage, 6, (i) => ({ project_id: `p${i % 2}` }));
    const other = await storage.begin('other');
    await other.appendCommit({
      clientId: 'c',
      clientCommitId: 'o',
      actorId: 'a',
      createdAtMs: NOW,
      changes: [
        {
          table: 'tasks',
          rowId: 'x',
          op: 'upsert',
          rowVersion: 1,
          scopes: { project_id: 'p0' },
          payload: new Uint8Array([1]),
        },
      ],
    });
    await other.commit();
    const { logEpoch } = await storage.touchPartition(PARTITION, NOW, 'epoch');
    drain();
    expect(
      await storage.pruneCommitsThrough(PARTITION, { logEpoch, throughSeq: 4 }),
    ).toMatchObject({ horizonSeq: 4, removedCommits: 4 });
    const scopeEntries = (await raw(
      'SELECT partition, value, commit_seq FROM sync_change_scopes ORDER BY partition, commit_seq',
    )) as { partition: string; value: string; commit_seq: number }[];
    expect(
      scopeEntries.map((entry) => [entry.partition, Number(entry.commit_seq)]),
    ).toEqual([
      ['other', 1],
      [PARTITION, 5],
      [PARTITION, 6],
    ]);
    expect(
      Number(
        (
          await raw(
            "SELECT count(*) AS n FROM sync_changes WHERE partition='part-1'",
          )
        )[0]?.n,
      ),
    ).toBe(4);

    if (kind === 'postgres') {
      expect(
        drain().find((text) =>
          text.startsWith('DELETE FROM sync_change_scopes'),
        ),
      ).toContain('jsonb_each_text(c.scopes)');
      return;
    }
    if (kind === 'd1') return;
    const pruneSql = drain().find((text) =>
      text.startsWith('DELETE FROM sync_change_scopes'),
    );
    const details = await plan(pruneSql!, [
      PARTITION,
      PARTITION,
      PARTITION,
      'e',
    ]);
    expect(
      details.find((detail) => detail.includes('SEARCH sync_change_scopes')),
    ).toContain('partition=? AND tbl=? AND var=? AND value=? AND commit_seq=?');
  });
}

test('Postgres prune seeks the scope primary key for the pruned changes (D9)', async () => {
  const { storage, drain, raw, plan } = await backend('postgres');
  await seedCommits(storage, 100, (i) => ({ project_id: `p${i % 20}` }));
  // A partition whose scope index dwarfs the pruned range.
  await raw(
    "INSERT INTO sync_change_scopes SELECT 'part-1', 'tasks', 'project_id', 'v' || g, g + 1000 FROM generate_series(1, 50000) g",
  );
  await raw('ANALYZE');
  const { logEpoch } = await storage.touchPartition(PARTITION, NOW, 'epoch');
  drain();
  await storage.pruneCommitsThrough(PARTITION, { logEpoch, throughSeq: 5 });
  const pruneSql = drain().find((text) =>
    text.startsWith('DELETE FROM sync_change_scopes'),
  );
  const text = (await plan(pruneSql!, [PARTITION, 5])).join('\n');
  expect(text).toContain('Index Scan using sync_change_scopes_pkey');
  expect(text).toContain('(commit_seq = k.commit_seq)');
});

test('D1 prune batches the key-derived scope delete before the change delete (D9)', async () => {
  const native = new Database(':memory:');
  const double = new BatchCountingD1(native);
  const storage = new D1ServerStorage(double, { pushApplySerialized: true });
  while (!(await storage.migrateSchema(COMPILED)).complete) {}
  await seedCommits(storage, 3);
  const { logEpoch } = await storage.touchPartition(PARTITION, NOW, 'epoch');
  double.batched.length = 0;
  await storage.pruneCommitsThrough(PARTITION, { logEpoch, throughSeq: 2 });
  const order = double.batched
    .map((sql) => /^DELETE FROM (\w+)/.exec(sql)?.[1])
    .filter((table) => table !== undefined);
  expect(order.indexOf('sync_change_scopes')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('sync_change_scopes')).toBeLessThan(
    order.indexOf('sync_changes'),
  );
  const pruneSql = double.batched.find((sql) =>
    sql.startsWith('DELETE FROM sync_change_scopes'),
  );
  expect(pruneSql).toContain('json_each(c.scopes)');
  const details = native
    .query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${pruneSql}`)
    .all(PARTITION, PARTITION, PARTITION, logEpoch)
    .map((row) => row.detail);
  expect(
    details.find((detail) => detail.includes('SEARCH sync_change_scopes')),
  ).toContain('partition=? AND tbl=? AND var=? AND value=? AND commit_seq=?');
});

for (const kind of KINDS) {
  test(`${kind} reads the live section of 13 units in one statement, one key range per unit (§4.5)`, async () => {
    const { storage, drain, plan } = await backend(kind);
    await seedCommits(storage, 40, (i) => ({ project_id: `p${i % 20}` }));
    const units = Array.from({ length: 13 }, (_, i) => ({
      scopes: { project_id: `p${i}` },
      afterSeq: 0,
      tables: new Map([['tasks', { project_id: [`p${i}`] }]]),
    }));
    drain();
    const window = await storage.readLiveWindow(PARTITION, {
      units,
      throughSeq: 40,
      limitChanges: 1000,
      limitBytes: 16 * 1024 * 1024,
    });
    expect(window.commits.map((commit) => commit.commitSeq)).toEqual(
      Array.from({ length: 40 }, (_, i) => i)
        .filter((i) => i % 20 < 13)
        .map((i) => i + 1),
    );
    const statements = drain();
    // One candidate read and one change read. D1 runs each SQLite statement
    // behind its published-schema guard, one batch of two statements each.
    expect(statements).toHaveLength(kind === 'd1' ? 4 : 2);
    if (kind === 'd1') return;
    const keys = JSON.stringify(
      units.map((unit, i) => ({
        i,
        var: 'project_id',
        value: unit.scopes.project_id,
        scopes: unit.scopes,
        after: 0,
        tables: ['tasks'],
      })),
    );
    // The change read seeks each candidate commit by (partition, commit_seq).
    const changeLines = await plan(statements[1]!, [
      PARTITION,
      keys,
      JSON.stringify(window.commits.map((commit) => commit.commitSeq)),
    ]);
    expect(
      changeLines.some((line) =>
        kind === 'sqlite'
          ? line.startsWith('SEARCH ch USING') &&
            line.includes('(partition=? AND commit_seq=?)')
          : /Index Scan using sync_changes_pkey on sync_changes/.test(line),
      ),
    ).toBe(true);
    expect(changeLines.some((line) => /^SCAN ch\b|Seq Scan/.test(line))).toBe(
      false,
    );
    const lines = await plan(statements[0]!, [
      PARTITION,
      keys,
      40,
      1000,
      1000,
      16 * 1024 * 1024,
    ]);
    if (kind === 'sqlite') {
      // The 13 keys drive the loop; each seeks one range of the key index.
      expect(lines).toContain(
        'SEARCH s USING COVERING INDEX sync_change_scopes_by_key (partition=? AND var=? AND value=? AND commit_seq>? AND commit_seq<?)',
      );
      expect(lines.some((line) => line.startsWith('SCAN s'))).toBe(false);
    } else {
      expect(
        lines.some((line) =>
          /Index Only Scan using sync_change_scopes_by_key on sync_change_scopes/.test(
            line,
          ),
        ),
      ).toBe(true);
      expect(lines.some((line) => line.includes('Seq Scan'))).toBe(false);
    }
  });
}

for (const kind of KINDS) {
  test(`${kind} sizes a far-behind live page up to its cut and one look-ahead, whatever the candidate limit (§4.5, §4.6)`, async () => {
    const { storage, drain, raw, plan } = await backend(kind);
    // 300 commits of 200 changes each; change j of commit i is in project
    // (200i + j) mod 120, so every commit carries changes of all 120 keys.
    for (let i = 0; i < 300; i++) {
      const tx = await storage.begin(PARTITION);
      await tx.appendCommit({
        clientId: 'c',
        clientCommitId: `k${i}`,
        actorId: 'a',
        createdAtMs: NOW + i,
        changes: Array.from({ length: 200 }, (_, j) => ({
          table: 'tasks',
          rowId: `r${i}-${j}`,
          op: 'upsert' as const,
          rowVersion: 1,
          scopes: { project_id: `p${(i * 200 + j) % 120}` },
          payload: new Uint8Array(40),
        })),
      });
      await tx.commit();
    }
    const units = Array.from({ length: 120 }, (_, i) => ({
      scopes: { project_id: `p${i}` },
      afterSeq: 0,
      tables: new Map([['tasks', { project_id: [`p${i}`] }]]),
    }));
    const keys = JSON.stringify(
      units.map((unit, i) => ({
        i,
        var: 'project_id',
        value: unit.scopes.project_id,
        scopes: unit.scopes,
        after: 0,
        tables: ['tasks'],
      })),
    );
    const read = async (limitChanges: number, limitBytes: number) => {
      drain();
      const window = await storage.readLiveWindow(PARTITION, {
        units,
        throughSeq: 300,
        limitChanges,
        limitBytes,
      });
      const statements = drain();
      return { window, statements };
    };
    // The candidates the page's sizing statement sizes, from the same text
    // and parameters (the candidate limit is max(64, limitChanges)).
    const sized = async (
      sql: string,
      limitChanges: number,
      limitBytes: number,
    ) =>
      new Set(
        (
          await raw(sql, [
            PARTITION,
            keys,
            300,
            Math.max(64, limitChanges),
            limitChanges,
            limitBytes,
          ])
        ).map((row) => Number(row.commit_seq)),
      ).size;
    // D1 runs each SQLite statement behind its published-schema guard.
    const perPage = kind === 'd1' ? 4 : 2;

    // The change budget: 1,100 changes reach it at commit 6 (1,200).
    const byChanges = await read(1100, 16 * 1024 * 1024);
    expect(byChanges.window.throughSeq).toBe(6);
    expect(byChanges.window.commits.map((c) => c.commitSeq)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(byChanges.statements).toHaveLength(perPage);

    // The byte budget: one commit stores 200 changes of 40 payload bytes,
    // their row ids and scopes; three and a half commits fit.
    const commitBytes = Array.from({ length: 200 }, (_, j) => {
      const scopes = JSON.stringify({ project_id: `p${j % 120}` });
      return 40 + `r0-${j}`.length + scopes.length;
    }).reduce((sum, bytes) => sum + bytes, 0);
    const limitBytes = Math.floor(commitBytes * 3.5);
    const byBytes = await read(1_000_000, limitBytes);
    expect(byBytes.window.throughSeq).toBe(3);
    expect(byBytes.window.commits.map((c) => c.commitSeq)).toEqual([1, 2, 3]);
    expect(byBytes.statements).toHaveLength(perPage);
    if (kind === 'd1') return;

    // The sizing statement sizes the delivered commits; under the byte
    // budget, one more, the commit that would pass it. Before 0.99.0 both
    // pages sized all 300 candidates.
    expect(await sized(byChanges.statements[0]!, 1100, 16 * 1024 * 1024)).toBe(
      6,
    );
    expect(await sized(byBytes.statements[0]!, 1_000_000, limitBytes)).toBe(4);

    if (kind === 'sqlite') {
      // Each scope pair seeks its key through an automatic index on (var,
      // value); `k` is scanned only as the candidate seek's outer loop.
      const sizing = await plan(byChanges.statements[0]!, [
        PARTITION,
        keys,
        300,
        1100,
        1100,
        16 * 1024 * 1024,
      ]);
      const changes = await plan(byChanges.statements[1]!, [
        PARTITION,
        keys,
        JSON.stringify([1, 2, 3, 4, 5, 6]),
      ]);
      for (const [lines, scans] of [
        [sizing, 1],
        [changes, 0],
      ] as const) {
        expect(lines).toContain(
          'SEARCH k USING AUTOMATIC COVERING INDEX (var=? AND value=?)',
        );
        expect(lines.filter((line) => line === 'SCAN k')).toHaveLength(scans);
      }
    }

    if (kind === 'postgres') {
      // Neither statement joins a change to the key list: each scope pair
      // looks its key up in one jsonb object. `k` is scanned only by the
      // candidate seek (one index range per key) and the object build,
      // never inside the per-commit walk or per change.
      const keyScans = async (sql: string, params: unknown[]) => {
        const [line] = await plan(`(FORMAT JSON) ${sql}`, params);
        const names: string[] = [];
        const visit = (node: Record<string, unknown>, under: string) => {
          const name = String(node['Subplan Name'] ?? under);
          if (node['Node Type'] === 'CTE Scan' && node['CTE Name'] === 'k') {
            names.push(name);
          }
          for (const child of (node.Plans ?? []) as Record<string, unknown>[]) {
            visit(child, name);
          }
        };
        const parsed = (typeof line === 'string' ? JSON.parse(line) : line) as {
          Plan: Record<string, unknown>;
        }[];
        visit(parsed[0]!.Plan, 'main');
        return names.sort();
      };
      expect(
        await keyScans(byChanges.statements[0]!, [
          PARTITION,
          keys,
          300,
          1100,
          1100,
          16 * 1024 * 1024,
        ]),
      ).toEqual(['CTE c', 'CTE km']);
      expect(
        await keyScans(byChanges.statements[1]!, [
          PARTITION,
          keys,
          JSON.stringify([1, 2, 3, 4, 5, 6]),
        ]),
      ).toEqual([]);
    }
  });
}

for (const kind of KINDS) {
  test(`${kind} scope scans seek the variable with the fewest index entries`, async () => {
    const { storage, drain } = await backend(kind);
    // org_id o1 (the alphabetical first variable) is on all 2,000 rows;
    // p-mid on 300 and p-small on the last 10 of them.
    const seed = await storage.begin(PARTITION);
    for (let i = 0; i < 2_000; i++) {
      const rowId = `d${String(i).padStart(4, '0')}`;
      const project = i >= 1_990 ? 'p-small' : i >= 1_690 ? 'p-mid' : 'p-big';
      await seed.upsertRow('docs', {
        rowId,
        serverVersion: 1,
        scopes: { org_id: 'o1', project_id: project },
        payload: encodeRow(DOCS_COLUMNS, [rowId, 'o1', project]),
      });
    }
    await seed.commit();
    const scan = async (
      read: Pick<ServerStorage, 'scanRows'>['scanRows'],
      projects: string[],
      limit: number,
    ) => {
      drain();
      const rows = await read(PARTITION, {
        table: 'docs',
        scopeFilter: { org_id: ['o1'], project_id: projects },
        afterRowId: null,
        limit,
      });
      return { rows: rows.length, statements: drain().length };
    };
    const read = storage.scanRows.bind(storage);
    // D1 runs every storage read behind its schema-guard statement.
    const reads = (count: number) => (kind === 'd1' ? 2 * count : count);
    // One probe and one page; seeking o1 took 32 pages of 64 entries.
    expect(await scan(read, ['p-small'], 64)).toEqual({
      rows: 10,
      statements: reads(2),
    });
    // The page loop of a bootstrap reuses the pick.
    expect(await scan(read, ['p-small'], 64)).toEqual({
      rows: 10,
      statements: reads(1),
    });
    // p-mid ties o1 at the caps 64 and 256 and counts 300 under 1,024.
    expect(await scan(read, ['p-mid'], 64)).toEqual({
      rows: 64,
      statements: reads(4),
    });
    // A value without entries ends the scan in the probe.
    expect(await scan(read, ['p-none'], 1)).toEqual({
      rows: 0,
      statements: reads(1),
    });
    const tx = await storage.begin(PARTITION);
    const inTransaction = await scan(
      (_, query) => tx.scanRows!(query),
      ['p-small', 'p-none'],
      64,
    );
    await tx.rollback();
    expect(inTransaction).toEqual({ rows: 10, statements: reads(2) });
  });
}

test('SQLite-family scope scans read a bounded range of the inverted index for 1, 2 and 5 values (D6)', async () => {
  const native = new Database(':memory:');
  const storage = new SqliteServerStorage(new BunSqliteDatabase(native));
  await storage.ensureSchema(COMPILED);
  const insertRow = native.query(
    'INSERT INTO sync_row_scopes(partition, tbl, var, value, row_id) VALUES (?,?,?,?,?)',
  );
  const insertChange = native.query(
    'INSERT INTO sync_change_scopes(partition, tbl, var, value, commit_seq) VALUES (?,?,?,?,?)',
  );
  for (let i = 0; i < 400; i++) {
    insertRow.run(PARTITION, 'tasks', 'project_id', `p${i % 20}`, `r${i}`);
    insertChange.run(PARTITION, 'tasks', 'project_id', `p${i % 20}`, i);
  }
  expect(
    native
      .query<{ name: string }, []>('PRAGMA index_list(sync_row_scopes)')
      .all()
      .map((index) => index.name),
  ).not.toContain('sync_row_scopes_by_row');
  const table = COMPILED.tables.get('tasks')!;
  for (const count of [1, 2, 5]) {
    const values = JSON.stringify(
      Array.from({ length: count }, (_, i) => `p${i}`),
    );
    const plan = native
      .query<{ detail: string }, string[]>(
        `EXPLAIN QUERY PLAN ${scanRowPageSql(table, count, 'sqlite')}`,
      )
      .all(PARTITION, 'tasks', 'project_id', values, '', '64');
    // The candidates range between the cursor and the bound (the smallest
    // of the values' 64th entries, one seek each), so a page reads at most
    // 64 entries per value however many follow the cursor.
    expect(
      plan
        .filter(({ detail }) => detail.includes('sync_row_scopes'))
        .map(({ detail }) => detail),
    ).toEqual([
      'SEARCH sync_row_scopes USING COVERING INDEX sqlite_autoindex_sync_row_scopes_1 (partition=? AND tbl=? AND var=? AND value=? AND row_id>? AND row_id<?)',
      'SEARCH sync_row_scopes USING COVERING INDEX sqlite_autoindex_sync_row_scopes_1 (partition=? AND tbl=? AND var=? AND value=? AND row_id>?)',
    ]);
    expect(plan.some(({ detail }) => detail.includes('ORDER BY'))).toBe(false);
    expect(plan.some(({ detail }) => detail.includes('_by_row'))).toBe(false);
  }
  // The per-row scope replacement binds the full key.
  const replace = native
    .query<{ detail: string }, string[]>(
      `EXPLAIN QUERY PLAN ${deleteSqliteRowScopesSql(table)}`,
    )
    .all(PARTITION, 'tasks', 'r1', PARTITION, 'r1');
  expect(replace[0]?.detail).toContain(
    'partition=? AND tbl=? AND var=? AND value=? AND row_id=?',
  );
});

test('existing databases lose the by-row index through the DDL (D6)', async () => {
  const legacy = () => {
    const native = new Database(':memory:');
    native.exec(
      `CREATE TABLE sync_row_scopes(partition TEXT NOT NULL, tbl TEXT NOT NULL, var TEXT NOT NULL, value TEXT NOT NULL, row_id TEXT NOT NULL, PRIMARY KEY(partition, tbl, var, value, row_id));
       CREATE INDEX sync_row_scopes_by_row ON sync_row_scopes(partition, tbl, row_id);`,
    );
    return native;
  };
  const indexes = (native: Database) =>
    native
      .query<{ name: string }, []>('PRAGMA index_list(sync_row_scopes)')
      .all()
      .map((index) => index.name);
  const sqlite = legacy();
  expect(indexes(sqlite)).toContain('sync_row_scopes_by_row');
  const storage = new SqliteServerStorage(new BunSqliteDatabase(sqlite));
  expect(storage).toBeDefined();
  expect(indexes(sqlite)).not.toContain('sync_row_scopes_by_row');
  const d1 = legacy();
  await new D1ServerStorage(new D1DatabaseDouble(d1)).migrate();
  expect(indexes(d1)).not.toContain('sync_row_scopes_by_row');
});

test('D1 scope scans bind scope values as one parameter (D4)', async () => {
  expect(scanRowPageSql(COMPILED.tables.get('tasks')!, 1, 'sqlite')).toBe(
    scanRowPageSql(COMPILED.tables.get('tasks')!, 150, 'sqlite'),
  );
  const storage = new D1ServerStorage(new CappedD1(), {
    pushApplySerialized: true,
  });
  while (!(await storage.migrateSchema(COMPILED)).complete) {}
  const projects = Array.from({ length: 150 }, (_, i) => `p${i}`);
  const tx = await storage.begin(PARTITION);
  const payload = (id: string, project: string) =>
    encodeRow(TASKS_COLUMNS, [id, project, null]);
  await tx.appendCommit({
    clientId: 'c',
    clientCommitId: 'k',
    actorId: 'a',
    createdAtMs: NOW,
    changes: projects.map((project, i) => ({
      table: 'tasks',
      rowId: `r${i}`,
      op: 'upsert' as const,
      rowVersion: 1,
      scopes: { project_id: project },
      payload: payload(`r${i}`, project),
    })),
  });
  for (const [i, project] of projects.entries()) {
    await tx.upsertRow('tasks', {
      rowId: `r${i}`,
      serverVersion: 1,
      scopes: { project_id: project },
      payload: payload(`r${i}`, project),
    });
  }
  await tx.commit();
  const rows = await storage.scanRows(PARTITION, {
    table: 'tasks',
    scopeFilter: { project_id: projects },
    afterRowId: null,
    limit: 500,
  });
  expect(rows).toHaveLength(150);
  // 150 units bind as one JSON parameter.
  const window = await storage.readLiveWindow(PARTITION, {
    units: projects.map((project) => ({
      scopes: { project_id: project },
      afterSeq: 0,
      tables: new Map([['tasks', { project_id: [project] }]]),
    })),
    throughSeq: 1,
    limitChanges: 500,
    limitBytes: 16 * 1024 * 1024,
  });
  expect(window.commits.flatMap((commit) => commit.changes)).toHaveLength(150);
  const reader = await storage.begin(PARTITION);
  const inTransaction = await reader.scanRows!({
    table: 'tasks',
    scopeFilter: { project_id: projects },
    afterRowId: null,
    limit: 500,
  });
  await reader.rollback();
  expect(inTransaction).toHaveLength(150);
});

test('a multi-operation D1 push reads its rows in one db.batch (D7)', async () => {
  const push = async (operationCount: number) => {
    const double = new BatchCountingD1(new Database(':memory:'));
    const storage = new D1ServerStorage(double, { pushApplySerialized: true });
    while (
      !(await storage.migrateSchema(compileSchema(TEST_SCHEMA))).complete
    ) {}
    const t = makeContext({ storage });
    await storage.touchPartition(t.ctx.partition, t.now.ms, TEST_LOG_EPOCH);
    const before = {
      batches: double.batches,
      batched: double.batched.length,
      statements: double.statementsExecuted,
    };
    const ids = Array.from({ length: operationCount }, (_, i) => `t${i}`);
    const message = await sync(t, [
      pushCommit(
        'multi',
        ids.map((id) => upsert('tasks', id, taskRow(id, 'p1'))),
      ),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect(
      (await storage.getRow(t.ctx.partition, 'tasks', ids.at(-1)!))
        ?.serverVersion,
    ).toBe(1);
    return {
      batches: double.batches - before.batches,
      // Statements D1 ran outside any batch: one round trip each.
      single:
        double.statementsExecuted -
        before.statements -
        (double.batched.length - before.batched),
    };
  };
  const one = await push(1);
  const many = await push(8);
  // Neither the batch count nor the round trips outside a batch grow with
  // the operation count: the commit's rows and tombstones arrive in one batch.
  expect(many.batches).toBe(one.batches);
  expect(many.single).toBe(one.single);
});

test('an idle SQLite storage runs a call before a close in the same tick', async () => {
  const open = async () => {
    const db = new BunSqliteDatabase();
    const storage = new SqliteServerStorage(db);
    await storage.ensureSchema(COMPILED);
    return { db, storage };
  };
  const reading = await open();
  const registry = reading.storage.listPartitionRegistry();
  reading.db.close();
  expect(await registry).toEqual([]);

  // touchPartition reads, writes and re-reads: all of it runs at call time.
  const touching = await open();
  const touched = touching.storage.touchPartition(PARTITION, NOW, 'epoch');
  touching.db.close();
  expect(await touched).toMatchObject({
    partition: PARTITION,
    logEpoch: 'epoch',
    lastAuthenticatedAtMs: NOW,
  });
});

test('the live change read loads only the candidate commits, whatever the log holds below them (§4.5)', async () => {
  const calls: (readonly number[])[] = [];
  const window = await readLiveWindowPages(
    PARTITION,
    {
      units: [
        {
          scopes: { project_id: 'p1' },
          afterSeq: 25,
          tables: new Map([['tasks', { project_id: ['p1'] }]]),
        },
      ],
      throughSeq: 26,
      limitChanges: 1000,
      limitBytes: 16 * 1024 * 1024,
    },
    new Map(),
    async () => {
      throw new Error('a single-variable unit needs no probe');
    },
    async (keys) =>
      keys[0]!.after < 26
        ? [
            {
              commitSeq: 26,
              meta: { actorId: 'a', createdAtMs: NOW },
              key: 0,
              bytes: 3,
            },
          ]
        : [],
    async (_keys, commitSeqs) => {
      calls.push(commitSeqs);
      return [];
    },
  );
  expect(calls).toEqual([[26]]);
  expect(window.throughSeq).toBe(26);
});

for (const kind of KINDS) {
  test(`${kind} counts a bootstrap extent on the row-scope index only (§4.7)`, async () => {
    const { storage, drain, plan } = await backend(kind);
    const tx = await storage.begin(PARTITION);
    for (let i = 0; i < 60; i++) {
      const rowId = `d${i}`;
      const scopes = { org_id: `o${i % 2}`, project_id: `p${i % 3}` };
      await tx.upsertRow('docs', {
        rowId,
        serverVersion: 1,
        scopes,
        payload: encodeRow(DOCS_COLUMNS, [
          rowId,
          scopes.org_id,
          scopes.project_id,
        ]),
      });
    }
    await tx.commit();
    drain();
    const count = (scopeFilter: Record<string, string[]>) =>
      storage.countScopedRows(PARTITION, { table: 'docs', scopeFilter });
    // D1 runs each batch behind its schema guard statement.
    const guard = kind === 'd1' ? 1 : 0;
    expect(await count({ project_id: ['p1'] })).toBe(20);
    expect(drain()).toHaveLength(1 + guard);
    // Several variables: the scan's selectivity probe, then the count.
    expect(await count({ org_id: ['o0'], project_id: ['p1', 'p2'] })).toBe(20);
    expect(drain()).toHaveLength(2 + 2 * guard);
    const vars = [
      { var: 'org_id', vals: ['o0'] },
      { var: 'project_id', vals: ['p1'] },
    ];
    const lines =
      kind === 'postgres'
        ? await plan(countRowsSql('postgres'), [
            PARTITION,
            JSON.stringify([{ i: 0, tbl: 'docs', vars }]),
          ])
        : await plan(countRowsSql('sqlite'), [
            PARTITION,
            'docs',
            JSON.stringify(vars),
          ]);
    const text = lines.join('\n');
    expect(text).not.toMatch(/docs/);
    if (kind === 'postgres') {
      expect(text).toContain('Index Only Scan using sync_row_scopes_pk');
      expect(text).not.toContain('sync_row_scopes_by_row');
      expect(text).not.toContain('Seq Scan');
    } else {
      // `b` ranges each variable once on the covering primary key.
      const scopeSteps = lines.filter((line) =>
        /^(SCAN|SEARCH) b\b/.test(line),
      );
      expect(scopeSteps).toHaveLength(1);
      expect(scopeSteps[0]).toMatch(
        /^SEARCH b USING COVERING INDEX sqlite_autoindex_sync_row_scopes_1 \(partition=\? AND tbl=\? AND var=\? AND value=\?/,
      );
    }
  });
}

test('a live page loads candidates only up to its cut, so a far-behind client reads what it receives (§4.5)', async () => {
  // 40 candidate commits whose key reads 2 changes each; `kept` of them
  // match the unit (the per-key count bounds delivery from above). A
  // `budgeted` read sizes candidates until their counts reach the change
  // budget, as the SQL backends do; the other returns every candidate.
  const run = async (kept: number, budgeted = false) => {
    const calls: (readonly number[])[] = [];
    const sized: number[] = [];
    const window = await readLiveWindowPages(
      PARTITION,
      {
        units: [
          {
            scopes: { project_id: 'p1' },
            afterSeq: 0,
            tables: new Map([['tasks', { project_id: ['p1'] }]]),
          },
        ],
        throughSeq: 40,
        limitChanges: 5,
        limitBytes: 16 * 1024 * 1024,
      },
      new Map(),
      async () => {
        throw new Error('a single-variable unit needs no probe');
      },
      async (keys, _limit, budget) => {
        const rows = Array.from({ length: 40 - keys[0]!.after }, (_, i) => ({
          commitSeq: keys[0]!.after + i + 1,
          meta: { actorId: 'a', createdAtMs: NOW },
          key: 0,
          bytes: 2,
          changes: 2,
        })).slice(0, budgeted ? Math.ceil(budget.changes / 2) : undefined);
        sized.push(rows.length);
        return rows;
      },
      async (_keys, commitSeqs) => {
        calls.push(commitSeqs);
        return commitSeqs.flatMap((commitSeq) =>
          ['a', 'b'].map((suffix, index) => ({
            commitSeq,
            change: {
              table: 'tasks',
              rowId: `r${commitSeq}${suffix}`,
              op: 'upsert' as const,
              rowVersion: 1,
              scopes: { project_id: index < kept ? 'p1' : 'p2' },
            },
          })),
        );
      },
    );
    return { calls, sized, window };
  };
  const exact = await run(2);
  // 2 + 2 + 2 reaches 5 at commit 3: one load, and no candidate past the cut.
  expect(exact.calls).toEqual([[1, 2, 3]]);
  expect(exact.window.throughSeq).toBe(3);
  expect(exact.window.commits.map((commit) => commit.commitSeq)).toEqual([
    1, 2, 3,
  ]);
  const over = await run(1);
  // The count overstates delivery; the page loads again until the exact cut.
  expect(over.calls).toEqual([[1, 2, 3], [4], [5]]);
  expect(over.window.throughSeq).toBe(5);
  expect(over.window.commits).toHaveLength(5);
  // A read the budget stopped below the candidate limit is not the end of
  // the log: the page reads on from the last loaded commit.
  const budgeted = await run(1, true);
  expect(budgeted.sized).toEqual([3, 1, 1]);
  expect(budgeted.calls).toEqual([[1, 2, 3], [4], [5]]);
  expect(budgeted.window.throughSeq).toBe(5);
  expect(budgeted.window.commits).toHaveLength(5);
});

test('a PostgreSQL segment download reads the registry and the checkpoint versions in one statement (§5.5)', async () => {
  const db = await PGlite.create();
  const counting = countingExecutor(pgliteExecutor(db));
  const storage = new PostgresServerStorage(counting.executor);
  await storage.ensureSchema(compileSchema(TEST_SCHEMA));
  const t = makeContext({ storage, limits: { inlineSegmentMaxBytes: 1 } });
  await seedTask(t, 'seed', 't1', 'p1');
  const unit = { project_id: 'p1' };
  const ref = section(await sync(t, pullFrames([unit])), unit).body.find(
    (frame): frame is SegmentRefFrame => frame.type === 'SEGMENT_REF',
  );
  if (ref === undefined) throw new Error('expected SEGMENT_REF');
  const download = () =>
    handleSegmentDownload(t.ctx, {
      segmentId: ref.segmentId,
      scopesHeader: canonicalScopeJson({ project_id: ['p1'] }),
    });
  counting.texts.length = 0;
  await download();
  // 0.91.0 ran two: the registry read, then `readCheckpoints`.
  expect(counting.texts).toHaveLength(1);
  expect(counting.texts[0]).toContain('sync_partition_registry');
  expect(counting.texts[0]).toContain('sync_backfill_checkpoints');

  // The same statement still refuses a descriptor older than a checkpoint.
  await storage.declareCheckpoint(PARTITION, 'tasks-projection', 2, NOW);
  await expect(download()).rejects.toMatchObject({
    code: 'sync.segment_expired',
  });
});

for (const kind of KINDS) {
  test(`${kind} picks the live keys of 40 catalogue units in one statement per probe round (§4.5)`, async () => {
    // Diego's shape: 40 releases in 4 content sets of one availability, and
    // 10 workspaces. The change-scope index holds one entry per commit and
    // value: r0 has 300 commits, the other releases one of 100 changes. A
    // new storage starts with no pick.
    const { storage, drain } = await backend(kind);
    const release = (i: number) => ({
      availability: 'offered',
      release_id: `r${i}`,
      set_id: `s${i % 4}`,
    });
    const commits = [
      ...Array.from({ length: 300 }, () => 0),
      ...Array.from({ length: 49 }, (_, i) => i + 1),
    ];
    for (const [seq, i] of commits.entries()) {
      const tx = await storage.begin(PARTITION);
      await tx.appendCommit({
        clientId: 'c',
        clientCommitId: `k${seq}`,
        actorId: 'a',
        createdAtMs: NOW + seq,
        changes: Array.from(
          { length: i === 0 ? 1 : i < 40 ? 100 : 2 },
          (_, j) => ({
            table: i < 40 ? 'docs' : 'tasks',
            rowId: `r${seq}-${j}`,
            op: 'upsert' as const,
            rowVersion: 1,
            scopes: i < 40 ? release(i) : { workspace_id: `w${i - 40}` },
            payload: new Uint8Array(1),
          }),
        ),
      });
      await tx.commit();
    }
    const units = [
      ...Array.from({ length: 40 }, (_, i) => ({
        scopes: release(i),
        afterSeq: 349,
        tables: new Map([
          [
            'docs',
            Object.fromEntries(
              Object.entries(release(i)).map(([name, value]) => [
                name,
                [value],
              ]),
            ),
          ],
        ]),
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        scopes: { workspace_id: `w${i}` },
        afterSeq: 349,
        tables: new Map([['tasks', { workspace_id: [`w${i}`] }]]),
      })),
    ];
    const pull = async () => {
      drain();
      await storage.readLiveWindow(PARTITION, {
        units,
        throughSeq: 349,
        limitChanges: 1000,
        limitBytes: 16 * 1024 * 1024,
      });
      return drain().length;
    };
    // A quiet pull reads one candidate statement; D1 runs each behind its
    // published-schema guard. The first pull adds one probe statement per
    // round for all 50 units: r0 ties with its set and availability at the
    // caps 64 and 256, so it takes three rounds; the others decide in one.
    const per = kind === 'd1' ? 2 : 1;
    expect(await pull()).toBe(4 * per);
    expect(await pull()).toBe(per);
  });
}
