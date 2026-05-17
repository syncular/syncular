/**
 * Benchmark utilities for performance testing
 *
 * Provides a simple, dependency-free benchmarking framework with
 * warmup runs, statistical analysis, and memory tracking.
 */

export interface BenchmarkResult {
  name: string;
  iterations: number;
  unit?: 'ms' | 'KiB' | 'count';
  mean: number;
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  stdDev: number;
  memoryDelta?: number; // bytes
}

interface BenchmarkOptions {
  /** Number of measured iterations (default: 10) */
  iterations?: number;
  /** Number of warmup iterations (default: 2) */
  warmup?: number;
  /** Whether to track memory usage (default: true) */
  trackMemory?: boolean;
}

/**
 * Run a benchmark and collect statistics
 */
export async function benchmark(
  name: string,
  fn: () => Promise<void>,
  options: BenchmarkOptions = {}
): Promise<BenchmarkResult> {
  const { iterations = 10, warmup = 2, trackMemory = true } = options;

  // Warmup runs (not measured)
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  // Force GC if available
  if (trackMemory && typeof globalThis.gc === 'function') {
    globalThis.gc();
  }

  // Measured runs
  const times: number[] = [];
  const memBefore = trackMemory ? process.memoryUsage().heapUsed : 0;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }

  const memAfter = trackMemory ? process.memoryUsage().heapUsed : 0;
  times.sort((a, b) => a - b);

  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const variance =
    times.reduce((sum, t) => sum + (t - mean) ** 2, 0) / times.length;
  const stdDev = Math.sqrt(variance);

  return {
    name,
    iterations,
    mean,
    median: times[Math.floor(times.length / 2)]!,
    p95: times[Math.floor(times.length * 0.95)]!,
    p99: times[Math.floor(times.length * 0.99)]!,
    min: times[0]!,
    max: times[times.length - 1]!,
    stdDev,
    memoryDelta: trackMemory ? memAfter - memBefore : undefined,
  };
}

/**
 * Format multiple benchmark results as a table
 */
export function formatBenchmarkTable(results: BenchmarkResult[]): string {
  const header =
    '| Benchmark | Median | P95 | P99 | Min | Max | StdDev | Memory |';
  const separator =
    '|-----------|--------|-----|-----|-----|-----|--------|--------|';

  const rows = results.map((r) => {
    const mem = r.memoryDelta
      ? `${(r.memoryDelta / 1024 / 1024).toFixed(1)}MB`
      : '-';
    return `| ${r.name} | ${formatBenchmarkValue(r.median, r.unit)} | ${formatBenchmarkValue(r.p95, r.unit)} | ${formatBenchmarkValue(r.p99, r.unit)} | ${formatBenchmarkValue(r.min, r.unit)} | ${formatBenchmarkValue(r.max, r.unit)} | ${formatBenchmarkValue(r.stdDev, r.unit)} | ${mem} |`;
  });

  return [header, separator, ...rows].join('\n');
}

export function parseBenchmarkTable(output: string): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];
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

    const match =
      /^\|\s([a-z0-9_:-]+)\s\|\s([0-9.]+)(ms|KiB|count)\s\|\s([0-9.]+)(?:ms|KiB|count)\s\|\s([0-9.]+)(?:ms|KiB|count)\s\|\s([0-9.]+)(?:ms|KiB|count)\s\|\s([0-9.]+)(?:ms|KiB|count)\s\|\s([0-9.]+)(?:ms|KiB|count)\s\|/i.exec(
        line
      );
    if (!match) continue;

    results.push({
      name: match[1]!,
      unit: match[3] as BenchmarkResult['unit'],
      iterations: 1,
      median: Number(match[2]!),
      p95: Number(match[4]!),
      p99: Number(match[5]!),
      min: Number(match[6]!),
      max: Number(match[7]!),
      stdDev: Number(match[8]!),
      mean: Number(match[2]!),
    });
  }

  return results;
}

function formatBenchmarkValue(
  value: number,
  unit: BenchmarkResult['unit'] = 'ms'
): string {
  return `${value.toFixed(1)}${unit}`;
}

/**
 * Performance thresholds for regression detection
 */
interface PerformanceThresholds {
  bootstrap_1k: number; // ms
  bootstrap_10k: number; // ms
  bootstrap_100k: number; // ms
  rebootstrap_after_prune_p99: number; // ms
  maintenance_prune_p99: number; // ms
  incremental_pull_p99: number; // ms
  reconnect_catchup_p99: number; // ms
  reconnect_storm_p99: number; // ms
  pglite_push_contention_p99: number; // ms
  transport_direct_catchup_p99: number; // ms
  transport_relay_catchup_p99: number; // ms
  transport_ws_catchup_p99: number; // ms
  push_single_row: number; // ms
  push_batch_100: number; // ms
  conflict_resolution: number; // ms
}

/**
 * Default performance thresholds
 */
export const defaultThresholds: PerformanceThresholds = {
  bootstrap_1k: 500,
  bootstrap_10k: 3000,
  bootstrap_100k: 25000,
  rebootstrap_after_prune_p99: 2000,
  maintenance_prune_p99: 1500,
  incremental_pull_p99: 50,
  reconnect_catchup_p99: 1500,
  reconnect_storm_p99: 2000,
  pglite_push_contention_p99: 12000,
  transport_direct_catchup_p99: 2000,
  transport_relay_catchup_p99: 2500,
  transport_ws_catchup_p99: 2500,
  push_single_row: 100,
  push_batch_100: 500,
  conflict_resolution: 200,
};
