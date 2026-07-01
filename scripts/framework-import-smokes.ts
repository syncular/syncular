#!/usr/bin/env bun
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  decodeBinarySnapshotTable,
  SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
} from '../packages/core/src/snapshot-chunks';
import {
  decodeBinarySyncPack,
  isBinarySyncPackContentType,
} from '../packages/core/src/sync-packs';

const repoRoot = resolve(join(import.meta.dirname, '..'));
const workDir = resolve(
  process.env.SYNCULAR_FRAMEWORK_IMPORT_SMOKE_DIR ??
    `.context/framework-import-smokes/run-${process.pid}`
);
const keep = process.argv.includes('--keep');
const requireViteBrowserRuntimeSmoke =
  process.env.SYNCULAR_FRAMEWORK_VITE_BROWSER_SMOKE === 'required' ||
  process.argv.includes('--require-vite-browser-runtime');

async function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> }
): Promise<void> {
  console.log(`[framework-import-smokes] $ ${[command, ...args].join(' ')}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      env: { ...process.env, ...options.env },
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

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  if (typeof address === 'object' && address != null) {
    return (address as AddressInfo).port;
  }
  throw new Error('Could not allocate a free localhost port');
}

async function runLocalWorkerRuntimeProbe(args: {
  blobRouteBase?: string;
  appDir: string;
  wranglerBin: string;
  route: string;
  expectedText: string;
  syncRouteBase?: string;
  webSocketExpectedText?: string;
  webSocketMessage?: string;
  webSocketRoute?: string;
}): Promise<void> {
  const port = await getFreePort();
  const failureArtifactPath = join(
    args.appDir,
    'cloudflare-runtime-failure.json'
  );
  const blobMetrics = args.blobRouteBase
    ? createCloudflareBlobRouteMetrics()
    : undefined;
  const output: string[] = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  const child = spawn(
    'node',
    [
      args.wranglerBin,
      'dev',
      '--config',
      'wrangler.jsonc',
      '--local',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--show-interactive-dev-session',
      'false',
      '--log-level',
      'error',
    ],
    {
      cwd: args.appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
      },
    }
  );
  child.stdout?.on('data', (chunk) =>
    appendProcessOutput(output, 'stdout', chunk)
  );
  child.stderr?.on('data', (chunk) =>
    appendProcessOutput(output, 'stderr', chunk)
  );
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  try {
    await waitForHttpText({
      label: 'Cloudflare Durable Object runtime smoke',
      url: `http://127.0.0.1:${port}${args.route}`,
      expectedText: args.expectedText,
      output,
      getExit: () => exited,
    });
    if (args.blobRouteBase) {
      if (!args.syncRouteBase) {
        throw new Error('Cloudflare blob route smoke requires syncRouteBase');
      }
      await runBlobRouteFlow({
        origin: `http://127.0.0.1:${port}`,
        routeBase: args.blobRouteBase,
        syncRouteBase: args.syncRouteBase,
        metrics: blobMetrics,
        output,
        getExit: () => exited,
      });
    }
    if (args.syncRouteBase) {
      await runSyncRouteFlow({
        origin: `http://127.0.0.1:${port}`,
        routeBase: args.syncRouteBase,
        output,
        getExit: () => exited,
      });
    }
    if (args.webSocketRoute && args.webSocketMessage) {
      await waitForWebSocketText({
        label: 'Cloudflare Durable Object WebSocket smoke',
        url: `ws://127.0.0.1:${port}${args.webSocketRoute}`,
        sendText: args.webSocketMessage,
        expectedText: args.webSocketExpectedText ?? args.webSocketMessage,
        output,
        getExit: () => exited,
      });
    }
    await verifyCloudflareRuntimeFailureArtifactSelfCheck(args.appDir, {
      blobRouteBase: args.blobRouteBase,
      blobMetrics,
      expectedText: args.expectedText,
      output,
      port,
      route: args.route,
      syncRouteBase: args.syncRouteBase,
      webSocketRoute: args.webSocketRoute,
      exited,
    });
  } catch (error) {
    await writeCloudflareRuntimeFailureArtifact(failureArtifactPath, error, {
      blobRouteBase: args.blobRouteBase,
      blobMetrics,
      expectedText: args.expectedText,
      output,
      port,
      route: args.route,
      syncRouteBase: args.syncRouteBase,
      webSocketRoute: args.webSocketRoute,
      exited,
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nFailure artifact: ${failureArtifactPath}`);
  } finally {
    await stopProcess(child);
  }
}

type CloudflareRuntimeFailureProbe = {
  blobMetrics: CloudflareBlobRouteMetrics | null;
  blobRouteBase: string | null;
  expectedText: string;
  exited: {
    code: number | null;
    signal: string | null;
  } | null;
  outputExcerpt: string;
  port: number;
  route: string;
  syncRouteBase: string | null;
  webSocketRoute: string | null;
};

type CloudflareBlobRouteMetrics = {
  attempted: boolean;
  completeUploadMs: number | null;
  contentBytes: number | null;
  downloadBytes: number | null;
  downloadBytesMs: number | null;
  downloadUrlMs: number | null;
  partitionedDownloadBytes: number | null;
  partitionedDownloadBytesMs: number | null;
  partitionedDownloadUrlMs: number | null;
  referencePushMs: number | null;
  totalMs: number | null;
  uploadBytesMs: number | null;
  uploadInitMs: number | null;
};

type CloudflareBlobRouteMetricMsKey =
  | 'completeUploadMs'
  | 'downloadBytesMs'
  | 'downloadUrlMs'
  | 'partitionedDownloadBytesMs'
  | 'partitionedDownloadUrlMs'
  | 'referencePushMs'
  | 'uploadBytesMs'
  | 'uploadInitMs';

type CloudflareRuntimeFailureArtifact = {
  generatedAt: string;
  reason: string;
  probe: CloudflareRuntimeFailureProbe;
};

type CloudflareRuntimeFailureProbeInput = {
  blobMetrics?: CloudflareBlobRouteMetrics;
  blobRouteBase?: string;
  expectedText: string;
  exited: { code: number | null; signal: NodeJS.Signals | null } | null;
  output: string[];
  port: number;
  route: string;
  syncRouteBase?: string;
  webSocketRoute?: string;
};

async function writeCloudflareRuntimeFailureArtifact(
  path: string,
  reason: unknown,
  input: CloudflareRuntimeFailureProbeInput
): Promise<void> {
  const artifact: CloudflareRuntimeFailureArtifact = {
    generatedAt: new Date().toISOString(),
    reason: errorMessage(reason),
    probe: cloudflareRuntimeFailureProbe(input),
  };
  assertCloudflareRuntimeFailureArtifactShape(artifact, path);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

async function verifyCloudflareRuntimeFailureArtifactSelfCheck(
  appDir: string,
  input: CloudflareRuntimeFailureProbeInput
): Promise<void> {
  const path = join(appDir, 'cloudflare-runtime-failure.self-check.json');
  await writeCloudflareRuntimeFailureArtifact(
    path,
    'cloudflare-runtime-artifact-self-check',
    input
  );
  const artifact = JSON.parse(await Bun.file(path).text()) as unknown;
  assertCloudflareRuntimeFailureArtifactShape(artifact, path);
  await rm(path, { force: true });
  console.log(
    '[framework-import-smokes] Cloudflare runtime failure artifact shape check passed'
  );
}

function cloudflareRuntimeFailureProbe(
  input: CloudflareRuntimeFailureProbeInput
): CloudflareRuntimeFailureProbe {
  return {
    blobMetrics: input.blobMetrics ?? null,
    blobRouteBase: input.blobRouteBase ?? null,
    expectedText: input.expectedText,
    exited: input.exited
      ? {
          code: input.exited.code,
          signal: input.exited.signal ?? null,
        }
      : null,
    outputExcerpt: boundedOutput(input.output),
    port: input.port,
    route: input.route,
    syncRouteBase: input.syncRouteBase ?? null,
    webSocketRoute: input.webSocketRoute ?? null,
  };
}

function assertCloudflareRuntimeFailureArtifactShape(
  artifact: unknown,
  path: string
): asserts artifact is CloudflareRuntimeFailureArtifact {
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
  assertCloudflareRuntimeFailureProbeShape(artifact.probe, path);
}

function assertCloudflareRuntimeFailureProbeShape(
  probe: unknown,
  path: string
): asserts probe is CloudflareRuntimeFailureProbe {
  if (!isRecord(probe)) {
    throw new Error(`${path} probe was not a JSON object`);
  }
  assertCloudflareBlobRouteMetricsShape(probe.blobMetrics, path);
  for (const key of [
    'blobRouteBase',
    'syncRouteBase',
    'webSocketRoute',
  ] as const) {
    if (probe[key] !== null && typeof probe[key] !== 'string') {
      throw new Error(`${path} probe.${key} was not nullable text`);
    }
  }
  for (const key of ['expectedText', 'outputExcerpt', 'route'] as const) {
    if (typeof probe[key] !== 'string') {
      throw new Error(`${path} probe.${key} was not text`);
    }
  }
  if (!Number.isInteger(probe.port) || probe.port <= 0) {
    throw new Error(`${path} probe.port was not a positive integer`);
  }
  if (probe.exited !== null) {
    if (!isRecord(probe.exited)) {
      throw new Error(`${path} probe.exited was not a JSON object`);
    }
    if (probe.exited.code !== null && typeof probe.exited.code !== 'number') {
      throw new Error(`${path} probe.exited.code was not nullable number`);
    }
    if (
      probe.exited.signal !== null &&
      typeof probe.exited.signal !== 'string'
    ) {
      throw new Error(`${path} probe.exited.signal was not nullable text`);
    }
  }
}

function assertCloudflareBlobRouteMetricsShape(
  metrics: unknown,
  path: string
): void {
  if (metrics === null) return;
  if (!isRecord(metrics)) {
    throw new Error(`${path} probe.blobMetrics was not a nullable JSON object`);
  }
  if (typeof metrics.attempted !== 'boolean') {
    throw new Error(`${path} probe.blobMetrics.attempted was not a boolean`);
  }
  for (const key of [
    'completeUploadMs',
    'contentBytes',
    'downloadBytes',
    'downloadBytesMs',
    'downloadUrlMs',
    'partitionedDownloadBytes',
    'partitionedDownloadBytesMs',
    'partitionedDownloadUrlMs',
    'referencePushMs',
    'totalMs',
    'uploadBytesMs',
    'uploadInitMs',
  ] as const) {
    if (metrics[key] !== null && !isNonNegativeFiniteNumber(metrics[key])) {
      throw new Error(
        `${path} probe.blobMetrics.${key} was not nullable non-negative number`
      );
    }
  }
}

function createCloudflareBlobRouteMetrics(): CloudflareBlobRouteMetrics {
  return {
    attempted: false,
    completeUploadMs: null,
    contentBytes: null,
    downloadBytes: null,
    downloadBytesMs: null,
    downloadUrlMs: null,
    partitionedDownloadBytes: null,
    partitionedDownloadBytesMs: null,
    partitionedDownloadUrlMs: null,
    referencePushMs: null,
    totalMs: null,
    uploadBytesMs: null,
    uploadInitMs: null,
  };
}

async function measureCloudflareBlobMetric<T>(
  metrics: CloudflareBlobRouteMetrics | undefined,
  key: CloudflareBlobRouteMetricMsKey,
  runMetric: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await runMetric();
  } finally {
    if (metrics) metrics[key] = elapsedSince(startedAt);
  }
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function runVitePreviewRuntimeProbe(args: {
  appDir: string;
  viteBin: string;
  bundlePath: string;
  expectedText: string;
}): Promise<void> {
  const port = await getFreePort();
  const output: string[] = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  console.log(
    `[framework-import-smokes] $ node ${args.viteBin} preview --host 127.0.0.1 --port ${port} --strictPort`
  );
  const child = spawn(
    'node',
    [
      args.viteBin,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: args.appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }
  );
  child.stdout?.on('data', (chunk) =>
    appendProcessOutput(output, 'stdout', chunk)
  );
  child.stderr?.on('data', (chunk) =>
    appendProcessOutput(output, 'stderr', chunk)
  );
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHttpText({
      label: 'Vite preview root smoke',
      url: `${baseUrl}/`,
      expectedText: args.bundlePath,
      output,
      getExit: () => exited,
    });
    await waitForHttpText({
      label: 'Vite preview bundle smoke',
      url: `${baseUrl}${args.bundlePath}`,
      expectedText: args.expectedText,
      output,
      getExit: () => exited,
    });
    console.log('[framework-import-smokes] Vite preview serving smoke passed');
    await verifyViteBrowserRuntimeFailureArtifactSelfCheck(args.appDir);
    await maybeRunViteBrowserRuntimeSmoke({
      origin: baseUrl,
      workDir: args.appDir,
    });
  } finally {
    await stopProcess(child);
  }
}

async function maybeRunViteBrowserRuntimeSmoke(args: {
  origin: string;
  workDir: string;
}): Promise<void> {
  const chrome = resolveChromeExecutable();
  if (!chrome) {
    const message =
      'Chrome/Chromium was not found; skipped Vite browser runtime smoke.';
    if (requireViteBrowserRuntimeSmoke) throw new Error(message);
    console.log(`[framework-import-smokes] ${message}`);
    return;
  }

  await runViteBrowserRuntimeSmoke({
    chrome,
    origin: args.origin,
    failureArtifactPath: join(
      args.workDir,
      'vite-browser-runtime-failure.json'
    ),
    userDataDir: join(args.workDir, 'chrome-profile'),
  });
  console.log('[framework-import-smokes] Vite browser runtime smoke passed');
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

async function runViteBrowserRuntimeSmoke(args: {
  chrome: string;
  failureArtifactPath: string;
  origin: string;
  userDataDir: string;
}): Promise<void> {
  await mkdir(args.userDataDir, { recursive: true });
  const debugPort = await getFreePort();
  const output: string[] = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
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
      `${args.origin}/`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  chrome.stdout?.on('data', (chunk) =>
    appendProcessOutput(output, 'stdout', chunk)
  );
  chrome.stderr?.on('data', (chunk) =>
    appendProcessOutput(output, 'stderr', chunk)
  );
  chrome.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  try {
    await waitForChromeDevTools({
      debugPort,
      output,
      getExit: () => exited,
    });
    const target = await createChromeTarget(debugPort, `${args.origin}/`);
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    try {
      await session.send('Runtime.enable');
      await session.send('Page.enable');
      await session.send('Log.enable');
      await waitForViteBrowserRuntimeReady(session, args.failureArtifactPath);
    } finally {
      session.close();
    }
  } finally {
    await stopProcess(chrome);
  }
}

async function waitForChromeDevTools(args: {
  debugPort: number;
  output: string[];
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const url = `http://127.0.0.1:${args.debugPort}/json/version`;
  const deadline = Date.now() + 15_000;
  let lastError = 'no request attempted';
  while (Date.now() < deadline) {
    const exit = args.getExit();
    if (exit) {
      throw new Error(
        `Chrome exited before DevTools became ready: code=${
          exit.code ?? 'null'
        } signal=${exit.signal ?? 'null'}\n${args.output.join('')}`
      );
    }
    try {
      const text = await fetchTextWithTimeout(url, 1_000);
      if (text.includes('webSocketDebuggerUrl')) return;
      lastError = `unexpected DevTools response: ${text.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `Timed out waiting for Chrome DevTools at ${url}: ${lastError}\n${args.output.join(
      ''
    )}`
  );
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

type ViteBrowserRuntimeProbe = {
  appHtml: string | null;
  bodyText: string;
  href: string;
  marker: string | null;
  readyState: string;
};

type ViteBrowserRuntimeFailureArtifact = {
  generatedAt: string;
  reason: string;
  probe: ViteBrowserRuntimeProbe | null;
};

async function readViteBrowserRuntimeProbe(
  session: CdpSession
): Promise<ViteBrowserRuntimeProbe> {
  return session.evaluate<ViteBrowserRuntimeProbe>(`(() => {
    const app = document.querySelector('#app');
    return {
      appHtml: app?.outerHTML?.slice(0, 500) ?? null,
      bodyText: document.body?.innerText ?? '',
      href: location.href,
      marker: app?.getAttribute('data-syncular-vite-root-import') ?? null,
      readyState: document.readyState,
    };
  })()`);
}

async function waitForViteBrowserRuntimeReady(
  session: CdpSession,
  failureArtifactPath: string
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastProbe: ViteBrowserRuntimeProbe | null = null;
  let lastError = 'no evaluation attempted';
  while (Date.now() < deadline) {
    try {
      lastProbe = await readViteBrowserRuntimeProbe(session);
      if (lastProbe.marker === 'ready') return;
      lastError = `marker=${lastProbe.marker ?? 'null'} readyState=${
        lastProbe.readyState
      }`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  await writeViteBrowserRuntimeFailureArtifact(
    failureArtifactPath,
    'vite-browser-runtime-timeout',
    lastProbe
  );
  throw new Error(
    `Timed out waiting for Vite browser root import marker: ${lastError}. Failure artifact: ${failureArtifactPath}`
  );
}

async function writeViteBrowserRuntimeFailureArtifact(
  path: string,
  reason: string,
  probe: ViteBrowserRuntimeProbe | null
): Promise<void> {
  const artifact: ViteBrowserRuntimeFailureArtifact = {
    generatedAt: new Date().toISOString(),
    reason,
    probe,
  };
  assertViteBrowserRuntimeFailureArtifactShape(artifact, path);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

async function verifyViteBrowserRuntimeFailureArtifactSelfCheck(
  appDir: string
): Promise<void> {
  const path = join(appDir, 'vite-browser-runtime-failure.self-check.json');
  await writeViteBrowserRuntimeFailureArtifact(
    path,
    'vite-browser-runtime-artifact-self-check',
    {
      appHtml:
        '<div id="app" data-syncular-vite-root-import="ready">ready</div>',
      bodyText: 'Syncular Vite root import ready',
      href: 'http://127.0.0.1:5173/',
      marker: 'ready',
      readyState: 'complete',
    }
  );
  const artifact = JSON.parse(await Bun.file(path).text()) as unknown;
  assertViteBrowserRuntimeFailureArtifactShape(artifact, path);
  await rm(path, { force: true });
  console.log(
    '[framework-import-smokes] Vite browser runtime failure artifact shape check passed'
  );
}

function assertViteBrowserRuntimeFailureArtifactShape(
  artifact: unknown,
  path: string
): asserts artifact is ViteBrowserRuntimeFailureArtifact {
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
  if (artifact.probe !== null) {
    assertViteBrowserRuntimeProbeShape(artifact.probe, path);
  }
}

function assertViteBrowserRuntimeProbeShape(
  probe: unknown,
  path: string
): asserts probe is ViteBrowserRuntimeProbe {
  if (!isRecord(probe)) {
    throw new Error(`${path} probe was not a JSON object`);
  }
  for (const key of ['appHtml', 'marker'] as const) {
    if (probe[key] !== null && typeof probe[key] !== 'string') {
      throw new Error(`${path} probe.${key} was not nullable text`);
    }
  }
  for (const key of ['bodyText', 'href', 'readyState'] as const) {
    if (typeof probe[key] !== 'string') {
      throw new Error(`${path} probe.${key} was not text`);
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

function appendProcessOutput(
  output: string[],
  stream: 'stdout' | 'stderr',
  chunk: unknown
) {
  output.push(`[${stream}] ${String(chunk)}`);
  while (output.join('').length > 12_000) {
    output.shift();
  }
}

function boundedOutput(output: string[]): string {
  return truncateString(output.join(''), 12_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

async function waitForHttpText(args: {
  label: string;
  url: string;
  expectedText: string;
  output: string[];
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<string> {
  const deadline = Date.now() + 30_000;
  let lastError = 'no request attempted';
  while (Date.now() < deadline) {
    const exit = args.getExit();
    if (exit) {
      throw new Error(
        `${args.label} exited before serving ${args.url}: code=${
          exit.code ?? 'null'
        } signal=${exit.signal ?? 'null'}\n${args.output.join('')}`
      );
    }
    try {
      const text = await fetchTextWithTimeout(args.url, 1_000);
      if (text.includes(args.expectedText)) return text;
      lastError = `unexpected response body: ${text.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${args.label} at ${args.url}: ${lastError}\n${args.output.join(
      ''
    )}`
  );
}

async function waitForWebSocketText(args: {
  label: string;
  url: string;
  sendText: string;
  expectedText: string;
  output: string[];
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  let socket: WebSocket | null = null;
  let settled = false;
  let lastError = 'no WebSocket event observed';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let exitPoll: ReturnType<typeof setInterval> | undefined;

  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (exitPoll) clearInterval(exitPoll);
      if (
        socket &&
        (socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.OPEN)
      ) {
        try {
          socket.close();
        } catch {
          // ignore close errors during cleanup
        }
      }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const pass = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise();
    };

    timeout = setTimeout(() => {
      fail(
        new Error(
          `Timed out waiting for ${args.label} at ${args.url}: ${lastError}\n${args.output.join(
            ''
          )}`
        )
      );
    }, 30_000);
    exitPoll = setInterval(() => {
      const exit = args.getExit();
      if (!exit) return;
      fail(
        new Error(
          `${args.label} exited before serving ${args.url}: code=${
            exit.code ?? 'null'
          } signal=${exit.signal ?? 'null'}\n${args.output.join('')}`
        )
      );
    }, 250);

    try {
      socket = new WebSocket(args.url);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    socket.addEventListener('open', () => {
      lastError = 'WebSocket opened without expected message';
      socket?.send(args.sendText);
    });
    socket.addEventListener('message', (event) => {
      const text = webSocketDataToText(event.data);
      if (text.includes(args.expectedText)) {
        pass();
        return;
      }
      lastError = `unexpected WebSocket message: ${text.slice(0, 200)}`;
    });
    socket.addEventListener('error', () => {
      lastError = 'WebSocket error event';
    });
    socket.addEventListener('close', (event) => {
      fail(
        new Error(
          `${args.label} closed before expected message: code=${event.code} reason=${
            event.reason || 'null'
          }; ${lastError}\n${args.output.join('')}`
        )
      );
    });
  });
}

function webSocketDataToText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
  }
  return String(data);
}

function isBinaryWebSocketData(data: unknown): boolean {
  return typeof data !== 'string';
}

function webSocketDataToBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error(`Unsupported binary WebSocket data: ${typeof data}`);
}

function closeWebSocket(socket: WebSocket | null): void {
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN)
  ) {
    try {
      socket.close();
    } catch {
      // ignore close errors during cleanup
    }
  }
}

async function runSyncRouteFlow(args: {
  origin: string;
  routeBase: string;
  output: string[];
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const label = 'Cloudflare D1 sync route smoke';
  const actorId = 'syncular-framework-actor';
  const readerClientId = 'syncular-framework-reader';
  const rowId = `syncular-framework-sync-task-${Date.now()}`;
  const title = 'D1 sync route ready';
  const syncUrl = `${args.origin}${args.routeBase}`;

  const pushResponse = await fetchWorkerResponse({
    label,
    url: syncUrl,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncular-smoke-actor': actorId,
      },
      body: JSON.stringify({
        clientId: 'syncular-framework-writer',
        push: {
          commits: [
            {
              clientCommitId: `commit-${rowId}`,
              schemaVersion: 1,
              operations: [
                {
                  table: 'syncular_framework_tasks',
                  row_id: rowId,
                  op: 'upsert',
                  payload: {
                    id: rowId,
                    user_id: actorId,
                    title,
                    server_version: 0,
                  },
                },
              ],
            },
          ],
        },
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectOkResponse(label, 'push', pushResponse, args.output);
  const pushBody = (await readSyncRouteResponse(
    label,
    'push',
    pushResponse
  )) as {
    ok?: boolean;
    push?: {
      commits?: Array<{
        results?: Array<{ status?: string }>;
        status?: string;
      }>;
    };
  };
  const pushedCommit = pushBody.push?.commits?.[0];
  if (
    pushBody.ok !== true ||
    pushedCommit?.status !== 'applied' ||
    pushedCommit.results?.[0]?.status !== 'applied'
  ) {
    throw new Error(
      `${label} push did not apply: ${JSON.stringify(pushBody).slice(0, 500)}`
    );
  }

  const forbiddenRowId = `${rowId}-forbidden`;
  const forbiddenPushResponse = await fetchWorkerResponse({
    label,
    url: syncUrl,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncular-smoke-actor': actorId,
      },
      body: JSON.stringify({
        clientId: 'syncular-framework-forbidden-writer',
        push: {
          commits: [
            {
              clientCommitId: `commit-${forbiddenRowId}`,
              schemaVersion: 1,
              operations: [
                {
                  table: 'syncular_framework_tasks',
                  row_id: forbiddenRowId,
                  op: 'upsert',
                  payload: {
                    id: forbiddenRowId,
                    user_id: `${actorId}-other`,
                    title: 'D1 sync route forbidden write',
                    server_version: 0,
                  },
                },
              ],
            },
          ],
        },
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectOkResponse(
    label,
    'forbidden-scope push envelope',
    forbiddenPushResponse,
    args.output
  );
  const forbiddenPushBody = (await readSyncRouteResponse(
    label,
    'forbidden-scope push',
    forbiddenPushResponse
  )) as {
    ok?: boolean;
    push?: {
      commits?: Array<{
        results?: Array<{ code?: string; status?: string }>;
        status?: string;
      }>;
    };
  };
  const forbiddenCommit = forbiddenPushBody.push?.commits?.[0];
  if (
    forbiddenPushBody.ok !== true ||
    forbiddenCommit?.status !== 'rejected' ||
    forbiddenCommit.results?.[0]?.status !== 'error' ||
    forbiddenCommit.results?.[0]?.code !== 'sync.forbidden'
  ) {
    throw new Error(
      `${label} forbidden-scope push did not produce sync.forbidden: ${JSON.stringify(
        forbiddenPushBody
      ).slice(0, 500)}`
    );
  }
  const forbiddenReadResponse = await fetchWorkerResponse({
    label,
    url: syncUrl,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncular-smoke-actor': `${actorId}-other`,
      },
      body: JSON.stringify({
        clientId: 'syncular-framework-forbidden-reader',
        pull: {
          schemaVersion: 1,
          limitCommits: 1,
          limitSnapshotRows: 1,
          subscriptions: [
            {
              id: 'syncular-framework-forbidden-tasks',
              table: 'syncular_framework_tasks',
              scopes: { user_id: actorId },
              cursor: -1,
              crdtStateVectors: [],
            },
          ],
        },
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectOkResponse(
    label,
    'revoked-scope pull envelope',
    forbiddenReadResponse,
    args.output
  );
  const forbiddenReadBody = (await readSyncRouteResponse(
    label,
    'revoked-scope pull',
    forbiddenReadResponse
  )) as {
    ok?: boolean;
    pull?: {
      subscriptions?: Array<{
        scopes?: Record<string, unknown>;
        status?: string;
      }>;
    };
  };
  const forbiddenReadSubscription = forbiddenReadBody.pull?.subscriptions?.[0];
  if (
    forbiddenReadBody.ok !== true ||
    forbiddenReadSubscription?.status !== 'revoked' ||
    Object.keys(forbiddenReadSubscription.scopes ?? {}).length !== 0
  ) {
    throw new Error(
      `${label} revoked-scope pull did not produce an empty revoked subscription: ${JSON.stringify(
        forbiddenReadBody
      ).slice(0, 500)}`
    );
  }

  const unauthenticatedResponse = await fetchWorkerResponse({
    label,
    url: syncUrl,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientId: 'syncular-framework-unauthenticated',
        pull: {
          schemaVersion: 1,
          limitCommits: 1,
          limitSnapshotRows: 1,
          subscriptions: [],
        },
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectJsonErrorResponse(label, 'unauthenticated sync', {
    response: unauthenticatedResponse,
    output: args.output,
    status: 401,
    code: 'sync.auth_required',
    category: 'auth-required',
    recommendedAction: 'refreshAuth',
  });

  const pullResponse = await fetchWorkerResponse({
    label,
    url: syncUrl,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncular-smoke-actor': actorId,
      },
      body: JSON.stringify({
        clientId: readerClientId,
        pull: {
          schemaVersion: 1,
          limitCommits: 10,
          limitSnapshotRows: 10,
          subscriptions: [
            {
              id: 'syncular-framework-tasks',
              table: 'syncular_framework_tasks',
              scopes: { user_id: actorId },
              cursor: -1,
              crdtStateVectors: [],
            },
          ],
        },
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectOkResponse(label, 'pull', pullResponse, args.output);
  const pullBody = (await readSyncRouteResponse(
    label,
    'pull',
    pullResponse
  )) as {
    ok?: boolean;
    pull?: {
      subscriptions?: Array<{
        snapshots?: Array<{
          chunks?: Array<{
            encoding?: string;
            id?: string;
          }>;
          rows?: unknown[];
        }>;
        status?: string;
      }>;
    };
  };
  const subscription = pullBody.pull?.subscriptions?.[0];
  let snapshotRows = subscription?.snapshots?.flatMap(
    (snapshot) => snapshot.rows ?? []
  );
  const firstChunk = subscription?.snapshots?.[0]?.chunks?.[0];
  if (snapshotRows?.length === 0 && firstChunk?.id) {
    if (firstChunk.encoding !== SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1) {
      throw new Error(
        `${label} returned unexpected snapshot chunk encoding: ${String(
          firstChunk.encoding
        )}`
      );
    }
    const chunkResponse = await fetchWorkerResponse({
      label,
      url: `${syncUrl}/snapshot-chunks/${encodeURIComponent(firstChunk.id)}`,
      init: {
        headers: {
          'x-syncular-smoke-actor': actorId,
          'x-syncular-snapshot-scopes': JSON.stringify({ user_id: actorId }),
        },
      },
      output: args.output,
      getExit: args.getExit,
    });
    await expectOkResponse(label, 'snapshot chunk', chunkResponse, args.output);
    snapshotRows = decodeBinarySnapshotTable(
      gunzipSync(new Uint8Array(await chunkResponse.arrayBuffer()))
    ).rows;
    const missingScopeChunkResponse = await fetchWorkerResponse({
      label,
      url: `${syncUrl}/snapshot-chunks/${encodeURIComponent(firstChunk.id)}`,
      init: {
        headers: {
          'x-syncular-smoke-actor': actorId,
        },
      },
      output: args.output,
      getExit: args.getExit,
    });
    await expectJsonErrorResponse(label, 'missing-scope snapshot chunk', {
      response: missingScopeChunkResponse,
      output: args.output,
      status: 400,
      code: 'sync.invalid_request',
      category: 'invalid-request',
      recommendedAction: 'fixRequest',
    });
    const forbiddenChunkResponse = await fetchWorkerResponse({
      label,
      url: `${syncUrl}/snapshot-chunks/${encodeURIComponent(firstChunk.id)}`,
      init: {
        headers: {
          'x-syncular-smoke-actor': actorId,
          'x-syncular-snapshot-scopes': JSON.stringify({
            user_id: `${actorId}-other`,
          }),
        },
      },
      output: args.output,
      getExit: args.getExit,
    });
    await expectJsonErrorResponse(label, 'forbidden snapshot chunk', {
      response: forbiddenChunkResponse,
      output: args.output,
      status: 403,
      code: 'sync.forbidden',
      category: 'forbidden',
      recommendedAction: 'checkPermissions',
    });
  }
  const pulledRow = snapshotRows?.find(
    (row): row is Record<string, unknown> =>
      row !== null &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      row.id === rowId
  );
  if (
    pullBody.ok !== true ||
    subscription?.status !== 'active' ||
    pulledRow?.title !== title
  ) {
    throw new Error(
      `${label} pull did not observe pushed row: ${JSON.stringify(
        pullBody
      ).slice(0, 500)}`
    );
  }

  await runSyncularRealtimeRouteFlow({
    actorId,
    origin: args.origin,
    output: args.output,
    readerClientId,
    routeBase: args.routeBase,
    getExit: args.getExit,
  });
}

async function runSyncularRealtimeRouteFlow(args: {
  actorId: string;
  origin: string;
  output: string[];
  readerClientId: string;
  routeBase: string;
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const label = 'Cloudflare Syncular realtime route smoke';
  const writerClientId = 'syncular-framework-realtime-writer';
  const rowId = `syncular-framework-realtime-task-${Date.now()}`;
  const title = 'D1 realtime route ready';
  const requestId = `request-${rowId}`;
  const readerUrl = syncularRealtimeUrl({
    actorId: args.actorId,
    clientId: args.readerClientId,
    origin: args.origin,
    routeBase: args.routeBase,
  });
  const writerUrl = syncularRealtimeUrl({
    actorId: args.actorId,
    clientId: writerClientId,
    origin: args.origin,
    routeBase: args.routeBase,
  });

  let readerSocket: WebSocket | null = null;
  let writerSocket: WebSocket | null = null;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let exitPoll: ReturnType<typeof setInterval> | undefined;
  let readerHello = false;
  let writerHello = false;
  let writerPushSent = false;
  let writerResponseApplied = false;
  let readerPackApplied = false;
  let lastError = 'no realtime WebSocket event observed';

  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (exitPoll) clearInterval(exitPoll);
      closeWebSocket(readerSocket);
      closeWebSocket(writerSocket);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const pass = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const maybeSendWriterPush = () => {
      if (!readerHello || !writerHello || writerPushSent) return;
      writerPushSent = true;
      writerSocket?.send(
        JSON.stringify({
          type: 'push',
          requestId,
          clientCommitId: `commit-${rowId}`,
          schemaVersion: 1,
          operations: [
            {
              table: 'syncular_framework_tasks',
              row_id: rowId,
              op: 'upsert',
              payload: {
                id: rowId,
                user_id: args.actorId,
                title,
                server_version: 0,
              },
            },
          ],
        })
      );
      lastError = 'writer push sent; waiting for push-response and reader pack';
    };
    const maybePass = () => {
      if (writerResponseApplied && readerPackApplied) pass();
    };

    timeout = setTimeout(() => {
      fail(
        new Error(
          `Timed out waiting for ${label}: ${lastError}\n${args.output.join(
            ''
          )}`
        )
      );
    }, 30_000);
    exitPoll = setInterval(() => {
      const exit = args.getExit();
      if (!exit) return;
      fail(
        new Error(
          `${label} worker exited before realtime proof completed: code=${
            exit.code ?? 'null'
          } signal=${exit.signal ?? 'null'}\n${args.output.join('')}`
        )
      );
    }, 250);

    try {
      readerSocket = new WebSocket(readerUrl);
      writerSocket = new WebSocket(writerUrl);
      readerSocket.binaryType = 'arraybuffer';
      writerSocket.binaryType = 'arraybuffer';
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    readerSocket.addEventListener('open', () => {
      lastError = 'reader websocket opened without hello';
    });
    writerSocket.addEventListener('open', () => {
      lastError = 'writer websocket opened without hello';
    });
    readerSocket.addEventListener('message', (event) => {
      if (settled) return;
      if (isBinaryWebSocketData(event.data)) {
        let pack: ReturnType<typeof decodeBinarySyncPack>;
        try {
          pack = decodeBinarySyncPack(webSocketDataToBytes(event.data));
        } catch (error) {
          fail(
            new Error(
              `${label} reader received undecodable binary sync-pack: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          );
          return;
        }
        const pushedChange = pack.pull?.subscriptions
          ?.flatMap((subscription) => subscription.commits ?? [])
          .flatMap((commit) => commit.changes ?? [])
          .find(
            (change) =>
              change.table === 'syncular_framework_tasks' &&
              change.row_id === rowId &&
              change.op === 'upsert'
          );
        if (
          pushedChange?.row_json &&
          typeof pushedChange.row_json === 'object' &&
          !Array.isArray(pushedChange.row_json) &&
          pushedChange.row_json.title === title
        ) {
          readerPackApplied = true;
          lastError =
            'reader binary sync-pack applied; waiting for writer response';
          maybePass();
          return;
        }
        fail(
          new Error(
            `${label} reader binary sync-pack did not contain pushed row: ${JSON.stringify(
              pack
            ).slice(0, 500)}`
          )
        );
        return;
      }

      let message: { event?: string; data?: unknown };
      try {
        message = parseRealtimeMessage(label, 'reader', event.data);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (message.event === 'hello') {
        const data = message.data as Record<string, unknown>;
        if (
          data.actorId !== args.actorId ||
          data.clientId !== args.readerClientId ||
          data.syncPackEncoding !== 'binary-sync-pack-v1'
        ) {
          fail(
            new Error(
              `${label} reader hello had unexpected data: ${JSON.stringify(
                message
              ).slice(0, 500)}`
            )
          );
          return;
        }
        readerHello = true;
        lastError = 'reader hello received; waiting for writer hello';
        maybeSendWriterPush();
        return;
      }
      if (message.event === 'sync') {
        fail(
          new Error(
            `${label} reader received JSON sync wakeup instead of binary sync-pack: ${JSON.stringify(
              message
            ).slice(0, 500)}`
          )
        );
        return;
      }
      if (message.event === 'error') {
        fail(
          new Error(
            `${label} reader realtime error: ${JSON.stringify(message).slice(
              0,
              500
            )}`
          )
        );
      }
    });
    writerSocket.addEventListener('message', (event) => {
      if (settled) return;
      if (isBinaryWebSocketData(event.data)) return;
      let message: { event?: string; data?: unknown };
      try {
        message = parseRealtimeMessage(label, 'writer', event.data);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (message.event === 'hello') {
        const data = message.data as Record<string, unknown>;
        if (
          data.actorId !== args.actorId ||
          data.clientId !== writerClientId ||
          data.syncPackEncoding !== 'binary-sync-pack-v1'
        ) {
          fail(
            new Error(
              `${label} writer hello had unexpected data: ${JSON.stringify(
                message
              ).slice(0, 500)}`
            )
          );
          return;
        }
        writerHello = true;
        lastError = 'writer hello received; waiting for reader pack';
        maybeSendWriterPush();
        return;
      }
      if (message.event === 'push-response') {
        const data = message.data as {
          ok?: boolean;
          requestId?: string;
          results?: Array<{ status?: string }>;
          status?: string;
        };
        if (
          data.requestId !== requestId ||
          data.ok !== true ||
          data.status !== 'applied' ||
          data.results?.[0]?.status !== 'applied'
        ) {
          fail(
            new Error(
              `${label} writer push-response did not apply: ${JSON.stringify(
                message
              ).slice(0, 500)}`
            )
          );
          return;
        }
        writerResponseApplied = true;
        lastError = 'writer push-response applied; waiting for reader pack';
        maybePass();
        return;
      }
      if (message.event === 'error') {
        fail(
          new Error(
            `${label} writer realtime error: ${JSON.stringify(message).slice(
              0,
              500
            )}`
          )
        );
      }
    });

    for (const [role, socket] of [
      ['reader', readerSocket],
      ['writer', writerSocket],
    ] as const) {
      socket.addEventListener('error', () => {
        lastError = `${role} websocket error event`;
      });
      socket.addEventListener('close', (event) => {
        if (settled) return;
        fail(
          new Error(
            `${label} ${role} websocket closed before proof completed: code=${
              event.code
            } reason=${event.reason || 'null'}; ${lastError}\n${args.output.join(
              ''
            )}`
          )
        );
      });
    }
  });
}

