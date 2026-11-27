/**
 * SYNCULAR-PUSH-ROUNDTRIPS-001: one push commit's storage statements are a
 * function of its tables, not of its operations, so a remote Postgres pays
 * per-table cost instead of per-row cost.
 *
 * SYNCULAR-PUSH-LOCK-STATEMENTS-001: a push request holds the partition lock
 * for BEGIN, the lock, the admission statement, one write statement and
 * COMMIT when its commits read nothing their own writes changed.
 *
 * SYNCULAR-PUSH-QUERY-SAVEPOINT-001: a registered query writes the held-back
 * writes first only when it reads a table they change.
 *
 * The counter tags statements by where they run: handler admission/readiness
 * traffic is pool-level, everything the commit apply does is inside the push
 * transaction the storage opens.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeMessage,
  encodeSparseRow,
  type PushOperation,
  type RequestFrame,
  type ResponseMessage,
} from '@syncular/core';
import {
  CommitValidationRejection,
  compileSchema,
  D1ServerStorage,
  handleSyncRequest,
  MemorySegmentStore,
  type PgExecutor,
  type PgQueryable,
  PostgresServerStorage,
  prepareReadTransaction,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
  type StorageTransaction,
  type SyncRequestContext,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import {
  docRow,
  pullFrames,
  pushCommit,
  pushResults,
  requestBytes,
  taskRow,
  TEST_LOG_EPOCH,
  TEST_SCHEMA,
  upsert,
} from './helpers';
import { D1DatabaseDouble } from './d1-double';

/**
 * Counts statements per scope (the pool and a storage transaction) and
 * records the text of every transaction's statements, one list per
 * `BEGIN`.
 */
function countingExecutor(inner: PgExecutor): {
  executor: PgExecutor;
  count: { pool: number; transaction: number };
  transactions: string[][];
} {
  const count = { pool: 0, transaction: 0 };
  const transactions: string[][] = [];
  const counted = (
    client: PgQueryable,
    scope: 'pool' | 'transaction',
    statements?: string[],
  ): PgQueryable => ({
    query: (text, params) => {
      count[scope] += 1;
      statements?.push(text);
      return client.query(text, params);
    },
  });
  return {
    count,
    transactions,
    executor: {
      query: counted(inner, 'pool').query,
      transaction: (fn) => {
        const statements: string[] = [];
        transactions.push(statements);
        return inner.transaction((client) =>
          fn(counted(client, 'transaction', statements)),
        );
      },
    },
  };
}

async function context(storage: ServerStorage): Promise<SyncRequestContext> {
  const ctx: SyncRequestContext = {
    partition: 'part-1',
    actorId: 'actor-1',
    schema: TEST_SCHEMA,
    storage,
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({
      project_id: ['p1'],
      projectId: ['p1'],
      org_id: ['o1'],
    }),
    clock: () => 1_750_000_000_000,
  };
  await storage.ensureSchema(compileSchema(TEST_SCHEMA));
  await storage.touchPartition(
    ctx.partition,
    1_750_000_000_000,
    TEST_LOG_EPOCH,
  );
  return ctx;
}

async function sync(
  ctx: SyncRequestContext,
  frames: RequestFrame[],
): Promise<ResponseMessage> {
  const message = decodeMessage(
    await handleSyncRequest(requestBytes(frames), ctx),
  );
  if (message.msgKind !== 'response') throw new Error('expected a response');
  return message;
}

/** Four tasks and three docs: seven operations over two tables. */
function sevenOps(prefix: string, baseVersion?: number): PushOperation[] {
  return [
    ...['1', '2', '3', '4'].map((suffix) =>
      upsert(
        'tasks',
        `${prefix}-t${suffix}`,
        taskRow(`${prefix}-t${suffix}`, 'p1'),
        baseVersion,
      ),
    ),
    ...['1', '2', '3'].map((suffix) =>
      upsert(
        'docs',
        `${prefix}-d${suffix}`,
        docRow(`${prefix}-d${suffix}`, 'o1', 'p1'),
        baseVersion,
      ),
    ),
  ];
}

