import { afterAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  type BenchmarkResult,
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

const results: BenchmarkResult[] = [];
const itBrowserBenchmark =
  Bun.env.PERF_RUST_BROWSER_BENCHMARK === 'true' ? it : it.skip;

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

      expect(browser.results.rustOwnedSqliteOpfsWorker.medianMs).toBeGreaterThan(
        0
      );
      expect(browser.runtime?.wasmProfile).toBe('release');
    },
    180_000
  );

  it('tracks browser Rust WASM size as a perf budget', async () => {
    await ensureBrowserReleaseWasmBuilt();
    const size = await runJsonCommand<WasmSizeReport>(
      ['bun', 'rust/bindings/browser/scripts/size-syncular-v2-wasm.ts', '--json'],
      'rust browser wasm size'
    );

    results.push(
      bytesMetric('rust_browser_wasm_raw_kib', size.rawBytes),
      bytesMetric('rust_browser_wasm_gzip_kib', size.gzipBytes)
    );

    expect(size.rawBytes).toBeGreaterThan(0);
    expect(size.gzipBytes).toBeGreaterThan(0);
  }, 120_000);
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