function syncularRealtimeUrl(args: {
  actorId: string;
  clientId: string;
  origin: string;
  routeBase: string;
}): string {
  const url = new URL(`${args.origin}${args.routeBase}/realtime`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('actorId', args.actorId);
  url.searchParams.set('clientId', args.clientId);
  url.searchParams.set('syncPackEncoding', 'binary-sync-pack-v1');
  return url.toString();
}

function parseRealtimeMessage(
  label: string,
  role: string,
  data: unknown
): { event?: string; data?: unknown } {
  const text = webSocketDataToText(data);
  try {
    return JSON.parse(text) as { event?: string; data?: unknown };
  } catch (error) {
    throw new Error(
      `${label} ${role} received non-JSON realtime frame: ${text.slice(
        0,
        500
      )}; ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function runBlobRouteFlow(args: {
  origin: string;
  routeBase: string;
  syncRouteBase: string;
  metrics?: CloudflareBlobRouteMetrics;
  output: string[];
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const label = 'Cloudflare R2 blob route smoke';
  const startedAt = performance.now();
  if (args.metrics) args.metrics.attempted = true;
  const actorId = 'syncular-framework-actor';
  const partitionId = 'syncular-framework-partition';
  const contentText = `syncular-cloudflare-r2-route-content-${Date.now()}`;
  const content = new TextEncoder().encode(contentText);
  if (args.metrics) args.metrics.contentBytes = content.byteLength;
  const hash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const headers = {
    'content-type': 'application/json',
    'x-syncular-smoke-actor': actorId,
    'x-syncular-smoke-partition': partitionId,
  };

  await assertBlobRouteNegativeMatrix({
    origin: args.origin,
    routeBase: args.routeBase,
    output: args.output,
    getExit: args.getExit,
  });

  try {
    const initResponse = await measureCloudflareBlobMetric(
      args.metrics,
      'uploadInitMs',
      () =>
        fetchWorkerResponse({
          label,
          url: `${args.origin}${args.routeBase}/blobs/upload`,
          init: {
            method: 'POST',
            headers,
            body: JSON.stringify({
              hash,
              size: content.byteLength,
              mimeType: 'text/plain',
            }),
          },
          output: args.output,
          getExit: args.getExit,
        })
    );
    await expectOkResponse(label, 'upload init', initResponse, args.output);
    const initBody = (await readJsonResponse(
      label,
      'upload init',
      initResponse
    )) as {
      exists?: boolean;
      headers?: Record<string, string>;
      uploadMethod?: string;
      uploadUrl?: string;
    };
    if (typeof initBody.uploadUrl !== 'string') {
      throw new Error(
        `${label} did not return an upload URL: ${JSON.stringify(initBody)}`
      );
    }

    const uploadResponse = await measureCloudflareBlobMetric(
      args.metrics,
      'uploadBytesMs',
      () =>
        fetchWorkerResponse({
          label,
          url: resolveWorkerRouteUrl(args.origin, initBody.uploadUrl),
          init: {
            method: initBody.uploadMethod ?? 'PUT',
            headers: {
              ...(initBody.headers ?? {}),
              'content-type': 'text/plain',
              'content-length': String(content.byteLength),
            },
            body: content,
          },
          output: args.output,
          getExit: args.getExit,
        })
    );
    await expectOkResponse(label, 'upload bytes', uploadResponse, args.output);

    const forbiddenCompleteResponse = await fetchWorkerResponse({
      label,
      url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
        hash
      )}/complete`,
      init: {
        method: 'POST',
        headers: {
          'x-syncular-smoke-actor': `${actorId}-other`,
          'x-syncular-smoke-partition': partitionId,
        },
      },
      output: args.output,
      getExit: args.getExit,
    });
    await expectJsonErrorResponse(label, 'forbidden upload completion', {
      response: forbiddenCompleteResponse,
      output: args.output,
      status: 403,
      code: 'blob.forbidden',
      category: 'forbidden',
      recommendedAction: 'checkPermissions',
    });

    const completeResponse = await measureCloudflareBlobMetric(
      args.metrics,
      'completeUploadMs',
      () =>
        fetchWorkerResponse({
          label,
          url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
            hash
          )}/complete`,
          init: {
            method: 'POST',
            headers: {
              'x-syncular-smoke-actor': actorId,
              'x-syncular-smoke-partition': partitionId,
            },
          },
          output: args.output,
          getExit: args.getExit,
        })
    );
    await expectOkResponse(
      label,
      'complete upload',
      completeResponse,
      args.output
    );

    const unreferencedDownloadUrlResponse = await fetchWorkerResponse({
      label,
      url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
        hash
      )}/url`,
      init: {
        headers: {
          'x-syncular-smoke-actor': actorId,
          'x-syncular-smoke-partition': partitionId,
        },
      },
      output: args.output,
      getExit: args.getExit,
    });
    const unreferencedDownloadUrlBody = await expectJsonErrorResponse(
      label,
      'unreferenced download URL',
      {
        response: unreferencedDownloadUrlResponse,
        output: args.output,
        status: 403,
        code: 'blob.forbidden',
        category: 'forbidden',
        recommendedAction: 'checkPermissions',
      }
    );
    assertBlobAccessDeniedDetails(label, 'unreferenced download URL', {
      body: unreferencedDownloadUrlBody,
      partitionId,
      accessReason: 'missing_reference',
      accessStage: 'reference',
    });

    await measureCloudflareBlobMetric(args.metrics, 'referencePushMs', () =>
      pushBlobReferenceRow({
        actorId,
        hash,
        mimeType: 'text/plain',
        origin: args.origin,
        output: args.output,
        routeBase: args.syncRouteBase,
        size: content.byteLength,
        getExit: args.getExit,
      })
    );

    const downloadUrlResponse = await measureCloudflareBlobMetric(
      args.metrics,
      'downloadUrlMs',
      () =>
        fetchWorkerResponse({
          label,
          url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
            hash
          )}/url`,
          init: {
            headers: {
              'x-syncular-smoke-actor': actorId,
              'x-syncular-smoke-partition': partitionId,
            },
          },
          output: args.output,
          getExit: args.getExit,
        })
    );
    await expectOkResponse(
      label,
      'create download URL',
      downloadUrlResponse,
      args.output
    );
    const downloadUrlBody = (await readJsonResponse(
      label,
      'create download URL',
      downloadUrlResponse
    )) as {
      url?: string;
    };
    if (typeof downloadUrlBody.url !== 'string') {
      throw new Error(
        `${label} did not return a download URL: ${JSON.stringify(
          downloadUrlBody
        )}`
      );
    }

    const downloadResponse = await measureCloudflareBlobMetric(
      args.metrics,
      'downloadBytesMs',
      () =>
        fetchWorkerResponse({
          label,
          url: resolveWorkerRouteUrl(args.origin, downloadUrlBody.url),
          output: args.output,
          getExit: args.getExit,
        })
    );
    await expectOkResponse(
      label,
      'download bytes',
      downloadResponse,
      args.output
    );
    const downloadedText = await downloadResponse.text();
    if (args.metrics) {
      args.metrics.downloadBytes = Buffer.byteLength(downloadedText, 'utf8');
    }
    if (downloadedText !== contentText) {
      throw new Error(
        `${label} downloaded unexpected content: ${downloadedText.slice(0, 200)}`
      );
    }

    const forbiddenDownloadUrlResponse = await fetchWorkerResponse({
      label,
      url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
        hash
      )}/url`,
      init: {
        headers: {
          'x-syncular-smoke-actor': 'syncular-framework-intruder',
          'x-syncular-smoke-partition': partitionId,
        },
      },
      output: args.output,
      getExit: args.getExit,
    });
    const forbiddenDownloadUrlBody = await expectJsonErrorResponse(
      label,
      'forbidden download URL',
      {
        response: forbiddenDownloadUrlResponse,
        output: args.output,
        status: 403,
        code: 'blob.forbidden',
        category: 'forbidden',
        recommendedAction: 'checkPermissions',
      }
    );
    assertBlobAccessDeniedDetails(label, 'forbidden download URL', {
      body: forbiddenDownloadUrlBody,
      partitionId,
      accessReason: 'scope_denied',
      accessStage: 'scope',
      referenceTable: 'syncular_framework_tasks',
      referenceColumn: 'image_blob_ref',
    });

    await runPartitionedBlobReferenceFlow({
      actorId,
      origin: args.origin,
      output: args.output,
      partitionId,
      routeBase: args.routeBase,
      syncRouteBase: args.syncRouteBase,
      metrics: args.metrics,
      getExit: args.getExit,
    });
  } finally {
    if (args.metrics) args.metrics.totalMs = elapsedSince(startedAt);
  }
}

