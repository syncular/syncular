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
 *    The browser path also proves pagehide/beforeunload pause evidence,
 *    restored-page and online lifecycle resume signals, two-tab
 *    lock-coordinated lifecycle resume, browser-observed lifecycle Web Lock
 *    contention timeout/recovery, two-tab propagation, same-client
 *    page reload/reopen persistence, and
 *    same-profile browser process restart persistence.
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
  let sawBrowserSupportPolicyMarker = false;
  let sawDeploymentPreflightMarker = false;
  let sawStarterTimelineMarker = false;
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
      sawSupportBundleMarker ||=
        assetBody.includes('data-syncular-support-bundle-status') &&
        assetBody.includes('data-syncular-support-bundle-timeline-event-count');
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

  return {
    assetCheckMs: elapsedSince(startedAtMs),
    assetCount: assetPaths.length,
    browserSupportPolicyMarkerInAssets: sawBrowserSupportPolicyMarker,
    cssAssetBytes,
    cssAssetCount,
    deploymentPreflightMarkerInAssets: sawDeploymentPreflightMarker,
    jsAssetBytes,
    jsAssetCount,
    lifecycleResumeMarkerInAssets: sawLifecycleResumeMarker,
    otherAssetBytes,
    otherAssetCount,
    starterTimelineMarkerInAssets: sawStarterTimelineMarker,
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
  browserSupportPolicyMarkerInAssets: boolean;
  cssAssetBytes: number;
  cssAssetCount: number;
  deploymentPreflightMarkerInAssets: boolean;
  jsAssetBytes: number;
  jsAssetCount: number;
  lifecycleResumeMarkerInAssets: boolean;
  otherAssetBytes: number;
  otherAssetCount: number;
  starterTimelineMarkerInAssets: boolean;
  supportBundleMarkerInAssets: boolean;
  totalAssetBytes: number;
};

async function maybeRunBrowserPreviewSmoke(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  origin: string;
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
  userDataDir: string;
}): Promise<void> {
  const targetUrl = `${args.origin}/`;
  const chrome = await startBrowserPreviewChrome({
    chrome: args.chrome,
    userDataDir: args.userDataDir,
  });
  let propagatedTitle: string | null = null;

  try {
    const target = await createChromeTarget(chrome.debugPort, targetUrl);
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    let secondSession: CdpSession | null = null;
    try {
      await session.send('Runtime.enable');
      await session.send('Page.enable');
      await session.send('Log.enable');
      await session.send('Network.enable');
      await waitForStarterBrowserReady(
        session,
        args.failureArtifactPath,
        args.failureMetrics
      );
      await proveStarterBrowserLifecycleResume(
        session,
        args.failureArtifactPath,
        args.failureMetrics
      );
      await proveStarterLifecycleLockContention({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        session,
      });
      const secondTarget = await createChromeTarget(
        chrome.debugPort,
        `${args.origin}/?syncularClientId=web-second`
      );
      secondSession = await CdpSession.connect(
        secondTarget.webSocketDebuggerUrl
      );
      await secondSession.send('Runtime.enable');
      await secondSession.send('Page.enable');
      await secondSession.send('Log.enable');
      await secondSession.send('Network.enable');
      await waitForStarterBrowserReady(
        secondSession,
        args.failureArtifactPath,
        args.failureMetrics
      );
      await proveStarterTwoTabLifecycleResumeCoordination({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        first: session,
        second: secondSession,
      });
      propagatedTitle = await proveStarterTwoTabPropagation({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        first: session,
        second: secondSession,
      });
      await proveStarterReloadPersistence({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        session: secondSession,
        title: propagatedTitle,
        url: `${args.origin}/?syncularClientId=web-second&syncularReloadProof=${Date.now()}`,
      });
    } finally {
      secondSession?.close();
      session.close();
    }
  } finally {
    await stopProcess(chrome.process);
  }

  if (propagatedTitle === null) {
    throw new Error('Built preview browser smoke did not produce a task title');
  }
  await proveStarterBrowserProcessRestart({
    chrome: args.chrome,
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    origin: args.origin,
    title: propagatedTitle,
    userDataDir: args.userDataDir,
  });
  log('real-browser built-preview preflight smoke passed');
}

