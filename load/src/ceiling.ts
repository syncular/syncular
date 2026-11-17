/**
 * The push and pull ceiling of one partition on PostgreSQL.
 *
 *   bun run load:ceiling --pg-url postgres://user:pass@127.0.0.1:5432/postgres
 *     [--app ./my-ceiling-app.ts] [--rtt 0,13] [--rows 1,10] [--commits 1,10]
 *     [--pushers 1,10,50,200] [--readers 20] [--warmup 5] [--max-warmup 120]
 *     [--duration 30]
 *     [--servers 4] [--pool N]
 *
 * For every point the runner recreates the database `syncular_ceiling` on the
 * PostgreSQL server `--pg-url` names, starts `rtt-proxy.ts` with half of the
 * round-trip time in each direction (no proxy at 0), spawns
 * `ceiling-server.ts` over it and drives the server over HTTP with
 * protocol-level clients (`vclient.ts`): pushers send requests of `--commits`
 * commits back to back, readers send pull-only rounds alongside. After the
 * warm-up it counts applied commits and pull rounds for `--duration` seconds.
 *
 * `--app` names a module whose default export is a `CeilingApp`: the app's
 * schema, its server (with its own validators) built on the runner's
 * executor, its request headers and its commits. `ceiling-app.ts` is the
 * reference app. Results go to stdout as a Markdown table and to
 * `load/results/ceiling-<timestamp>.json`.
 */
import { join, resolve } from 'node:path';
import { SQL } from 'bun';
import type { UnitScopes } from '@syncular/core';
import type { PgExecutor } from '@syncular/server';
import { readReadyPort, spawnServer } from './harness';
import { Histogram, percentile } from './metrics';
import {
  HttpVClient,
  type VClientOperation,
  type VClientTable,
} from './vclient';

/** What an app hands the partition ceiling. */
export interface CeilingApp {
  /** The tables commits write and the schema version requests name. */
  readonly schema: {
    readonly version: number;
    readonly tables: readonly VClientTable[];
  };
  /**
   * Runs in each server process: migrate, seed and return the HTTP handler
   * that serves `POST /sync`. The first process runs alone on an empty
   * database; the others start after it, so seeding checks what exists. Every statement goes
   * through `executor`, which reaches PostgreSQL through the delay proxy.
   */
  createServer(input: {
    readonly executor: PgExecutor;
    readonly rowsPerCommit: number;
  }): Promise<{ fetch(request: Request): Response | Promise<Response> }>;
  /** Request headers of client `client`, such as its authorization. */
  headers?(
    client: number,
  ): Record<string, string> | Promise<Record<string, string>>;
  /** The scopes client `client` subscribes; reader `n` reads pusher `n`'s scopes. */
  scopes(client: number): UnitScopes;
  /** The operations of commit `seq` of pusher `client`, `rows` rows long. */
  commit(input: {
    readonly client: number;
    readonly seq: number;
    readonly rows: number;
  }): readonly VClientOperation[];
}

interface Point {
  readonly rttMs: number;
  readonly rows: number;
  readonly commitsPerRequest: number;
  readonly pushers: number;
  readonly readers: number;
}

interface LockStats {
  readonly transactions: number;
  readonly statements: number;
  readonly holdMs: number[];
  readonly waitMs: number[];
  /** CPU time of the server process over the wall time since the last read. */
  readonly cpu: number;
}

const list = (value: string) => value.split(',').map(Number);
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(
    String(process.argv[i]).replace(/^--/, ''),
    String(process.argv[i + 1]),
  );
}
const pgUrl = args.get('pg-url') ?? process.env.SYNCULAR_PG_URL;
if (pgUrl === undefined)
  throw new Error('--pg-url or SYNCULAR_PG_URL is required');
const appPath = resolve(
  args.get('app') ?? join(import.meta.dir, 'ceiling-app.ts'),
);
const app = (await import(appPath)).default as CeilingApp;
const warmupMs = Number(args.get('warmup') ?? 5) * 1000;
const durationMs = Number(args.get('duration') ?? 30) * 1000;
const maxWarmupMs = Number(args.get('max-warmup') ?? 120) * 1000;
// Client n talks to server process n mod --servers, as requests spread over
// Worker isolates; one process would measure its own event loop.
const servers = Number(args.get('servers') ?? 4);
// Each server pools one connection per client it serves unless `--pool`
// caps it: with fewer, pushers waiting on the partition lock hold every
// connection and pull rounds wait for a connection instead of for PostgreSQL.
const pool = args.has('pool') ? Number(args.get('pool')) : undefined;
const readers = Number(args.get('readers') ?? 20);

