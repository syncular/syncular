#!/usr/bin/env bun
import { Buffer } from 'node:buffer';
/**
 * End-to-end smoke test for create-syncular-app.
 *
 * 1. Builds the CLI bundle (dist/cli.js) and runs it to scaffold an app into
 *    a temp directory outside the repository.
 * 2. Replaces the scaffolded dependency ranges with symlinks to the local
 *    workspace packages (the published-registry equivalent of `bun install`),
 *    mirroring scripts/fresh-app-smokes.ts.
 * 3. Boots `bun scripts/dev.ts`, curls the sync server health endpoint and
 *    the Vite page, then builds the app and repeats the same checks against
 *    `bun scripts/dev.ts --preview`.
 * 4. When Chrome/Chromium is available, opens the built preview in a real
 *    browser and waits for the starter's Syncular health/schema/support lines.
 *    The browser path also proves pagehide/freeze/beforeunload pause
 *    evidence, real browser target background/foreground visibility,
 *    restored-page, online, DOM and CDP page-lifecycle resume signals,
 *    two-tab lock-coordinated lifecycle resume, browser-observed lifecycle Web
 *    Lock contention timeout/recovery, browser-observed local recovery Web
 *    Lock contention timeout/recovery, storage
 *    preflight-to-recovery action mapping, browser-observed quota-pressure
 *    preflight classification, quota-exhausted generated writes, browser
 *    database-storage eviction/rebootstrap recovery, browser origin-storage
 *    eviction/rebootstrap recovery, two-tab propagation,
 *    same-client page reload/reopen persistence, same-client duplicate-tab
 *    open/write contention, generated write pressure, same-profile browser
 *    process restart persistence, sync-held shutdown replay recovery,
 *    renderer-crash replay recovery, explicit storage shutdown replay
 *    recovery, discarded-tab recovery, and service-worker-controlled PWA plus
 *    incognito memory-storage support-policy classification.
 *    After the happy path, the browser smoke also forces a hidden
 *    support-bundle marker failure and verifies the live
 *    browser-preview-failure artifact contract from real Chrome probe data.
 *    Browser failures write
 *    browser-preview-failure.json with redacted marker state under the smoke
 *    work dir. The normal smoke also self-checks that artifact shape and safe
 *    smoke metrics so non-browser runners keep the failure contract covered.
 *    Set SYNCULAR_CSA_BROWSER_PREVIEW_SMOKE=required to fail when no browser
 *    is available.
 *
 * Usage: bun scripts/smoke.ts [--keep] [--require-browser-preview]
 * Set SYNCULAR_CSA_SMOKE_WORK_DIR to keep artifacts in a predictable
 * repo-root-relative or absolute path.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const packageDir = resolve(join(import.meta.dirname, '..'));
const repoRoot = resolve(join(packageDir, '../..'));
const STARTER_LIFECYCLE_RESUME_LOCK_NAME =
  'syncular:create-syncular-app:lifecycle-resume';
const STARTER_LIFECYCLE_RESUME_LOCK_TIMEOUT_MS = 10_000;
const STARTER_LOCAL_RECOVERY_LOCK_NAME =
  'syncular:create-syncular-app:local-recovery';
const STARTER_LOCAL_RECOVERY_LOCK_TIMEOUT_MS = 1_000;
const STARTER_WRITE_PRESSURE_PROOF_COUNT = 4;
const STARTER_QUOTA_PRESSURE_FILL_BYTES = 8 * 1024 * 1024;
const STARTER_QUOTA_EXHAUSTION_WRITE_MIN_BYTES = 2 * 1024 * 1024;
const STARTER_QUOTA_EXHAUSTION_WRITE_EXTRA_BYTES = 512 * 1024;
const STARTER_STORAGE_EVICTION_SENTINEL_BYTES = 1024 * 1024;
const STARTER_STORAGE_EVICTION_SENTINEL_CACHE =
  'syncular-storage-eviction-proof';
const STARTER_STORAGE_EVICTION_SENTINEL_INDEXEDDB =
  'syncular-storage-eviction-proof';
const STARTER_STORAGE_EVICTION_SENTINEL_INDEXEDDB_STORE = 'sentinels';
const STARTER_STORAGE_EVICTION_SENTINEL_INDEXEDDB_KEY = 'database-storage';
const STARTER_STORAGE_EVICTION_SENTINEL_KEY =
  '__syncular_storage_eviction_sentinel__';
const STARTER_STORAGE_EVICTION_SENTINEL_URL =
  '/__syncular-storage-eviction-proof.bin';
const STARTER_DATABASE_STORAGE_EVICTION_TYPES = 'indexeddb,file_systems';
const STARTER_PWA_SMOKE_SERVICE_WORKER_PATH = '/__syncular-smoke-pwa-sw.js';
const BROWSER_PREVIEW_SMOKE_TIMEOUT_MS = 180_000;
const CDP_CONNECT_TIMEOUT_MS = 10_000;
const CDP_COMMAND_TIMEOUT_MS = 30_000;
const CHROME_BFCACHE_LIFECYCLE_SUSPENSION_TEXT =
  'Page entered Back-Forward Cache';
const keep = process.argv.includes('--keep');
const requireBrowserPreviewSmoke =
  process.env.SYNCULAR_CSA_BROWSER_PREVIEW_SMOKE === 'required' ||
  process.argv.includes('--require-browser-preview');

function log(message: string): void {
  console.log(`[csa-smoke] ${message}`);
}

async function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> }
): Promise<void> {
  log(`$ ${[command, ...args].join(' ')}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      env: options.env ?? process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with status ${code ?? 'unknown'}`));
    });
  });
}

/** Maps a dependency name to its directory inside the repository. */
function localPackageDir(name: string): string | null {
  if (name === 'syncular') return join(repoRoot, 'packages/syncular');
  if (name.startsWith('@syncular/')) {
    return join(repoRoot, 'packages', name.slice('@syncular/'.length));
  }

  // External dependencies: reuse the copies installed for repo workspaces
  // that depend on them.
  const candidates = [
    join(repoRoot, 'apps/demo/node_modules', name),
    join(repoRoot, 'packages/typegen/node_modules', name),
    join(repoRoot, 'packages/client/node_modules', name),
    join(repoRoot, 'node_modules', name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function linkDependencies(appDir: string): Promise<void> {
  const pkg = JSON.parse(
    await readFile(join(appDir, 'package.json'), 'utf8')
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  for (const name of names) {
    const sourceDir = localPackageDir(name);
    if (!sourceDir || !existsSync(sourceDir)) {
      throw new Error(`No local copy found for dependency ${name}`);
    }
    const linkPath = join(appDir, 'node_modules', ...name.split('/'));
    await mkdir(dirname(linkPath), { recursive: true });
    await rm(linkPath, { recursive: true, force: true });
    await symlink(sourceDir, linkPath, 'dir');
  }
  log(`linked ${names.length} dependencies to local packages`);
}

async function runLinkedViteBuild(
  appDir: string,
  env: Record<string, string | undefined>
): Promise<void> {
  const viteBin = join(appDir, 'node_modules/vite/bin/vite.js');
  if (!existsSync(viteBin)) {
    throw new Error(
      'Vite binary was not available through the smoke symlinked dependencies'
    );
  }
  await run(process.execPath, [viteBin, 'build'], { cwd: appDir, env });
}

async function writeBuiltPreviewSmokeServiceWorker(
  appDir: string
): Promise<void> {
  await writeFile(
    join(appDir, 'dist', STARTER_PWA_SMOKE_SERVICE_WORKER_PATH.slice(1)),
    `self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SYNCULAR_SMOKE_SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('fetch', () => {});
`,
    'utf8'
  );
}

/**
 * The symlinked node_modules resolve to files outside the app directory, so
 * widen Vite's dev-server file allowlist to the repository. Real users do not
 * need this: their node_modules live inside the app.
 */
async function widenViteFsAllow(appDir: string): Promise<void> {
  const configPath = join(appDir, 'vite.config.ts');
  const source = await readFile(configPath, 'utf8');
  const marker = 'strictPort: false,';
  if (!source.includes(marker)) {
    throw new Error('vite.config.ts marker not found for smoke fs.allow');
  }
  await writeFile(
    configPath,
    source.replace(
      marker,
      `${marker}\n    fs: { allow: [${JSON.stringify(repoRoot)}, '.'] },`
    )
  );
}

async function fetchUntilReady(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - Date.now());
    const attemptTimeout = setTimeout(
      () => controller.abort(),
      Math.min(5_000, remainingMs)
    );
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(attemptTimeout);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  if (port <= 0) throw new Error('Could not allocate a free smoke-test port');
  return port;
}

function elapsedSince(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function stopProcess(
  child: ReturnType<typeof spawn> | null
): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveExit) => {
    child.on('exit', () => resolveExit());
    setTimeout(resolveExit, 5_000);
  });
  // Give Vite's native (Rolldown) threads a moment to wind down before
  // their working directory disappears.
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000));
}

