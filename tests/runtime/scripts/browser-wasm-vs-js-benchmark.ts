import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import {
  type BrowserErrorCollector,
  collectBrowserErrors,
} from '../shared/browser-errors';
import { pickFreePort, waitForHealthy } from '../shared/utils';

interface BenchmarkStats {
  label: string;
  operations: number;
  rounds: number;
  totalOperations: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  opsPerSecondMedian: number;
  outboxRows: number;
  taskRows: number;
}

interface BenchmarkResult {
  ok: boolean;
  operations?: number;
  rounds?: number;
  preferOPFS?: boolean;
  includeDirectRustOwned?: boolean;
  js?: BenchmarkStats;
  jsBatch?: BenchmarkStats;
  rustOwnedSqliteIdb?: BenchmarkStats;
  rustOwnedSqliteOpfsWorker?: BenchmarkStats;
  ratioRustOwnedSqliteIdbToJsBatch?: number;
  ratioRustOwnedSqliteOpfsWorkerToJsBatch?: number;
  error?: string;
}

interface FeatureBenchmarkResult {
  ok: boolean;
  operations?: number;
  rounds?: number;
  storage?: string;
  readHeavyQuery?: BenchmarkStats;
  liveQueryRefresh?: BenchmarkStats;
  crdtTextUpdates?: BenchmarkStats;
  encryptedFieldPush?: BenchmarkStats;
  encryptedCrdtTextUpdates?: BenchmarkStats;
  blobMetadata?: BenchmarkStats;
  largeSnapshotRead?: BenchmarkStats;
  multiTableCommit?: BenchmarkStats;
  error?: string;
}

interface BenchmarkRuntimeWindow {
  __runtimeReady: boolean;
  __runtime: {
    benchmarkLocalMutations(options: {
      operations: number;
      rounds: number;
      warmupOperations: number;
      preferOPFS: boolean;
      includeDirectRustOwned: boolean;
    }): Promise<BenchmarkResult>;
    benchmarkFeatureWorkloads(options: {
      operations: number;
      rounds: number;
      warmupOperations: number;
      storage: 'memory' | 'indexedDb' | 'opfsSahPool';
    }): Promise<FeatureBenchmarkResult>;
  };
}

const operations = numberArg('--operations', 100);
const rounds = numberArg('--rounds', 5);
const warmupOperations = numberArg('--warmup', 10);
const featureWorkloads = process.argv.includes('--feature-workloads');
const featureOperations = numberArg('--feature-operations', 50);
const featureRounds = numberArg('--feature-rounds', 5);
const featureWarmupOperations = numberArg('--feature-warmup', 5);
const featureStorage = storageArg('--feature-storage', 'indexedDb');
const preferOPFS = !process.argv.includes('--indexeddb');
const includeDirectRustOwned = process.argv.includes('--include-direct-rust');
const wasmProfile = wasmProfileArg(
  '--wasm-profile',
  process.env.SYNCULAR_BROWSER_WASM_PROFILE ?? 'release'
);
const jsonOutput = process.argv.includes('--json');
const outputPath = stringArg('--output');

let assetProc: ReturnType<typeof Bun.spawn> | undefined;
let assetPort: number | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let browserErrors: BrowserErrorCollector | undefined;

