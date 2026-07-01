#!/usr/bin/env bun
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';

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
  appDir: string;
  wranglerBin: string;
  route: string;
  expectedText: string;
}): Promise<void> {
  const port = await getFreePort();
  const output: string[] = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  const child = spawn(
    'node',
    [
      args.wranglerBin,
      'dev',
      'src/worker.ts',
      '--local',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--name',
      'syncular-framework-import-smoke',
      '--compatibility-date',
      '2026-01-01',
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
      label: 'Cloudflare Worker runtime smoke',
      url: `http://127.0.0.1:${port}${args.route}`,
      expectedText: args.expectedText,
      output,
      getExit: () => exited,
    });
  } finally {
    await stopProcess(child);
  }
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
  await writeFile(
    path,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        reason,
        probe,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
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

async function fetchTextWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.text();
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
          hono: 'workspace:*',
          wrangler: 'workspace:*',
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
  SyncDurableObject,
  createSyncWorker,
} from '@syncular/server/cloudflare';

type Env = Record<string, never>;

export class SyncularSmokeDurableObject extends SyncDurableObject<Env> {
  setup() {}
}

export default createSyncWorker<Env>((app) => {
  app.get('/syncular-framework-import-smoke', (c) =>
    c.text('syncular-cloudflare-root-import-ready')
  );
});
`,
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
  await linkPackage(appDir, 'wrangler', workspaceDependencyPath('wrangler'));
  const wranglerBin = join(appDir, 'node_modules/wrangler/bin/wrangler.js');

  const outDir = join(appDir, 'dist');
  await run(
    'node',
    [
      wranglerBin,
      'deploy',
      'src/worker.ts',
      '--dry-run',
      '--outdir',
      outDir,
      '--name',
      'syncular-framework-import-smoke',
      '--compatibility-date',
      '2026-01-01',
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
    if (bundle.includes('syncular-cloudflare-root-import-ready')) {
      console.log(
        '[framework-import-smokes] Cloudflare Worker root import smoke passed'
      );
      await runLocalWorkerRuntimeProbe({
        appDir,
        wranglerBin,
        route: '/syncular-framework-import-smoke',
        expectedText: 'syncular-cloudflare-root-import-ready',
      });
      console.log(
        '[framework-import-smokes] Cloudflare Worker runtime smoke passed'
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
