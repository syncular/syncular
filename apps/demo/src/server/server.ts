/**
 * @syncular/demo-app - Production server entry
 *
 * Serves prebuilt demo frontend assets from `dist-client` and API routes from Hono.
 */

import { getPgliteAssetPaths } from '@syncular/dialect-pglite';
import {
  getWaSqliteWasmPaths,
  getWaSqliteWorkerEntrypointPaths,
} from '@syncular/dialect-wa-sqlite';
import type { BuildArtifact } from 'bun';
import { serve } from 'bun';
import { createBunWebSocket } from 'hono/bun';
import indexHtml from '../../index.html';
import { createDemoApp } from './app';

async function main() {
  const portRaw = process.env.PORT;
  const portParsed = portRaw ? Number(portRaw) : Number.NaN;
  const port = Number.isFinite(portParsed) ? portParsed : 9811;
  const consoleToken = process.env.SYNC_CONSOLE_TOKEN ?? 'demo-token';

  const { moduleWorkerPath } = getWaSqliteWorkerEntrypointPaths();
  const wasqliteAssets = await buildWasqliteWorkerAssets(moduleWorkerPath);

  const { asyncWasmPath, syncWasmPath } = getWaSqliteWasmPaths();
  const wasqliteAsyncWasm = Bun.file(asyncWasmPath);
  const wasqliteSyncWasm = Bun.file(syncWasmPath);

  const { fsBundlePath, wasmPath } = getPgliteAssetPaths();
  const pgliteFsBundle = Bun.file(fsBundlePath);
  const pgliteWasm = Bun.file(wasmPath);

  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const { app } = await createDemoApp({
    consoleToken,
    upgradeWebSocket,
  });

  type HonoEnv = { server: ReturnType<typeof serve> };
  let server: ReturnType<typeof serve> | null = null;

  function fetchHono(req: Request): Response | Promise<Response> {
    if (!server) return new Response('Server not ready', { status: 503 });
    return app.fetch(req, { server } satisfies HonoEnv);
  }

  server = serve({
    port,
    development: false,
    websocket,
    routes: {
      '/api/*': (req) => fetchHono(req as Request),
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
      '/*': indexHtml,
    },
    fetch() {
      return new Response('Not found', { status: 404 });
    },
  });

  console.log(`Demo app:   ${server.url}`);
  console.log(
    `Console UI: ${new URL(`/console/?server=${encodeURIComponent(`${server.url}api`)}&token=${encodeURIComponent(consoleToken)}`, server.url)}`
  );
  console.log('  (Console is now built-in — no separate build step needed)');
}

await main();

function responseForBuildArtifact(artifact: BuildArtifact): Response {
  const headers = new Headers();
  const contentType = contentTypeFromLoader(artifact.loader);
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-cache');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-embedder-policy', 'require-corp');
  headers.set('cross-origin-resource-policy', 'cross-origin');
  if (artifact.hash) headers.set('etag', artifact.hash);
  return new Response(artifact, { status: 200, headers });
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
    splitting: true,
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

  const assets = new Map<string, BuildArtifact>();
  for (const output of result.outputs) {
    const name = output.path.split('/').at(-1);
    if (!name) continue;
    assets.set(name, output);
  }

  return assets;
}
