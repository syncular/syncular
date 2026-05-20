import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      incrementalRows: number;
      realtimeIterations: number;
      queryIterations: number;
      rustStorage: 'memory' | 'indexedDb' | 'opfsSahPool';
      rustIncludeSnapshotRows: boolean;
      rustCollectChangedRows: boolean;
      rustMaxSnapshotChangedRows?: number | null;
      rustSnapshotRowsPerPage?: number | null;
      rustMaxSnapshotPages?: number | null;
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

interface ScoreboardReport {
  name: string;
  generatedAt: string;
  runtime: { wasmProfile: 'dev' | 'release'; rustStorage: string };
  browser: { name: string; userAgent: string };
  options: Record<string, unknown>;
  metrics: ScoreboardMetric[];
  comparisons: ReturnType<typeof buildComparisons>;
  baseline?: {
    path: string;
    generatedAt?: string;
    comparisons: BaselineComparison[];
    regressionGate?: BaselineRegressionGate;
  };
}

interface BaselineComparison {
  name: string;
  unit: ScoreboardMetric['unit'];
  previous: number;
  current: number;
  delta: number;
  deltaPercent: number | null;
}

interface BaselineRegressionGate {
  enabled: boolean;
  passed: boolean;
  metricScope: 'rust';
  thresholds: {
    percent: number;
    ms: number;
    bytes: number;
    count: number;
  };
  failures: BaselineRegressionFailure[];
}

interface BaselineRegressionFailure extends BaselineComparison {
  threshold: number;
}

interface BrowserMemorySnapshot {
  jsHeapUsedBytes?: number;
  jsHeapTotalBytes?: number;
}

const rows = numberArg(
  '--rows',
  Number(process.env.SYNCULAR_BROWSER_PERF_ROWS ?? 100_000)
);
const scopeFanoutUsers = numberArg(
  '--scope-fanout-users',
  Number(process.env.SYNCULAR_BROWSER_PERF_SCOPE_FANOUT_USERS ?? 1)
);
const incrementalRows = nonNegativeNumberArg('--incremental-rows', 0);
const realtimeIterations = numberArg(
  '--realtime-iterations',
  Number(process.env.SYNCULAR_BROWSER_E2E_REALTIME_ITERATIONS ?? 1)
);
const queryIterations = nonNegativeNumberArg('--query-iterations', 25);
const rustStorage = storageArg('--rust-storage', 'memory');
const rustIncludeSnapshotRows = booleanArg(
  '--rust-include-snapshot-rows',
  false
);
const rustCollectChangedRows = booleanArg('--rust-collect-changed-rows', false);
const rustMaxSnapshotChangedRows = optionalNumberArg(
  '--rust-max-snapshot-changed-rows'
);
const rustMaxSnapshotPages = optionalPositiveNumberArg(
  '--rust-max-snapshot-pages'
);
const syncSnapshotArtifacts = booleanArg('--sync-snapshot-artifacts', false);
const syncSnapshotArtifactRowLimit = optionalPositiveNumberArg(
  '--sync-snapshot-artifact-row-limit'
);
const rustSnapshotRowsPerPage = optionalPositiveNumberArg(
  '--rust-snapshot-rows-per-page'
);
const effectiveSyncSnapshotArtifactRowLimit = syncSnapshotArtifacts
  ? (syncSnapshotArtifactRowLimit ?? rustSnapshotRowsPerPage ?? 50_000)
  : undefined;
const effectiveRustSnapshotRowsPerPage =
  rustSnapshotRowsPerPage ?? effectiveSyncSnapshotArtifactRowLimit;
const wasmProfile = wasmProfileArg(
  '--wasm-profile',
  process.env.SYNCULAR_BROWSER_WASM_PROFILE ?? 'release'
);
const outputPath = stringArg('--output');
const baselinePath = stringArg('--baseline');
const updateBaseline = process.argv.includes('--update-baseline');
const jsonOutput = process.argv.includes('--json');
const failOnRegression = process.argv.includes('--fail-on-regression');
const regressionThresholdPercent = nonNegativeNumberArg(
  '--regression-threshold-percent',
  5
);
const regressionThresholdMs = nonNegativeNumberArg(
  '--regression-threshold-ms',
  5
);
const regressionThresholdBytes = nonNegativeNumberArg(
  '--regression-threshold-bytes',
  1024
);
const regressionThresholdCount = nonNegativeNumberArg(
  '--regression-threshold-count',
  0
);

