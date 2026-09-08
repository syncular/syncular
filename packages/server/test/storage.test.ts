/**
 * Both in-tree server storages against the shared `ServerStorage` contract:
 * `SqliteServerStorage` (bun:sqlite, the reference) and
 * `PostgresServerStorage` (pglite, embedded WASM Postgres — hermetic, no
 * docker). The two run identical assertions so the Postgres path matches the
 * reference key-for-key (index-first fanout, dense commitSeq, §4.6 horizon).
 */

import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { encodeRow } from '@syncular/core';
import {
  compileSchema,
  SyncularAdmin,
  pruneCommitLog,
  type D1PreparedStatement,
  D1ServerStorage,
  PostgresServerStorage,
  SqliteServerStorage,
  type StoredPushResult,
  type ServerStorage,
  type SqliteValue,
  type SqliteStatement,
} from '@syncular/server';
import type { PgExecutor } from '../src/pg-executor';
import type { NewChange } from '../src/storage';
import { pgliteExecutor } from '@syncular/server/pglite';
import { BunSqliteDatabase } from '@syncular/server/sqlite';
import { StorageConstraintError } from '../src/storage-errors';
import { D1DatabaseDouble } from './d1-double';
import { CONTRACT_SCHEMA, runStorageContract } from './storage-contract';
import { deleteSqliteRowScopesSql } from '../src/relational-rows';

