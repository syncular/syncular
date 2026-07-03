/**
 * Client-side latency histograms and simple counters — no external metrics
 * stack (load brief §3). A Histogram keeps every sample (rounds are cheap;
 * even a minutes-long soak at hundreds of ops/s stays in the low millions,
 * comfortably in memory) and computes p50/p95/p99 by sort. Machine-readable
 * summaries feed the JSON result; `describe()` renders the human line.
 */

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

export interface HistogramSummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export class Histogram {
  readonly #samples: number[] = [];

  add(valueMs: number): void {
    this.#samples.push(valueMs);
  }

  get count(): number {
    return this.#samples.length;
  }

  summary(): HistogramSummary {
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const count = sorted.length;
    if (count === 0) {
      return {
        count: 0,
        min: Number.NaN,
        max: Number.NaN,
        mean: Number.NaN,
        p50: Number.NaN,
        p95: Number.NaN,
        p99: Number.NaN,
      };
    }
    let sum = 0;
    for (const value of sorted) sum += value;
    return {
      count,
      min: sorted[0] as number,
      max: sorted[count - 1] as number,
      mean: sum / count,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  }
}

export function fmtMs(value: number | null): string {
  // JSON round-trips NaN as null, so guard both (empty server-side series).
  return value === null || Number.isNaN(value) ? '—' : `${value.toFixed(1)}ms`;
}

export function fmtMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

/** A named latency series in the machine-readable result. */
export interface LatencySeries extends HistogramSummary {
  readonly name: string;
}

export function seriesOf(name: string, histogram: Histogram): LatencySeries {
  return { name, ...histogram.summary() };
}
