import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  type BenchmarkResult,
  formatBenchmarkTable,
} from './benchmark';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');

interface RustStressReport {
  options: {
    transport: 'http' | 'ws';
    writers: number;
    readers: number;
    batches: number;
    batchSize: number;
    totalRows: number;
  };
  checks: {
    totalRows: number;
    serverRows: number;
    readerRows: number[];
    writerOutboxCommits: number;
  };
  metrics: Array<
    BenchmarkResult & {
      rows?: number;
      outboxCommits?: number;
    }
  >;
}

describe('rust client stress', () => {
  it('sustains multi-client HTTP and WebSocket client-server-client sync', async () => {
    const transports = readStressTransports();
    for (const transport of transports) {
      await runStressTransport(transport);
    }
  }, 300_000);
});

async function runStressTransport(transport: 'http' | 'ws'): Promise<void> {
    const report = await runJsonCommand<RustStressReport>(
      [
        'cargo',
        'run',
        '--release',
        '--manifest-path',
        'rust/Cargo.toml',
        '-p',
        'syncular-client',
        '--bin',
        'syncular-rust-perf',
        '--',
        '--json',
        '--stress',
        `--stress-writers=${readPositiveIntEnv('PERF_RUST_STRESS_WRITERS', 4)}`,
        `--stress-readers=${readPositiveIntEnv('PERF_RUST_STRESS_READERS', 4)}`,
        `--stress-batches=${readPositiveIntEnv('PERF_RUST_STRESS_BATCHES', 12)}`,
        `--stress-batch-size=${readPositiveIntEnv('PERF_RUST_STRESS_BATCH_SIZE', 250)}`,
        `--stress-transport=${transport}`,
      ],
      'rust stress perf'
    );

    const results = report.metrics.map((metric) => ({
      name: metric.name,
      iterations: metric.iterations,
      mean: metric.mean,
      median: metric.median,
      p95: metric.p95,
      p99: metric.p99,
      min: metric.min,
      max: metric.max,
      stdDev: metric.stdDev,
    }));

    console.log(`\n## Rust Client Stress (${transport})`);
    console.log(
      `- writers: ${report.options.writers}, readers: ${report.options.readers}, batches: ${report.options.batches}, batch size: ${report.options.batchSize}`
    );
    console.log(
      `- rows: server ${report.checks.serverRows}, readers ${report.checks.readerRows.join(', ')}`
    );
    console.log(
      `- throughput: ${formatRowsPerSecond(report.options.totalRows, results.find((result) => result.name.includes('_e2e_'))?.median ?? 0)}`
    );
    console.log(`\n${formatBenchmarkTable(results)}`);

    expect(report.checks.serverRows).toBe(report.checks.totalRows);
    expect(report.checks.readerRows).toHaveLength(report.options.readers);
    for (const rows of report.checks.readerRows) {
      expect(rows).toBe(report.checks.totalRows);
    }
    expect(report.metrics.length).toBeGreaterThanOrEqual(3);
}

async function runJsonCommand<T>(cmd: string[], label: string): Promise<T> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${exitCode}\n${stdout}\n${stderr}`
    );
  }

  const output = stdout.trim();
  const jsonStart = output.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(`${label} did not emit JSON`);
  }
  return JSON.parse(output.slice(jsonStart)) as T;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readStressTransports(): Array<'http' | 'ws'> {
  const raw = Bun.env.PERF_RUST_STRESS_TRANSPORT;
  if (raw === 'http' || raw === 'ws') return [raw];
  return ['http', 'ws'];
}

function formatRowsPerSecond(rows: number, ms: number): string {
  if (ms <= 0) return 'N/A';
  return `${((rows / ms) * 1000).toFixed(1)} rows/s`;
}