const admin = new SQL(pgUrl, { max: 1 });
const target = new URL(pgUrl);
const ms = (value: number) => Number(value.toFixed(1));
const median = (values: readonly number[]) =>
  ms(
    percentile(
      [...values].sort((a, b) => a - b),
      50,
    ),
  );

async function runPoint(point: Point, proxyPort: number | undefined) {
  await admin.unsafe('DROP DATABASE IF EXISTS syncular_ceiling WITH (FORCE)');
  await admin.unsafe('CREATE DATABASE syncular_ceiling');
  const url = new URL(pgUrl ?? '');
  url.pathname = '/syncular_ceiling';
  if (proxyPort !== undefined) {
    url.hostname = '127.0.0.1';
    url.port = String(proxyPort);
  }
  const probe = new SQL(url.toString(), { max: 1 });
  const probes: number[] = [];
  for (let i = 0; i < 31; i++) {
    const started = performance.now();
    await probe.unsafe('SELECT 1');
    probes.push(performance.now() - started);
  }
  await probe.end();

  const poolPerServer =
    pool ?? Math.ceil((point.pushers + point.readers) / servers);
  const spawn = () =>
    spawnServer({
      entry: join(import.meta.dir, 'ceiling-server.ts'),
      env: {
        CEILING_APP: appPath,
        CEILING_PG_URL: url.toString(),
        CEILING_POOL: String(poolPerServer),
        CEILING_ROWS: String(point.rows),
      },
    });
  // The first process migrates and seeds alone; concurrent migrations of an
  // empty database race on PostgreSQL's catalog.
  const first = await spawn();
  const processes = [
    first,
    ...(await Promise.all(Array.from({ length: servers - 1 }, spawn))),
  ];
  try {
    let assigned = 0;
    const client = async (index: number, kind: 'push' | 'pull') => {
      const scopesOf = index % point.pushers;
      const server = processes[assigned++ % servers];
      if (server === undefined) throw new Error('ceiling: no server process');
      const vclient = new HttpVClient({
        baseUrl: server.baseUrl,
        clientId: `ceiling-${kind}-${index}`,
        schemaVersion: app.schema.version,
        headers: (await app.headers?.(scopesOf)) ?? {},
      });
      vclient.subscribe(app.scopes(scopesOf));
      await vclient.pull();
      return vclient;
    };
    const pushers = await Promise.all(
      Array.from({ length: point.pushers }, (_, i) => client(i, 'push')),
    );
    const pullers = await Promise.all(
      Array.from({ length: point.readers }, (_, i) => client(i, 'pull')),
    );

    // The window opens once the warm-up has passed and every pusher has
    // finished a request, so a saturated partition is measured with its
    // queue full, or after `--max-warmup`: PostgreSQL does not grant a row
    // lock in arrival order, so one pusher can wait far longer than the rest.
    // It closes `durationMs` later.
    let start = Number.POSITIVE_INFINITY;
    let end = Number.POSITIVE_INFINITY;
    const pushLatency = new Histogram();
    const pullLatency = new Histogram();
    let commits = 0;
    let warmPushers = 0;
    let allPushed = () => {};
    const stats = async () => {
      const each = await Promise.all(
        processes.map(
          async (server) =>
            (await (
              await fetch(`${server.baseUrl}/__ceiling/stats`)
            ).json()) as LockStats,
        ),
      );
      return {
        transactions: each.reduce((sum, one) => sum + one.transactions, 0),
        statements: each.reduce((sum, one) => sum + one.statements, 0),
        holdMs: each.flatMap((one) => one.holdMs),
        waitMs: each.flatMap((one) => one.waitMs),
        cpu: Math.max(...each.map((one) => one.cpu)),
      };
    };
    let clientCpu = process.cpuUsage();
    const window = Promise.all([
      new Promise((resolveWarmup) => setTimeout(resolveWarmup, warmupMs)),
      new Promise<void>((resolvePushed) => {
        allPushed = resolvePushed;
        setTimeout(resolvePushed, maxWarmupMs);
      }),
    ]).then(async () => {
      await stats();
      clientCpu = process.cpuUsage();
      start = performance.now();
      end = start + durationMs;
      await new Promise((resolveWindow) =>
        setTimeout(resolveWindow, durationMs),
      );
      clientCpu = process.cpuUsage(clientCpu);
      return stats();
    });
    let seq = 0;
    await Promise.all([
      ...pushers.map(async (pusher, index) => {
        let warm = false;
        while (performance.now() < end) {
          const commitsOfRequest = Array.from(
            { length: point.commitsPerRequest },
            () => app.commit({ client: index, seq: seq++, rows: point.rows }),
          );
          const result = await pusher.push(app.schema.tables, commitsOfRequest);
          const applied = result.message.frames.filter(
            (frame) =>
              frame.type === 'PUSH_RESULT' && frame.status === 'applied',
          ).length;
          if (applied !== point.commitsPerRequest) {
            throw new Error(
              `ceiling: ${applied} of ${point.commitsPerRequest} commits applied`,
            );
          }
          const done = performance.now();
          if (done >= start && done < end) {
            pushLatency.add(result.latencyMs);
            commits += applied;
          }
          if (!warm && (warmPushers += 1) === point.pushers) allPushed();
          warm = true;
        }
      }),
      ...pullers.map(async (puller) => {
        while (performance.now() < end) {
          const result = await puller.pull();
          const done = performance.now();
          if (done >= start && done < end) pullLatency.add(result.latencyMs);
        }
      }),
    ]);
    const lock = await window;
    const seconds = durationMs / 1000;
    const push = pushLatency.summary();
    const pull = pullLatency.summary();
    return {
      ...point,
      servers,
      poolPerServer,
      measuredRttMs: median(probes),
      commitsPerSec: Number((commits / seconds).toFixed(1)),
      commitP50Ms: ms(push.p50),
      commitP99Ms: ms(push.p99),
      pullRoundsPerSec: Number((pull.count / seconds).toFixed(1)),
      pullP50Ms: ms(pull.p50),
      pullP99Ms: ms(pull.p99),
      lockTransactions: lock.transactions,
      statementsUnderLock: Number(
        (lock.statements / lock.transactions).toFixed(1),
      ),
      lockHoldP50Ms: median(lock.holdMs),
      lockWaitP50Ms: median(lock.waitMs),
      busiestServerCpu: ms(lock.cpu),
      clientCpu: ms((clientCpu.user + clientCpu.system) / 1000 / durationMs),
    };
  } finally {
    await Promise.all(processes.map((server) => server.stop()));
  }
}

