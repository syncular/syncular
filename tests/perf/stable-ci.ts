/**
 * Stable CI performance runner.
 *
 * Executes sync perf tests multiple times, aggregates medians per metric,
 * and performs regression detection against baseline.json using median-of-medians.
 */

import path from 'node:path';
import {
  type BenchmarkResult,
  parseBenchmarkTable,
} from './benchmark';
import {
  detectRegressions,
  formatRegressionReport,
  hasMissingBaselines,
  hasRegressions,
  loadBaseline,
} from './regression';

const RUN_COUNT = parseRunCount(Bun.env.PERF_STABLE_RUNS);
const RUN_RETRY_COUNT = 2;
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');
const BASELINE_PATH = path.join(import.meta.dir, 'baseline.json');
const PERF_TEST_PATHS = [
  'tests/perf/sync.perf.test.ts',
  'tests/perf/rust-client.perf.test.ts',
];
const RUST_PERF_TEST_PATHS = ['tests/perf/rust-client.perf.test.ts'];
const OPTIONAL_METRIC_PREFIXES = ['rust_browser_local_'];
const RUST_METRIC_PREFIXES = [
  'rust_native_',
  'rust_e2e_',
  'rust_http_',
  'rust_ws_',
  'rust_browser_',
];
const OUTPUT_JSON_PATH = Bun.env.PERF_STABLE_OUTPUT_JSON;

interface StableMetricStats {
  metric: string;
  suite: string;
  unit: BenchmarkResult['unit'];
  baseline: number | null;
  median: number;
  min: number;
  max: number;
  runs: number[];
}

interface PerfRunResourceUsage {
  durationMs: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  cpuTotalMicros: number;
  maxRssBytes: number;
  contextSwitchesVoluntary: number;
  contextSwitchesInvoluntary: number;
}

interface PerfRunResult {
  medians: Map<string, number>;
  units: Map<string, BenchmarkResult['unit']>;
  resourceUsage: PerfRunResourceUsage;
}

function parseRunCount(raw: string | undefined): number {
  if (!raw) return 5;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 5;
  return parsed;
}

async function resolveGitCommitSha(): Promise<string | null> {
  const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
}

