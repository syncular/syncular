/**
 * Performance regression detection
 *
 * Compares current benchmark results against stored baselines
 * to detect performance regressions.
 */

import type { BenchmarkResult } from './benchmark';

/** Baseline data stored in baseline.json */
export interface Baseline {
  [metricName: string]: {
    median: number;
    p95: number;
    p99: number;
    timestamp: string;
    commit?: string;
    source?: 'local' | 'ci';
    environment?: {
      platform: string;
      arch: string;
      bunVersion: string;
      runnerOs?: string;
      runnerName?: string;
    };
  };
}

interface RegressionResult {
  metric: string;
  baseline: number;
  current: number;
  change: number; // percentage (positive = slower)
  baselineMissing: boolean;
  regression: boolean;
  improvement: boolean;
}

/**
 * Regression threshold (20% slower = regression)
 */
const REGRESSION_THRESHOLD = 0.2;

/**
 * Per-metric overrides for known noisy benchmarks.
 */
const REGRESSION_THRESHOLD_OVERRIDES: Record<string, number> = {
  reconnect_storm: 0.25,
  pglite_push_contention: 0.6,
  transport_direct_catchup: 0.5,
  transport_relay_catchup: 0.5,
  transport_ws_catchup: 0.5,
};

/**
 * Improvement threshold (10% faster = improvement)
 */
const IMPROVEMENT_THRESHOLD = -0.1;

function getRegressionThreshold(metric: string): number {
  return REGRESSION_THRESHOLD_OVERRIDES[metric] ?? REGRESSION_THRESHOLD;
}

function calculateRelativeChange(current: number, baseline: number): number {
  if (baseline === 0) {
    if (current === 0) return 0;
    return current > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return (current - baseline) / baseline;
}

function formatChange(change: number): string {
  if (!Number.isFinite(change)) {
    return change > 0 ? '+∞%' : '-∞%';
  }
  const pct = (change * 100).toFixed(1);
  const sign = change >= 0 ? '+' : '';
  return `${sign}${pct}%`;
}

/**
 * Load baseline from file
 */
export async function loadBaseline(path: string): Promise<Baseline | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.json();
  } catch {
    return null;
  }
}

/**
 * Detect regressions by comparing results to baseline
 */
export function detectRegressions(
  results: BenchmarkResult[],
  baseline: Baseline | null
): RegressionResult[] {
  return results.map((r) => {
    const baselineMetric = baseline?.[r.name];
    const baselineMissing = !baselineMetric;
    const base = baselineMetric?.median ?? r.median;
    const change = calculateRelativeChange(r.median, base);
    const regressionThreshold = getRegressionThreshold(r.name);

    return {
      metric: r.name,
      baseline: base,
      current: r.median,
      change,
      baselineMissing,
      regression: !baselineMissing && change > regressionThreshold,
      improvement: !baselineMissing && change < IMPROVEMENT_THRESHOLD,
    };
  });
}

/**
 * Format regression report as markdown
 */
export function formatRegressionReport(
  regressions: RegressionResult[]
): string {
  const hasRegression = regressions.some((r) => r.regression);
  const hasImprovement = regressions.some((r) => r.improvement);
  const hasMissingBaseline = regressions.some((r) => r.baselineMissing);

  let header: string;
  if (hasRegression) {
    header = '⚠️ Performance Regression Detected';
  } else if (hasMissingBaseline) {
    header = '⚠️ Missing Performance Baseline';
  } else if (hasImprovement) {
    header = '🚀 Performance Improvement Detected';
  } else {
    header = '✅ No Performance Regressions';
  }

  const rows = regressions.map((r) => {
    let emoji: string;
    if (r.baselineMissing) {
      emoji = '🟡';
    } else if (r.regression) {
      emoji = '🔴';
    } else if (r.improvement) {
      emoji = '🟢';
    } else {
      emoji = '⚪';
    }

    const baselineLabel = r.baselineMissing
      ? 'N/A'
      : `${r.baseline.toFixed(1)}ms`;
    const changeLabel = r.baselineMissing ? 'N/A' : formatChange(r.change);
    return `| ${emoji} ${r.metric} | ${baselineLabel} | ${r.current.toFixed(1)}ms | ${changeLabel} |`;
  });

  return `## ${header}

| Metric | Baseline | Current | Change |
|--------|----------|---------|--------|
${rows.join('\n')}`;
}

/**
 * Check if any regressions were detected
 */
export function hasRegressions(regressions: RegressionResult[]): boolean {
  return regressions.some((r) => r.regression);
}

/**
 * Check if the current run includes metrics with no baseline values.
 */
export function hasMissingBaselines(regressions: RegressionResult[]): boolean {
  return regressions.some((r) => r.baselineMissing);
}
