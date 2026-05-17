import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import {
  type BrowserErrorCollector,
  collectBrowserErrors,
} from '../shared/browser-errors';
import { pickFreePort, waitForHealthy } from '../shared/utils';

interface ScoreboardMetric {
  name: string;
  value: number;
  unit: 'ms' | 'rows' | 'bytes' | 'count';
}

interface ScoreboardResult {
  ok: boolean;
  rows?: number;
  queryIterations?: number;
  metrics?: ScoreboardMetric[];
  error?: string;
}

interface ScoreboardWindow {
  __runtimeReady: boolean;
  __runtime: {
    benchmarkE2eScoreboard(options: {
      serverUrl: string;
      actorId: string;
      projectId: string;
      rows: number;
      queryIterations: number;
      rustStorage: 'memory' | 'indexedDb' | 'opfsSahPool';
      rustIncludeSnapshotRows: boolean;
      rustCollectChangedRows: boolean;
      rustMaxSnapshotChangedRows?: number | null;
    }): Promise<ScoreboardResult>;
  };
}

interface ResourceSummary {
  totalTransferBytes: number;
  totalEncodedBytes: number;
  totalDecodedBytes: number;
  assetTransferBytes: number;
  assetEncodedBytes: number;
  assetDecodedBytes: number;
  jsAssetEncodedBytes: number;
  wasmAssetEncodedBytes: number;
  syncTransferBytes: number;
  syncEncodedBytes: number;
  syncDecodedBytes: number;
}

interface BrowserMemorySnapshot {
  jsHeapUsedBytes?: number;
  jsHeapTotalBytes?: number;
}

const rows = numberArg(
  '--rows',
  Number(process.env.SYNCULAR_BROWSER_PERF_ROWS ?? 100_000)
);
const queryIterations = numberArg('--query-iterations', 25);
const rustStorage = storageArg('--rust-storage', 'memory');
const rustIncludeSnapshotRows = booleanArg('--rust-include-snapshot-rows', false);
const rustCollectChangedRows = booleanArg('--rust-collect-changed-rows', false);
const rustMaxSnapshotChangedRows = optionalNumberArg(
  '--rust-max-snapshot-changed-rows'
);
const wasmProfile = wasmProfileArg(
  '--wasm-profile',
  process.env.SYNCULAR_BROWSER_WASM_PROFILE ?? 'release'
);
const outputPath = stringArg('--output');
const jsonOutput = process.argv.includes('--json');

let assetProc: ReturnType<typeof Bun.spawn> | undefined;
let assetPort: number | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let browserErrors: BrowserErrorCollector | undefined;
const failedResponses: string[] = [];