async function verifyBuiltPreviewAssets(
  origin: string,
  pageBody: string
): Promise<BuiltPreviewAssetMetrics> {
  const startedAtMs = Date.now();
  if (!pageBody.includes('<div id="root">')) {
    throw new Error('Built preview page did not include the app root element');
  }
  const assetPaths = [...pageBody.matchAll(/\b(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter(
      (value): value is string =>
        typeof value === 'string' &&
        (value.startsWith('/assets/') || value.startsWith('./assets/'))
    );
  if (assetPaths.length === 0) {
    throw new Error('Built preview page did not reference any Vite assets');
  }

  let sawLifecycleResumeMarker = false;
  let sawBrowserHealthMarker = false;
  let sawBrowserSupportPolicyMarker = false;
  let sawCommandTimelineMarker = false;
  let sawDeploymentPreflightMarker = false;
  let sawStarterTimelineMarker = false;
  let sawStorageShutdownMarker = false;
  let sawStorageRecoveryMarker = false;
  let sawSupportBundleMarker = false;
  let totalAssetBytes = 0;
  let jsAssetCount = 0;
  let jsAssetBytes = 0;
  let cssAssetCount = 0;
  let cssAssetBytes = 0;
  let otherAssetCount = 0;
  let otherAssetBytes = 0;
  for (const assetPath of assetPaths) {
    const assetUrl = new URL(assetPath, origin);
    const response = await fetch(assetUrl);
    if (!response.ok) {
      throw new Error(
        `Built preview asset ${assetUrl.href} returned ${response.status}`
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (
      assetUrl.pathname.endsWith('.js') ||
      contentType.includes('javascript')
    ) {
      jsAssetCount += 1;
      const assetBody = await response.text();
      const assetBytes = Buffer.byteLength(assetBody, 'utf8');
      totalAssetBytes += assetBytes;
      jsAssetBytes += assetBytes;
      sawLifecycleResumeMarker ||=
        assetBody.includes('data-syncular-lifecycle-resume-status') &&
        assetBody.includes('data-syncular-lifecycle-resume-lock-state');
      sawBrowserHealthMarker ||=
        assetBody.includes('data-syncular-browser-health-lifecycle-stage') &&
        assetBody.includes('data-syncular-browser-health-recovery-owner') &&
        assetBody.includes('data-syncular-browser-health-sync-now');
      sawBrowserSupportPolicyMarker ||=
        assetBody.includes('data-syncular-browser-support-policy-status') &&
        assetBody.includes(
          'data-syncular-browser-support-policy-reason-count'
        ) &&
        assetBody.includes(
          'data-syncular-browser-support-policy-required-evidence-count'
        );
      sawDeploymentPreflightMarker ||= assetBody.includes(
        'data-syncular-deployment-preflight-status'
      );
      sawStarterTimelineMarker ||=
        assetBody.includes('data-syncular-starter-bootstrap-ready-ms') &&
        assetBody.includes('data-syncular-starter-database-open-ms') &&
        assetBody.includes('data-syncular-starter-local-visibility-ms') &&
        assetBody.includes('data-syncular-starter-realtime-connected-ms');
      sawStorageRecoveryMarker ||=
        assetBody.includes('data-syncular-storage-recovery-proof-status') &&
        assetBody.includes('data-syncular-storage-recovery-proof-action-kinds');
      sawStorageShutdownMarker ||=
        assetBody.includes('data-syncular-storage-shutdown-proof-status') &&
        assetBody.includes(
          'data-syncular-storage-shutdown-proof-post-close-error-code'
        );
      sawSupportBundleMarker ||=
        assetBody.includes('data-syncular-support-bundle-status') &&
        assetBody.includes('data-syncular-support-bundle-timeline-event-count');
      sawCommandTimelineMarker ||=
        assetBody.includes('data-syncular-command-timeline-proof-status') &&
        assetBody.includes(
          'data-syncular-command-timeline-proof-local-visibility-observed'
        ) &&
        assetBody.includes(
          'data-syncular-command-timeline-proof-realtime-cursor'
        );
    } else {
      const assetBytes = (await response.arrayBuffer()).byteLength;
      totalAssetBytes += assetBytes;
      if (assetUrl.pathname.endsWith('.css') || contentType.includes('css')) {
        cssAssetCount += 1;
        cssAssetBytes += assetBytes;
      } else {
        otherAssetCount += 1;
        otherAssetBytes += assetBytes;
      }
    }
  }
  if (!sawSupportBundleMarker) {
    throw new Error(
      'Built preview assets did not include the support-bundle smoke marker'
    );
  }
  if (!sawDeploymentPreflightMarker) {
    throw new Error(
      'Built preview assets did not include the deployment-preflight smoke marker'
    );
  }
  if (!sawBrowserSupportPolicyMarker) {
    throw new Error(
      'Built preview assets did not include the browser support-policy smoke marker'
    );
  }
  if (!sawBrowserHealthMarker) {
    throw new Error(
      'Built preview assets did not include the browser health lifecycle smoke marker'
    );
  }
  if (!sawLifecycleResumeMarker) {
    throw new Error(
      'Built preview assets did not include the lifecycle-resume smoke marker'
    );
  }
  if (!sawStarterTimelineMarker) {
    throw new Error(
      'Built preview assets did not include the starter timeline smoke marker'
    );
  }
  if (!sawStorageRecoveryMarker) {
    throw new Error(
      'Built preview assets did not include the storage recovery proof marker'
    );
  }
  if (!sawStorageShutdownMarker) {
    throw new Error(
      'Built preview assets did not include the storage shutdown proof marker'
    );
  }
  if (!sawCommandTimelineMarker) {
    throw new Error(
      'Built preview assets did not include the command timeline proof marker'
    );
  }

  return {
    assetCheckMs: elapsedSince(startedAtMs),
    assetCount: assetPaths.length,
    browserHealthMarkerInAssets: sawBrowserHealthMarker,
    browserSupportPolicyMarkerInAssets: sawBrowserSupportPolicyMarker,
    commandTimelineMarkerInAssets: sawCommandTimelineMarker,
    cssAssetBytes,
    cssAssetCount,
    deploymentPreflightMarkerInAssets: sawDeploymentPreflightMarker,
    jsAssetBytes,
    jsAssetCount,
    lifecycleResumeMarkerInAssets: sawLifecycleResumeMarker,
    otherAssetBytes,
    otherAssetCount,
    starterTimelineMarkerInAssets: sawStarterTimelineMarker,
    storageShutdownMarkerInAssets: sawStorageShutdownMarker,
    storageRecoveryMarkerInAssets: sawStorageRecoveryMarker,
    supportBundleMarkerInAssets: sawSupportBundleMarker,
    totalAssetBytes,
  };
}

async function verifyBuiltPreviewRuntimeAssets(origin: string): Promise<void> {
  const assets = [
    { path: '/syncular/wasm-core/syncular.js', label: 'Syncular WASM glue' },
    {
      path: '/syncular/wasm-core/syncular_bg.wasm',
      label: 'Syncular WASM binary',
    },
  ];

  for (const asset of assets) {
    const assetUrl = new URL(asset.path, origin);
    const response = await fetch(assetUrl);
    if (!response.ok) {
      throw new Error(
        `${asset.label} asset ${assetUrl.href} returned ${response.status}`
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    const expected = asset.path.endsWith('.wasm')
      ? 'application/wasm'
      : 'javascript';
    const valid = isExpectedAssetContentType(contentType, expected);
    if (!valid) {
      throw new Error(
        `${asset.label} asset ${assetUrl.href} was served as ${contentType}; expected ${expected}`
      );
    }
  }
}

function isExpectedAssetContentType(contentType: string, expected: string) {
  return expected === 'javascript'
    ? contentType.includes('javascript')
    : contentType.split(';', 1)[0]?.trim() === expected;
}

type BuiltPreviewAssetMetrics = {
  assetCheckMs: number;
  assetCount: number;
  browserHealthMarkerInAssets: boolean;
  browserSupportPolicyMarkerInAssets: boolean;
  commandTimelineMarkerInAssets: boolean;
  cssAssetBytes: number;
  cssAssetCount: number;
  deploymentPreflightMarkerInAssets: boolean;
  jsAssetBytes: number;
  jsAssetCount: number;
  lifecycleResumeMarkerInAssets: boolean;
  otherAssetBytes: number;
  otherAssetCount: number;
  starterTimelineMarkerInAssets: boolean;
  storageShutdownMarkerInAssets: boolean;
  storageRecoveryMarkerInAssets: boolean;
  supportBundleMarkerInAssets: boolean;
  totalAssetBytes: number;
};

async function maybeRunBrowserPreviewSmoke(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  syncOrigin: string;
  workDir: string;
}): Promise<void> {
  const chrome = resolveChromeExecutable();
  if (!chrome) {
    const message =
      'Chrome/Chromium was not found; skipped real-browser built-preview smoke.';
    if (requireBrowserPreviewSmoke) throw new Error(message);
    log(message);
    return;
  }

  await runBrowserPreviewSmoke({
    chrome,
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    syncOrigin: args.syncOrigin,
    failureArtifactPath: join(args.workDir, 'browser-preview-failure.json'),
    userDataDir: join(args.workDir, 'chrome-profile'),
  });
}

function resolveChromeExecutable(): string | null {
  const explicit = process.env.CHROME_BIN ?? process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function runBrowserPreviewSmoke(args: {
  chrome: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  origin: string;
  syncOrigin: string;
  userDataDir: string;
}): Promise<void> {
  const targetUrl = `${args.origin}/`;
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  let propagatedTitle: string | null = null;

  const smokeOperation = (async () => {
    log('real-browser smoke: creating first Chrome target');
    const target = await createChromeTarget(chrome.debugPort, 'about:blank');
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    let secondSession: CdpSession | null = null;
    try {
      log('real-browser smoke: enabling first Chrome target');
      await enableChromeTarget(session);
      await navigateChromeTarget(session, targetUrl);
      log('real-browser smoke: waiting for first page readiness');
      await waitForStarterBrowserReady(
        session,
        args.failureArtifactPath,
        args.failureMetrics
      );
      log('real-browser smoke: proving target activation lifecycle');
      const backgroundTarget = await createChromeTarget(
        chrome.debugPort,
        'about:blank'
      );
      const backgroundSession = await CdpSession.connect(
        backgroundTarget.webSocketDebuggerUrl
      );
      try {
        await enableChromeTarget(backgroundSession);
        await proveStarterBrowserTargetActivationLifecycle({
          active: session,
          background: backgroundSession,
          failureArtifactPath: args.failureArtifactPath,
          failureMetrics: args.failureMetrics,
        });
      } finally {
        backgroundSession.close();
        await closeChromeTarget(chrome.debugPort, backgroundTarget.id).catch(
          () => undefined
        );
      }
      log('real-browser smoke: proving first page lifecycle');
      await proveStarterBrowserLifecycleResume(
        session,
        args.failureArtifactPath,
        args.failureMetrics
      );
      log('real-browser smoke: proving lifecycle lock contention');
      await proveStarterLifecycleLockContention({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        session,
      });
      log('real-browser smoke: proving local recovery lock contention');
      await proveStarterLocalRecoveryLockContention({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        session,
      });
      log('real-browser smoke: proving storage recovery action mapping');
      await proveStarterStorageRecoveryActionMapping({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        session,
      });
      log('real-browser smoke: creating second Chrome target');
      const secondUrl = `${args.origin}/?syncularClientId=web-second`;
      const secondTarget = await createChromeTarget(
        chrome.debugPort,
        'about:blank'
      );
      secondSession = await CdpSession.connect(
        secondTarget.webSocketDebuggerUrl
      );
      log('real-browser smoke: enabling second Chrome target');
      await enableChromeTarget(secondSession);
      await navigateChromeTarget(secondSession, secondUrl);
      log('real-browser smoke: waiting for second page readiness');
      await waitForStarterBrowserReady(
        secondSession,
        args.failureArtifactPath,
        args.failureMetrics
      );
      log('real-browser smoke: proving two-tab lifecycle coordination');
      await proveStarterTwoTabLifecycleResumeCoordination({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        first: session,
        second: secondSession,
      });
      log('real-browser smoke: proving two-tab propagation');
      propagatedTitle = await proveStarterTwoTabPropagation({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        first: session,
        second: secondSession,
      });
      log('real-browser smoke: proving reload persistence');
      await proveStarterReloadPersistence({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        session: secondSession,
        title: propagatedTitle,
        url: `${args.origin}/?syncularClientId=web-second&syncularReloadProof=${Date.now()}`,
      });
      log('real-browser smoke: proving same-client duplicate-tab contention');
      await proveStarterSameClientDuplicateOpenContention({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        active: secondSession,
        debugPort: chrome.debugPort,
        observer: session,
        origin: args.origin,
        title: propagatedTitle,
      });
      log('real-browser smoke: proving generated write pressure');
      await proveStarterGeneratedWritePressure({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        active: secondSession,
        observer: session,
      });
    } finally {
      secondSession?.close();
      session.close();
    }
  })();
  smokeOperation.catch(() => undefined);

  try {
    await withTimeout({
      description: 'real-browser built-preview smoke',
      operation: smokeOperation,
      timeoutMs: BROWSER_PREVIEW_SMOKE_TIMEOUT_MS,
      onTimeout: async () => {
        await writeBrowserPreviewFailureArtifactIfMissing(
          args.failureArtifactPath,
          'real-browser-smoke-timeout',
          null,
          args.failureMetrics
        );
      },
    });
  } catch (error) {
    await writeBrowserPreviewFailureArtifactIfMissing(
      args.failureArtifactPath,
      'real-browser-smoke-error',
      null,
      args.failureMetrics
    );
    throw error;
  } finally {
    await stopProcess(chrome.process);
  }

  if (propagatedTitle === null) {
    throw new Error('Built preview browser smoke did not produce a task title');
  }
  log('real-browser smoke: proving browser process restart persistence');
  try {
    await proveStarterBrowserProcessRestart({
      chrome: args.chrome,
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      origin: args.origin,
      title: propagatedTitle,
      userDataDir: args.userDataDir,
    });
  } catch (error) {
    await writeBrowserPreviewFailureArtifactIfMissing(
      args.failureArtifactPath,
      'browser-restart-smoke-error',
      null,
      args.failureMetrics
    );
    throw error;
  }
  log('real-browser smoke: proving shutdown replay recovery');
  await proveStarterShutdownReplayRecovery({
    chrome: args.chrome,
    failureArtifactPath: shutdownReplayFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-shutdown-replay`,
  });
  log('real-browser smoke: proving renderer-crash replay recovery');
  await proveStarterRendererCrashReplayRecovery({
    chrome: args.chrome,
    failureArtifactPath: rendererCrashReplayFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-renderer-crash-replay`,
  });
  log('real-browser smoke: proving targeted sync-transport replay recovery');
  await proveStarterSyncTransportReplayRecovery({
    chrome: args.chrome,
    failureArtifactPath: syncTransportReplayFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    syncOrigin: args.syncOrigin,
    userDataDir: `${args.userDataDir}-sync-transport-replay`,
  });
  log('real-browser smoke: proving storage shutdown replay recovery');
  await proveStarterStorageShutdownReplayRecovery({
    chrome: args.chrome,
    failureArtifactPath: storageShutdownReplayFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-storage-shutdown-replay`,
  });
  log('real-browser smoke: proving discarded-tab recovery');
  await proveStarterDiscardedTabRecovery({
    chrome: args.chrome,
    failureArtifactPath: discardedTabRecoveryFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-discarded-tab-recovery`,
  });
  log('real-browser smoke: proving support-bundle failure artifact');
  await proveStarterSupportBundleFailureArtifact({
    chrome: args.chrome,
    failureArtifactPath: supportBundleFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-support-bundle-failure`,
  });
  log('real-browser smoke: proving service-worker-controlled PWA policy');
  await proveStarterPwaServiceWorkerContext({
    chrome: args.chrome,
    failureArtifactPath: pwaFailureArtifactPath(args.failureArtifactPath),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-pwa`,
  });
  log('real-browser smoke: proving incognito memory-storage policy');
  await proveStarterIncognitoMemoryStoragePolicy({
    chrome: args.chrome,
    failureArtifactPath: incognitoMemoryFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-incognito-memory`,
  });
  log('real-browser smoke: proving browser-observed quota pressure');
  await proveStarterQuotaPressurePreflight({
    chrome: args.chrome,
    failureArtifactPath: quotaPressureFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-quota-pressure`,
  });
  log('real-browser smoke: proving browser database-storage eviction recovery');
  await proveStarterDatabaseStorageEvictionRecovery({
    chrome: args.chrome,
    failureArtifactPath: databaseStorageEvictionFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-database-storage-eviction`,
  });
  log('real-browser smoke: proving browser storage eviction recovery');
  await proveStarterStorageEvictionRecovery({
    chrome: args.chrome,
    failureArtifactPath: storageEvictionFailureArtifactPath(
      args.failureArtifactPath
    ),
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    userDataDir: `${args.userDataDir}-storage-eviction`,
  });
  log('real-browser built-preview preflight smoke passed');
}

function supportBundleFailureArtifactPath(failureArtifactPath: string): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.support-bundle.json')
    : `${failureArtifactPath}.support-bundle.json`;
}

function pwaFailureArtifactPath(failureArtifactPath: string): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.pwa.json')
    : `${failureArtifactPath}.pwa.json`;
}

function incognitoMemoryFailureArtifactPath(
  failureArtifactPath: string
): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.incognito-memory.json')
    : `${failureArtifactPath}.incognito-memory.json`;
}

function quotaPressureFailureArtifactPath(failureArtifactPath: string): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.quota-pressure.json')
    : `${failureArtifactPath}.quota-pressure.json`;
}

function databaseStorageEvictionFailureArtifactPath(
  failureArtifactPath: string
): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.database-storage-eviction.json')
    : `${failureArtifactPath}.database-storage-eviction.json`;
}

function storageEvictionFailureArtifactPath(
  failureArtifactPath: string
): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.storage-eviction.json')
    : `${failureArtifactPath}.storage-eviction.json`;
}

function shutdownReplayFailureArtifactPath(
  failureArtifactPath: string
): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.shutdown-replay.json')
    : `${failureArtifactPath}.shutdown-replay.json`;
}

function rendererCrashReplayFailureArtifactPath(
  failureArtifactPath: string
): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.renderer-crash-replay.json')
    : `${failureArtifactPath}.renderer-crash-replay.json`;
}

function syncTransportReplayFailureArtifactPath(
  failureArtifactPath: string
): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.sync-transport-replay.json')
    : `${failureArtifactPath}.sync-transport-replay.json`;
}

function storageShutdownReplayFailureArtifactPath(
  failureArtifactPath: string
): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.storage-shutdown-replay.json')
    : `${failureArtifactPath}.storage-shutdown-replay.json`;
}

function discardedTabRecoveryFailureArtifactPath(
  failureArtifactPath: string
): string {
  return failureArtifactPath.endsWith('.json')
    ? failureArtifactPath.replace(/\.json$/u, '.discarded-tab-recovery.json')
    : `${failureArtifactPath}.discarded-tab-recovery.json`;
}

async function withTimeout<T>(args: {
  description: string;
  operation: Promise<T>;
  timeoutMs: number;
  onTimeout: () => Promise<void>;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      void args
        .onTimeout()
        .catch(() => undefined)
        .finally(() => {
          reject(
            new Error(
              `Timed out after ${args.timeoutMs}ms waiting for ${args.description}`
            )
          );
        });
    }, args.timeoutMs);
  });
  try {
    return await Promise.race([args.operation, timeoutPromise]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

async function enableChromeTarget(session: CdpSession): Promise<void> {
  await session.send('Runtime.enable');
  await session.send('Page.enable');
  await session.send('Log.enable');
  await session.send('Network.enable');
}

async function navigateChromeTarget(
  session: CdpSession,
  url: string
): Promise<void> {
  const loadEvent = session.waitForEvent('Page.loadEventFired', 15_000);
  await session.send('Page.navigate', { url });
  await loadEvent;
}

async function startBrowserPreviewChrome(args: {
  chrome: string;
  incognito?: boolean;
  userDataDir: string;
}): Promise<{ debugPort: number; process: ReturnType<typeof spawn> }> {
  await mkdir(args.userDataDir, { recursive: true });
  await enableChromeInternalDebugPages(args.userDataDir);
  const debugPort = await getFreePort();
  const chromeArgs = [
    '--headless=new',
    '--allow-chrome-scheme-url',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-allow-origins=*',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${args.userDataDir}`,
    ...(args.incognito ? ['--incognito'] : []),
    'about:blank',
  ];
  const chrome = spawn(args.chrome, chromeArgs, { stdio: 'ignore' });

  try {
    await fetchUntilReady(`http://127.0.0.1:${debugPort}/json/version`, 15_000);
  } catch (error) {
    await stopProcess(chrome);
    throw error;
  }

  return { debugPort, process: chrome };
}

async function enableChromeInternalDebugPages(
  userDataDir: string
): Promise<void> {
  const localStatePath = join(userDataDir, 'Local State');
  const localState = existsSync(localStatePath)
    ? (JSON.parse(await readFile(localStatePath, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};
  localState.internal_only_uis_enabled = true;
  await writeFile(localStatePath, JSON.stringify(localState));
}

async function createChromeTarget(
  debugPort: number,
  url: string
): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  const endpoint = `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(
    url
  )}`;
  let response = await fetch(endpoint, { method: 'PUT' });
  if (!response.ok) response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(
      `Chrome target creation failed with ${response.status} ${response.statusText}`
    );
  }
  const target = (await response.json()) as {
    id?: string;
    webSocketDebuggerUrl?: string;
  };
  if (!target.id || !target.webSocketDebuggerUrl) {
    throw new Error('Chrome target did not return a WebSocket debugger URL');
  }
  return {
    id: target.id,
    webSocketDebuggerUrl: normalizeChromeWebSocketUrl(
      target.webSocketDebuggerUrl
    ),
  };
}

type ChromeTargetListEntry = {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

async function listChromeTargets(
  debugPort: number
): Promise<ChromeTargetListEntry[]> {
  const endpoint = `http://127.0.0.1:${debugPort}/json/list`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(
      `Chrome target list failed with ${response.status} ${response.statusText}`
    );
  }
  const targets = (await response.json()) as ChromeTargetListEntry[];
  return targets;
}

async function findChromePageTarget(args: {
  debugPort: number;
  urlIncludes: string;
}): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const targets = await listChromeTargets(args.debugPort);
    const target = targets.find(
      (candidate) =>
        candidate.type === 'page' &&
        typeof candidate.id === 'string' &&
        typeof candidate.webSocketDebuggerUrl === 'string' &&
        typeof candidate.url === 'string' &&
        candidate.url.includes(args.urlIncludes)
    );
    if (target?.id && target.webSocketDebuggerUrl) {
      return {
        id: target.id,
        webSocketDebuggerUrl: normalizeChromeWebSocketUrl(
          target.webSocketDebuggerUrl
        ),
      };
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  throw new Error(
    `Timed out waiting for Chrome target containing URL ${args.urlIncludes}`
  );
}

async function activateChromeTargetById(
  debugPort: number,
  targetId: string
): Promise<void> {
  const endpoint = `http://127.0.0.1:${debugPort}/json/activate/${encodeURIComponent(
    targetId
  )}`;
  let response = await fetch(endpoint, { method: 'PUT' });
  if (!response.ok) response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(
      `Chrome target activation failed with ${response.status} ${response.statusText}`
    );
  }
}

async function closeChromeTarget(
  debugPort: number,
  targetId: string
): Promise<void> {
  const endpoint = `http://127.0.0.1:${debugPort}/json/close/${encodeURIComponent(
    targetId
  )}`;
  let response = await fetch(endpoint, { method: 'PUT' });
  if (!response.ok) response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(
      `Chrome target close failed with ${response.status} ${response.statusText}`
    );
  }
}

async function closeStarterChromeTarget(args: {
  debugPort: number;
  session: CdpSession | null;
  targetId: string | null;
}): Promise<void> {
  try {
    args.session?.close();
  } catch {
    // Target cleanup below is the important part for storage-release proofs.
  }
  if (args.targetId !== null) {
    await closeChromeTarget(args.debugPort, args.targetId).catch(
      () => undefined
    );
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
}

function normalizeChromeWebSocketUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
    return parsed.toString();
  } catch {
    return url;
  }
}

type BrowserPreviewProbe = {
  ready: boolean;
  errors: string[];
  markers: {
    durableHealthLine: boolean;
    schemaLine: boolean;
    preflightFailure: boolean;
    databaseOpening: boolean;
  };
  browserHealth: {
    blockedOperationCount: number;
    generatedMutation: string | null;
    lifecycleStage: string | null;
    localVisibility: string | null;
    recoveryOwner: string | null;
    status: string | null;
    syncNow: string | null;
  };
  deploymentPreflight: {
    actionCount: number;
    availableBytes: number | null;
    issueCount: number;
    minimumAvailableBytes: number | null;
    minimumQuotaBytes: number | null;
    persistence: string | null;
    persisted: string | null;
    preflightMs: number | null;
    quotaPressure: string | null;
    quotaBytes: number | null;
    serviceWorker: string | null;
    serviceWorkerControlled: string | null;
    serviceWorkerControllerScriptPath: string | null;
    serviceWorkerControllerState: string | null;
    status: string | null;
    supportTier: string | null;
    usageRatio: number | null;
    usageBytes: number | null;
  };
  browserSupportPolicy: {
    actionCount: number;
    context: string | null;
    expectedPersistence: string | null;
    expectedSupportTier: string | null;
    issueCount: number;
    knownRisks: string[];
    knownRiskCount: number;
    nextSteps: string[];
    nextStepCount: number;
    observedPersistence: string | null;
    observedSupportTier: string | null;
    policy: string | null;
    preflightRequired: string | null;
    reasonCodes: string[];
    reasonCount: number;
    requiredEvidence: string[];
    requiredEvidenceCount: number;
    status: string | null;
  };
  supportBundle: {
    status: string | null;
    redacted: string | null;
    sectionCount: number;
    issueCount: number;
    blobEventCount: number;
    cursorCount: number;
    latestBlobCode: string | null;
    latestLocalApplyCode: string | null;
    latestRealtimeCode: string | null;
    latestSyncCode: string | null;
    localApplyEventCount: number;
    realtimeEventCount: number;
    requestIdCount: number;
    sectionErrorCount: number;
    syncAttemptIdCount: number;
    syncEventCount: number;
    timelineEventCount: number;
  };
  commandTimelineProof: {
    clientCommitId: string | null;
    complete: boolean;
    contextEventCount: number;
    count: number;
    durationMs: number | null;
    error: string | null;
    errorCode: string | null;
    eventCount: number;
    localApplyObserved: boolean;
    localApplyCommitSeq: number | null;
    localApplyOutboxId: string | null;
    localVisibilityObserved: boolean;
    localVisibilitySource: string | null;
    localVisibilityState: string | null;
    localVisibilityTrigger: string | null;
    matchedEventCount: number;
    missingEvidence: string[];
    missingEvidenceCount: number;
    outboxPersisted: boolean;
    pullReasonObserved: boolean;
    pullReason: string | null;
    realtimeCursorObserved: boolean;
    realtimeCursor: number | string | null;
    requestCorrelated: boolean;
    requestId: string | null;
    serverCommitObserved: boolean;
    serverCommitSeq: number | null;
    scopeJoined: boolean;
    state: string | null;
    status: string | null;
    subscriptionIdCount: number;
    subscriptionIds: string[];
    syncAttemptId: string | null;
    syncAttemptObserved: boolean;
    traceId: string | null;
    spanId: string | null;
  };
  lifecycleResume: {
    status: string | null;
    count: number;
    reason: string | null;
    error: string | null;
    lockName: string | null;
    lockRequired: string | null;
    lockState: string | null;
    lockTimeoutMs: number | null;
  };
  lifecyclePause: {
    count: number;
    reason: string | null;
    pagehidePersisted: string | null;
    shutdownSignalCount: number;
    visibilityState: string | null;
  };
  localRecoveryProof: {
    actionKind: string | null;
    count: number;
    error: string | null;
    errorCode: string | null;
    lockName: string | null;
    lockRequired: string | null;
    lockState: string | null;
    lockTimeoutMs: number | null;
    status: string | null;
  };
  storageRecoveryProof: {
    actionKinds: string[];
    availableBytes: number | null;
    clearBlobCacheCompleted: string | null;
    compactCompleted: string | null;
    count: number;
    dataLossConsequenceCount: number;
    destructiveSafetyCount: number;
    error: string | null;
    errorCode: string | null;
    issueCodes: string[];
    issueCount: number;
    planActionCount: number;
    quotaBytes: number | null;
    quotaPressure: string | null;
    requestPersistenceGranted: string | null;
    requestPersistenceOffered: string | null;
    requestPersistenceSupported: string | null;
    source: string | null;
    status: string | null;
    outboxSafetyStatus: string | null;
    usageBytes: number | null;
    usageRatio: number | null;
  };
  quotaPressureProof: {
    actionCount: number;
    availableBytes: number | null;
    count: number;
    error: string | null;
    errorCode: string | null;
    issueCodes: string[];
    issueCount: number;
    persistence: string | null;
    quotaBytes: number | null;
    quotaPressure: string | null;
    status: string | null;
    supportTier: string | null;
    usageBytes: number | null;
    usageRatio: number | null;
  };
  writePressureProof: {
    durationMs: number | null;
    error: string | null;
    errorCode: string | null;
    requestedCount: number;
    runCount: number;
    status: string | null;
    titlePrefix: string | null;
    visibleCount: number;
  };
  quotaExhaustionWriteProof: {
    attemptedBytes: number;
    availableBytes: number | null;
    count: number;
    durationMs: number | null;
    error: string | null;
    errorCode: string | null;
    quotaBytes: number | null;
    status: string | null;
    usageBytes: number | null;
    usageRatio: number | null;
    writeFailed: boolean;
  };
  storageShutdownProof: {
    closed: boolean;
    count: number;
    durationMs: number | null;
    error: string | null;
    errorCode: string | null;
    lifecyclePhase: string | null;
    mutationRejected: boolean;
    postCloseErrorCode: string | null;
    status: string | null;
  };
  starterTimeline: {
    bootstrapReadyMs: number | null;
    bootstrapStatus: string | null;
    commandTimelineStatus: string | null;
    databaseOpenMs: number | null;
    healthRefreshMs: number | null;
    localVisibilityErrorCode: string | null;
    localVisibilityMs: number | null;
    localVisibilityStatus: string | null;
    marker: boolean;
    realtimeConnectedMs: number | null;
    realtimeStatus: string | null;
    schemaReadinessMs: number | null;
    supportBundleExportMs: number | null;
  };
  starterOpen: {
    diagnosticCode: string | null;
    diagnosticCount: number;
    diagnosticLevel: string | null;
    diagnosticSource: string | null;
    error: string | null;
    phase: string | null;
  };
  textExcerpt: string;
};

type BrowserPreviewFailureArtifact = {
  generatedAt: string;
  metrics: BrowserPreviewFailureMetrics;
  reason: string;
  probe: BrowserPreviewProbe | null;
};

type BrowserPreviewFailureMetrics = {
  artifactCreatedAfterMs: number;
  assetCheckMs: number;
  assetCount: number;
  browserHealthMarkerInAssets: boolean;
  browserSupportPolicyMarkerInAssets: boolean;
  commandTimelineMarkerInAssets: boolean;
  cssAssetBytes: number;
  cssAssetCount: number;
  deploymentPreflightMarkerInAssets: boolean;
  jsAssetBytes: number;
  jsAssetCount: number;
  lifecycleResumeMarkerInAssets: boolean;
  otherAssetBytes: number;
  otherAssetCount: number;
  previewReadyMs: number;
  starterTimelineMarkerInAssets: boolean;
  storageShutdownMarkerInAssets: boolean;
  storageRecoveryMarkerInAssets: boolean;
  supportBundleMarkerInAssets: boolean;
  totalAssetBytes: number;
};

type BrowserPreviewFailureMetricsInput = Omit<
  BrowserPreviewFailureMetrics,
  'artifactCreatedAfterMs'
> & {
  smokeStartedAtMs: number;
};

async function readStarterBrowserProbe(
  session: CdpSession
): Promise<BrowserPreviewProbe> {
  return session.evaluate<BrowserPreviewProbe>(`(() => {
    const text = document.body?.innerText ?? '';
    const browserHealth = document.querySelector('[data-syncular-browser-health-status]');
    const browserHealthBlockedOperationCount = Number(browserHealth?.getAttribute('data-syncular-browser-health-blocked-operation-count') ?? 0);
    const browserHealthGeneratedMutation = browserHealth?.getAttribute('data-syncular-browser-health-generated-mutation') ?? null;
    const browserHealthLifecycleStage = browserHealth?.getAttribute('data-syncular-browser-health-lifecycle-stage') ?? null;
    const browserHealthLocalVisibility = browserHealth?.getAttribute('data-syncular-browser-health-local-visibility') ?? null;
    const browserHealthRecoveryOwner = browserHealth?.getAttribute('data-syncular-browser-health-recovery-owner') ?? null;
    const browserHealthStatus = browserHealth?.getAttribute('data-syncular-browser-health-status') ?? null;
    const browserHealthSyncNow = browserHealth?.getAttribute('data-syncular-browser-health-sync-now') ?? null;
    const supportBundle = document.querySelector('[data-syncular-support-bundle-status]');
    const supportBundleStatus = supportBundle?.getAttribute('data-syncular-support-bundle-status') ?? null;
    const supportBundleRedacted = supportBundle?.getAttribute('data-syncular-support-bundle-redacted') ?? null;
    const supportBundleSectionCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-section-count') ?? 0);
    const supportBundleIssueCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-issue-count') ?? 0);
    const supportBundleBlobEventCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-blob-event-count') ?? 0);
    const supportBundleCursorCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-cursor-count') ?? 0);
    const supportBundleLatestBlobCode = supportBundle?.getAttribute('data-syncular-support-bundle-latest-blob-code') ?? null;
    const supportBundleLatestLocalApplyCode = supportBundle?.getAttribute('data-syncular-support-bundle-latest-local-apply-code') ?? null;
    const supportBundleLatestRealtimeCode = supportBundle?.getAttribute('data-syncular-support-bundle-latest-realtime-code') ?? null;
    const supportBundleLatestSyncCode = supportBundle?.getAttribute('data-syncular-support-bundle-latest-sync-code') ?? null;
    const supportBundleLocalApplyEventCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-local-apply-event-count') ?? 0);
    const supportBundleRealtimeEventCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-realtime-event-count') ?? 0);
    const supportBundleRequestIdCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-request-id-count') ?? 0);
    const supportBundleSectionErrorCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-section-error-count') ?? 0);
    const supportBundleSyncAttemptIdCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-sync-attempt-id-count') ?? 0);
    const supportBundleSyncEventCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-sync-event-count') ?? 0);
    const supportBundleTimelineEventCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-timeline-event-count') ?? 0);
    const commandTimelineProof = document.querySelector('[data-syncular-command-timeline-proof-status]');
    const commandTimelineProofClientCommitId = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-client-commit-id') ?? null;
    const commandTimelineProofComplete = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-complete') === 'true';
    const commandTimelineProofContextEventCount = Number(commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-context-event-count') ?? 0);
    const commandTimelineProofError = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-error') ?? null;
    const commandTimelineProofErrorCode = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-error-code') ?? null;
    const commandTimelineProofEventCount = Number(commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-event-count') ?? 0);
    const commandTimelineProofLocalApplyObserved = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-local-apply-observed') === 'true';
    const commandTimelineProofLocalVisibilityObserved = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-local-visibility-observed') === 'true';
    const commandTimelineProofLocalVisibilityState = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-local-visibility-state') ?? null;
    const commandTimelineProofLocalVisibilityTrigger = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-local-visibility-trigger') ?? null;
    const commandTimelineProofMatchedEventCount = Number(commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-matched-event-count') ?? 0);
    const commandTimelineProofMissingEvidenceText = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-missing-evidence') ?? '';
    const commandTimelineProofMissingEvidence = commandTimelineProofMissingEvidenceText === '' ? [] : commandTimelineProofMissingEvidenceText.split(',').filter(Boolean);
    const commandTimelineProofMissingEvidenceCount = Number(commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-missing-evidence-count') ?? commandTimelineProofMissingEvidence.length);
    const commandTimelineProofOutboxPersisted = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-outbox-persisted') === 'true';
    const commandTimelineProofPullReasonObserved = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-pull-reason-observed') === 'true';
    const commandTimelineProofRealtimeCursorObserved = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-realtime-cursor-observed') === 'true';
    const commandTimelineProofRequestCorrelated = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-request-correlated') === 'true';
    const commandTimelineProofServerCommitObserved = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-server-commit-observed') === 'true';
    const commandTimelineProofState = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-state') ?? null;
    const commandTimelineProofStatus = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-status') ?? null;
    const commandTimelineProofSyncAttemptObserved = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-sync-attempt-observed') === 'true';
    const readCommandTimelineProofNumber = (name) => {
      const value = commandTimelineProof?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const readCommandTimelineProofText = (name) => {
      const value = commandTimelineProof?.getAttribute(name) ?? null;
      return value === null || value === '' ? null : value;
    };
    const readCommandTimelineProofTextArray = (name) => {
      const value = commandTimelineProof?.getAttribute(name) ?? '';
      return value === '' ? [] : value.split(',').filter(Boolean);
    };
    const readCommandTimelineProofCursor = (name) => {
      const value = commandTimelineProof?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : value;
    };
    const commandTimelineProofCount = Number(commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-count') ?? 0);
    const commandTimelineProofDurationMs = readCommandTimelineProofNumber('data-syncular-command-timeline-proof-duration-ms');
    const commandTimelineProofLocalApplyCommitSeq = readCommandTimelineProofNumber('data-syncular-command-timeline-proof-local-apply-commit-seq');
    const commandTimelineProofLocalApplyOutboxId = readCommandTimelineProofText('data-syncular-command-timeline-proof-local-apply-outbox-id');
    const commandTimelineProofLocalVisibilitySource = readCommandTimelineProofText('data-syncular-command-timeline-proof-local-visibility-source');
    const commandTimelineProofPullReason = readCommandTimelineProofText('data-syncular-command-timeline-proof-pull-reason');
    const commandTimelineProofRealtimeCursor = readCommandTimelineProofCursor('data-syncular-command-timeline-proof-realtime-cursor');
    const commandTimelineProofRequestId = readCommandTimelineProofText('data-syncular-command-timeline-proof-request-id');
    const commandTimelineProofServerCommitSeq = readCommandTimelineProofNumber('data-syncular-command-timeline-proof-server-commit-seq');
    const commandTimelineProofScopeJoined = commandTimelineProof?.getAttribute('data-syncular-command-timeline-proof-scope-joined') === 'true';
    const commandTimelineProofSubscriptionIds = readCommandTimelineProofTextArray('data-syncular-command-timeline-proof-subscription-ids');
    const commandTimelineProofSyncAttemptId = readCommandTimelineProofText('data-syncular-command-timeline-proof-sync-attempt-id');
    const commandTimelineProofTraceId = readCommandTimelineProofText('data-syncular-command-timeline-proof-trace-id');
    const commandTimelineProofSpanId = readCommandTimelineProofText('data-syncular-command-timeline-proof-span-id');
    const deploymentPreflight = document.querySelector('[data-syncular-deployment-preflight-status]');
    const readDeploymentPreflightNumber = (name) => {
      const value = deploymentPreflight?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const deploymentPreflightActionCount = Number(deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-action-count') ?? 0);
    const deploymentPreflightAvailableBytes = readDeploymentPreflightNumber('data-syncular-deployment-preflight-available-bytes');
    const deploymentPreflightIssueCount = Number(deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-issue-count') ?? 0);
    const deploymentPreflightMinimumAvailableBytes = readDeploymentPreflightNumber('data-syncular-deployment-preflight-minimum-available-bytes');
    const deploymentPreflightMinimumQuotaBytes = readDeploymentPreflightNumber('data-syncular-deployment-preflight-minimum-quota-bytes');
    const deploymentPreflightPersistence = deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-persistence') ?? null;
    const deploymentPreflightPersisted = deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-persisted') ?? null;
    const deploymentPreflightPreflightMs = readDeploymentPreflightNumber('data-syncular-deployment-preflight-preflight-ms');
    const deploymentPreflightQuotaPressure = deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-quota-pressure') ?? null;
    const deploymentPreflightQuotaBytes = readDeploymentPreflightNumber('data-syncular-deployment-preflight-quota-bytes');
    const deploymentPreflightServiceWorker = deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-service-worker') ?? null;
    const deploymentPreflightServiceWorkerControlled = deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-service-worker-controlled') ?? null;
    const deploymentPreflightServiceWorkerControllerScriptPath = deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-service-worker-controller-script-path') ?? null;
    const deploymentPreflightServiceWorkerControllerState = deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-service-worker-controller-state') ?? null;
    const deploymentPreflightStatus = deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-status') ?? null;
    const deploymentPreflightSupportTier = deploymentPreflight?.getAttribute('data-syncular-deployment-preflight-support-tier') ?? null;
    const deploymentPreflightUsageRatio = readDeploymentPreflightNumber('data-syncular-deployment-preflight-usage-ratio');
    const deploymentPreflightUsageBytes = readDeploymentPreflightNumber('data-syncular-deployment-preflight-usage-bytes');
    const browserSupportPolicy = document.querySelector('[data-syncular-browser-support-policy-status]');
    const browserSupportPolicyActionCount = Number(browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-action-count') ?? 0);
    const browserSupportPolicyContext = browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-context') ?? null;
    const browserSupportPolicyExpectedPersistence = browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-expected-persistence') ?? null;
    const browserSupportPolicyExpectedSupportTier = browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-expected-support-tier') ?? null;
    const browserSupportPolicyIssueCount = Number(browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-issue-count') ?? 0);
    const readBrowserSupportPolicyTextArray = (name) => {
      const value = browserSupportPolicy?.getAttribute(name) ?? '';
      if (value === '') return [];
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
          ? parsed.filter((item) => typeof item === 'string')
          : [];
      } catch {
        return [];
      }
    };
    const browserSupportPolicyKnownRisks = readBrowserSupportPolicyTextArray('data-syncular-browser-support-policy-known-risks');
    const browserSupportPolicyKnownRiskCount = Number(browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-known-risk-count') ?? browserSupportPolicyKnownRisks.length);
    const browserSupportPolicyNextSteps = readBrowserSupportPolicyTextArray('data-syncular-browser-support-policy-next-steps');
    const browserSupportPolicyNextStepCount = Number(browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-next-step-count') ?? browserSupportPolicyNextSteps.length);
    const browserSupportPolicyObservedPersistence = browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-observed-persistence') ?? null;
    const browserSupportPolicyObservedSupportTier = browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-observed-support-tier') ?? null;
    const browserSupportPolicyPolicy = browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-policy') ?? null;
    const browserSupportPolicyPreflightRequired = browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-preflight-required') ?? null;
    const browserSupportPolicyReasonCodesText = browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-reason-codes') ?? '';
    const browserSupportPolicyReasonCodes = browserSupportPolicyReasonCodesText === '' ? [] : browserSupportPolicyReasonCodesText.split(',').filter(Boolean);
    const browserSupportPolicyReasonCount = Number(browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-reason-count') ?? browserSupportPolicyReasonCodes.length);
    const browserSupportPolicyRequiredEvidence = readBrowserSupportPolicyTextArray('data-syncular-browser-support-policy-required-evidence');
    const browserSupportPolicyRequiredEvidenceCount = Number(browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-required-evidence-count') ?? browserSupportPolicyRequiredEvidence.length);
    const browserSupportPolicyStatus = browserSupportPolicy?.getAttribute('data-syncular-browser-support-policy-status') ?? null;
    const lifecycleResume = document.querySelector('[data-syncular-lifecycle-resume-status]');
    const lifecycleResumeStatus = lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-status') ?? null;
    const lifecycleResumeCount = Number(lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-count') ?? 0);
    const readLifecycleResumeNumber = (name) => {
      const value = lifecycleResume?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const lifecycleResumeReason = lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-reason') ?? null;
    const lifecycleResumeError = lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-error') ?? null;
    const lifecycleResumeLockName = lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-lock-name') ?? null;
    const lifecycleResumeLockRequired = lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-lock-required') ?? null;
    const lifecycleResumeLockState = lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-lock-state') ?? null;
    const lifecycleResumeLockTimeoutMs = readLifecycleResumeNumber('data-syncular-lifecycle-resume-lock-timeout-ms');
    const lifecyclePauseCount = Number(lifecycleResume?.getAttribute('data-syncular-lifecycle-pause-count') ?? 0);
    const lifecyclePauseReason = lifecycleResume?.getAttribute('data-syncular-lifecycle-pause-reason') ?? null;
    const lifecyclePausePagehidePersisted = lifecycleResume?.getAttribute('data-syncular-lifecycle-pause-pagehide-persisted') ?? null;
    const lifecyclePauseShutdownSignalCount = Number(lifecycleResume?.getAttribute('data-syncular-lifecycle-pause-shutdown-signal-count') ?? 0);
    const lifecyclePauseVisibilityState = lifecycleResume?.getAttribute('data-syncular-lifecycle-pause-visibility-state') ?? null;
    const localRecoveryProof = document.querySelector('[data-syncular-local-recovery-proof-status]');
    const localRecoveryProofActionKind = localRecoveryProof?.getAttribute('data-syncular-local-recovery-proof-action-kind') ?? null;
    const localRecoveryProofCount = Number(localRecoveryProof?.getAttribute('data-syncular-local-recovery-proof-count') ?? 0);
    const localRecoveryProofError = localRecoveryProof?.getAttribute('data-syncular-local-recovery-proof-error') ?? null;
    const localRecoveryProofErrorCode = localRecoveryProof?.getAttribute('data-syncular-local-recovery-proof-error-code') ?? null;
    const localRecoveryProofLockName = localRecoveryProof?.getAttribute('data-syncular-local-recovery-proof-lock-name') ?? null;
    const localRecoveryProofLockRequired = localRecoveryProof?.getAttribute('data-syncular-local-recovery-proof-lock-required') ?? null;
    const localRecoveryProofLockState = localRecoveryProof?.getAttribute('data-syncular-local-recovery-proof-lock-state') ?? null;
    const localRecoveryProofStatus = localRecoveryProof?.getAttribute('data-syncular-local-recovery-proof-status') ?? null;
    const readLocalRecoveryProofNumber = (name) => {
      const value = localRecoveryProof?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const localRecoveryProofLockTimeoutMs = readLocalRecoveryProofNumber('data-syncular-local-recovery-proof-lock-timeout-ms');
    const storageRecoveryProof = document.querySelector('[data-syncular-storage-recovery-proof-status]');
    const readStorageRecoveryProofNumber = (name) => {
      const value = storageRecoveryProof?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const storageRecoveryProofActionKindsText = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-action-kinds') ?? '';
    const storageRecoveryProofActionKinds = storageRecoveryProofActionKindsText === '' ? [] : storageRecoveryProofActionKindsText.split(',').filter(Boolean);
    const storageRecoveryProofAvailableBytes = readStorageRecoveryProofNumber('data-syncular-storage-recovery-proof-available-bytes');
    const storageRecoveryProofClearBlobCacheCompleted = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-clear-blob-cache-completed') ?? null;
    const storageRecoveryProofCompactCompleted = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-compact-completed') ?? null;
    const storageRecoveryProofCount = Number(storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-count') ?? 0);
    const storageRecoveryProofDataLossConsequenceCount = Number(storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-data-loss-consequence-count') ?? 0);
    const storageRecoveryProofDestructiveSafetyCount = Number(storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-destructive-safety-count') ?? 0);
    const storageRecoveryProofError = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-error') ?? null;
    const storageRecoveryProofErrorCode = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-error-code') ?? null;
    const storageRecoveryProofIssueCodesText = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-issue-codes') ?? '';
    const storageRecoveryProofIssueCodes = storageRecoveryProofIssueCodesText === '' ? [] : storageRecoveryProofIssueCodesText.split(',').filter(Boolean);
    const storageRecoveryProofIssueCount = Number(storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-issue-count') ?? 0);
    const storageRecoveryProofPlanActionCount = Number(storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-plan-action-count') ?? 0);
    const storageRecoveryProofQuotaBytes = readStorageRecoveryProofNumber('data-syncular-storage-recovery-proof-quota-bytes');
    const storageRecoveryProofQuotaPressure = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-quota-pressure') ?? null;
    const storageRecoveryProofRequestPersistenceGranted = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-request-persistence-granted') ?? null;
    const storageRecoveryProofRequestPersistenceOffered = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-request-persistence-offered') ?? null;
    const storageRecoveryProofRequestPersistenceSupported = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-request-persistence-supported') ?? null;
    const storageRecoveryProofSource = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-source') ?? null;
    const storageRecoveryProofStatus = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-status') ?? null;
    const storageRecoveryProofOutboxSafetyStatus = storageRecoveryProof?.getAttribute('data-syncular-storage-recovery-proof-outbox-safety-status') ?? null;
    const storageRecoveryProofUsageBytes = readStorageRecoveryProofNumber('data-syncular-storage-recovery-proof-usage-bytes');
    const storageRecoveryProofUsageRatio = readStorageRecoveryProofNumber('data-syncular-storage-recovery-proof-usage-ratio');
    const quotaPressureProof = document.querySelector('[data-syncular-quota-pressure-proof-status]');
    const readQuotaPressureProofNumber = (name) => {
      const value = quotaPressureProof?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const quotaPressureProofActionCount = Number(quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-action-count') ?? 0);
    const quotaPressureProofAvailableBytes = readQuotaPressureProofNumber('data-syncular-quota-pressure-proof-available-bytes');
    const quotaPressureProofCount = Number(quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-count') ?? 0);
    const quotaPressureProofError = quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-error') ?? null;
    const quotaPressureProofErrorCode = quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-error-code') ?? null;
    const quotaPressureProofIssueCodesText = quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-issue-codes') ?? '';
    const quotaPressureProofIssueCodes = quotaPressureProofIssueCodesText === '' ? [] : quotaPressureProofIssueCodesText.split(',').filter(Boolean);
    const quotaPressureProofIssueCount = Number(quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-issue-count') ?? 0);
    const quotaPressureProofPersistence = quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-persistence') ?? null;
    const quotaPressureProofQuotaBytes = readQuotaPressureProofNumber('data-syncular-quota-pressure-proof-quota-bytes');
    const quotaPressureProofQuotaPressure = quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-quota-pressure') ?? null;
    const quotaPressureProofStatus = quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-status') ?? null;
    const quotaPressureProofSupportTier = quotaPressureProof?.getAttribute('data-syncular-quota-pressure-proof-support-tier') ?? null;
    const quotaPressureProofUsageBytes = readQuotaPressureProofNumber('data-syncular-quota-pressure-proof-usage-bytes');
    const quotaPressureProofUsageRatio = readQuotaPressureProofNumber('data-syncular-quota-pressure-proof-usage-ratio');
    const writePressureProof = document.querySelector('[data-syncular-write-pressure-proof-status]');
    const writePressureProofError = writePressureProof?.getAttribute('data-syncular-write-pressure-proof-error') ?? null;
    const writePressureProofErrorCode = writePressureProof?.getAttribute('data-syncular-write-pressure-proof-error-code') ?? null;
    const writePressureProofStatus = writePressureProof?.getAttribute('data-syncular-write-pressure-proof-status') ?? null;
    const writePressureProofTitlePrefix = writePressureProof?.getAttribute('data-syncular-write-pressure-proof-title-prefix') ?? null;
    const readWritePressureProofNumber = (name) => {
      const value = writePressureProof?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const writePressureProofDurationMs = readWritePressureProofNumber('data-syncular-write-pressure-proof-duration-ms');
    const writePressureProofRequestedCount = Number(writePressureProof?.getAttribute('data-syncular-write-pressure-proof-requested-count') ?? 0);
    const writePressureProofRunCount = Number(writePressureProof?.getAttribute('data-syncular-write-pressure-proof-run-count') ?? 0);
    const writePressureProofVisibleCount = Number(writePressureProof?.getAttribute('data-syncular-write-pressure-proof-visible-count') ?? 0);
    const quotaExhaustionWriteProof = document.querySelector('[data-syncular-quota-exhaustion-write-proof-status]');
    const quotaExhaustionWriteProofError = quotaExhaustionWriteProof?.getAttribute('data-syncular-quota-exhaustion-write-proof-error') ?? null;
    const quotaExhaustionWriteProofErrorCode = quotaExhaustionWriteProof?.getAttribute('data-syncular-quota-exhaustion-write-proof-error-code') ?? null;
    const quotaExhaustionWriteProofStatus = quotaExhaustionWriteProof?.getAttribute('data-syncular-quota-exhaustion-write-proof-status') ?? null;
    const quotaExhaustionWriteProofWriteFailed = quotaExhaustionWriteProof?.getAttribute('data-syncular-quota-exhaustion-write-proof-write-failed') === 'true';
    const readQuotaExhaustionWriteProofNumber = (name) => {
      const value = quotaExhaustionWriteProof?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const quotaExhaustionWriteProofAttemptedBytes = Number(quotaExhaustionWriteProof?.getAttribute('data-syncular-quota-exhaustion-write-proof-attempted-bytes') ?? 0);
    const quotaExhaustionWriteProofAvailableBytes = readQuotaExhaustionWriteProofNumber('data-syncular-quota-exhaustion-write-proof-available-bytes');
    const quotaExhaustionWriteProofCount = Number(quotaExhaustionWriteProof?.getAttribute('data-syncular-quota-exhaustion-write-proof-count') ?? 0);
    const quotaExhaustionWriteProofDurationMs = readQuotaExhaustionWriteProofNumber('data-syncular-quota-exhaustion-write-proof-duration-ms');
    const quotaExhaustionWriteProofQuotaBytes = readQuotaExhaustionWriteProofNumber('data-syncular-quota-exhaustion-write-proof-quota-bytes');
    const quotaExhaustionWriteProofUsageBytes = readQuotaExhaustionWriteProofNumber('data-syncular-quota-exhaustion-write-proof-usage-bytes');
    const quotaExhaustionWriteProofUsageRatio = readQuotaExhaustionWriteProofNumber('data-syncular-quota-exhaustion-write-proof-usage-ratio');
    const storageShutdownProof = document.querySelector('[data-syncular-storage-shutdown-proof-status]');
    const storageShutdownProofClosed = storageShutdownProof?.getAttribute('data-syncular-storage-shutdown-proof-closed') === 'true';
    const storageShutdownProofCount = Number(storageShutdownProof?.getAttribute('data-syncular-storage-shutdown-proof-count') ?? 0);
    const storageShutdownProofError = storageShutdownProof?.getAttribute('data-syncular-storage-shutdown-proof-error') ?? null;
    const storageShutdownProofErrorCode = storageShutdownProof?.getAttribute('data-syncular-storage-shutdown-proof-error-code') ?? null;
    const storageShutdownProofLifecyclePhase = storageShutdownProof?.getAttribute('data-syncular-storage-shutdown-proof-lifecycle-phase') ?? null;
    const storageShutdownProofMutationRejected = storageShutdownProof?.getAttribute('data-syncular-storage-shutdown-proof-mutation-rejected') === 'true';
    const storageShutdownProofPostCloseErrorCode = storageShutdownProof?.getAttribute('data-syncular-storage-shutdown-proof-post-close-error-code') ?? null;
    const storageShutdownProofStatus = storageShutdownProof?.getAttribute('data-syncular-storage-shutdown-proof-status') ?? null;
    const readStorageShutdownProofNumber = (name) => {
      const value = storageShutdownProof?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const storageShutdownProofDurationMs = readStorageShutdownProofNumber('data-syncular-storage-shutdown-proof-duration-ms');
    const starterTimeline = document.querySelector('[data-syncular-starter-database-open-ms]');
    const readStarterTimelineMs = (name) => {
      const value = starterTimeline?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const bootstrapReadyMs = readStarterTimelineMs('data-syncular-starter-bootstrap-ready-ms');
    const bootstrapStatus = starterTimeline?.getAttribute('data-syncular-starter-bootstrap-status') ?? null;
    const commandTimelineStatus = starterTimeline?.getAttribute('data-syncular-starter-command-timeline-status') ?? null;
    const databaseOpenMs = readStarterTimelineMs('data-syncular-starter-database-open-ms');
    const healthRefreshMs = readStarterTimelineMs('data-syncular-starter-health-refresh-ms');
    const localVisibilityErrorCode = starterTimeline?.getAttribute('data-syncular-starter-local-visibility-error-code') ?? null;
    const localVisibilityMs = readStarterTimelineMs('data-syncular-starter-local-visibility-ms');
    const localVisibilityStatus = starterTimeline?.getAttribute('data-syncular-starter-local-visibility-status') ?? null;
    const realtimeConnectedMs = readStarterTimelineMs('data-syncular-starter-realtime-connected-ms');
    const realtimeStatus = starterTimeline?.getAttribute('data-syncular-starter-realtime-status') ?? null;
    const schemaReadinessMs = readStarterTimelineMs('data-syncular-starter-schema-readiness-ms');
    const supportBundleExportMs = readStarterTimelineMs('data-syncular-starter-support-bundle-export-ms');
    const starterOpen = document.querySelector('[data-syncular-starter-open-phase]');
    const starterOpenDiagnosticCount = Number(starterOpen?.getAttribute('data-syncular-starter-open-diagnostic-count') ?? 0);
    const starterOpenDiagnosticCode = starterOpen?.getAttribute('data-syncular-starter-open-diagnostic-code') ?? null;
    const starterOpenDiagnosticLevel = starterOpen?.getAttribute('data-syncular-starter-open-diagnostic-level') ?? null;
    const starterOpenDiagnosticSource = starterOpen?.getAttribute('data-syncular-starter-open-diagnostic-source') ?? null;
    const starterOpenError = starterOpen?.getAttribute('data-syncular-starter-open-error') ?? null;
    const starterOpenPhase = starterOpen?.getAttribute('data-syncular-starter-open-phase') ?? null;
    const durableHealthLine = text.includes('indexedDb durable');
    const memoryStorageHealthLine = text.includes('memory storage');
    const schemaLine = text.includes('schema v');
    const preflightFailure = text.includes('Syncular browser preflight failed');
    const databaseOpening = text.includes('Opening local database');
    const errors = [];
    if (preflightFailure) {
      errors.push('preflight failed');
    }
    if (databaseOpening && text.includes('Error')) {
      errors.push('database open failed');
    }
    if (supportBundleStatus === 'failed') {
      errors.push('support bundle export failed');
    }
    if (supportBundleStatus !== null && supportBundleRedacted !== 'true') {
      errors.push('support bundle was not redacted');
    }
    if (commandTimelineProofStatus === 'failed') {
      errors.push(
        commandTimelineProofErrorCode
          ? 'command timeline proof failed: ' + commandTimelineProofErrorCode
          : 'command timeline proof failed'
      );
    }
    if (deploymentPreflightStatus === 'failed') {
      errors.push('deployment preflight failed');
    }
    if (deploymentPreflightStatus === 'not-ready') {
      errors.push('deployment preflight not ready');
    }
    if (browserSupportPolicyStatus === 'not-met') {
      errors.push('browser support policy not met');
    }
    if (lifecycleResumeStatus === 'failed') {
      errors.push('lifecycle resume failed');
    }
    if (localVisibilityStatus === 'failed') {
      errors.push(
        localVisibilityErrorCode
          ? 'local visibility failed: ' + localVisibilityErrorCode
          : 'local visibility failed'
      );
    }
    if (storageRecoveryProofStatus === 'failed') {
      errors.push(
        storageRecoveryProofErrorCode
          ? 'storage recovery proof failed: ' + storageRecoveryProofErrorCode
          : 'storage recovery proof failed'
      );
    }
    if (quotaPressureProofStatus === 'failed') {
      errors.push(
        quotaPressureProofErrorCode
          ? 'quota pressure proof failed: ' + quotaPressureProofErrorCode
          : 'quota pressure proof failed'
      );
    }
    if (writePressureProofStatus === 'failed') {
      errors.push(
        writePressureProofErrorCode
          ? 'write pressure proof failed: ' + writePressureProofErrorCode
          : 'write pressure proof failed'
      );
    }
    if (quotaExhaustionWriteProofStatus === 'failed') {
      errors.push(
        quotaExhaustionWriteProofErrorCode
          ? 'quota exhaustion write proof failed: ' +
              quotaExhaustionWriteProofErrorCode
          : 'quota exhaustion write proof failed'
      );
    }
    if (storageShutdownProofStatus === 'failed') {
      errors.push(
        storageShutdownProofErrorCode
          ? 'storage shutdown proof failed: ' + storageShutdownProofErrorCode
          : 'storage shutdown proof failed'
      );
    }
    return {
      ready:
        (durableHealthLine || memoryStorageHealthLine) &&
        schemaLine &&
        supportBundleStatus !== null &&
        commandTimelineProofStatus !== null &&
        browserSupportPolicyStatus !== null &&
        deploymentPreflightStatus !== null &&
        lifecycleResumeStatus !== null &&
        localRecoveryProof !== null &&
        storageRecoveryProof !== null &&
        quotaPressureProof !== null &&
        writePressureProof !== null &&
        quotaExhaustionWriteProof !== null &&
        storageShutdownProof !== null &&
        starterTimeline !== null &&
        bootstrapStatus !== null &&
        databaseOpenMs !== null &&
        healthRefreshMs !== null &&
        localVisibilityStatus !== null &&
        commandTimelineProofStatus !== null &&
        realtimeStatus !== null &&
        schemaReadinessMs !== null &&
        supportBundleExportMs !== null &&
        supportBundleRedacted === 'true' &&
        supportBundleSectionCount >= 4 &&
        !databaseOpening &&
        !preflightFailure,
      errors,
      markers: {
        durableHealthLine,
        schemaLine,
        preflightFailure,
        databaseOpening,
      },
      browserHealth: {
        blockedOperationCount: browserHealthBlockedOperationCount,
        generatedMutation:
          browserHealthGeneratedMutation === ''
            ? null
            : browserHealthGeneratedMutation,
        lifecycleStage:
          browserHealthLifecycleStage === ''
            ? null
            : browserHealthLifecycleStage,
        localVisibility:
          browserHealthLocalVisibility === ''
            ? null
            : browserHealthLocalVisibility,
        recoveryOwner:
          browserHealthRecoveryOwner === ''
            ? null
            : browserHealthRecoveryOwner,
        status: browserHealthStatus === '' ? null : browserHealthStatus,
        syncNow: browserHealthSyncNow === '' ? null : browserHealthSyncNow,
      },
      deploymentPreflight: {
        actionCount: deploymentPreflightActionCount,
        availableBytes: deploymentPreflightAvailableBytes,
        issueCount: deploymentPreflightIssueCount,
        minimumAvailableBytes: deploymentPreflightMinimumAvailableBytes,
        minimumQuotaBytes: deploymentPreflightMinimumQuotaBytes,
        persistence: deploymentPreflightPersistence,
        persisted: deploymentPreflightPersisted,
        preflightMs: deploymentPreflightPreflightMs,
        quotaPressure: deploymentPreflightQuotaPressure,
        quotaBytes: deploymentPreflightQuotaBytes,
        serviceWorker: deploymentPreflightServiceWorker,
        serviceWorkerControlled: deploymentPreflightServiceWorkerControlled,
        serviceWorkerControllerScriptPath:
          deploymentPreflightServiceWorkerControllerScriptPath,
        serviceWorkerControllerState:
          deploymentPreflightServiceWorkerControllerState,
        status: deploymentPreflightStatus,
        supportTier: deploymentPreflightSupportTier,
        usageRatio: deploymentPreflightUsageRatio,
        usageBytes: deploymentPreflightUsageBytes,
      },
      browserSupportPolicy: {
        actionCount: browserSupportPolicyActionCount,
        context: browserSupportPolicyContext,
        expectedPersistence: browserSupportPolicyExpectedPersistence,
        expectedSupportTier: browserSupportPolicyExpectedSupportTier,
        issueCount: browserSupportPolicyIssueCount,
        knownRisks: browserSupportPolicyKnownRisks,
        knownRiskCount: browserSupportPolicyKnownRiskCount,
        nextSteps: browserSupportPolicyNextSteps,
        nextStepCount: browserSupportPolicyNextStepCount,
        observedPersistence: browserSupportPolicyObservedPersistence,
        observedSupportTier: browserSupportPolicyObservedSupportTier,
        policy: browserSupportPolicyPolicy,
        preflightRequired: browserSupportPolicyPreflightRequired,
        reasonCodes: browserSupportPolicyReasonCodes,
        reasonCount: browserSupportPolicyReasonCount,
        requiredEvidence: browserSupportPolicyRequiredEvidence,
        requiredEvidenceCount: browserSupportPolicyRequiredEvidenceCount,
        status: browserSupportPolicyStatus,
      },
      supportBundle: {
        status: supportBundleStatus,
        redacted: supportBundleRedacted,
        sectionCount: supportBundleSectionCount,
        issueCount: supportBundleIssueCount,
        blobEventCount: supportBundleBlobEventCount,
        cursorCount: supportBundleCursorCount,
        latestBlobCode: supportBundleLatestBlobCode,
        latestLocalApplyCode: supportBundleLatestLocalApplyCode,
        latestRealtimeCode: supportBundleLatestRealtimeCode,
        latestSyncCode: supportBundleLatestSyncCode,
        localApplyEventCount: supportBundleLocalApplyEventCount,
        realtimeEventCount: supportBundleRealtimeEventCount,
        requestIdCount: supportBundleRequestIdCount,
        sectionErrorCount: supportBundleSectionErrorCount,
        syncAttemptIdCount: supportBundleSyncAttemptIdCount,
        syncEventCount: supportBundleSyncEventCount,
        timelineEventCount: supportBundleTimelineEventCount,
      },
      commandTimelineProof: {
        clientCommitId:
          commandTimelineProofClientCommitId === ''
            ? null
            : commandTimelineProofClientCommitId,
        complete: commandTimelineProofComplete,
        contextEventCount: commandTimelineProofContextEventCount,
        count: commandTimelineProofCount,
        durationMs: commandTimelineProofDurationMs,
        error:
          commandTimelineProofError === '' ? null : commandTimelineProofError,
        errorCode:
          commandTimelineProofErrorCode === ''
            ? null
            : commandTimelineProofErrorCode,
        eventCount: commandTimelineProofEventCount,
        localApplyObserved: commandTimelineProofLocalApplyObserved,
        localApplyCommitSeq: commandTimelineProofLocalApplyCommitSeq,
        localApplyOutboxId: commandTimelineProofLocalApplyOutboxId,
        localVisibilityObserved: commandTimelineProofLocalVisibilityObserved,
        localVisibilitySource: commandTimelineProofLocalVisibilitySource,
        localVisibilityState:
          commandTimelineProofLocalVisibilityState === ''
            ? null
            : commandTimelineProofLocalVisibilityState,
        localVisibilityTrigger:
          commandTimelineProofLocalVisibilityTrigger === ''
            ? null
            : commandTimelineProofLocalVisibilityTrigger,
        matchedEventCount: commandTimelineProofMatchedEventCount,
        missingEvidence: commandTimelineProofMissingEvidence,
        missingEvidenceCount: commandTimelineProofMissingEvidenceCount,
        outboxPersisted: commandTimelineProofOutboxPersisted,
        pullReasonObserved: commandTimelineProofPullReasonObserved,
        pullReason: commandTimelineProofPullReason,
        realtimeCursorObserved: commandTimelineProofRealtimeCursorObserved,
        realtimeCursor: commandTimelineProofRealtimeCursor,
        requestCorrelated: commandTimelineProofRequestCorrelated,
        requestId: commandTimelineProofRequestId,
        serverCommitObserved: commandTimelineProofServerCommitObserved,
        serverCommitSeq: commandTimelineProofServerCommitSeq,
        scopeJoined: commandTimelineProofScopeJoined,
        state:
          commandTimelineProofState === ''
            ? null
            : commandTimelineProofState,
        status: commandTimelineProofStatus,
        subscriptionIdCount: commandTimelineProofSubscriptionIds.length,
        subscriptionIds: commandTimelineProofSubscriptionIds,
        syncAttemptId: commandTimelineProofSyncAttemptId,
        syncAttemptObserved: commandTimelineProofSyncAttemptObserved,
        traceId: commandTimelineProofTraceId,
        spanId: commandTimelineProofSpanId,
      },
      lifecycleResume: {
        status: lifecycleResumeStatus,
        count: lifecycleResumeCount,
        reason: lifecycleResumeReason,
        error: lifecycleResumeError,
        lockName: lifecycleResumeLockName,
        lockRequired: lifecycleResumeLockRequired,
        lockState: lifecycleResumeLockState,
        lockTimeoutMs: lifecycleResumeLockTimeoutMs,
      },
      lifecyclePause: {
        count: lifecyclePauseCount,
        reason: lifecyclePauseReason,
        pagehidePersisted: lifecyclePausePagehidePersisted,
        shutdownSignalCount: lifecyclePauseShutdownSignalCount,
        visibilityState: lifecyclePauseVisibilityState,
      },
      localRecoveryProof: {
        actionKind: localRecoveryProofActionKind === '' ? null : localRecoveryProofActionKind,
        count: localRecoveryProofCount,
        error: localRecoveryProofError === '' ? null : localRecoveryProofError,
        errorCode: localRecoveryProofErrorCode === '' ? null : localRecoveryProofErrorCode,
        lockName: localRecoveryProofLockName === '' ? null : localRecoveryProofLockName,
        lockRequired: localRecoveryProofLockRequired,
        lockState: localRecoveryProofLockState,
        lockTimeoutMs: localRecoveryProofLockTimeoutMs,
        status: localRecoveryProofStatus,
      },
      storageRecoveryProof: {
        actionKinds: storageRecoveryProofActionKinds,
        availableBytes: storageRecoveryProofAvailableBytes,
        clearBlobCacheCompleted:
          storageRecoveryProofClearBlobCacheCompleted,
        compactCompleted: storageRecoveryProofCompactCompleted,
        count: storageRecoveryProofCount,
        dataLossConsequenceCount: storageRecoveryProofDataLossConsequenceCount,
        destructiveSafetyCount: storageRecoveryProofDestructiveSafetyCount,
        error:
          storageRecoveryProofError === ''
            ? null
            : storageRecoveryProofError,
        errorCode:
          storageRecoveryProofErrorCode === ''
            ? null
            : storageRecoveryProofErrorCode,
        issueCodes: storageRecoveryProofIssueCodes,
        issueCount: storageRecoveryProofIssueCount,
        planActionCount: storageRecoveryProofPlanActionCount,
        quotaBytes: storageRecoveryProofQuotaBytes,
        quotaPressure:
          storageRecoveryProofQuotaPressure === ''
            ? null
            : storageRecoveryProofQuotaPressure,
        requestPersistenceGranted:
          storageRecoveryProofRequestPersistenceGranted === ''
            ? null
            : storageRecoveryProofRequestPersistenceGranted,
        requestPersistenceOffered:
          storageRecoveryProofRequestPersistenceOffered,
        requestPersistenceSupported:
          storageRecoveryProofRequestPersistenceSupported === ''
            ? null
            : storageRecoveryProofRequestPersistenceSupported,
        source:
          storageRecoveryProofSource === ''
            ? null
            : storageRecoveryProofSource,
        status: storageRecoveryProofStatus,
        outboxSafetyStatus:
          storageRecoveryProofOutboxSafetyStatus === ''
            ? null
            : storageRecoveryProofOutboxSafetyStatus,
        usageBytes: storageRecoveryProofUsageBytes,
        usageRatio: storageRecoveryProofUsageRatio,
      },
      quotaPressureProof: {
        actionCount: quotaPressureProofActionCount,
        availableBytes: quotaPressureProofAvailableBytes,
        count: quotaPressureProofCount,
        error:
          quotaPressureProofError === '' ? null : quotaPressureProofError,
        errorCode:
          quotaPressureProofErrorCode === ''
            ? null
            : quotaPressureProofErrorCode,
        issueCodes: quotaPressureProofIssueCodes,
        issueCount: quotaPressureProofIssueCount,
        persistence:
          quotaPressureProofPersistence === ''
            ? null
            : quotaPressureProofPersistence,
        quotaBytes: quotaPressureProofQuotaBytes,
        quotaPressure:
          quotaPressureProofQuotaPressure === ''
            ? null
            : quotaPressureProofQuotaPressure,
        status: quotaPressureProofStatus,
        supportTier:
          quotaPressureProofSupportTier === ''
            ? null
            : quotaPressureProofSupportTier,
        usageBytes: quotaPressureProofUsageBytes,
        usageRatio: quotaPressureProofUsageRatio,
      },
      writePressureProof: {
        durationMs: writePressureProofDurationMs,
        error: writePressureProofError === '' ? null : writePressureProofError,
        errorCode: writePressureProofErrorCode === '' ? null : writePressureProofErrorCode,
        requestedCount: writePressureProofRequestedCount,
        runCount: writePressureProofRunCount,
        status: writePressureProofStatus,
        titlePrefix: writePressureProofTitlePrefix === '' ? null : writePressureProofTitlePrefix,
        visibleCount: writePressureProofVisibleCount,
      },
      quotaExhaustionWriteProof: {
        attemptedBytes: quotaExhaustionWriteProofAttemptedBytes,
        availableBytes: quotaExhaustionWriteProofAvailableBytes,
        count: quotaExhaustionWriteProofCount,
        durationMs: quotaExhaustionWriteProofDurationMs,
        error:
          quotaExhaustionWriteProofError === ''
            ? null
            : quotaExhaustionWriteProofError,
        errorCode:
          quotaExhaustionWriteProofErrorCode === ''
            ? null
            : quotaExhaustionWriteProofErrorCode,
        quotaBytes: quotaExhaustionWriteProofQuotaBytes,
        status: quotaExhaustionWriteProofStatus,
        usageBytes: quotaExhaustionWriteProofUsageBytes,
        usageRatio: quotaExhaustionWriteProofUsageRatio,
        writeFailed: quotaExhaustionWriteProofWriteFailed,
      },
      storageShutdownProof: {
        closed: storageShutdownProofClosed,
        count: storageShutdownProofCount,
        durationMs: storageShutdownProofDurationMs,
        error:
          storageShutdownProofError === ''
            ? null
            : storageShutdownProofError,
        errorCode:
          storageShutdownProofErrorCode === ''
            ? null
            : storageShutdownProofErrorCode,
        lifecyclePhase:
          storageShutdownProofLifecyclePhase === ''
            ? null
            : storageShutdownProofLifecyclePhase,
        mutationRejected: storageShutdownProofMutationRejected,
        postCloseErrorCode:
          storageShutdownProofPostCloseErrorCode === ''
            ? null
            : storageShutdownProofPostCloseErrorCode,
        status: storageShutdownProofStatus,
      },
      starterTimeline: {
        bootstrapReadyMs,
        bootstrapStatus,
        commandTimelineStatus,
        databaseOpenMs,
        healthRefreshMs,
        localVisibilityErrorCode,
        localVisibilityMs,
        localVisibilityStatus,
        marker: starterTimeline !== null,
        realtimeConnectedMs,
        realtimeStatus,
        schemaReadinessMs,
        supportBundleExportMs,
      },
      starterOpen: {
        diagnosticCode: starterOpenDiagnosticCode === '' ? null : starterOpenDiagnosticCode,
        diagnosticCount: starterOpenDiagnosticCount,
        diagnosticLevel: starterOpenDiagnosticLevel === '' ? null : starterOpenDiagnosticLevel,
        diagnosticSource: starterOpenDiagnosticSource === '' ? null : starterOpenDiagnosticSource,
        error: starterOpenError === '' ? null : starterOpenError,
        phase: starterOpenPhase,
      },
      textExcerpt: text.slice(0, 4000),
    };
  })()`);
}

async function waitForStarterBrowserReady(
  session: CdpSession,
  failureArtifactPath: string,
  failureMetrics: BrowserPreviewFailureMetricsInput
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    let evaluation: BrowserPreviewProbe;
    try {
      evaluation = await readStarterBrowserProbe(session);
    } catch (error) {
      await writeBrowserPreviewFailureArtifact(
        failureArtifactPath,
        'readiness-probe-error',
        lastProbe,
        failureMetrics
      );
      throw new Error(
        `Built preview browser readiness probe failed: ${describeError(
          error
        )}. Failure artifact: ${failureArtifactPath}`
      );
    }
    lastProbe = evaluation;
    if (evaluation.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        failureArtifactPath,
        'page-reported-errors',
        evaluation,
        failureMetrics
      );
      throw new Error(
        `Built preview browser smoke failed: ${evaluation.errors.join(
          ', '
        )}. Failure artifact: ${failureArtifactPath}`
      );
    }
    if (evaluation.ready) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  await writeBrowserPreviewFailureArtifact(
    failureArtifactPath,
    'readiness-timeout',
    lastProbe,
    failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview browser readiness. Failure artifact: ${failureArtifactPath}`
  );
}

async function proveStarterBrowserLifecycleResume(
  session: CdpSession,
  failureArtifactPath: string,
  failureMetrics: BrowserPreviewFailureMetricsInput
): Promise<void> {
  const initialProbe = await readStarterBrowserProbe(session);

  const visibilityPauseCount = initialProbe.lifecyclePause.count + 1;
  await dispatchStarterVisibilityChange(session, 'hidden');
  await waitForStarterLifecyclePause({
    expectedCount: visibilityPauseCount,
    expectedReason: 'visibilitychange',
    expectedVisibilityState: 'hidden',
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-visibility-hidden-timeout',
  });

  const visibilityResumeCount = initialProbe.lifecycleResume.count + 1;
  await dispatchStarterVisibilityChange(session, 'visible');
  await waitForStarterLifecycleResume({
    expectedCount: visibilityResumeCount,
    expectedReason: 'visibilitychange',
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-visibility-visible-timeout',
  });

  const pagehideCount = visibilityPauseCount + 1;
  await session.evaluate(`(() => {
    let event;
    if (typeof PageTransitionEvent === 'function') {
      event = new PageTransitionEvent('pagehide', { persisted: true });
    } else {
      event = new Event('pagehide');
      Object.defineProperty(event, 'persisted', { value: true });
    }
    window.dispatchEvent(event);
    return true;
  })()`);
  await waitForStarterLifecyclePause({
    expectedCount: pagehideCount,
    expectedPagehidePersisted: 'true',
    expectedReason: 'pagehide',
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-pagehide-timeout',
  });

  const pageshowCount = visibilityResumeCount + 1;
  await session.evaluate(`(() => {
    const event =
      typeof PageTransitionEvent === 'function'
        ? new PageTransitionEvent('pageshow', { persisted: true })
        : new Event('pageshow');
    window.dispatchEvent(event);
    return true;
  })()`);
  await waitForStarterLifecycleResume({
    expectedCount: pageshowCount,
    expectedReason: 'pageshow',
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-pageshow-timeout',
  });

  await session.evaluate(`(() => {
    window.dispatchEvent(new Event('online'));
    return true;
  })()`);
  await waitForStarterLifecycleResume({
    expectedCount: pageshowCount + 1,
    expectedReason: 'online',
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-online-timeout',
  });

  const freezeCount = pagehideCount + 1;
  await session.evaluate(`(() => {
    window.dispatchEvent(new Event('freeze'));
    return true;
  })()`);
  await waitForStarterLifecyclePause({
    expectedCount: freezeCount,
    expectedReason: 'freeze',
    expectedVisibilityState: 'visible',
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-freeze-timeout',
  });

  await session.evaluate(`(() => {
    window.dispatchEvent(new Event('resume'));
    return true;
  })()`);
  await waitForStarterLifecycleResume({
    expectedCount: pageshowCount + 2,
    expectedReason: 'resume',
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-resume-event-timeout',
  });

  const beforeCdpLifecycle = await readStarterBrowserProbe(session);
  const cdpLifecycleSuspensionCount =
    session.chromeLifecycleSuspensionCount() + 1;
  const cdpLifecycleResumeCount = beforeCdpLifecycle.lifecycleResume.count + 1;
  await setStarterChromeWebLifecycleState(session, 'frozen');
  await setStarterChromeWebLifecycleState(session, 'active');
  await waitForStarterChromeLifecycleSuspension({
    expectedCount: cdpLifecycleSuspensionCount,
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-cdp-suspension-timeout',
  });
  await waitForStarterLifecycleResume({
    expectedCount: cdpLifecycleResumeCount,
    expectedReason: 'visibilitychange',
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-cdp-active-timeout',
  });

  await session.evaluate(`(() => {
    window.dispatchEvent(new Event('beforeunload'));
    return true;
  })()`);
  await waitForStarterLifecyclePause({
    expectedCount: freezeCount + 1,
    expectedReason: 'beforeunload',
    expectedShutdownSignalCount: 1,
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-beforeunload-timeout',
  });
}

async function proveStarterBrowserTargetActivationLifecycle(args: {
  active: CdpSession;
  background: CdpSession;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
}): Promise<void> {
  const initialProbe = await readStarterBrowserProbe(args.active);
  const initialVisibility = await readChromeDocumentVisibilityState(
    args.active
  );

  await bringChromeTargetToFront(args.active);
  await waitForStarterDocumentVisibility({
    expectedState: 'visible',
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.active,
    timeoutReason: 'lifecycle-target-initial-visible-timeout',
  });
  if (initialVisibility === 'hidden') {
    await waitForStarterLifecycleResume({
      expectedCount: initialProbe.lifecycleResume.count + 1,
      expectedReason: 'visibilitychange',
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.active,
      timeoutReason: 'lifecycle-target-initial-foreground-timeout',
    });
  }

  const beforeBackground = await readStarterBrowserProbe(args.active);
  await bringChromeTargetToFront(args.background);
  await waitForStarterDocumentVisibility({
    expectedState: 'hidden',
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.active,
    timeoutReason: 'lifecycle-target-background-visibility-timeout',
  });
  await waitForStarterLifecyclePause({
    expectedCount: beforeBackground.lifecyclePause.count + 1,
    expectedReason: 'visibilitychange',
    expectedVisibilityState: 'hidden',
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.active,
    timeoutReason: 'lifecycle-target-background-pause-timeout',
  });

  const beforeForeground = await readStarterBrowserProbe(args.active);
  await bringChromeTargetToFront(args.active);
  await waitForStarterDocumentVisibility({
    expectedState: 'visible',
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.active,
    timeoutReason: 'lifecycle-target-foreground-visibility-timeout',
  });
  await waitForStarterLifecycleResume({
    expectedCount: beforeForeground.lifecycleResume.count + 1,
    expectedReason: 'visibilitychange',
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.active,
    timeoutReason: 'lifecycle-target-foreground-resume-timeout',
  });
}

async function setStarterChromeWebLifecycleState(
  session: CdpSession,
  state: 'active' | 'frozen'
): Promise<void> {
  await session.send('Page.setWebLifecycleState', { state });
}

async function bringChromeTargetToFront(session: CdpSession): Promise<void> {
  await session.send('Page.bringToFront');
}

async function readChromeDocumentVisibilityState(
  session: CdpSession
): Promise<string | null> {
  return session.evaluate<string | null>(`(() => {
    return typeof document.visibilityState === 'string'
      ? document.visibilityState
      : null;
  })()`);
}

async function waitForStarterDocumentVisibility(args: {
  expectedState: 'hidden' | 'visible';
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
  timeoutReason: string;
}): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    try {
      const visibilityState = await readChromeDocumentVisibilityState(
        args.session
      );
      if (visibilityState === args.expectedState) return;
    } catch {
      // Keep polling through transient execution-context changes while Chrome
      // moves the page between foreground and background targets.
    }
    try {
      lastProbe = await readStarterBrowserProbe(args.session);
    } catch {
      // A transient probe failure should not hide a later successful
      // visibility transition.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    args.timeoutReason,
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview document.visibilityState=${args.expectedState}. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function waitForStarterChromeLifecycleSuspension(args: {
  expectedCount: number;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
  timeoutReason: string;
}): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    if (args.session.chromeLifecycleSuspensionCount() >= args.expectedCount) {
      return;
    }
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'lifecycle-cdp-suspension-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview Chrome lifecycle suspension failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    args.timeoutReason,
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview Chrome lifecycle suspension. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function proveStarterLifecycleLockContention(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  session: CdpSession;
}): Promise<void> {
  const before = await readStarterBrowserProbe(args.session);
  const holdResult = await holdStarterLifecycleResumeLock(args.session);
  if (!holdResult.ok) {
    await writeBrowserPreviewFailureArtifact(
      args.failureArtifactPath,
      'lifecycle-lock-contention-setup-failed',
      before,
      args.failureMetrics
    );
    throw new Error(
      `Could not hold built preview lifecycle Web Lock (${holdResult.reason}). Failure artifact: ${args.failureArtifactPath}`
    );
  }

  let timeoutProbe: BrowserPreviewProbe | null = null;
  try {
    await dispatchStarterOnlineEvent(args.session);
    timeoutProbe = await waitForStarterLifecycleLockTimeout({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.session,
    });
  } finally {
    await releaseStarterLifecycleResumeLock(args.session);
  }

  await dispatchStarterOnlineEvent(args.session);
  await waitForStarterLifecycleResume({
    expectedCount: (timeoutProbe ?? before).lifecycleResume.count + 1,
    expectedReason: 'online',
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    ignoreLifecycleResumeFailure: true,
    session: args.session,
    timeoutReason: 'lifecycle-lock-contention-recovery-timeout',
  });
}

async function proveStarterLocalRecoveryLockContention(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  session: CdpSession;
}): Promise<void> {
  const before = await readStarterBrowserProbe(args.session);
  const holdResult = await holdStarterLocalRecoveryLock(args.session);
  if (!holdResult.ok) {
    await writeBrowserPreviewFailureArtifact(
      args.failureArtifactPath,
      'local-recovery-lock-contention-setup-failed',
      before,
      args.failureMetrics
    );
    throw new Error(
      `Could not hold built preview local recovery Web Lock (${holdResult.reason}). Failure artifact: ${args.failureArtifactPath}`
    );
  }

  let timeoutProbe: BrowserPreviewProbe | null = null;
  try {
    await dispatchStarterLocalRecoveryProof(args.session);
    timeoutProbe = await waitForStarterLocalRecoveryLockTimeout({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.session,
    });
  } finally {
    await releaseStarterLocalRecoveryLock(args.session);
  }

  await dispatchStarterLocalRecoveryProof(args.session);
  await waitForStarterLocalRecoveryCompletion({
    expectedCount: (timeoutProbe ?? before).localRecoveryProof.count + 1,
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.session,
  });
}

async function dispatchStarterLocalRecoveryProof(
  session: CdpSession
): Promise<void> {
  await session.evaluate(`(() => {
    window.dispatchEvent(
      new Event('syncular-starter-run-local-recovery-proof')
    );
    return true;
  })()`);
}

async function proveStarterStorageRecoveryActionMapping(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  session: CdpSession;
}): Promise<void> {
  const before = await readStarterBrowserProbe(args.session);
  await dispatchStarterStorageRecoveryProof(args.session);
  await waitForStarterStorageRecoveryCompletion({
    expectedCount: before.storageRecoveryProof.count + 1,
    expectedSource: 'synthetic',
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    requireObservedQuotaPressure: false,
    session: args.session,
  });
}

async function dispatchStarterStorageRecoveryProof(
  session: CdpSession,
  quotaPressure?: StarterOriginQuotaPressure
): Promise<void> {
  await session.evaluate(`(() => {
    window.dispatchEvent(
      new CustomEvent('syncular-starter-run-storage-recovery-proof', {
        detail: ${JSON.stringify(
          quotaPressure
            ? {
                availableBytes: quotaPressure.availableBytes,
                overrideActive: quotaPressure.overrideActive,
                quotaBytes: quotaPressure.quotaBytes,
                source: 'chrome-devtools-protocol',
                usageBytes: quotaPressure.usageBytes,
                usageRatio: quotaPressure.usageRatio,
              }
            : null
        )},
      })
    );
    return true;
  })()`);
}

async function waitForStarterStorageRecoveryCompletion(args: {
  expectedCount: number;
  expectedSource?: 'synthetic' | 'browser-observed';
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  requireObservedQuotaPressure?: boolean;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'storage-recovery-action-mapping-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview storage recovery action mapping failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const actionKinds = new Set(probe.storageRecoveryProof.actionKinds);
    const clearBlobCacheOffered = actionKinds.has('clear-blob-cache');
    if (
      probe.storageRecoveryProof.status === 'complete' &&
      probe.storageRecoveryProof.count >= args.expectedCount &&
      probe.storageRecoveryProof.planActionCount >= 2 &&
      actionKinds.has('request-persistent-storage') &&
      actionKinds.has('compact-storage') &&
      probe.storageRecoveryProof.requestPersistenceOffered === 'true' &&
      probe.storageRecoveryProof.requestPersistenceSupported === 'true' &&
      probe.storageRecoveryProof.requestPersistenceGranted === 'true' &&
      probe.storageRecoveryProof.compactCompleted === 'true' &&
      (args.expectedSource == null ||
        probe.storageRecoveryProof.source === args.expectedSource) &&
      (args.requireObservedQuotaPressure !== true ||
        (probe.storageRecoveryProof.quotaPressure === 'high' &&
          probe.storageRecoveryProof.issueCodes.includes(
            'browser.storage_pressure_high'
          ) &&
          probe.storageRecoveryProof.usageRatio !== null &&
          probe.storageRecoveryProof.usageRatio >= 0.9 &&
          probe.storageRecoveryProof.quotaBytes !== null &&
          probe.storageRecoveryProof.usageBytes !== null &&
          probe.storageRecoveryProof.availableBytes !== null &&
          probe.storageRecoveryProof.issueCount >= 1)) &&
      (clearBlobCacheOffered
        ? probe.storageRecoveryProof.clearBlobCacheCompleted === 'true' &&
          probe.storageRecoveryProof.destructiveSafetyCount >= 1 &&
          probe.storageRecoveryProof.dataLossConsequenceCount >= 1 &&
          probe.storageRecoveryProof.outboxSafetyStatus === 'empty'
        : probe.storageRecoveryProof.clearBlobCacheCompleted === 'false')
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'storage-recovery-action-mapping-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview storage recovery action mapping. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function holdStarterLocalRecoveryLock(
  session: CdpSession
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return session.evaluate<
    { ok: true } | { ok: false; reason: string }
  >(`(async () => {
    const lockName = ${JSON.stringify(STARTER_LOCAL_RECOVERY_LOCK_NAME)};
    const locks = globalThis.navigator?.locks;
    if (typeof locks?.request !== 'function') {
      return { ok: false, reason: 'web-locks-unavailable' };
    }
    const existingRelease =
      globalThis.__syncularStarterHeldLocalRecoveryLockRelease;
    if (typeof existingRelease === 'function') {
      existingRelease();
      try {
        await globalThis.__syncularStarterHeldLocalRecoveryLockPromise;
      } catch {
        // Ignore cleanup errors from a previous setup attempt.
      }
    }
    globalThis.__syncularStarterHeldLocalRecoveryLockAcquired = false;
    globalThis.__syncularStarterHeldLocalRecoveryLockPromise = locks.request(
      lockName,
      { mode: 'exclusive' },
      () =>
        new Promise((resolve) => {
          globalThis.__syncularStarterHeldLocalRecoveryLockAcquired = true;
          globalThis.__syncularStarterHeldLocalRecoveryLockRelease = () => {
            globalThis.__syncularStarterHeldLocalRecoveryLockRelease = null;
            resolve(true);
          };
        })
    );
    globalThis.__syncularStarterHeldLocalRecoveryLockPromise.catch(
      () => undefined
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (
        globalThis.__syncularStarterHeldLocalRecoveryLockAcquired === true &&
        typeof globalThis.__syncularStarterHeldLocalRecoveryLockRelease ===
          'function'
      ) {
        return { ok: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: false, reason: 'lock-acquire-timeout' };
  })()`);
}

async function releaseStarterLocalRecoveryLock(
  session: CdpSession
): Promise<void> {
  await session.evaluate(`(async () => {
    const release = globalThis.__syncularStarterHeldLocalRecoveryLockRelease;
    if (typeof release !== 'function') return true;
    release();
    try {
      await Promise.race([
        globalThis.__syncularStarterHeldLocalRecoveryLockPromise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    } catch {
      // The smoke only needs the lock released; cleanup rejections are nonfatal.
    }
    return true;
  })()`);
}

async function waitForStarterLocalRecoveryLockTimeout(args: {
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<BrowserPreviewProbe> {
  const deadline = Date.now() + STARTER_LOCAL_RECOVERY_LOCK_TIMEOUT_MS + 7_500;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'local-recovery-lock-contention-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview local recovery lock contention failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const errorText = probe.localRecoveryProof.error ?? '';
    if (
      probe.localRecoveryProof.status === 'failed' &&
      probe.localRecoveryProof.actionKind === 'export-support-bundle' &&
      probe.localRecoveryProof.errorCode ===
        'syncular.local_recovery_web_locks_timeout' &&
      probe.localRecoveryProof.lockName === STARTER_LOCAL_RECOVERY_LOCK_NAME &&
      probe.localRecoveryProof.lockState === 'timed-out' &&
      probe.localRecoveryProof.lockTimeoutMs ===
        STARTER_LOCAL_RECOVERY_LOCK_TIMEOUT_MS &&
      errorText.includes('Timed out waiting')
    ) {
      return probe;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'local-recovery-lock-contention-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview local recovery Web Lock contention. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function waitForStarterLocalRecoveryCompletion(args: {
  expectedCount: number;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'local-recovery-completion-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview local recovery completion failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    if (
      probe.localRecoveryProof.status === 'complete' &&
      probe.localRecoveryProof.count >= args.expectedCount &&
      probe.localRecoveryProof.actionKind === 'export-support-bundle' &&
      probe.localRecoveryProof.lockName === STARTER_LOCAL_RECOVERY_LOCK_NAME &&
      probe.localRecoveryProof.lockState === 'acquired' &&
      probe.localRecoveryProof.lockTimeoutMs ===
        STARTER_LOCAL_RECOVERY_LOCK_TIMEOUT_MS
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'local-recovery-completion-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview local recovery completion. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function holdStarterLifecycleResumeLock(
  session: CdpSession
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return session.evaluate<
    { ok: true } | { ok: false; reason: string }
  >(`(async () => {
    const lockName = ${JSON.stringify(STARTER_LIFECYCLE_RESUME_LOCK_NAME)};
    const locks = globalThis.navigator?.locks;
    if (typeof locks?.request !== 'function') {
      return { ok: false, reason: 'web-locks-unavailable' };
    }
    const existingRelease =
      globalThis.__syncularStarterHeldLifecycleLockRelease;
    if (typeof existingRelease === 'function') {
      existingRelease();
      try {
        await globalThis.__syncularStarterHeldLifecycleLockPromise;
      } catch {
        // Ignore cleanup errors from a previous setup attempt.
      }
    }
    globalThis.__syncularStarterHeldLifecycleLockAcquired = false;
    globalThis.__syncularStarterHeldLifecycleLockPromise = locks.request(
      lockName,
      { mode: 'exclusive' },
      () =>
        new Promise((resolve) => {
          globalThis.__syncularStarterHeldLifecycleLockAcquired = true;
          globalThis.__syncularStarterHeldLifecycleLockRelease = () => {
            globalThis.__syncularStarterHeldLifecycleLockRelease = null;
            resolve(true);
          };
        })
    );
    globalThis.__syncularStarterHeldLifecycleLockPromise.catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (
        globalThis.__syncularStarterHeldLifecycleLockAcquired === true &&
        typeof globalThis.__syncularStarterHeldLifecycleLockRelease === 'function'
      ) {
        return { ok: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: false, reason: 'lock-acquire-timeout' };
  })()`);
}

async function releaseStarterLifecycleResumeLock(
  session: CdpSession
): Promise<void> {
  await session.evaluate(`(async () => {
    const release = globalThis.__syncularStarterHeldLifecycleLockRelease;
    if (typeof release !== 'function') return true;
    release();
    try {
      await Promise.race([
        globalThis.__syncularStarterHeldLifecycleLockPromise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    } catch {
      // The smoke only needs the lock released; cleanup rejections are nonfatal.
    }
    return true;
  })()`);
}

async function waitForStarterLifecycleLockTimeout(args: {
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<BrowserPreviewProbe> {
  const deadline =
    Date.now() + STARTER_LIFECYCLE_RESUME_LOCK_TIMEOUT_MS + 7_500;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    const unexpectedErrors = probe.errors.filter(
      (error) => error !== 'lifecycle resume failed'
    );
    if (unexpectedErrors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'lifecycle-lock-contention-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview lifecycle lock contention failed: ${unexpectedErrors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const errorText = probe.lifecycleResume.error ?? '';
    if (
      probe.lifecycleResume.status === 'failed' &&
      probe.lifecycleResume.reason === 'online' &&
      probe.lifecycleResume.lockName === STARTER_LIFECYCLE_RESUME_LOCK_NAME &&
      probe.lifecycleResume.lockState === 'timed-out' &&
      probe.lifecycleResume.lockTimeoutMs ===
        STARTER_LIFECYCLE_RESUME_LOCK_TIMEOUT_MS &&
      errorText.includes('Timed out waiting')
    ) {
      return probe;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'lifecycle-lock-contention-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview lifecycle Web Lock contention. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function waitForStarterLifecycleResume(args: {
  expectedCount: number;
  expectedReason: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  ignoreLifecycleResumeFailure?: boolean;
  session: CdpSession;
  timeoutReason: string;
}): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    const errors =
      args.ignoreLifecycleResumeFailure === true
        ? probe.errors.filter((error) => error !== 'lifecycle resume failed')
        : probe.errors;
    if (errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'lifecycle-resume-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview lifecycle resume failed: ${errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    if (
      probe.lifecycleResume.status === 'complete' &&
      probe.lifecycleResume.count >= args.expectedCount &&
      probe.lifecycleResume.reason === args.expectedReason
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    args.timeoutReason,
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview lifecycle resume (${args.expectedReason}). Failure artifact: ${args.failureArtifactPath}`
  );
}

async function waitForStarterLifecyclePause(args: {
  expectedCount: number;
  expectedPagehidePersisted?: string;
  expectedReason: string;
  expectedShutdownSignalCount?: number;
  expectedVisibilityState?: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
  timeoutReason: string;
}): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'lifecycle-pause-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview lifecycle pause failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const pagehidePersistedMatches =
      args.expectedPagehidePersisted === undefined ||
      probe.lifecyclePause.pagehidePersisted === args.expectedPagehidePersisted;
    const shutdownSignalMatches =
      args.expectedShutdownSignalCount === undefined ||
      probe.lifecyclePause.shutdownSignalCount >=
        args.expectedShutdownSignalCount;
    const visibilityStateMatches =
      args.expectedVisibilityState === undefined ||
      probe.lifecyclePause.visibilityState === args.expectedVisibilityState;
    if (
      probe.lifecyclePause.count >= args.expectedCount &&
      probe.lifecyclePause.reason === args.expectedReason &&
      pagehidePersistedMatches &&
      shutdownSignalMatches &&
      visibilityStateMatches
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    args.timeoutReason,
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview lifecycle pause (${args.expectedReason}). Failure artifact: ${args.failureArtifactPath}`
  );
}

async function dispatchStarterVisibilityChange(
  session: CdpSession,
  visibilityState: 'hidden' | 'visible'
): Promise<void> {
  const result = await session.evaluate<{
    ok: boolean;
    visibilityState: string | null;
  }>(`(() => {
    const nextVisibilityState = ${JSON.stringify(visibilityState)};
    const defineVisibilityState = (target) => {
      try {
        Object.defineProperty(target, 'visibilityState', {
          configurable: true,
          get: () => nextVisibilityState,
        });
        return true;
      } catch {
        return false;
      }
    };
    const defined =
      defineVisibilityState(document) ||
      defineVisibilityState(Object.getPrototypeOf(document));
    const observed =
      typeof document.visibilityState === 'string'
        ? document.visibilityState
        : null;
    if (!defined || observed !== nextVisibilityState) {
      return { ok: false, visibilityState: observed };
    }
    document.dispatchEvent(new Event('visibilitychange'));
    return { ok: true, visibilityState: observed };
  })()`);
  if (!result.ok) {
    throw new Error(
      `Could not simulate document.visibilityState=${visibilityState}; observed ${result.visibilityState}`
    );
  }
}

async function proveStarterTwoTabLifecycleResumeCoordination(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  first: CdpSession;
  second: CdpSession;
}): Promise<void> {
  const [firstBefore, secondBefore] = await Promise.all([
    readStarterBrowserProbe(args.first),
    readStarterBrowserProbe(args.second),
  ]);

  await Promise.all([
    dispatchStarterOnlineEvent(args.first),
    dispatchStarterOnlineEvent(args.second),
  ]);

  await waitForStarterLifecycleResume({
    expectedCount: firstBefore.lifecycleResume.count + 1,
    expectedReason: 'online',
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.first,
    timeoutReason: 'two-tab-lifecycle-first-timeout',
  });
  await waitForStarterLifecycleResume({
    expectedCount: secondBefore.lifecycleResume.count + 1,
    expectedReason: 'online',
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.second,
    timeoutReason: 'two-tab-lifecycle-second-timeout',
  });

  const [firstAfter, secondAfter] = await Promise.all([
    readStarterBrowserProbe(args.first),
    readStarterBrowserProbe(args.second),
  ]);
  const firstLockReady = isStarterLifecycleResumeLockAcquired(firstAfter);
  const secondLockReady = isStarterLifecycleResumeLockAcquired(secondAfter);
  if (firstLockReady && secondLockReady) return;

  const probe = firstLockReady ? secondAfter : firstAfter;
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'two-tab-lifecycle-lock-state-mismatch',
    probe,
    args.failureMetrics
  );
  throw new Error(
    `Built preview two-tab lifecycle resume did not acquire the expected Web Lock. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function dispatchStarterOnlineEvent(session: CdpSession): Promise<void> {
  await session.evaluate(`(() => {
    window.dispatchEvent(new Event('online'));
    return true;
  })()`);
}

function isStarterLifecycleResumeLockAcquired(
  probe: BrowserPreviewProbe
): boolean {
  return (
    probe.lifecycleResume.status === 'complete' &&
    probe.lifecycleResume.reason === 'online' &&
    probe.lifecycleResume.lockName === STARTER_LIFECYCLE_RESUME_LOCK_NAME &&
    probe.lifecycleResume.lockState === 'acquired'
  );
}

async function proveStarterTwoTabPropagation(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  first: CdpSession;
  second: CdpSession;
}): Promise<string> {
  const title = `two-tab ${Date.now()}`;
  const before = await readStarterBrowserProbe(args.first);
  await submitStarterTask(args.first, title);

  await waitForStarterLocalVisibility({
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.first,
  });
  await waitForStarterCommandTimelineProof({
    expectedCount: before.commandTimelineProof.count + 1,
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.first,
  });

  await waitForStarterText({
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.second,
    title,
    errorReason: 'two-tab-propagation-errors',
    timeoutReason: 'two-tab-propagation-timeout',
    timeoutMessage: 'Timed out waiting for built preview two-tab propagation',
  });
  return title;
}

async function submitStarterTask(
  session: CdpSession,
  title: string
): Promise<void> {
  await session.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="New task"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Task input not found');
    }
    input.value = ${JSON.stringify(title)};
    const form = input.closest('form');
    if (!(form instanceof HTMLFormElement)) {
      throw new Error('Task form not found');
    }
    form.requestSubmit();
    return true;
  })()`);
}

async function waitForStarterText(args: {
  errorReason: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
  timeoutMessage: string;
  timeoutReason: string;
  title: string;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        args.errorReason,
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview text proof failed: ${probe.errors.join(', ')}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const visible = await args.session.evaluate<boolean>(
      `document.body?.innerText.includes(${JSON.stringify(args.title)}) ?? false`
    );
    if (visible) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    args.timeoutReason,
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `${args.timeoutMessage}. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function waitForStarterRenderedText(args: {
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
  timeoutMessage: string;
  timeoutReason: string;
  title: string;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const visible = await args.session.evaluate<boolean>(
      `document.body?.innerText.includes(${JSON.stringify(args.title)}) ?? false`
    );
    if (visible) return;
    try {
      lastProbe = await readStarterBrowserProbe(args.session);
    } catch {
      // Keep polling the rendered page; the final artifact can still use the
      // last successful probe if navigation or startup is briefly noisy.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    args.timeoutReason,
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `${args.timeoutMessage}. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function proveStarterGeneratedWritePressure(args: {
  active: CdpSession;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  observer: CdpSession;
}): Promise<void> {
  const before = await readStarterBrowserProbe(args.active);
  const titlePrefix = `write pressure ${Date.now()}`;
  await dispatchStarterWritePressureProof(args.active, {
    count: STARTER_WRITE_PRESSURE_PROOF_COUNT,
    titlePrefix,
  });
  await waitForStarterWritePressureCompletion({
    expectedRunCount: before.writePressureProof.runCount + 1,
    expectedTitlePrefix: titlePrefix,
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.active,
  });

  for (let index = 1; index <= STARTER_WRITE_PRESSURE_PROOF_COUNT; index += 1) {
    const title = `${titlePrefix} ${index}`;
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.active,
      title,
      errorReason: 'write-pressure-active-render-errors',
      timeoutReason: 'write-pressure-active-render-timeout',
      timeoutMessage:
        'Timed out waiting for built preview generated write pressure on the active tab',
    });
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.observer,
      title,
      errorReason: 'write-pressure-observer-render-errors',
      timeoutReason: 'write-pressure-observer-render-timeout',
      timeoutMessage:
        'Timed out waiting for built preview generated write pressure propagation',
    });
  }
}

async function dispatchStarterWritePressureProof(
  session: CdpSession,
  detail: { count: number; titlePrefix: string }
): Promise<void> {
  await session.evaluate(`(() => {
    window.dispatchEvent(
      new CustomEvent('syncular-starter-run-write-pressure-proof', {
        detail: ${JSON.stringify(detail)},
      })
    );
    return true;
  })()`);
}

async function waitForStarterWritePressureCompletion(args: {
  expectedRunCount: number;
  expectedTitlePrefix: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'write-pressure-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview generated write pressure failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    if (
      probe.writePressureProof.status === 'complete' &&
      probe.writePressureProof.runCount >= args.expectedRunCount &&
      probe.writePressureProof.requestedCount ===
        STARTER_WRITE_PRESSURE_PROOF_COUNT &&
      probe.writePressureProof.visibleCount ===
        STARTER_WRITE_PRESSURE_PROOF_COUNT &&
      probe.writePressureProof.durationMs !== null &&
      probe.writePressureProof.titlePrefix === args.expectedTitlePrefix
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'write-pressure-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview generated write pressure. Failure artifact: ${args.failureArtifactPath}`
  );
}

type SameClientDuplicateOpenOutcome = {
  status: 'blocked' | 'ready';
  probe: BrowserPreviewProbe;
};

async function proveStarterSameClientDuplicateOpenContention(args: {
  active: CdpSession;
  debugPort: number;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  observer: CdpSession;
  origin: string;
  title: string;
}): Promise<void> {
  await waitForStarterText({
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.active,
    title: args.title,
    errorReason: 'same-client-active-before-contention-errors',
    timeoutReason: 'same-client-active-before-contention-timeout',
    timeoutMessage:
      'Timed out waiting for built preview active same-client tab before duplicate open',
  });

  const duplicateUrl = `${args.origin}/?syncularClientId=web-second&syncularDuplicateProof=${Date.now()}`;
  const target = await createChromeTarget(args.debugPort, 'about:blank');
  const duplicate = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    await enableChromeTarget(duplicate);
    await navigateChromeTarget(duplicate, duplicateUrl);
    const outcome = await waitForStarterSameClientDuplicateOpenOutcome({
      duplicate,
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
    });
    if (outcome.status === 'ready') {
      await waitForStarterText({
        failureArtifactPath: args.failureArtifactPath,
        failureMetrics: args.failureMetrics,
        session: duplicate,
        title: args.title,
        errorReason: 'same-client-duplicate-existing-task-errors',
        timeoutReason: 'same-client-duplicate-existing-task-timeout',
        timeoutMessage:
          'Timed out waiting for built preview same-client duplicate tab to show the existing task',
      });
      await proveStarterSameClientDuplicateWriterContention({
        active: args.active,
        duplicate,
        failureArtifactPath: args.failureArtifactPath,
        failureMetrics: args.failureMetrics,
        observer: args.observer,
      });
    }

    const postContentionTitle = `same-client contention ${Date.now()}`;
    await submitStarterTask(args.active, postContentionTitle);
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.active,
      title: postContentionTitle,
      errorReason: 'same-client-active-post-contention-errors',
      timeoutReason: 'same-client-active-post-contention-timeout',
      timeoutMessage:
        'Timed out waiting for built preview active same-client tab after duplicate open',
    });
  } finally {
    duplicate.close();
  }
}

async function proveStarterSameClientDuplicateWriterContention(args: {
  active: CdpSession;
  duplicate: CdpSession;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  observer: CdpSession;
}): Promise<void> {
  const titlePrefix = `same-db write contention ${Date.now()}`;
  const activeTitle = `${titlePrefix} active`;
  const duplicateTitle = `${titlePrefix} duplicate`;

  await Promise.all([
    submitStarterTask(args.active, activeTitle),
    submitStarterTask(args.duplicate, duplicateTitle),
  ]);

  for (const title of [activeTitle, duplicateTitle]) {
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.active,
      title,
      errorReason: 'same-client-active-write-contention-errors',
      timeoutReason: 'same-client-active-write-contention-timeout',
      timeoutMessage:
        'Timed out waiting for built preview same-client active tab write contention',
    });
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.duplicate,
      title,
      errorReason: 'same-client-duplicate-write-contention-errors',
      timeoutReason: 'same-client-duplicate-write-contention-timeout',
      timeoutMessage:
        'Timed out waiting for built preview same-client duplicate tab write contention',
    });
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.observer,
      title,
      errorReason: 'same-client-observer-write-contention-errors',
      timeoutReason: 'same-client-observer-write-contention-timeout',
      timeoutMessage:
        'Timed out waiting for built preview same-client write contention propagation',
    });
  }
}

async function waitForStarterSameClientDuplicateOpenOutcome(args: {
  duplicate: CdpSession;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
}): Promise<SameClientDuplicateOpenOutcome> {
  const deadline = Date.now() + 30_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.duplicate);
    lastProbe = probe;
    const unexpectedErrors = probe.errors.filter(
      (error) => error !== 'database open failed'
    );
    if (unexpectedErrors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'same-client-duplicate-open-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview same-client duplicate tab failed unexpectedly: ${unexpectedErrors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    if (probe.ready) {
      if (probe.starterOpen.error !== null) {
        await writeBrowserPreviewFailureArtifact(
          args.failureArtifactPath,
          'same-client-duplicate-ready-with-error',
          probe,
          args.failureMetrics
        );
        throw new Error(
          `Built preview same-client duplicate tab became ready with an open error. Failure artifact: ${args.failureArtifactPath}`
        );
      }
      return { status: 'ready', probe };
    }
    if (probe.starterOpen.error !== null) {
      return { status: 'blocked', probe };
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'same-client-duplicate-open-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview same-client duplicate tab to settle. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function proveStarterReloadPersistence(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  session: CdpSession;
  title: string;
  url: string;
}): Promise<void> {
  await args.session.send('Page.navigate', { url: args.url });
  await waitForStarterBrowserUrl(args);
  await waitForStarterBrowserReady(
    args.session,
    args.failureArtifactPath,
    args.failureMetrics
  );

  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'reload-persistence-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview reload persistence failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const restored = await args.session.evaluate<boolean>(
      `document.body?.innerText.includes(${JSON.stringify(args.title)}) ?? false`
    );
    if (restored) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'reload-persistence-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview reload persistence. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function proveStarterBrowserProcessRestart(args: {
  chrome: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  origin: string;
  title: string;
  userDataDir: string;
}): Promise<void> {
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  const url = `${args.origin}/?syncularClientId=web-second&syncularRestartProof=${Date.now()}`;
  let session: CdpSession | null = null;

  try {
    const target = await createChromeTarget(chrome.debugPort, 'about:blank');
    session = await CdpSession.connect(target.webSocketDebuggerUrl);
    await enableChromeTarget(session);
    await navigateChromeTarget(session, url);
    await waitForStarterBrowserReady(
      session,
      args.failureArtifactPath,
      args.failureMetrics
    );

    const deadline = Date.now() + 20_000;
    let lastProbe: BrowserPreviewProbe | null = null;
    while (Date.now() < deadline) {
      const probe = await readStarterBrowserProbe(session);
      lastProbe = probe;
      if (probe.errors.length > 0) {
        await writeBrowserPreviewFailureArtifact(
          args.failureArtifactPath,
          'browser-restart-persistence-errors',
          probe,
          args.failureMetrics
        );
        throw new Error(
          `Built preview browser restart persistence failed: ${probe.errors.join(
            ', '
          )}. Failure artifact: ${args.failureArtifactPath}`
        );
      }
      const restored = await session.evaluate<boolean>(
        `document.body?.innerText.includes(${JSON.stringify(args.title)}) ?? false`
      );
      if (restored) return;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
    }

    await writeBrowserPreviewFailureArtifact(
      args.failureArtifactPath,
      'browser-restart-persistence-timeout',
      lastProbe,
      args.failureMetrics
    );
    throw new Error(
      `Timed out waiting for built preview browser restart persistence. Failure artifact: ${args.failureArtifactPath}`
    );
  } finally {
    session?.close();
    await stopProcess(chrome.process);
  }
}

