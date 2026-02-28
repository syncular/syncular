import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import {
  type BrowserErrorCollector,
  collectBrowserErrors,
} from '../shared/browser-errors';
import { pickFreePort, shutdown, waitForHealthy } from '../shared/utils';

function hasPlaywrightChromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

async function waitForTaskInBothPanes(args: {
  page: Page;
  title: string;
  timeoutMs: number;
}): Promise<void> {
  const { page, title, timeoutMs } = args;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.getByText(title, { exact: true }).count();
    if (count >= 2) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Task "${title}" was not visible on both panes in time`);
}

async function measureSplitScreenToggleLatency(args: {
  page: Page;
  title: string;
  timeoutMs: number;
}): Promise<{ samePaneMs: number | null; mirrorPaneMs: number | null }> {
  const { page, title, timeoutMs } = args;
  return await page.evaluate(
    async ({
      titleText,
      maxWaitMs,
    }: {
      titleText: string;
      maxWaitMs: number;
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
      titleText: title,
      maxWaitMs: timeoutMs,
    }
  );
}

const hasPlaywrightChromium = hasPlaywrightChromiumInstalled();
const describeDemoSmoke = hasPlaywrightChromium ? describe : describe.skip;

describeDemoSmoke('Demo split-screen smoke', () => {
  let demoProc: ReturnType<typeof Bun.spawn>;
  let demoBaseUrl = '';
  let browser: Browser;
  let page: Page;
  let browserErrors: BrowserErrorCollector | null = null;

  beforeAll(async () => {
    const port = await pickFreePort();
    const repoRoot = path.resolve(import.meta.dir, '../../..');
    demoBaseUrl = `http://127.0.0.1:${port}`;

    demoProc = Bun.spawn(['bun', '--cwd', 'apps/demo', 'dev'], {
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

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
    browserErrors = collectBrowserErrors(page);
  }, 120_000);

  beforeEach(() => {
    if (!browserErrors)
      throw new Error('browser error collector not initialized');
    browserErrors.clear();
  });

  afterEach(() => {
    if (!browserErrors)
      throw new Error('browser error collector not initialized');
    browserErrors.assertNone('demo smoke test');
  });

  afterAll(async () => {
    browserErrors?.detach();
    await Promise.all([
      browser?.close().catch(() => {}),
      shutdown(demoProc).catch(() => {}),
    ]);
  }, 30_000);

  it('loads both clients and mirrors todo updates', async () => {
    await page.goto(demoBaseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('input[placeholder="Add a task..."]')
          .length >= 1,
      undefined,
      { timeout: 120_000 }
    );

    expect(
      await page.getByText('Database initialization failed:').count()
    ).toBe(0);

    const resetButtons = page.getByRole('button', { name: 'Reset my data' });
    const resetButtonCount = await resetButtons.count();
    for (let index = 0; index < resetButtonCount; index += 1) {
      await resetButtons.nth(index).click();
    }

    if (resetButtonCount > 0) {
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll('button')).some(
            (button) => button.textContent?.trim() === 'Reset my data'
          ),
        undefined,
        { timeout: 90_000 }
      );
    }

    const title = `smoke-${Date.now()}`;
    const input = page.getByPlaceholder('Add a task...').first();
    await input.fill(title);
    await input.press('Enter');

    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const count = await page.getByText(title, { exact: true }).count();
      if (count >= 2) return;
      await page.waitForTimeout(150);
    }

    const finalCount = await page.getByText(title, { exact: true }).count();
    expect(finalCount).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it('uploads media and syncs thumbnails across both clients', async () => {
    await page.goto(`${demoBaseUrl}/media`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('input[type="file"]') !== null,
      undefined,
      { timeout: 120_000 }
    );

    expect(
      await page.getByText('Database initialization failed:').count()
    ).toBe(0);

    await page.waitForFunction(
      () => !document.body.innerText.includes('Initializing PGlite...'),
      undefined,
      { timeout: 180_000 }
    );

    const initialThumbnailCount = await page
      .locator('[data-testid="media-thumbnail"]')
      .count();
    const fileName = `smoke-media-${Date.now()}.png`;
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8LhB4AAAAASUVORK5CYII=',
      'base64'
    );

    await page.locator('input[type="file"]').first().setInputFiles({
      name: fileName,
      mimeType: 'image/png',
      buffer: png1x1,
    });

    await page.waitForFunction(
      (name) => document.body.innerText.includes(name),
      fileName,
      { timeout: 120_000 }
    );

    await page.waitForFunction(
      (minThumbnails) =>
        document.querySelectorAll('[data-testid="media-thumbnail"]').length >=
        minThumbnails,
      initialThumbnailCount + 2,
      { timeout: 240_000 }
    );
  }, 300_000);

  it('keeps source-pane toggle responsive while mirroring to target pane', async () => {
    await page.goto(demoBaseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('input[placeholder="Add a task..."]')
          .length >= 1,
      undefined,
      { timeout: 120_000 }
    );

    const title = `latency-${Date.now()}`;
    const input = page.getByPlaceholder('Add a task...').first();
    await input.fill(title);
    await input.press('Enter');
    await waitForTaskInBothPanes({
      page,
      title,
      timeoutMs: 240_000,
    });

    const { samePaneMs, mirrorPaneMs } = await measureSplitScreenToggleLatency({
      page,
      title,
      timeoutMs: 240_000,
    });

    expect(samePaneMs).not.toBeNull();
    expect(mirrorPaneMs).not.toBeNull();
    expect(samePaneMs!).toBeLessThan(500);
    expect(mirrorPaneMs!).toBeGreaterThanOrEqual(samePaneMs!);
  }, 300_000);
});