const results: Awaited<ReturnType<typeof runPoint>>[] = [];
for (const rttMs of list(args.get('rtt') ?? '0,13')) {
  const proxy =
    rttMs > 0
      ? Bun.spawn(
          [
            'bun',
            join(import.meta.dir, 'rtt-proxy.ts'),
            target.hostname,
            target.port || '5432',
            // Bun's timers fire about 1 ms late at this resolution: 5.5 ms
            // each way measures 13 ms with `SELECT 1` against 0.5 ms direct.
            String(rttMs / 2 - 1),
          ],
          { stdout: 'pipe', stderr: 'inherit' },
        )
      : undefined;
  try {
    const proxyPort =
      proxy === undefined ? undefined : await readReadyPort(proxy);
    for (const rows of list(args.get('rows') ?? '1,10')) {
      for (const commitsPerRequest of list(args.get('commits') ?? '1,10')) {
        for (const pushers of list(args.get('pushers') ?? '1,10,50,200')) {
          const result = await runPoint(
            { rttMs, rows, commitsPerRequest, pushers, readers },
            proxyPort,
          );
          results.push(result);
          console.error(JSON.stringify(result));
        }
      }
    }
  } finally {
    proxy?.kill();
  }
}
await admin.unsafe('DROP DATABASE IF EXISTS syncular_ceiling WITH (FORCE)');
const version = await admin.unsafe<{ server_version: string }[]>(
  'SHOW server_version',
);
await admin.end();
const environment = {
  app: appPath,
  bun: Bun.version,
  postgres: version[0]?.server_version,
  servers,
  poolPerServer: pool ?? '(pushers + readers) / servers',
  readers,
  warmupSec: warmupMs / 1000,
  maxWarmupSec: maxWarmupMs / 1000,
  durationSec: durationMs / 1000,
};
await Bun.write(
  join(import.meta.dir, '..', 'results', `ceiling-${Date.now()}.json`),
  JSON.stringify({ environment, results }, null, 2),
);
console.log(JSON.stringify(environment));
console.log(
  '| RTT ms (measured) | rows/commit | commits/request | pushers | commits/s | commit p50 / p99 ms | pull rounds/s | pull p50 / p99 ms | statements under lock | lock hold p50 ms |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  console.log(
    `| ${r.rttMs} (${r.measuredRttMs}) | ${r.rows} | ${r.commitsPerRequest} | ${r.pushers} | ${r.commitsPerSec} | ${r.commitP50Ms} / ${r.commitP99Ms} | ${r.pullRoundsPerSec} | ${r.pullP50Ms} / ${r.pullP99Ms} | ${r.statementsUnderLock} | ${r.lockHoldP50Ms} |`,
  );
}
process.exit(0);
