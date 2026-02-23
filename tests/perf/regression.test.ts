import { describe, expect, it } from 'bun:test';
import type { BenchmarkResult } from './benchmark';
import {
  detectRegressions,
  formatRegressionReport,
  hasMissingBaselines,
} from './regression';

function makeResult(name: string, median: number): BenchmarkResult {
  return {
    name,
    iterations: 1,
    mean: median,
    median,
    p95: median,
    p99: median,
    min: median,
    max: median,
    stdDev: 0,
  };
}

describe('detectRegressions', () => {
  it('handles zero baseline without NaN/Infinity crashes', () => {
    const results = [makeResult('metric_zero', 0), makeResult('metric_up', 5)];
    const baseline = {
      metric_zero: { median: 0, p95: 0, p99: 0, timestamp: '2025-01-01' },
      metric_up: { median: 0, p95: 0, p99: 0, timestamp: '2025-01-01' },
    };

    const regressions = detectRegressions(results, baseline);

    expect(regressions[0]?.change).toBe(0);
    expect(regressions[0]?.regression).toBe(false);
    expect(regressions[1]?.change).toBe(Number.POSITIVE_INFINITY);
    expect(regressions[1]?.regression).toBe(true);
  });

  it('renders infinity changes in report output', () => {
    const results = [makeResult('metric_up', 5)];
    const baseline = {
      metric_up: { median: 0, p95: 0, p99: 0, timestamp: '2025-01-01' },
    };

    const regressions = detectRegressions(results, baseline);
    const report = formatRegressionReport(regressions);

    expect(report.includes('+∞%')).toBe(true);
  });

  it('marks missing baseline metrics explicitly', () => {
    const results = [makeResult('new_metric', 12)];
    const baseline = {
      known_metric: { median: 10, p95: 15, p99: 20, timestamp: '2025-01-01' },
    };

    const regressions = detectRegressions(results, baseline);
    const report = formatRegressionReport(regressions);

    expect(regressions[0]?.baselineMissing).toBe(true);
    expect(hasMissingBaselines(regressions)).toBe(true);
    expect(report.includes('Missing Performance Baseline')).toBe(true);
    expect(report.includes('N/A')).toBe(true);
  });
});
