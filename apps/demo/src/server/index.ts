/**
 * @syncular/demo-app - Unified dev server
 *
 * Serves everything from a single Bun dev server:
 * - `/` and frontend routes → Demo React app (via Bun's bundler)
 * - `/console/*` → Console UI (built-in via TanStack Router)
 * - `/api/*` → Disabled (API is provided by the Service Worker server)
 * - `/__demo/*` → WASM assets (pglite, wa-sqlite)
 */
import { getPgliteAssetPaths } from '@syncular/dialect-pglite';
import {
  getWaSqliteWasmPaths,
  getWaSqliteWorkerEntrypointPaths,
} from '@syncular/dialect-wa-sqlite';
import type { BuildArtifact } from 'bun';
import { serve } from 'bun';
// Import HTML file - Bun will bundle this as a frontend app
import demoApp from '../../index.html';

async function main() {
  const portRaw = process.env.PORT;
  const portParsed = portRaw ? Number(portRaw) : Number.NaN;
  const preferredPort = Number.isFinite(portParsed) ? portParsed : 9811;

  const consoleToken = process.env.SYNC_CONSOLE_TOKEN ?? 'demo-token';

  const { moduleWorkerPath } = getWaSqliteWorkerEntrypointPaths();
  const wasqliteAssets = await buildWasqliteWorkerAssets(moduleWorkerPath);
  const swServerAsset = await buildServiceWorkerServerAsset(
    new URL('../sw/server.ts', import.meta.url).pathname
  );

  const { asyncWasmPath, syncWasmPath } = getWaSqliteWasmPaths();
  const wasqliteAsyncWasm = Bun.file(asyncWasmPath);
  const wasqliteSyncWasm = Bun.file(syncWasmPath);

  const { fsBundlePath, wasmPath } = getPgliteAssetPaths();
  const pgliteFsBundle = Bun.file(fsBundlePath);
  const pgliteWasm = Bun.file(wasmPath);

  const createServer = (port: number) =>
    serve({
      port,
      development: {
        hmr: true,
        console: true,
      },
      routes: {
        // API is intentionally disabled in network server mode.
        // Browser clients must use the Service Worker server path.
        '/api/health': () => responseForHealth(),
        '/api/*': () => responseForDisabledApi(),

        // WASM/Worker assets
        '/__demo/pglite/pglite.data': () =>
          responseForFile(pgliteFsBundle, 'application/octet-stream'),
        '/__demo/pglite/pglite.wasm': () =>
          responseForFile(pgliteWasm, 'application/wasm'),
        '/__demo/wasqlite/wa-sqlite-async.wasm': () =>
          responseForFile(wasqliteAsyncWasm, 'application/wasm'),
        '/__demo/wasqlite/wa-sqlite.wasm': () =>
          responseForFile(wasqliteSyncWasm, 'application/wasm'),
        '/__demo/wasqlite/*': (req) => {
          const url = new URL(req.url);
          const name = url.pathname.slice('/__demo/wasqlite/'.length);
          const asset = wasqliteAssets.get(name);
          if (!asset) return new Response('Not found', { status: 404 });
          return responseForBuildArtifact(asset);
        },
        '/__demo/sw-server.js': () =>
          responseForServiceWorkerScript(swServerAsset),

        // Demo React app - catch-all for SPA
        '/*': demoApp,
      },
      fetch() {
        return new Response('Not found', { status: 404 });
      },
    });

  let server: ReturnType<typeof serve>;
  try {
    server = createServer(preferredPort);
  } catch (error) {
    if (
      preferredPort === 9811 &&
      (!portRaw || !Number.isFinite(portParsed)) &&
      isAddressInUseError(error)
    ) {
      server = createServer(0);
      const fallbackPort = new URL(server.url).port;
      console.warn(
        `[demo] Port 9811 is already in use; started on port ${fallbackPort}. Set PORT to override.`
      );
    } else {
      throw error;
    }
  }

  console.log(`Demo app:   ${server.url}`);
  console.log(
    `Console UI: ${new URL(`/console/?server=${encodeURIComponent(`${server.url}api`)}&token=${encodeURIComponent(consoleToken)}`, server.url)}`
  );
  console.log('  (Console is now built-in — no separate build step needed)');
}

await main();

function isAddressInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const withCode = error as Error & { code?: string };
  return withCode.code === 'EADDRINUSE';
}

function responseForBuildArtifact(artifact: BuildArtifact): Response {
  const headers = new Headers();
  const contentType = contentTypeFromLoader(artifact.loader);
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-cache');
  // Vite serves the HTML with COOP/COEP headers, but the `/__demo/*` assets are
  // proxied from this Bun server. Chromium enforces COEP on module workers and
  // will block them with `net::ERR_BLOCKED_BY_RESPONSE` unless these headers
  // are present on the worker + its imported chunks.
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-embedder-policy', 'require-corp');
  headers.set('cross-origin-resource-policy', 'cross-origin');
  if (artifact.hash) headers.set('etag', artifact.hash);
  return new Response(artifact, { status: 200, headers });
}

function responseForServiceWorkerScript(artifact: BuildArtifact): Response {
  const response = responseForBuildArtifact(artifact);
  response.headers.set('service-worker-allowed', '/');
  return response;
}

function responseForDisabledApi(): Response {
  return new Response(
    JSON.stringify({
      error: 'Demo API server is disabled. Service Worker server is required.',
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    }
  );
}

function responseForHealth(): Response {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

type BunFileLike = ReturnType<typeof Bun.file>;

function responseForFile(file: BunFileLike, contentType: string): Response {
  const headers = new Headers();
  headers.set('content-type', contentType);
  headers.set('cache-control', 'no-cache');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-embedder-policy', 'require-corp');
  headers.set('cross-origin-resource-policy', 'cross-origin');
  return new Response(file, { status: 200, headers });
}

function contentTypeFromLoader(loader: BuildArtifact['loader']): string | null {
  switch (loader) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return 'text/javascript; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'html':
      return 'text/html; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'wasm':
      return 'application/wasm';
    default:
      return null;
  }
}

async function buildWasqliteWorkerAssets(
  entrypointPath: string
): Promise<Map<string, BuildArtifact>> {
  const result = await Bun.build({
    entrypoints: [entrypointPath],
    target: 'browser',
    format: 'esm',
    splitting: false,
    sourcemap: 'inline',
    publicPath: '/__demo/wasqlite/',
    naming: {
      entry: 'worker.js',
      chunk: 'chunk-[hash].js',
      asset: 'asset-[hash].[ext]',
    },
  });

  if (!result.success) {
    const message = result.logs.at(0)?.message ?? 'unknown bundler error';
    throw new Error(`[demo] Failed to bundle wa-sqlite worker: ${message}`);
  }

  assertSingleWorkerBundle(
    result.outputs.map((output) => output.path),
    'demo-dev'
  );

  const assets = new Map<string, BuildArtifact>();
  for (const output of result.outputs) {
    const name = output.path.split('/').at(-1);
    if (!name) continue;
    assets.set(name, output);
  }

  return assets;
}

async function buildServiceWorkerServerAsset(
  entrypointPath: string
): Promise<BuildArtifact> {
  const result = await Bun.build({
    entrypoints: [entrypointPath],
    target: 'browser',
    format: 'esm',
    splitting: false,
    conditions: ['bun'],
    naming: {
      entry: 'sw-server.js',
      chunk: 'chunk-[hash].js',
      asset: 'asset-[hash].[ext]',
    },
  });

  if (!result.success) {
    const message = result.logs.at(0)?.message ?? 'unknown bundler error';
    throw new Error(
      `[demo] Failed to bundle service worker server: ${message}`
    );
  }

  const swBundle = result.outputs.find((output) =>
    output.path.endsWith('/sw-server.js')
  );
  if (!swBundle) {
    throw new Error('[demo] Missing service worker server bundle output');
  }

  return swBundle;
}

function assertSingleWorkerBundle(
  outputPaths: readonly string[],
  buildContext: string
): void {
  const outputNames = outputPaths
    .map((outputPath) => outputPath.split('/').at(-1))
    .filter((name): name is string => Boolean(name));
  const extraOutputs = outputNames.filter((name) => name !== 'worker.js');

  if (extraOutputs.length === 0) return;

  throw new Error(
    `[${buildContext}] wa-sqlite worker build produced split artifacts (${extraOutputs.join(', ')}). ` +
      'This can trigger Bun ESM duplicate-export crashes in module workers. Keep worker bundling unsplit.'
  );
}