async function pushBlobReferenceRow(args: {
  actorId: string;
  hash: string;
  mimeType: string;
  origin: string;
  output: string[];
  routeBase: string;
  size: number;
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const label = 'Cloudflare R2 blob route smoke';
  const rowId = `syncular-framework-blob-reference-${Date.now()}`;
  const pushResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncular-smoke-actor': args.actorId,
      },
      body: JSON.stringify({
        clientId: 'syncular-framework-blob-reference-writer',
        push: {
          commits: [
            {
              clientCommitId: `commit-${rowId}`,
              schemaVersion: 1,
              operations: [
                {
                  table: 'syncular_framework_tasks',
                  row_id: rowId,
                  op: 'upsert',
                  payload: {
                    id: rowId,
                    user_id: args.actorId,
                    title: 'R2 scoped blob reference ready',
                    image_blob_hash: args.hash,
                    image_blob_ref: JSON.stringify({
                      hash: args.hash,
                      size: args.size,
                      mimeType: args.mimeType,
                    }),
                    server_version: 0,
                  },
                },
              ],
            },
          ],
        },
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectOkResponse(
    label,
    'blob reference push',
    pushResponse,
    args.output
  );
  const pushBody = (await readSyncRouteResponse(
    label,
    'blob reference push',
    pushResponse
  )) as {
    ok?: boolean;
    push?: {
      commits?: Array<{
        results?: Array<{ status?: string }>;
        status?: string;
      }>;
    };
  };
  const pushedCommit = pushBody.push?.commits?.[0];
  if (
    pushBody.ok !== true ||
    pushedCommit?.status !== 'applied' ||
    pushedCommit.results?.[0]?.status !== 'applied'
  ) {
    throw new Error(
      `${label} blob reference push did not apply: ${JSON.stringify(
        pushBody
      ).slice(0, 500)}`
    );
  }
}

async function runPartitionedBlobReferenceFlow(args: {
  actorId: string;
  metrics?: CloudflareBlobRouteMetrics;
  origin: string;
  output: string[];
  partitionId: string;
  routeBase: string;
  syncRouteBase: string;
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const label = 'Cloudflare R2 blob route smoke';
  const alternatePartitionId = `${args.partitionId}-alternate`;
  const contentText = `syncular-cloudflare-r2-partitioned-route-content-${Date.now()}`;
  const content = new TextEncoder().encode(contentText);
  const hash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const headers = {
    'content-type': 'application/json',
    'x-syncular-smoke-actor': args.actorId,
    'x-syncular-smoke-partition': args.partitionId,
  };

  const initResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}/blobs/upload`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        hash,
        size: content.byteLength,
        mimeType: 'text/plain',
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectOkResponse(
    label,
    'partitioned upload init',
    initResponse,
    args.output
  );
  const initBody = (await readJsonResponse(
    label,
    'partitioned upload init',
    initResponse
  )) as {
    headers?: Record<string, string>;
    uploadMethod?: string;
    uploadUrl?: string;
  };
  if (typeof initBody.uploadUrl !== 'string') {
    throw new Error(
      `${label} did not return a partitioned upload URL: ${JSON.stringify(
        initBody
      )}`
    );
  }

  const uploadResponse = await fetchWorkerResponse({
    label,
    url: resolveWorkerRouteUrl(args.origin, initBody.uploadUrl),
    init: {
      method: initBody.uploadMethod ?? 'PUT',
      headers: {
        ...(initBody.headers ?? {}),
        'content-type': 'text/plain',
        'content-length': String(content.byteLength),
      },
      body: content,
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectOkResponse(
    label,
    'partitioned upload bytes',
    uploadResponse,
    args.output
  );

  const completeResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
      hash
    )}/complete`,
    init: {
      method: 'POST',
      headers: {
        'x-syncular-smoke-actor': args.actorId,
        'x-syncular-smoke-partition': args.partitionId,
      },
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectOkResponse(
    label,
    'partitioned complete upload',
    completeResponse,
    args.output
  );

  await pushPartitionedBlobReferenceRow({
    actorId: args.actorId,
    hash,
    mimeType: 'text/plain',
    origin: args.origin,
    output: args.output,
    partitionId: alternatePartitionId,
    routeBase: args.syncRouteBase,
    size: content.byteLength,
    getExit: args.getExit,
  });

  const wrongPartitionUrlResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
      hash
    )}/url`,
    init: {
      headers: {
        'x-syncular-smoke-actor': args.actorId,
        'x-syncular-smoke-partition': args.partitionId,
      },
    },
    output: args.output,
    getExit: args.getExit,
  });
  const wrongPartitionUrlBody = await expectJsonErrorResponse(
    label,
    'wrong-partition download URL',
    {
      response: wrongPartitionUrlResponse,
      output: args.output,
      status: 403,
      code: 'blob.forbidden',
      category: 'forbidden',
      recommendedAction: 'checkPermissions',
    }
  );
  assertBlobAccessDeniedDetails(label, 'wrong-partition download URL', {
    body: wrongPartitionUrlBody,
    partitionId: args.partitionId,
    accessReason: 'missing_reference',
    accessStage: 'reference',
  });

  const referenceRowId = await pushPartitionedBlobReferenceRow({
    actorId: args.actorId,
    hash,
    mimeType: 'text/plain',
    origin: args.origin,
    output: args.output,
    partitionId: args.partitionId,
    routeBase: args.syncRouteBase,
    size: content.byteLength,
    getExit: args.getExit,
  });

  const downloadUrlResponse = await measureCloudflareBlobMetric(
    args.metrics,
    'partitionedDownloadUrlMs',
    () =>
      fetchWorkerResponse({
        label,
        url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
          hash
        )}/url`,
        init: {
          headers: {
            'x-syncular-smoke-actor': args.actorId,
            'x-syncular-smoke-partition': args.partitionId,
          },
        },
        output: args.output,
        getExit: args.getExit,
      })
  );
  await expectOkResponse(
    label,
    'partitioned download URL',
    downloadUrlResponse,
    args.output
  );
  const downloadUrlBody = (await readJsonResponse(
    label,
    'partitioned download URL',
    downloadUrlResponse
  )) as { url?: string };
  if (typeof downloadUrlBody.url !== 'string') {
    throw new Error(
      `${label} did not return a partitioned download URL: ${JSON.stringify(
        downloadUrlBody
      )}`
    );
  }

  const forbiddenDownloadUrlResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
      hash
    )}/url`,
    init: {
      headers: {
        'x-syncular-smoke-actor': `${args.actorId}-intruder`,
        'x-syncular-smoke-partition': args.partitionId,
      },
    },
    output: args.output,
    getExit: args.getExit,
  });
  const forbiddenDownloadUrlBody = await expectJsonErrorResponse(
    label,
    'partitioned forbidden download URL',
    {
      response: forbiddenDownloadUrlResponse,
      output: args.output,
      status: 403,
      code: 'blob.forbidden',
      category: 'forbidden',
      recommendedAction: 'checkPermissions',
    }
  );
  assertBlobAccessDeniedDetails(label, 'partitioned forbidden download URL', {
    body: forbiddenDownloadUrlBody,
    partitionId: args.partitionId,
    accessReason: 'scope_denied',
    accessStage: 'scope',
    referenceTable: 'syncular_framework_file_versions',
    referenceColumn: 'blob_ref',
  });

  const downloadResponse = await measureCloudflareBlobMetric(
    args.metrics,
    'partitionedDownloadBytesMs',
    () =>
      fetchWorkerResponse({
        label,
        url: resolveWorkerRouteUrl(args.origin, downloadUrlBody.url),
        output: args.output,
        getExit: args.getExit,
      })
  );
  await expectOkResponse(
    label,
    'partitioned download bytes',
    downloadResponse,
    args.output
  );
  const downloadedText = await downloadResponse.text();
  if (args.metrics) {
    args.metrics.partitionedDownloadBytes = Buffer.byteLength(
      downloadedText,
      'utf8'
    );
  }
  if (downloadedText !== contentText) {
    throw new Error(
      `${label} downloaded unexpected partitioned content: ${downloadedText.slice(
        0,
        200
      )}`
    );
  }

  await pushPartitionedBlobReferenceRevocation({
    actorId: args.actorId,
    hash,
    origin: args.origin,
    output: args.output,
    partitionId: args.partitionId,
    routeBase: args.syncRouteBase,
    rowId: referenceRowId,
    getExit: args.getExit,
  });
  await expectBlobDownloadUrlDenied({
    accessReason: 'missing_reference',
    accessStage: 'reference',
    actorId: args.actorId,
    hash,
    origin: args.origin,
    output: args.output,
    partitionId: args.partitionId,
    routeBase: args.routeBase,
    step: 'revoked partitioned download URL',
    getExit: args.getExit,
  });

  await pushPartitionedBlobReferenceDelete({
    actorId: args.actorId,
    origin: args.origin,
    output: args.output,
    routeBase: args.syncRouteBase,
    rowId: referenceRowId,
    getExit: args.getExit,
  });
  await expectBlobDownloadUrlDenied({
    accessReason: 'missing_reference',
    accessStage: 'reference',
    actorId: args.actorId,
    hash,
    origin: args.origin,
    output: args.output,
    partitionId: args.partitionId,
    routeBase: args.routeBase,
    step: 'deleted partitioned download URL',
    getExit: args.getExit,
  });
}

async function pushPartitionedBlobReferenceRow(args: {
  actorId: string;
  hash: string;
  mimeType: string;
  origin: string;
  output: string[];
  partitionId: string;
  routeBase: string;
  size: number;
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<string> {
  const label = 'Cloudflare R2 blob route smoke';
  const rowId = `syncular-framework-file-version-${args.partitionId}-${Date.now()}`;
  const pushResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncular-smoke-actor': args.actorId,
      },
      body: JSON.stringify({
        clientId: `syncular-framework-file-version-writer-${args.partitionId}`,
        push: {
          commits: [
            {
              clientCommitId: `commit-${rowId}`,
              schemaVersion: 1,
              operations: [
                {
                  table: 'syncular_framework_file_versions',
                  row_id: rowId,
                  op: 'upsert',
                  payload: {
                    id: rowId,
                    owner_id: args.actorId,
                    partition_id: args.partitionId,
                    content_hash: args.hash,
                    blob_ref: JSON.stringify({
                      hash: args.hash,
                      size: args.size,
                      mimeType: args.mimeType,
                    }),
                    server_version: 0,
                  },
                },
              ],
            },
          ],
        },
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectOkResponse(
    label,
    'partitioned blob reference push',
    pushResponse,
    args.output
  );
  const pushBody = (await readSyncRouteResponse(
    label,
    'partitioned blob reference push',
    pushResponse
  )) as {
    ok?: boolean;
    push?: {
      commits?: Array<{
        results?: Array<{ status?: string }>;
        status?: string;
      }>;
    };
  };
  const pushedCommit = pushBody.push?.commits?.[0];
  if (
    pushBody.ok !== true ||
    pushedCommit?.status !== 'applied' ||
    pushedCommit.results?.[0]?.status !== 'applied'
  ) {
    throw new Error(
      `${label} partitioned blob reference push did not apply: ${JSON.stringify(
        pushBody
      ).slice(0, 500)}`
    );
  }
  return rowId;
}

async function pushPartitionedBlobReferenceRevocation(args: {
  actorId: string;
  hash: string;
  origin: string;
  output: string[];
  partitionId: string;
  routeBase: string;
  rowId: string;
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const label = 'Cloudflare R2 blob route smoke';
  const pushResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncular-smoke-actor': args.actorId,
      },
      body: JSON.stringify({
        clientId: `syncular-framework-file-version-revoker-${args.partitionId}`,
        push: {
          commits: [
            {
              clientCommitId: `commit-revoke-${args.rowId}`,
              schemaVersion: 1,
              operations: [
                {
                  table: 'syncular_framework_file_versions',
                  row_id: args.rowId,
                  op: 'upsert',
                  payload: {
                    id: args.rowId,
                    owner_id: args.actorId,
                    partition_id: args.partitionId,
                    content_hash: args.hash,
                    blob_ref: null,
                    server_version: 0,
                  },
                },
              ],
            },
          ],
        },
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectAppliedPushResponse({
    label,
    output: args.output,
    response: pushResponse,
    step: 'partitioned blob reference revocation',
  });
}

async function pushPartitionedBlobReferenceDelete(args: {
  actorId: string;
  origin: string;
  output: string[];
  routeBase: string;
  rowId: string;
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const label = 'Cloudflare R2 blob route smoke';
  const pushResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncular-smoke-actor': args.actorId,
      },
      body: JSON.stringify({
        clientId: 'syncular-framework-file-version-deleter',
        push: {
          commits: [
            {
              clientCommitId: `commit-delete-${args.rowId}`,
              schemaVersion: 1,
              operations: [
                {
                  table: 'syncular_framework_file_versions',
                  row_id: args.rowId,
                  op: 'delete',
                  payload: null,
                },
              ],
            },
          ],
        },
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectAppliedPushResponse({
    label,
    output: args.output,
    response: pushResponse,
    step: 'partitioned blob reference delete',
  });
}

async function expectBlobDownloadUrlDenied(args: {
  accessReason: string;
  accessStage: string;
  actorId: string;
  hash: string;
  origin: string;
  output: string[];
  partitionId: string;
  referenceColumn?: string;
  referenceTable?: string;
  routeBase: string;
  step: string;
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const label = 'Cloudflare R2 blob route smoke';
  const response = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
      args.hash
    )}/url`,
    init: {
      headers: {
        'x-syncular-smoke-actor': args.actorId,
        'x-syncular-smoke-partition': args.partitionId,
      },
    },
    output: args.output,
    getExit: args.getExit,
  });
  const body = await expectJsonErrorResponse(label, args.step, {
    response,
    output: args.output,
    status: 403,
    code: 'blob.forbidden',
    category: 'forbidden',
    recommendedAction: 'checkPermissions',
  });
  assertBlobAccessDeniedDetails(label, args.step, {
    body,
    partitionId: args.partitionId,
    accessReason: args.accessReason,
    accessStage: args.accessStage,
    referenceColumn: args.referenceColumn,
    referenceTable: args.referenceTable,
  });
}