try {
  if (!existsSync(chromium.executablePath())) {
    throw new Error(
      'Playwright Chromium is missing. Run `bunx playwright install chromium` first.'
    );
  }

  assetPort = await pickFreePort();
  const servePath = path.resolve(import.meta.dir, '../apps/browser/serve.ts');
  assetProc = Bun.spawn(
    ['bun', servePath, `--port=${assetPort}`, `--wasm-profile=${wasmProfile}`],
    {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, SYNCULAR_BROWSER_WASM_PROFILE: wasmProfile },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  const assetUrl = `http://127.0.0.1:${assetPort}`;
  await waitForHealthy(assetUrl, wasmProfile === 'release' ? 120_000 : 30_000);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.goto(assetUrl);
  await page.waitForFunction(() => window.__runtimeReady === true, {
    timeout: 30_000,
  });
  browserErrors = collectBrowserErrors(page);

  const result = await page.evaluate(
    (options) =>
      (
        window as unknown as BenchmarkRuntimeWindow
      ).__runtime.benchmarkLocalMutations(options),
    {
      operations,
      rounds,
      warmupOperations,
      preferOPFS,
      includeDirectRustOwned,
    }
  );
  const featureResult = featureWorkloads
    ? await page.evaluate(
        (options) =>
          (
            window as unknown as BenchmarkRuntimeWindow
          ).__runtime.benchmarkFeatureWorkloads(options),
        {
          operations: featureOperations,
          rounds: featureRounds,
          warmupOperations: featureWarmupOperations,
          storage: featureStorage,
        }
      )
    : undefined;

  browserErrors.assertNone('browser wasm/js benchmark');
  if (
    !result.ok ||
    !result.js ||
    !result.jsBatch ||
    !result.rustOwnedSqliteOpfsWorker
  ) {
    throw new Error(
      result.error ??
        `benchmark failed without an error: ${JSON.stringify(result)}`
    );
  }
  if (featureResult && !featureResult.ok) {
    throw new Error(
      featureResult.error ??
        `feature benchmark failed without an error: ${JSON.stringify(featureResult)}`
    );
  }

  const report = {
    name: 'browser-rust-owned-sqlite-local-mutations',
    description:
      'Compares Rust-owned sqlite-wasm-rs local mutation batches against the legacy JS/wa-sqlite host-store fixture. The JS path is benchmark-only, not a supported v2 runtime.',
    generatedAt: new Date().toISOString(),
    browser: {
      name: 'chromium',
      userAgent: await page.evaluate(() => navigator.userAgent),
    },
    runtime: {
      wasmProfile,
    },
    options: {
      operations,
      rounds,
      warmupOperations,
      preferOPFS,
      includeDirectRustOwned,
    },
    results: {
      legacyJsHostStoreSingle: result.js,
      legacyJsHostStoreBatch: result.jsBatch,
      rustOwnedSqliteIndexedDb: result.rustOwnedSqliteIdb,
      rustOwnedSqliteOpfsWorker: result.rustOwnedSqliteOpfsWorker,
    },
    ratios: {
      rustOwnedSqliteIndexedDbMedianToLegacyJsBatch:
        result.ratioRustOwnedSqliteIdbToJsBatch,
      rustOwnedSqliteOpfsWorkerMedianToLegacyJsBatch:
        result.ratioRustOwnedSqliteOpfsWorkerToJsBatch ?? 0,
      rustOwnedSqliteIndexedDbSpeedupVsLegacyJsBatch: result.rustOwnedSqliteIdb
        ? speedup(result.jsBatch, result.rustOwnedSqliteIdb)
        : undefined,
      rustOwnedSqliteOpfsWorkerSpeedupVsLegacyJsBatch: speedup(
        result.jsBatch,
        result.rustOwnedSqliteOpfsWorker
      ),
    },
    featureWorkloads: featureResult
      ? {
          options: {
            operations: featureOperations,
            rounds: featureRounds,
            warmupOperations: featureWarmupOperations,
            storage: featureStorage,
          },
          results: collectFeatureRows(featureResult),
        }
      : undefined,
  };

  if (outputPath) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log('Browser Rust-owned SQLite local mutation benchmark');
    console.log(
      `operations=${operations} rounds=${rounds} warmup=${warmupOperations} preferred-storage=${
        preferOPFS ? 'OPFS' : 'IndexedDB'
      } wasm-profile=${wasmProfile} direct-rust=${includeDirectRustOwned ? 'included' : 'skipped'}`
    );
    console.log(
      'Legacy JS/wa-sqlite rows are benchmark baselines only; v2 runtime remains Rust-owned SQLite.'
    );
    console.log('');
    console.log(
      formatTable([
        result.js,
        result.jsBatch,
        result.rustOwnedSqliteIdb,
        result.rustOwnedSqliteOpfsWorker,
      ].filter((row): row is BenchmarkStats => row != null))
    );
    console.log('');
    if (result.rustOwnedSqliteIdb) {
      console.log(
        `Rust-owned IndexedDB median / legacy JS batch median: ${formatNumber(
          report.ratios.rustOwnedSqliteIndexedDbMedianToLegacyJsBatch ?? 0
        )}x (${formatNumber(
          report.ratios.rustOwnedSqliteIndexedDbSpeedupVsLegacyJsBatch ?? 0
        )}x speedup)`
      );
    }
    console.log(
      `Rust-owned OPFS Worker median / legacy JS batch median: ${formatNumber(
        report.ratios.rustOwnedSqliteOpfsWorkerMedianToLegacyJsBatch
      )}x (${formatNumber(
        report.ratios.rustOwnedSqliteOpfsWorkerSpeedupVsLegacyJsBatch
      )}x speedup)`
    );
    if (outputPath) console.log(`JSON report: ${outputPath}`);
    if (featureResult) {
      const featureRows = collectFeatureRows(featureResult);
      console.log('');
      console.log('Browser Rust-owned SQLite feature workload benchmark');
      console.log(
        `operations=${featureOperations} rounds=${featureRounds} warmup=${featureWarmupOperations} storage=${featureStorage} wasm-profile=${wasmProfile}`
      );
      console.log('');
      console.log(formatTable(featureRows));
    }
  }
} finally {
  browserErrors?.detach();
  await closeBrowser(browser);
  await killProcess(assetProc);
  killAssetServerByPort(assetPort);
}

