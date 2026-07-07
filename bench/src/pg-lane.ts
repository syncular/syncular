/**
 * The env-gated Postgres bench lane (TODO §4.1 — "a dedicated bench lane the
 * day it lands"). Runs ONLY when `SYNCULAR_PG_URL` is set; it is NOT part of
 * `bench:ci` budgets (those stay on the deterministic in-process sqlite
 * loopback). This lane measures the production database path — 100k
 * bootstrap and online propagation — against a real Postgres, so the
 * inverted-scope-index behavior is exercised end to end on the engine
 * where scan-before-LIMIT regressions would actually bite.
 *
 *   SYNCULAR_PG_URL=postgres://user:pass@localhost:5432/db bun run bench
 *
 * Row/propagation counts honor the same SYNCULAR_BENCH_* env overrides as
 * the sqlite lanes. The lane wires Bun.sql (built into bun) as the
 * `PgExecutor` — the same production-shape adapter documented in the server
 * README.
 */
import {
  type PgExecutor,
  type PgQueryable,
  PostgresServerStorage,
} from '@syncular/server';
import {
  fmtMs,
  PARTITION,
  PROJECT_ID,
  percentile,
  rowId,
  TABLE,
} from './fixture';
import {
  type BenchServer,
  createBenchClient,
  createBenchServer,
  seedServerRows,
} from './loopback';

// biome-ignore lint/suspicious/noExplicitAny: Bun.sql is version-fluid.
const BunSQL = (Bun as any).SQL as undefined | (new (url: string) => any);

/** A `PgExecutor` over Bun.sql — the production-shape driver adapter. */
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

export interface PgLaneResult {
  readonly rows: number;
  readonly bootstrapMs: number;
  readonly rowsPerSec: number;
  readonly propP50: number;
  readonly propP95: number;
}

/** Build a Postgres-backed bench server on a fresh schema (unique partition). */
async function createPgServer(url: string): Promise<{
  server: BenchServer;
  reset(): Promise<void>;
}> {
  const sql = new (BunSQL as new (url: string) => unknown)(url);
  const storage = new PostgresServerStorage(bunSqlExecutor(sql as never));
  await storage.migrate();
  const server = createBenchServer({
    storage,
    close: async () => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic handle.
      await (sql as any).end?.();
    },
  });
  const reset = async () => {
    // Clear our partition's data so re-runs start clean.
    // The relational row store: the app table is partitioned by
    // _sync_partition (it may not exist yet on a fresh database).
    // biome-ignore lint/suspicious/noExplicitAny: dynamic handle.
    await (sql as any).unsafe(
      `DO $$ BEGIN
         IF to_regclass('tasks') IS NOT NULL THEN
           DELETE FROM tasks WHERE _sync_partition = '${'${PARTITION}'}';
         END IF;
       END $$`,
    );
    for (const table of [
      'sync_row_scopes',
      'sync_commits',
      'sync_changes',
      'sync_change_scopes',
      'sync_push_results',
      'sync_clients',
      'sync_partitions',
    ]) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic handle.
      await (sql as any).unsafe(`DELETE FROM ${table} WHERE partition=$1`, [
        PARTITION,
      ]);
    }
  };
  return { server, reset };
}

/** Run the PG lane; returns undefined (with a note) when not configured. */
export async function runPgLane(
  bootstrapRows: number,
  propIterations: number,
): Promise<PgLaneResult | { skipped: string }> {
  const url = process.env.SYNCULAR_PG_URL;
  if (url === undefined || url.length === 0) {
    return { skipped: 'SYNCULAR_PG_URL not set' };
  }
  if (BunSQL === undefined) {
    return { skipped: 'Bun.SQL unavailable in this runtime' };
  }

  const { server, reset } = await createPgServer(url);
  try {
    await reset();

    // -- Bootstrap: seed N rows, time a fresh client to fully applied. -----
    await seedServerRows(server, bootstrapRows);
    const t0 = performance.now();
    const handle = await createBenchClient(server, {
      limits: {
        limitSnapshotRows: 50_000,
        maxSnapshotPages: 50,
        accept: 0b0011,
      },
    });
    await handle.client.syncUntilIdle();
    const bootstrapMs = performance.now() - t0;
    const count = handle.client.query(`SELECT count(*) AS n FROM "${TABLE}"`)[0]
      ?.n;
    if (Number(count) !== bootstrapRows) {
      throw new Error(`pg bootstrap incomplete: ${String(count)}`);
    }
    await handle.close();

    // -- Propagation: mutate on A, measure apply+ack latency on B. ---------
    const a = await createBenchClient(server);
    const b = await createBenchClient(server, { realtime: true });
    await a.client.syncUntilIdle();
    await b.client.syncUntilIdle();
    await b.client.connectRealtime();
    const samples: number[] = [];
    let seq = await server.storage.getMaxCommitSeq(PARTITION);
    const warmup = 20;
    for (let i = 0; i < propIterations + warmup; i++) {
      const id = rowId(1_000_000 + i);
      const t = performance.now();
      a.client.mutate([
        {
          table: TABLE,
          op: 'upsert',
          values: {
            id,
            project_id: PROJECT_ID,
            title: `propagation ${i}`,
            done: false,
            priority: i % 5,
            updated_at_ms: 0,
          },
        },
      ]);
      await a.client.sync();
      seq += 1;
      await b.waitForAck(seq);
      const rowInB = b.client.query(`SELECT 1 FROM "${TABLE}" WHERE id = ?`, [
        id,
      ]);
      if (rowInB.length !== 1) throw new Error('pg propagation row missing');
      if (i < warmup) continue;
      samples.push(performance.now() - t);
    }
    await a.close();
    await b.close();
    samples.sort((x, y) => x - y);

    return {
      rows: bootstrapRows,
      bootstrapMs,
      rowsPerSec: Math.round(bootstrapRows / (bootstrapMs / 1000)),
      propP50: percentile(samples, 50),
      propP95: percentile(samples, 95),
    };
  } finally {
    await reset();
    await server.close();
  }
}

/** Console summary for the PG lane (never asserts budgets). */
export function reportPgLane(
  result: PgLaneResult | { skipped: string },
): string {
  if ('skipped' in result) {
    return `bench: pg lane skipped (${result.skipped})`;
  }
  return [
    `bench: pg lane (SYNCULAR_PG_URL) — ${result.rows.toLocaleString('en-US')} rows`,
    `  bootstrap ${fmtMs(result.bootstrapMs)} (${result.rowsPerSec.toLocaleString('en-US')} rows/s)`,
    `  propagation p50 ${fmtMs(result.propP50)} p95 ${fmtMs(result.propP95)}`,
  ].join('\n');
}
