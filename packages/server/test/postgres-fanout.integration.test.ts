/**
 * Cross-connection LISTEN/NOTIFY integration — env-gated on SYNCULAR_PG_URL.
 *
 * pglite is single-connection and cannot exercise real cross-instance
 * NOTIFY, so this test runs only against a real Postgres reachable at
 * `SYNCULAR_PG_URL`; without it the whole describe block skips cleanly. It
 * wires Bun.sql (built into bun, zero runtime dep) as both the storage
 * executor and the notification connection — a worked example of the
 * production driver seam.
 *
 *   SYNCULAR_PG_URL=postgres://user:pass@localhost:5432/db \
 *     bun test packages/server/test/postgres-fanout.integration.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  decodeMessage,
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type PushResultFrame,
  type RowColumn,
  type WakeReason,
} from '@syncular/core';
import {
  compileSchema,
  FANOUT_CHANNEL,
  type FanoutWakeTarget,
  handleSyncRequest,
  MemorySegmentStore,
  type PgExecutor,
  type PgNotificationConnection,
  type PgQueryable,
  PostgresFanout,
  PostgresServerStorage,
  type ServerSchema,
  type ServerStorage,
} from '@syncular/server';

const PG_URL = process.env.SYNCULAR_PG_URL;

// oxlint-disable-next-line typescript/no-explicit-any -- Bun.sql is version-fluid.
const BunSQL = (Bun as any).SQL as undefined | (new (url: string) => any);

const gate =
  PG_URL !== undefined && BunSQL !== undefined ? describe : describe.skip;

const TASK_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];

const SYNC_SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: TASK_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

// oxlint-disable-next-line typescript/no-explicit-any -- driver handle is dynamic.
function queryableOver(handle: any): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      const rows = (await handle.unsafe(
        text,
        params ? [...params] : [],
      )) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
}

/** A `PgExecutor` over Bun.sql — the production-shape adapter (README). */
// oxlint-disable-next-line typescript/no-explicit-any -- driver handle is dynamic.
function bunSqlExecutor(sql: any): PgExecutor {
  const q = queryableOver(sql);
  return {
    query: q.query,
    async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      // oxlint-disable-next-line typescript/no-explicit-any -- dynamic tx handle.
      return sql.begin(async (tx: any) => fn(queryableOver(tx)));
    },
    async close() {
      await sql.end();
    },
  };
}