async function startBrowserPreviewChrome(args: {
  chrome: string;
  userDataDir: string;
}): Promise<{ debugPort: number; process: ReturnType<typeof spawn> }> {
  await mkdir(args.userDataDir, { recursive: true });
  const debugPort = await getFreePort();
  const chrome = spawn(
    args.chrome,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${args.userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    await fetchUntilReady(`http://127.0.0.1:${debugPort}/json/version`, 15_000);
  } catch (error) {
    await stopProcess(chrome);
    throw error;
  }

  return { debugPort, process: chrome };
}

async function createChromeTarget(
  debugPort: number,
  url: string
): Promise<{ webSocketDebuggerUrl: string }> {
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
  const target = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!target.webSocketDebuggerUrl) {
    throw new Error('Chrome target did not return a WebSocket debugger URL');
  }
  return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
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
  starterTimeline: {
    bootstrapReadyMs: number | null;
    bootstrapStatus: string | null;
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
  browserSupportPolicyMarkerInAssets: boolean;
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
    const starterTimeline = document.querySelector('[data-syncular-starter-database-open-ms]');
    const readStarterTimelineMs = (name) => {
      const value = starterTimeline?.getAttribute(name) ?? null;
      if (value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const bootstrapReadyMs = readStarterTimelineMs('data-syncular-starter-bootstrap-ready-ms');
    const bootstrapStatus = starterTimeline?.getAttribute('data-syncular-starter-bootstrap-status') ?? null;
    const databaseOpenMs = readStarterTimelineMs('data-syncular-starter-database-open-ms');
    const healthRefreshMs = readStarterTimelineMs('data-syncular-starter-health-refresh-ms');
    const localVisibilityErrorCode = starterTimeline?.getAttribute('data-syncular-starter-local-visibility-error-code') ?? null;
    const localVisibilityMs = readStarterTimelineMs('data-syncular-starter-local-visibility-ms');
    const localVisibilityStatus = starterTimeline?.getAttribute('data-syncular-starter-local-visibility-status') ?? null;
    const realtimeConnectedMs = readStarterTimelineMs('data-syncular-starter-realtime-connected-ms');
    const realtimeStatus = starterTimeline?.getAttribute('data-syncular-starter-realtime-status') ?? null;
    const schemaReadinessMs = readStarterTimelineMs('data-syncular-starter-schema-readiness-ms');
    const supportBundleExportMs = readStarterTimelineMs('data-syncular-starter-support-bundle-export-ms');
    const durableHealthLine = text.includes('indexedDb durable');
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
    return {
      ready:
        durableHealthLine &&
        schemaLine &&
        supportBundleStatus !== null &&
        browserSupportPolicyStatus !== null &&
        deploymentPreflightStatus !== null &&
        lifecycleResumeStatus !== null &&
        starterTimeline !== null &&
        bootstrapStatus !== null &&
        databaseOpenMs !== null &&
        healthRefreshMs !== null &&
        localVisibilityStatus !== null &&
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
      starterTimeline: {
        bootstrapReadyMs,
        bootstrapStatus,
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
    const evaluation = await readStarterBrowserProbe(session);
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

  await session.evaluate(`(() => {
    window.dispatchEvent(new Event('beforeunload'));
    return true;
  })()`);
  await waitForStarterLifecyclePause({
    expectedCount: pagehideCount + 1,
    expectedReason: 'beforeunload',
    expectedShutdownSignalCount: 1,
    failureArtifactPath,
    failureMetrics,
    session,
    timeoutReason: 'lifecycle-beforeunload-timeout',
  });
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
  await args.first.evaluate(`(() => {
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

  await waitForStarterLocalVisibility({
    failureArtifactPath: args.failureArtifactPath,
    failureMetrics: args.failureMetrics,
    session: args.first,
  });

  const deadline = Date.now() + 20_000;
  let lastProbe: BrowserPreviewProbe | null = null;
  while (Date.now() < deadline) {
    const probe = await readStarterBrowserProbe(args.second);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeBrowserPreviewFailureArtifact(
        args.failureArtifactPath,
        'two-tab-propagation-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview two-tab propagation failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifactPath}`
      );
    }
    const propagated = await args.second.evaluate<boolean>(
      `document.body?.innerText.includes(${JSON.stringify(title)}) ?? false`
    );
    if (propagated) return title;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  await writeBrowserPreviewFailureArtifact(
    args.failureArtifactPath,
    'two-tab-propagation-timeout',
    lastProbe,
    args.failureMetrics
  );
  throw new Error(
    `Timed out waiting for built preview two-tab propagation. Failure artifact: ${args.failureArtifactPath}`
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
    const target = await createChromeTarget(chrome.debugPort, url);
    session = await CdpSession.connect(target.webSocketDebuggerUrl);
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Log.enable');
    await session.send('Network.enable');
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
      starterTimeline: {
        bootstrapReadyMs: 10,
        bootstrapStatus: 'ready',
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
    browserSupportPolicyMarkerInAssets:
      metrics.browserSupportPolicyMarkerInAssets,
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
    'browserSupportPolicyMarkerInAssets',
    'deploymentPreflightMarkerInAssets',
    'lifecycleResumeMarkerInAssets',
    'starterTimelineMarkerInAssets',
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
  assertBrowserPreviewDeploymentPreflightShape(probe.deploymentPreflight, path);
  assertBrowserPreviewSupportPolicyShape(probe.browserSupportPolicy, path);
  assertBrowserPreviewSupportBundleShape(probe.supportBundle, path);
  assertBrowserPreviewLifecycleResumeShape(probe.lifecycleResume, path);
  assertBrowserPreviewLifecyclePauseShape(probe.lifecyclePause, path);
  assertBrowserPreviewStarterTimelineShape(probe.starterTimeline, path);
  if (
    typeof probe.textExcerpt !== 'string' ||
    probe.textExcerpt.length > 4000
  ) {
    throw new Error(`${path} probe.textExcerpt was not a bounded string`);
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

class CdpSession {
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void }
  >();
  #errors: string[] = [];
  #requests = new Map<string, { type?: string; url: string }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.#handleMessage(event));
  }

  static connect(url: string): Promise<CdpSession> {
    return new Promise((resolveConnect, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () =>
        resolveConnect(new CdpSession(socket))
      );
      socket.addEventListener('error', () =>
        reject(new Error('Chrome DevTools WebSocket failed to connect'))
      );
    });
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const payload =
      params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolveSend, reject) => {
      this.#pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify(payload));
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

  close(): void {
    this.socket.close();
  }

  #handleMessage(event: MessageEvent): void {
    const data =
      typeof event.data === 'string'
        ? event.data
        : Buffer.from(event.data as ArrayBuffer).toString('utf8');
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
      this.#errors.push(
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
        this.#errors.push(
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
        this.#errors.push(
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
        this.#errors.push(
          `Browser request failed: ${params?.type ?? request.type ?? 'asset'} ${
            request.url
          }${params?.errorText ? ` (${params.errorText})` : ''}`
        );
      }
    }
  }
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
