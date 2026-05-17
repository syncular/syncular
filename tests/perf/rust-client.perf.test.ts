import { afterAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  type BinarySnapshotColumn,
  encodeBinarySnapshotTable,
} from '../../packages/core/src/snapshot-chunks';
import {
  decodeBinarySyncPack,
  encodeBinarySyncPack,
} from '../../packages/core/src/sync-packs';
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
        expect(rowMetrics.get('rust_incremental_rows')).toBe(
          rows + incrementalRows
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
  if (metric.unit === 'count' || metric.unit === 'rows') return null;
  const value = metric.unit === 'bytes' ? metric.value / 1024 : metric.value;
  const unit: BenchmarkResult['unit'] = metric.unit === 'bytes' ? 'KiB' : 'ms';
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
  const changes = Array.from({ length: changeCount }, (_, index) => ({
    table: 'tasks',
    row_id: `task-${index}`,
    op: 'upsert' as const,
    row_json: {
      id: `task-${index}`,
      title: `Task ${index}`,
      completed: index % 2 === 0 ? 1 : 0,
      user_id: 'browser-e2e-user',
      project_id: index % 5 === 0 ? 'p1' : null,
      server_version: index + 1,
      image: null,
      title_yjs_state: null,
    },
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
