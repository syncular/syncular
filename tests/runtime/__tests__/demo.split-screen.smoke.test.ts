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

    const initialImageCount = await page.locator('main img').count();
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
      (minImages) => document.querySelectorAll('main img').length >= minImages,
      initialImageCount + 2,
      { timeout: 240_000 }
    );
  }, 300_000);
});