async function expectAppliedPushResponse(args: {
  label: string;
  output: string[];
  response: Response;
  step: string;
}): Promise<void> {
  await expectOkResponse(args.label, args.step, args.response, args.output);
  const pushBody = (await readSyncRouteResponse(
    args.label,
    args.step,
    args.response
  )) as {
    ok?: boolean;
    push?: {
      commits?: Array<{
        results?: Array<{ status?: string }>;
        status?: string;
      }>;
    };
  };
  const pushedCommit = pushBody.push?.commits?.[0];
  if (
    pushBody.ok !== true ||
    pushedCommit?.status !== 'applied' ||
    pushedCommit.results?.[0]?.status !== 'applied'
  ) {
    throw new Error(
      `${args.label} ${args.step} did not apply: ${JSON.stringify(
        pushBody
      ).slice(0, 500)}`
    );
  }
}

function assertBlobAccessDeniedDetails(
  label: string,
  step: string,
  args: {
    body: Record<string, unknown>;
    partitionId: string;
    accessReason: string;
    accessStage: string;
    referenceColumn?: string;
    referenceTable?: string;
  }
): void {
  const details = args.body.details as Record<string, unknown> | undefined;
  if (
    details?.failureKind !== 'blob_access_denied' ||
    details.accessReason !== args.accessReason ||
    details.accessStage !== args.accessStage ||
    details.partitionId !== args.partitionId ||
    (args.referenceTable !== undefined &&
      details.referenceTable !== args.referenceTable) ||
    (args.referenceColumn !== undefined &&
      details.referenceColumn !== args.referenceColumn)
  ) {
    throw new Error(
      `${label} ${step} returned unexpected details: ${JSON.stringify(
        args.body
      ).slice(0, 500)}`
    );
  }
}

