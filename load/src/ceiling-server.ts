/**
 * The server process of the partition ceiling. It imports the app module the
 * runner names (`CEILING_APP`), opens a `Bun.SQL` pool of `CEILING_POOL`
 * connections to `CEILING_PG_URL` and hands the app that executor. The
 * executor observes every transaction: from the statement that takes the
 * partition row lock (`SELECT … FROM sync_partitions … FOR UPDATE`) to the
 * end of COMMIT, it counts the statements and the time the lock is held.
 *
 * Routes: the app's handler for everything, plus `GET /__ceiling/stats`
 * (read and reset the lock counters and the process CPU share) and
 * `POST /__load/shutdown`.
 */
import type { PgExecutor } from '@syncular/server';
import type { CeilingApp } from './ceiling';
import { bunSqlExecutor } from './pg';

const app = (await import(String(process.env.CEILING_APP)))
  .default as CeilingApp;
const pool = bunSqlExecutor(String(process.env.CEILING_PG_URL), {
  max: Number(process.env.CEILING_POOL),
});

let since = { at: performance.now(), cpu: process.cpuUsage() };
let stats = {
  transactions: 0,
  statements: 0,
  holdMs: [] as number[],
  waitMs: [] as number[],
};

const executor: PgExecutor = {
  query: pool.executor.query,
  transaction: async (fn) => {
    let lockedAt: number | undefined;
    let statements = 0;
    const result = await pool.executor.transaction((client) =>
      fn({
        query: async <Row>(text: string, params?: readonly unknown[]) => {
          if (lockedAt !== undefined) statements += 1;
          const isLock =
            lockedAt === undefined &&
            text.includes('sync_partitions') &&
            text.includes('FOR UPDATE');
          const started = performance.now();
          const rows = await client.query<Row>(text, params);
          if (isLock) {
            lockedAt = performance.now();
            stats.waitMs.push(lockedAt - started);
          }
          return rows;
        },
      }),
    );
    if (lockedAt !== undefined) {
      stats.transactions += 1;
      // The statements after the lock, then COMMIT.
      stats.statements += statements + 1;
      stats.holdMs.push(performance.now() - lockedAt);
    }
    return result;
  },
  close: () => pool.sql.end(),
};

const handler = await app.createServer({
  executor,
  rowsPerCommit: Number(process.env.CEILING_ROWS ?? 1),
});

const server = Bun.serve({
  port: Number(process.env.SYNCULAR_LOAD_PORT ?? 0),
  // A request waiting minutes on the partition lock sends nothing meanwhile.
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__ceiling/stats') {
      const cpu = process.cpuUsage(since.cpu);
      const snapshot = {
        ...stats,
        cpu: (cpu.user + cpu.system) / 1000 / (performance.now() - since.at),
      };
      since = { at: performance.now(), cpu: process.cpuUsage() };
      stats = { transactions: 0, statements: 0, holdMs: [], waitMs: [] };
      return Response.json(snapshot);
    }
    if (path === '/__load/shutdown' && request.method === 'POST') {
      queueMicrotask(async () => {
        await pool.sql.end();
        process.exit(0);
      });
      return Response.json({ ok: true });
    }
    return handler.fetch(request);
  },
});

process.stdout.write(`LOAD_SERVER_READY ${server.port}\n`);
