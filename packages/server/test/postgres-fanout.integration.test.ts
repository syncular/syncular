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
import type { WakeReason } from '@syncular/core';
import {
  FANOUT_CHANNEL,
  type FanoutWakeTarget,
  type PgExecutor,
  type PgNotificationConnection,
  type PgQueryable,
  PostgresFanout,
  PostgresServerStorage,
} from '@syncular/server';

const PG_URL = process.env.SYNCULAR_PG_URL;

// biome-ignore lint/suspicious/noExplicitAny: Bun.sql is version-fluid.
const BunSQL = (Bun as any).SQL as undefined | (new (url: string) => any);

const gate =
  PG_URL !== undefined && BunSQL !== undefined ? describe : describe.skip;

// biome-ignore lint/suspicious/noExplicitAny: driver handle is dynamic.
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
// biome-ignore lint/suspicious/noExplicitAny: driver handle is dynamic.
function bunSqlExecutor(sql: any): PgExecutor {
  const q = queryableOver(sql);
  return {
    query: q.query,
    async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic tx handle.
      return sql.begin(async (tx: any) => fn(queryableOver(tx)));
    },
    async close() {
      await sql.end();
    },
  };
}

gate('Postgres fanout integration (SYNCULAR_PG_URL)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic Bun.sql handles.
  const handles: any[] = [];
  afterAll(async () => {
    for (const h of handles) await h.end?.().catch(() => {});
  });

  test('storage migrates and allocates commitSeq on real Postgres', async () => {
    const sql = new (BunSQL as new (url: string) => unknown)(PG_URL as string);
    handles.push(sql);
    const storage = new PostgresServerStorage(bunSqlExecutor(sql));
    await storage.migrate();
    const partition = `it-${crypto.randomUUID()}`;
    const tx = await storage.begin(partition);
    const seq = await tx.appendCommit({
      clientId: 'c',
      clientCommitId: 'k0',
      actorId: 'a',
      createdAtMs: Date.now(),
      changes: [
        {
          table: 'tasks',
          rowId: 'r0',
          op: 'upsert',
          rowVersion: 1,
          scopes: { project_id: 'p1' },
          payload: new Uint8Array([1, 2, 3]),
        },
      ],
    });
    await tx.commit();
    expect(seq).toBe(1);
    const window = await storage.readCommitWindow(partition, {
      table: 'tasks',
      scopeFilter: { project_id: ['p1'] },
      afterSeq: 0,
      throughSeq: 1,
      limitChanges: 10,
    });
    expect(window[0]?.changes[0]?.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('NOTIFY on one connection wakes a LISTEN on another', async () => {
    // Two independent connections: a listener and a notifier.
    const listenSql = new (BunSQL as new (url: string) => unknown)(
      PG_URL as string,
    );
    const notifySql = new (BunSQL as new (url: string) => unknown)(
      PG_URL as string,
    );
    handles.push(listenSql, notifySql);

    const wakes: Array<{ partition: string; reason: WakeReason }> = [];
    const hub: FanoutWakeTarget = {
      wake(partition, reason) {
        wakes.push({ partition, reason });
      },
    };

    const conn: PgNotificationConnection = {
      async listen(channel, handler) {
        // biome-ignore lint/suspicious/noExplicitAny: Bun.sql listen shape.
        await (listenSql as any).listen(channel, (payload: string) =>
          handler(payload),
        );
      },
      async notify(channel, payload) {
        // biome-ignore lint/suspicious/noExplicitAny: unsafe param call.
        await (notifySql as any).unsafe('SELECT pg_notify($1, $2)', [
          channel,
          payload,
        ]);
      },
    };

    const fanout = new PostgresFanout(conn);
    await fanout.install(hub);
    // Give the LISTEN a moment to register on the server.
    await new Promise((r) => setTimeout(r, 200));

    const partition = `it-${crypto.randomUUID()}`;
    await fanout.notifyCommit(partition, 5);

    // Poll for the cross-connection delivery.
    const deadline = Date.now() + 3000;
    while (wakes.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(wakes).toContainEqual({
      partition,
      reason: 'catchup-required',
    });
    expect(FANOUT_CHANNEL).toBe('syncular_commit');
  });
});
