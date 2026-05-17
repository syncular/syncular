import { afterAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import { createDatabase } from '../../packages/core/src';
import {
  type BinarySnapshotColumn,
  decodeBinarySnapshotTable,
  decodeSnapshotRows,
  encodeBinarySnapshotTable,
  encodeSnapshotRows,
} from '../../packages/core/src/snapshot-chunks';
import {
  decodeBinarySyncPack,
  encodeBinarySyncPack,
} from '../../packages/core/src/sync-packs';
import { gunzipBytes, gzipBytes } from '../../packages/core/src/utils';
import { createBunSqliteDialect } from '../../packages/dialect-bun-sqlite/src';
import {
  createScopeCommitIndexEntries,
  createServerHandler,
  createServerHandlerCollection,
  ensureSyncSchema,
  pull,
  type SyncCoreDb,
  type SyncServerAuth,
} from '../../packages/server/src';
import { createSqliteServerDialect } from '../../packages/server-dialect-sqlite/src';
import {
  type BenchmarkResult,
  benchmark,
  formatBenchmarkTable,
} from './benchmark';
import {
  detectRegressions,
  formatRegressionReport,
  loadBaseline,
} from './regression';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');
const BASELINE_PATH = path.join(import.meta.dir, 'baseline.json');

interface NativePerfReport {
  metrics: Array<
    BenchmarkResult & {
      rows?: number;
      outboxCommits?: number;
    }
  >;
}

interface WasmSizeReport {
  rawBytes: number;
  gzipBytes: number;
}

interface BrowserBenchmarkStats {
  label: string;
  operations: number;
  rounds: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

interface BrowserBenchmarkReport {
  runtime?: {
    wasmProfile?: string;
  };
  results: {
    rustOwnedSqliteIndexedDb?: BrowserBenchmarkStats;
    rustOwnedSqliteOpfsWorker: BrowserBenchmarkStats;
  };
}

interface BrowserE2eScoreboardMetric {
  name: string;
  value: number;
  unit: 'ms' | 'rows' | 'bytes' | 'count';
}

interface BrowserE2eScoreboardReport {
  runtime?: {
    wasmProfile?: string;
    rustStorage?: string;
  };
  options?: {
    rows?: number;
    incrementalRows?: number;
    realtimeIterations?: number;
    queryIterations?: number;
  };
  metrics: BrowserE2eScoreboardMetric[];
}

const results: BenchmarkResult[] = [];
const itBrowserBenchmark =
  Bun.env.PERF_RUST_BROWSER_BENCHMARK === 'true' ? it : it.skip;
const itBrowserE2eScoreboard =
  Bun.env.PERF_RUST_BROWSER_E2E_SCOREBOARD === 'true' ? it : it.skip;
let syncPackBenchmarkSink = 0;
let snapshotChunkBenchmarkSink = 0;

describe('rust client performance', () => {
  afterAll(async () => {
    console.log(`\n${formatBenchmarkTable(results)}`);

    const baseline = await loadBaseline(BASELINE_PATH);
    const regressions = detectRegressions(results, baseline);
    console.log(`\n${formatRegressionReport(regressions)}`);
  });

  it('tracks native client local and e2e sync hot paths', async () => {
    const native = await runJsonCommand<NativePerfReport>(
      [
        'cargo',
        'run',
        '--release',
        '--manifest-path',
        'rust/Cargo.toml',
        '-p',
        'syncular-client',
        '--bin',
        'syncular-rust-perf',
        '--',
        '--json',
        `--operations=${readPositiveIntEnv('PERF_RUST_NATIVE_OPERATIONS', 100)}`,
        `--rounds=${readPositiveIntEnv('PERF_RUST_NATIVE_ROUNDS', 5)}`,
        `--warmup=${readPositiveIntEnv('PERF_RUST_NATIVE_WARMUP', 10)}`,
      ],
      'rust native perf'
    );

    for (const metric of native.metrics) {
      results.push({
        name: metric.name,
        iterations: metric.iterations,
        mean: metric.mean,
        median: metric.median,
        p95: metric.p95,
        p99: metric.p99,
        min: metric.min,
        max: metric.max,
        stdDev: metric.stdDev,
      });
    }

    expect(native.metrics.length).toBeGreaterThan(0);
  }, 120_000);

  it('tracks binary sync-pack incremental row codec cost', async () => {
    const changeCount = readPositiveIntEnv('PERF_SYNC_PACK_CHANGES', 50_000);
    const rounds = readPositiveIntEnv('PERF_SYNC_PACK_ROUNDS', 5);
    const warmup = readPositiveIntEnv('PERF_SYNC_PACK_WARMUP', 2);
    const response = makeIncrementalSyncPackResponse(changeCount);
    const json = JSON.stringify(response);
    const binary = encodeBinarySyncPack(response);
    const binaryGenerated = encodeBinarySyncPack(response, {
      changeRowEncoders: {
        tasks: encodeBenchmarkTaskRows,
      },
    });

    results.push(
      await benchmark(
        `sync_pack_json_encode_${changeCount}`,
        async () => {
          syncPackBenchmarkSink += JSON.stringify(response).length;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `sync_pack_json_decode_${changeCount}`,
        async () => {
          syncPackBenchmarkSink += JSON.parse(json).pull.subscriptions.length;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `sync_pack_binary_encode_${changeCount}`,
        async () => {
          syncPackBenchmarkSink += encodeBinarySyncPack(response).byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `sync_pack_binary_decode_${changeCount}`,
        async () => {
          syncPackBenchmarkSink +=
            decodeBinarySyncPack(binary).pull?.subscriptions.length ?? 0;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `sync_pack_binary_generated_encode_${changeCount}`,
        async () => {
          syncPackBenchmarkSink += encodeBinarySyncPack(response, {
            changeRowEncoders: {
              tasks: encodeBenchmarkTaskRows,
            },
          }).byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `sync_pack_binary_generated_decode_${changeCount}`,
        async () => {
          syncPackBenchmarkSink +=
            decodeBinarySyncPack(binaryGenerated).pull?.subscriptions.length ??
            0;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      bytesMetric(`sync_pack_json_response_${changeCount}_kib`, json.length),
      bytesMetric(
        `sync_pack_binary_response_${changeCount}_kib`,
        binary.byteLength
      ),
      bytesMetric(
        `sync_pack_binary_generated_response_${changeCount}_kib`,
        binaryGenerated.byteLength
      )
    );

    expect(binary.byteLength).toBeGreaterThan(0);
    expect(binaryGenerated.byteLength).toBeLessThan(binary.byteLength);
    expect(syncPackBenchmarkSink).toBeGreaterThan(0);
  });

  it('tracks scoped incremental server pull under fanout', async () => {
    const totalCommits = readPositiveIntEnv('PERF_SERVER_SCOPE_COMMITS', 5_000);
    const fanoutUsers = readPositiveIntEnv(
      'PERF_SERVER_SCOPE_FANOUT_USERS',
      20
    );
    const limitCommits = readPositiveIntEnv(
      'PERF_SERVER_SCOPE_LIMIT_COMMITS',
      500
    );
    const rounds = readPositiveIntEnv('PERF_SERVER_SCOPE_ROUNDS', 3);
    const warmup = readPositiveIntEnv('PERF_SERVER_SCOPE_WARMUP', 1);
    const context = await createScopedPullBenchmarkContext({
      totalCommits,
      fanoutUsers,
    });

    try {
      let summary = await runScopedIncrementalPullCatchup(context, {
        limitCommits,
      });
      results.push(
        await benchmark(
          `server_scoped_incremental_pull_fanout_${totalCommits}_${fanoutUsers}`,
          async () => {
            summary = await runScopedIncrementalPullCatchup(context, {
              limitCommits,
            });
          },
          { iterations: rounds, warmup, trackMemory: false }
        ),
        countMetric(
          `server_scoped_incremental_pull_requests_${totalCommits}_${fanoutUsers}`,
          summary.requests
        ),
        countMetric(
          `server_scoped_incremental_pull_changes_${totalCommits}_${fanoutUsers}`,
          summary.changes
        )
      );

      expect(summary.cursor).toBe(totalCommits);
      expect(summary.changes).toBe(Math.ceil(totalCommits / fanoutUsers));
    } finally {
      await context.db.destroy();
    }
  });

  it('tracks dense incremental pull build and binary encode cost', async () => {
    const totalCommits = readPositiveIntEnv('PERF_SERVER_DENSE_COMMITS', 5_000);
    const limitCommits = readPositiveIntEnv(
      'PERF_SERVER_DENSE_LIMIT_COMMITS',
      500
    );
    const rounds = readPositiveIntEnv('PERF_SERVER_DENSE_ROUNDS', 3);
    const warmup = readPositiveIntEnv('PERF_SERVER_DENSE_WARMUP', 1);
    const context = await createScopedPullBenchmarkContext({
      totalCommits,
      fanoutUsers: 1,
    });

    try {
      let buildSummary = await runScopedIncrementalPullCatchup(context, {
        limitCommits,
      });
      let genericSummary = await runScopedIncrementalPullCatchup(context, {
        limitCommits,
        encodeBinary: 'generic',
      });
      let generatedSummary = await runScopedIncrementalPullCatchup(context, {
        limitCommits,
        encodeBinary: 'generated',
      });

      results.push(
        await benchmark(
          `server_dense_incremental_pull_build_${totalCommits}_${limitCommits}`,
          async () => {
            buildSummary = await runScopedIncrementalPullCatchup(context, {
              limitCommits,
            });
          },
          { iterations: rounds, warmup, trackMemory: false }
        ),
        await benchmark(
          `server_dense_incremental_pull_build_binary_encode_${totalCommits}_${limitCommits}`,
          async () => {
            genericSummary = await runScopedIncrementalPullCatchup(context, {
              limitCommits,
              encodeBinary: 'generic',
            });
          },
          { iterations: rounds, warmup, trackMemory: false }
        ),
        await benchmark(
          `server_dense_incremental_pull_build_generated_binary_encode_${totalCommits}_${limitCommits}`,
          async () => {
            generatedSummary = await runScopedIncrementalPullCatchup(context, {
              limitCommits,
              encodeBinary: 'generated',
            });
          },
          { iterations: rounds, warmup, trackMemory: false }
        ),
        countMetric(
          `server_dense_incremental_pull_requests_${totalCommits}_${limitCommits}`,
          buildSummary.requests
        ),
        countMetric(
          `server_dense_incremental_pull_changes_${totalCommits}_${limitCommits}`,
          buildSummary.changes
        ),
        bytesMetric(
          `server_dense_incremental_pull_binary_response_${totalCommits}_${limitCommits}_kib`,
          genericSummary.encodedBytes
        ),
        bytesMetric(
          `server_dense_incremental_pull_generated_binary_response_${totalCommits}_${limitCommits}_kib`,
          generatedSummary.encodedBytes
        )
      );

      expect(buildSummary.cursor).toBe(totalCommits);
      expect(buildSummary.changes).toBe(totalCommits);
      expect(genericSummary.encodedBytes).toBeGreaterThan(0);
      expect(generatedSummary.encodedBytes).toBeGreaterThan(0);
    } finally {
      await context.db.destroy();
    }
  });

  it('tracks snapshot chunk encoding and gzip policy cost', async () => {
    const rowCount = readPositiveIntEnv('PERF_SNAPSHOT_CHUNK_ROWS', 50_000);
    const rounds = readPositiveIntEnv('PERF_SNAPSHOT_CHUNK_ROUNDS', 5);
    const warmup = readPositiveIntEnv('PERF_SNAPSHOT_CHUNK_WARMUP', 2);
    const rows = makeBenchmarkTaskRows(rowCount);
    const jsonChunk = encodeSnapshotRows(rows);
    const binaryChunk = encodeBenchmarkTaskRows(rows);
    const jsonGzipLevel1 = await gzipBytes(jsonChunk, { level: 1 });
    const binaryGzipLevel1 = await gzipBytes(binaryChunk, { level: 1 });
    const jsonGzipLevel6 = await gzipBytes(jsonChunk, { level: 6 });
    const binaryGzipLevel6 = await gzipBytes(binaryChunk, { level: 6 });

    results.push(
      await benchmark(
        `snapshot_chunk_json_encode_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink += encodeSnapshotRows(rows).byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `snapshot_chunk_binary_encode_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink +=
            encodeBenchmarkTaskRows(rows).byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `snapshot_chunk_json_gzip_level_1_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink += (
            await gzipBytes(jsonChunk, { level: 1 })
          ).byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `snapshot_chunk_binary_gzip_level_1_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink += (
            await gzipBytes(binaryChunk, { level: 1 })
          ).byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `snapshot_chunk_json_gzip_level_6_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink += (
            await gzipBytes(jsonChunk, { level: 6 })
          ).byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `snapshot_chunk_binary_gzip_level_6_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink += (
            await gzipBytes(binaryChunk, { level: 6 })
          ).byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `snapshot_chunk_json_gunzip_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink += (await gunzipBytes(jsonGzipLevel1))
            .byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `snapshot_chunk_binary_gunzip_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink += (await gunzipBytes(binaryGzipLevel1))
            .byteLength;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `snapshot_chunk_json_decode_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink += decodeSnapshotRows(jsonChunk).length;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      await benchmark(
        `snapshot_chunk_binary_decode_${rowCount}`,
        async () => {
          snapshotChunkBenchmarkSink +=
            decodeBinarySnapshotTable(binaryChunk).rows.length;
        },
        { iterations: rounds, warmup, trackMemory: false }
      ),
      bytesMetric(`snapshot_chunk_json_raw_${rowCount}_kib`, jsonChunk.length),
      bytesMetric(
        `snapshot_chunk_binary_raw_${rowCount}_kib`,
        binaryChunk.length
      ),
      bytesMetric(
        `snapshot_chunk_json_gzip_level_1_${rowCount}_kib`,
        jsonGzipLevel1.length
      ),
      bytesMetric(
        `snapshot_chunk_binary_gzip_level_1_${rowCount}_kib`,
        binaryGzipLevel1.length
      ),
      bytesMetric(
        `snapshot_chunk_json_gzip_level_6_${rowCount}_kib`,
        jsonGzipLevel6.length
      ),
      bytesMetric(
        `snapshot_chunk_binary_gzip_level_6_${rowCount}_kib`,
        binaryGzipLevel6.length
      )
    );

    expect(binaryChunk.byteLength).toBeLessThan(jsonChunk.byteLength);
    expect(binaryGzipLevel1.byteLength).toBeLessThan(jsonGzipLevel1.byteLength);
    expect(snapshotChunkBenchmarkSink).toBeGreaterThan(0);
  });

  itBrowserBenchmark(
    'tracks browser Rust-owned SQLite local mutation latency',
    async () => {
      const browser = await runJsonCommand<BrowserBenchmarkReport>(
        [
          'bun',
          'tests/runtime/scripts/browser-wasm-vs-js-benchmark.ts',
          '--json',
          `--operations=${readPositiveIntEnv('PERF_RUST_BROWSER_OPERATIONS', 50)}`,
          `--rounds=${readPositiveIntEnv('PERF_RUST_BROWSER_ROUNDS', 3)}`,
          `--warmup=${readPositiveIntEnv('PERF_RUST_BROWSER_WARMUP', 5)}`,
          '--wasm-profile=release',
        ],
        'rust browser local mutation perf'
      );

      if (browser.results.rustOwnedSqliteIndexedDb) {
        results.push(
          browserMetric(
            `rust_browser_local_mutations_indexeddb_${browser.results.rustOwnedSqliteIndexedDb.operations}`,
            browser.results.rustOwnedSqliteIndexedDb
          )
        );
      }
      results.push(
        browserMetric(
          `rust_browser_local_mutations_opfs_worker_${browser.results.rustOwnedSqliteOpfsWorker.operations}`,
          browser.results.rustOwnedSqliteOpfsWorker
        )
      );

      expect(
        browser.results.rustOwnedSqliteOpfsWorker.medianMs
      ).toBeGreaterThan(0);
      expect(browser.runtime?.wasmProfile).toBe('release');
    },
    180_000
  );

  it('tracks browser Rust WASM size as a perf budget', async () => {
    await ensureBrowserReleaseWasmBuilt();
    const size = await runJsonCommand<WasmSizeReport>(
      [
        'bun',
        'rust/bindings/browser/scripts/size-syncular-v2-wasm.ts',
        '--json',
      ],
      'rust browser wasm size'
    );

    results.push(
      bytesMetric('rust_browser_wasm_raw_kib', size.rawBytes),
      bytesMetric('rust_browser_wasm_gzip_kib', size.gzipBytes)
    );

    expect(size.rawBytes).toBeGreaterThan(0);
    expect(size.gzipBytes).toBeGreaterThan(0);
  }, 120_000);

  itBrowserE2eScoreboard(
    'tracks browser E2E TS-vs-Rust bootstrap and local-query scoreboard',
    async () => {
      const rows = readPositiveIntEnv('PERF_RUST_BROWSER_E2E_ROWS', 1_000);
      const incrementalRows = readNonNegativeIntEnv(
        'PERF_RUST_BROWSER_E2E_INCREMENTAL_ROWS',
        0
      );
      const realtimeIterations = readPositiveIntEnv(
        'PERF_RUST_BROWSER_E2E_REALTIME_ITERATIONS',
        1
      );
      const queryIterations = readPositiveIntEnv(
        'PERF_RUST_BROWSER_E2E_QUERY_ITERATIONS',
        10
      );
      const scoreboard = await runJsonCommand<BrowserE2eScoreboardReport>(
        [
          'bun',
          'tests/runtime/scripts/browser-e2e-scoreboard.ts',
          '--json',
          `--rows=${rows}`,
          `--incremental-rows=${incrementalRows}`,
          `--realtime-iterations=${realtimeIterations}`,
          `--query-iterations=${queryIterations}`,
          '--wasm-profile=release',
        ],
        'rust browser e2e scoreboard'
      );

      for (const metric of scoreboard.metrics) {
        const result = browserE2eMetric(metric);
        if (result) results.push(result);
      }

      const rowMetrics = new Map(
        scoreboard.metrics.map((metric) => [metric.name, metric.value])
      );
      expect(rowMetrics.get('ts_rows')).toBe(rows);
      expect(rowMetrics.get('rust_rows')).toBe(rows);
      if (incrementalRows > 0) {
        expect(rowMetrics.get('incremental_rows')).toBe(incrementalRows);
        expect(rowMetrics.get('realtime_iterations')).toBe(realtimeIterations);
        expect(rowMetrics.get('realtime_rows')).toBe(
          incrementalRows * realtimeIterations
        );
        expect(rowMetrics.get('rust_incremental_rows')).toBe(
          rows + incrementalRows
        );
        expect(rowMetrics.get('rust_realtime_rows')).toBe(
          rows + incrementalRows + incrementalRows * realtimeIterations
        );
      }
      expect(scoreboard.runtime?.wasmProfile).toBe('release');
    },
    300_000
  );
});

async function ensureBrowserReleaseWasmBuilt(): Promise<void> {
  const wasmPath = path.join(
    REPO_ROOT,
    'rust/bindings/browser/dist/wasm/syncular_v2_bg.wasm'
  );
  const profilePath = path.join(
    REPO_ROOT,
    'rust/bindings/browser/dist/wasm/.syncular-v2-wasm-profile'
  );
  const profile = await Bun.file(profilePath)
    .text()
    .then((value) => value.trim())
    .catch(() => null);
  if ((await Bun.file(wasmPath).exists()) && profile === 'release') return;

  await runCommand(
    ['bun', '--cwd', 'rust/bindings/browser', 'build:wasm'],
    'build rust browser wasm'
  );
}

interface ServerScopedPullTaskTable {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string | null;
  server_version: number;
  image: string | null;
  title_yjs_state: string | null;
}

interface ServerScopedPullDb extends SyncCoreDb {
  tasks: ServerScopedPullTaskTable;
}

interface ServerScopedPullAuth extends SyncServerAuth {
  actorId: string;
}

interface ServerScopedPullContext {
  db: ReturnType<typeof createDatabase<ServerScopedPullDb>>;
  dialect: ReturnType<typeof createSqliteServerDialect>;
  handlers: ReturnType<
    typeof createServerHandlerCollection<
      ServerScopedPullDb,
      ServerScopedPullAuth
    >
  >;
  totalCommits: number;
  fanoutUsers: number;
}

async function createScopedPullBenchmarkContext(args: {
  totalCommits: number;
  fanoutUsers: number;
}): Promise<ServerScopedPullContext> {
  const dialect = createSqliteServerDialect();
  const db = createDatabase<ServerScopedPullDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
    family: 'sqlite',
  });
  await ensureSyncSchema(db, dialect);
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('project_id', 'text')
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('image', 'text')
    .addColumn('title_yjs_state', 'text')
    .execute();

  await seedScopedPullCommits(db, dialect, args);

  const handler = createServerHandler<
    ServerScopedPullDb,
    ServerScopedPullDb,
    'tasks',
    ServerScopedPullAuth
  >({
    table: 'tasks',
    scopes: ['user:{user_id}'],
    resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
  });

  return {
    db,
    dialect,
    handlers: createServerHandlerCollection<
      ServerScopedPullDb,
      ServerScopedPullAuth
    >([handler]),
    totalCommits: args.totalCommits,
    fanoutUsers: args.fanoutUsers,
  };
}

async function seedScopedPullCommits(
  db: ReturnType<typeof createDatabase<ServerScopedPullDb>>,
  dialect: ReturnType<typeof createSqliteServerDialect>,
  args: { totalCommits: number; fanoutUsers: number }
): Promise<void> {
  const chunkSize = 500;
  for (let start = 1; start <= args.totalCommits; start += chunkSize) {
    const end = Math.min(args.totalCommits, start + chunkSize - 1);
    const commits = [];
    const changes = [];
    const tableCommits = [];
    const scopeCommitSources = [];

    for (let seq = start; seq <= end; seq++) {
      const userIndex = (seq - 1) % args.fanoutUsers;
      const userId = `scope-user-${userIndex}`;
      const task = {
        id: `task-${seq}`,
        title: `Task ${seq}`,
        completed: seq % 2,
        user_id: userId,
        project_id: 'p1',
        server_version: seq,
        image: null,
        title_yjs_state: null,
      };
      commits.push({
        commit_seq: seq,
        partition_id: 'server-scope-perf',
        actor_id: userId,
        client_id: `seed-client-${userIndex}`,
        client_commit_id: `seed-${seq}`,
        created_at: '2026-05-17T00:00:00.000Z',
        meta: null,
        result_json: null,
        change_count: 1,
        affected_tables: dialect.arrayToDb(['tasks']),
      });
      changes.push({
        partition_id: 'server-scope-perf',
        commit_seq: seq,
        table: 'tasks',
        row_id: task.id,
        op: 'upsert',
        row_json: JSON.stringify(task),
        row_version: seq,
        scopes: dialect.scopesToDb({ user_id: userId }),
      });
      scopeCommitSources.push({
        table: 'tasks',
        scopes: { user_id: userId },
        commit_seq: seq,
      });
      tableCommits.push({
        partition_id: 'server-scope-perf',
        table: 'tasks',
        commit_seq: seq,
      });
    }

    await db
      .insertInto('sync_commits')
      .values(commits as never)
      .execute();
    await db
      .insertInto('sync_changes')
      .values(changes as never)
      .execute();
    await db.insertInto('sync_table_commits').values(tableCommits).execute();
    await db
      .insertInto('sync_scope_commits')
      .values(
        scopeCommitSources.flatMap((source) =>
          createScopeCommitIndexEntries([source]).map((entry) => ({
            partition_id: 'server-scope-perf',
            table: entry.table,
            scope_key: entry.scopeKey,
            commit_seq: source.commit_seq,
          }))
        )
      )
      .execute();
  }
}

async function runScopedIncrementalPullCatchup(
  context: ServerScopedPullContext,
  args: { limitCommits: number; encodeBinary?: 'generic' | 'generated' }
): Promise<{
  cursor: number;
  requests: number;
  commits: number;
  changes: number;
  encodedBytes: number;
}> {
  let cursor = 0;
  let requests = 0;
  let commits = 0;
  let changes = 0;
  let encodedBytes = 0;

  while (cursor < context.totalCommits) {
    const result = await pull({
      db: context.db,
      dialect: context.dialect,
      handlers: context.handlers,
      auth: { actorId: 'scope-user-0', partitionId: 'server-scope-perf' },
      request: {
        clientId: 'server-scope-pull-client',
        limitCommits: args.limitCommits,
        limitSnapshotRows: 100,
        maxSnapshotPages: 1,
        dedupeRows: false,
        subscriptions: [
          {
            id: 'tasks-scope-user-0',
            table: 'tasks',
            scopes: { user_id: 'scope-user-0' },
            cursor,
          },
        ],
      },
    });

    if (args.encodeBinary) {
      const encoded = encodeBinarySyncPack(
        {
          ok: true as const,
          pull: result.response,
        },
        args.encodeBinary === 'generated'
          ? {
              changeRowEncoders: {
                tasks: encodeBenchmarkTaskRows,
              },
            }
          : undefined
      );
      encodedBytes += encoded.byteLength;
    }

    const subscription = result.response.subscriptions[0];
    if (!subscription) {
      throw new Error('Scoped pull benchmark returned no subscription');
    }
    const nextCursor = subscription.nextCursor;
    if (nextCursor <= cursor) {
      throw new Error(
        `Scoped pull benchmark made no progress at cursor ${cursor}`
      );
    }
    requests += 1;
    commits += subscription.commits.length;
    changes += subscription.commits.reduce(
      (total, commit) => total + commit.changes.length,
      0
    );
    cursor = nextCursor;
  }

  return { cursor, requests, commits, changes, encodedBytes };
}

function bytesMetric(name: string, bytes: number): BenchmarkResult {
  const kib = bytes / 1024;
  return {
    name,
    unit: 'KiB',
    iterations: 1,
    mean: kib,
    median: kib,
    p95: kib,
    p99: kib,
    min: kib,
    max: kib,
    stdDev: 0,
  };
}

function countMetric(name: string, value: number): BenchmarkResult {
  return {
    name,
    unit: 'count',
    iterations: 1,
    mean: value,
    median: value,
    p95: value,
    p99: value,
    min: value,
    max: value,
    stdDev: 0,
  };
}

function browserMetric(
  name: string,
  metric: BrowserBenchmarkStats
): BenchmarkResult {
  return {
    name,
    iterations: metric.rounds,
    mean: metric.meanMs,
    median: metric.medianMs,
    p95: metric.p95Ms,
    p99: metric.p95Ms,
    min: metric.minMs,
    max: metric.maxMs,
    stdDev: 0,
  };
}

function browserE2eMetric(
  metric: BrowserE2eScoreboardMetric
): BenchmarkResult | null {
  if (metric.unit === 'rows') return null;
  const value = metric.unit === 'bytes' ? metric.value / 1024 : metric.value;
  const unit: BenchmarkResult['unit'] =
    metric.unit === 'bytes' ? 'KiB' : metric.unit === 'count' ? 'count' : 'ms';
  return {
    name:
      metric.unit === 'bytes'
        ? `rust_browser_e2e_${metric.name.replace(/_bytes$/, '_kib')}`
        : `rust_browser_e2e_${metric.name}`,
    unit,
    iterations: 1,
    mean: value,
    median: value,
    p95: value,
    p99: value,
    min: value,
    max: value,
    stdDev: 0,
  };
}

function makeIncrementalSyncPackResponse(changeCount: number) {
  const changes = makeBenchmarkTaskRows(changeCount).map((row, index) => ({
    table: 'tasks',
    row_id: row.id,
    op: 'upsert' as const,
    row_json: row,
    row_version: index + 1,
    scopes: { user_id: 'browser-e2e-user' },
  }));

  return {
    ok: true as const,
    pull: {
      ok: true as const,
      subscriptions: [
        {
          id: 'sub-tasks',
          status: 'active' as const,
          scopes: { user_id: 'browser-e2e-user' },
          bootstrap: false,
          bootstrapState: null,
          nextCursor: changeCount,
          commits: [
            {
              commitSeq: 1,
              createdAt: '2026-05-17T00:00:00.000Z',
              actorId: 'server',
              changes,
            },
          ],
        },
      ],
    },
  };
}

function makeBenchmarkTaskRows(rowCount: number): BenchmarkTaskRow[] {
  return Array.from({ length: rowCount }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    completed: index % 2 === 0 ? 1 : 0,
    user_id: 'browser-e2e-user',
    project_id: index % 5 === 0 ? 'p1' : null,
    server_version: index + 1,
    image: null,
    title_yjs_state: null,
  }));
}

interface BenchmarkTaskRow {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string | null;
  server_version: number;
  image: null;
  title_yjs_state: null;
}

const benchmarkTaskBinaryColumns = [
  { name: 'id', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'completed', type: 'integer' },
  { name: 'user_id', type: 'string' },
  { name: 'project_id', type: 'string', nullable: true },
  { name: 'server_version', type: 'integer' },
  { name: 'image', type: 'json', nullable: true },
  { name: 'title_yjs_state', type: 'string', nullable: true },
] satisfies readonly BinarySnapshotColumn[];

function encodeBenchmarkTaskRows(rows: readonly unknown[]): Uint8Array {
  return encodeBinarySnapshotTable({
    table: 'tasks',
    columns: benchmarkTaskBinaryColumns,
    rows: rows as readonly Record<string, unknown>[],
  });
}

async function runJsonCommand<T>(cmd: string[], label: string): Promise<T> {
  const { stdout } = await runCommand(cmd, label);
  const output = stdout.trim();
  const jsonStart = output.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(`${label} did not emit JSON`);
  }
  return JSON.parse(output.slice(jsonStart)) as T;
}

async function runCommand(
  cmd: string[],
  label: string
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${exitCode}\n${stdout}\n${stderr}`
    );
  }
  return { stdout, stderr };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
