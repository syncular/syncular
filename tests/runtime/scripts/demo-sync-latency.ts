/**
 * Measure end-to-end split-screen sync latency on the deployed demo.
 *
 * Flow per trial:
 * 1) Insert task on left client
 * 2) Wait until task is visible on both clients (count >= 2)
 * 3) Record elapsed time
 *
 * Usage:
 *   bun --cwd tests/runtime run scripts/demo-sync-latency.ts
 *
 * Optional env vars:
 *   DEMO_URL=https://demo.syncular.dev
 *   TRIALS=5
 *   READY_TIMEOUT_MS=30000
 *   WAIT_TIMEOUT_MS=20000
 *   POLL_INTERVAL_MS=100
 *   HEADLESS=true
 */

import { chromium, type Page } from '@playwright/test';

type LatencySample = {
  trial: number;
  title: string;
  ms: number | null;
  timedOut: boolean;
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  return fallback;
}

async function waitUntilReady(
  page: Page,
  readyTimeoutMs: number
): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelectorAll('input[placeholder="Add a task..."]').length >=
      2,
    { timeout: readyTimeoutMs }
  );
}

async function measureTrial(args: {
  page: Page;
  trial: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<LatencySample> {
  const { page, trial, waitTimeoutMs, pollIntervalMs } = args;
  const title = `lat-${Date.now()}-${trial}`;

  const input = page.getByPlaceholder('Add a task...').first();
  const startedAt = Date.now();
  await input.fill(title);
  await input.press('Enter');

  const deadline = startedAt + waitTimeoutMs;
  while (Date.now() < deadline) {
    const count = await page.getByText(title, { exact: true }).count();
    if (count >= 2) {
      return {
        trial,
        title,
        ms: Date.now() - startedAt,
        timedOut: false,
      };
    }
    await page.waitForTimeout(pollIntervalMs);
  }

  return {
    trial,
    title,
    ms: null,
    timedOut: true,
  };
}

function formatMs(value: number | null): string {
  if (value == null) return 'timeout';
  return `${value}ms`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index]!;
}

function summarize(samples: LatencySample[]): void {
  const ok = samples.filter((s) => s.ms != null).map((s) => s.ms as number);
  const timeouts = samples.filter((s) => s.timedOut).length;

  console.log('\nSplit-Screen Latency Samples');
  for (const sample of samples) {
    console.log(
      `- trial ${sample.trial}: ${formatMs(sample.ms)} (${sample.title})`
    );
  }

  if (ok.length === 0) {
    console.log('\nNo successful samples.');
    return;
  }

  const avg = Math.round(ok.reduce((sum, value) => sum + value, 0) / ok.length);
  const min = Math.min(...ok);
  const max = Math.max(...ok);
  const p50 = percentile(ok, 50);
  const p95 = percentile(ok, 95);

  console.log('\nSummary');
  console.log(`- samples: ${samples.length}`);
  console.log(`- successful: ${ok.length}`);
  console.log(`- timeouts: ${timeouts}`);
  console.log(`- min: ${min}ms`);
  console.log(`- p50: ${p50}ms`);
  console.log(`- p95: ${p95}ms`);
  console.log(`- max: ${max}ms`);
  console.log(`- avg: ${avg}ms`);
}

async function main(): Promise<void> {
  const demoUrl = process.env.DEMO_URL ?? 'https://demo.syncular.dev';
  const trials = readIntEnv('TRIALS', 3);
  const readyTimeoutMs = readIntEnv('READY_TIMEOUT_MS', 30_000);
  const waitTimeoutMs = readIntEnv('WAIT_TIMEOUT_MS', 20_000);
  const pollIntervalMs = readIntEnv('POLL_INTERVAL_MS', 100);
  const headless = readBoolEnv('HEADLESS', true);

  console.log('Config');
  console.log(`- url: ${demoUrl}`);
  console.log(`- trials: ${trials}`);
  console.log(`- readyTimeoutMs: ${readyTimeoutMs}`);
  console.log(`- waitTimeoutMs: ${waitTimeoutMs}`);
  console.log(`- pollIntervalMs: ${pollIntervalMs}`);
  console.log(`- headless: ${headless}`);

  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  try {
    await page.goto(demoUrl, { waitUntil: 'domcontentloaded' });
    await waitUntilReady(page, readyTimeoutMs);

    // Let initial bootstrapping settle before measuring.
    await page.waitForTimeout(2_000);

    const samples: LatencySample[] = [];
    for (let trial = 1; trial <= trials; trial++) {
      const sample = await measureTrial({
        page,
        trial,
        waitTimeoutMs,
        pollIntervalMs,
      });
      samples.push(sample);

      console.log(`trial ${trial}: ${formatMs(sample.ms)}`);
      await page.waitForTimeout(500);
    }

    summarize(samples);

    const hasTimeout = samples.some((s) => s.timedOut);
    if (hasTimeout) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

await main();
