import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from '@playwright/test';
import {
  type BrowserErrorCollector,
  collectBrowserErrors,
} from './browser-errors';
import { pickFreePort, shutdown, waitForHealthy } from './utils';

export type DemoSmokeHarness = {
  browser: Browser;
  browserErrors: BrowserErrorCollector;
  context: BrowserContext;
  demoBaseUrl: string;
  page: Page;
};

type DemoSmokeHarnessInternal = DemoSmokeHarness & {
  demoProc: ReturnType<typeof Bun.spawn>;
};

type DemoSmokeScenarioArgs = {
  scenarioName: string;
  testBody: (harness: DemoSmokeHarness) => Promise<void>;
  testName: string;
  timeoutMs?: number;
};

export function hasPlaywrightChromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

async function startDemoSmokeHarness(): Promise<DemoSmokeHarnessInternal> {
  const port = await pickFreePort();
  const repoRoot = path.resolve(import.meta.dir, '../../..');
  const demoBaseUrl = `http://127.0.0.1:${port}`;

  const demoProc = Bun.spawn(['bun', '--cwd', 'apps/demo', 'dev'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  await waitForHealthy(`${demoBaseUrl}/api`, 60_000);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);

  return {
    browser,
    browserErrors,
    context,
    demoBaseUrl,
    demoProc,
    page,
  };
}

async function stopDemoSmokeHarness(
  harness: DemoSmokeHarnessInternal | undefined
): Promise<void> {
  if (!harness) return;

  harness.browserErrors.detach();
  await Promise.all([
    harness.browser.close().catch(() => {}),
    shutdown(harness.demoProc).catch(() => {}),
  ]);
}

function requireHarness(
  harness: DemoSmokeHarnessInternal | undefined
): DemoSmokeHarnessInternal {
  if (!harness) {
    throw new Error('demo smoke harness not initialized');
  }
  return harness;
}

export function defineDemoSmokeScenario(args: DemoSmokeScenarioArgs): void {
  const describeDemoSmoke = hasPlaywrightChromiumInstalled()
    ? describe
    : describe.skip;

  describeDemoSmoke(args.scenarioName, () => {
    let harness: DemoSmokeHarnessInternal | undefined;

    beforeAll(async () => {
      harness = await startDemoSmokeHarness();
    }, 120_000);

    beforeEach(() => {
      requireHarness(harness).browserErrors.clear();
    });

    afterEach(() => {
      requireHarness(harness).browserErrors.assertNone('demo smoke test');
    });

    afterAll(async () => {
      await stopDemoSmokeHarness(harness);
    }, 30_000);

    it(
      args.testName,
      async () => {
        await args.testBody(requireHarness(harness));
      },
      args.timeoutMs ?? 300_000
    );
  });
}

export async function waitForTaskInBothPanes(args: {
  page: Page;
  timeoutMs: number;
  title: string;
}): Promise<void> {
  const { page, timeoutMs, title } = args;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.getByText(title, { exact: true }).count();
    if (count >= 2) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Task "${title}" was not visible on both panes in time`);
}

export async function waitForSplitScreenClientsReady(
  page: Page
): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelectorAll('input[placeholder="Add a task..."]').length >=
      2,
    undefined,
    { timeout: 120_000 }
  );
}

export async function resetDemoData(page: Page): Promise<void> {
  const resetButtons = page.getByRole('button', { name: 'Reset my data' });
  const resetButtonCount = await resetButtons.count();
  for (let index = 0; index < resetButtonCount; index += 1) {
    await resetButtons.nth(index).click();
  }

  if (resetButtonCount === 0) {
    return;
  }

  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Reset my data'
      ),
    undefined,
    { timeout: 90_000 }
  );
}

export async function measureSplitScreenToggleLatency(args: {
  page: Page;
  timeoutMs: number;
  title: string;
}): Promise<{ mirrorPaneMs: number | null; samePaneMs: number | null }> {
  const { page, timeoutMs, title } = args;
  return await page.evaluate(
    async ({
      maxWaitMs,
      titleText,
    }: {
      maxWaitMs: number;
      titleText: string;
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
          (element) => {
            const cls =
              typeof element.className === 'string' ? element.className : '';
            return (
              cls.includes('group flex items-center') &&
              (element.textContent ?? '').includes(taskTitle)
            );
          }
        );
        const row = rows[0];
        if (!row) return null;
        const button = row.querySelector('button');
        return button instanceof HTMLButtonElement ? button : null;
      }

      const leftPanelRoot = findPanelRoot('Client A · wa-sqlite');
      const rightPanelRoot = findPanelRoot('Client B · PGlite');
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
      const deadline = startedAt + maxWaitMs;
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

        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      return { samePaneMs, mirrorPaneMs };
    },
    {
      maxWaitMs: timeoutMs,
      titleText: title,
    }
  );
}
