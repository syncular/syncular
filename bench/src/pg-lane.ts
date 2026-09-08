import { SQL } from 'bun';
import { measureMethods, type MethodMeasurement } from './instrumentation';
import { processObject } from './process-driver';
/**
 * The env-gated Postgres bench lane. Runs ONLY when `SYNCULAR_PG_URL` is set;
 * it is NOT part of
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
import { fmtMs, PROJECT_ID, percentile, rowId, TABLE } from './fixture';
import {
  type BenchServerOptions,
  createBenchClient,
  createBenchServer,
  seedServerRows,
} from './loopback';

/** A typed driver adapter, shared by the engine and socket benchmarks. */
function queryableOver(handle: Pick<SQL, 'unsafe'>): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      const rows = await handle.unsafe<Row[]>(text, params ? [...params] : []);
      return { rows, rowCount: rows.length };
    },
  };
}

/** Reject reset statistics instead of publishing an invalid counter interval. */
export function validatePgIoSnapshots(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  for (const view of ['io', 'wal', 'checkpointer']) {
    const initial = before[view];
    const final = after[view];
    if (
      !Array.isArray(initial) ||
      !Array.isArray(final) ||
      initial.length === 0 ||
      JSON.stringify(initial.map((row) => processObject(row).stats_reset)) !==
        JSON.stringify(final.map((row) => processObject(row).stats_reset)) ||
      initial.some((row) => typeof processObject(row).stats_reset !== 'string')
    )
      throw new Error(
        'Postgres statistics reset or are missing during the benchmark attempt',
      );
  }
}

/** Cluster-wide counters require an explicitly selected, isolated PG instance. */
export async function openPgIoObserver(url: string) {
  const sql = new SQL(url, {
    max: 1,
    connection: { application_name: 'syncular-bench-io-observer' },
  });
  const snapshot = async () => {
    // A closed benchmark pool can leave a backend finishing its exit. Wait for
    // those sessions to disappear before reading their flushed statistics.
    const deadline = performance.now() + 10_000;
    while (true) {
      const active = await sql.unsafe(
        "SELECT pid FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()",
      );
      if (active.length === 0) break;
      if (performance.now() >= deadline)
        throw new Error(
          'Postgres I/O diagnostics require an isolated instance with no other client connections',
        );
    }
    await sql.unsafe('SELECT pg_stat_clear_snapshot()');
    const io = await sql.unsafe(
      "SELECT * FROM pg_stat_io WHERE object='wal' ORDER BY backend_type, context",
    );
    const wal = await sql.unsafe('SELECT * FROM pg_stat_wal');
    const checkpointer = await sql.unsafe('SELECT * FROM pg_stat_checkpointer');
    // Preserve bigint counters without an unsafe numeric conversion.
    return processObject(
      JSON.parse(
        JSON.stringify({ io, wal, checkpointer }, (_, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ),
    );
  };
  try {
    const rows = await sql.unsafe<{ name: string; setting: string }[]>(
      "SELECT name, setting FROM pg_settings WHERE name IN ('server_version_num','track_wal_io_timing','track_io_timing','fsync','full_page_writes','synchronous_commit','wal_sync_method') ORDER BY name",
    );
    const settings = Object.fromEntries(
      rows.map((row) => [row.name, row.setting]),
    );
    const version = Number(settings.server_version_num);
    if (
      version < 180000 ||
      version >= 190000 ||
      !Number.isInteger(version) ||
      settings.track_wal_io_timing !== 'on'
    )
      throw new Error(
        'Postgres I/O diagnostics require PostgreSQL 18 with track_wal_io_timing=on',
      );
    const before = await snapshot();
    return {
      async collect() {
        const after = await snapshot();
        validatePgIoSnapshots(before, after);
        return {
          settings,
          before,
          after,
          boundaries:
            'Cluster-wide cumulative WAL I/O and checkpoint counters around the complete attempt, including server schema creation, bootstrap, validation, and cleanup. All benchmark server database sessions have exited before the final snapshot. Background PostgreSQL processes remain separate by backend type. These counters are not replay-only spans and cannot be added to overlapping storage or transaction durations. The observer reads settings and statistics without changing database settings or resetting counters. Use an isolated instance; other workloads would contaminate the counters.',
        };
      },
      close: () => sql.close(),
    };
  } catch (error) {
    await sql.close();
    throw error;
  }
}

export interface PgLaneResult {
  readonly rows: number;
  readonly bootstrapMs: number;
  readonly rowsPerSec: number;
  readonly propP50: number;
  readonly propP95: number;
}

/** Every run owns an isolated schema; cleanup never touches existing tables. */
export async function createPgServer(
  url: string,
  measurements: Record<string, MethodMeasurement> = {},
  options: Pick<
    BenchServerOptions,
    'rejectMiddle' | 'blobs' | 'resolveScopes'
  > = {},
) {
  const schema = `syncular_bench_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(url);
  let sql: SQL | undefined;
  let created = false;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    sql = new SQL(url, { connection: { search_path: schema } });
    const pool = sql;
    const settings = processObject(
      (
        await pool.unsafe(
          "SELECT current_setting('server_version') AS version, current_setting('server_version_num') AS \"versionNumber\", current_setting('synchronous_commit') AS \"synchronousCommit\", current_setting('fsync') AS fsync, current_setting('full_page_writes') AS \"fullPageWrites\", current_setting('wal_sync_method') AS \"walSyncMethod\"",
        )
      )[0],
    );
    for (const key of [
      'version',
      'versionNumber',
      'synchronousCommit',
      'fsync',
      'fullPageWrites',
      'walSyncMethod',
    ])
      if (typeof settings[key] !== 'string' || settings[key].length === 0)
        throw new Error('Postgres configuration missing');
    const database = { backend: 'postgres' as const, settings };

    const measured = measureMethods(
      queryableOver(pool),
      measurements,
      'postgres',
      true,
    );
    const executor: PgExecutor = {
      query: measured.query,
      transaction: (fn) =>
        pool.begin((tx) =>
          fn(
            measureMethods(
              queryableOver(tx),
              measurements,
              'postgresTransaction',
              true,
            ),
          ),
        ),
    };
    const storage = new PostgresServerStorage(executor);
    await storage.migrate();
    return {
      database,
      ...createBenchServer({
        ...options,
        measurements,
        partition: schema,
        storage: measureMethods(storage, measurements, 'storage'),
        close: async () => {
          try {
            await pool.close();
          } finally {
            try {
              await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
            } finally {
              await admin.close();
            }
          }
        },
      }),
    };
  } catch (error) {
    try {
      await sql?.close();
    } finally {
      try {
        if (created) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.close();
      }
    }
    throw error;
  }
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
  const server = await createPgServer(url);
  try {
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
    let seq = await server.storage.getMaxCommitSeq(server.ctx.partition);
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