async function proveStarterShutdownReplayRecovery(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const clientId = 'web-shutdown-replay';
  const title = `shutdown replay ${Date.now()}`;
  let chrome: { debugPort: number; process: ReturnType<typeof spawn> } | null =
    await startBrowserPreviewChrome({
      chrome: args.chrome,
      userDataDir: args.userDataDir,
    });
  let activeSession: CdpSession | null = null;
  let activeTargetId: string | null = null;
  let recoverySession: CdpSession | null = null;
  let recoveryTargetId: string | null = null;
  let observerSession: CdpSession | null = null;
  let observerTargetId: string | null = null;
  let lastProbe: BrowserPreviewProbe | null = null;

  try {
    const activeTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    activeTargetId = activeTarget.id;
    activeSession = await CdpSession.connect(activeTarget.webSocketDebuggerUrl);
    await enableChromeTarget(activeSession);
    await navigateChromeTarget(
      activeSession,
      `${args.origin}/?syncularClientId=${clientId}&syncularSyncStartup=manual&syncularShutdownReplayProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      activeSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(activeSession);
    await submitStarterTask(activeSession, title);
    await waitForStarterLocalVisibility({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });
    await waitForStarterRenderedText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
      timeoutMessage:
        'Timed out waiting for built preview shutdown replay local render before browser stop',
      timeoutReason: 'shutdown-replay-local-render-timeout',
      title,
    });

    activeSession.close();
    activeSession = null;
    activeTargetId = null;
    await stopProcess(chrome.process);
    chrome = null;

    chrome = await startBrowserPreviewChrome({
      chrome: args.chrome,
      userDataDir: args.userDataDir,
    });
    const recoveryTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    recoveryTargetId = recoveryTarget.id;
    recoverySession = await CdpSession.connect(
      recoveryTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(recoverySession);
    await navigateChromeTarget(
      recoverySession,
      `${args.origin}/?syncularClientId=${clientId}&syncularSyncStartup=manual&syncularShutdownReplayRestoreProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(recoverySession);
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: recoverySession,
      title,
      errorReason: 'shutdown-replay-local-restore-errors',
      timeoutReason: 'shutdown-replay-local-restore-timeout',
      timeoutMessage:
        'Timed out waiting for built preview shutdown replay local restore',
    });

    await navigateChromeTarget(
      recoverySession,
      `${args.origin}/?syncularClientId=${clientId}&syncularShutdownReplayOnlineProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await dispatchStarterOnlineEvent(recoverySession);

    const observerTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    observerTargetId = observerTarget.id;
    observerSession = await CdpSession.connect(
      observerTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(observerSession);
    await navigateChromeTarget(
      observerSession,
      `${args.origin}/?syncularClientId=web-shutdown-replay-observer&syncularShutdownReplayObserverProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      observerSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: observerSession,
      title,
      errorReason: 'shutdown-replay-propagation-errors',
      timeoutReason: 'shutdown-replay-propagation-timeout',
      timeoutMessage:
        'Timed out waiting for built preview shutdown replay propagation',
    });
  } catch (error) {
    await writeBrowserPreviewFailureArtifactIfMissing(
      args.failureArtifactPath,
      'shutdown-replay-smoke-error',
      lastProbe,
      args.failureMetrics
    );
    throw error;
  } finally {
    if (chrome !== null) {
      await closeStarterChromeTarget({
        debugPort: chrome.debugPort,
        session: observerSession,
        targetId: observerTargetId,
      });
      await closeStarterChromeTarget({
        debugPort: chrome.debugPort,
        session: recoverySession,
        targetId: recoveryTargetId,
      });
      await closeStarterChromeTarget({
        debugPort: chrome.debugPort,
        session: activeSession,
        targetId: activeTargetId,
      });
      await stopProcess(chrome.process);
    } else {
      try {
        activeSession?.close();
      } catch {
        // The browser process was already stopped for the shutdown proof.
      }
    }
  }
}

