/**
 * Reusable statistical functions for trend and change-point analysis.
 *
 * Shared between perf and load test trend-ci scripts.
 */

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export function mad(values: number[], center: number): number {
  if (values.length === 0) return 0;
  const deviations = values.map((value) => Math.abs(value - center));
  return median(deviations);
}

function relativeDelta(current: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return (current - baseline) / baseline;
}

export function formatMs(value: number | null): string {
  if (value == null) return 'N/A';
  return `${value.toFixed(1)}ms`;
}

export function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  const pct = value * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export function formatRobustZ(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return value.toFixed(2);
}

export function parseFloatOrDefault(
  raw: string | undefined,
  fallback: number
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

export function parseIntOrDefault(
  raw: string | undefined,
  fallback: number
): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Robust Z-score change-point detection.
 *
 * Given a current value, historical median, and MAD, compute a robust Z-score
 * using the consistency constant 1.4826. Returns the raw Z-score and flags
 * for regression/improvement change points based on the provided thresholds.
 */
export function detectChangePoint(
  current: number,
  historyMedian: number,
  historyMad: number,
  deltaThreshold: number,
  robustZThreshold: number
): {
  robustZ: number | null;
  deltaPercent: number | null;
  regressionChangePoint: boolean;
  improvementChangePoint: boolean;
} {
  const robustSigma = historyMad * 1.4826;
  const deltaPercent = relativeDelta(current, historyMedian);

  const rawRobustZ =
    robustSigma === 0
      ? current === historyMedian
        ? 0
        : Number.POSITIVE_INFINITY
      : (current - historyMedian) / robustSigma;

  const regressionByDelta =
    deltaPercent != null && deltaPercent >= deltaThreshold;
  const regressionByZ =
    robustSigma === 0
      ? regressionByDelta
      : Number.isFinite(rawRobustZ) && rawRobustZ >= robustZThreshold;

  const improvementByDelta =
    deltaPercent != null && deltaPercent <= -deltaThreshold;
  const improvementByZ =
    robustSigma === 0
      ? improvementByDelta
      : Number.isFinite(rawRobustZ) && rawRobustZ <= -robustZThreshold;

  return {
    robustZ: Number.isFinite(rawRobustZ) ? rawRobustZ : null,
    deltaPercent,
    regressionChangePoint: regressionByDelta && regressionByZ,
    improvementChangePoint: improvementByDelta && improvementByZ,
  };
}
