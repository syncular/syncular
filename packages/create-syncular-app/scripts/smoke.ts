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
 *    The browser path also proves restored-page and online lifecycle resume
 *    signals plus two-tab propagation. Browser failures write
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
      sawLifecycleResumeMarker ||= assetBody.includes(
        'data-syncular-lifecycle-resume-status'
      );
      sawStarterTimelineMarker ||=
        assetBody.includes('data-syncular-starter-bootstrap-ready-ms') &&
        assetBody.includes('data-syncular-starter-database-open-ms') &&
        assetBody.includes('data-syncular-starter-local-visibility-ms') &&
        assetBody.includes('data-syncular-starter-realtime-connected-ms');
      sawSupportBundleMarker ||= assetBody.includes(
        'data-syncular-support-bundle-status'
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
    cssAssetBytes,
    cssAssetCount,
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

type BuiltPreviewAssetMetrics = {
  assetCheckMs: number;
  assetCount: number;
  cssAssetBytes: number;
  cssAssetCount: number;
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
  await mkdir(args.userDataDir, { recursive: true });
  const debugPort = await getFreePort();
  const targetUrl = `${args.origin}/`;
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
    const target = await createChromeTarget(debugPort, targetUrl);
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    let secondSession: CdpSession | null = null;
    try {
      await session.send('Runtime.enable');
      await session.send('Page.enable');
      await session.send('Log.enable');
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
      const secondTarget = await createChromeTarget(
        debugPort,
        `${args.origin}/?syncularClientId=web-second`
      );
      secondSession = await CdpSession.connect(
        secondTarget.webSocketDebuggerUrl
      );
      await secondSession.send('Runtime.enable');
      await secondSession.send('Page.enable');
      await secondSession.send('Log.enable');
      await waitForStarterBrowserReady(
        secondSession,
        args.failureArtifactPath,
        args.failureMetrics
      );
      await proveStarterTwoTabPropagation({
        failureMetrics: args.failureMetrics,
        failureArtifactPath: args.failureArtifactPath,
        first: session,
        second: secondSession,
      });
    } finally {
      secondSession?.close();
      session.close();
    }
    log('real-browser built-preview preflight smoke passed');
  } finally {
    await stopProcess(chrome);
  }
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
  supportBundle: {
    status: string | null;
    redacted: string | null;
    sectionCount: number;
    issueCount: number;
    requestIdCount: number;
    sectionErrorCount: number;
  };
  lifecycleResume: {
    status: string | null;
    count: number;
    reason: string | null;
    error: string | null;
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
  cssAssetBytes: number;
  cssAssetCount: number;
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
    const supportBundleRequestIdCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-request-id-count') ?? 0);
    const supportBundleSectionErrorCount = Number(supportBundle?.getAttribute('data-syncular-support-bundle-section-error-count') ?? 0);
    const lifecycleResume = document.querySelector('[data-syncular-lifecycle-resume-status]');
    const lifecycleResumeStatus = lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-status') ?? null;
    const lifecycleResumeCount = Number(lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-count') ?? 0);
    const lifecycleResumeReason = lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-reason') ?? null;
    const lifecycleResumeError = lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-error') ?? null;
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
      supportBundle: {
        status: supportBundleStatus,
        redacted: supportBundleRedacted,
        sectionCount: supportBundleSectionCount,
        issueCount: supportBundleIssueCount,
        requestIdCount: supportBundleRequestIdCount,
        sectionErrorCount: supportBundleSectionErrorCount,
      },
      lifecycleResume: {
        status: lifecycleResumeStatus,
        count: lifecycleResumeCount,
        reason: lifecycleResumeReason,
        error: lifecycleResumeError,
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
  const pageshowCount = initialProbe.lifecycleResume.count + 1;
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
}

async function waitForStarterLifecycleResume(args: {
  expectedCount: number;
  expectedReason: string;
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
        'lifecycle-resume-errors',
        probe,
        args.failureMetrics
      );
      throw new Error(
        `Built preview lifecycle resume failed: ${probe.errors.join(
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

async function proveStarterTwoTabPropagation(args: {
  failureMetrics: BrowserPreviewFailureMetricsInput;
  failureArtifactPath: string;
  first: CdpSession;
  second: CdpSession;
}): Promise<void> {
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
    if (propagated) return;
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
      supportBundle: {
        status: 'failed',
        redacted: 'true',
        sectionCount: 4,
        issueCount: 1,
        requestIdCount: 0,
        sectionErrorCount: 1,
      },
      lifecycleResume: {
        status: 'complete',
        count: 2,
        reason: 'online',
        error: null,
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
    cssAssetBytes: metrics.cssAssetBytes,
    cssAssetCount: metrics.cssAssetCount,
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
  assertBrowserPreviewSupportBundleShape(probe.supportBundle, path);
  assertBrowserPreviewLifecycleResumeShape(probe.lifecycleResume, path);
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

function assertBrowserPreviewSupportBundleShape(
  value: unknown,
  path: string
): void {
  if (!isRecord(value)) {
    throw new Error(`${path} probe.supportBundle was not a JSON object`);
  }
  for (const key of ['status', 'redacted'] as const) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(
        `${path} probe.supportBundle.${key} was not nullable text`
      );
    }
  }
  for (const key of [
    'sectionCount',
    'issueCount',
    'requestIdCount',
    'sectionErrorCount',
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
  for (const key of ['status', 'reason', 'error'] as const) {
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
              exception?: { description?: string };
            };
          }
        | undefined;
      this.#errors.push(
        params?.exceptionDetails?.exception?.description ??
          params?.exceptionDetails?.text ??
          'Browser runtime exception'
      );
    }
    if (message.method === 'Log.entryAdded') {
      const params = message.params as
        | { entry?: { level?: string; text?: string } }
        | undefined;
      if (params?.entry?.level === 'error') {
        this.#errors.push(params.entry.text ?? 'Browser log error');
      }
    }
  }
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
    const failureMetrics: BrowserPreviewFailureMetricsInput = {
      smokeStartedAtMs,
      previewReadyMs,
      ...assetMetrics,
    };
    log('built preview asset check passed');
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
