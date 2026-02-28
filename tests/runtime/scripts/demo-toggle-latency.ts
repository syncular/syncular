/**
 * Measure split-screen toggle latency on the demo page.
 *
 * Per trial:
 * 1) Insert a unique task on the left pane.
 * 2) Wait until it appears on both panes.
 * 3) Toggle completion on the left pane.
 * 4) Measure:
 *    - samePaneMs: click -> left pane reflects toggled state
 *    - mirrorPaneMs: click -> right pane reflects toggled state
 *
 * Usage:
 *   bun --cwd tests/runtime run scripts/demo-toggle-latency.ts
 *
 * Optional env vars:
 *   DEMO_URL=https://demo.syncular.dev
 *   TRIALS=5
 *   READY_TIMEOUT_MS=30000
 *   VISIBILITY_TIMEOUT_MS=20000
 *   TOGGLE_TIMEOUT_MS=30000
 *   POLL_INTERVAL_MS=16
 *   HEADLESS=true
 *   LOCAL_P95_BUDGET_MS=120
 *   MIRROR_P95_BUDGET_MS=3000
 */

import { chromium, type Page } from '@playwright/test';

type ToggleSample = {
  trial: number;
  title: string;
  samePaneMs: number | null;
  mirrorPaneMs: number | null;
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

async function waitUntilVisibleOnBothPanes(args: {
  page: Page;
  title: string;
  visibilityTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<boolean> {
  const { page, title, visibilityTimeoutMs, pollIntervalMs } = args;
  const deadline = Date.now() + visibilityTimeoutMs;
  while (Date.now() < deadline) {
    const count = await page.getByText(title, { exact: true }).count();
    if (count >= 2) return true;
    await page.waitForTimeout(pollIntervalMs);
  }
  return false;
}

async function measureToggle(args: {
  page: Page;
  title: string;
  toggleTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<{ samePaneMs: number | null; mirrorPaneMs: number | null }> {
  const { page, title, toggleTimeoutMs, pollIntervalMs } = args;

  return await page.evaluate(
    async ({
      titleText,
      timeoutMs,
      pollMs,
    }: {
      titleText: string;
      timeoutMs: number;
      pollMs: number;
    }) => {
      function findPanelRoot(panelTitle: string): HTMLElement | null {
        const headerSpans = Array.from(
          document.querySelectorAll('span')
        ).filter((span) => span.textContent?.trim() === panelTitle);
        for (const span of headerSpans) {
          let current = span.parentElement;
          while (current) {
            const cls =
              typeof current.className === 'string' ? current.className : '';
            if (cls.includes('rounded-[10px]') && cls.includes('bg-panel')) {
              return current;
            }
            current = current.parentElement;
          }
        }
        return null;
      }

      function findToggleButton(
        panelRoot: HTMLElement | null,
        taskTitle: string
      ): HTMLButtonElement | null {
        if (!panelRoot) return null;
        const rows = Array.from(panelRoot.querySelectorAll('div')).filter(
          (el) => {
            const cls = typeof el.className === 'string' ? el.className : '';
            return (
              cls.includes('group flex items-center') &&
              (el.textContent ?? '').includes(taskTitle)
            );
          }
        );
        const row = rows[0];
        if (!row) return null;
        const button = row.querySelector('button');
        return button instanceof HTMLButtonElement ? button : null;
      }

      const leftPanelTitle = 'Client A · wa-sqlite';
      const rightPanelTitle = 'Client B · PGlite';
      const leftPanelRoot = findPanelRoot(leftPanelTitle);
      const rightPanelRoot = findPanelRoot(rightPanelTitle);
      if (!leftPanelRoot || !rightPanelRoot) {
        return { samePaneMs: null, mirrorPaneMs: null };
      }

      const leftButtonInitial = findToggleButton(leftPanelRoot, titleText);
      const rightButtonInitial = findToggleButton(rightPanelRoot, titleText);
      if (!leftButtonInitial || !rightButtonInitial) {
        return { samePaneMs: null, mirrorPaneMs: null };
      }

      const leftCheckedInitial =
        leftButtonInitial.className.includes('bg-healthy');
      const rightCheckedInitial =
        rightButtonInitial.className.includes('bg-healthy');

      const startedAt = performance.now();
      leftButtonInitial.click();
      const deadline = startedAt + timeoutMs;

      let samePaneMs: number | null = null;
      let mirrorPaneMs: number | null = null;

      while (performance.now() < deadline) {
        const leftButton = findToggleButton(leftPanelRoot, titleText);
        const rightButton = findToggleButton(rightPanelRoot, titleText);
        if (leftButton && rightButton) {
          const leftCheckedNow = leftButton.className.includes('bg-healthy');
          const rightCheckedNow = rightButton.className.includes('bg-healthy');
          const elapsed = performance.now() - startedAt;

          if (samePaneMs === null && leftCheckedNow !== leftCheckedInitial) {
            samePaneMs = elapsed;
          }
          if (
            mirrorPaneMs === null &&
            rightCheckedNow !== rightCheckedInitial
          ) {
            mirrorPaneMs = elapsed;
          }
          if (samePaneMs !== null && mirrorPaneMs !== null) {
            break;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      return { samePaneMs, mirrorPaneMs };
    },
    {
      titleText: title,
      timeoutMs: toggleTimeoutMs,
      pollMs: pollIntervalMs,
    }
  );
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

function formatMs(value: number | null): string {
  if (value == null) return 'timeout';
  return `${Math.round(value)}ms`;
}

function summarize(samples: ToggleSample[]): {
  localP95: number | null;
  mirrorP95: number | null;
} {
  const localValues = samples
    .map((sample) => sample.samePaneMs)
    .filter((value): value is number => value != null);
  const mirrorValues = samples
    .map((sample) => sample.mirrorPaneMs)
    .filter((value): value is number => value != null);

  console.log('\nSplit-Screen Toggle Latency Samples');
  for (const sample of samples) {
    console.log(
      `- trial ${sample.trial}: same=${formatMs(sample.samePaneMs)} mirror=${formatMs(sample.mirrorPaneMs)} (${sample.title})`
    );
  }

  const timeoutCount = samples.filter((sample) => sample.timedOut).length;
  const localP95 = localValues.length > 0 ? percentile(localValues, 95) : null;
  const mirrorP95 =
    mirrorValues.length > 0 ? percentile(mirrorValues, 95) : null;

  console.log('\nSummary');
  console.log(`- samples: ${samples.length}`);
  console.log(`- timeouts: ${timeoutCount}`);
  if (localValues.length > 0) {
    const avg = Math.round(
      localValues.reduce((sum, value) => sum + value, 0) / localValues.length
    );
    console.log(`- same-pane min: ${Math.round(Math.min(...localValues))}ms`);
    console.log(
      `- same-pane p50: ${Math.round(percentile(localValues, 50))}ms`
    );
    console.log(`- same-pane p95: ${Math.round(localP95!)}ms`);
    console.log(`- same-pane max: ${Math.round(Math.max(...localValues))}ms`);
    console.log(`- same-pane avg: ${avg}ms`);
  } else {
    console.log('- same-pane: no successful samples');
  }

  if (mirrorValues.length > 0) {
    const avg = Math.round(
      mirrorValues.reduce((sum, value) => sum + value, 0) / mirrorValues.length
    );
    console.log(
      `- mirror-pane min: ${Math.round(Math.min(...mirrorValues))}ms`
    );
    console.log(
      `- mirror-pane p50: ${Math.round(percentile(mirrorValues, 50))}ms`
    );
    console.log(`- mirror-pane p95: ${Math.round(mirrorP95!)}ms`);
    console.log(
      `- mirror-pane max: ${Math.round(Math.max(...mirrorValues))}ms`
    );
    console.log(`- mirror-pane avg: ${avg}ms`);
  } else {
    console.log('- mirror-pane: no successful samples');
  }

  return { localP95, mirrorP95 };
}

async function runTrial(args: {
  page: Page;
  trial: number;
  visibilityTimeoutMs: number;
  toggleTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<ToggleSample> {
  const { page, trial, visibilityTimeoutMs, toggleTimeoutMs, pollIntervalMs } =
    args;
  const title = `toggle-lat-${Date.now()}-${trial}`;

  const input = page.getByPlaceholder('Add a task...').first();
  await input.fill(title);
  await input.press('Enter');

  const visible = await waitUntilVisibleOnBothPanes({
    page,
    title,
    visibilityTimeoutMs,
    pollIntervalMs,
  });
  if (!visible) {
    return {
      trial,
      title,
      samePaneMs: null,
      mirrorPaneMs: null,
      timedOut: true,
    };
  }

  const toggle = await measureToggle({
    page,
    title,
    toggleTimeoutMs,
    pollIntervalMs,
  });

  const timedOut = toggle.samePaneMs == null || toggle.mirrorPaneMs == null;
  return {
    trial,
    title,
    samePaneMs: toggle.samePaneMs,
    mirrorPaneMs: toggle.mirrorPaneMs,
    timedOut,
  };
}

async function main(): Promise<void> {
  const demoUrl = process.env.DEMO_URL ?? 'https://demo.syncular.dev';
  const trials = readIntEnv('TRIALS', 5);
  const readyTimeoutMs = readIntEnv('READY_TIMEOUT_MS', 30_000);
  const visibilityTimeoutMs = readIntEnv('VISIBILITY_TIMEOUT_MS', 20_000);
  const toggleTimeoutMs = readIntEnv('TOGGLE_TIMEOUT_MS', 30_000);
  const pollIntervalMs = readIntEnv('POLL_INTERVAL_MS', 16);
  const headless = readBoolEnv('HEADLESS', true);
  const localP95BudgetMs = readIntEnv('LOCAL_P95_BUDGET_MS', 120);
  const mirrorP95BudgetMs = readIntEnv('MIRROR_P95_BUDGET_MS', 3_000);

  console.log('Config');
  console.log(`- url: ${demoUrl}`);
  console.log(`- trials: ${trials}`);
  console.log(`- readyTimeoutMs: ${readyTimeoutMs}`);
  console.log(`- visibilityTimeoutMs: ${visibilityTimeoutMs}`);
  console.log(`- toggleTimeoutMs: ${toggleTimeoutMs}`);
  console.log(`- pollIntervalMs: ${pollIntervalMs}`);
  console.log(`- headless: ${headless}`);
  console.log(`- localP95BudgetMs: ${localP95BudgetMs}`);
  console.log(`- mirrorP95BudgetMs: ${mirrorP95BudgetMs}`);

  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  try {
    await page.goto(demoUrl, { waitUntil: 'domcontentloaded' });
    await waitUntilReady(page, readyTimeoutMs);

    await page.waitForTimeout(2_000);

    const samples: ToggleSample[] = [];
    for (let trial = 1; trial <= trials; trial++) {
      const sample = await runTrial({
        page,
        trial,
        visibilityTimeoutMs,
        toggleTimeoutMs,
        pollIntervalMs,
      });
      samples.push(sample);
      console.log(
        `trial ${trial}: same=${formatMs(sample.samePaneMs)} mirror=${formatMs(sample.mirrorPaneMs)}`
      );
      await page.waitForTimeout(500);
    }

    const { localP95, mirrorP95 } = summarize(samples);
    const hasTimeout = samples.some((sample) => sample.timedOut);
    const localBudgetExceeded = localP95 != null && localP95 > localP95BudgetMs;
    const mirrorBudgetExceeded =
      mirrorP95 != null && mirrorP95 > mirrorP95BudgetMs;

    if (hasTimeout || localBudgetExceeded || mirrorBudgetExceeded) {
      if (hasTimeout) {
        console.error('Latency measurement timed out for at least one trial.');
      }
      if (localBudgetExceeded) {
        console.error(
          `same-pane p95 exceeded budget: ${Math.round(localP95!)}ms > ${localP95BudgetMs}ms`
        );
      }
      if (mirrorBudgetExceeded) {
        console.error(
          `mirror-pane p95 exceeded budget: ${Math.round(mirrorP95!)}ms > ${mirrorP95BudgetMs}ms`
        );
      }
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

await main();