async function assertBlobRouteNegativeMatrix(args: {
  origin: string;
  routeBase: string;
  output: string[];
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<void> {
  const label = 'Cloudflare R2 blob route smoke';
  const invalidHash = `sha256:${'0'.repeat(64)}`;
  const unauthenticatedUploadInitResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}/blobs/upload`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        hash: invalidHash,
        size: 1,
        mimeType: 'application/octet-stream',
      }),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectJsonErrorResponse(label, 'unauthenticated upload init', {
    response: unauthenticatedUploadInitResponse,
    output: args.output,
    status: 401,
    code: 'sync.auth_required',
    category: 'auth-required',
    recommendedAction: 'refreshAuth',
  });

  const invalidUploadInitResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}/blobs/upload`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncular-smoke-actor': 'syncular-framework-actor',
      },
      body: JSON.stringify({}),
    },
    output: args.output,
    getExit: args.getExit,
  });
  await expectJsonErrorResponse(label, 'invalid upload init', {
    response: invalidUploadInitResponse,
    output: args.output,
    status: 400,
    code: 'blob.invalid_request',
    category: 'blob',
    recommendedAction: 'fixRequest',
  });

  const invalidDirectUploadTokenResponse = await fetchWorkerResponse({
    label,
    url: `${args.origin}${args.routeBase}/blobs/${encodeURIComponent(
      invalidHash
    )}/upload?token=invalid-token`,
    init: {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array([1]),
    },
    output: args.output,
    getExit: args.getExit,
  });
  const invalidTokenBody = await expectJsonErrorResponse(
    label,
    'invalid direct-upload token',
    {
      response: invalidDirectUploadTokenResponse,
      output: args.output,
      status: 401,
      code: 'blob.invalid_token',
      category: 'auth-required',
      recommendedAction: 'refreshAuth',
    }
  );
  const invalidTokenDetails = invalidTokenBody.details as
    | Record<string, unknown>
    | undefined;
  if (
    invalidTokenDetails?.failureKind !== 'invalid_token' ||
    invalidTokenDetails.tokenAction !== 'upload'
  ) {
    throw new Error(
      `${label} invalid direct-upload token returned unexpected details: ${JSON.stringify(
        invalidTokenBody
      ).slice(0, 500)}`
    );
  }
}

