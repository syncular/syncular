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
  };
}

interface RegressionResult {
  metric: string;
  baseline: number;
  current: number;
  change: number; // percentage (positive = slower)
  regression: boolean;
  improvement: boolean;
}

/**
 * Regression threshold (20% slower = regression)
 */
const REGRESSION_THRESHOLD = 0.2;

/**
 * Improvement threshold (10% faster = improvement)
 */
const IMPROVEMENT_THRESHOLD = -0.1;

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
    const base = baseline?.[r.name]?.median ?? r.median;
    const change = calculateRelativeChange(r.median, base);

    return {
      metric: r.name,
      baseline: base,
      current: r.median,
      change,
      regression: change > REGRESSION_THRESHOLD,
      improvement: change < IMPROVEMENT_THRESHOLD,
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

  let header: string;
  if (hasRegression) {
    header = '⚠️ Performance Regression Detected';
  } else if (hasImprovement) {
    header = '🚀 Performance Improvement Detected';
  } else {
    header = '✅ No Performance Regressions';
  }

  const rows = regressions.map((r) => {
    let emoji: string;
    if (r.regression) {
      emoji = '🔴';
    } else if (r.improvement) {
      emoji = '🟢';
    } else {
      emoji = '⚪';
    }

    return `| ${emoji} ${r.metric} | ${r.baseline.toFixed(1)}ms | ${r.current.toFixed(1)}ms | ${formatChange(r.change)} |`;
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
