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
import {
  type Browser,
  type BrowserType,
  chromium,
  firefox,
  type Page,
} from '@playwright/test';
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
      hostStore(): Promise<{
        ok: boolean;
        opfsSupported?: boolean;
        pendingCount?: number;
        retryBaseVersion?: number;
        subscriptionCursor?: number;
        rowIds?: string[];
        error?: string;
      }>;
      rustOwnedSqlite(): Promise<{
        ok: boolean;
        clientCommitIds?: string[];
        taskRows?: number;
        outboxRows?: number;
        schemaVersion?: number | null;
        currentSchemaVersion?: number;
        error?: string;
      }>;
      rustOwnedSqliteSchemaMismatch(): Promise<{
        ok: boolean;
        errorMessage?: string;
        error?: string;
      }>;
      rustOwnedSqliteOpfsWorker(): Promise<{
        ok: boolean;
        clientCommitIds?: string[];
        taskRows?: number;
        outboxRows?: number;
        error?: string;
      }>;
      rustOwnedStoreParity(): Promise<{
        ok: boolean;
        clientCommitId?: string;
        retryBaseVersion?: number;
        subscriptionCursor?: number;
        rowIds?: string[];
        outboxRows?: number;
        error?: string;
      }>;
      rustOwnedKyselyLive(): Promise<{
        ok: boolean;
        initialRows?: number;
        liveSnapshots?: Array<{ initial: boolean; ids: string[] }>;
        selectedIds?: string[];
        updatedTitle?: string;
        runtimePackage?: string;
        runtimeProtocol?: number;
        runtimeRustFeature?: string;
        runtimeStorage?: string;
        runtimeFallbackFrom?: string;
        runtimeFallbackTo?: string;
        error?: string;
      }>;
      rustOwnedSqliteClient(params: {
        serverUrl: string;
        actorId: string;
        clientId: string;
      }): Promise<{
        ok: boolean;
        clientCommitId?: string;
        pushedCommits?: number;
        changedTables?: string[];
        localRowCount?: number;
        rowIds?: string[];
        schemaVersion?: number | null;
        currentSchemaVersion?: number;
        runtimeStorage?: string;
        runtimeFallbackFrom?: string;
        runtimeFallbackTo?: string;
        error?: string;
      }>;
    };
    __runtimeReady: boolean;
  }
}

const browserType: BrowserType =
  process.env.PLAYWRIGHT_BROWSER === 'firefox' ? firefox : chromium;

function hasPlaywrightBrowserInstalled(): boolean {
  try {
    return existsSync(browserType.executablePath());
  } catch {
    return false;
  }
}

const hasPlaywrightBrowser = hasPlaywrightBrowserInstalled();

if (!hasPlaywrightBrowser) {
  console.warn(
    `[runtime-browser] Playwright ${browserType.name()} is missing. Run \`bunx playwright install ${browserType.name()}\` to enable browser runtime tests.`
  );
}