function resolveWorkerRouteUrl(origin: string, candidate: string): string {
  const url = new URL(candidate, origin);
  return `${origin}${url.pathname}${url.search}`;
}

async function fetchWorkerResponse(args: {
  label: string;
  url: string;
  init?: RequestInit;
  output: string[];
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}): Promise<Response> {
  const exit = args.getExit();
  if (exit) {
    throw new Error(
      `${args.label} exited before fetching ${args.url}: code=${
        exit.code ?? 'null'
      } signal=${exit.signal ?? 'null'}\n${args.output.join('')}`
    );
  }
  try {
    return await fetchResponseWithTimeout(args.url, args.init, 10_000);
  } catch (error) {
    throw new Error(
      `${args.label} request failed for ${args.url}: ${
        error instanceof Error ? error.message : String(error)
      }\n${args.output.join('')}`
    );
  }
}

async function expectOkResponse(
  label: string,
  step: string,
  response: Response,
  output: string[]
): Promise<void> {
  if (response.ok) return;
  throw new Error(
    `${label} ${step} failed with ${response.status} ${
      response.statusText
    }: ${(await response.text()).slice(0, 500)}\n${output.join('')}`
  );
}

async function expectJsonErrorResponse(
  label: string,
  step: string,
  args: {
    category: string;
    code: string;
    output: string[];
    recommendedAction: string;
    response: Response;
    status: number;
  }
): Promise<Record<string, unknown>> {
  const text = await args.response.text();
  if (args.response.status !== args.status) {
    throw new Error(
      `${label} ${step} expected ${args.status} but received ${
        args.response.status
      } ${args.response.statusText}: ${text.slice(0, 500)}\n${args.output.join(
        ''
      )}`
    );
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${label} ${step} returned non-JSON error body: ${text.slice(0, 500)}; ${
        error instanceof Error ? error.message : String(error)
      }\n${args.output.join('')}`
    );
  }
  if (
    body.error !== args.code ||
    body.code !== args.code ||
    body.category !== args.category ||
    body.recommendedAction !== args.recommendedAction
  ) {
    throw new Error(
      `${label} ${step} returned unexpected error envelope: ${JSON.stringify(
        body
      ).slice(0, 500)}\n${args.output.join('')}`
    );
  }
  return body;
}

async function readJsonResponse(
  label: string,
  step: string,
  response: Response
): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label} ${step} returned non-JSON ${response.status} ${
        response.statusText
      } (${response.headers.get('content-type') ?? 'no content-type'}): ${text.slice(
        0,
        500
      )}; ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function readSyncRouteResponse(
  label: string,
  step: string,
  response: Response
): Promise<unknown> {
  if (isBinarySyncPackContentType(response.headers.get('content-type'))) {
    return decodeBinarySyncPack(new Uint8Array(await response.arrayBuffer()));
  }
  return readJsonResponse(label, step, response);
}

async function fetchTextWithTimeout(url: string, timeoutMs: number) {
  const response = await fetchResponseWithTimeout(url, undefined, timeoutMs);
  return await response.text();
}

async function fetchResponseWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const exitPromise = new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise());
  });
  child.kill('SIGINT');
  const interrupted = await Promise.race([
    exitPromise.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!interrupted && child.exitCode == null && child.signalCode == null) {
    child.kill('SIGTERM');
  }
  const terminated = await Promise.race([
    exitPromise.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!terminated && child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL');
    await Promise.race([exitPromise, Bun.sleep(2_000)]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function linkPackage(appDir: string, name: string, target: string) {
  if (!existsSync(target)) {
    throw new Error(`Cannot link ${name}; missing ${target}`);
  }
  const destination = join(appDir, 'node_modules', ...name.split('/'));
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await symlink(target, destination, 'dir');
}

function workspaceDependencyPath(name: string): string {
  const bunStore = join(repoRoot, 'node_modules/.bun');
  const bunStoreName = name.replace('/', '+');
  const bunStoreCandidates = existsSync(bunStore)
    ? Array.from(
        new Bun.Glob(`${bunStoreName}@*/node_modules/${name}`).scanSync({
          cwd: bunStore,
        })
      ).map((candidate) => join(bunStore, candidate))
    : [];
  const candidates = [
    join(repoRoot, 'node_modules', name),
    join(repoRoot, 'apps/docs/node_modules', name),
    join(repoRoot, 'packages/client/node_modules', name),
    join(repoRoot, 'packages/server/node_modules', name),
    join(repoRoot, 'packages/create-syncular-app/node_modules', name),
    join(repoRoot, 'packages/console/node_modules', name),
    ...bunStoreCandidates,
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Cannot resolve workspace dependency ${name}; tried ${candidates.join(', ')}`
    );
  }
  return found;
}