async function proveStarterRendererCrashReplayRecovery(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const clientId = 'web-renderer-crash-replay';
  const title = `renderer crash replay ${Date.now()}`;
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  let activeSession: CdpSession | null = null;
  let activeTargetId: string | null = null;
  let recoverySession: CdpSession | null = null;
  let recoveryTargetId: string | null = null;
  let observerSession: CdpSession | null = null;
  let observerTargetId: string | null = null;
  let lastProbe: BrowserPreviewProbe | null = null;

  try {
    const activeTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    activeTargetId = activeTarget.id;
    activeSession = await CdpSession.connect(activeTarget.webSocketDebuggerUrl);
    await enableChromeTarget(activeSession);
    await navigateChromeTarget(
      activeSession,
      `${args.origin}/?syncularClientId=${clientId}&syncularSyncStartup=manual&syncularRendererCrashReplayProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      activeSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(activeSession);
    await submitStarterTask(activeSession, title);
    await waitForStarterLocalVisibility({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });
    await waitForStarterRenderedText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
      timeoutMessage:
        'Timed out waiting for built preview renderer-crash local render before crash',
      timeoutReason: 'renderer-crash-local-render-timeout',
      title,
    });

    await crashStarterChromeRenderer(activeSession);
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    activeSession = null;
    activeTargetId = null;

    const recoveryTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    recoveryTargetId = recoveryTarget.id;
    recoverySession = await CdpSession.connect(
      recoveryTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(recoverySession);
    await navigateChromeTarget(
      recoverySession,
      `${args.origin}/?syncularClientId=${clientId}&syncularSyncStartup=manual&syncularRendererCrashRestoreProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(recoverySession);
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: recoverySession,
      title,
      errorReason: 'renderer-crash-local-restore-errors',
      timeoutReason: 'renderer-crash-local-restore-timeout',
      timeoutMessage:
        'Timed out waiting for built preview renderer-crash local restore',
    });

    await navigateChromeTarget(
      recoverySession,
      `${args.origin}/?syncularClientId=${clientId}&syncularRendererCrashOnlineProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await dispatchStarterOnlineEvent(recoverySession);

    const observerTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    observerTargetId = observerTarget.id;
    observerSession = await CdpSession.connect(
      observerTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(observerSession);
    await navigateChromeTarget(
      observerSession,
      `${args.origin}/?syncularClientId=web-renderer-crash-replay-observer&syncularRendererCrashObserverProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      observerSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: observerSession,
      title,
      errorReason: 'renderer-crash-propagation-errors',
      timeoutReason: 'renderer-crash-propagation-timeout',
      timeoutMessage:
        'Timed out waiting for built preview renderer-crash replay propagation',
    });
  } catch (error) {
    await writeBrowserPreviewFailureArtifactIfMissing(
      args.failureArtifactPath,
      'renderer-crash-replay-smoke-error',
      lastProbe,
      args.failureMetrics
    );
    throw error;
  } finally {
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: observerSession,
      targetId: observerTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: recoverySession,
      targetId: recoveryTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    await stopProcess(chrome.process);
  }
}