try {
  if (!existsSync(chromium.executablePath())) {
    throw new Error(
      'Playwright Chromium is missing. Run `bunx playwright install chromium` first.'
    );
  }

  assetPort = await pickFreePort();
  const servePath = path.resolve(import.meta.dir, '../apps/browser/serve.ts');
  assetProc = Bun.spawn(
    [
      'bun',
      servePath,
      `--port=${assetPort}`,
      `--wasm-profile=${wasmProfile}`,
      `--sync-seed-rows=${rows}`,
    ],
    {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, SYNCULAR_BROWSER_WASM_PROFILE: wasmProfile },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  const assetUrl = `http://127.0.0.1:${assetPort}`;
  await waitForHealthy(assetUrl, wasmProfile === 'release' ? 180_000 : 60_000);
  const servedAssetMetrics = await collectServedAssetMetrics(assetUrl);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  page.on('response', (response) => {
    if (response.status() < 400) return;
    failedResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(assetUrl);
  await page.waitForFunction(() => window.__runtimeReady === true, {
    timeout: 30_000,
  });
  browserErrors = collectBrowserErrors(page);
  const resourcesAfterLoad = await collectResourceSummary(page);
  const memoryBefore = await collectBrowserMemory(page);

  const result = await page.evaluate(
    (options) =>
      (
        window as unknown as ScoreboardWindow
      ).__runtime.benchmarkE2eScoreboard(options),
    {
      serverUrl: assetUrl,
      actorId: 'browser-e2e-user',
      projectId: 'p1',
      rows,
      queryIterations,
      rustStorage,
      rustIncludeSnapshotRows,
      rustCollectChangedRows,
      rustMaxSnapshotChangedRows,
    }
  );

  if (!result.ok || !result.metrics) {
    throw new Error(
      `${result.error ?? `browser e2e scoreboard failed without an error: ${JSON.stringify(result)}`}` +
        (failedResponses.length > 0
          ? `\nFailed responses:\n${failedResponses.join('\n')}`
          : '')
    );
  }
  browserErrors.assertNone('browser e2e scoreboard');
  const resourcesAfterBenchmark = await collectResourceSummary(page);
  const memoryAfter = await collectBrowserMemory(page);
  const metrics = [
    ...result.metrics,
    ...resourceMetrics(resourcesAfterLoad, resourcesAfterBenchmark),
    ...servedAssetMetrics,
    ...memoryMetrics(memoryBefore, memoryAfter),
  ];

  const report = {
    name: 'browser-e2e-scoreboard',
    generatedAt: new Date().toISOString(),
    runtime: { wasmProfile, rustStorage },
    browser: {
      name: 'chromium',
      userAgent: await page.evaluate(() => navigator.userAgent),
    },
    options: {
      rows,
      queryIterations,
      rustIncludeSnapshotRows,
      rustCollectChangedRows,
      rustMaxSnapshotChangedRows,
    },
    metrics,
    comparisons: buildComparisons(metrics),
  };

  if (outputPath) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log('Browser E2E TS vs Rust scoreboard');
    console.log(
      `rows=${rows} query-iterations=${queryIterations} wasm-profile=${wasmProfile} rust-storage=${rustStorage}`
    );
    console.log(
      `rust-include-snapshot-rows=${rustIncludeSnapshotRows} rust-collect-changed-rows=${rustCollectChangedRows}`
    );
    if (rustMaxSnapshotChangedRows != null) {
      console.log(`rust-max-snapshot-changed-rows=${rustMaxSnapshotChangedRows}`);
    }
    console.log('');
    console.log(formatMetrics(report.metrics));
    const comparisons = report.comparisons;
    if (comparisons.length > 0) {
      console.log('');
      console.log(formatComparisons(comparisons));
    }
    if (outputPath) console.log(`JSON report: ${outputPath}`);
  }
} finally {
  browserErrors?.detach();
  await closeBrowser(browser);
  await killProcess(assetProc);
  killAssetServerByPort(assetPort);
}

async function collectResourceSummary(page: Page): Promise<ResourceSummary> {
  return page.evaluate(() => {
    const empty = {
      totalTransferBytes: 0,
      totalEncodedBytes: 0,
      totalDecodedBytes: 0,
      assetTransferBytes: 0,
      assetEncodedBytes: 0,
      assetDecodedBytes: 0,
      jsAssetEncodedBytes: 0,
      wasmAssetEncodedBytes: 0,
      syncTransferBytes: 0,
      syncEncodedBytes: 0,
      syncDecodedBytes: 0,
    };
    const entries = [
      ...performance.getEntriesByType('navigation'),
      ...performance.getEntriesByType('resource'),
    ] as PerformanceResourceTiming[];
    for (const entry of entries) {
      const transferSize = entry.transferSize || 0;
      const encodedBodySize = entry.encodedBodySize || 0;
      const decodedBodySize = entry.decodedBodySize || 0;
      empty.totalTransferBytes += transferSize;
      empty.totalEncodedBytes += encodedBodySize;
      empty.totalDecodedBytes += decodedBodySize;
      const pathname = new URL(entry.name, location.href).pathname;
      const isAsset =
        pathname === '/' ||
        pathname === '/index.html' ||
        pathname.endsWith('.js') ||
        pathname.endsWith('.wasm') ||
        pathname.startsWith('/wasqlite/') ||
        pathname.startsWith('/wasm/');
      if (isAsset) {
        empty.assetTransferBytes += transferSize;
        empty.assetEncodedBytes += encodedBodySize;
        empty.assetDecodedBytes += decodedBodySize;
      }
      if (pathname.endsWith('.js')) {
        empty.jsAssetEncodedBytes += encodedBodySize;
      }
      if (pathname.endsWith('.wasm')) {
        empty.wasmAssetEncodedBytes += encodedBodySize;
      }
      if (pathname.startsWith('/sync')) {
        empty.syncTransferBytes += transferSize;
        empty.syncEncodedBytes += encodedBodySize;
        empty.syncDecodedBytes += decodedBodySize;
      }
    }
    return empty;
  });
}

async function collectBrowserMemory(
  page: Page
): Promise<BrowserMemorySnapshot> {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const response = (await session.send('Performance.getMetrics')) as {
      metrics: Array<{ name: string; value: number }>;
    };
    await session.detach();
    const metrics = new Map(
      response.metrics.map((metric) => [metric.name, metric.value])
    );
    return {
      jsHeapUsedBytes: metrics.get('JSHeapUsedSize'),
      jsHeapTotalBytes: metrics.get('JSHeapTotalSize'),
    };
  } catch {
    return page.evaluate(() => {
      const memory = (
        performance as Performance & {
          memory?: {
            usedJSHeapSize?: number;
            totalJSHeapSize?: number;
          };
        }
      ).memory;
      return {
        jsHeapUsedBytes: memory?.usedJSHeapSize,
        jsHeapTotalBytes: memory?.totalJSHeapSize,
      };
    });
  }
}

function resourceMetrics(
  afterLoad: ResourceSummary,
  afterBenchmark: ResourceSummary
): ScoreboardMetric[] {
  const syncTransferBytes =
    afterBenchmark.syncTransferBytes - afterLoad.syncTransferBytes;
  const syncEncodedBytes =
    afterBenchmark.syncEncodedBytes - afterLoad.syncEncodedBytes;
  const syncDecodedBytes =
    afterBenchmark.syncDecodedBytes - afterLoad.syncDecodedBytes;
  return [
    metric(
      'browser_page_loaded_transfer_bytes',
      afterLoad.totalTransferBytes,
      'bytes'
    ),
    metric(
      'browser_page_loaded_encoded_bytes',
      afterLoad.totalEncodedBytes,
      'bytes'
    ),
    metric(
      'browser_page_asset_transfer_bytes',
      afterLoad.assetTransferBytes,
      'bytes'
    ),
    metric(
      'browser_page_asset_encoded_bytes',
      afterLoad.assetEncodedBytes,
      'bytes'
    ),
    metric(
      'browser_page_js_asset_encoded_bytes',
      afterLoad.jsAssetEncodedBytes,
      'bytes'
    ),
    metric(
      'browser_page_wasm_asset_encoded_bytes',
      afterLoad.wasmAssetEncodedBytes,
      'bytes'
    ),
    metric('browser_page_sync_transfer_bytes', syncTransferBytes, 'bytes'),
    metric('browser_page_sync_encoded_bytes', syncEncodedBytes, 'bytes'),
    metric('browser_page_sync_decoded_bytes', syncDecodedBytes, 'bytes'),
    metric(
      'browser_page_total_transfer_bytes',
      afterBenchmark.totalTransferBytes,
      'bytes'
    ),
    metric(
      'browser_page_total_encoded_bytes',
      afterBenchmark.totalEncodedBytes,
      'bytes'
    ),
    metric(
      'browser_page_total_decoded_bytes',
      afterBenchmark.totalDecodedBytes,
      'bytes'
    ),
  ];
}

async function collectServedAssetMetrics(
  assetUrl: string
): Promise<ScoreboardMetric[]> {
  const assets = [
    ['browser_served_entry_js_bytes', '/entry.js'],
    ['browser_served_syncular_worker_js_bytes', '/syncular-v2-worker.js'],
    ['browser_served_rust_wasm_glue_js_bytes', '/wasm/syncular_v2.js'],
    ['browser_served_rust_wasm_bytes', '/wasm/syncular_v2_bg.wasm'],
    ['browser_served_wasqlite_worker_js_bytes', '/wasqlite/worker.js'],
    [
      'browser_served_wasqlite_async_wasm_bytes',
      '/wasqlite/wa-sqlite-async.wasm',
    ],
    ['browser_served_wasqlite_sync_wasm_bytes', '/wasqlite/wa-sqlite.wasm'],
  ] as const;
  const metrics: ScoreboardMetric[] = [];
  let total = 0;
  for (const [name, pathname] of assets) {
    const response = await fetch(`${assetUrl}${pathname}`);
    if (!response.ok) {
      throw new Error(
        `Failed to measure served asset ${pathname}: ${response.status}`
      );
    }
    const bytes = (await response.arrayBuffer()).byteLength;
    total += bytes;
    metrics.push(metric(name, bytes, 'bytes'));
  }
  metrics.push(metric('browser_served_asset_total_bytes', total, 'bytes'));
  return metrics;
}

function memoryMetrics(
  before: BrowserMemorySnapshot,
  after: BrowserMemorySnapshot
): ScoreboardMetric[] {
  const metrics: ScoreboardMetric[] = [];
  if (isFiniteNumber(before.jsHeapUsedBytes)) {
    metrics.push(
      metric(
        'browser_js_heap_used_before_bytes',
        before.jsHeapUsedBytes,
        'bytes'
      )
    );
  }
  if (isFiniteNumber(after.jsHeapUsedBytes)) {
    metrics.push(
      metric(
        'browser_js_heap_used_after_bytes',
        after.jsHeapUsedBytes,
        'bytes'
      )
    );
  }
  if (
    isFiniteNumber(before.jsHeapUsedBytes) &&
    isFiniteNumber(after.jsHeapUsedBytes)
  ) {
    metrics.push(
      metric(
        'browser_js_heap_used_delta_bytes',
        after.jsHeapUsedBytes - before.jsHeapUsedBytes,
        'bytes'
      )
    );
  }
  if (isFiniteNumber(after.jsHeapTotalBytes)) {
    metrics.push(
      metric(
        'browser_js_heap_total_after_bytes',
        after.jsHeapTotalBytes,
        'bytes'
      )
    );
  }
  return metrics;
}

function metric(
  name: string,
  value: number,
  unit: ScoreboardMetric['unit']
): ScoreboardMetric {
  return { name, value, unit };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function buildComparisons(metrics: ScoreboardMetric[]): Array<{
  name: string;
  ts: number;
  rust: number;
  rustToTs: number;
}> {
  const byName = new Map(metrics.map((metric) => [metric.name, metric]));
  const pairs = [
    ['bootstrap', 'ts_bootstrap_ms', 'rust_bootstrap_ms'],
    ['local_list_p50', 'ts_local_list_p50_ms', 'rust_local_list_p50_ms'],
    ['local_list_p95', 'ts_local_list_p95_ms', 'rust_local_list_p95_ms'],
    ['local_search_p50', 'ts_local_search_p50_ms', 'rust_local_search_p50_ms'],
    ['local_search_p95', 'ts_local_search_p95_ms', 'rust_local_search_p95_ms'],
    ['aggregate_p50', 'ts_aggregate_p50_ms', 'rust_aggregate_p50_ms'],
    ['aggregate_p95', 'ts_aggregate_p95_ms', 'rust_aggregate_p95_ms'],
  ] as const;
  return pairs
    .map(([name, tsName, rustName]) => {
      const ts = byName.get(tsName)?.value;
      const rust = byName.get(rustName)?.value;
      if (ts == null || rust == null || ts <= 0) return null;
      return { name, ts, rust, rustToTs: rust / ts };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);
}

function formatMetrics(metrics: ScoreboardMetric[]): string {
  const header = '| Metric | Value |';
  const separator = '|--------|-------|';
  return [
    header,
    separator,
    ...metrics.map(
      (metric) => `| ${metric.name} | ${formatMetricValue(metric)} |`
    ),
  ].join('\n');
}

function formatComparisons(
  comparisons: Array<{ name: string; ts: number; rust: number; rustToTs: number }>
): string {
  const header = '| Compare | TS | Rust | Rust / TS |';
  const separator = '|---------|----|------|-----------|';
  return [
    header,
    separator,
    ...comparisons.map(
      (row) =>
        `| ${row.name} | ${formatNumber(row.ts)}ms | ${formatNumber(row.rust)}ms | ${formatNumber(row.rustToTs)}x |`
    ),
  ].join('\n');
}

function formatMetricValue(metric: ScoreboardMetric): string {
  if (metric.unit === 'ms') return `${formatNumber(metric.value)}ms`;
  if (metric.unit === 'bytes') return `${formatNumber(metric.value)} bytes`;
  return `${formatNumber(metric.value)} ${metric.unit}`;
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

function optionalNumberArg(name: string): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!raw) return undefined;
  const value = Number(raw.slice(name.length + 1));
  if (!Number.isFinite(value) || value < 0) {
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

function booleanArg(name: string, fallback: boolean): boolean {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  const value = raw?.slice(name.length + 1);
  if (value == null) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name}: ${raw}`);
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