gate('Postgres fanout integration (SYNCULAR_PG_URL)', () => {
  // oxlint-disable-next-line typescript/no-explicit-any -- dynamic Bun.sql handles.
  const handles: any[] = [];
  afterAll(async () => {
    for (const h of handles) await h.end?.().catch(() => {});
  });

  test('storage migrates and allocates commitSeq on real Postgres', async () => {
    const sql = new (BunSQL as new (url: string) => unknown)(PG_URL as string);
    handles.push(sql);
    const executor = bunSqlExecutor(sql);
    const storage = new PostgresServerStorage(executor);
    await storage.migrate();
    const partition = `it-${crypto.randomUUID()}`;
    const tx = await storage.begin(partition);
    let seq: number;
    try {
      seq = await tx.appendCommit({
        clientId: 'c',
        clientCommitId: 'k0',
        actorId: 'a',
        createdAtMs: Date.now(),
        changes: [
          { table: 'tasks', rowId: 'unscoped', op: 'delete', scopes: {} },
          {
            table: 'tasks',
            rowId: 'r0',
            op: 'upsert',
            rowVersion: 1,
            scopes: { project_id: 'p1', org_id: "org's 雪" },
            payload: new Uint8Array([1, 2, 3]),
          },
          {
            table: 'tasks',
            rowId: 'deleted',
            op: 'delete',
            scopes: { project_id: 'p1' },
          },
        ],
      });
      await tx.commit();
    } finally {
      await tx.rollback();
    }
    expect(seq).toBe(1);
    expect(
      (
        await executor.query(
          'SELECT jsonb_typeof(scopes) AS scope_type FROM sync_changes WHERE partition=$1',
          [partition],
        )
      ).rows,
    ).toEqual([
      { scope_type: 'object' },
      { scope_type: 'object' },
      { scope_type: 'object' },
    ]);
    const window = await storage.readCommitWindow(partition, {
      table: 'tasks',
      scopeFilter: { project_id: ['p1'] },
      afterSeq: 0,
      throughSeq: 1,
      limitChanges: 10,
    });
    expect(window[0]?.changes[0]?.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(window[0]?.changes.map((change) => change.rowId)).toEqual([
      'r0',
      'deleted',
    ]);
    // Historical Bun SQL bindings stored serialized scopes as a JSONB string.
    // Those rows must remain readable alongside the new object representation.
    await executor.query(
      'UPDATE sync_changes SET scopes=to_jsonb(scopes::text) WHERE partition=$1',
      [partition],
    );
    expect(
      await storage.readCommitWindow(partition, {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterSeq: 0,
        throughSeq: 1,
        limitChanges: 10,
      }),
    ).toEqual(window);
  });

  test('two real connections apply an overlapping duplicate exactly once', async () => {
    const leftSql = new (BunSQL as new (url: string) => unknown)(
      PG_URL as string,
    );
    const rightSql = new (BunSQL as new (url: string) => unknown)(
      PG_URL as string,
    );
    handles.push(leftSql, rightSql);
    const leftStorage = new PostgresServerStorage(bunSqlExecutor(leftSql));
    const rightStorage = new PostgresServerStorage(bunSqlExecutor(rightSql));
    await leftStorage.migrate();
    await leftStorage.ensureSchema(compileSchema(SYNC_SCHEMA));
    await rightStorage.ensureSchema(compileSchema(SYNC_SCHEMA));

    let optimisticArrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pauseFirstLookup = (storage: ServerStorage): ServerStorage =>
      new Proxy(storage, {
        get(target, property) {
          if (property === 'getPushResult') {
            return async (...args: [string, string, string]) => {
              optimisticArrivals += 1;
              if (optimisticArrivals <= 2) {
                if (optimisticArrivals === 2) release();
                await gate;
              }
              return target.getPushResult(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

    const partition = `overlap-${crypto.randomUUID()}`;
    const { logEpoch } = await leftStorage.touchPartition(
      partition,
      Date.now(),
      crypto.randomUUID(),
    );
    const bytes = encodeMessage({
      wireVersion: PROTOCOL_WIRE_VERSION,
      msgKind: 'request',
      frames: [
        {
          type: 'REQ_HEADER',
          clientId: 'overlap-client',
          schemaVersion: 1,
          logEpoch,
        },
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'overlap-commit',
          operations: [
            {
              table: 'tasks',
              rowId: 'overlap-row',
              op: 'upsert',
              payload: encodeRow(TASK_COLUMNS, ['overlap-row', 'p1', 'once']),
            },
          ],
        },
      ],
    });
    let validatorCalls = 0;
    let notifications = 0;
    const request = (storage: ServerStorage) =>
      handleSyncRequest(bytes, {
        partition,
        actorId: 'actor',
        schema: SYNC_SCHEMA,
        storage,
        segments: new MemorySegmentStore(),
        resolveScopes: () => ({ project_id: ['p1'] }),
        validators: {
          tasks: () => {
            validatorCalls += 1;
          },
        },
        realtime: {
          notifyCommit: () => {
            notifications += 1;
          },
        },
      });

    const [left, right] = await Promise.all([
      request(pauseFirstLookup(leftStorage)),
      request(pauseFirstLookup(rightStorage)),
    ]);
    const statusOf = (response: Uint8Array) => {
      const message = decodeMessage(response);
      if (message.msgKind !== 'response') throw new Error('expected response');
      return message.frames.find(
        (frame): frame is PushResultFrame => frame.type === 'PUSH_RESULT',
      )?.status;
    };
    expect([statusOf(left), statusOf(right)].sort()).toEqual([
      'applied',
      'cached',
    ]);
    expect(validatorCalls).toBe(1);
    expect(notifications).toBe(1);
    expect(
      (await leftStorage.getRow(partition, 'tasks', 'overlap-row'))
        ?.serverVersion,
    ).toBe(1);
    expect(await leftStorage.getMaxCommitSeq(partition)).toBe(1);
  });

  for (const firstOutcome of ['commit', 'rollback'] as const) {
    test(`concurrent first partition writers retain the lock after ${firstOutcome}`, async () => {
      const sql = new (BunSQL as new (url: string) => unknown)(
        PG_URL as string,
      );
      handles.push(sql);
      const base = bunSqlExecutor(sql);
      const bothMissing = Promise.withResolvers<void>();
      const firstLocked = Promise.withResolvers<void>();
      const secondInserting = Promise.withResolvers<void>();
      let missingReads = 0;
      const storages = [0, 1].map(
        (writer) =>
          new PostgresServerStorage({
            query: (text, params) => base.query(text, params),
            transaction: (fn) =>
              base.transaction((client) =>
                fn({
                  async query<Row = Record<string, unknown>>(
                    text: string,
                    params?: readonly unknown[],
                  ) {
                    if (
                      writer === 1 &&
                      text.startsWith('INSERT INTO sync_partitions')
                    ) {
                      await firstLocked.promise;
                      secondInserting.resolve();
                    }
                    const result = await client.query<Row>(text, params);
                    if (
                      text.includes('FOR UPDATE') &&
                      result.rows.length === 0
                    ) {
                      missingReads += 1;
                      if (missingReads === 2) bothMissing.resolve();
                      await bothMissing.promise;
                    }
                    return result;
                  },
                }),
              ),
          }),
      );
      const left = storages[0]!;
      const right = storages[1]!;
      await left.migrate();
      const partition = `first-writers-${crypto.randomUUID()}`;
      const first = await left.begin(partition);
      const second = await right.begin(partition);
      let secondAcquired = false;
      const firstLock = first.lockPartitionForPush!();
      const secondLock = second.lockPartitionForPush!().then(() => {
        secondAcquired = true;
      });
      try {
        await firstLock;
        firstLocked.resolve();
        await secondInserting.promise;
        expect(secondAcquired).toBe(false);
        expect(
          await first.appendCommit({
            clientId: 'first',
            clientCommitId: 'one',
            actorId: 'actor',
            createdAtMs: 1,
            changes: [],
          }),
        ).toBe(1);
        await first[firstOutcome]();
        await secondLock;
        expect(missingReads).toBe(2);
        const expectedSeq = firstOutcome === 'commit' ? 2 : 1;
        expect(
          await second.appendCommit({
            clientId: 'second',
            clientCommitId: 'two',
            actorId: 'actor',
            createdAtMs: 2,
            changes: [],
          }),
        ).toBe(expectedSeq);
        await second.commit();
        expect(await left.getMaxCommitSeq(partition)).toBe(expectedSeq);
      } finally {
        bothMissing.resolve();
        firstLocked.resolve();
        await first.rollback();
        await secondLock;
        await second.rollback();
      }
    });
  }

  test('NOTIFY on one connection wakes a LISTEN on another', async () => {
    // Two independent connections: a listener and a notifier.
    const listenSql = new (BunSQL as new (url: string) => unknown)(
      PG_URL as string,
    );
    const notifySql = new (BunSQL as new (url: string) => unknown)(
      PG_URL as string,
    );
    handles.push(listenSql, notifySql);

    const delivered = Promise.withResolvers<{
      partition: string;
      reason: WakeReason;
    }>();
    const hub: FanoutWakeTarget = {
      wake(partition, reason) {
        delivered.resolve({ partition, reason });
      },
    };

    const conn: PgNotificationConnection = {
      async listen(channel, handler) {
        // oxlint-disable-next-line typescript/no-explicit-any -- Bun.sql listen shape.
        await (listenSql as any).listen(channel, (payload: string) =>
          handler(payload),
        );
      },
      async notify(channel, payload) {
        // oxlint-disable-next-line typescript/no-explicit-any -- unsafe param call.
        await (notifySql as any).unsafe('SELECT pg_notify($1, $2)', [
          channel,
          payload,
        ]);
      },
    };

    const fanout = new PostgresFanout(conn);
    await fanout.install(hub);
    const partition = `it-${crypto.randomUUID()}`;
    await fanout.notifyCommit(partition, 5);
    expect(await delivered.promise).toEqual({
      partition,
      reason: 'catchup-required',
    });
    expect(FANOUT_CHANNEL).toBe('syncular_commit');
  });
});