const describeBrowserRuntime = hasPlaywrightBrowser ? describe : describe.skip;
const itChromium = browserType.name() === 'chromium' ? it : it.skip;

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

    // Launch browser (chromium or firefox based on PLAYWRIGHT_BROWSER env)
    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();

    // Navigate and wait for runtime to be ready (wa-sqlite WASM + worker init)
    await page.goto(assetUrl);
    await page.waitForFunction(() => window.__runtimeReady === true, {
      timeout: 30_000,
    });
    browserErrors = collectBrowserErrors(page);
  }, 30_000);

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
  }, 30_000);

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

  itChromium(
    'runs the Rust host-store contract over wa-sqlite/OPFS',
    async () => {
      const result = await page.evaluate(() => window.__runtime.hostStore());
      expect(result.ok).toBe(true);
      expect(result.opfsSupported).toBe(true);
      expect(result.pendingCount).toBe(1);
      expect(result.retryBaseVersion).toBe(8);
      expect(result.subscriptionCursor).toBe(12);
      expect(result.rowIds).toEqual(['host-task-1']);
    }
  );

  itChromium('runs rust-owned sqlite-wasm-rs over IndexedDB', async () => {
    const result = await page.evaluate(() =>
      window.__runtime.rustOwnedSqlite()
    );

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.clientCommitIds?.length).toBe(1);
    expect(result.taskRows).toBe(1);
    expect(result.outboxRows).toBe(1);
    expect(result.schemaVersion).toBe(result.currentSchemaVersion);
  });

  itChromium('rejects stale rust-owned app table shape on open', async () => {
    const result = await page.evaluate(() =>
      window.__runtime.rustOwnedSqliteSchemaMismatch()
    );

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.errorMessage).toContain(
      'Syncular app schema mismatch: tasks.title is missing'
    );
  });

  itChromium(
    'runs rust-owned sqlite-wasm-rs OPFS SAH in a Worker',
    async () => {
      const result = await page.evaluate(() =>
        window.__runtime.rustOwnedSqliteOpfsWorker()
      );

      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.clientCommitIds?.length).toBe(1);
      expect(result.taskRows).toBe(1);
      expect(result.outboxRows).toBe(1);
    }
  );

  itChromium('matches the store contract on rust-owned SQLite', async () => {
    const result = await page.evaluate(() =>
      window.__runtime.rustOwnedStoreParity()
    );

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.clientCommitId).toBeTruthy();
    expect(result.retryBaseVersion).toBe(5);
    expect(result.subscriptionCursor).toBe(42);
    expect(result.rowIds).toEqual(['parity-task-1']);
    expect(result.outboxRows).toBe(2);
  });

  itChromium(
    'runs Kysely queries and live subscriptions over rust-owned SQLite',
    async () => {
      const result = await page.evaluate(() =>
        window.__runtime.rustOwnedKyselyLive()
      );

      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.initialRows).toBe(0);
      expect(result.selectedIds).toEqual([
        'kysely-live-1',
        'kysely-live-client-write',
      ]);
      expect(result.updatedTitle).toBe('Kysely live task updated');
      expect(result.runtimePackage).toBe('@syncular/client-rust');
      expect(result.runtimeProtocol).toBe(1);
      expect(result.runtimeRustFeature).toBe('web-owned-sqlite');
      expect(result.runtimeStorage).toBeDefined();
      expect(['opfsSahPool', 'indexedDb']).toContain(result.runtimeStorage!);
      if (result.runtimeStorage === 'indexedDb') {
        expect(result.runtimeFallbackFrom).toBe('opfsSahPool');
        expect(result.runtimeFallbackTo).toBe('indexedDb');
      }
      expect(result.liveSnapshots?.map((snapshot) => snapshot.ids)).toEqual([
        [],
        ['kysely-live-client-write'],
        ['kysely-live-1', 'kysely-live-client-write'],
        ['kysely-live-1', 'kysely-live-client-write'],
      ]);
    }
  );

  itChromium('runs the Rust-owned SQLite v2 client over OPFS', async () => {
    const result = await page.evaluate(
      (params) => window.__runtime.rustOwnedSqliteClient(params),
      {
        serverUrl: server.baseUrl,
        actorId: 'browser-rust-owned-user',
        clientId: 'browser-rust-owned-client',
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.clientCommitId).toBeTruthy();
    expect(result.pushedCommits).toBe(1);
    expect(result.localRowCount).toBe(1);
    expect(result.rowIds).toEqual(['rust-owned-client-task-1']);
    expect(result.schemaVersion).toBe(result.currentSchemaVersion);
    expect(result.runtimeStorage).toBeDefined();
    expect(['opfsSahPool', 'indexedDb']).toContain(result.runtimeStorage!);
    if (result.runtimeStorage === 'indexedDb') {
      expect(result.runtimeFallbackFrom).toBe('opfsSahPool');
      expect(result.runtimeFallbackTo).toBe('indexedDb');
    }

    const serverRows = await server.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'rust-owned-client-task-1')
      .execute();
    expect(serverRows.length).toBe(1);
    expect(serverRows[0]!.title).toBe('Rust Owned SQLite Task');
  });
});
