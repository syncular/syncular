/**
 * Browser runtime tests — proves wa-sqlite works with sync in the browser.
 *
 * Starts a browser asset server (Bun subprocess), launches Chromium via Playwright,
 * and runs conformance + sync scenarios via page.evaluate().
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import { createIntegrationServer } from '../../integration/harness/create-server';
import type { IntegrationServer } from '../../integration/harness/types';
import {
  type BrowserErrorCollector,
  collectBrowserErrors,
} from '../shared/browser-errors';
import { pickFreePort, waitForHealthy } from '../shared/utils';

/** Window augmentation for runtime API exposed by entry.ts */
declare global {
  interface Window {
    __runtime: {
      conformance(): Promise<{ ok: boolean; error?: string }>;
      bootstrap(params: {
        serverUrl: string;
        actorId: string;
        clientId: string;
      }): Promise<{ ok: boolean; rowCount?: number; error?: string }>;
      pushPull(params: {
        serverUrl: string;
        actorId: string;
        clientId: string;
      }): Promise<{ ok: boolean; finalRowCount?: number; error?: string }>;
    };
    __runtimeReady: boolean;
  }
}

function hasPlaywrightChromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const hasPlaywrightChromium = hasPlaywrightChromiumInstalled();

if (!hasPlaywrightChromium) {
  console.warn(
    '[runtime-browser] Playwright Chromium is missing. Run `bunx playwright install chromium` to enable browser runtime tests.'
  );
}

const describeBrowserRuntime = hasPlaywrightChromium ? describe : describe.skip;

describeBrowserRuntime('Browser runtime (wa-sqlite)', () => {
  let assetProc: ReturnType<typeof Bun.spawn>;
  let assetUrl: string;
  let browser: Browser;
  let page: Page;
  let server: IntegrationServer;
  let browserErrors: BrowserErrorCollector | null = null;

  beforeAll(async () => {
    // Start integration server for sync tests (with CORS)
    server = await createIntegrationServer('sqlite');

    // Start browser asset server (builds wa-sqlite worker + entry, serves with COOP/COEP)
    const assetPort = await pickFreePort();
    const servePath = path.resolve(import.meta.dir, '../apps/browser/serve.ts');

    assetProc = Bun.spawn(['bun', 'run', servePath, `--port=${assetPort}`], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    assetUrl = `http://127.0.0.1:${assetPort}`;
    await waitForHealthy(assetUrl, 30_000);

    // Launch Chromium
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();

    // Navigate and wait for runtime to be ready (wa-sqlite WASM + worker init)
    await page.goto(assetUrl);
    await page.waitForFunction(() => window.__runtimeReady === true, {
      timeout: 30_000,
    });
    browserErrors = collectBrowserErrors(page);
  });

  beforeEach(() => {
    if (!browserErrors)
      throw new Error('browser error collector not initialized');
    browserErrors.clear();
  });

  afterEach(() => {
    if (!browserErrors)
      throw new Error('browser error collector not initialized');
    browserErrors.assertNone('browser runtime test');
  });

  afterAll(async () => {
    browserErrors?.detach();
    // Force-kill the asset server immediately (no graceful shutdown needed in tests)
    try {
      assetProc?.kill('SIGKILL');
    } catch {}
    // Close browser + server in parallel
    await Promise.all([
      browser?.close().catch(() => {}),
      server?.destroy().catch(() => {}),
    ]);
  });

  it('passes conformance (types, nulls, unique, tx)', async () => {
    const result = await page.evaluate(() => window.__runtime.conformance());
    expect(result.ok).toBe(true);
  });

  it('bootstraps from server', async () => {
    // Seed server with test data
    await server.db
      .insertInto('tasks')
      .values([
        {
          id: 'browser-rt-1',
          title: 'Task 1',
          completed: 0,
          user_id: 'browser-boot-user',
          project_id: 'p1',
          server_version: 1,
        },
        {
          id: 'browser-rt-2',
          title: 'Task 2',
          completed: 1,
          user_id: 'browser-boot-user',
          project_id: 'p1',
          server_version: 1,
        },
      ])
      .execute();

    const result = await page.evaluate(
      (params) => window.__runtime.bootstrap(params),
      {
        serverUrl: server.baseUrl,
        actorId: 'browser-boot-user',
        clientId: 'browser-client-1',
      }
    );

    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(2);
  });

  it('pushes and pulls data', async () => {
    const result = await page.evaluate(
      (params) => window.__runtime.pushPull(params),
      {
        serverUrl: server.baseUrl,
        actorId: 'browser-push-user',
        clientId: 'browser-client-2',
      }
    );

    expect(result.ok).toBe(true);
    expect(result.finalRowCount).toBe(1);

    // Verify server has the task
    const serverRows = await server.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'browser-task-1')
      .execute();
    expect(serverRows.length).toBe(1);
    expect(serverRows[0]!.title).toBe('Browser Task');
  });
});