const baselineComparisonMetrics = [
  'ts_bootstrap_ms',
  'rust_schema_install_ms',
  'rust_schema_base_ms',
  'rust_schema_derived_ms',
  'rust_schema_indexes_ms',
  'rust_schema_read_model_rebuild_ms',
  'rust_bootstrap_ms',
  'rust_request_count',
  'rust_response_bytes',
  'rust_pull_request_ms',
  'rust_snapshot_fetch_ms',
  'rust_pull_apply_ms',
  'rust_snapshot_row_apply_ms',
  'rust_snapshot_artifact_apply_ms',
  'rust_snapshot_artifact_count',
  'rust_snapshot_artifact_bytes',
  'rust_snapshot_artifact_fetch_ms',
  'rust_snapshot_artifact_decompress_ms',
  'rust_snapshot_artifact_hash_ms',
  'rust_snapshot_chunk_apply_ms',
  'rust_snapshot_chunk_materialize_ms',
  'rust_snapshot_chunk_bind_ms',
  'rust_snapshot_chunk_step_ms',
  'rust_server_bootstrap_row_frame_encode_ms',
  'rust_server_bootstrap_snapshot_binary_encode_ms',
  'rust_cached_bootstrap_ms',
  'rust_cached_schema_install_ms',
  'rust_cached_schema_base_ms',
  'rust_cached_schema_derived_ms',
  'rust_cached_schema_indexes_ms',
  'rust_cached_schema_read_model_rebuild_ms',
  'rust_server_bootstrap_artifact_cache_lookup_ms',
  'rust_cached_request_count',
  'rust_cached_response_bytes',
  'rust_cached_pull_apply_ms',
  'rust_cached_snapshot_artifact_apply_ms',
  'rust_cached_snapshot_artifact_count',
  'rust_cached_snapshot_artifact_bytes',
  'rust_cached_snapshot_artifact_fetch_ms',
  'rust_cached_snapshot_artifact_decompress_ms',
  'rust_cached_snapshot_artifact_hash_ms',
  'rust_cached_snapshot_chunk_apply_ms',
  'rust_cached_server_bootstrap_row_frame_encode_ms',
  'rust_cached_server_bootstrap_snapshot_binary_encode_ms',
  'rust_cached_server_bootstrap_artifact_cache_lookup_ms',
  'ts_local_list_p50_ms',
  'rust_local_list_p50_ms',
  'ts_local_search_p50_ms',
  'rust_local_search_p50_ms',
  'ts_aggregate_p50_ms',
  'rust_aggregate_p50_ms',
  'ts_aggregate_read_model_p50_ms',
  'rust_aggregate_read_model_p50_ms',
  'ts_incremental_push_ms',
  'rust_incremental_pull_ms',
  'rust_incremental_pull_request_ms',
  'rust_incremental_pull_apply_ms',
  'rust_incremental_commit_apply_ms',
  'rust_incremental_sync_pack_decode_ms',
  'rust_incremental_response_bytes',
  'rust_incremental_rows',
  'ts_realtime_push_ms',
  'ts_realtime_push_p95_ms',
  'rust_realtime_live_ms',
  'rust_realtime_live_p95_ms',
  'rust_realtime_overhead_p50_ms',
  'rust_realtime_overhead_p95_ms',
  'rust_realtime_http_request_count',
  'rust_realtime_http_request_bytes',
  'rust_realtime_http_response_bytes',
  'rust_realtime_binary_events',
  'rust_realtime_binary_bytes',
  'rust_realtime_apply_total_ms',
  'rust_realtime_apply_total_p50_ms',
  'rust_realtime_apply_total_p95_ms',
  'rust_realtime_sync_pack_decode_total_ms',
  'rust_realtime_sync_pack_decode_p50_ms',
  'rust_realtime_sync_pack_decode_p95_ms',
  'rust_realtime_pull_transform_total_ms',
  'rust_realtime_pull_transform_p50_ms',
  'rust_realtime_pull_transform_p95_ms',
  'rust_realtime_integrity_verify_total_ms',
  'rust_realtime_integrity_verify_p50_ms',
  'rust_realtime_integrity_verify_p95_ms',
  'rust_realtime_pull_apply_total_ms',
  'rust_realtime_pull_apply_p50_ms',
  'rust_realtime_pull_apply_p95_ms',
  'rust_realtime_commit_apply_total_ms',
  'rust_realtime_commit_apply_p50_ms',
  'rust_realtime_commit_apply_p95_ms',
  'rust_realtime_subscription_state_total_ms',
  'rust_realtime_subscription_state_p50_ms',
  'rust_realtime_subscription_state_p95_ms',
  'rust_realtime_notify_total_ms',
  'rust_realtime_notify_p50_ms',
  'rust_realtime_notify_p95_ms',
  'rust_realtime_rows',
  'browser_js_heap_used_delta_bytes',
  'browser_js_heap_total_after_bytes',
  'browser_served_rust_wasm_bytes',
  'browser_served_asset_total_bytes',
] as const;