type StarterSyncTransportFailpointState = {
  blockedClientIds: string[];
  blockedPostCount: number;
  blockedPushCount: number;
  blockedRequestCount: number;
  enabled: boolean;
  lastBlockedClientId: string | null;
  lastBlockedPath: string | null;
};

async function proveStarterSyncTransportReplayRecovery(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  syncOrigin: string;
  userDataDir: string;
}): Promise<void> {
  const clientId = 'web-sync-transport-replay';
  const observerClientId = 'web-sync-transport-replay-observer';
  const title = `sync transport replay ${Date.now()}`;
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  let activeSession: CdpSession | null = null;
  let activeTargetId: string | null = null;
  let observerSession: CdpSession | null = null;
  let observerTargetId: string | null = null;
  let lastProbe: BrowserPreviewProbe | null = null;

  try {
    await resetStarterSyncTransportFailpoint(args.syncOrigin);
    const activeTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    activeTargetId = activeTarget.id;
    activeSession = await CdpSession.connect(activeTarget.webSocketDebuggerUrl);
    await enableChromeTarget(activeSession);
    await navigateChromeTarget(
      activeSession,
      `${args.origin}/?syncularClientId=${clientId}&syncularSyncTransportReplayProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      activeSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(activeSession);

    const blockedBefore = await configureStarterSyncTransportFailpoint({
      blocked: true,
      clientId,
      syncOrigin: args.syncOrigin,
    });
    await submitStarterTask(activeSession, title);
    await waitForStarterLocalVisibility({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });
    await waitForStarterRenderedText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
      timeoutMessage:
        'Timed out waiting for built preview sync-transport replay local render while transport was blocked',
      timeoutReason: 'sync-transport-local-render-timeout',
      title,
    });
    await waitForStarterSyncTransportBlockedPush({
      expectedBlockedPushCount: blockedBefore.blockedPushCount + 1,
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
      syncOrigin: args.syncOrigin,
      targetClientId: clientId,
    });

    await configureStarterSyncTransportFailpoint({
      blocked: false,
      clientId,
      syncOrigin: args.syncOrigin,
    });
    await dispatchStarterOnlineEvent(activeSession);
    await waitForStarterResumeReplayPush({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });

    const observerTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    observerTargetId = observerTarget.id;
    observerSession = await CdpSession.connect(
      observerTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(observerSession);
    await navigateChromeTarget(
      observerSession,
      `${args.origin}/?syncularClientId=${observerClientId}&syncularSyncTransportReplayObserverProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      observerSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: observerSession,
      title,
      errorReason: 'sync-transport-replay-propagation-errors',
      timeoutReason: 'sync-transport-replay-propagation-timeout',
      timeoutMessage:
        'Timed out waiting for built preview sync-transport replay propagation',
    });
  } catch (error) {
    await writeBrowserPreviewFailureArtifactIfMissing(
      args.failureArtifactPath,
      'sync-transport-replay-smoke-error',
      lastProbe,
      args.failureMetrics
    );
    throw error;
  } finally {
    await configureStarterSyncTransportFailpoint({
      blocked: false,
      clientId,
      syncOrigin: args.syncOrigin,
    }).catch(() => undefined);
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: observerSession,
      targetId: observerTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    await stopProcess(chrome.process);
  }
}

async function proveStarterStorageShutdownReplayRecovery(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const clientId = 'web-storage-shutdown-replay';
  const title = `storage shutdown replay ${Date.now()}`;
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  let activeSession: CdpSession | null = null;
  let activeTargetId: string | null = null;
  let recoverySession: CdpSession | null = null;
  let recoveryTargetId: string | null = null;
  let observerSession: CdpSession | null = null;
  let observerTargetId: string | null = null;
  let lastProbe: BrowserPreviewProbe | null = null;

  try {
    const activeTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    activeTargetId = activeTarget.id;
    activeSession = await CdpSession.connect(activeTarget.webSocketDebuggerUrl);
    await enableChromeTarget(activeSession);
    await navigateChromeTarget(
      activeSession,
      `${args.origin}/?syncularClientId=${clientId}&syncularSyncStartup=manual&syncularStorageShutdownReplayProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      activeSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(activeSession);
    await submitStarterTask(activeSession, title);
    await waitForStarterLocalVisibility({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });
    await waitForStarterRenderedText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
      timeoutMessage:
        'Timed out waiting for built preview storage-shutdown local render before close',
      timeoutReason: 'storage-shutdown-local-render-timeout',
      title,
    });
    await runStarterStorageShutdownProof({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });
    await waitForStarterStorageShutdownProof({
      expectedCount: (lastProbe.storageShutdownProof.count ?? 0) + 1,
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    activeSession = null;
    activeTargetId = null;

    const recoveryTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    recoveryTargetId = recoveryTarget.id;
    recoverySession = await CdpSession.connect(
      recoveryTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(recoverySession);
    await navigateChromeTarget(
      recoverySession,
      `${args.origin}/?syncularClientId=${clientId}&syncularSyncStartup=manual&syncularStorageShutdownRestoreProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(recoverySession);
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: recoverySession,
      title,
      errorReason: 'storage-shutdown-local-restore-errors',
      timeoutReason: 'storage-shutdown-local-restore-timeout',
      timeoutMessage:
        'Timed out waiting for built preview storage-shutdown local restore',
    });

    await navigateChromeTarget(
      recoverySession,
      `${args.origin}/?syncularClientId=${clientId}&syncularStorageShutdownOnlineProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await dispatchStarterOnlineEvent(recoverySession);

    const observerTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    observerTargetId = observerTarget.id;
    observerSession = await CdpSession.connect(
      observerTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(observerSession);
    await navigateChromeTarget(
      observerSession,
      `${args.origin}/?syncularClientId=web-storage-shutdown-replay-observer&syncularStorageShutdownObserverProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      observerSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: observerSession,
      title,
      errorReason: 'storage-shutdown-propagation-errors',
      timeoutReason: 'storage-shutdown-propagation-timeout',
      timeoutMessage:
        'Timed out waiting for built preview storage-shutdown replay propagation',
    });
  } catch (error) {
    await writeBrowserPreviewFailureArtifactIfMissing(
      args.failureArtifactPath,
      'storage-shutdown-replay-smoke-error',
      lastProbe,
      args.failureMetrics
    );
    throw error;
  } finally {
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: observerSession,
      targetId: observerTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: recoverySession,
      targetId: recoveryTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    await stopProcess(chrome.process);
  }
}

type StarterDiscardsTabState = {
  canDiscard: boolean;
  cannotDiscardReasons: string[];
  discardCount: number;
  discardReason: number;
  id: number;
  loadingState: number;
  state: number;
  tabUrl: string;
  title: string;
  visibility: number;
};

type StarterDiscardsTabResult = {
  before: StarterDiscardsTabState;
  discarded: StarterDiscardsTabState;
};