async function resolveToolVersion(command: string[]): Promise<string | null> {
  const proc = Bun.spawn(command, {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const version = stdout.trim();
  return version.length > 0 ? version : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = average(values);
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * p);
  return sorted[index]!;
}

function formatMetricValue(
  value: number,
  unit: BenchmarkResult['unit'] = 'ms'
): string {
  return `${value.toFixed(1)}${unit}`;
}

function formatChange(current: number, baseline: number | null): string {
  if (baseline === null) return 'N/A';
  if (baseline === 0) return current === 0 ? '0.0%' : '+∞%';
  const delta = ((current - baseline) / baseline) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

async function runPerfTestPath(
  run: number,
  testPath: string
): Promise<PerfRunResult> {
  for (let attempt = 1; attempt <= RUN_RETRY_COUNT; attempt++) {
    console.log(
      `\n### Stable Perf Run ${run}/${RUN_COUNT} (${testPath})${
        attempt > 1 ? ` (retry ${attempt - 1}/${RUN_RETRY_COUNT - 1})` : ''
      }`
    );
    const startedAt = performance.now();
    const proc = Bun.spawn(['bun', 'test', '--max-concurrency=1', testPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, PERF_STRICT: 'false' },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const combined = [stdout, stderr].filter(Boolean).join('\n');

    if (exitCode !== 0) {
      console.log(combined);
      const transientCrash =
        exitCode === 132 ||
        exitCode === 133 ||
        combined.includes('RuntimeError: Aborted(). Build with -sASSERTIONS');
      if (transientCrash && attempt < RUN_RETRY_COUNT) {
        console.log(
          `${testPath} run ${run} hit transient crash (exit ${exitCode}); retrying...`
        );
        continue;
      }
      throw new Error(`${testPath} run ${run} failed with exit code ${exitCode}`);
    }

    const runRegressionMarker = findGateMarker(combined, [
      'PERF_GATE_REGRESSION',
      'PERF_GATE_SYNC_REGRESSION',
    ]);
    const runMissingBaselineMarker = findGateMarker(combined, [
      'PERF_GATE_MISSING_BASELINE',
      'PERF_GATE_SYNC_MISSING_BASELINE',
    ]);
    if (runRegressionMarker || runMissingBaselineMarker) {
      console.log(
        `${testPath} run ${run} markers: regression=${
          runRegressionMarker ?? 'unknown'
        }, missingBaseline=${runMissingBaselineMarker ?? 'unknown'}`
      );
    }

    const parsedBenchmarks = parseBenchmarkTable(combined);
    if (parsedBenchmarks.length === 0) {
      throw new Error(
        `unable to parse benchmark medians for ${testPath} run ${run}`
      );
    }
    const medians = new Map(
      parsedBenchmarks.map((benchmark) => [benchmark.name, benchmark.median])
    );
    const units = new Map(
      parsedBenchmarks.map((benchmark) => [
        benchmark.name,
        benchmark.unit ?? 'ms',
      ])
    );

    const usage = proc.resourceUsage();
    const cpuUserMicros = usage ? Number(usage.cpuTime.user) : 0;
    const cpuSystemMicros = usage ? Number(usage.cpuTime.system) : 0;
    const cpuTotalMicros = usage ? Number(usage.cpuTime.total) : 0;
    const maxRssBytes = usage ? Number(usage.maxRSS) : 0;
    const contextSwitchesVoluntary = usage
      ? usage.contextSwitches.voluntary
      : 0;
    const contextSwitchesInvoluntary = usage
      ? usage.contextSwitches.involuntary
      : 0;
    return {
      medians,
      units,
      resourceUsage: {
        durationMs: performance.now() - startedAt,
        cpuUserMicros,
        cpuSystemMicros,
        cpuTotalMicros,
        maxRssBytes,
        contextSwitchesVoluntary,
        contextSwitchesInvoluntary,
      },
    };
  }

  throw new Error(`${testPath} run ${run} exhausted retries`);
}

async function runStablePerf(
  run: number,
  testPaths: string[]
): Promise<PerfRunResult> {
  const merged = new Map<string, number>();
  const units = new Map<string, BenchmarkResult['unit']>();
  const resources: PerfRunResourceUsage[] = [];

  for (const testPath of testPaths) {
    const result = await runPerfTestPath(run, testPath);
    for (const [metric, value] of result.medians) {
      if (merged.has(metric)) {
        throw new Error(`duplicate benchmark metric emitted: ${metric}`);
      }
      merged.set(metric, value);
      units.set(metric, result.units.get(metric) ?? 'ms');
    }
    resources.push(result.resourceUsage);
  }

  return {
    medians: merged,
    units,
    resourceUsage: {
      durationMs: resources.reduce((sum, usage) => sum + usage.durationMs, 0),
      cpuUserMicros: resources.reduce(
        (sum, usage) => sum + usage.cpuUserMicros,
        0
      ),
      cpuSystemMicros: resources.reduce(
        (sum, usage) => sum + usage.cpuSystemMicros,
        0
      ),
      cpuTotalMicros: resources.reduce(
        (sum, usage) => sum + usage.cpuTotalMicros,
        0
      ),
      maxRssBytes: Math.max(...resources.map((usage) => usage.maxRssBytes)),
      contextSwitchesVoluntary: resources.reduce(
        (sum, usage) => sum + usage.contextSwitchesVoluntary,
        0
      ),
      contextSwitchesInvoluntary: resources.reduce(
        (sum, usage) => sum + usage.contextSwitchesInvoluntary,
        0
      ),
    },
  };
}

function toBenchmarkResult(
  metric: string,
  values: number[],
  aggregatedMedian: number,
  unit: BenchmarkResult['unit']
): BenchmarkResult {
  return {
    name: metric,
    unit,
    iterations: values.length,
    mean: average(values),
    median: aggregatedMedian,
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    min: Math.min(...values),
    max: Math.max(...values),
    stdDev: stdDev(values),
  };
}

async function main() {
  const baseline = await loadBaseline(BASELINE_PATH);
  if (!baseline) {
    console.log('Unable to load tests/perf/baseline.json');
    console.log('PERF_GATE_REGRESSION=false');
    console.log('PERF_GATE_MISSING_BASELINE=true');
    console.log('PERF_GATE_SYNC_REGRESSION=false');
    console.log('PERF_GATE_SYNC_MISSING_BASELINE=true');
    process.exit(1);
  }

  const testPaths = selectedPerfTestPaths();
  const runResults: PerfRunResult[] = [];
  for (let run = 1; run <= RUN_COUNT; run++) {
    const result = await runStablePerf(run, testPaths);
    runResults.push(result);
  }
  const trackedMetrics = trackedMetricNames(baseline, runResults);

  const stableMetrics: StableMetricStats[] = trackedMetrics.map((metric) => {
    const values = runResults
      .map((run) => run.medians.get(metric))
      .filter((v) => v !== undefined);
    const numericValues = values.map((v) => v!);
    if (numericValues.length !== RUN_COUNT) {
      throw new Error(
        `metric "${metric}" missing in one or more runs (${numericValues.length}/${RUN_COUNT})`
      );
    }

    return {
      metric,
      suite: metricSuite(metric),
      unit:
        runResults.find((run) => run.units.has(metric))?.units.get(metric) ??
        baseline[metric]?.unit ??
        metricUnit(metric),
      baseline: baseline[metric]?.median ?? null,
      median: median(numericValues),
      min: Math.min(...numericValues),
      max: Math.max(...numericValues),
      runs: numericValues,
    };
  });

  const aggregatedResults: BenchmarkResult[] = stableMetrics.map((metric) =>
    toBenchmarkResult(metric.metric, metric.runs, metric.median, metric.unit)
  );

  const regressions = detectRegressions(aggregatedResults, baseline);
  const hasRegression = hasRegressions(regressions);
  const hasMissingBaseline = hasMissingBaselines(regressions);
  const resourceStats = {
    durationMs: summarizeResourceMetric(
      runResults.map((run) => run.resourceUsage.durationMs)
    ),
    cpuUserMicros: summarizeResourceMetric(
      runResults.map((run) => run.resourceUsage.cpuUserMicros)
    ),
    cpuSystemMicros: summarizeResourceMetric(
      runResults.map((run) => run.resourceUsage.cpuSystemMicros)
    ),
    cpuTotalMicros: summarizeResourceMetric(
      runResults.map((run) => run.resourceUsage.cpuTotalMicros)
    ),
    maxRssBytes: summarizeResourceMetric(
      runResults.map((run) => run.resourceUsage.maxRssBytes)
    ),
    contextSwitchesVoluntary: summarizeResourceMetric(
      runResults.map((run) => run.resourceUsage.contextSwitchesVoluntary)
    ),
    contextSwitchesInvoluntary: summarizeResourceMetric(
      runResults.map((run) => run.resourceUsage.contextSwitchesInvoluntary)
    ),
  };
  const commit =
    process.env.GITHUB_SHA ?? (await resolveGitCommitSha()) ?? null;
  const runEnvironment = {
    source: process.env.GITHUB_ACTIONS === 'true' ? 'ci' : 'local',
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    rustcVersion: await resolveToolVersion(['rustc', '--version']),
    cargoVersion: await resolveToolVersion(['cargo', '--version']),
    wasmPackVersion: await resolveToolVersion(['wasm-pack', '--version']),
    perfSuites: testPaths,
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerName: process.env.RUNNER_NAME ?? null,
  };
  const baselineCommits = Array.from(
    new Set(
      Object.values(baseline)
        .map((entry) => entry.commit)
        .filter((entry): entry is string => typeof entry === 'string')
    )
  );

  if (OUTPUT_JSON_PATH) {
    await Bun.write(
      OUTPUT_JSON_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          commit,
          runCount: RUN_COUNT,
          baselinePath: BASELINE_PATH,
          baselineCommits,
          runEnvironment,
          hasRegression,
          hasMissingBaseline,
          resources: resourceStats,
          metrics: stableMetrics.map((metric) => ({
            metric: metric.metric,
            suite: metric.suite,
            unit: metric.unit,
            baseline: metric.baseline,
            aggregatedMedian: metric.median,
            min: metric.min,
            max: metric.max,
            runs: metric.runs,
            changePercent:
              metric.baseline === null || metric.baseline === 0
                ? null
                : ((metric.median - metric.baseline) / metric.baseline) * 100,
          })),
        },
        null,
        2
      )
    );
  }

  console.log(`\n## Stable Performance (${RUN_COUNT} runs, median-of-medians)`);
  console.log(
    '| Suite | Benchmark | Baseline | Aggregated Median | Change | Run Min | Run Max |'
  );
  console.log(
    '|-------|-----------|----------|-------------------|--------|---------|---------|'
  );
  for (const metric of stableMetrics) {
    const baselineLabel =
      metric.baseline === null
        ? 'N/A'
        : formatMetricValue(metric.baseline, metric.unit);
    console.log(
      `| ${metric.suite} | ${metric.metric} | ${baselineLabel} | ${formatMetricValue(metric.median, metric.unit)} | ${formatChange(metric.median, metric.baseline)} | ${formatMetricValue(metric.min, metric.unit)} | ${formatMetricValue(metric.max, metric.unit)} |`
    );
  }

  console.log(`\n${formatRegressionReport(regressions)}`);
  console.log('\n## Stable Perf Environment');
  console.log(`- suites: ${testPaths.join(', ')}`);
  console.log(
    `- runtime: ${runEnvironment.source} / ${runEnvironment.platform} / ${runEnvironment.arch} / bun ${runEnvironment.bunVersion}`
  );
  if (runEnvironment.rustcVersion) {
    console.log(`- rustc: ${runEnvironment.rustcVersion}`);
  }
  if (runEnvironment.wasmPackVersion) {
    console.log(`- wasm-pack: ${runEnvironment.wasmPackVersion}`);
  }
  console.log('\n## Stable Perf Resources');
  console.log(
    `- duration per run (median): ${resourceStats.durationMs.median.toFixed(1)}ms`
  );
  console.log(
    `- cpu total per run (median): ${(resourceStats.cpuTotalMicros.median / 1000).toFixed(1)}ms`
  );
  console.log(
    `- max RSS per run (median): ${(resourceStats.maxRssBytes.median / (1024 * 1024)).toFixed(1)} MiB`
  );
  printGateMarkers(hasRegression, hasMissingBaseline);

  if (hasRegression || hasMissingBaseline) {
    process.exit(1);
  }
}

function shouldTrackMetric(metric: string): boolean {
  if (!OPTIONAL_METRIC_PREFIXES.some((prefix) => metric.startsWith(prefix))) {
    return true;
  }
  return Bun.env.PERF_RUST_BROWSER_BENCHMARK === 'true';
}

function findGateMarker(output: string, names: string[]): string | null {
  for (const line of output.split('\n')) {
    for (const name of names) {
      if (line.startsWith(`${name}=`)) {
        return line.split('=')[1] ?? null;
      }
    }
  }
  return null;
}

function printGateMarkers(
  hasRegression: boolean,
  hasMissingBaseline: boolean
): void {
  const regression = hasRegression ? 'true' : 'false';
  const missingBaseline = hasMissingBaseline ? 'true' : 'false';

  console.log(`PERF_GATE_REGRESSION=${regression}`);
  console.log(`PERF_GATE_MISSING_BASELINE=${missingBaseline}`);

  // Compatibility aliases for existing CI parsers and direct sync perf output.
  console.log(`PERF_GATE_SYNC_REGRESSION=${regression}`);
  console.log(`PERF_GATE_SYNC_MISSING_BASELINE=${missingBaseline}`);
}

function metricSuite(metric: string): string {
  if (metric.startsWith('rust_native_')) return 'rust-native';
  if (metric.startsWith('rust_e2e_')) return 'rust-e2e';
  if (metric.startsWith('rust_http_')) return 'rust-http';
  if (metric.startsWith('rust_ws_')) return 'rust-ws';
  if (metric.startsWith('rust_browser_')) return 'rust-browser';
  if (metric.startsWith('dialect_')) return 'dialect';
  return 'sync';
}

function metricUnit(metric: string): BenchmarkResult['unit'] {
  if (metric.startsWith('rust_browser_wasm_') && metric.endsWith('_kib')) {
    return 'KiB';
  }
  return 'ms';
}

function selectedPerfTestPaths(): string[] {
  return Bun.env.PERF_RUST_ONLY === 'true'
    ? RUST_PERF_TEST_PATHS
    : PERF_TEST_PATHS;
}

function shouldIncludeSuiteMetric(metric: string): boolean {
  if (Bun.env.PERF_RUST_ONLY !== 'true') return true;
  return RUST_METRIC_PREFIXES.some((prefix) => metric.startsWith(prefix));
}

function trackedMetricNames(
  baseline: NonNullable<Awaited<ReturnType<typeof loadBaseline>>>,
  runResults: PerfRunResult[]
): string[] {
  return Array.from(
    new Set([
      ...Object.keys(baseline),
      ...runResults.flatMap((run) => Array.from(run.medians.keys())),
    ])
  )
    .filter((metric) => !metric.startsWith('dialect_'))
    .filter((metric) => shouldIncludeSuiteMetric(metric))
    .filter((metric) => shouldTrackMetric(metric));
}

function summarizeResourceMetric(values: number[]): {
  min: number;
  median: number;
  max: number;
} {
  return {
    min: Math.min(...values),
    median: median(values),
    max: Math.max(...values),
  };
}

void main();