for (const backend of ['sqlite', 'postgres', 'd1'] as const) {
  test(`${backend} scope replacement removes exact old keys across repeated writes and rollback`, async () => {
    const pg = backend === 'postgres' ? await PGlite.create() : undefined;
    const sqlite = backend === 'sqlite' ? new BunSqliteDatabase() : undefined;
    const d1 = backend === 'd1' ? new Database(':memory:') : undefined;
    const storage: ServerStorage = pg
      ? new PostgresServerStorage(pgliteExecutor(pg))
      : sqlite
        ? new SqliteServerStorage(sqlite)
        : new D1ServerStorage(new D1DatabaseDouble(d1!), {
            pushApplySerialized: true,
          });
    const columns = CONTRACT_SCHEMA.tables.find(
      (table) => table.name === 'docs',
    )!.columns;
    const row = (id: string, org: string, project: string) => ({
      rowId: id,
      serverVersion: 1,
      scopes: { org_id: org, project_id: project },
      payload: encodeRow(columns, [id, org, project]),
    });
    const entries = async () => {
      const sql =
        'SELECT partition, tbl, var, value, row_id FROM sync_row_scopes ORDER BY partition, tbl, var, value, row_id';
      type Entry = {
        partition: string;
        tbl: string;
        var: string;
        value: string;
        row_id: string;
      };
      if (pg) return (await pg.query<Entry>(sql)).rows;
      if (sqlite) return sqlite.query<Entry, []>(sql).all();
      return d1!.query<Entry, []>(sql).all();
    };
    try {
      if (storage instanceof D1ServerStorage) await prepareD1(storage);
      await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
      for (const partition of ['part', 'other']) {
        const tx = await storage.begin(partition);
        await tx.upsertRow('docs', row('shared', 'o1', 'p1'));
        if (partition === 'part') {
          await tx.upsertRow('docs', row('sibling', 'o1', 'p1'));
          await tx.upsertRow('tasks', {
            rowId: 'shared',
            serverVersion: 1,
            scopes: { project_id: 'p1' },
            payload: encodeRow(CONTRACT_SCHEMA.tables[0]!.columns, [
              'shared',
              'p1',
              null,
            ]),
          });
        }
        await tx.commit();
      }
      const baseline = await entries();
      if (pg) {
        // Bun's executor also has existing rows whose JSONB is JSON-encoded
        // text. The storage reader already supports this representation.
        await pg.query(
          `UPDATE docs SET _sync_scopes=to_jsonb(_sync_scopes::text) WHERE _sync_partition=$1 AND _sync_row_id=$2`,
          ['part', 'shared'],
        );
      }
      const isolated = baseline.filter(
        (entry) =>
          entry.partition !== 'part' ||
          entry.tbl !== 'docs' ||
          entry.row_id !== 'shared',
      );
      for (const empty of [false, true, false]) {
        const tx = await storage.begin('part');
        await tx.upsertRow('docs', row('shared', 'o2', 'p2'));
        await tx.deleteRow('docs', 'shared');
        await tx.deleteRow('docs', 'absent');
        await tx.upsertRow('docs', row('shared', 'o3', 'p3'));
        await tx.upsertRow('docs', {
          ...row('shared', 'o4', 'p4'),
          ...(empty ? { scopes: {} } : {}),
        });
        await tx.commit();
        const actual = await entries();
        expect(
          actual.filter(
            (entry) =>
              entry.partition !== 'part' ||
              entry.tbl !== 'docs' ||
              entry.row_id !== 'shared',
          ),
        ).toEqual(isolated);
        expect(
          actual
            .filter(
              (entry) =>
                entry.partition === 'part' &&
                entry.tbl === 'docs' &&
                entry.row_id === 'shared',
            )
            .map(({ var: variable, value }) => [variable, value]),
        ).toEqual(
          empty
            ? []
            : [
                ['org_id', 'o4'],
                ['project_id', 'p4'],
              ],
        );
      }
      const before = await entries();
      for (const rejected of [false, true]) {
        const tx = await storage.begin('part');
        await tx.lockPartitionForPush?.();
        await tx.upsertRow('docs', row('shared', 'rejected', 'rejected'));
        await tx.deleteRow('docs', 'sibling');
        if (rejected) {
          await expect(
            tx.upsertRow('docs', {
              ...row('shared', 'invalid', 'invalid'),
              payload: new Uint8Array([255]),
            }),
          ).rejects.toThrow();
          await tx.commitRejectedPushResult?.('client', 'bad-row', {
            status: 'rejected',
            results: [
              {
                opIndex: 1,
                status: 'error',
                code: 'sync.invalid_request',
                message: 'injected invalid row',
                retryable: false,
              },
            ],
          });
        } else await tx.rollback();
        expect(await entries()).toEqual(before);
        expect(
          (await storage.getRow('part', 'docs', 'shared'))?.scopes,
        ).toEqual({ org_id: 'o4', project_id: 'p4' });
        expect(
          (await storage.getRow('part', 'docs', 'sibling'))?.scopes,
        ).toEqual({ org_id: 'o1', project_id: 'p1' });
      }
      const deleted = await storage.begin('part');
      await deleted.deleteRow('docs', 'shared');
      await deleted.deleteRow('docs', 'shared');
      await deleted.commit();
      expect(await entries()).toEqual(isolated);
      if (sqlite) {
        const table = compileSchema(CONTRACT_SCHEMA).tables.get('docs')!;
        const plan = sqlite
          .query<{ detail: string }, string[]>(
            `EXPLAIN QUERY PLAN ${deleteSqliteRowScopesSql(table)}`,
          )
          .all('part', 'docs', 'shared', 'part', 'shared');
        expect(
          plan.some(
            ({ detail }) =>
              detail.includes('SEARCH sync_row_scopes') &&
              detail.includes('var=?') &&
              detail.includes('value=?') &&
              detail.includes('row_id=?'),
          ),
        ).toBe(true);
      }
    } finally {
      sqlite?.close();
      d1?.close();
      await pg?.close();
    }
  });
}

runStorageContract('sqlite', () => new SqliteServerStorage());

runStorageContract('postgres/pglite', async () => {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.migrate();
  return storage;
});

// D1 (Cloudflare Workers) against the local bun:sqlite-backed double
// (test/d1-double.ts documents its fidelity limits). Same contract, so the
// D1 path is held to the reference behavior key-for-key.
async function prepareD1(storage: D1ServerStorage): Promise<void> {
  while (
    !(await storage.migrateSchema(compileSchema(CONTRACT_SCHEMA))).complete
  ) {}
}