async function proveStarterDiscardedTabRecovery(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const clientId = 'web-discarded-tab-recovery';
  const observerClientId = 'web-discarded-tab-recovery-observer';
  const title = `discarded tab replay ${Date.now()}`;
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  let activeSession: CdpSession | null = null;
  let activeTargetId: string | null = null;
  let discardsSession: CdpSession | null = null;
  let discardsTargetId: string | null = null;
  let recoverySession: CdpSession | null = null;
  let recoveryTargetId: string | null = null;
  let observerSession: CdpSession | null = null;
  let observerTargetId: string | null = null;
  let lastProbe: BrowserPreviewProbe | null = null;

  try {
    const activeTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    activeTargetId = activeTarget.id;
    activeSession = await CdpSession.connect(activeTarget.webSocketDebuggerUrl);
    await enableChromeTarget(activeSession);
    await navigateChromeTarget(
      activeSession,
      `${args.origin}/?syncularClientId=${clientId}&syncularSyncStartup=manual&syncularDiscardedTabProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      activeSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(activeSession);
    await submitStarterTask(activeSession, title);
    await waitForStarterLocalVisibility({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });
    await waitForStarterRenderedText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
      timeoutMessage:
        'Timed out waiting for built preview discarded-tab local render before discard',
      timeoutReason: 'discarded-tab-local-render-timeout',
      title,
    });
    lastProbe = await readStarterBrowserProbe(activeSession);

    const discardsTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    discardsTargetId = discardsTarget.id;
    discardsSession = await CdpSession.connect(
      discardsTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(discardsSession);
    await navigateChromeTarget(discardsSession, 'chrome://discards/');

    // A DevTools attachment can make a tab non-discardable, so detach before
    // asking Chrome's own discards WebUI to unload the hidden starter tab.
    activeSession.close();
    activeSession = null;

    const discardResult = await discardStarterTabViaChromeDiscards({
      session: discardsSession,
      tabUrlIncludes: `syncularClientId=${clientId}`,
    });
    if (discardResult.discarded.state !== 5) {
      throw new Error(
        `Chrome did not report the starter tab as discarded: state=${discardResult.discarded.state}`
      );
    }

    const recoveryTarget = await findChromePageTarget({
      debugPort: chrome.debugPort,
      urlIncludes: `syncularClientId=${clientId}`,
    });
    recoveryTargetId = recoveryTarget.id;
    await activateChromeTargetById(chrome.debugPort, recoveryTarget.id);
    recoverySession = await CdpSession.connect(
      recoveryTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(recoverySession);
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(recoverySession);
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: recoverySession,
      title,
      errorReason: 'discarded-tab-local-restore-errors',
      timeoutReason: 'discarded-tab-local-restore-timeout',
      timeoutMessage:
        'Timed out waiting for built preview discarded-tab local restore',
    });

    await navigateChromeTarget(
      recoverySession,
      `${args.origin}/?syncularClientId=${clientId}&syncularDiscardedTabOnlineProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await dispatchStarterOnlineEvent(recoverySession);

    const observerTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    observerTargetId = observerTarget.id;
    observerSession = await CdpSession.connect(
      observerTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(observerSession);
    await navigateChromeTarget(
      observerSession,
      `${args.origin}/?syncularClientId=${observerClientId}&syncularDiscardedTabObserverProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      observerSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: observerSession,
      title,
      errorReason: 'discarded-tab-propagation-errors',
      timeoutReason: 'discarded-tab-propagation-timeout',
      timeoutMessage:
        'Timed out waiting for built preview discarded-tab replay propagation',
    });
  } catch (error) {
    await writeBrowserPreviewFailureArtifactIfMissing(
      args.failureArtifactPath,
      'discarded-tab-recovery-smoke-error',
      lastProbe,
      args.failureMetrics
    );
    throw error;
  } finally {
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: observerSession,
      targetId: observerTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: recoverySession,
      targetId: recoveryTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: discardsSession,
      targetId: discardsTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    await stopProcess(chrome.process);
  }
}

async function discardStarterTabViaChromeDiscards(args: {
  session: CdpSession;
  tabUrlIncludes: string;
}): Promise<StarterDiscardsTabResult> {
  return await args.session.evaluate<StarterDiscardsTabResult>(
    `(async () => {
      const getProvider = async () => {
        let lastState = null;
        for (let index = 0; index < 80; index += 1) {
          const main = document.querySelector('discards-main');
          const tab = main?.shadowRoot?.querySelector('discards-tab');
          const provider = tab?.discardsDetailsProvider_;
          if (
            provider &&
            typeof provider.getTabDiscardsInfo === 'function' &&
            typeof provider.setAutoDiscardable === 'function' &&
            typeof provider.discardById === 'function'
          ) {
            return provider;
          }
          lastState = {
            bodyText: document.body?.textContent?.slice(0, 200) ?? null,
            hasMain: Boolean(main),
            hasMainShadowRoot: Boolean(main?.shadowRoot),
            hasTab: Boolean(tab),
            hasProvider: Boolean(provider),
            title: document.title,
            url: document.URL,
          };
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(
          'Timed out waiting for chrome://discards provider: ' +
            JSON.stringify(lastState)
        );
      };
      const provider = await getProvider();
      const targetUrlPart = ${JSON.stringify(args.tabUrlIncludes)};
      const serialize = (info) => ({
        canDiscard: Boolean(info.canDiscard),
        cannotDiscardReasons: Array.isArray(info.cannotDiscardReasons)
          ? info.cannotDiscardReasons.map(String)
          : [],
        discardCount: Number(info.discardCount ?? 0),
        discardReason: Number(info.discardReason ?? -1),
        id: Number(info.id),
        loadingState: Number(info.loadingState ?? -1),
        state: Number(info.state ?? -1),
        tabUrl: String(info.tabUrl ?? ''),
        title: String(info.title ?? ''),
        visibility: Number(info.visibility ?? -1),
      });
      const findTab = async () => {
        const response = await provider.getTabDiscardsInfo();
        const infos = Array.isArray(response.infos)
          ? response.infos.map(serialize)
          : [];
        return infos.find((info) => info.tabUrl.includes(targetUrlPart)) ?? null;
      };
      const waitForTab = async (predicate, label) => {
        let last = null;
        for (let index = 0; index < 80; index += 1) {
          last = await findTab();
          if (last && predicate(last)) return last;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(
          'Timed out waiting for discards tab state: ' +
            label +
            '; last=' +
            JSON.stringify(last)
        );
      };

      const before = await waitForTab(
        (info) => info.state !== 5,
        'starter tab present before discard'
      );
      await provider.setAutoDiscardable(before.id, true);
      await provider.discardById(before.id, 2);
      const discarded = await waitForTab(
        (info) =>
          info.state === 5 &&
          info.discardCount > before.discardCount,
        'starter tab discarded'
      );
      return { before, discarded };
    })()`
  );
}

type StarterStorageShutdownProofResult = {
  closed: boolean;
  lifecyclePhase: string;
  mutationRejected: boolean;
  postCloseErrorCode: string | null;
};

async function runStarterStorageShutdownProof(args: {
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<StarterStorageShutdownProofResult> {
  try {
    return await args.session.evaluate<StarterStorageShutdownProofResult>(
      `(() => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const timeout = setTimeout(() => {
        finish(reject, new Error('Timed out waiting for starter storage shutdown proof'));
      }, 15_000);
      window.dispatchEvent(
        new CustomEvent('syncular-starter-run-storage-shutdown-proof', {
          detail: {
            resolve: (result) => finish(resolve, result),
            reject: (reason) =>
              finish(
                reject,
                new Error(
                  typeof reason === 'string'
                    ? reason
                    : 'Starter storage shutdown proof failed'
                )
              ),
          },
        })
      );
    }))()`
    );
  } catch (error) {
    const probe = await readStarterBrowserProbe(args.session).catch(() => null);
    await writeBrowserPreviewFailureArtifact(
      args.failureArtifactPath,
      'storage-shutdown-proof-error',
      probe,
      args.failureMetrics
    );
    throw new Error(
      `Built preview starter storage shutdown proof failed: ${describeError(
        error
      )}. Failure artifact: ${args.failureArtifactPath}`
    );
  }
}

async function waitForStarterStorageShutdownProof(args: {
  expectedCount: number;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'storage-shutdown-proof-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview storage shutdown proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const proof = probe.storageShutdownProof;
    if (
      proof.status === 'complete' &&
      proof.count >= args.expectedCount &&
      proof.closed &&
      proof.lifecyclePhase === 'closed' &&
      proof.mutationRejected &&
      proof.postCloseErrorCode === 'worker.closed' &&
      proof.durationMs !== null
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'storage-shutdown-proof-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview storage shutdown proof. Failure artifact: ${args.failureArtifactPath}`
  );
}

type StarterResumeProofResult = {
  pushedCommits: number;
};

async function waitForStarterResumeReplayPush(args: {
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  let lastResult: StarterResumeProofResult | null = null;
  while (Date.now() < deadline) {
    const result = await runStarterResumeProof({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: args.session,
    });
    lastResult = result;
    if (result.pushedCommits > 0) return;
    try {
      lastProbe = await readStarterBrowserProbe(args.session);
      if (lastProbe.errors.length > 0) {
        await writeBrowserPreviewFailureArtifact(
          args.failureArtifactPath,
          'sync-transport-resume-push-errors',
          lastProbe,
          args.failureMetrics
        );
        throw new Error(
          `Built preview sync-transport replay resume failed: ${lastProbe.errors.join(
            ', '
          )}. Failure artifact: ${args.failureArtifactPath}`
        );
      }
    } catch (error) {
      if (lastProbe?.errors.length) throw error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'sync-transport-resume-push-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview sync-transport replay resume to push a queued commit (last pushedCommits ${
      lastResult?.pushedCommits ?? 0
    }). Failure artifact: ${args.failureArtifactPath}`
  );
}

async function runStarterResumeProof(args: {
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<StarterResumeProofResult> {
  try {
    const result = await args.session.evaluate<StarterResumeProofResult>(
      `(() => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const timeout = setTimeout(() => {
        finish(reject, new Error('Timed out waiting for starter resume proof'));
      }, 15_000);
      window.dispatchEvent(
        new CustomEvent('syncular-starter-run-resume-proof', {
          detail: {
            resolve: (result) =>
              finish(resolve, {
                pushedCommits:
                  result &&
                  typeof result === 'object' &&
                  Number.isFinite(result.pushedCommits)
                    ? result.pushedCommits
                    : 0,
              }),
            reject: (reason) =>
              finish(
                reject,
                new Error(
                  typeof reason === 'string' ? reason : 'Starter resume proof failed'
                )
              ),
          },
        })
      );
    }))()`
    );
    return {
      pushedCommits: Number.isFinite(result?.pushedCommits)
        ? result.pushedCommits
        : 0,
    };
  } catch (error) {
    const probe = await readStarterBrowserProbe(args.session).catch(() => null);
    await writeBrowserPreviewFailureArtifact(
      args.failureArtifactPath,
      'sync-transport-resume-proof-error',
      probe,
      args.failureMetrics
    );
    throw new Error(
      `Built preview starter resume proof failed: ${describeError(
        error
      )}. Failure artifact: ${args.failureArtifactPath}`
    );
  }
}

async function resetStarterSyncTransportFailpoint(
  syncOrigin: string
): Promise<StarterSyncTransportFailpointState> {
  return configureStarterSyncTransportFailpoint({
    reset: true,
    syncOrigin,
  });
}

async function configureStarterSyncTransportFailpoint(args: {
  blocked?: boolean;
  clientId?: string;
  reset?: boolean;
  syncOrigin: string;
}): Promise<StarterSyncTransportFailpointState> {
  const response = await fetch(
    `${args.syncOrigin}/__syncular-smoke/sync-transport`,
    {
      body: JSON.stringify({
        blocked: args.blocked,
        clientId: args.clientId,
        reset: args.reset,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  );
  if (!response.ok) {
    throw new Error(
      `Starter sync-transport failpoint configure failed with ${response.status}`
    );
  }
  return readStarterSyncTransportFailpointResponse(response);
}

async function readStarterSyncTransportFailpoint(
  syncOrigin: string
): Promise<StarterSyncTransportFailpointState> {
  const response = await fetch(`${syncOrigin}/__syncular-smoke/sync-transport`);
  if (!response.ok) {
    throw new Error(
      `Starter sync-transport failpoint status failed with ${response.status}`
    );
  }
  return readStarterSyncTransportFailpointResponse(response);
}

async function readStarterSyncTransportFailpointResponse(
  response: Response
): Promise<StarterSyncTransportFailpointState> {
  const value = await response.json();
  assertStarterSyncTransportFailpointState(value);
  return value;
}

function assertStarterSyncTransportFailpointState(
  value: unknown
): asserts value is StarterSyncTransportFailpointState {
  if (!isRecord(value)) {
    throw new Error('Starter sync-transport failpoint response was not object');
  }
  if (value.enabled !== true) {
    throw new Error('Starter sync-transport failpoint was not enabled');
  }
  if (
    !Array.isArray(value.blockedClientIds) ||
    !value.blockedClientIds.every((entry) => typeof entry === 'string')
  ) {
    throw new Error(
      'Starter sync-transport failpoint blockedClientIds was not string[]'
    );
  }
  for (const key of [
    'blockedPostCount',
    'blockedPushCount',
    'blockedRequestCount',
  ] as const) {
    if (
      !isNonNegativeFiniteNumber(value[key]) ||
      !Number.isInteger(value[key])
    ) {
      throw new Error(
        `Starter sync-transport failpoint ${key} was not a non-negative integer`
      );
    }
  }
  for (const key of ['lastBlockedClientId', 'lastBlockedPath'] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `Starter sync-transport failpoint ${key} was not nullable string`
      );
    }
  }
}

async function waitForStarterSyncTransportBlockedPush(args: {
  expectedBlockedPushCount: number;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
  syncOrigin: string;
  targetClientId: string;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const failpoint = await readStarterSyncTransportFailpoint(args.syncOrigin);
    if (
      failpoint.blockedPushCount >= args.expectedBlockedPushCount &&
      failpoint.lastBlockedClientId === args.targetClientId &&
      failpoint.lastBlockedPath?.endsWith('/sync') === true
    ) {
      return;
    }
    try {
      lastProbe = await readStarterBrowserProbe(args.session);
    } catch {
      // Keep polling failpoint state; the artifact can use the last probe.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'sync-transport-blocked-push-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for blocked sync-transport push proof. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function crashStarterChromeRenderer(session: CdpSession): Promise<void> {
  const crashed = session
    .waitForEvent('Inspector.targetCrashed', 5_000)
    .then(() => true)
    .catch(() => false);
  const crashCommand = session
    .send('Page.crash', undefined, 2_000)
    .then(() => true)
    .catch((error) => {
      if (
        isExpectedChromeRendererCrashError(error) ||
        isChromeDevToolsCommandTimeout(error, 'Page.crash')
      ) {
        return false;
      }
      throw error;
    });
  const observedCrash = await Promise.race([
    crashed,
    crashCommand,
    new Promise<false>((resolveSleep) => setTimeout(resolveSleep, 2_000)),
  ]);
  if (!observedCrash) await assertStarterChromeRendererUnavailable(session);
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
}

async function assertStarterChromeRendererUnavailable(
  session: CdpSession
): Promise<void> {
  try {
    await session.send(
      'Runtime.evaluate',
      { expression: '1', returnByValue: true },
      2_000
    );
  } catch (error) {
    if (
      isExpectedChromeRendererCrashError(error) ||
      isChromeDevToolsCommandTimeout(error, 'Runtime.evaluate')
    ) {
      return;
    }
    throw error;
  }
  throw new Error('Chrome renderer stayed responsive after Page.crash');
}

function isExpectedChromeRendererCrashError(error: unknown): boolean {
  const message = describeError(error);
  return (
    message.includes('Chrome DevTools WebSocket closed') ||
    message.includes('Inspector.detached') ||
    message.includes('Target closed') ||
    message.includes('target closed') ||
    message.includes('Render process gone')
  );
}

function isChromeDevToolsCommandTimeout(
  error: unknown,
  method: string
): boolean {
  const message = describeError(error);
  return (
    message.includes('Timed out after') &&
    message.includes(`Chrome DevTools command ${method}`)
  );
}

async function proveStarterSupportBundleFailureArtifact(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  const url = `${args.origin}/?syncularClientId=web-support-bundle-artifact&syncularSupportBundleArtifactProof=${Date.now()}`;
  let session: CdpSession | null = null;

  try {
    const target = await createChromeTarget(chrome.debugPort, 'about:blank');
    session = await CdpSession.connect(target.webSocketDebuggerUrl);
    await enableChromeTarget(session);
    await navigateChromeTarget(session, url);
    await waitForStarterBrowserReady(
      session,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await forceStarterSupportBundleFailureMarker(session);

    try {
      await waitForStarterBrowserReady(
        session,
        args.failureArtifactPath,
        args.failureMetrics
      );
    } catch {
      await verifyExpectedSupportBundleFailureArtifact(
        args.failureArtifactPath
      );
      return;
    }

    throw new Error(
      `Built preview support-bundle failure marker did not produce a failure artifact. Artifact path: ${args.failureArtifactPath}`
    );
  } finally {
    session?.close();
    await stopProcess(chrome.process);
  }
}

async function proveStarterPwaServiceWorkerContext(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  const baseUrl = `${args.origin}/?syncularClientId=web-pwa&syncularPwaProof=${Date.now()}`;
  let session: CdpSession | null = null;

  try {
    const target = await createChromeTarget(chrome.debugPort, 'about:blank');
    session = await CdpSession.connect(target.webSocketDebuggerUrl);
    await enableChromeTarget(session);
    await navigateChromeTarget(session, baseUrl);
    await waitForStarterBrowserReady(
      session,
      args.failureArtifactPath,
      args.failureMetrics
    );

    const registration = await registerStarterSmokeServiceWorker(session);
    if (!registration.ok) {
      const probe = await readStarterBrowserProbe(session);
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'pwa-service-worker-registration-failed',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview PWA service worker registration failed: ${registration.reason}. Failure artifact: ${args.failureArtifactPath}`
      );
    }

    await navigateChromeTarget(
      session,
      `${baseUrl}&syncularPwaControlled=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      session,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await waitForStarterPwaServiceWorkerEvidence({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session,
    });
  } finally {
    session?.close();
    await stopProcess(chrome.process);
  }
}

type StarterSmokeServiceWorkerRegistrationResult =
  | {
      ok: true;
      controlled: boolean;
      scriptPath: string | null;
      state: string | null;
    }
  | { ok: false; reason: string };

async function registerStarterSmokeServiceWorker(
  session: CdpSession
): Promise<StarterSmokeServiceWorkerRegistrationResult> {
  return session.evaluate<StarterSmokeServiceWorkerRegistrationResult>(
    `(async () => {
      const scriptPath = ${JSON.stringify(STARTER_PWA_SMOKE_SERVICE_WORKER_PATH)};
      const serviceWorker = globalThis.navigator?.serviceWorker;
      if (typeof serviceWorker?.register !== 'function') {
        return { ok: false, reason: 'service-worker-unavailable' };
      }

      const registration = await serviceWorker.register(scriptPath, {
        scope: '/',
      });
      const waitForWorkerState = (worker, state) =>
        new Promise((resolve, reject) => {
          if (!worker) {
            resolve(false);
            return;
          }
          if (worker.state === state) {
            resolve(true);
            return;
          }
          const timeout = setTimeout(() => {
            worker.removeEventListener('statechange', onStateChange);
            reject(new Error('timed out waiting for service worker ' + state));
          }, 10_000);
          const onStateChange = () => {
            if (worker.state !== state) return;
            clearTimeout(timeout);
            worker.removeEventListener('statechange', onStateChange);
            resolve(true);
          };
          worker.addEventListener('statechange', onStateChange);
        });

      if (registration.installing) {
        await waitForWorkerState(registration.installing, 'activated');
      } else if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SYNCULAR_SMOKE_SKIP_WAITING' });
        await waitForWorkerState(registration.waiting, 'activated');
      } else if (registration.active?.state !== 'activated') {
        await waitForWorkerState(registration.active, 'activated');
      }

      await serviceWorker.ready;
      if (!serviceWorker.controller) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 2_000);
          serviceWorker.addEventListener(
            'controllerchange',
            () => {
              clearTimeout(timeout);
              resolve(true);
            },
            { once: true }
          );
        });
      }

      const controller = serviceWorker.controller;
      const scriptUrl = registration.active?.scriptURL ?? controller?.scriptURL ?? null;
      return {
        ok: true,
        controlled: controller !== null,
        scriptPath: scriptUrl === null ? null : new URL(scriptUrl, window.location.href).pathname,
        state: registration.active?.state ?? controller?.state ?? null,
      };
    })()`
  );
}

async function waitForStarterPwaServiceWorkerEvidence(args: {
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'pwa-service-worker-policy-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview PWA service worker policy proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }

    if (
      probe.deploymentPreflight.serviceWorker === 'true' &&
      probe.deploymentPreflight.serviceWorkerControlled === 'true' &&
      probe.deploymentPreflight.serviceWorkerControllerScriptPath ===
        STARTER_PWA_SMOKE_SERVICE_WORKER_PATH &&
      probe.deploymentPreflight.serviceWorkerControllerState === 'activated' &&
      probe.browserSupportPolicy.context === 'pwa' &&
      probe.browserSupportPolicy.policy === 'preflight-required' &&
      probe.browserSupportPolicy.status === 'warning' &&
      probe.browserSupportPolicy.reasonCodes.includes(
        'browser_support.target_evidence_required'
      )
    ) {
      return;
    }

    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'pwa-service-worker-policy-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview PWA service worker policy evidence. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function proveStarterIncognitoMemoryStoragePolicy(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    incognito: true,
    userDataDir: args.userDataDir,
  });
  const url = `${args.origin}/?syncularClientId=web-incognito-memory&syncularStorage=memory&syncularIncognitoMemoryProof=${Date.now()}`;
  let session: CdpSession | null = null;

  try {
    const target = await createChromeTarget(chrome.debugPort, 'about:blank');
    session = await CdpSession.connect(target.webSocketDebuggerUrl);
    await enableChromeTarget(session);
    await navigateChromeTarget(session, url);
    await waitForStarterBrowserReady(
      session,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await waitForStarterIncognitoMemoryStorageEvidence({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session,
    });
  } finally {
    session?.close();
    await stopProcess(chrome.process);
  }
}

async function waitForStarterIncognitoMemoryStorageEvidence(args: {
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'incognito-memory-policy-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview incognito memory-storage policy proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }

    if (
      probe.deploymentPreflight.status === 'ready' &&
      probe.deploymentPreflight.supportTier === 'ephemeral-development' &&
      probe.deploymentPreflight.persistence === 'ephemeral' &&
      probe.browserSupportPolicy.context === 'private-browsing' &&
      probe.browserSupportPolicy.expectedSupportTier ===
        'ephemeral-development' &&
      probe.browserSupportPolicy.expectedPersistence === 'ephemeral' &&
      probe.browserSupportPolicy.observedSupportTier ===
        'ephemeral-development' &&
      probe.browserSupportPolicy.observedPersistence === 'ephemeral' &&
      probe.browserSupportPolicy.policy === 'development-only' &&
      probe.browserSupportPolicy.status === 'met' &&
      probe.browserSupportPolicy.reasonCodes.includes(
        'browser_support.development_only_context'
      )
    ) {
      return;
    }

    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'incognito-memory-policy-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview incognito memory-storage policy evidence. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function proveStarterQuotaPressurePreflight(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  const url = `${args.origin}/?syncularClientId=web-quota-pressure&syncularQuotaPressureProof=${Date.now()}`;
  let session: CdpSession | null = null;

  try {
    const target = await createChromeTarget(chrome.debugPort, 'about:blank');
    session = await CdpSession.connect(target.webSocketDebuggerUrl);
    await enableChromeTarget(session);
    await navigateChromeTarget(session, url);
    await waitForStarterBrowserReady(
      session,
      args.failureArtifactPath,
      args.failureMetrics
    );
    const quotaPressure = await configureStarterQuotaPressure(
      session,
      args.origin
    );
    const before = await readStarterBrowserProbe(session);
    await dispatchStarterQuotaPressureProof(session, quotaPressure);
    await waitForStarterQuotaPressureEvidence({
      expectedCount: before.quotaPressureProof.count + 1,
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session,
    });
    log('real-browser smoke: proving browser-observed quota recovery actions');
    const beforeRecovery = await readStarterBrowserProbe(session);
    await dispatchStarterStorageRecoveryProof(session, quotaPressure);
    await waitForStarterStorageRecoveryCompletion({
      expectedCount: beforeRecovery.storageRecoveryProof.count + 1,
      expectedSource: 'browser-observed',
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      requireObservedQuotaPressure: true,
      session,
    });
    log('real-browser smoke: proving quota-exhausted generated write');
    const beforeExhaustion = await readStarterBrowserProbe(session);
    const attemptedBytes = await dispatchStarterQuotaExhaustionWriteProof(
      session,
      quotaPressure
    );
    await waitForStarterQuotaExhaustionWriteCompletion({
      attemptedBytes,
      expectedCount: beforeExhaustion.quotaExhaustionWriteProof.count + 1,
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session,
    });
  } finally {
    session?.close();
    await stopProcess(chrome.process);
  }
}

async function proveStarterDatabaseStorageEvictionRecovery(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  const clientId = 'web-database-storage-eviction';
  const title = `database storage eviction ${Date.now()}`;
  let activeSession: CdpSession | null = null;
  let activeTargetId: string | null = null;
  let observerSession: CdpSession | null = null;
  let observerTargetId: string | null = null;
  let clearSession: CdpSession | null = null;
  let clearTargetId: string | null = null;
  let recoverySession: CdpSession | null = null;
  let recoveryTargetId: string | null = null;
  let lastProbe: BrowserPreviewProbe | null = null;

  try {
    const activeTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    activeTargetId = activeTarget.id;
    activeSession = await CdpSession.connect(activeTarget.webSocketDebuggerUrl);
    await enableChromeTarget(activeSession);
    await navigateChromeTarget(
      activeSession,
      `${args.origin}/?syncularClientId=${clientId}&syncularDatabaseStorageEvictionProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      activeSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(activeSession);
    await writeStarterStorageEvictionSentinel(activeSession);
    const sentinelBefore =
      await readStarterStorageEvictionSentinel(activeSession);
    if (
      sentinelBefore.cachePresent !== true ||
      sentinelBefore.indexedDbPresent !== true ||
      sentinelBefore.localStoragePresent !== true
    ) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'database-storage-eviction-sentinel-write-missing',
        lastProbe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview database-storage eviction sentinel was not fully visible before clear. Failure artifact: ${args.failureArtifactPath}`
      );
    }

    const beforeTask = await readStarterBrowserProbe(activeSession);
    lastProbe = beforeTask;
    await submitStarterTask(activeSession, title);
    await waitForStarterLocalVisibility({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });
    await waitForStarterCommandTimelineProof({
      expectedCount: beforeTask.commandTimelineProof.count + 1,
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });

    const observerTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    observerTargetId = observerTarget.id;
    observerSession = await CdpSession.connect(
      observerTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(observerSession);
    await navigateChromeTarget(
      observerSession,
      `${args.origin}/?syncularClientId=web-database-storage-eviction-observer&syncularDatabaseStorageEvictionObserverProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      observerSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: observerSession,
      title,
      errorReason: 'database-storage-eviction-propagation-errors',
      timeoutReason: 'database-storage-eviction-propagation-timeout',
      timeoutMessage:
        'Timed out waiting for built preview database-storage eviction propagation',
    });

    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    activeSession = null;
    activeTargetId = null;
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: observerSession,
      targetId: observerTargetId,
    });
    observerSession = null;
    observerTargetId = null;

    const clearTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    clearTargetId = clearTarget.id;
    clearSession = await CdpSession.connect(clearTarget.webSocketDebuggerUrl);
    await enableChromeTarget(clearSession);
    await clearStarterDatabaseStorage(clearSession, args.origin);
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: clearSession,
      targetId: clearTargetId,
    });
    clearSession = null;
    clearTargetId = null;

    const recoveryTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    recoveryTargetId = recoveryTarget.id;
    recoverySession = await CdpSession.connect(
      recoveryTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(recoverySession);
    await navigateChromeTarget(
      recoverySession,
      `${args.origin}/?syncularClientId=${clientId}&syncularDatabaseStorageEvictionRecoveryProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(recoverySession);
    const sentinelAfter =
      await readStarterStorageEvictionSentinel(recoverySession);
    if (
      sentinelAfter.cachePresent !== true ||
      sentinelAfter.localStoragePresent !== true ||
      sentinelAfter.indexedDbPresent !== false
    ) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'database-storage-eviction-sentinel-unexpected-state',
        lastProbe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview database-storage eviction did not only clear IndexedDB/FileSystem state. Failure artifact: ${args.failureArtifactPath}`
      );
    }

    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: recoverySession,
      title,
      errorReason: 'database-storage-eviction-recovery-errors',
      timeoutReason: 'database-storage-eviction-recovery-timeout',
      timeoutMessage:
        'Timed out waiting for built preview database-storage eviction recovery',
    });
  } catch (error) {
    await writeBrowserPreviewFailureArtifactIfMissing(
      args.failureArtifactPath,
      'database-storage-eviction-smoke-error',
      lastProbe,
      args.failureMetrics
    );
    throw error;
  } finally {
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: recoverySession,
      targetId: recoveryTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: clearSession,
      targetId: clearTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: observerSession,
      targetId: observerTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    await stopProcess(chrome.process);
  }
}

async function proveStarterStorageEvictionRecovery(args: {
  chrome: string;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  const clientId = 'web-storage-eviction';
  const title = `storage eviction ${Date.now()}`;
  let activeSession: CdpSession | null = null;
  let activeTargetId: string | null = null;
  let observerSession: CdpSession | null = null;
  let observerTargetId: string | null = null;
  let clearSession: CdpSession | null = null;
  let clearTargetId: string | null = null;
  let recoverySession: CdpSession | null = null;
  let recoveryTargetId: string | null = null;
  let lastProbe: BrowserPreviewProbe | null = null;

  try {
    const activeTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    activeTargetId = activeTarget.id;
    activeSession = await CdpSession.connect(activeTarget.webSocketDebuggerUrl);
    await enableChromeTarget(activeSession);
    await navigateChromeTarget(
      activeSession,
      `${args.origin}/?syncularClientId=${clientId}&syncularStorageEvictionProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      activeSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(activeSession);
    await writeStarterStorageEvictionSentinel(activeSession);
    const sentinelBefore =
      await readStarterStorageEvictionSentinel(activeSession);
    if (
      sentinelBefore.cachePresent !== true ||
      sentinelBefore.indexedDbPresent !== true ||
      sentinelBefore.localStoragePresent !== true
    ) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'storage-eviction-sentinel-write-missing',
        lastProbe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview storage eviction sentinel was not visible before clear. Failure artifact: ${args.failureArtifactPath}`
      );
    }

    const beforeTask = await readStarterBrowserProbe(activeSession);
    lastProbe = beforeTask;
    await submitStarterTask(activeSession, title);
    await waitForStarterLocalVisibility({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });
    await waitForStarterCommandTimelineProof({
      expectedCount: beforeTask.commandTimelineProof.count + 1,
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: activeSession,
    });

    const observerTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    observerTargetId = observerTarget.id;
    observerSession = await CdpSession.connect(
      observerTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(observerSession);
    await navigateChromeTarget(
      observerSession,
      `${args.origin}/?syncularClientId=web-storage-eviction-observer&syncularStorageEvictionObserverProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      observerSession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: observerSession,
      title,
      errorReason: 'storage-eviction-propagation-errors',
      timeoutReason: 'storage-eviction-propagation-timeout',
      timeoutMessage:
        'Timed out waiting for built preview storage eviction propagation',
    });

    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    activeSession = null;
    activeTargetId = null;
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: observerSession,
      targetId: observerTargetId,
    });
    observerSession = null;
    observerTargetId = null;

    const clearTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    clearTargetId = clearTarget.id;
    clearSession = await CdpSession.connect(clearTarget.webSocketDebuggerUrl);
    await enableChromeTarget(clearSession);
    await clearStarterOriginStorage(clearSession, args.origin);
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: clearSession,
      targetId: clearTargetId,
    });
    clearSession = null;
    clearTargetId = null;

    const recoveryTarget = await createChromeTarget(
      chrome.debugPort,
      'about:blank'
    );
    recoveryTargetId = recoveryTarget.id;
    recoverySession = await CdpSession.connect(
      recoveryTarget.webSocketDebuggerUrl
    );
    await enableChromeTarget(recoverySession);
    await navigateChromeTarget(
      recoverySession,
      `${args.origin}/?syncularClientId=${clientId}&syncularStorageEvictionRecoveryProof=${Date.now()}`
    );
    await waitForStarterBrowserReady(
      recoverySession,
      args.failureArtifactPath,
      args.failureMetrics
    );
    lastProbe = await readStarterBrowserProbe(recoverySession);
    const sentinelAfter =
      await readStarterStorageEvictionSentinel(recoverySession);
    if (
      sentinelAfter.cachePresent !== false ||
      sentinelAfter.indexedDbPresent !== false ||
      sentinelAfter.localStoragePresent !== false
    ) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'storage-eviction-sentinel-still-present',
        lastProbe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview storage eviction sentinel survived origin clear. Failure artifact: ${args.failureArtifactPath}`
      );
    }

    await waitForStarterText({
      failureArtifactPath: args.failureArtifactPath,
      failureMetrics: args.failureMetrics,
      session: recoverySession,
      title,
      errorReason: 'storage-eviction-recovery-errors',
      timeoutReason: 'storage-eviction-recovery-timeout',
      timeoutMessage:
        'Timed out waiting for built preview storage eviction recovery',
    });
  } catch (error) {
    await writeBrowserPreviewFailureArtifactIfMissing(
      args.failureArtifactPath,
      'storage-eviction-smoke-error',
      lastProbe,
      args.failureMetrics
    );
    throw error;
  } finally {
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: recoverySession,
      targetId: recoveryTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: clearSession,
      targetId: clearTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: observerSession,
      targetId: observerTargetId,
    });
    await closeStarterChromeTarget({
      debugPort: chrome.debugPort,
      session: activeSession,
      targetId: activeTargetId,
    });
    await stopProcess(chrome.process);
  }
}

type StarterStorageEvictionSentinelState = {
  cachePresent: boolean | null;
  indexedDbPresent: boolean | null;
  localStoragePresent: boolean | null;
};

async function writeStarterStorageEvictionSentinel(
  session: CdpSession
): Promise<StarterStorageEvictionSentinelState> {
  const result = await session.evaluate<
    | {
        ok: true;
        cachePresent: boolean;
        indexedDbPresent: boolean;
        localStoragePresent: boolean;
        storedBytes: number;
      }
    | { ok: false; reason: string }
  >(`(async () => {
    try {
      const bytes = ${STARTER_STORAGE_EVICTION_SENTINEL_BYTES};
      const cacheName = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_CACHE)};
      const localStorageKey = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_KEY)};
      const sentinelUrl = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_URL)};
      if (typeof globalThis.localStorage?.setItem !== 'function') {
        return { ok: false, reason: 'local-storage-unavailable' };
      }
      if (typeof globalThis.caches?.open !== 'function') {
        return { ok: false, reason: 'cache-storage-unavailable' };
      }
      const indexedDB = globalThis.indexedDB;
      if (typeof indexedDB?.open !== 'function') {
        return { ok: false, reason: 'indexeddb-unavailable' };
      }
      if (typeof indexedDB.databases !== 'function') {
        return { ok: false, reason: 'indexeddb-databases-unavailable' };
      }

      globalThis.localStorage.setItem(
        localStorageKey,
        'present:' + Date.now()
      );
      const cache = await globalThis.caches.open(cacheName);
      const payload = new Uint8Array(bytes);
      payload.fill(83);
      await cache.put(
        sentinelUrl,
        new Response(new Blob([payload]), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      );
      const indexedDbName = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_INDEXEDDB)};
      const indexedDbStore = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_INDEXEDDB_STORE)};
      const indexedDbKey = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_INDEXEDDB_KEY)};
      const openDatabase = () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(indexedDbName, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(indexedDbStore)) {
              db.createObjectStore(indexedDbStore);
            }
          };
          request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
          request.onsuccess = () => resolve(request.result);
        });
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(indexedDbStore, 'readwrite');
        transaction.objectStore(indexedDbStore).put('present:' + Date.now(), indexedDbKey);
        transaction.onerror = () => reject(transaction.error ?? new Error('indexeddb write failed'));
        transaction.oncomplete = () => resolve(true);
      });
      database.close();
      const indexedDbPresent = (await indexedDB.databases()).some(
        (databaseInfo) => databaseInfo.name === indexedDbName
      );
      return {
        ok: true,
        cachePresent: Boolean(await cache.match(sentinelUrl)),
        indexedDbPresent,
        localStoragePresent:
          globalThis.localStorage.getItem(localStorageKey) !== null,
        storedBytes: bytes,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })()`);
  if (!result.ok) {
    throw new Error(
      `Could not write browser storage eviction sentinel: ${result.reason}`
    );
  }
  if (
    !result.cachePresent ||
    !result.indexedDbPresent ||
    !result.localStoragePresent
  ) {
    throw new Error(
      'Browser storage eviction sentinel write completed without readable cache/IndexedDB/localStorage state'
    );
  }
  return {
    cachePresent: result.cachePresent,
    indexedDbPresent: result.indexedDbPresent,
    localStoragePresent: result.localStoragePresent,
  };
}

async function readStarterStorageEvictionSentinel(
  session: CdpSession
): Promise<StarterStorageEvictionSentinelState> {
  const result = await session.evaluate<
    | {
        ok: true;
        cachePresent: boolean | null;
        indexedDbPresent: boolean | null;
        localStoragePresent: boolean | null;
      }
    | { ok: false; reason: string }
  >(`(async () => {
    try {
      const cacheName = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_CACHE)};
      const indexedDbName = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_INDEXEDDB)};
      const indexedDbStore = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_INDEXEDDB_STORE)};
      const indexedDbKey = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_INDEXEDDB_KEY)};
      const localStorageKey = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_KEY)};
      const sentinelUrl = ${JSON.stringify(STARTER_STORAGE_EVICTION_SENTINEL_URL)};
      let localStoragePresent = null;
      if (typeof globalThis.localStorage?.getItem === 'function') {
        localStoragePresent =
          globalThis.localStorage.getItem(localStorageKey) !== null;
      }

      let cachePresent = null;
      if (
        typeof globalThis.caches?.has === 'function' &&
        typeof globalThis.caches?.open === 'function'
      ) {
        if (await globalThis.caches.has(cacheName)) {
          const cache = await globalThis.caches.open(cacheName);
          cachePresent = Boolean(await cache.match(sentinelUrl));
        } else {
          cachePresent = false;
        }
      }

      let indexedDbPresent = null;
      const indexedDB = globalThis.indexedDB;
      if (
        typeof indexedDB?.databases === 'function' &&
        typeof indexedDB?.open === 'function'
      ) {
        const databases = await indexedDB.databases();
        if (!databases.some((databaseInfo) => databaseInfo.name === indexedDbName)) {
          indexedDbPresent = false;
        } else {
          indexedDbPresent = await new Promise((resolve) => {
            const request = indexedDB.open(indexedDbName);
            request.onerror = () => resolve(false);
            request.onsuccess = () => {
              const database = request.result;
              if (!database.objectStoreNames.contains(indexedDbStore)) {
                database.close();
                resolve(false);
                return;
              }
              const transaction = database.transaction(indexedDbStore, 'readonly');
              const getRequest = transaction.objectStore(indexedDbStore).get(indexedDbKey);
              getRequest.onerror = () => {
                database.close();
                resolve(false);
              };
              getRequest.onsuccess = () => {
                const present = getRequest.result !== undefined;
                database.close();
                resolve(present);
              };
            };
          });
        }
      }

      return { ok: true, cachePresent, indexedDbPresent, localStoragePresent };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })()`);
  if (!result.ok) {
    throw new Error(
      `Could not read browser storage eviction sentinel: ${result.reason}`
    );
  }
  return {
    cachePresent: result.cachePresent,
    indexedDbPresent: result.indexedDbPresent,
    localStoragePresent: result.localStoragePresent,
  };
}

async function clearStarterOriginStorage(
  session: CdpSession,
  origin: string
): Promise<void> {
  await session.send('Storage.clearDataForOrigin', {
    origin,
    storageTypes: 'all',
  });
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
}

async function clearStarterDatabaseStorage(
  session: CdpSession,
  origin: string
): Promise<void> {
  await session.send('Storage.clearDataForOrigin', {
    origin,
    storageTypes: STARTER_DATABASE_STORAGE_EVICTION_TYPES,
  });
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
}

type StarterOriginStorageUsage = {
  overrideActive: boolean | null;
  quotaBytes: number | null;
  usageBytes: number | null;
};

