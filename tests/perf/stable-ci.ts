/**
 * Stable CI performance runner.
 *
 * Executes sync perf tests multiple times, aggregates medians per metric,
 * and performs regression detection against baseline.json using median-of-medians.
 */

import path from 'node:path';
import type { BenchmarkResult } from './benchmark';
import {
  detectRegressions,
  formatRegressionReport,
  hasMissingBaselines,
  hasRegressions,
  loadBaseline,
} from './regression';

const RUN_COUNT = parseRunCount(Bun.env.PERF_STABLE_RUNS);
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');
const BASELINE_PATH = path.join(import.meta.dir, 'baseline.json');
const SYNC_TEST_PATH = 'tests/perf/sync.perf.test.ts';
const OUTPUT_JSON_PATH = Bun.env.PERF_STABLE_OUTPUT_JSON;

interface StableMetricStats {
  metric: string;
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

function formatMilliseconds(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function formatChange(current: number, baseline: number | null): string {
  if (baseline === null) return 'N/A';
  if (baseline === 0) return current === 0 ? '0.0%' : '+∞%';
  const delta = ((current - baseline) / baseline) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

function parseBenchmarkMedians(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const lines = output.split('\n');
  let inBenchmarkTable = false;

  for (const line of lines) {
    if (line.includes('| Benchmark |')) {
      inBenchmarkTable = true;
      continue;
    }

    if (!inBenchmarkTable) continue;

    if (!line.startsWith('|')) {
      inBenchmarkTable = false;
      continue;
    }

    const match = /^\|\s([a-z0-9_:-]+)\s\|\s([0-9.]+)ms\s\|/i.exec(line);
    if (!match) continue;

    const metric = match[1]!;
    const metricMedian = Number(match[2]!);
    if (!Number.isNaN(metricMedian)) {
      metrics.set(metric, metricMedian);
    }
  }

  return metrics;
}

async function runSyncPerf(run: number): Promise<PerfRunResult> {
  console.log(`\n### Stable Perf Run ${run}/${RUN_COUNT}`);
  const startedAt = performance.now();
  const proc = Bun.spawn(['bun', 'test', SYNC_TEST_PATH], {
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
    throw new Error(`sync perf run ${run} failed with exit code ${exitCode}`);
  }

  const runRegressionMarker = combined
    .split('\n')
    .find((line) => line.startsWith('PERF_GATE_SYNC_REGRESSION='));
  const runMissingBaselineMarker = combined
    .split('\n')
    .find((line) => line.startsWith('PERF_GATE_SYNC_MISSING_BASELINE='));
  if (runRegressionMarker || runMissingBaselineMarker) {
    console.log(
      `sync.perf run ${run} markers: regression=${
        runRegressionMarker?.split('=')[1] ?? 'unknown'
      }, missingBaseline=${runMissingBaselineMarker?.split('=')[1] ?? 'unknown'}`
    );
  }

  const medians = parseBenchmarkMedians(combined);
  if (medians.size === 0) {
    throw new Error(`unable to parse benchmark medians for run ${run}`);
  }

  const usage = proc.resourceUsage();
  const cpuUserMicros = usage ? Number(usage.cpuTime.user) : 0;
  const cpuSystemMicros = usage ? Number(usage.cpuTime.system) : 0;
  const cpuTotalMicros = usage ? Number(usage.cpuTime.total) : 0;
  const maxRssBytes = usage ? Number(usage.maxRSS) : 0;
  const contextSwitchesVoluntary = usage ? usage.contextSwitches.voluntary : 0;
  const contextSwitchesInvoluntary = usage
    ? usage.contextSwitches.involuntary
    : 0;
  return {
    medians,
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

function toBenchmarkResult(
  metric: string,
  values: number[],
  aggregatedMedian: number
): BenchmarkResult {
  return {
    name: metric,
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
    console.log('PERF_GATE_SYNC_REGRESSION=false');
    console.log('PERF_GATE_SYNC_MISSING_BASELINE=true');
    process.exit(1);
  }

  const trackedMetrics = Object.keys(baseline).filter(
    (metric) => !metric.startsWith('dialect_')
  );

  const runResults: PerfRunResult[] = [];
  for (let run = 1; run <= RUN_COUNT; run++) {
    const result = await runSyncPerf(run);
    runResults.push(result);
  }

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
      baseline: baseline[metric]?.median ?? null,
      median: median(numericValues),
      min: Math.min(...numericValues),
      max: Math.max(...numericValues),
      runs: numericValues,
    };
  });

  const aggregatedResults: BenchmarkResult[] = stableMetrics.map((metric) =>
    toBenchmarkResult(metric.metric, metric.runs, metric.median)
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
    '| Benchmark | Baseline | Aggregated Median | Change | Run Min | Run Max |'
  );
  console.log(
    '|-----------|----------|-------------------|--------|---------|---------|'
  );
  for (const metric of stableMetrics) {
    const baselineLabel =
      metric.baseline === null ? 'N/A' : formatMilliseconds(metric.baseline);
    console.log(
      `| ${metric.metric} | ${baselineLabel} | ${formatMilliseconds(metric.median)} | ${formatChange(metric.median, metric.baseline)} | ${formatMilliseconds(metric.min)} | ${formatMilliseconds(metric.max)} |`
    );
  }

  console.log(`\n${formatRegressionReport(regressions)}`);
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
  console.log(`PERF_GATE_SYNC_REGRESSION=${hasRegression ? 'true' : 'false'}`);
  console.log(
    `PERF_GATE_SYNC_MISSING_BASELINE=${hasMissingBaseline ? 'true' : 'false'}`
  );

  if (hasRegression || hasMissingBaseline) {
    process.exit(1);
  }
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