runStorageContract('d1/double', async () => {
  const storage = new D1ServerStorage(new D1DatabaseDouble(), {
    pushApplySerialized: true,
  });
  await prepareD1(storage);
  return storage;
});

const LEGACY_CLIENTS_DDL = `CREATE TABLE sync_clients(
  partition TEXT NOT NULL, client_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  cursor INTEGER NOT NULL, subscriptions TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(partition, client_id)
)`;

test('SQLite migrates legacy client records to wire version 1', async () => {
  const db = new BunSqliteDatabase();
  db.exec(LEGACY_CLIENTS_DDL);
  db.run(
    `INSERT INTO sync_clients(
       partition, client_id, actor_id, cursor, subscriptions, updated_at_ms
     ) VALUES (?,?,?,?,?,?)`,
    ['partition', 'client', 'actor', 7, '[]', 10],
  );
  const storage = new SqliteServerStorage(db);
  expect(await storage.getClientRecord('partition', 'client')).toMatchObject({
    wireVersion: 1,
    cursor: 7,
  });
  storage.db.close();
});

test('D1 migrates legacy client records to wire version 1', async () => {
  const db = new D1DatabaseDouble();
  await db.exec(LEGACY_CLIENTS_DDL);
  await db
    .prepare(
      `INSERT INTO sync_clients(
         partition, client_id, actor_id, cursor, subscriptions, updated_at_ms
       ) VALUES (?,?,?,?,?,?)`,
    )
    .bind('partition', 'client', 'actor', 7, '[]', 10)
    .run();
  const storage = new D1ServerStorage(db, { pushApplySerialized: true });
  await storage.migrate();
  expect(await storage.getClientRecord('partition', 'client')).toMatchObject({
    wireVersion: 1,
    cursor: 7,
  });
});