type StarterOriginQuotaPressure = {
  availableBytes: number;
  overrideActive: boolean | null;
  quotaBytes: number;
  usageBytes: number;
  usageRatio: number;
};

async function configureStarterQuotaPressure(
  session: CdpSession,
  origin: string
): Promise<StarterOriginQuotaPressure> {
  await fillStarterOriginStorageForQuotaPressure(session);
  const before = await readStarterOriginStorageUsage(session, origin);
  if (
    before.usageBytes == null ||
    before.usageBytes < STARTER_QUOTA_PRESSURE_FILL_BYTES / 2
  ) {
    throw new Error(
      `Chrome did not report enough origin storage usage for quota-pressure proof: ${before.usageBytes ?? 'unknown'}`
    );
  }
  const quotaSize = Math.max(
    Math.ceil(before.usageBytes / 0.92),
    before.usageBytes + 512 * 1024
  );
  await session.send('Storage.overrideQuotaForOrigin', {
    origin,
    quotaSize,
  });
  const after = await readStarterOriginStorageUsage(session, origin);
  if (after.overrideActive !== true) {
    throw new Error('Chrome did not report an active quota override');
  }
  if (after.quotaBytes == null || after.usageBytes == null) {
    throw new Error('Chrome quota override did not expose usage/quota data');
  }
  if (after.usageBytes / after.quotaBytes < 0.9) {
    throw new Error(
      `Chrome quota override did not create high storage pressure: ${after.usageBytes}/${after.quotaBytes}`
    );
  }
  return {
    availableBytes: Math.max(0, after.quotaBytes - after.usageBytes),
    overrideActive: after.overrideActive,
    quotaBytes: after.quotaBytes,
    usageBytes: after.usageBytes,
    usageRatio: after.usageBytes / after.quotaBytes,
  };
}

async function fillStarterOriginStorageForQuotaPressure(
  session: CdpSession
): Promise<void> {
  const result = await session.evaluate<
    | {
        ok: true;
        quotaBytes: number | null;
        storedBytes: number;
        usageBytes: number | null;
      }
    | { ok: false; reason: string }
  >(`(async () => {
    const bytes = ${STARTER_QUOTA_PRESSURE_FILL_BYTES};
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.estimate !== 'function') {
      return { ok: false, reason: 'storage-estimate-unavailable' };
    }
    if (typeof globalThis.caches?.open !== 'function') {
      return { ok: false, reason: 'cache-storage-unavailable' };
    }

    const cache = await globalThis.caches.open('syncular-quota-pressure-proof');
    const payload = new Uint8Array(bytes);
    payload.fill(65);
    await cache.put(
      '/__syncular-quota-pressure-proof.bin?bytes=' + bytes + '&t=' + Date.now(),
      new Response(new Blob([payload]), {
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
    const estimate = await storage.estimate();
    return {
      ok: true,
      quotaBytes:
        typeof estimate.quota === 'number' && Number.isFinite(estimate.quota)
          ? estimate.quota
          : null,
      storedBytes: bytes,
      usageBytes:
        typeof estimate.usage === 'number' && Number.isFinite(estimate.usage)
          ? estimate.usage
          : null,
    };
  })()`);
  if (!result.ok) {
    throw new Error(
      `Could not fill browser origin storage for quota-pressure proof: ${result.reason}`
    );
  }
  if (
    result.usageBytes == null ||
    result.usageBytes < STARTER_QUOTA_PRESSURE_FILL_BYTES / 2
  ) {
    throw new Error(
      `Browser storage estimate did not include quota-pressure payload: ${result.usageBytes ?? 'unknown'}`
    );
  }
}

async function readStarterOriginStorageUsage(
  session: CdpSession,
  origin: string
): Promise<StarterOriginStorageUsage> {
  const result = (await session.send('Storage.getUsageAndQuota', {
    origin,
  })) as {
    overrideActive?: unknown;
    quota?: unknown;
    usage?: unknown;
  };
  return {
    overrideActive:
      typeof result.overrideActive === 'boolean' ? result.overrideActive : null,
    quotaBytes:
      typeof result.quota === 'number' && Number.isFinite(result.quota)
        ? result.quota
        : null,
    usageBytes:
      typeof result.usage === 'number' && Number.isFinite(result.usage)
        ? result.usage
        : null,
  };
}

async function dispatchStarterQuotaPressureProof(
  session: CdpSession,
  quotaPressure: StarterOriginQuotaPressure
): Promise<void> {
  await session.evaluate(`(() => {
    window.dispatchEvent(
      new CustomEvent('syncular-starter-run-quota-pressure-proof', {
        detail: ${JSON.stringify({
          availableBytes: quotaPressure.availableBytes,
          overrideActive: quotaPressure.overrideActive,
          quotaBytes: quotaPressure.quotaBytes,
          source: 'chrome-devtools-protocol',
          usageBytes: quotaPressure.usageBytes,
          usageRatio: quotaPressure.usageRatio,
        })},
      })
    );
    return true;
  })()`);
}

async function waitForStarterQuotaPressureEvidence(args: {
  expectedCount: number;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'quota-pressure-proof-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview quota-pressure proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    if (
      probe.quotaPressureProof.status === 'complete' &&
      probe.quotaPressureProof.count >= args.expectedCount &&
      probe.quotaPressureProof.quotaPressure === 'high' &&
      probe.quotaPressureProof.issueCodes.includes(
        'browser.storage_pressure_high'
      ) &&
      probe.quotaPressureProof.usageRatio !== null &&
      probe.quotaPressureProof.usageRatio >= 0.9 &&
      probe.quotaPressureProof.quotaBytes !== null &&
      probe.quotaPressureProof.usageBytes !== null &&
      probe.quotaPressureProof.availableBytes !== null &&
      probe.quotaPressureProof.issueCount >= 1 &&
      probe.quotaPressureProof.actionCount >= 1
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'quota-pressure-proof-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview quota-pressure preflight evidence. Failure artifact: ${args.failureArtifactPath}`
  );
}

function starterQuotaExhaustionWriteBytes(
  quotaPressure: StarterOriginQuotaPressure
): number {
  return Math.max(
    STARTER_QUOTA_EXHAUSTION_WRITE_MIN_BYTES,
    Math.ceil(
      quotaPressure.availableBytes + STARTER_QUOTA_EXHAUSTION_WRITE_EXTRA_BYTES
    )
  );
}

async function dispatchStarterQuotaExhaustionWriteProof(
  session: CdpSession,
  quotaPressure: StarterOriginQuotaPressure
): Promise<number> {
  const attemptedBytes = starterQuotaExhaustionWriteBytes(quotaPressure);
  await session.evaluate(`(() => {
    window.dispatchEvent(
      new CustomEvent('syncular-starter-run-quota-exhaustion-write-proof', {
        detail: ${JSON.stringify({
          attemptedBytes,
          availableBytes: quotaPressure.availableBytes,
          overrideActive: quotaPressure.overrideActive,
          quotaBytes: quotaPressure.quotaBytes,
          source: 'chrome-devtools-protocol',
          usageBytes: quotaPressure.usageBytes,
          usageRatio: quotaPressure.usageRatio,
        })},
      })
    );
    return true;
  })()`);
  return attemptedBytes;
}

async function waitForStarterQuotaExhaustionWriteCompletion(args: {
  attemptedBytes: number;
  expectedCount: number;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'quota-exhaustion-write-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview quota-exhaustion write proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const proof = probe.quotaExhaustionWriteProof;
    if (
      proof.status === 'complete' &&
      proof.count >= args.expectedCount &&
      proof.writeFailed === true &&
      proof.error !== null &&
      proof.durationMs !== null &&
      proof.attemptedBytes === args.attemptedBytes &&
      proof.availableBytes !== null &&
      proof.attemptedBytes > proof.availableBytes &&
      proof.quotaBytes !== null &&
      proof.usageBytes !== null &&
      proof.usageRatio !== null &&
      proof.usageRatio >= 0.9
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'quota-exhaustion-write-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview quota-exhaustion write proof. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function forceStarterSupportBundleFailureMarker(
  session: CdpSession
): Promise<void> {
  const result = await session.evaluate<{
    ok: boolean;
    reason: string | null;
  }>(`(() => {
    const supportBundle = document.querySelector('[data-syncular-support-bundle-status]');
    if (!(supportBundle instanceof HTMLElement)) {
      return { ok: false, reason: 'support-bundle-marker-missing' };
    }
    const readCount = (name) => {
      const value = Number(supportBundle.getAttribute(name) ?? 0);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    };
    supportBundle.setAttribute('data-syncular-support-bundle-status', 'failed');
    supportBundle.setAttribute('data-syncular-support-bundle-redacted', 'true');
    supportBundle.setAttribute(
      'data-syncular-support-bundle-issue-count',
      String(Math.max(1, readCount('data-syncular-support-bundle-issue-count')))
    );
    supportBundle.setAttribute(
      'data-syncular-support-bundle-section-error-count',
      String(Math.max(1, readCount('data-syncular-support-bundle-section-error-count')))
    );
    supportBundle.textContent = 'support bundle failed';
    return { ok: true, reason: null };
  })()`);
  if (!result.ok) {
    throw new Error(
      `Could not force built preview support-bundle failure marker: ${result.reason}`
    );
  }
}

async function verifyExpectedSupportBundleFailureArtifact(
  path: string
): Promise<void> {
  const artifact = JSON.parse(await readFile(path, 'utf8')) as unknown;
  assertBrowserPreviewFailureArtifactShape(artifact, path);
  if (artifact.reason !== 'page-reported-errors') {
    throw new Error(
      `${path} had reason ${artifact.reason}; expected page-reported-errors`
    );
  }
  if (artifact.probe === null) {
    throw new Error(`${path} did not include the live browser probe`);
  }
  if (!artifact.probe.errors.includes('support bundle export failed')) {
    throw new Error(
      `${path} did not include the support bundle export failure error`
    );
  }
  if (artifact.probe.supportBundle.status !== 'failed') {
    throw new Error(`${path} did not preserve supportBundle.status=failed`);
  }
  if (artifact.probe.supportBundle.redacted !== 'true') {
    throw new Error(`${path} did not preserve redacted support-bundle state`);
  }
  if (artifact.probe.supportBundle.issueCount < 1) {
    throw new Error(`${path} did not preserve support-bundle issue evidence`);
  }
  if (artifact.probe.supportBundle.sectionErrorCount < 1) {
    throw new Error(
      `${path} did not preserve support-bundle section-error evidence`
    );
  }
  if (artifact.probe.deploymentPreflight.status !== 'ready') {
    throw new Error(
      `${path} did not include ready deployment-preflight evidence`
    );
  }
  if (
    artifact.probe.browserSupportPolicy.policy !== 'supported-after-preflight'
  ) {
    throw new Error(
      `${path} did not include supported-after-preflight browser support-policy evidence`
    );
  }
  if (
    artifact.probe.browserSupportPolicy.status !== 'met' &&
    artifact.probe.browserSupportPolicy.status !== 'warning'
  ) {
    throw new Error(
      `${path} did not include actionable browser support-policy evidence`
    );
  }
  log('support-bundle failure artifact check passed');
}

async function waitForStarterBrowserUrl(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  session: CdpSession;
  url: string;
}): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    try {
      const href = await args.session.evaluate<string>('window.location.href');
      if (href === args.url) return;
    } catch {
      // The execution context can disappear briefly while the navigation
      // commits. Keep polling until the new page is observable.
    }
    try {
      lastProbe = await readStarterBrowserProbe(args.session);
    } catch {
      // Ignore transient evaluation failures while the page is navigating.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }

  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'reload-navigation-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview reload navigation. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function waitForStarterLocalVisibility(args: {
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'local-visibility-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview local visibility failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    if (
      probe.starterTimeline.localVisibilityStatus === 'visible' &&
      probe.starterTimeline.localVisibilityMs !== null
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'local-visibility-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview local visibility. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function waitForStarterCommandTimelineProof(args: {
  expectedCount: number;
  failureArtifactPath: string;
  failureMetrics: BrowserPreviewFailureMetricsInput;
  session: CdpSession;
}): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.session);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'command-timeline-proof-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview command timeline proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const proof = probe.commandTimelineProof;
    if (
      proof.status === 'complete' &&
      proof.count >= args.expectedCount &&
      proof.clientCommitId !== null &&
      proof.durationMs !== null &&
      proof.eventCount >= 3 &&
      proof.outboxPersisted &&
      proof.localApplyObserved &&
      proof.localVisibilityObserved &&
      proof.localVisibilityState === 'visible' &&
      !proof.missingEvidence.includes('outbox-status') &&
      !proof.missingEvidence.includes('local-apply') &&
      !proof.missingEvidence.includes('local-visibility') &&
      probe.starterTimeline.commandTimelineStatus === 'complete'
    ) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'command-timeline-proof-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview command timeline proof. Failure artifact: ${args.failureArtifactPath}`
  );
}

async function writeBrowserPreviewFailureArtifact(
  path: string,
  reason: string,
  probe: BrowserPreviewProbe | null,
  metrics: BrowserPreviewFailureMetricsInput
): Promise<void> {
  const artifact: BrowserPreviewFailureArtifact = {
    generatedAt: new Date().toISOString(),
    metrics: finalizeBrowserPreviewFailureMetrics(metrics),
    reason,
    probe,
  };
  assertBrowserPreviewFailureArtifactShape(artifact, path);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

async function writeBrowserPreviewFailureArtifactIfMissing(
  path: string,
  reason: string,
  probe: BrowserPreviewProbe | null,
  metrics: BrowserPreviewFailureMetricsInput
): Promise<void> {
  if (existsSync(path)) return;
  await writeBrowserPreviewFailureArtifact(path, reason, probe, metrics);
}

async function verifyBrowserPreviewFailureArtifactSelfCheck(
  workDir: string,
  metrics: BrowserPreviewFailureMetricsInput
): Promise<void> {
  const path = join(workDir, 'browser-preview-failure.self-check.json');
  await writeBrowserPreviewFailureArtifact(
    path,
    'artifact-self-check',
    {
      ready: false,
      errors: ['support bundle export failed'],
      markers: {
        durableHealthLine: true,
        schemaLine: true,
        preflightFailure: false,
        databaseOpening: false,
      },
      browserHealth: {
        blockedOperationCount: 0,
        generatedMutation: 'available',
        lifecycleStage: 'realtime-live',
        localVisibility: 'available',
        recoveryOwner: 'runtime',
        status: 'healthy',
        syncNow: 'available',
      },
      deploymentPreflight: {
        actionCount: 0,
        availableBytes: 107_374_178_304,
        issueCount: 0,
        minimumAvailableBytes: 26_214_400,
        minimumQuotaBytes: 52_428_800,
        persistence: 'persistent',
        persisted: 'true',
        preflightMs: 2,
        quotaPressure: 'normal',
        quotaBytes: 107_374_182_400,
        serviceWorker: 'true',
        serviceWorkerControlled: 'true',
        serviceWorkerControllerScriptPath: '/__syncular/sw.js',
        serviceWorkerControllerState: 'activated',
        status: 'ready',
        supportTier: 'persistent-offline',
        usageRatio: 0.00000003814697265625,
        usageBytes: 4096,
      },
      browserSupportPolicy: {
        actionCount: 0,
        context: 'chromium-secure-page',
        expectedPersistence: 'persistent',
        expectedSupportTier: 'persistent-offline',
        issueCount: 0,
        knownRisks: ['storage can be evicted'],
        knownRiskCount: 1,
        nextSteps: ['run reopen smoke'],
        nextStepCount: 1,
        observedPersistence: 'persistent',
        observedSupportTier: 'persistent-offline',
        policy: 'supported-after-preflight',
        preflightRequired: 'true',
        reasonCodes: ['browser_support.policy_met'],
        reasonCount: 1,
        requiredEvidence: ['deployment preflight passed'],
        requiredEvidenceCount: 1,
        status: 'met',
      },
      supportBundle: {
        status: 'failed',
        redacted: 'true',
        sectionCount: 4,
        issueCount: 1,
        blobEventCount: 0,
        cursorCount: 1,
        latestBlobCode: null,
        latestLocalApplyCode: 'local.visibility.visible',
        latestRealtimeCode: 'realtime.sync_wakeup',
        latestSyncCode: 'sync.pull.complete',
        localApplyEventCount: 1,
        realtimeEventCount: 2,
        requestIdCount: 0,
        sectionErrorCount: 1,
        syncAttemptIdCount: 1,
        syncEventCount: 3,
        timelineEventCount: 12,
      },
      commandTimelineProof: {
        clientCommitId: 'commit-self-check',
        complete: false,
        contextEventCount: 1,
        count: 1,
        durationMs: 6,
        error: null,
        errorCode: null,
        eventCount: 3,
        localApplyObserved: true,
        localApplyCommitSeq: null,
        localApplyOutboxId: 'outbox-self-check',
        localVisibilityObserved: true,
        localVisibilitySource: 'query',
        localVisibilityState: 'visible',
        localVisibilityTrigger: 'initial',
        matchedEventCount: 1,
        missingEvidence: [
          'push-request-id',
          'sync-attempt',
          'server-commit-sequence',
          'realtime-event-cursor',
          'pull-reason',
        ],
        missingEvidenceCount: 5,
        outboxPersisted: true,
        pullReasonObserved: false,
        pullReason: null,
        realtimeCursorObserved: false,
        realtimeCursor: null,
        requestCorrelated: false,
        requestId: null,
        serverCommitObserved: false,
        serverCommitSeq: null,
        scopeJoined: true,
        state: 'queued',
        status: 'complete',
        subscriptionIdCount: 1,
        subscriptionIds: ['tasks:user-1'],
        syncAttemptId: null,
        syncAttemptObserved: false,
        traceId: null,
        spanId: null,
      },
      lifecycleResume: {
        status: 'complete',
        count: 2,
        reason: 'online',
        error: null,
        lockName: STARTER_LIFECYCLE_RESUME_LOCK_NAME,
        lockRequired: 'false',
        lockState: 'acquired',
        lockTimeoutMs: 10_000,
      },
      lifecyclePause: {
        count: 2,
        reason: 'beforeunload',
        pagehidePersisted: 'true',
        shutdownSignalCount: 1,
        visibilityState: 'visible',
      },
      localRecoveryProof: {
        actionKind: 'export-support-bundle',
        count: 2,
        error: null,
        errorCode: null,
        lockName: STARTER_LOCAL_RECOVERY_LOCK_NAME,
        lockRequired: 'false',
        lockState: 'acquired',
        lockTimeoutMs: STARTER_LOCAL_RECOVERY_LOCK_TIMEOUT_MS,
        status: 'complete',
      },
      storageRecoveryProof: {
        actionKinds: ['request-persistent-storage', 'compact-storage'],
        availableBytes: 524_288,
        clearBlobCacheCompleted: 'false',
        compactCompleted: 'true',
        count: 1,
        dataLossConsequenceCount: 0,
        destructiveSafetyCount: 0,
        error: null,
        errorCode: null,
        issueCodes: ['browser.storage_pressure_high'],
        issueCount: 1,
        planActionCount: 2,
        quotaBytes: 10_485_760,
        quotaPressure: 'high',
        requestPersistenceGranted: 'true',
        requestPersistenceOffered: 'true',
        requestPersistenceSupported: 'true',
        source: 'browser-observed',
        status: 'complete',
        outboxSafetyStatus: null,
        usageBytes: 9_961_472,
        usageRatio: 0.95,
      },
      quotaPressureProof: {
        actionCount: 1,
        availableBytes: 524_288,
        count: 1,
        error: null,
        errorCode: null,
        issueCodes: ['browser.storage_pressure_high'],
        issueCount: 1,
        persistence: 'evictable',
        quotaBytes: 10_485_760,
        quotaPressure: 'high',
        status: 'complete',
        supportTier: 'unknown',
        usageBytes: 9_961_472,
        usageRatio: 0.95,
      },
      writePressureProof: {
        durationMs: 8,
        error: null,
        errorCode: null,
        requestedCount: STARTER_WRITE_PRESSURE_PROOF_COUNT,
        runCount: 1,
        status: 'complete',
        titlePrefix: 'write pressure self check',
        visibleCount: STARTER_WRITE_PRESSURE_PROOF_COUNT,
      },
      quotaExhaustionWriteProof: {
        attemptedBytes: STARTER_QUOTA_EXHAUSTION_WRITE_MIN_BYTES,
        availableBytes: 524_288,
        count: 1,
        durationMs: 12,
        error: 'Quota exceeded',
        errorCode: 'browser.quota_exhausted',
        quotaBytes: 10_485_760,
        status: 'complete',
        usageBytes: 9_961_472,
        usageRatio: 0.95,
        writeFailed: true,
      },
      storageShutdownProof: {
        closed: true,
        count: 1,
        durationMs: 10,
        error: null,
        errorCode: null,
        lifecyclePhase: 'closed',
        mutationRejected: true,
        postCloseErrorCode: 'worker.closed',
        status: 'complete',
      },
      starterTimeline: {
        bootstrapReadyMs: 10,
        bootstrapStatus: 'ready',
        commandTimelineStatus: 'complete',
        databaseOpenMs: 12,
        healthRefreshMs: 3,
        localVisibilityErrorCode: null,
        localVisibilityMs: 5,
        localVisibilityStatus: 'visible',
        marker: true,
        realtimeConnectedMs: 14,
        realtimeStatus: 'connected',
        schemaReadinessMs: 2,
        supportBundleExportMs: 4,
      },
      starterOpen: {
        diagnosticCode: 'sync.syncOnce.completed',
        diagnosticCount: 1,
        diagnosticLevel: 'info',
        diagnosticSource: 'sync',
        error: null,
        phase: 'ready',
      },
      textExcerpt:
        'Syncular support bundle failed after redacted export check.',
    },
    metrics
  );

  const artifact = JSON.parse(await readFile(path, 'utf8')) as unknown;
  assertBrowserPreviewFailureArtifactShape(artifact, path);
  await rm(path, { force: true });
  log('browser failure artifact shape and metrics check passed');
}

function assertBrowserPreviewFailureArtifactShape(
  artifact: unknown,
  path: string
): asserts artifact is BrowserPreviewFailureArtifact {
  if (!isRecord(artifact)) {
    throw new Error(`${path} did not contain a JSON object`);
  }

  if (
    typeof artifact.generatedAt !== 'string' ||
    Number.isNaN(Date.parse(artifact.generatedAt))
  ) {
    throw new Error(`${path} had an invalid generatedAt value`);
  }
  if (
    typeof artifact.reason !== 'string' ||
    artifact.reason.trim().length === 0
  ) {
    throw new Error(`${path} had an invalid reason value`);
  }
  assertBrowserPreviewFailureMetricsShape(artifact.metrics, path);
  if (artifact.probe !== null) {
    assertBrowserPreviewProbeShape(artifact.probe, path);
  }
}

function finalizeBrowserPreviewFailureMetrics(
  metrics: BrowserPreviewFailureMetricsInput
): BrowserPreviewFailureMetrics {
  return {
    artifactCreatedAfterMs: elapsedSince(metrics.smokeStartedAtMs),
    assetCheckMs: metrics.assetCheckMs,
    assetCount: metrics.assetCount,
    browserHealthMarkerInAssets: metrics.browserHealthMarkerInAssets,
    browserSupportPolicyMarkerInAssets:
      metrics.browserSupportPolicyMarkerInAssets,
    commandTimelineMarkerInAssets: metrics.commandTimelineMarkerInAssets,
    cssAssetBytes: metrics.cssAssetBytes,
    cssAssetCount: metrics.cssAssetCount,
    deploymentPreflightMarkerInAssets:
      metrics.deploymentPreflightMarkerInAssets,
    jsAssetBytes: metrics.jsAssetBytes,
    jsAssetCount: metrics.jsAssetCount,
    lifecycleResumeMarkerInAssets: metrics.lifecycleResumeMarkerInAssets,
    otherAssetBytes: metrics.otherAssetBytes,
    otherAssetCount: metrics.otherAssetCount,
    previewReadyMs: metrics.previewReadyMs,
    starterTimelineMarkerInAssets: metrics.starterTimelineMarkerInAssets,
    storageShutdownMarkerInAssets: metrics.storageShutdownMarkerInAssets,
    storageRecoveryMarkerInAssets: metrics.storageRecoveryMarkerInAssets,
    supportBundleMarkerInAssets: metrics.supportBundleMarkerInAssets,
    totalAssetBytes: metrics.totalAssetBytes,
  };
}

function assertBrowserPreviewFailureMetricsShape(
  metrics: unknown,
  path: string
): asserts metrics is BrowserPreviewFailureMetrics {
  if (!isRecord(metrics)) {
    throw new Error(`${path} metrics was not a JSON object`);
  }
  for (const key of [
    'artifactCreatedAfterMs',
    'assetCheckMs',
    'assetCount',
    'cssAssetBytes',
    'cssAssetCount',
    'jsAssetBytes',
    'jsAssetCount',
    'otherAssetBytes',
    'otherAssetCount',
    'previewReadyMs',
    'totalAssetBytes',
  ] as const) {
    if (!isNonNegativeFiniteNumber(metrics[key])) {
      throw new Error(`${path} metrics.${key} was not a non-negative number`);
    }
  }
  for (const key of [
    'browserHealthMarkerInAssets',
    'browserSupportPolicyMarkerInAssets',
    'commandTimelineMarkerInAssets',
    'deploymentPreflightMarkerInAssets',
    'lifecycleResumeMarkerInAssets',
    'starterTimelineMarkerInAssets',
    'storageShutdownMarkerInAssets',
    'storageRecoveryMarkerInAssets',
    'supportBundleMarkerInAssets',
  ] as const) {
    if (typeof metrics[key] !== 'boolean') {
      throw new Error(`${path} metrics.${key} was not a boolean`);
    }
  }
}

function assertBrowserPreviewProbeShape(
  probe: unknown,
  path: string
): asserts probe is BrowserPreviewProbe {
  if (!isRecord(probe)) {
    throw new Error(`${path} probe was not a JSON object`);
  }
  if (typeof probe.ready !== 'boolean') {
    throw new Error(`${path} probe.ready was not a boolean`);
  }
  if (
    !Array.isArray(probe.errors) ||
    probe.errors.some((error) => typeof error !== 'string')
  ) {
    throw new Error(`${path} probe.errors was not a string array`);
  }
  assertBrowserPreviewMarkersShape(probe.markers, path);
  assertBrowserPreviewBrowserHealthShape(probe.browserHealth, path);
  assertBrowserPreviewDeploymentPreflightShape(probe.deploymentPreflight, path);
  assertBrowserPreviewSupportPolicyShape(probe.browserSupportPolicy, path);
  assertBrowserPreviewSupportBundleShape(probe.supportBundle, path);
  assertBrowserPreviewCommandTimelineProofShape(
    probe.commandTimelineProof,
    path
  );
  assertBrowserPreviewLifecycleResumeShape(probe.lifecycleResume, path);
  assertBrowserPreviewLifecyclePauseShape(probe.lifecyclePause, path);
  assertBrowserPreviewLocalRecoveryProofShape(probe.localRecoveryProof, path);
  assertBrowserPreviewStorageRecoveryProofShape(
    probe.storageRecoveryProof,
    path
  );
  assertBrowserPreviewQuotaPressureProofShape(probe.quotaPressureProof, path);
  assertBrowserPreviewWritePressureProofShape(probe.writePressureProof, path);
  assertBrowserPreviewQuotaExhaustionWriteProofShape(
    probe.quotaExhaustionWriteProof,
    path
  );
  assertBrowserPreviewStorageShutdownProofShape(
    probe.storageShutdownProof,
    path
  );
  assertBrowserPreviewStarterTimelineShape(probe.starterTimeline, path);
  assertBrowserPreviewStarterOpenShape(probe.starterOpen, path);
  if (
    typeof probe.textExcerpt !== 'string' ||
    probe.textExcerpt.length > 4000
  ) {
    throw new Error(`${path} probe.textExcerpt was not a bounded string`);
  }
}

function assertBrowserPreviewStarterOpenShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.starterOpen was not a JSON object`);
  }
  if (
    !isNonNegativeFiniteNumber(value.diagnosticCount) ||
    !Number.isInteger(value.diagnosticCount)
  ) {
    throw new Error(
      `${path} probe.starterOpen.diagnosticCount was not a non-negative integer`
    );
  }
  for (const key of [
    'diagnosticCode',
    'diagnosticLevel',
    'diagnosticSource',
    'error',
    'phase',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(`${path} probe.starterOpen.${key} was not nullable text`);
    }
  }
}

function assertBrowserPreviewStarterTimelineShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.starterTimeline was not a JSON object`);
  }
  if (typeof value.marker !== 'boolean') {
    throw new Error(`${path} probe.starterTimeline.marker was not a boolean`);
  }
  for (const key of [
    'bootstrapReadyMs',
    'databaseOpenMs',
    'healthRefreshMs',
    'localVisibilityMs',
    'realtimeConnectedMs',
    'schemaReadinessMs',
    'supportBundleExportMs',
  ] as const) {
    if (value[key] !== null && !isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.starterTimeline.${key} was not nullable non-negative number`
      );
    }
  }
  for (const key of [
    'bootstrapStatus',
    'commandTimelineStatus',
    'localVisibilityErrorCode',
    'localVisibilityStatus',
    'realtimeStatus',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.starterTimeline.${key} was not nullable text`
      );
    }
  }
}

