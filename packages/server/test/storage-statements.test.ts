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
import { encodeRow } from '@syncular/core';
import {
  commitWindowPageSql,
  compileSchema,
  D1ServerStorage,
  type D1PreparedStatement,
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
import {
  makeContext,
  pushCommit,
  pushResults,
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
  readonly raw: (sql: string) => Promise<Record<string, unknown>[]>;
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
      raw: async (sql) => (await db.query<Record<string, unknown>>(sql)).rows,
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
  const raw = async (sql: string) =>
    native.query<Record<string, unknown>, []>(sql).all();
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

test('SQLite-family scope scans seek the inverted index for 1, 2 and 5 values (D6)', async () => {
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
    const plans = [
      native
        .query<{ detail: string }, string[]>(
          `EXPLAIN QUERY PLAN ${scanRowPageSql(table, count, 'sqlite')}`,
        )
        .all(PARTITION, 'tasks', 'project_id', values, '', '64', PARTITION),
      native
        .query<{ detail: string }, (string | number)[]>(
          `EXPLAIN QUERY PLAN ${commitWindowPageSql(count, 'sqlite')}`,
        )
        .all(
          PARTITION,
          'tasks',
          'project_id',
          values,
          0,
          1000,
          64,
          PARTITION,
          PARTITION,
          'tasks',
        ),
    ];
    for (const [plan, index] of [
      [plans[0]!, 'sync_row_scopes'],
      [plans[1]!, 'sync_change_scopes'],
    ] as const) {
      const search = plan.filter(({ detail }) => detail.includes(index));
      expect(search).toHaveLength(1);
      expect(search[0]?.detail).toContain(
        `SEARCH ${index} USING COVERING INDEX sqlite_autoindex_${index}_1 (partition=? AND tbl=? AND var=? AND value=?`,
      );
      expect(plan.some(({ detail }) => detail.includes('_by_row'))).toBe(false);
    }
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
  expect(commitWindowPageSql(1, 'sqlite')).toBe(
    commitWindowPageSql(150, 'sqlite'),
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
  const commits = await storage.readCommitWindow(PARTITION, {
    table: 'tasks',
    scopeFilter: { project_id: projects },
    afterSeq: 0,
    throughSeq: 1,
    limitChanges: 500,
  });
  expect(commits.flatMap((commit) => commit.changes)).toHaveLength(150);
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