test('Postgres migrates legacy client records to wire version 1', async () => {
  const db = await PGlite.create();
  await db.exec(LEGACY_CLIENTS_DDL);
  await db.query(
    `INSERT INTO sync_clients(
       partition, client_id, actor_id, cursor, subscriptions, updated_at_ms
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['partition', 'client', 'actor', 7, '[]', 10],
  );
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.migrate();
  expect(await storage.getClientRecord('partition', 'client')).toMatchObject({
    wireVersion: 1,
    cursor: 7,
  });
  await db.close();
});

test('D1 push apply fails closed without external serialization', async () => {
  const storage = new D1ServerStorage(new D1DatabaseDouble());
  await prepareD1(storage);
  const tx = await storage.begin('partition');
  await expect(tx.lockPartitionForPush?.()).rejects.toThrow(
    'requires externally serialized partition writes',
  );
  await tx.rollback();
  await expect(
    storage.pruneCommitsThrough('partition', {
      logEpoch: 'epoch',
      throughSeq: 0,
    }),
  ).rejects.toThrow('requires externally serialized partition writes');
});

function appliedResult(): StoredPushResult {
  return {
    status: 'applied',
    commitSeq: 1,
    results: [{ opIndex: 0, status: 'applied' }],
  };
}

test('SQLite: a failed COMMIT rolls back and later transactions proceed', async () => {
  const storage = new SqliteServerStorage();
  const realExec = storage.db.exec.bind(storage.db);
  let failNextCommit = true;
  (storage.db as unknown as { exec: (sql: string) => unknown }).exec = (
    sql: string,
  ) => {
    if (failNextCommit && sql === 'COMMIT') {
      failNextCommit = false;
      throw Object.assign(new Error('SQLITE_BUSY: database is locked'), {
        code: 'SQLITE_BUSY',
      });
    }
    return realExec(sql);
  };

  const tx = await storage.begin('partition');
  await tx.putPushResult('c1', 'lost-commit', appliedResult());
  await expect(tx.commit()).rejects.toThrow('SQLITE_BUSY');

  // Regression: before the ROLLBACK-on-failed-COMMIT the connection stayed
  // inside BEGIN IMMEDIATE and every later transaction errored with
  // "cannot start a transaction within a transaction".
  const tx2 = await storage.begin('partition');
  await tx2.putPushResult('c1', 'landed-commit', appliedResult());
  await tx2.commit();
  expect(
    await storage.getPushResult('partition', 'c1', 'lost-commit'),
  ).toBeUndefined();
  expect(
    await storage.getPushResult('partition', 'c1', 'landed-commit'),
  ).toBeDefined();
});

test('pglite executor serializes overlapping transaction scopes', async () => {
  const db = await PGlite.create();
  const exec = pgliteExecutor(db);
  try {
    const order: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = exec.transaction(async () => {
      order.push('first:start');
      entered();
      await gate;
      order.push('first:end');
    });
    await started;
    const second = exec.transaction(async () => {
      order.push('second:start');
      order.push('second:end');
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    // Interleaved scopes would collapse into one SQL transaction (a nested
    // BEGIN is a warning-level no-op on Postgres).
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  } finally {
    await exec.close?.();
  }
});

test('Postgres partition locking initializes once and survives an initial rollback', async () => {
  const db = await PGlite.create();
  const base = pgliteExecutor(db);
  const statements: string[] = [];
  const storage = new PostgresServerStorage({
    query: (sql, params) => base.query(sql, params),
    transaction: (fn) =>
      base.transaction((client) =>
        fn({
          query: (sql, params) => {
            statements.push(sql);
            return client.query(sql, params);
          },
        }),
      ),
  });
  try {
    await storage.migrate();
    for (const [finish, initializes, expectedSeq] of [
      ['rollback', true, 1],
      ['commit', true, 1],
      ['commit', false, 2],
    ] as const) {
      statements.length = 0;
      const tx = await storage.begin('lock-partition');
      try {
        await tx.lockPartitionForPush?.();
        const initialization = statements.filter((sql) =>
          sql.includes('INSERT INTO sync_partitions'),
        );
        expect(initialization).toHaveLength(initializes ? 1 : 0);
        expect(
          statements.filter((sql) => sql.includes('FOR UPDATE')),
        ).toHaveLength(initialization.length + 1);
        expect(statements.at(-1)).toBe('SAVEPOINT syncular_push_candidate');
        const seq = await tx.appendCommit({
          clientId: 'client',
          clientCommitId: crypto.randomUUID(),
          actorId: 'actor',
          createdAtMs: 1,
          changes: [],
        });
        expect(seq).toBe(expectedSeq);
        await tx[finish]();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    }
    expect(await storage.getMaxCommitSeq('lock-partition')).toBe(2);
  } finally {
    await db.close();
  }
});

test('Postgres allocates the sequence and commit metadata in one statement with atomic rollback', async () => {
  const db = await PGlite.create();
  const base = pgliteExecutor(db);
  const statements: string[] = [];
  const storage = new PostgresServerStorage({
    query: (sql, params) => base.query(sql, params),
    transaction: (fn) =>
      base.transaction((client) =>
        fn({
          query: (sql, params) => {
            statements.push(sql);
            return client.query(sql, params);
          },
        }),
      ),
  });
  try {
    await storage.migrate();
    for (const [finish, expectedSeq] of [
      ['rollback', 1],
      ['commit', 1],
      ['rollback', 2],
      ['commit', 2],
    ] as const) {
      const tx = await storage.begin('commit-allocation');
      try {
        statements.length = 0;
        const seq = await tx.appendCommit({
          clientId: 'client-λ',
          clientCommitId: `commit-${expectedSeq}`,
          actorId: "actor's id",
          createdAtMs: 1_750_000_000_123,
          changes: [],
        });
        expect(seq).toBe(expectedSeq);
        expect(statements).toHaveLength(1);
        await tx[finish]();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      expect(await storage.getMaxCommitSeq('commit-allocation')).toBe(
        finish === 'commit' ? expectedSeq : expectedSeq - 1,
      );
    }
    const records = await base.query(
      'SELECT partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms FROM sync_commits ORDER BY commit_seq',
    );
    expect(records.rows).toEqual(
      [1, 2].map((seq) => ({
        partition: 'commit-allocation',
        commit_seq: seq,
        client_id: 'client-λ',
        client_commit_id: `commit-${seq}`,
        actor_id: "actor's id",
        created_at_ms: 1_750_000_000_123,
      })),
    );
    await base.query(
      "ALTER TABLE sync_commits ADD CHECK (actor_id <> 'rejected')",
    );
    const rejected = await storage.begin('commit-allocation');
    try {
      await expect(
        rejected.appendCommit({
          clientId: 'client',
          clientCommitId: 'rejected',
          actorId: 'rejected',
          createdAtMs: 1,
          changes: [],
        }),
      ).rejects.toThrow();
    } finally {
      await rejected.rollback();
    }
    expect(await storage.getMaxCommitSeq('commit-allocation')).toBe(2);
    const retry = await storage.begin('commit-allocation');
    try {
      expect(
        await retry.appendCommit({
          clientId: 'client',
          clientCommitId: 'next',
          actorId: 'actor',
          createdAtMs: 2,
          changes: [],
        }),
      ).toBe(3);
      await retry.commit();
    } catch (error) {
      await retry.rollback();
      throw error;
    }
    expect(
      (
        await base.query(
          'SELECT client_commit_id FROM sync_commits ORDER BY commit_seq',
        )
      ).rows,
    ).toEqual([
      { client_commit_id: 'commit-1' },
      { client_commit_id: 'commit-2' },
      { client_commit_id: 'next' },
    ]);
  } finally {
    await db.close();
  }
});

test('Postgres appends each change and all its scopes in one statement', async () => {
  const db = await PGlite.create();
  const base = pgliteExecutor(db);
  const statements: string[] = [];
  const storage = new PostgresServerStorage({
    query: (sql, params) => base.query(sql, params),
    transaction: (fn) =>
      base.transaction((client) =>
        fn({
          query: (sql, params) => {
            statements.push(sql);
            return client.query(sql, params);
          },
        }),
      ),
  });
  const changes: NewChange[] = [
    { table: 'docs', rowId: 'unscoped', op: 'delete', scopes: {} },
    {
      table: 'docs',
      rowId: 'upsert',
      op: 'upsert',
      rowVersion: 7,
      scopes: { project_id: 'p\n1', org_id: "org's 雪", empty: '' },
      payload: new Uint8Array([0, 1, 128, 255]),
    },
    {
      table: 'docs',
      rowId: 'delete',
      op: 'delete',
      scopes: { project_id: 'p\n1', org_id: "org's 雪" },
    },
  ];
  try {
    await storage.migrate();
    for (const finish of ['rollback', 'commit'] as const) {
      const tx = await storage.begin('change-scopes');
      try {
        statements.length = 0;
        expect(
          await tx.appendCommit({
            clientId: 'client',
            clientCommitId: finish,
            actorId: 'actor',
            createdAtMs: 123,
            changes,
          }),
        ).toBe(1);
        expect(statements).toHaveLength(1 + changes.length);
        await tx[finish]();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      expect(await storage.getMaxCommitSeq('change-scopes')).toBe(
        finish === 'commit' ? 1 : 0,
      );
      expect(
        (await base.query('SELECT idx FROM sync_changes ORDER BY idx')).rows,
      ).toEqual(
        finish === 'commit' ? [{ idx: 0 }, { idx: 1 }, { idx: 2 }] : [],
      );
      const entries = await base.query(
        'SELECT tbl, var, value, commit_seq FROM sync_change_scopes ORDER BY var',
      );
      expect(entries.rows).toEqual(
        finish === 'commit'
          ? [
              { tbl: 'docs', var: 'empty', value: '', commit_seq: 1 },
              { tbl: 'docs', var: 'org_id', value: "org's 雪", commit_seq: 1 },
              { tbl: 'docs', var: 'project_id', value: 'p\n1', commit_seq: 1 },
            ]
          : [],
      );
    }
    const window = await storage.readCommitWindow('change-scopes', {
      table: 'docs',
      scopeFilter: { project_id: ['p\n1'], org_id: ["org's 雪"] },
      afterSeq: 0,
      throughSeq: 1,
      limitChanges: 10,
    });
    expect(window).toEqual([
      {
        commitSeq: 1,
        actorId: 'actor',
        createdAtMs: 123,
        changes: changes.slice(1),
      },
    ]);
    await base.query(
      "ALTER TABLE sync_change_scopes ADD CHECK (value <> 'rejected')",
    );
    const tx = await storage.begin('change-scopes');
    try {
      await expect(
        tx.appendCommit({
          clientId: 'client',
          clientCommitId: 'rejected',
          actorId: 'actor',
          createdAtMs: 124,
          changes: [
            changes[1]!,
            {
              table: 'docs',
              rowId: 'bad',
              op: 'delete',
              scopes: { project_id: 'rejected' },
            },
          ],
        }),
      ).rejects.toThrow();
    } finally {
      await tx.rollback();
    }
    expect(await storage.getMaxCommitSeq('change-scopes')).toBe(1);
    expect(
      (await base.query('SELECT DISTINCT commit_seq FROM sync_changes')).rows,
    ).toEqual([{ commit_seq: 1 }]);
    expect(
      (await base.query('SELECT DISTINCT commit_seq FROM sync_change_scopes'))
        .rows,
    ).toEqual([{ commit_seq: 1 }]);
  } finally {
    await db.close();
  }
});

/** A D1 double whose batch() fails commit-time with a constraint error. */
class ConstraintAtBatchDouble extends D1DatabaseDouble {
  failNextBatch = false;

  override async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error('D1_ERROR: NOT NULL constraint failed: tasks.data');
    }
    return super.batch(statements);
  }
}

test('D1: a batch-commit constraint attributes the opIndex only when it is unambiguous', async () => {
  const db = new ConstraintAtBatchDouble();
  const storage = new D1ServerStorage(db, { pushApplySerialized: true });
  await prepareD1(storage);
  const taskRow = (id: string) => ({
    rowId: id,
    serverVersion: 1,
    scopes: { project: 'p1' },
    payload: encodeRow(
      [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'data', type: 'bytes', nullable: true },
      ] as const,
      [id, 'p1', null],
    ),
  });

  // Several buffered application ops: the violating one is unknowable from
  // the batch error, so the rejection omits the opIndex.
  const ambiguous = await storage.begin('partition');
  await ambiguous.lockPartitionForPush?.();
  await ambiguous.upsertRow('tasks', taskRow('t-0'), { opIndex: 0 });
  await ambiguous.upsertRow('tasks', taskRow('t-2'), { opIndex: 2 });
  db.failNextBatch = true;
  const ambiguousError = await ambiguous.commit().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(ambiguousError).toBeInstanceOf(StorageConstraintError);
  expect((ambiguousError as StorageConstraintError).opIndex).toBeUndefined();
  await ambiguous.rollback();

  // One buffered application op: the attribution is exact.
  const exact = await storage.begin('partition');
  await exact.lockPartitionForPush?.();
  await exact.upsertRow('tasks', taskRow('t-solo'), { opIndex: 3 });
  db.failNextBatch = true;
  const exactError = await exact.commit().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(exactError).toBeInstanceOf(StorageConstraintError);
  expect((exactError as StorageConstraintError).opIndex).toBe(3);
  await exact.rollback();
});

for (const backend of ['SQLite', 'Postgres', 'D1'] as const) {
  test(`${backend} rolls back pruning at every write boundary and cleans up an interrupted older pass`, async () => {
    let failAt: string | undefined;
    const before = (sql: string) => {
      const matches =
        failAt === 'horizon'
          ? /(?:INSERT INTO sync_partitions\(partition,\s*horizon_seq\)|UPDATE sync_partitions SET horizon_seq)/.test(
              sql,
            )
          : failAt === 'COMMIT'
            ? sql === 'COMMIT'
            : failAt !== undefined && sql.startsWith(`DELETE FROM ${failAt} `);
      if (matches) throw new Error('injected pruning failure');
    };
    const sqlite = backend === 'SQLite' ? new BunSqliteDatabase() : undefined;
    const postgres = backend === 'Postgres' ? await PGlite.create() : undefined;
    const d1 = new D1DatabaseDouble();
    let storage: ServerStorage;
    if (sqlite !== undefined) {
      const query = sqlite.query.bind(sqlite);
      sqlite.query = <Row, Params extends readonly SqliteValue[]>(
        sql: string,
      ): SqliteStatement<Row, Params> => {
        before(sql);
        return query<Row, Params>(sql);
      };
      const exec = sqlite.exec.bind(sqlite);
      sqlite.exec = (sql) => {
        before(sql);
        exec(sql);
      };
      storage = new SqliteServerStorage(sqlite);
    } else if (postgres !== undefined) {
      const base = pgliteExecutor(postgres);
      const executor: PgExecutor = {
        query: (sql, params) => base.query(sql, params),
        transaction: (fn) =>
          base.transaction(async (client) => {
            const result = await fn({
              query: (sql, params) => {
                before(sql);
                return client.query(sql, params);
              },
            });
            before('COMMIT');
            return result;
          }),
      };
      storage = new PostgresServerStorage(executor);
    } else {
      d1.beforeBatchStatement = before;
      const adapter = new D1ServerStorage(d1, { pushApplySerialized: true });
      await prepareD1(adapter);
      storage = adapter;
    }
    try {
      await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
      const { logEpoch } = await storage.touchPartition(
        'partition',
        1,
        'epoch',
      );
      for (let i = 1; i <= 3; i += 1) {
        const tx = await storage.begin('partition');
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: `c${i}`,
          actorId: 'a',
          createdAtMs: 1,
          changes: [
            {
              table: 'tasks',
              rowId: `t${i}`,
              op: 'upsert',
              rowVersion: 1,
              scopes: { project_id: 'p1' },
              payload: new Uint8Array([i]),
            },
          ],
        });
        await tx.commit();
      }
      for (const boundary of [
        'horizon',
        'sync_commits',
        'sync_changes',
        'sync_change_scopes',
        'COMMIT',
      ]) {
        failAt = boundary;
        await expect(
          storage.pruneCommitsThrough('partition', { logEpoch, throughSeq: 2 }),
        ).rejects.toThrow('injected pruning failure');
        failAt = undefined;
        expect(await storage.getHorizonSeq('partition')).toBe(0);
        expect(
          (
            await storage.readCommitWindow('partition', {
              table: 'tasks',
              scopeFilter: { project_id: ['p1'] },
              afterSeq: 0,
              throughSeq: 3,
              limitChanges: 100,
            })
          ).map((commit) => commit.commitSeq),
        ).toEqual([1, 2, 3]);
      }
      // Simulate the old setter succeeding before a historical delete failed.
      await storage.setHorizonSeq('partition', 2);
      expect(
        await storage.pruneCommitsThrough('partition', {
          logEpoch,
          throughSeq: 1,
        }),
      ).toEqual({ previousHorizonSeq: 2, horizonSeq: 2, removedCommits: 2 });
      expect(
        await storage.pruneCommitsThrough('partition', {
          logEpoch,
          throughSeq: 1,
        }),
      ).toEqual({ previousHorizonSeq: 2, horizonSeq: 2, removedCommits: 0 });
    } finally {
      failAt = undefined;
      sqlite?.close();
      await postgres?.close();
    }
  });
}

for (const backend of ['sqlite', 'postgres/pglite', 'd1/double']) {
  test(`${backend} active cursor aggregation handles 100001 records without enumerating clients`, async () => {
    let storage: ServerStorage;
    let close: () => void | Promise<void>;
    let plan: unknown;
    const seed = `INSERT INTO sync_clients(partition,client_id,actor_id,wire_version,cursor,subscriptions,updated_at_ms)
      SELECT 'part', CAST(n AS TEXT), 'actor', 2, CASE WHEN n=100001 THEN -1 ELSE n END, '[]', CASE WHEN n%2=0 THEN 99 ELSE 100 END FROM numbers`;
    const sqliteSeed = `WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<100001) ${seed}`;
    const aggregate =
      'SELECT MIN(cursor) AS cursor FROM sync_clients WHERE partition=? AND updated_at_ms>=?';
    if (backend === 'postgres/pglite') {
      const db = await PGlite.create();
      const pg = new PostgresServerStorage(pgliteExecutor(db));
      await pg.migrate();
      await db.exec(
        `WITH numbers AS (SELECT generate_series(1,100001) AS n) ${seed}`,
      );
      await db.exec('ANALYZE sync_clients');
      plan = (
        await db.query(
          `EXPLAIN (FORMAT JSON) ${aggregate.replace('partition=?', 'partition=$1').replace('>=?', '>=$2')}`,
          ['part', 100],
        )
      ).rows;
      storage = pg;
      close = () => db.close();
    } else if (backend === 'd1/double') {
      const db = new D1DatabaseDouble();
      const d1 = new D1ServerStorage(db, { pushApplySerialized: true });
      await d1.migrate();
      await db.exec(sqliteSeed);
      plan = (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${aggregate}`)
          .bind('part', 100)
          .all()
      ).results;
      storage = d1;
      close = () => undefined;
    } else {
      const sqlite = new SqliteServerStorage();
      sqlite.db.exec(sqliteSeed);
      plan = sqlite.db
        .query(`EXPLAIN QUERY PLAN ${aggregate}`)
        .all('part', 100);
      storage = sqlite;
      close = () => sqlite.db.close();
    }
    try {
      await storage.touchPartition('part', 100, 'epoch');
      const measurements = [];
      for (const mode of ['enumerate', 'aggregate']) {
        const times: number[] = [];
        const heaps: number[] = [];
        let transferredBytes = 0;
        for (let run = 0; run < 3; run += 1) {
          Bun.gc(true);
          const before = process.memoryUsage().heapUsed;
          const start = performance.now();
          const result =
            mode === 'enumerate'
              ? await storage.listClientCursors('part')
              : await storage.getActiveClientCursorFloor('part', 100);
          times.push(performance.now() - start);
          heaps.push(process.memoryUsage().heapUsed - before);
          transferredBytes = JSON.stringify(result).length;
          if (typeof result === 'number') expect(result).toBe(-1);
          else expect(result).toHaveLength(100001);
        }
        measurements.push({ mode, times, heaps, transferredBytes });
      }
      const cutoffs: number[] = [];
      const aggregateRead = storage.getActiveClientCursorFloor.bind(storage);
      storage.getActiveClientCursorFloor = (partition, cutoff) => {
        cutoffs.push(cutoff);
        return aggregateRead(partition, cutoff);
      };
      storage.listClientCursors = () => {
        throw new Error('client enumeration forbidden');
      };
      const admin = new SyncularAdmin({
        storage,
        clock: () => 110,
        retention: { activeWindowMs: 10 },
      });
      expect((await admin.horizonStatus('part')).activeCursorFloor).toBe(-1);
      expect(
        await pruneCommitLog({
          storage,
          partition: 'part',
          nowMs: 110,
          retention: { activeWindowMs: 10 },
        }),
      ).toBe(0);
      expect(cutoffs).toEqual([100, 100]);
      if (process.env.SYNCULAR_RETENTION_BENCH === '1')
        console.log(JSON.stringify({ backend, measurements, plan }));
    } finally {
      await close();
    }
  });
}