let assetProc: ReturnType<typeof Bun.spawn> | undefined;
let assetPort: number | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let browserErrors: BrowserErrorCollector | undefined;
const failedResponses: string[] = [];
const observedRustPullRequests: Array<{
  limitSnapshotRows?: number;
  maxSnapshotPages?: number;
  requestsSnapshotArtifacts: boolean;
}> = [];

try {
  if (!existsSync(chromium.executablePath())) {
    throw new Error(
      'Playwright Chromium is missing. Run `bunx playwright install chromium` first.'
    );
  }

  assetPort = await pickFreePort();
  const servePath = path.resolve(import.meta.dir, '../apps/browser/serve.ts');
  const serveArgs = [
    'bun',
    servePath,
    `--port=${assetPort}`,
    `--wasm-profile=${wasmProfile}`,
    `--sync-seed-rows=${rows * scopeFanoutUsers}`,
    `--sync-seed-users=${scopeFanoutUsers}`,
  ];
  if (syncSnapshotArtifacts) {
    serveArgs.push('--sync-snapshot-artifacts');
    serveArgs.push(
      `--sync-snapshot-artifact-row-limit=${effectiveSyncSnapshotArtifactRowLimit}`
    );
  }
  assetProc = Bun.spawn(serveArgs, {
    cwd: path.resolve(import.meta.dir, '..'),
    env: { ...process.env, SYNCULAR_BROWSER_WASM_PROFILE: wasmProfile },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

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
  page.on('request', (request) => {
    observeRustPullRequest(request.url(), request.method(), request.postData());
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
      (window as unknown as ScoreboardWindow).__runtime.benchmarkE2eScoreboard(
        options
      ),
    {
      serverUrl: assetUrl,
      actorId: 'browser-e2e-user',
      projectId: 'p1',
      rows,
      incrementalRows,
      realtimeIterations,
      queryIterations,
      rustStorage,
      rustIncludeSnapshotRows,
      rustCollectChangedRows,
      rustMaxSnapshotChangedRows,
      rustSnapshotRowsPerPage: effectiveRustSnapshotRowsPerPage,
      rustMaxSnapshotPages,
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
    metric('benchmark_seed_rows', rows * scopeFanoutUsers, 'rows'),
    metric('benchmark_scope_fanout_users', scopeFanoutUsers, 'count'),
    metric(
      'benchmark_sync_snapshot_artifacts',
      syncSnapshotArtifacts ? 1 : 0,
      'count'
    ),
    ...(syncSnapshotArtifacts
      ? [
          metric(
            'benchmark_sync_snapshot_artifact_row_limit',
            effectiveSyncSnapshotArtifactRowLimit!,
            'rows'
          ),
        ]
      : []),
    ...(effectiveRustSnapshotRowsPerPage != null
      ? [
          metric(
            'benchmark_rust_snapshot_rows_per_page',
            effectiveRustSnapshotRowsPerPage,
            'rows'
          ),
        ]
      : []),
    ...observedRustPullRequestMetrics(observedRustPullRequests[0]),
    ...result.metrics,
    ...resourceMetrics(resourcesAfterLoad, resourcesAfterBenchmark),
    ...servedAssetMetrics,
    ...memoryMetrics(memoryBefore, memoryAfter),
  ];

  const baselineReport =
    baselinePath && existsSync(baselinePath)
      ? readScoreboardReport(baselinePath)
      : undefined;
  const baselineComparisons = baselineReport
    ? buildBaselineComparisons(metrics, baselineReport.metrics)
    : [];
  const baselineRegressionGate =
    baselinePath && baselineReport
      ? buildBaselineRegressionGate(baselineComparisons)
      : undefined;

  const report: ScoreboardReport = {
    name: 'browser-e2e-scoreboard',
    generatedAt: new Date().toISOString(),
    runtime: { wasmProfile, rustStorage },
    browser: {
      name: 'chromium',
      userAgent: await page.evaluate(() => navigator.userAgent),
    },
    options: {
      rows,
      seedRows: rows * scopeFanoutUsers,
      scopeFanoutUsers,
      incrementalRows,
      realtimeIterations,
      queryIterations,
      rustIncludeSnapshotRows,
      rustCollectChangedRows,
      rustMaxSnapshotChangedRows,
      rustSnapshotRowsPerPage: effectiveRustSnapshotRowsPerPage,
      syncSnapshotArtifacts,
      syncSnapshotArtifactRowLimit: effectiveSyncSnapshotArtifactRowLimit,
    },
    metrics,
    comparisons: buildComparisons(metrics),
  };
  if (baselinePath) {
    report.baseline = {
      path: baselinePath,
      generatedAt: baselineReport?.generatedAt,
      comparisons: baselineComparisons,
      regressionGate: baselineRegressionGate,
    };
  }

  if (outputPath) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (baselinePath && updateBaseline) {
    mkdirSync(path.dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log('Browser E2E TS vs Rust scoreboard');
    console.log(
      `rows=${rows} incremental-rows=${incrementalRows} query-iterations=${queryIterations} wasm-profile=${wasmProfile} rust-storage=${rustStorage}`
    );
    if (incrementalRows > 0) {
      console.log(`realtime-iterations=${realtimeIterations}`);
    }
    if (scopeFanoutUsers > 1) {
      console.log(
        `scope-fanout-users=${scopeFanoutUsers} seed-rows=${rows * scopeFanoutUsers}`
      );
    }
    console.log(
      `rust-include-snapshot-rows=${rustIncludeSnapshotRows} rust-collect-changed-rows=${rustCollectChangedRows}`
    );
    if (rustMaxSnapshotChangedRows != null) {
      console.log(
        `rust-max-snapshot-changed-rows=${rustMaxSnapshotChangedRows}`
      );
    }
    if (effectiveRustSnapshotRowsPerPage != null) {
      console.log(
        `rust-snapshot-rows-per-page=${effectiveRustSnapshotRowsPerPage}`
      );
    }
    if (rustMaxSnapshotPages != null) {
      console.log(`rust-max-snapshot-pages=${rustMaxSnapshotPages}`);
    }
    console.log(`sync-snapshot-artifacts=${syncSnapshotArtifacts}`);
    if (syncSnapshotArtifacts) {
      console.log(
        `sync-snapshot-artifact-row-limit=${effectiveSyncSnapshotArtifactRowLimit}`
      );
    }
    console.log('');
    console.log(formatMetrics(report.metrics));
    const comparisons = report.comparisons;
    if (comparisons.length > 0) {
      console.log('');
      console.log(formatComparisons(comparisons));
    }
    if (baselinePath) {
      console.log('');
      if (baselineReport) {
        console.log(formatBaselineComparisons(baselineComparisons));
        if (baselineRegressionGate?.enabled) {
          console.log('');
          console.log(formatBaselineRegressionGate(baselineRegressionGate));
        }
      } else {
        console.log(`Baseline not found: ${baselinePath}`);
      }
      if (updateBaseline) {
        console.log(`Updated baseline: ${baselinePath}`);
      }
    }
    if (outputPath) console.log(`JSON report: ${outputPath}`);
  }
  if (
    baselineRegressionGate?.enabled &&
    baselineRegressionGate.failures.length > 0
  ) {
    process.exitCode = 1;
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
      metric('browser_js_heap_used_after_bytes', after.jsHeapUsedBytes, 'bytes')
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

function observeRustPullRequest(
  requestUrl: string,
  method: string,
  postData: string | null
) {
  if (method !== 'POST' || !postData) return;
  const url = new URL(requestUrl);
  if (!url.pathname.endsWith('/sync')) return;
  try {
    const body = JSON.parse(postData) as {
      clientId?: unknown;
      pull?: {
        limitSnapshotRows?: unknown;
        maxSnapshotPages?: unknown;
        snapshotArtifacts?: unknown;
      };
    };
    if (
      typeof body.clientId !== 'string' ||
      !body.clientId.startsWith('rust-e2e') ||
      body.pull == null
    ) {
      return;
    }
    observedRustPullRequests.push({
      limitSnapshotRows:
        typeof body.pull.limitSnapshotRows === 'number'
          ? body.pull.limitSnapshotRows
          : undefined,
      maxSnapshotPages:
        typeof body.pull.maxSnapshotPages === 'number'
          ? body.pull.maxSnapshotPages
          : undefined,
      requestsSnapshotArtifacts: body.pull.snapshotArtifacts != null,
    });
  } catch {
    // Best-effort benchmark observation only.
  }
}

function observedRustPullRequestMetrics(
  request:
    | {
        limitSnapshotRows?: number;
        maxSnapshotPages?: number;
        requestsSnapshotArtifacts: boolean;
      }
    | undefined
): ScoreboardMetric[] {
  if (!request) return [];
  const metrics = [
    metric(
      'benchmark_rust_observed_snapshot_artifacts',
      request.requestsSnapshotArtifacts ? 1 : 0,
      'count'
    ),
  ];
  if (request.limitSnapshotRows != null) {
    metrics.push(
      metric(
        'benchmark_rust_observed_limit_snapshot_rows',
        request.limitSnapshotRows,
        'rows'
      )
    );
  }
  if (request.maxSnapshotPages != null) {
    metrics.push(
      metric(
        'benchmark_rust_observed_max_snapshot_pages',
        request.maxSnapshotPages,
        'count'
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
    [
      'aggregate_read_model_p50',
      'ts_aggregate_read_model_p50_ms',
      'rust_aggregate_read_model_p50_ms',
    ],
    [
      'aggregate_read_model_p95',
      'ts_aggregate_read_model_p95_ms',
      'rust_aggregate_read_model_p95_ms',
    ],
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

function buildBaselineComparisons(
  current: ScoreboardMetric[],
  baseline: ScoreboardMetric[]
): BaselineComparison[] {
  const currentByName = new Map(current.map((metric) => [metric.name, metric]));
  const baselineByName = new Map(
    baseline.map((metric) => [metric.name, metric])
  );
  return baselineComparisonMetrics.flatMap((name) => {
    const currentMetric = currentByName.get(name);
    const baselineMetric = baselineByName.get(name);
    if (!currentMetric || !baselineMetric) return [];
    if (currentMetric.unit !== baselineMetric.unit) return [];
    const delta = currentMetric.value - baselineMetric.value;
    const deltaPercent =
      baselineMetric.value === 0
        ? delta === 0
          ? 0
          : null
        : (delta / baselineMetric.value) * 100;
    return [
      {
        name,
        unit: currentMetric.unit,
        previous: baselineMetric.value,
        current: currentMetric.value,
        delta,
        deltaPercent,
      },
    ];
  });
}

function buildBaselineRegressionGate(
  comparisons: BaselineComparison[]
): BaselineRegressionGate {
  const failures = failOnRegression
    ? comparisons.filter(isGatedBaselineRegression).map((row) => ({
        ...row,
        threshold: absoluteRegressionThreshold(row.unit),
      }))
    : [];
  return {
    enabled: failOnRegression,
    passed: failures.length === 0,
    metricScope: 'rust',
    thresholds: {
      percent: regressionThresholdPercent,
      ms: regressionThresholdMs,
      bytes: regressionThresholdBytes,
      count: regressionThresholdCount,
    },
    failures,
  };
}

function isGatedBaselineRegression(row: BaselineComparison): boolean {
  if (!isRustRegressionGateMetric(row.name)) return false;
  if (row.delta <= 0) return false;
  const absoluteThreshold = absoluteRegressionThreshold(row.unit);
  if (row.delta <= absoluteThreshold) return false;
  if (row.deltaPercent == null) return true;
  return row.deltaPercent > regressionThresholdPercent;
}

function isRustRegressionGateMetric(name: string): boolean {
  return name.startsWith('rust_') || name.startsWith('browser_served_');
}

function absoluteRegressionThreshold(unit: ScoreboardMetric['unit']): number {
  if (unit === 'ms') return regressionThresholdMs;
  if (unit === 'bytes') return regressionThresholdBytes;
  return regressionThresholdCount;
}

function readScoreboardReport(filePath: string): ScoreboardReport {
  const raw = readFileSync(filePath, 'utf8');
  const value = JSON.parse(raw) as Partial<ScoreboardReport>;
  if (!Array.isArray(value.metrics)) {
    throw new Error(`Baseline report is missing metrics: ${filePath}`);
  }
  return value as ScoreboardReport;
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
  comparisons: Array<{
    name: string;
    ts: number;
    rust: number;
    rustToTs: number;
  }>
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

function formatBaselineComparisons(comparisons: BaselineComparison[]): string {
  if (comparisons.length === 0) {
    return 'Baseline comparison: no matching target metrics.';
  }
  const header = '| Baseline Metric | Previous | Current | Delta | Delta % |';
  const separator =
    '|-----------------|----------|---------|-------|---------|';
  return [
    'Baseline comparison',
    header,
    separator,
    ...comparisons.map((row) => {
      const delta = `${row.delta >= 0 ? '+' : ''}${formatMetricDelta(row)}`;
      const deltaPercent =
        row.deltaPercent == null
          ? 'n/a'
          : `${row.deltaPercent >= 0 ? '+' : ''}${formatNumber(row.deltaPercent)}%`;
      return `| ${row.name} | ${formatMetricValue({ name: row.name, value: row.previous, unit: row.unit })} | ${formatMetricValue({ name: row.name, value: row.current, unit: row.unit })} | ${delta} | ${deltaPercent} |`;
    }),
  ].join('\n');
}

function formatBaselineRegressionGate(gate: BaselineRegressionGate): string {
  if (!gate.enabled) return 'Regression gate: disabled.';
  if (gate.passed) {
    return `Regression gate: passed for Rust/package metrics (>${formatNumber(gate.thresholds.ms)}ms and >${formatNumber(gate.thresholds.percent)}%, >${formatNumber(gate.thresholds.bytes)} bytes and >${formatNumber(gate.thresholds.percent)}%, or >${formatNumber(gate.thresholds.count)} count/rows and >${formatNumber(gate.thresholds.percent)}%).`;
  }
  const header =
    '| Failed Metric | Previous | Current | Delta | Delta % | Absolute Threshold |';
  const separator =
    '|---------------|----------|---------|-------|---------|--------------------|';
  return [
    `Regression gate: failed for ${gate.failures.length} Rust/package metric(s).`,
    header,
    separator,
    ...gate.failures.map((row) => {
      const delta = `${row.delta >= 0 ? '+' : ''}${formatMetricDelta(row)}`;
      const deltaPercent =
        row.deltaPercent == null
          ? 'n/a'
          : `${row.deltaPercent >= 0 ? '+' : ''}${formatNumber(row.deltaPercent)}%`;
      return `| ${row.name} | ${formatMetricValue({ name: row.name, value: row.previous, unit: row.unit })} | ${formatMetricValue({ name: row.name, value: row.current, unit: row.unit })} | ${delta} | ${deltaPercent} | ${formatMetricValue({ name: row.name, value: row.threshold, unit: row.unit })} |`;
    }),
  ].join('\n');
}

function formatMetricValue(metric: ScoreboardMetric): string {
  if (metric.unit === 'ms') return `${formatNumber(metric.value)}ms`;
  if (metric.unit === 'bytes') return `${formatNumber(metric.value)} bytes`;
  return `${formatNumber(metric.value)} ${metric.unit}`;
}

function formatMetricDelta(
  metric: Omit<ScoreboardMetric, 'value'> & {
    delta: number;
  }
): string {
  if (metric.unit === 'ms') return `${formatNumber(metric.delta)}ms`;
  if (metric.unit === 'bytes') return `${formatNumber(metric.delta)} bytes`;
  return `${formatNumber(metric.delta)} ${metric.unit}`;
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

function nonNegativeNumberArg(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 1));
  if (!Number.isFinite(value) || value < 0) {
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

function optionalPositiveNumberArg(name: string): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!raw) return undefined;
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

function booleanArg(name: string, fallback: boolean): boolean {
  const raw = process.argv.find(
    (arg) => arg === name || arg.startsWith(`${name}=`)
  );
  if (raw === name) return true;
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