async function writeNextApp(appDir: string): Promise<void> {
  await mkdir(join(appDir, 'app'), { recursive: true });
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: {
          build: 'next build',
        },
        dependencies: {
          '@syncular/client': 'workspace:*',
          '@syncular/core': 'workspace:*',
          '@syncular/server': 'workspace:*',
          next: 'workspace:*',
          react: 'workspace:*',
          'react-dom': 'workspace:*',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'next.config.mjs'),
    `import { resolve } from 'node:path';

const repoRoot = ${JSON.stringify(repoRoot)};

const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@syncular/client', '@syncular/core', '@syncular/server'],
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      '@syncular/client': resolve(repoRoot, 'packages/client/src/index.ts'),
      '@syncular/core': resolve(repoRoot, 'packages/core/src/index.ts'),
      '@syncular/core/http': resolve(
        repoRoot,
        'packages/core/src/http/index.ts'
      ),
      '@syncular/core/http/blob': resolve(
        repoRoot,
        'packages/core/src/http/blob.ts'
      ),
      '@syncular/core/sentry': resolve(repoRoot, 'packages/core/src/sentry.ts'),
      '@syncular/server': resolve(repoRoot, 'packages/server/src/index.ts'),
    };
    return config;
  },
};

export default nextConfig;
`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'app', 'layout.js'),
    `export const metadata = {
  title: 'Syncular framework import smoke',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'app', 'page.js'),
    `import {
  getSyncularBrowserHealth,
  getSyncularSupportBundle,
} from '@syncular/client';
import { ensureSyncSchema } from '@syncular/server';

export const dynamic = 'force-static';

export default function Page() {
  const checks = [
    ['client health', getSyncularBrowserHealth],
    ['client support bundle', getSyncularSupportBundle],
    ['server schema', ensureSyncSchema],
  ];
  for (const [label, value] of checks) {
    if (typeof value !== 'function') {
      throw new Error(label + ' root import was not a function');
    }
  }
  return <main>Syncular root imports are SSR-safe.</main>;
}
`,
    'utf8'
  );
}

async function writeViteApp(appDir: string): Promise<void> {
  await mkdir(join(appDir, 'src'), { recursive: true });
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: {
          build: 'vite build',
        },
        dependencies: {
          '@syncular/client': 'workspace:*',
          '@syncular/core': 'workspace:*',
          vite: 'workspace:*',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="data:," />
    <title>Syncular Vite framework smoke</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'src', 'main.ts'),
    `import {
  getSyncularBrowserHealth,
  getSyncularSupportBundle,
} from '@syncular/client';

const checks = [
  ['client health', getSyncularBrowserHealth],
  ['client support bundle', getSyncularSupportBundle],
] as const;

for (const [label, value] of checks) {
  if (typeof value !== 'function') {
    throw new Error(label + ' root import was not a function');
  }
}

document
  .querySelector('#app')
  ?.setAttribute('data-syncular-vite-root-import', 'ready');
`,
    'utf8'
  );
}

async function writeCloudflareWorkerApp(appDir: string): Promise<void> {
  await mkdir(join(appDir, 'src'), { recursive: true });
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@syncular/core': 'workspace:*',
          '@syncular/server': 'workspace:*',
          'hono-openapi': 'workspace:*',
          hono: 'workspace:*',
          wrangler: 'workspace:*',
          zod: 'workspace:*',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'src', 'worker.ts'),
    `import {
  createBlobManager,
  createDatabase,
  createServerHandler,
  createScopedBlobAccessDecisionChecker,
  ensureBlobStorageSchemaSqlite,
  ensureSyncSchema,
} from '@syncular/server';
import { createD1Dialect } from '@syncular/server/d1';
import { createBlobRoutes, createSyncServer } from '@syncular/server/hono';
import { createSqliteServerDialect } from '@syncular/server/sqlite';
import {
  createHmacTokenSigner,
  createR2BlobStorageAdapter,
  SyncDurableObject,
  createSyncWorkerWithDO,
} from '@syncular/server/cloudflare';

type Env = {
  BLOBS: R2Bucket;
  DB: D1Database;
  SYNC_DO: DurableObjectNamespace;
};

