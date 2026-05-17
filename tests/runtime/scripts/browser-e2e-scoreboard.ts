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
    }): Promise<ScoreboardResult>;
  };
}

const rows = numberArg(
  '--rows',
  Number(process.env.SYNCULAR_BROWSER_PERF_ROWS ?? 100_000)
);
const queryIterations = numberArg('--query-iterations', 25);
const rustStorage = storageArg('--rust-storage', 'memory');
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

  const report = {
    name: 'browser-e2e-scoreboard',
    generatedAt: new Date().toISOString(),
    runtime: { wasmProfile, rustStorage },
    browser: {
      name: 'chromium',
      userAgent: await page.evaluate(() => navigator.userAgent),
    },
    options: { rows, queryIterations },
    metrics: result.metrics,
    comparisons: buildComparisons(result.metrics),
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