function assertBrowserPreviewMarkersShape(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.markers was not a JSON object`);
  }
  for (const key of [
    'durableHealthLine',
    'schemaLine',
    'preflightFailure',
    'databaseOpening',
  ] as const) {
    if (typeof value[key] !== 'boolean') {
      throw new Error(`${path} probe.markers.${key} was not a boolean`);
    }
  }
}

function assertBrowserPreviewBrowserHealthShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.browserHealth was not a JSON object`);
  }
  if (
    !isNonNegativeFiniteNumber(value.blockedOperationCount) ||
    !Number.isInteger(value.blockedOperationCount)
  ) {
    throw new Error(
      `${path} probe.browserHealth.blockedOperationCount was not a non-negative integer`
    );
  }
  for (const key of [
    'generatedMutation',
    'lifecycleStage',
    'localVisibility',
    'recoveryOwner',
    'status',
    'syncNow',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.browserHealth.${key} was not nullable text`
      );
    }
  }
}

function assertBrowserPreviewDeploymentPreflightShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.deploymentPreflight was not a JSON object`);
  }
  for (const key of ['actionCount', 'issueCount'] as const) {
    if (!isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.deploymentPreflight.${key} was not a non-negative number`
      );
    }
  }
  for (const key of [
    'availableBytes',
    'minimumAvailableBytes',
    'minimumQuotaBytes',
    'preflightMs',
    'quotaBytes',
    'usageRatio',
    'usageBytes',
  ] as const) {
    if (value[key] !== null && !isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.deploymentPreflight.${key} was not nullable non-negative number`
      );
    }
  }
  for (const key of [
    'persistence',
    'persisted',
    'quotaPressure',
    'serviceWorker',
    'serviceWorkerControlled',
    'serviceWorkerControllerScriptPath',
    'serviceWorkerControllerState',
    'status',
    'supportTier',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.deploymentPreflight.${key} was not nullable text`
      );
    }
  }
}

function assertBrowserPreviewSupportPolicyShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.browserSupportPolicy was not a JSON object`);
  }
  for (const key of [
    'actionCount',
    'issueCount',
    'knownRiskCount',
    'nextStepCount',
    'reasonCount',
    'requiredEvidenceCount',
  ] as const) {
    if (!isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.browserSupportPolicy.${key} was not a non-negative number`
      );
    }
  }
  for (const key of [
    'knownRisks',
    'nextSteps',
    'reasonCodes',
    'requiredEvidence',
  ] as const) {
    if (
      !Array.isArray(value[key]) ||
      !value[key].every((item) => typeof item === 'string')
    ) {
      throw new Error(
        `${path} probe.browserSupportPolicy.${key} was not a text array`
      );
    }
  }
  const knownRisks = value.knownRisks as string[];
  const nextSteps = value.nextSteps as string[];
  const reasonCodes = value.reasonCodes as string[];
  const requiredEvidence = value.requiredEvidence as string[];
  if (value.knownRiskCount !== knownRisks.length) {
    throw new Error(
      `${path} probe.browserSupportPolicy.knownRiskCount did not match knownRisks length`
    );
  }
  if (value.nextStepCount !== nextSteps.length) {
    throw new Error(
      `${path} probe.browserSupportPolicy.nextStepCount did not match nextSteps length`
    );
  }
  if (value.reasonCount !== reasonCodes.length) {
    throw new Error(
      `${path} probe.browserSupportPolicy.reasonCount did not match reasonCodes length`
    );
  }
  if (value.requiredEvidenceCount !== requiredEvidence.length) {
    throw new Error(
      `${path} probe.browserSupportPolicy.requiredEvidenceCount did not match requiredEvidence length`
    );
  }
  for (const key of [
    'context',
    'expectedPersistence',
    'expectedSupportTier',
    'observedPersistence',
    'observedSupportTier',
    'policy',
    'preflightRequired',
    'status',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.browserSupportPolicy.${key} was not nullable text`
      );
    }
  }
}

function assertBrowserPreviewSupportBundleShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.supportBundle was not a JSON object`);
  }
  for (const key of [
    'status',
    'redacted',
    'latestBlobCode',
    'latestLocalApplyCode',
    'latestRealtimeCode',
    'latestSyncCode',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.supportBundle.${key} was not nullable text`
      );
    }
  }
  for (const key of [
    'blobEventCount',
    'cursorCount',
    'issueCount',
    'localApplyEventCount',
    'realtimeEventCount',
    'requestIdCount',
    'sectionCount',
    'sectionErrorCount',
    'syncAttemptIdCount',
    'syncEventCount',
    'timelineEventCount',
  ] as const) {
    if (!isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.supportBundle.${key} was not a non-negative number`
      );
    }
  }
}

function assertBrowserPreviewCommandTimelineProofShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.commandTimelineProof was not a JSON object`);
  }
  for (const key of [
    'complete',
    'localApplyObserved',
    'localVisibilityObserved',
    'outboxPersisted',
    'pullReasonObserved',
    'realtimeCursorObserved',
    'requestCorrelated',
    'serverCommitObserved',
    'scopeJoined',
    'syncAttemptObserved',
  ] as const) {
    if (typeof value[key] !== 'boolean') {
      throw new Error(
        `${path} probe.commandTimelineProof.${key} was not boolean`
      );
    }
  }
  if (
    !Array.isArray(value.missingEvidence) ||
    value.missingEvidence.some((item) => typeof item !== 'string')
  ) {
    throw new Error(
      `${path} probe.commandTimelineProof.missingEvidence was not a string array`
    );
  }
  if (value.missingEvidenceCount !== value.missingEvidence.length) {
    throw new Error(
      `${path} probe.commandTimelineProof.missingEvidenceCount did not match missingEvidence length`
    );
  }
  if (
    !Array.isArray(value.subscriptionIds) ||
    value.subscriptionIds.some((item) => typeof item !== 'string')
  ) {
    throw new Error(
      `${path} probe.commandTimelineProof.subscriptionIds was not a string array`
    );
  }
  if (value.subscriptionIdCount !== value.subscriptionIds.length) {
    throw new Error(
      `${path} probe.commandTimelineProof.subscriptionIdCount did not match subscriptionIds length`
    );
  }
  for (const key of [
    'clientCommitId',
    'error',
    'errorCode',
    'localApplyOutboxId',
    'localVisibilitySource',
    'localVisibilityState',
    'localVisibilityTrigger',
    'pullReason',
    'requestId',
    'state',
    'status',
    'syncAttemptId',
    'traceId',
    'spanId',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.commandTimelineProof.${key} was not nullable text`
      );
    }
  }
  for (const key of [
    'contextEventCount',
    'count',
    'eventCount',
    'matchedEventCount',
    'missingEvidenceCount',
    'subscriptionIdCount',
  ] as const) {
    if (
      !isNonNegativeFiniteNumber(value[key]) ||
      !Number.isInteger(value[key])
    ) {
      throw new Error(
        `${path} probe.commandTimelineProof.${key} was not a non-negative integer`
      );
    }
  }
  if (
    value.durationMs !== null &&
    !isNonNegativeFiniteNumber(value.durationMs)
  ) {
    throw new Error(
      `${path} probe.commandTimelineProof.durationMs was not nullable non-negative number`
    );
  }
  for (const key of ['localApplyCommitSeq', 'serverCommitSeq'] as const) {
    if (value[key] !== null && !isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.commandTimelineProof.${key} was not nullable non-negative number`
      );
    }
  }
  if (
    value.realtimeCursor !== null &&
    typeof value.realtimeCursor !== 'string' &&
    !isNonNegativeFiniteNumber(value.realtimeCursor)
  ) {
    throw new Error(
      `${path} probe.commandTimelineProof.realtimeCursor was not nullable text or non-negative number`
    );
  }
}

function assertBrowserPreviewLifecycleResumeShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.lifecycleResume was not a JSON object`);
  }
  for (const key of [
    'status',
    'reason',
    'error',
    'lockName',
    'lockRequired',
    'lockState',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.lifecycleResume.${key} was not nullable text`
      );
    }
  }
  if (!isNonNegativeFiniteNumber(value.count)) {
    throw new Error(
      `${path} probe.lifecycleResume.count was not a non-negative number`
    );
  }
  if (
    value.lockTimeoutMs !== null &&
    !isNonNegativeFiniteNumber(value.lockTimeoutMs)
  ) {
    throw new Error(
      `${path} probe.lifecycleResume.lockTimeoutMs was not nullable non-negative number`
    );
  }
}

function assertBrowserPreviewLifecyclePauseShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.lifecyclePause was not a JSON object`);
  }
  for (const key of [
    'reason',
    'pagehidePersisted',
    'visibilityState',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.lifecyclePause.${key} was not nullable text`
      );
    }
  }
  for (const key of ['count', 'shutdownSignalCount'] as const) {
    if (!isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.lifecyclePause.${key} was not a non-negative number`
      );
    }
  }
}

function assertBrowserPreviewLocalRecoveryProofShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.localRecoveryProof was not a JSON object`);
  }
  for (const key of [
    'actionKind',
    'error',
    'errorCode',
    'lockName',
    'lockRequired',
    'lockState',
    'status',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.localRecoveryProof.${key} was not nullable text`
      );
    }
  }
  if (!isNonNegativeFiniteNumber(value.count)) {
    throw new Error(
      `${path} probe.localRecoveryProof.count was not a non-negative number`
    );
  }
  if (
    value.lockTimeoutMs !== null &&
    !isNonNegativeFiniteNumber(value.lockTimeoutMs)
  ) {
    throw new Error(
      `${path} probe.localRecoveryProof.lockTimeoutMs was not nullable non-negative number`
    );
  }
}

function assertBrowserPreviewStorageRecoveryProofShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.storageRecoveryProof was not a JSON object`);
  }
  if (
    !Array.isArray(value.actionKinds) ||
    value.actionKinds.some((actionKind) => typeof actionKind !== 'string')
  ) {
    throw new Error(
      `${path} probe.storageRecoveryProof.actionKinds was not a string array`
    );
  }
  if (
    !Array.isArray(value.issueCodes) ||
    value.issueCodes.some((issueCode) => typeof issueCode !== 'string')
  ) {
    throw new Error(
      `${path} probe.storageRecoveryProof.issueCodes was not a string array`
    );
  }
  for (const key of [
    'clearBlobCacheCompleted',
    'compactCompleted',
    'error',
    'errorCode',
    'quotaPressure',
    'requestPersistenceGranted',
    'requestPersistenceOffered',
    'requestPersistenceSupported',
    'source',
    'status',
    'outboxSafetyStatus',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.storageRecoveryProof.${key} was not nullable text`
      );
    }
  }
  for (const key of [
    'count',
    'dataLossConsequenceCount',
    'destructiveSafetyCount',
    'issueCount',
    'planActionCount',
  ] as const) {
    if (
      !isNonNegativeFiniteNumber(value[key]) ||
      !Number.isInteger(value[key])
    ) {
      throw new Error(
        `${path} probe.storageRecoveryProof.${key} was not a non-negative integer`
      );
    }
  }
  for (const key of [
    'availableBytes',
    'quotaBytes',
    'usageBytes',
    'usageRatio',
  ] as const) {
    if (value[key] !== null && !isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.storageRecoveryProof.${key} was not nullable non-negative number`
      );
    }
  }
}

function assertBrowserPreviewQuotaPressureProofShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.quotaPressureProof was not a JSON object`);
  }
  if (
    !Array.isArray(value.issueCodes) ||
    value.issueCodes.some((issueCode) => typeof issueCode !== 'string')
  ) {
    throw new Error(
      `${path} probe.quotaPressureProof.issueCodes was not a string array`
    );
  }
  for (const key of ['actionCount', 'count', 'issueCount'] as const) {
    if (
      !isNonNegativeFiniteNumber(value[key]) ||
      !Number.isInteger(value[key])
    ) {
      throw new Error(
        `${path} probe.quotaPressureProof.${key} was not a non-negative integer`
      );
    }
  }
  for (const key of [
    'availableBytes',
    'quotaBytes',
    'usageBytes',
    'usageRatio',
  ] as const) {
    if (value[key] !== null && !isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.quotaPressureProof.${key} was not nullable non-negative number`
      );
    }
  }
  for (const key of [
    'error',
    'errorCode',
    'persistence',
    'quotaPressure',
    'status',
    'supportTier',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.quotaPressureProof.${key} was not nullable text`
      );
    }
  }
}

function assertBrowserPreviewWritePressureProofShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.writePressureProof was not a JSON object`);
  }
  for (const key of ['error', 'errorCode', 'status', 'titlePrefix'] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.writePressureProof.${key} was not nullable text`
      );
    }
  }
  for (const key of ['requestedCount', 'runCount', 'visibleCount'] as const) {
    if (
      !isNonNegativeFiniteNumber(value[key]) ||
      !Number.isInteger(value[key])
    ) {
      throw new Error(
        `${path} probe.writePressureProof.${key} was not a non-negative integer`
      );
    }
  }
  if (
    value.durationMs !== null &&
    !isNonNegativeFiniteNumber(value.durationMs)
  ) {
    throw new Error(
      `${path} probe.writePressureProof.durationMs was not nullable non-negative number`
    );
  }
}

function assertBrowserPreviewQuotaExhaustionWriteProofShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(
      `${path} probe.quotaExhaustionWriteProof was not a JSON object`
    );
  }
  for (const key of ['error', 'errorCode', 'status'] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.quotaExhaustionWriteProof.${key} was not nullable text`
      );
    }
  }
  for (const key of ['attemptedBytes', 'count'] as const) {
    if (
      !isNonNegativeFiniteNumber(value[key]) ||
      !Number.isInteger(value[key])
    ) {
      throw new Error(
        `${path} probe.quotaExhaustionWriteProof.${key} was not a non-negative integer`
      );
    }
  }
  for (const key of [
    'availableBytes',
    'durationMs',
    'quotaBytes',
    'usageBytes',
    'usageRatio',
  ] as const) {
    if (value[key] !== null && !isNonNegativeFiniteNumber(value[key])) {
      throw new Error(
        `${path} probe.quotaExhaustionWriteProof.${key} was not nullable non-negative number`
      );
    }
  }
  if (typeof value.writeFailed !== 'boolean') {
    throw new Error(
      `${path} probe.quotaExhaustionWriteProof.writeFailed was not boolean`
    );
  }
}

function assertBrowserPreviewStorageShutdownProofShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.storageShutdownProof was not a JSON object`);
  }
  for (const key of [
    'error',
    'errorCode',
    'lifecyclePhase',
    'postCloseErrorCode',
    'status',
  ] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.storageShutdownProof.${key} was not nullable text`
      );
    }
  }
  for (const key of ['closed', 'mutationRejected'] as const) {
    if (typeof value[key] !== 'boolean') {
      throw new Error(
        `${path} probe.storageShutdownProof.${key} was not boolean`
      );
    }
  }
  if (
    !isNonNegativeFiniteNumber(value.count) ||
    !Number.isInteger(value.count)
  ) {
    throw new Error(
      `${path} probe.storageShutdownProof.count was not a non-negative integer`
    );
  }
  if (
    value.durationMs !== null &&
    !isNonNegativeFiniteNumber(value.durationMs)
  ) {
    throw new Error(
      `${path} probe.storageShutdownProof.durationMs was not nullable non-negative number`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

type CdpResponse = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type CdpEventWaiter = {
  method: string;
  predicate(params: unknown): boolean;
  reject(reason: unknown): void;
  resolve(params: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
};

class CdpSession {
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void }
  >();
  #errors: string[] = [];
  #chromeLifecycleSuspensionCount = 0;
  #eventWaiters = new Set<CdpEventWaiter>();
  #requests = new Map<string, { type?: string; url: string }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      void this.#handleMessage(event).catch((error) => {
        this.#rejectPending(
          new Error(
            `Chrome DevTools message decode failed: ${describeError(error)}`
          )
        );
      });
    });
    socket.addEventListener('close', () => {
      const error = new Error('Chrome DevTools WebSocket closed');
      this.#rejectPending(error);
      this.#rejectEventWaiters(error);
    });
    socket.addEventListener('error', () => {
      const error = new Error('Chrome DevTools WebSocket errored');
      this.#rejectPending(error);
      this.#rejectEventWaiters(error);
    });
  }

  static connect(url: string): Promise<CdpSession> {
    const normalizedUrl = normalizeChromeWebSocketUrl(url);
    return new Promise((resolveConnect, reject) => {
      let settled = false;
      let socket: WebSocket | null = null;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          socket?.close();
        } catch {
          // The connection is already failed; close errors are not useful here.
        }
        reject(error);
      };
      const timeout = setTimeout(
        () =>
          fail(
            new Error(
              `Timed out after ${CDP_CONNECT_TIMEOUT_MS}ms connecting to Chrome DevTools at ${normalizedUrl}`
            )
          ),
        CDP_CONNECT_TIMEOUT_MS
      );
      socket = new WebSocket(normalizedUrl);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolveConnect(new CdpSession(socket));
      });
      socket.addEventListener('error', () =>
        fail(
          new Error(
            `Chrome DevTools WebSocket failed to connect at ${normalizedUrl}`
          )
        )
      );
      socket.addEventListener('close', () =>
        fail(
          new Error(
            `Chrome DevTools WebSocket closed before connect at ${normalizedUrl}`
          )
        )
      );
    });
  }

  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS
  ): Promise<unknown> {
    const id = this.#nextId++;
    const payload =
      params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolveSend, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for Chrome DevTools command ${method}`
          )
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolveSend(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  waitForEvent(
    method: string,
    timeoutMs: number,
    predicate: (params: unknown) => boolean = () => true
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const waiter: CdpEventWaiter = {
        method,
        predicate,
        reject,
        resolve,
        timeout: setTimeout(() => {
          this.#eventWaiters.delete(waiter);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for Chrome DevTools event ${method}`
            )
          );
        }, timeoutMs),
      };
      this.#eventWaiters.add(waiter);
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (this.#errors.length > 0) {
      throw new Error(`Browser runtime error: ${this.#errors.join('\n')}`);
    }
    const response = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: T };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
      };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          'Browser evaluation failed'
      );
    }
    return response.result?.value as T;
  }

  chromeLifecycleSuspensionCount(): number {
    return this.#chromeLifecycleSuspensionCount;
  }

  close(): void {
    this.socket.close();
    this.#rejectEventWaiters(new Error('Chrome DevTools WebSocket closed'));
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #rejectEventWaiters(error: Error): void {
    for (const waiter of this.#eventWaiters) {
      this.#eventWaiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  async #handleMessage(event: MessageEvent): Promise<void> {
    const data = await decodeWebSocketMessageData(event.data);
    const message = JSON.parse(data) as CdpResponse;
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? 'CDP request failed')
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.#resolveEventWaiters(message);

    if (message.method === 'Runtime.consoleAPICalled') {
      const params = message.params as
        | {
            args?: Array<{
              description?: string;
              type?: string;
              value?: unknown;
            }>;
            type?: string;
          }
        | undefined;
      const text = (params?.args ?? [])
        .map((arg) => {
          if (typeof arg.value === 'string') return arg.value;
          if (arg.value !== undefined) return JSON.stringify(arg.value);
          return arg.description ?? arg.type ?? '';
        })
        .filter(Boolean)
        .join(' ');
      if (text.includes('[syncular-starter]')) {
        log(`browser console ${params?.type ?? 'log'}: ${text}`);
      }
      return;
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const params = message.params as
        | {
            exceptionDetails?: {
              text?: string;
              url?: string;
              lineNumber?: number;
              columnNumber?: number;
              exception?: { description?: string };
              stackTrace?: {
                callFrames?: {
                  url?: string;
                  lineNumber?: number;
                  columnNumber?: number;
                }[];
              };
            };
          }
        | undefined;
      const details = params?.exceptionDetails;
      this.#recordBrowserDiagnostic(
        formatBrowserDiagnostic(
          details?.exception?.description ??
            details?.text ??
            'Browser runtime exception',
          details?.url ??
            details?.stackTrace?.callFrames?.find((frame) => frame.url)?.url,
          details?.lineNumber,
          details?.columnNumber
        )
      );
    }
    if (message.method === 'Log.entryAdded') {
      const params = message.params as
        | {
            entry?: {
              level?: string;
              lineNumber?: number;
              networkRequestId?: string;
              text?: string;
              url?: string;
            };
          }
        | undefined;
      if (params?.entry?.level === 'error') {
        const request =
          params.entry.networkRequestId === undefined
            ? undefined
            : this.#requests.get(params.entry.networkRequestId);
        this.#recordBrowserDiagnostic(
          formatBrowserDiagnostic(
            params.entry.text ?? 'Browser log error',
            params.entry.url ?? request?.url,
            params.entry.lineNumber
          )
        );
      }
    }
    if (message.method === 'Network.requestWillBeSent') {
      const params = message.params as
        | {
            requestId?: string;
            request?: { url?: string };
            type?: string;
          }
        | undefined;
      if (params?.requestId && params.request?.url) {
        this.#requests.set(params.requestId, {
          type: params.type,
          url: params.request.url,
        });
      }
    }
    if (message.method === 'Network.responseReceived') {
      const params = message.params as
        | {
            requestId?: string;
            response?: {
              mimeType?: string;
              status?: number;
              url?: string;
            };
            type?: string;
          }
        | undefined;
      const response = params?.response;
      const url =
        response?.url ??
        (params?.requestId ? this.#requests.get(params.requestId)?.url : null);
      if (
        url &&
        response?.mimeType?.includes('text/html') &&
        isModuleLikeAssetUrl(url)
      ) {
        this.#recordBrowserDiagnostic(
          `Browser loaded ${params?.type ?? 'asset'} ${url} as ${
            response.mimeType
          }${response.status === undefined ? '' : ` (${response.status})`}`
        );
      }
    }
    if (message.method === 'Network.loadingFailed') {
      const params = message.params as
        | {
            canceled?: boolean;
            errorText?: string;
            requestId?: string;
            type?: string;
          }
        | undefined;
      if (
        params?.canceled === true ||
        params?.errorText === 'net::ERR_ABORTED'
      ) {
        return;
      }
      const request = params?.requestId
        ? this.#requests.get(params.requestId)
        : undefined;
      if (request) {
        this.#recordBrowserDiagnostic(
          `Browser request failed: ${params?.type ?? request.type ?? 'asset'} ${
            request.url
          }${params?.errorText ? ` (${params.errorText})` : ''}`
        );
      }
    }
  }

  #resolveEventWaiters(message: CdpResponse): void {
    if (message.method === undefined) return;
    for (const waiter of [...this.#eventWaiters]) {
      if (waiter.method !== message.method) continue;
      if (!waiter.predicate(message.params)) continue;
      this.#eventWaiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(message.params);
    }
  }

  #recordBrowserDiagnostic(message: string): void {
    if (message.includes(CHROME_BFCACHE_LIFECYCLE_SUSPENSION_TEXT)) {
      this.#chromeLifecycleSuspensionCount += 1;
      return;
    }
    this.#errors.push(message);
  }
}

async function decodeWebSocketMessageData(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      'utf8'
    );
  }
  const maybeBlob = data as { text?: unknown; arrayBuffer?: unknown };
  if (typeof maybeBlob?.text === 'function') {
    return await (maybeBlob.text as () => Promise<string>).call(maybeBlob);
  }
  if (typeof maybeBlob?.arrayBuffer === 'function') {
    const buffer = await (
      maybeBlob.arrayBuffer as () => Promise<ArrayBuffer>
    ).call(maybeBlob);
    return Buffer.from(buffer).toString('utf8');
  }
  throw new Error(
    `Unsupported Chrome DevTools WebSocket frame type: ${typeof data}`
  );
}

function formatBrowserDiagnostic(
  message: string,
  url?: string | null,
  lineNumber?: number,
  columnNumber?: number
): string {
  if (!url) return message;
  const location =
    lineNumber === undefined
      ? ''
      : `:${lineNumber + 1}${columnNumber === undefined ? '' : `:${columnNumber + 1}`}`;
  return `${message} (${url}${location})`;
}

function isModuleLikeAssetUrl(url: string): boolean {
  const pathname = new URL(url, 'http://syncular.local').pathname;
  return pathname.endsWith('.js') || pathname.endsWith('.wasm');
}

async function main(): Promise<void> {
  const smokeStartedAtMs = Date.now();
  const configuredWorkDir = process.env.SYNCULAR_CSA_SMOKE_WORK_DIR;
  const workDir = configuredWorkDir
    ? isAbsolute(configuredWorkDir)
      ? configuredWorkDir
      : resolve(repoRoot, configuredWorkDir)
    : join(tmpdir(), `csa-smoke-${Date.now()}`);
  const appDir = join(workDir, 'my-app');
  const syncPort = await getFreePort();
  const vitePort = await getFreePort();
  await mkdir(workDir, { recursive: true });

  let devProcess: ReturnType<typeof spawn> | null = null;
  try {
    log(`work dir: ${workDir}`);
    const appEnv = {
      ...process.env,
      SYNC_PORT: String(syncPort),
      SYNCULAR_STARTER_SMOKE_FAILPOINTS: '1',
      PORT: String(vitePort),
      VITE_SYNCULAR_SYNC_URL: `http://127.0.0.1:${syncPort}/sync`,
    };

    // 1. Build and run the actual CLI artifact.
    await run('bun', ['run', 'build:cli'], { cwd: packageDir });
    await run(process.execPath, [join(packageDir, 'dist/cli.js'), appDir], {
      cwd: workDir,
    });

    // 2. Verify the scaffold output.
    const scaffoldedPkg = JSON.parse(
      await readFile(join(appDir, 'package.json'), 'utf8')
    ) as { name?: string; dependencies?: Record<string, string> };
    if (scaffoldedPkg.name !== 'my-app') {
      throw new Error(`Unexpected package name: ${scaffoldedPkg.name}`);
    }
    const clientRange = scaffoldedPkg.dependencies?.['@syncular/client'];
    if (!clientRange || clientRange.startsWith('workspace:')) {
      throw new Error(
        `@syncular/client range was not rewritten: ${clientRange}`
      );
    }
    if (!existsSync(join(appDir, '.gitignore'))) {
      throw new Error('.gitignore was not restored from _gitignore');
    }
    if (existsSync(join(appDir, '_gitignore'))) {
      throw new Error('_gitignore placeholder was left behind');
    }
    if (!existsSync(join(appDir, 'src/generated/syncular.generated.ts'))) {
      throw new Error('generated client missing from scaffold');
    }
    log('scaffold output verified');

    // 3. Wire dependencies to the local workspace and boot the dev script.
    await linkDependencies(appDir);
    await widenViteFsAllow(appDir);

    devProcess = spawn('bun', ['scripts/dev.ts'], {
      cwd: appDir,
      stdio: 'inherit',
      env: appEnv,
    });

    const health = await fetchUntilReady(
      `http://127.0.0.1:${syncPort}/health`,
      60_000
    );
    const healthBody = (await health.json()) as { ok?: boolean };
    if (healthBody.ok !== true) {
      throw new Error(
        `Unexpected health response: ${JSON.stringify(healthBody)}`
      );
    }
    log('sync server health check passed');

    const page = await fetchUntilReady(`http://127.0.0.1:${vitePort}/`, 60_000);
    const pageBody = await page.text();
    if (!pageBody.includes('<div id="root">')) {
      throw new Error('Vite page did not include the app root element');
    }
    log('vite page check passed');

    // Exercise Vite's import analysis over the app entry (resolves react,
    // the generated client and the @syncular packages).
    const moduleResponse = await fetchUntilReady(
      `http://127.0.0.1:${vitePort}/src/main.tsx`,
      60_000
    );
    const moduleBody = await moduleResponse.text();
    if (!moduleBody.includes('createRoot')) {
      throw new Error('Vite did not serve the transformed app entry');
    }
    log('vite module transform check passed');

    const clientModuleResponse = await fetchUntilReady(
      `http://127.0.0.1:${vitePort}/src/client/syncular.ts`,
      60_000
    );
    const clientModuleBody = await clientModuleResponse.text();
    if (!clientModuleBody.includes('getSyncularBrowserDeploymentPreflight')) {
      throw new Error(
        'Vite did not serve the transformed preflight client module'
      );
    }
    log('vite preflight module transform check passed');

    await stopProcess(devProcess);
    devProcess = null;

    // 4. Build and serve the production preview, then verify the built page
    // and assets are reachable. If a browser is available, execute the built
    // app and wait for the preflight-gated local database to open.
    await runLinkedViteBuild(appDir, appEnv);
    await writeBuiltPreviewSmokeServiceWorker(appDir);
    devProcess = spawn('bun', ['scripts/dev.ts', '--preview'], {
      cwd: appDir,
      stdio: 'inherit',
      env: appEnv,
    });

    const previewOrigin = `http://127.0.0.1:${vitePort}`;
    const previewPage = await fetchUntilReady(`${previewOrigin}/`, 60_000);
    const previewBody = await previewPage.text();
    const previewReadyMs = elapsedSince(smokeStartedAtMs);
    const assetMetrics = await verifyBuiltPreviewAssets(
      previewOrigin,
      previewBody
    );
    await verifyBuiltPreviewRuntimeAssets(previewOrigin);
    const failureMetrics: BrowserPreviewFailureMetricsInput = {
      smokeStartedAtMs,
      previewReadyMs,
      ...assetMetrics,
    };
    log('built preview asset check passed');
    log('built preview runtime asset check passed');
    await verifyBrowserPreviewFailureArtifactSelfCheck(workDir, failureMetrics);

    await maybeRunBrowserPreviewSmoke({
      failureMetrics,
      origin: previewOrigin,
      syncOrigin: `http://127.0.0.1:${syncPort}`,
      workDir,
    });

    log('smoke test passed');
  } finally {
    await stopProcess(devProcess);
    if (keep || configuredWorkDir) {
      log(`keeping ${workDir}`);
    } else {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

await main();