describe('push commit statement count (SYNCULAR-PUSH-ROUNDTRIPS-001)', () => {
  test('Postgres persists conflict authorization and rechecks it after revocation', async () => {
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    const original = await context(storage);
    let allowed = { org_id: ['o1'], projectId: ['old'] };
    const ctx: SyncRequestContext = {
      ...original,
      schema: {
        ...TEST_SCHEMA,
        tables: TEST_SCHEMA.tables.map((table) =>
          table.name === 'docs'
            ? { ...table, writeScopeVariables: ['org_id'] }
            : table,
        ),
      },
      resolveScopes: () => allowed,
    };
    try {
      expect(
        pushResults(
          await sync(ctx, [
            pushCommit('insert-alt', [
              upsert('docs', 'd1', docRow('d1', 'o1', 'new')),
            ]),
          ]),
        )[0]?.status,
      ).toBe('applied');
      const request = pushCommit('conflict-alt', [
        upsert('docs', 'd1', docRow('d1', 'o1', 'new'), 0),
      ]);
      expect(
        pushResults(await sync(ctx, [request]))[0]?.results[0]?.status,
      ).toBe('conflict');
      allowed = { org_id: ['o2'], projectId: ['old'] };
      expect(
        pushResults(await sync(ctx, [request]))[0]?.results[0],
      ).toMatchObject({ status: 'error', code: 'sync.forbidden' });
      allowed = { org_id: ['o1'], projectId: ['old'] };
      expect(
        pushResults(await sync(ctx, [request]))[0]?.results[0]?.status,
      ).toBe('conflict');
    } finally {
      await db.close();
    }
  });
  test('Postgres serializes competing inserts without exposing a foreign winner', async () => {
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    const original = await context(storage);
    const schema: ServerSchema = {
      ...TEST_SCHEMA,
      tables: TEST_SCHEMA.tables.map((table) =>
        table.name === 'docs'
          ? { ...table, writeScopeVariables: ['org_id'] }
          : table,
      ),
    };
    try {
      const attempts = await Promise.all(
        ['o1', 'o2'].map(async (org) => {
          const ctx: SyncRequestContext = {
            ...original,
            actorId: org,
            schema,
            resolveScopes: () => ({ org_id: [org] }),
          };
          const response = decodeMessage(
            await handleSyncRequest(
              requestBytes(
                [
                  pushCommit(`race-${org}`, [
                    upsert('docs', 'race', docRow('race', org, 'race', org), 0),
                  ]),
                ],
                `client-${org}`,
              ),
              ctx,
            ),
          );
          if (response.msgKind !== 'response')
            throw new Error('expected a response');
          return pushResults(response)[0];
        }),
      );
      expect(
        attempts.filter((result) => result?.status === 'applied'),
      ).toHaveLength(1);
      expect(
        attempts.filter((result) => result?.results[0]?.status === 'error'),
      ).toHaveLength(1);
      expect(
        attempts
          .flatMap((result) => result?.results ?? [])
          .find((record) => record.status === 'error'),
      ).toMatchObject({ code: 'sync.forbidden' });
      expect(
        attempts
          .flatMap((result) => result?.results ?? [])
          .some((record) => record.status === 'conflict'),
      ).toBe(false);
    } finally {
      await db.close();
    }
  });
  test('a 7-op commit applies in 3 statements, a refused one in 3', async () => {
    const db = await PGlite.create();
    const counting = countingExecutor(pgliteExecutor(db));
    const storage = new PostgresServerStorage(counting.executor);
    const ctx = await context(storage);
    try {
      // Initialize the partition and its first row outside the measurement.
      const seeded = pushResults(
        await sync(ctx, [
          pushCommit('seed', [upsert('tasks', 'seed', taskRow('seed', 'p1'))]),
        ]),
      )[0];
      expect(seeded?.status).toBe('applied');

      counting.count.transaction = 0;
      const inserted = pushResults(
        await sync(ctx, [pushCommit('insert', sevenOps('a'))]),
      )[0];
      const insertStatements = counting.count.transaction;
      expect(inserted?.status).toBe('applied');
      // The lock, the admission read and one write statement.
      expect(insertStatements).toBe(3);

      counting.count.transaction = 0;
      const updated = pushResults(
        await sync(ctx, [pushCommit('update', sevenOps('a', 1))]),
      )[0];
      const updateStatements = counting.count.transaction;
      expect(updated?.status).toBe('applied');
      expect(updateStatements).toBe(3);

      // The commit's writes all landed under the one commitSeq the result
      // reports, and the per-column versions advanced.
      const stored = await storage.getRow('part-1', 'tasks', 'a-t1');
      expect(stored?.serverVersion).toBe(2);
      const seq = updated?.commitSeq ?? 0;
      const { commits } = await storage.readLiveWindow('part-1', {
        units: [
          {
            scopes: { project_id: 'p1' },
            afterSeq: seq - 1,
            tables: new Map([['tasks', { project_id: ['p1'] }]]),
          },
        ],
        throughSeq: seq,
        limitChanges: 10,
        limitBytes: 16 * 1024 * 1024,
      });
      expect(commits).toHaveLength(1);
      expect(commits[0]?.changes).toHaveLength(4);

      // A refused commit writes no row and costs the lock, the admission
      // read (which carries the row read-ahead), and the persisted rejection.
      const maxSeqBefore = await storage.getMaxCommitSeq('part-1');
      counting.count.transaction = 0;
      const refused = pushResults(
        await sync(ctx, [
          pushCommit('refused', [
            upsert('tasks', 'a-t1', taskRow('a-t1', 'p1'), 0),
          ]),
        ]),
      )[0];
      const refusedStatements = counting.count.transaction;
      expect(refused?.status).toBe('rejected');
      expect(refusedStatements).toBe(3);
      expect(await storage.getMaxCommitSeq('part-1')).toBe(maxSeqBefore);
      expect(
        (await storage.getRow('part-1', 'tasks', 'a-t1'))?.serverVersion,
      ).toBe(2);

      // The rejection is durable: the retry replays it from the admission
      // read without reopening the apply.
      counting.count.transaction = 0;
      const replay = pushResults(
        await sync(ctx, [
          pushCommit('refused', [
            upsert('tasks', 'a-t1', taskRow('a-t1', 'p1'), 0),
          ]),
        ]),
      )[0];
      expect(replay).toEqual(refused);
      expect(counting.count.transaction).toBe(2);
    } finally {
      await db.close();
    }
  }, 60_000);

  test('a mixed delete and update commit stays one commit', async () => {
    const db = await PGlite.create();
    const counting = countingExecutor(pgliteExecutor(db));
    const storage = new PostgresServerStorage(counting.executor);
    const ctx = await context(storage);
    try {
      await sync(ctx, [
        pushCommit('seed', [
          upsert('tasks', 't1', taskRow('t1', 'p1')),
          upsert('tasks', 't2', taskRow('t2', 'p1')),
          upsert('docs', 'd1', docRow('d1', 'o1', 'p1')),
        ]),
      ]);
      counting.count.transaction = 0;
      const message = pushResults(
        await sync(ctx, [
          pushCommit('mixed', [
            { table: 'tasks', rowId: 't1', op: 'delete', baseVersion: 1 },
            upsert('tasks', 't2', taskRow('t2', 'p1', 'edited'), 1),
            { table: 'docs', rowId: 'd1', op: 'delete', baseVersion: 1 },
          ]),
        ]),
      )[0];
      expect(message?.status).toBe('applied');
      // The lock, the admission read, the savepoint, each delete (the second
      // carries the staged update ahead of it), and the commit append with
      // its result.
      expect(counting.count.transaction).toBe(7);
      expect(await storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
      expect(await storage.getRow('part-1', 'docs', 'd1')).toBeUndefined();
      expect(
        (await storage.getRow('part-1', 'tasks', 't2'))?.serverVersion,
      ).toBe(2);
      const { commits } = await storage.readLiveWindow('part-1', {
        units: [
          {
            scopes: { project_id: 'p1' },
            afterSeq: (message?.commitSeq ?? 1) - 1,
            tables: new Map([['tasks', { project_id: ['p1'] }]]),
          },
        ],
        throughSeq: message?.commitSeq ?? 1,
        limitChanges: 10,
        limitBytes: 16 * 1024 * 1024,
      });
      expect(commits).toHaveLength(1);
      // The deletion left its tombstone (§5.2): an unversioned upsert cannot
      // resurrect the row within the horizon.
      expect(
        pushResults(
          await sync(ctx, [
            pushCommit('resurrect', [
              upsert('tasks', 't1', taskRow('t1', 'p1')),
            ]),
          ]),
        )[0]?.status,
      ).toBe('rejected');
    } finally {
      await db.close();
    }
  }, 60_000);
});

/**
 * SYNCULAR-PUSH-ROUNDTRIPS-002: the reply a push round assembles reads the
 * commit's changed rows per table, never per row. The pushing client's own
 * pull half covers three tables, so a per-row read-back would cost one
 * statement per changed row (the feedback item: 24 row reads plus 19 change
 * joins for a 5-row commit). The reply here issues no single-row read and one
 * batched change-window statement.
 */
describe('push reply row reads (SYNCULAR-PUSH-ROUNDTRIPS-002)', () => {
  const COLUMNS = [
    { name: 'id', type: 'string' as const, nullable: false },
    { name: 'project_id', type: 'string' as const, nullable: false },
    { name: 'v', type: 'string' as const, nullable: false },
  ];
  const TABLES = ['chronicle', 'combats', 'combatants'];
  const REPLY_SCHEMA = {
    version: 1,
    tables: TABLES.map((name) => ({
      name,
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    })),
  };
  const payload = (id: string): Uint8Array =>
    encodeSparseRow(COLUMNS, 0, [id, 'p1', 'x']);
  const fiveRows = (baseVersion?: number): PushOperation[] =>
    [
      ['chronicle', 'ch1'],
      ['combats', 'co1'],
      ['combats', 'co2'],
      ['combatants', 'ca1'],
      ['combatants', 'ca2'],
    ].map(([table, rowId]) =>
      upsert(table!, rowId!, payload(rowId!), baseVersion),
    );

  test('a 5-row commit over 3 tables replies without a single-row read', async () => {
    const db = await PGlite.create();
    const sql: string[] = [];
    const inner = pgliteExecutor(db);
    const wrap = (client: PgQueryable): PgQueryable => ({
      query: (text, params) => {
        sql.push(text);
        return client.query(text, params);
      },
    });
    const storage = new PostgresServerStorage({
      query: wrap(inner).query,
      transaction: (fn) => inner.transaction((client) => fn(wrap(client))),
    });
    const ctx: SyncRequestContext = {
      partition: 'part-1',
      actorId: 'actor-1',
      schema: REPLY_SCHEMA,
      storage,
      segments: new MemorySegmentStore(),
      resolveScopes: () => ({ project_id: ['p1'] }),
      clock: () => 1_750_000_000_000,
    };
    await storage.ensureSchema(compileSchema(REPLY_SCHEMA));
    await storage.touchPartition(
      ctx.partition,
      1_750_000_000_000,
      TEST_LOG_EPOCH,
    );
    const round = async (
      commitId: string,
      operations: PushOperation[],
      cursor: number,
    ) => {
      sql.length = 0;
      const message = decodeMessage(
        await handleSyncRequest(
          requestBytes([
            pushCommit(commitId, operations),
            /**
             * One live unit covering the three tables, at the replica cursor
             * the client held before the push: the reply's live section
             * carries this commit's changes for all of them.
             */
            ...pullFrames([{ project_id: 'p1' }], {
              limitCommits: 20,
              cursor,
              progress: [],
            }),
          ]),
          ctx,
        ),
      );
      if (message.msgKind !== 'response') throw new Error('expected response');
      return message;
    };

    try {
      const inserted = await round('insert', fiveRows(), 0);
      expect(pushResults(inserted)[0]?.status).toBe('applied');
      const commitSeq = pushResults(inserted)[0]?.commitSeq ?? 0;
      const commits = inserted.frames.filter(
        (frame) => frame.type === 'COMMIT',
      );
      const changes = commits.flatMap((frame) => frame.changes);
      expect(changes.map((change) => change.rowId)).toEqual([
        'ch1',
        'co1',
        'co2',
        'ca1',
        'ca2',
      ]);
      expect(commits.every((frame) => frame.commitSeq === commitSeq)).toBe(
        true,
      );

      const singleRowReads = sql.filter(
        (text) =>
          text.startsWith(
            'SELECT "_sync_row_id" AS row_id, "_sync_server_version"',
          ) && /"_sync_row_id"=\$\d+$/.test(text),
      );
      const windowReads = sql.filter((text) =>
        text.includes('FROM sync_changes ch CROSS JOIN km'),
      );
      expect(singleRowReads).toEqual([]);
      expect(windowReads).toHaveLength(1);
      expect(singleRowReads.length + windowReads.length).toBeLessThanOrEqual(6);

      // A versioned update replies the same way.
      const updated = await round('update', fiveRows(1), commitSeq);
      expect(pushResults(updated)[0]?.status).toBe('applied');
      expect(
        updated.frames
          .filter((frame) => frame.type === 'COMMIT')
          .flatMap((frame) => frame.changes)
          .map((change) => change.rowId),
      ).toEqual(['ch1', 'co1', 'co2', 'ca1', 'ca2']);
      expect(
        sql.filter((text) =>
          text.startsWith(
            'SELECT "_sync_row_id" AS row_id, "_sync_server_version"',
          ),
        ),
      ).toEqual([]);
      expect(
        sql.filter((text) =>
          text.includes('FROM sync_changes ch CROSS JOIN km'),
        ),
      ).toHaveLength(1);
    } finally {
      await db.close();
    }
  }, 60_000);
});

/**
 * SYNCULAR-PUSH-ROUNDTRIPS-003: declared-reference enforcement reads the
 * parents a commit names once per table, never once per reference. A fight
 * start writes its chronicle row, the fight row, and three combatants; the
 * chronicle and all three combatants point at the same fight, so the commit
 * pays one candidate-state read for its single parent table instead of four.
 */
describe('push declared-reference reads (SYNCULAR-PUSH-ROUNDTRIPS-003)', () => {
  const COMBAT_COLUMNS = [
    { name: 'id', type: 'string' as const, nullable: false },
    { name: 'project_id', type: 'string' as const, nullable: false },
  ];
  const CHILD_COLUMNS = [
    ...COMBAT_COLUMNS,
    { name: 'combat_id', type: 'string' as const, nullable: false },
  ];
  const REF_SCHEMA: ServerSchema = {
    version: 1,
    tables: [
      {
        name: 'combats',
        columns: COMBAT_COLUMNS,
        primaryKey: 'id',
        scopes: ['project:{project_id}'],
      },
      ...['chronicle', 'combatants'].map((name) => ({
        name,
        columns: CHILD_COLUMNS,
        primaryKey: 'id',
        scopes: ['project:{project_id}'],
        references: [
          {
            column: 'combat_id',
            parentTable: 'combats',
            onDelete: 'CASCADE' as const,
          },
        ],
        indexes: [{ name: `${name}_by_combat`, columns: ['combat_id'] }],
      })),
    ],
  };
  const payload = (id: string, combatId: string): Uint8Array =>
    encodeSparseRow(CHILD_COLUMNS, 0, [id, 'p1', combatId]);

  test('a 4-row commit over 2 tables reads its parent table once', async () => {
    const db = await PGlite.create();
    const sql: string[] = [];
    const inner = pgliteExecutor(db);
    const wrap = (client: PgQueryable): PgQueryable => ({
      query: (text, params) => {
        sql.push(text);
        return client.query(text, params);
      },
    });
    const storage = new PostgresServerStorage({
      query: wrap(inner).query,
      transaction: (fn) => inner.transaction((client) => fn(wrap(client))),
    });
    const ctx: SyncRequestContext = {
      partition: 'part-1',
      actorId: 'actor-1',
      schema: REF_SCHEMA,
      storage,
      segments: new MemorySegmentStore(),
      resolveScopes: () => ({ project_id: ['p1'] }),
      clock: () => 1_750_000_000_000,
    };
    await storage.ensureSchema(compileSchema(REF_SCHEMA));
    await storage.touchPartition(
      ctx.partition,
      1_750_000_000_000,
      TEST_LOG_EPOCH,
    );
    try {
      // The fight row lands first: a parent staged in the same commit
      // answers from memory and costs no read.
      await handleSyncRequest(
        requestBytes([
          pushCommit('fight', [
            upsert(
              'combats',
              'f1',
              encodeSparseRow(COMBAT_COLUMNS, 0, ['f1', 'p1']),
              0,
            ),
          ]),
        ]),
        ctx,
      );
      sql.length = 0;
      const message = decodeMessage(
        await handleSyncRequest(
          requestBytes([
            pushCommit('fight-start', [
              upsert('chronicle', 'ch1', payload('ch1', 'f1'), 0),
              upsert('combatants', 'ca1', payload('ca1', 'f1'), 0),
              upsert('combatants', 'ca2', payload('ca2', 'f1'), 0),
              upsert('combatants', 'ca3', payload('ca3', 'f1'), 0),
            ]),
          ]),
          ctx,
        ),
      );
      if (message.msgKind !== 'response') throw new Error('expected response');
      expect(pushResults(message)[0]?.status).toBe('applied');
      const readBacks = sql.filter((text) =>
        text.startsWith(
          'SELECT "_sync_row_id" AS row_id, "_sync_server_version"',
        ),
      );
      // One parent table (combats); before batching this was one statement
      // per reference, four for this commit.
      expect(readBacks).toHaveLength(1);
      expect(readBacks[0]).toContain('IN (SELECT jsonb_array_elements_text(');
      expect(await storage.getRow('part-1', 'combats', 'f1')).toBeDefined();
      expect(await storage.getRow('part-1', 'combatants', 'ca3')).toBeDefined();
    } finally {
      await db.close();
    }
  }, 60_000);
});

describe('one push request, one transaction (SYNCULAR-PUSH-ROUNDTRIPS-001)', () => {
  const tenCommits = Array.from({ length: 10 }, (_, i) =>
    pushCommit(
      `batch-${i}`,
      [upsert('tasks', `batch-t${i}`, taskRow(`batch-t${i}`, 'p1'))],
      i + 1,
    ),
  );

  test('Postgres applies 10 commits in BEGIN, the lock, the admission read, one write and COMMIT', async () => {
    const db = await PGlite.create();
    const counting = countingExecutor(pgliteExecutor(db));
    const storage = new PostgresServerStorage(counting.executor);
    const notified: number[] = [];
    const ctx: SyncRequestContext = {
      ...(await context(storage)),
      realtime: {
        notifyCommit: (_partition, commit) => {
          notified.push(commit.commitSeq);
        },
      },
    };
    const push = async () =>
      pushResults(
        decodeMessage(
          await handleSyncRequest(
            requestBytes(tenCommits, 'client-1', 1, TEST_LOG_EPOCH, 'outbox-1'),
            ctx,
          ),
        ) as ResponseMessage,
      );
    try {
      // Warm-up: the partition's first push initializes its lock row.
      expect(
        pushResults(
          await sync(ctx, [
            pushCommit('warm-up', [
              upsert('tasks', 'warm-up', taskRow('warm-up', 'p1')),
            ]),
          ]),
        )[0]?.status,
      ).toBe('applied');
      counting.transactions.length = 0;
      notified.length = 0;
      const applied = await push();
      expect(applied.map((result) => result.status)).toEqual(
        tenCommits.map(() => 'applied'),
      );
      const seqs = applied.map((result) => result.commitSeq ?? 0);
      expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
      expect(notified).toEqual(seqs);
      // One BEGIN for the whole request.
      expect(counting.transactions).toHaveLength(1);
      const statements = counting.transactions[0]!;
      const matching = (pattern: RegExp) =>
        statements.filter((text) => pattern.test(text));
      expect(
        matching(/FROM sync_partitions WHERE partition=\$1 FOR UPDATE/),
      ).toHaveLength(1);
      // The admission statement carries the §6.3.2 settlement and the gate;
      // the write statement carries every row, commit and result. No commit
      // read its own writes, so none took a savepoint.
      expect(matching(/sync_schema_meta/)).toHaveLength(1);
      expect(matching(/sync_push_watermarks/)).toHaveLength(1);
      expect(matching(/^SAVEPOINT/)).toHaveLength(0);
      expect(matching(/INSERT INTO sync_push_results/)).toHaveLength(1);
      expect(statements).toHaveLength(3);

      // An idempotent replay returns the stored results without a write.
      counting.transactions.length = 0;
      const replayed = await push();
      expect(replayed.map((result) => result.status)).toEqual(
        tenCommits.map(() => 'cached'),
      );
      expect(replayed.map((result) => result.commitSeq)).toEqual(seqs);
      expect(notified).toEqual(seqs);
      expect(counting.transactions).toHaveLength(1);
      // The lock and the admission read, which carries the settlement.
      expect(counting.transactions[0]).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  for (const backend of ['postgres/pglite', 'sqlite', 'd1/double'] as const) {
    test(`${backend}: a rejected middle commit rolls back only itself`, async () => {
      const db =
        backend === 'postgres/pglite' ? await PGlite.create() : undefined;
      const d1 =
        backend === 'd1/double'
          ? new D1ServerStorage(new D1DatabaseDouble(), {
              pushApplySerialized: true,
            })
          : undefined;
      if (d1 !== undefined) {
        while (!(await d1.migrateSchema(compileSchema(TEST_SCHEMA))).complete) {
          // Resume the resumable D1 migration until it lands.
        }
      }
      const storage: ServerStorage =
        db !== undefined
          ? new PostgresServerStorage(pgliteExecutor(db))
          : (d1 ?? new SqliteServerStorage());
      const notified: number[] = [];
      const ctx: SyncRequestContext = {
        ...(await context(storage)),
        realtime: {
          notifyCommit: (_partition, commit) => {
            notified.push(commit.commitSeq);
          },
        },
        // The scan reaches the staged rows, so the middle commit has written
        // them before its rejection rolls them back.
        commitValidator: async ({ clientCommitId, read }) => {
          if (clientCommitId !== 'middle') return;
          expect(
            (
              await read.scanRows({
                table: 'tasks',
                scopeFilter: { project_id: ['p1'] },
              })
            ).map(({ row }) => row.id),
          ).toContain('middle-a');
          throw new CommitValidationRejection(1, 'app.rejected');
        },
      };
      try {
        const results = pushResults(
          decodeMessage(
            await handleSyncRequest(
              requestBytes(
                [
                  pushCommit(
                    'first',
                    [upsert('tasks', 'first', taskRow('first', 'p1'))],
                    1,
                  ),
                  pushCommit(
                    'middle',
                    [
                      upsert('tasks', 'middle-a', taskRow('middle-a', 'p1')),
                      upsert('tasks', 'middle-b', taskRow('middle-b', 'p1')),
                    ],
                    2,
                  ),
                  pushCommit(
                    'last',
                    [upsert('tasks', 'last', taskRow('last', 'p1'))],
                    3,
                  ),
                ],
                'client-1',
                1,
                TEST_LOG_EPOCH,
                'outbox-1',
              ),
              ctx,
            ),
          ) as ResponseMessage,
        );
        expect(
          results.map((result) => [result.clientCommitId, result.status]),
        ).toEqual([
          ['first', 'applied'],
          ['middle', 'rejected'],
          ['last', 'applied'],
        ]);
        expect(results[1]?.results).toMatchObject([
          { opIndex: 1, status: 'error', code: 'app.rejected' },
        ]);
        const [first, , last] = results;
        expect(last?.commitSeq).toBe((first?.commitSeq ?? 0) + 1);
        expect(notified).toEqual([first?.commitSeq ?? 0, last?.commitSeq ?? 0]);
        for (const [rowId, present] of [
          ['first', true],
          ['middle-a', false],
          ['middle-b', false],
          ['last', true],
        ] as const) {
          expect(
            (await storage.getRow('part-1', 'tasks', rowId)) !== undefined,
          ).toBe(present);
        }
        expect(await storage.getMaxCommitSeq('part-1')).toBe(
          last?.commitSeq ?? 0,
        );
        expect(
          (await storage.getPushResult('part-1', 'client-1', 'middle'))?.status,
        ).toBe('rejected');
      } finally {
        await db?.close();
      }
    });
  }

  test('d1/double: a failure after a flushed commit still notifies that commit', async () => {
    const d1 = new D1ServerStorage(new D1DatabaseDouble(), {
      pushApplySerialized: true,
    });
    while (!(await d1.migrateSchema(compileSchema(TEST_SCHEMA))).complete) {
      // Resume the resumable D1 migration until it lands.
    }
    // A storage fault, not a rejection: the second commit's append throws.
    const storage = new Proxy(d1, {
      get(target, property) {
        if (property !== 'begin') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (partition: string) => {
          const tx = await target.begin(partition);
          return new Proxy(tx, {
            get(txTarget, txProperty) {
              if (txProperty === 'appendCommit') {
                return async (
                  ...args: Parameters<StorageTransaction['appendCommit']>
                ) => {
                  if (args[0].clientCommitId === 'broken') {
                    throw new Error('injected storage fault');
                  }
                  return txTarget.appendCommit(...args);
                };
              }
              const value = Reflect.get(txTarget, txProperty, txTarget);
              return typeof value === 'function' ? value.bind(txTarget) : value;
            },
          });
        };
      },
    });
    const notified: string[] = [];
    const ctx: SyncRequestContext = {
      ...(await context(storage)),
      realtime: {
        notifyCommit: (_partition, commit) => {
          notified.push(commit.changes.map((change) => change.rowId).join());
        },
      },
    };
    // The request fails without a single PUSH_RESULT.
    await expect(
      handleSyncRequest(
        requestBytes(
          [
            pushCommit(
              'durable',
              [upsert('tasks', 'durable', taskRow('durable', 'p1'))],
              1,
            ),
            pushCommit(
              'broken',
              [upsert('tasks', 'broken', taskRow('broken', 'p1'))],
              2,
            ),
          ],
          'client-1',
          1,
          TEST_LOG_EPOCH,
          'outbox-1',
        ),
        ctx,
      ),
    ).rejects.toThrow('injected storage fault');
    // The first commit's batch reached D1 before the fault: it stays applied
    // and its notification still leaves; the failed commit leaves nothing.
    expect(notified).toEqual(['durable']);
    expect(await d1.getRow('part-1', 'tasks', 'durable')).toBeDefined();
    expect(await d1.getRow('part-1', 'tasks', 'broken')).toBeUndefined();
    expect(
      (await d1.getPushResult('part-1', 'client-1', 'durable'))?.status,
    ).toBe('applied');
  });
});

/**
 * SYNCULAR-PUSH-LOCK-STATEMENTS-001 and SYNCULAR-PUSH-QUERY-CURSOR-001: the
 * statements a push request runs under the partition lock. The counting
 * executor sees the statements between BEGIN and COMMIT, which the executor
 * issues itself.
 */
describe('statements under the partition lock (SYNCULAR-PUSH-LOCK-STATEMENTS-001)', () => {
  const tasksInProject = {
    plan: {
      sql: 'SELECT id FROM tasks WHERE project_id = ?',
      relations: [{ table: 'tasks', start: 15, end: 20 }],
    },
    params: ['p1'],
    tables: ['tasks'],
  };
  const docsInProject = {
    plan: {
      sql: 'SELECT id FROM docs WHERE project_id = ?',
      relations: [{ table: 'docs', start: 15, end: 19 }],
    },
    params: ['p1'],
    tables: ['docs'],
  };

  async function measure(
    validator: SyncRequestContext['commitValidator'],
    frames: RequestFrame[],
  ) {
    const db = await PGlite.create();
    const counting = countingExecutor(pgliteExecutor(db));
    const storage = new PostgresServerStorage(counting.executor);
    const ctx: SyncRequestContext = {
      ...(await context(storage)),
      ...(validator === undefined ? {} : { commitValidator: validator }),
    };
    const push = async (pushed: RequestFrame[]) =>
      pushResults(
        decodeMessage(
          await handleSyncRequest(
            requestBytes(pushed, 'client-1', 1, TEST_LOG_EPOCH, 'outbox-1'),
            ctx,
          ),
        ) as ResponseMessage,
      );
    // The partition's first commit initializes its lock row.
    const warmUp = await storage.begin('part-1');
    await warmUp.appendCommit({
      clientId: 'host',
      clientCommitId: 'warm-up',
      actorId: 'host',
      createdAtMs: 0,
      changes: [],
    });
    await warmUp.commit();
    counting.transactions.length = 0;
    const results = await push(frames);
    const statements = counting.transactions.flat();
    await db.close();
    return { results, statements, transactions: counting.transactions };
  }

  const oneRow = (id: string, seq: number, title = 'task') =>
    pushCommit(id, [upsert('tasks', id, taskRow(id, 'p1', title))], seq);

  test('a one-row commit runs the lock, the admission read and one write', async () => {
    const { results, statements } = await measure(undefined, [
      oneRow('day-note', 2),
    ]);
    expect(results[0]?.status).toBe('applied');
    // With BEGIN and COMMIT: 5 statements under the lock.
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('FOR UPDATE');
    expect(statements[1]).toContain('sync_push_watermarks');
    expect(statements[1]).toContain('sync_schema_meta');
    expect(statements[2]).toContain('INSERT INTO "tasks"');
    expect(statements[2]).toContain('INSERT INTO sync_changes');
    expect(statements[2]).toContain('INSERT INTO sync_push_results');
  });

  test('a validator reading rows by id adds only its reads', async () => {
    const { results, statements } = await measure(
      async ({ read }) => {
        for (const id of ['day-note', 'other-1', 'other-2', 'other-3']) {
          await read.getRow('tasks', id);
        }
      },
      [oneRow('day-note', 2)],
    );
    expect(results[0]?.status).toBe('applied');
    // The staged row answers from memory; the three others are reads.
    expect(statements).toHaveLength(3 + 3);
    expect(statements.some((text) => text.startsWith('SAVEPOINT'))).toBe(false);
  });

  test('a registered query reads the cursor from the lock (SYNCULAR-PUSH-QUERY-CURSOR-001)', async () => {
    const cursors: number[] = [];
    const ids: string[][] = [];
    const { results, statements } = await measure(
      async ({ read }) => {
        const { rows, maxCommitSeq } =
          await read.queryAuthoritative(tasksInProject);
        ids.push(rows.map((row) => String(row.id)));
        cursors.push(maxCommitSeq);
      },
      [oneRow('day-note', 2), oneRow('op-edit', 3)],
    );
    expect(results.map((result) => result.commitSeq)).toEqual([2, 3]);
    // The query sees its commit's staged row and the cursor before it.
    expect(ids).toEqual([['day-note'], ['day-note', 'op-edit']]);
    expect(cursors).toEqual([1, 2]);
    expect(statements.filter((text) => text.startsWith('SAVEPOINT'))).toEqual([
      'SAVEPOINT syncular_push_candidate',
      'SAVEPOINT syncular_push_candidate',
    ]);
    expect(
      statements.filter((text) =>
        /^SELECT max_commit_seq FROM sync_partitions WHERE partition=\$1$/.test(
          text,
        ),
      ),
    ).toEqual([]);
    // Per commit: the savepoint, the row write and the query; the first
    // commit's append and result precede the second commit's savepoint.
    expect(statements).toHaveLength(2 + 3 + 1 + 3 + 1);
  });

  test('a pinned read snapshot reads the cursor once for all its registered queries (SYNCULAR-SNAPSHOT-MAX-COMMIT-SEQ-001)', async () => {
    const db = await PGlite.create();
    const counting = countingExecutor(pgliteExecutor(db));
    const storage = new PostgresServerStorage(counting.executor);
    const cursorReads = () =>
      counting.transactions
        .flat()
        .filter((text) =>
          /^SELECT max_commit_seq FROM sync_partitions WHERE partition=\$1$/.test(
            text,
          ),
        ).length;
    try {
      const ctx = await context(storage);
      await sync(ctx, [
        pushCommit('seed', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
      ]);
      const committed = await storage.getMaxCommitSeq('part-1');
      expect(committed).toBe(1);

      counting.transactions.length = 0;
      const snapshot = await storage.begin('part-1');
      try {
        await prepareReadTransaction(snapshot, TEST_SCHEMA.version);
        const concurrent = await Promise.all([
          snapshot.queryAuthoritative!(tasksInProject),
          snapshot.queryAuthoritative!(tasksInProject),
          snapshot.queryAuthoritative!(docsInProject),
        ]);
        const later = await snapshot.queryAuthoritative!(tasksInProject);
        expect(
          [...concurrent, later].map(({ rows, maxCommitSeq }) => [
            rows.map((row) => String(row.id)),
            maxCommitSeq,
          ]),
        ).toEqual([
          [['t1'], committed],
          [['t1'], committed],
          [[], committed],
          [['t1'], committed],
        ]);
        expect(cursorReads()).toBe(1);
      } finally {
        await snapshot.rollback();
      }

      // Unpinned, each statement reads committed state of its own start, so
      // every query reads the cursor beside its rows.
      counting.transactions.length = 0;
      const unpinned = await storage.begin('part-1');
      try {
        await unpinned.queryAuthoritative!(tasksInProject);
        await unpinned.queryAuthoritative!(tasksInProject);
        expect(cursorReads()).toBe(2);
      } finally {
        await unpinned.rollback();
      }
    } finally {
      await db.close();
    }
  });

  test('a registered query over a table the commit did not write runs before its write', async () => {
    const cursors: number[] = [];
    const { results, statements } = await measure(
      async ({ read }) => {
        cursors.push(
          (await read.queryAuthoritative(docsInProject)).maxCommitSeq,
        );
      },
      [oneRow('day-note', 2), oneRow('op-edit', 3)],
    );
    expect(results.map((result) => result.commitSeq)).toEqual([2, 3]);
    expect(cursors).toEqual([1, 2]);
    // With BEGIN and COMMIT, a one-query commit runs 6 statements under the
    // lock: the queries run first, and both commits write in one statement.
    expect(statements).toHaveLength(2 + 2 + 1);
    expect(statements[2]).toContain('FROM "docs"');
    expect(statements[3]).toContain('FROM "docs"');
    expect(statements[4]).toContain('INSERT INTO "tasks"');
    expect(statements[4]).toContain('INSERT INTO sync_push_results');
    expect(statements.some((text) => text.startsWith('SAVEPOINT'))).toBe(false);
  });

  test('a scan of a table the commit did not write takes no savepoint', async () => {
    const { results, statements } = await measure(
      async ({ read }) => {
        await read.scanRows({
          table: 'docs',
          scopeFilter: { project_id: ['p1'] },
        });
      },
      [oneRow('day-note', 2)],
    );
    expect(results[0]?.status).toBe('applied');
    expect(statements).toHaveLength(3 + 1);
    expect(statements[3]).toContain('INSERT INTO "tasks"');
    expect(statements.some((text) => text.startsWith('SAVEPOINT'))).toBe(false);
  });

  test('a commit rejected after a query over another table discards its writes', async () => {
    const db = await PGlite.create();
    const counting = countingExecutor(pgliteExecutor(db));
    const storage = new PostgresServerStorage(counting.executor);
    const ctx: SyncRequestContext = {
      ...(await context(storage)),
      commitValidator: async ({ clientCommitId, read }) => {
        await read.queryAuthoritative(docsInProject);
        if (clientCommitId === 'refused') {
          throw new CommitValidationRejection(0, 'app.rejected');
        }
      },
    };
    try {
      counting.transactions.length = 0;
      const results = pushResults(
        decodeMessage(
          await handleSyncRequest(
            requestBytes(
              [oneRow('kept', 1), oneRow('refused', 2), oneRow('after', 3)],
              'client-1',
              1,
              TEST_LOG_EPOCH,
              'outbox-1',
            ),
            ctx,
          ),
        ) as ResponseMessage,
      );
      expect(results.map((result) => result.status)).toEqual([
        'applied',
        'rejected',
        'applied',
      ]);
      expect(results[2]?.commitSeq).toBe((results[0]?.commitSeq ?? 0) + 1);
      expect(
        await storage.getRow('part-1', 'tasks', 'refused'),
      ).toBeUndefined();
      expect(await storage.getRow('part-1', 'tasks', 'kept')).toBeDefined();
      expect(await storage.getRow('part-1', 'tasks', 'after')).toBeDefined();
      const statements = counting.transactions.flat();
      expect(
        statements.some(
          (text) => text.startsWith('SAVEPOINT') || text.startsWith('ROLLBACK'),
        ),
      ).toBe(false);
    } finally {
      await db.close();
    }
  });

  test('ten one-row commits run the same five statements', async () => {
    const { results, statements } = await measure(
      undefined,
      Array.from({ length: 10 }, (_, i) => oneRow(`batch-${i}`, i + 2)),
    );
    expect(results.map((result) => result.commitSeq)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 2),
    );
    expect(statements).toHaveLength(3);
  });

  test('a constraint on a closed commit reruns the request and rejects only that commit', async () => {
    const db = await PGlite.create();
    const counting = countingExecutor(pgliteExecutor(db));
    const storage = new PostgresServerStorage(counting.executor);
    const notified: number[] = [];
    const ctx: SyncRequestContext = {
      ...(await context(storage)),
      realtime: {
        notifyCommit: (_partition, commit) => {
          notified.push(commit.commitSeq);
        },
      },
    };
    // A host constraint PostgreSQL checks only when the staged row is written.
    await db.exec(
      "ALTER TABLE tasks ADD CONSTRAINT tasks_title_allowed CHECK (title <> 'forbidden')",
    );
    const push = async (pushed: RequestFrame[]) =>
      pushResults(
        decodeMessage(
          await handleSyncRequest(
            requestBytes(pushed, 'client-1', 1, TEST_LOG_EPOCH, 'outbox-1'),
            ctx,
          ),
        ) as ResponseMessage,
      );
    try {
      counting.transactions.length = 0;
      const single = await push([oneRow('alone', 1, 'forbidden')]);
      expect(single[0]).toMatchObject({
        status: 'rejected',
        results: [{ opIndex: 0, code: 'sync.constraint_violation' }],
      });
      // The first transaction rolled back; the rerun wrote the rejection.
      expect(counting.transactions).toHaveLength(2);
      expect(
        (await storage.getPushResult('part-1', 'client-1', 'alone'))?.status,
      ).toBe('rejected');
      expect(
        (
          await db.query(
            'SELECT outbox_id, through_seq FROM sync_push_watermarks',
          )
        ).rows,
      ).toEqual([{ outbox_id: 'outbox-1', through_seq: 1 }]);

      const batch = await push([
        oneRow('first', 2),
        oneRow('middle', 3, 'forbidden'),
        oneRow('last', 4),
      ]);
      expect(batch.map((result) => result.status)).toEqual([
        'applied',
        'rejected',
        'applied',
      ]);
      const [first, , last] = batch;
      expect(last?.commitSeq).toBe((first?.commitSeq ?? 0) + 1);
      expect(notified).toEqual([first?.commitSeq ?? 0, last?.commitSeq ?? 0]);
      expect(await storage.getRow('part-1', 'tasks', 'middle')).toBeUndefined();
      expect(await storage.getRow('part-1', 'tasks', 'last')).toBeDefined();
      expect(await storage.getMaxCommitSeq('part-1')).toBe(
        last?.commitSeq ?? 0,
      );
    } finally {
      await db.close();
    }
  });
});
