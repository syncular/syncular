/**
 * SYNCULAR-PUSH-ROUNDTRIPS-001: one push commit's storage statements are a
 * function of its tables, not of its operations. A 7-operation commit applies
 * in at most 8 statements inside its transaction and a refused one in at most
 * 3, so a remote Postgres pays per-table cost instead of per-row cost.
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
  compileSchema,
  handleSyncRequest,
  MemorySegmentStore,
  type PgExecutor,
  type PgQueryable,
  PostgresServerStorage,
  type ServerSchema,
  type SyncRequestContext,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import {
  docRow,
  pullHeader,
  pushCommit,
  pushResults,
  requestBytes,
  taskRow,
  TEST_LOG_EPOCH,
  TEST_SCHEMA,
  upsert,
} from './helpers';

/** Counts statements per scope: the pool and a storage transaction. */
function countingExecutor(inner: PgExecutor): {
  executor: PgExecutor;
  count: { pool: number; transaction: number };
} {
  const count = { pool: 0, transaction: 0 };
  const counted = (
    client: PgQueryable,
    scope: 'pool' | 'transaction',
  ): PgQueryable => ({
    query: (text, params) => {
      count[scope] += 1;
      return client.query(text, params);
    },
  });
  return {
    count,
    executor: {
      query: counted(inner, 'pool').query,
      transaction: (fn) =>
        inner.transaction((client) => fn(counted(client, 'transaction'))),
    },
  };
}

async function context(
  storage: PostgresServerStorage,
): Promise<SyncRequestContext> {
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
  test('a 7-op commit applies in ≤8 statements, a refused one in ≤3', async () => {
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
      expect(insertStatements).toBeLessThanOrEqual(8);

      counting.count.transaction = 0;
      const updated = pushResults(
        await sync(ctx, [pushCommit('update', sevenOps('a', 1))]),
      )[0];
      const updateStatements = counting.count.transaction;
      expect(updated?.status).toBe('applied');
      expect(updateStatements).toBeLessThanOrEqual(8);

      // The commit's writes all landed under the one commitSeq the result
      // reports, and the per-column versions advanced.
      const stored = await storage.getRow('part-1', 'tasks', 'a-t1');
      expect(stored?.serverVersion).toBe(2);
      const seq = updated?.commitSeq ?? 0;
      const commits = await storage.readCommitWindow('part-1', {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterSeq: seq - 1,
        throughSeq: seq,
        limitChanges: 10,
      });
      expect(commits).toHaveLength(1);
      expect(commits[0]?.changes).toHaveLength(4);

      // A refused commit writes nothing and costs the admission lock, the
      // admission read (which carries the row read-ahead), and the persisted
      // rejection.
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
      expect(refusedStatements).toBeLessThanOrEqual(3);
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
      expect(counting.count.transaction).toBeLessThanOrEqual(2);
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
      // Two tables of writes plus the read-ahead, savepoint, combined
      // allocation + change log, and the outcome record.
      expect(counting.count.transaction).toBeLessThanOrEqual(8);
      expect(await storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
      expect(await storage.getRow('part-1', 'docs', 'd1')).toBeUndefined();
      expect(
        (await storage.getRow('part-1', 'tasks', 't2'))?.serverVersion,
      ).toBe(2);
      const commits = await storage.readCommitWindow('part-1', {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterSeq: (message?.commitSeq ?? 1) - 1,
        throughSeq: message?.commitSeq ?? 1,
        limitChanges: 10,
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
            pullHeader({ limitCommits: 20 }),
            /**
             * Three subscriptions, one per table, at the cursor the client
             * held before the push: the reply carries this commit's changes
             * for all of them.
             */
            ...TABLES.map((table) => ({
              type: 'SUBSCRIPTION' as const,
              id: table,
              table,
              scopes: { project_id: ['p1'] },
              cursor,
            })),
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
        text.includes('LEFT JOIN sync_changes ch'),
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
        sql.filter((text) => text.includes('LEFT JOIN sync_changes ch')),
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

  test('a 5-row commit over 3 tables reads its parent table once', async () => {
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
      sql.length = 0;
      const message = decodeMessage(
        await handleSyncRequest(
          requestBytes([
            pushCommit('fight-start', [
              upsert(
                'combats',
                'f1',
                encodeSparseRow(COMBAT_COLUMNS, 0, ['f1', 'p1']),
                0,
              ),
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
      expect(readBacks[0]).toContain('=ANY(');
      expect(await storage.getRow('part-1', 'combats', 'f1')).toBeDefined();
      expect(await storage.getRow('part-1', 'combatants', 'ca3')).toBeDefined();
    } finally {
      await db.close();
    }
  }, 60_000);
});