function collectFeatureRows(result: FeatureBenchmarkResult): BenchmarkStats[] {
  return [
    result.readHeavyQuery,
    result.liveQueryRefresh,
    result.crdtTextUpdates,
    result.encryptedFieldPush,
    result.encryptedCrdtTextUpdates,
    result.blobMetadata,
    result.largeSnapshotRead,
    result.multiTableCommit,
  ].filter((row): row is BenchmarkStats => row != null);
}

function numberArg(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 1));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return Math.floor(value);
}

function storageArg(
  name: string,
  fallback: 'memory' | 'indexedDb' | 'opfsSahPool'
): 'memory' | 'indexedDb' | 'opfsSahPool' {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  const value = raw?.slice(name.length + 1);
  if (value == null) return fallback;
  if (value === 'memory' || value === 'indexedDb' || value === 'opfsSahPool') {
    return value;
  }
  throw new Error(`Invalid ${name}: ${raw}`);
}

function wasmProfileArg(name: string, fallback: string): 'dev' | 'release' {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  const value = raw?.slice(name.length + 1) ?? fallback;
  if (value === 'dev' || value === 'release') return value;
  throw new Error(`Invalid ${name}: ${raw ?? value}`);
}

function stringArg(name: string): string | undefined {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!raw) return undefined;
  const value = raw.slice(name.length + 1);
  if (value.length === 0) throw new Error(`Invalid ${name}: ${raw}`);
  return path.resolve(value);
}

function formatTable(rows: BenchmarkStats[]): string {
  const header =
    '| Client | Median | P95 | Mean | Min | Max | Median ops/s | Tasks | Outbox |';
  const separator =
    '|--------|--------|-----|------|-----|-----|--------------|-------|--------|';
  return [
    header,
    separator,
    ...rows.map(
      (row) =>
        `| ${row.label} | ${formatMs(row.medianMs)} | ${formatMs(row.p95Ms)} | ${formatMs(row.meanMs)} | ${formatMs(row.minMs)} | ${formatMs(row.maxMs)} | ${formatNumber(row.opsPerSecondMedian)} | ${row.taskRows} | ${row.outboxRows} |`
    ),
  ].join('\n');
}

function speedup(baseline: BenchmarkStats, candidate: BenchmarkStats): number {
  if (candidate.medianMs <= 0) return 0;
  return baseline.medianMs / candidate.medianMs;
}

function formatMs(value: number): string {
  return `${formatNumber(value)}ms`;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
}

async function closeBrowser(target: Browser | undefined): Promise<void> {
  if (!target) return;
  await withTimeout(target.close(), 5_000).catch(() => {});
}

async function killProcess(
  target: ReturnType<typeof Bun.spawn> | undefined
): Promise<void> {
  if (!target) return;
  try {
    target.kill('SIGKILL');
  } catch {
    // ignore
  }
  await withTimeout(target.exited, 5_000).catch(() => {});
}

function killAssetServerByPort(port: number | undefined): void {
  if (port == null) return;
  const pattern = `apps/browser/serve.ts --port=${port}`;
  Bun.spawnSync(['pkill', '-f', pattern], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