export class SyncularSmokeDurableObject extends SyncDurableObject<Env> {
  async setup(app, env, upgradeWebSocket) {
    const d1Dialect = createD1Dialect(env.DB);
    const syncDialect = createSqliteServerDialect({
      supportsTransactions: false,
    });
    const db = createDatabase({
      dialect: d1Dialect,
      family: 'sqlite',
    });
    const tokenSigner = createHmacTokenSigner(
      'syncular-framework-smoke-secret'
    );
    const blobStorage = createR2BlobStorageAdapter({
      bucket: env.BLOBS,
      baseUrl: '/syncular-framework-import-smoke/sync',
      tokenSigner,
    });
    const blobManager = createBlobManager({
      db,
      adapter: blobStorage,
    });
    await ensureSyncSchema(db, syncDialect);
    await ensureBlobStorageSchemaSqlite(db);
    await db.schema
      .createTable('syncular_framework_tasks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('image_blob_hash', 'text')
      .addColumn('image_blob_ref', 'text')
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
    await db.schema
      .createTable('syncular_framework_file_versions')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('owner_id', 'text', (col) => col.notNull())
      .addColumn('partition_id', 'text', (col) => col.notNull())
      .addColumn('content_hash', 'text', (col) => col.notNull())
      .addColumn('blob_ref', 'text')
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
    const taskHandler = createServerHandler({
      table: 'syncular_framework_tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({
        user_id: [ctx.actorId],
      }),
    });
    const fileVersionHandler = createServerHandler({
      table: 'syncular_framework_file_versions',
      scopes: ['user:{owner_id}'],
      resolveScopes: async (ctx) => ({
        owner_id: [ctx.actorId],
      }),
    });
    const { syncRoutes } = createSyncServer({
      db,
      dialect: syncDialect,
      sync: {
        handlers: [taskHandler, fileVersionHandler],
        authenticate: async (request) => {
          const actorId =
            request.headers.get('x-syncular-smoke-actor') ??
            new URL(request.url).searchParams.get('actorId');
          return actorId ? { actorId } : null;
        },
      },
      upgradeWebSocket,
    });
    app.route('/syncular-framework-import-smoke/full-sync', syncRoutes);
    app.route(
      '/syncular-framework-import-smoke/sync',
      createBlobRoutes({
        blobManager,
        tokenSigner,
        db,
        authenticate: async (c) => {
          const actorId = c.req.header('x-syncular-smoke-actor');
          if (!actorId) return null;
          return {
            actorId,
            partitionId:
              c.req.header('x-syncular-smoke-partition') ?? 'default',
          };
        },
        canAccessBlob: createScopedBlobAccessDecisionChecker({
          db,
          handlers: [taskHandler, fileVersionHandler],
          references: [
            {
              table: 'syncular_framework_tasks',
              blobColumns: ['image_blob_ref'],
              hashColumn: 'image_blob_hash',
            },
            {
              table: 'syncular_framework_file_versions',
              blobColumns: ['blob_ref'],
              hashColumn: 'content_hash',
              partitionColumn: 'partition_id',
            },
          ],
        }),
        maxUploadSize: 1024 * 1024,
      })
    );
    app.get('/syncular-framework-import-smoke', async (c) => {
      if (!c.env.SYNC_DO) {
        throw new Error('Durable Object binding was not available');
      }
      if (!c.env.DB) {
        throw new Error('D1 binding was not available');
      }
      if (!c.env.BLOBS) {
        throw new Error('R2 binding was not available');
      }
      if (!d1Dialect || blobStorage.name !== 'r2') {
        throw new Error('Cloudflare adapter factories did not initialize');
      }
      const d1Row = await c.env.DB.prepare(
        'SELECT 1 AS syncular_ready'
      ).first<{ syncular_ready: number }>();
      if (d1Row?.syncular_ready !== 1) {
        throw new Error('D1 runtime query did not return the expected row');
      }
      const commitCountRow = await c.env.DB.prepare(
        'SELECT COUNT(*) AS sync_commit_count FROM sync_commits'
      ).first<{ sync_commit_count: number }>();
      if (typeof commitCountRow?.sync_commit_count !== 'number') {
        throw new Error('Syncular D1 core schema did not create sync_commits');
      }
      const taskId = 'syncular-framework-smoke-task';
      await db
        .deleteFrom('syncular_framework_tasks')
        .where('id', '=', taskId)
        .execute();
      await db
        .insertInto('syncular_framework_tasks')
        .values({
          id: taskId,
          user_id: 'syncular-framework-actor',
          title: 'D1 schema operation ready',
          server_version: 0,
        })
        .execute();
      const taskRow = await db
        .selectFrom('syncular_framework_tasks')
        .select(['id', 'title'])
        .where('id', '=', taskId)
        .executeTakeFirst();
      await db
        .deleteFrom('syncular_framework_tasks')
        .where('id', '=', taskId)
        .execute();
      if (taskRow?.title !== 'D1 schema operation ready') {
        throw new Error('D1 app table operation did not return expected row');
      }
      const objectKey = 'syncular-framework-smoke/object.txt';
      await c.env.BLOBS.put(objectKey, 'syncular-cloudflare-r2-ready', {
        httpMetadata: { contentType: 'text/plain' },
      });
      const objectHead = await c.env.BLOBS.head(objectKey);
      await c.env.BLOBS.delete(objectKey);
      if (!objectHead || objectHead.size <= 0) {
        throw new Error('R2 runtime object IO did not produce object metadata');
      }
      return c.text('syncular-cloudflare-runtime-schema-io-ready');
    });
    app.get('/syncular-framework-import-smoke/ws', (c) =>
      upgradeWebSocket(c, {
        onOpen(_event, ws) {
          ws.send('syncular-cloudflare-websocket-open');
        },
        onMessage(event, ws) {
          ws.send(
            \`syncular-cloudflare-websocket-echo:\${String(event.data)}\`
          );
        },
      })
    );
  }
}

export default createSyncWorkerWithDO<Env>('SYNC_DO');
`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'wrangler.jsonc'),
    `${JSON.stringify(
      {
        name: 'syncular-framework-import-smoke',
        main: 'src/worker.ts',
        compatibility_date: '2026-01-01',
        alias: {
          '@syncular/core': join(repoRoot, 'packages/core/src/index.ts'),
          '@syncular/core/http': join(
            repoRoot,
            'packages/core/src/http/index.ts'
          ),
          '@syncular/core/http/blob': join(
            repoRoot,
            'packages/core/src/http/blob.ts'
          ),
          '@syncular/core/sentry': join(
            repoRoot,
            'packages/core/src/sentry.ts'
          ),
          '@syncular/server': join(repoRoot, 'packages/server/src/index.ts'),
          '@syncular/server/cloudflare': join(
            repoRoot,
            'packages/server/src/cloudflare/index.ts'
          ),
          '@syncular/server/d1': join(repoRoot, 'packages/server/src/d1.ts'),
          '@syncular/server/hono': join(
            repoRoot,
            'packages/server/src/hono/index.ts'
          ),
          '@syncular/server/sqlite': join(
            repoRoot,
            'packages/server/src/sqlite/index.ts'
          ),
        },
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'syncular-framework-import-smoke',
            database_id: '00000000-0000-0000-0000-000000000000',
          },
        ],
        durable_objects: {
          bindings: [
            {
              name: 'SYNC_DO',
              class_name: 'SyncularSmokeDurableObject',
            },
          ],
        },
        migrations: [
          {
            tag: 'v1',
            new_classes: ['SyncularSmokeDurableObject'],
          },
        ],
        r2_buckets: [
          {
            binding: 'BLOBS',
            bucket_name: 'syncular-framework-import-smoke',
          },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function linkSyncularWorkspacePackages(appDir: string): Promise<void> {
  await linkPackage(
    appDir,
    '@syncular/client',
    join(repoRoot, 'packages/client')
  );
  await linkPackage(appDir, '@syncular/core', join(repoRoot, 'packages/core'));
}

async function linkSyncularServerWorkspacePackages(
  appDir: string
): Promise<void> {
  await linkPackage(appDir, '@syncular/core', join(repoRoot, 'packages/core'));
  await linkPackage(
    appDir,
    '@syncular/server',
    join(repoRoot, 'packages/server')
  );
}

async function runNextRootImportSmoke(): Promise<void> {
  const appDir = join(workDir, 'next-root-imports');
  await mkdir(appDir, { recursive: true });
  await writeNextApp(appDir);

  await linkSyncularWorkspacePackages(appDir);
  await linkPackage(
    appDir,
    '@syncular/server',
    join(repoRoot, 'packages/server')
  );
  await linkPackage(appDir, 'next', workspaceDependencyPath('next'));
  await linkPackage(appDir, 'react', workspaceDependencyPath('react'));
  await linkPackage(appDir, 'react-dom', workspaceDependencyPath('react-dom'));

  await run(
    'node',
    [join(appDir, 'node_modules/next/dist/bin/next'), 'build', '--webpack'],
    {
      cwd: appDir,
      env: {
        NEXT_TELEMETRY_DISABLED: '1',
      },
    }
  );
  console.log('[framework-import-smokes] Next root import smoke passed');
}

async function runViteClientRootImportSmoke(): Promise<void> {
  const appDir = join(workDir, 'vite-client-root-imports');
  await mkdir(appDir, { recursive: true });
  await writeViteApp(appDir);

  await linkSyncularWorkspacePackages(appDir);
  await linkPackage(appDir, 'vite', workspaceDependencyPath('vite'));
  const viteBin = join(appDir, 'node_modules/vite/bin/vite.js');

  await run('node', [viteBin, 'build'], {
    cwd: appDir,
  });

  const bundleDir = join(appDir, 'dist/assets');
  const bundleNames = Array.from(
    new Bun.Glob('*.js').scanSync({ cwd: bundleDir })
  );
  for (const bundleName of bundleNames) {
    const bundle = await Bun.file(join(bundleDir, bundleName)).text();
    if (bundle.includes('data-syncular-vite-root-import')) {
      console.log('[framework-import-smokes] Vite root import smoke passed');
      await runVitePreviewRuntimeProbe({
        appDir,
        viteBin,
        bundlePath: `/assets/${bundleName}`,
        expectedText: 'data-syncular-vite-root-import',
      });
      console.log('[framework-import-smokes] Vite preview smoke passed');
      return;
    }
  }

  throw new Error(
    `Vite build did not contain the Syncular root import marker in ${bundleDir}`
  );
}

async function runCloudflareWorkerImportSmoke(): Promise<void> {
  const appDir = join(workDir, 'cloudflare-worker-root-imports');
  await mkdir(appDir, { recursive: true });
  await writeCloudflareWorkerApp(appDir);

  await linkSyncularServerWorkspacePackages(appDir);
  await linkPackage(appDir, 'hono', workspaceDependencyPath('hono'));
  await linkPackage(
    appDir,
    'hono-openapi',
    workspaceDependencyPath('hono-openapi')
  );
  await linkPackage(appDir, 'wrangler', workspaceDependencyPath('wrangler'));
  await linkPackage(appDir, 'zod', workspaceDependencyPath('zod'));
  const wranglerBin = join(appDir, 'node_modules/wrangler/bin/wrangler.js');

  const outDir = join(appDir, 'dist');
  await run(
    'node',
    [
      wranglerBin,
      'deploy',
      '--config',
      'wrangler.jsonc',
      '--dry-run',
      '--outdir',
      outDir,
    ],
    {
      cwd: appDir,
      env: {
        WRANGLER_SEND_METRICS: 'false',
      },
    }
  );

  const bundleNames = Array.from(
    new Bun.Glob('**/*.js').scanSync({ cwd: outDir })
  );
  for (const bundleName of bundleNames) {
    const bundle = await Bun.file(join(outDir, bundleName)).text();
    if (
      bundle.includes('syncular-cloudflare-runtime-schema-io-ready') &&
      bundle.includes('syncular-cloudflare-websocket-echo')
    ) {
      console.log(
        '[framework-import-smokes] Cloudflare DO/D1 schema+sync authz+realtime/R2 blob authz/WebSocket import smoke passed'
      );
      await runLocalWorkerRuntimeProbe({
        appDir,
        wranglerBin,
        route: '/syncular-framework-import-smoke',
        expectedText: 'syncular-cloudflare-runtime-schema-io-ready',
        blobRouteBase: '/syncular-framework-import-smoke/sync',
        syncRouteBase: '/syncular-framework-import-smoke/full-sync',
        webSocketRoute: '/syncular-framework-import-smoke/ws',
        webSocketMessage: 'syncular-cloudflare-websocket-ping',
        webSocketExpectedText:
          'syncular-cloudflare-websocket-echo:syncular-cloudflare-websocket-ping',
      });
      console.log(
        '[framework-import-smokes] Cloudflare DO/D1 schema+sync authz+realtime/R2 blob authz/WebSocket runtime IO smoke passed'
      );
      return;
    }
  }

  throw new Error(
    `Cloudflare dry-run build did not contain the Syncular root import marker in ${outDir}`
  );
}

async function main(): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
  try {
    await runNextRootImportSmoke();
    await runViteClientRootImportSmoke();
    await runCloudflareWorkerImportSmoke();
  } finally {
    if (!keep) {
      await rm(workDir, { recursive: true, force: true });
    } else {
      console.log(`[framework-import-smokes] keeping ${workDir}`);
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[framework-import-smokes] ${message}`);
  process.exitCode = 1;
}
