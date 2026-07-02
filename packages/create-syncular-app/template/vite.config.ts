import { cp, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const require = createRequire(import.meta.url);
const syncularClientRoot = dirname(
  require.resolve('@syncular/client/package.json')
);
const syncularCoreRuntimeDir = join(syncularClientRoot, 'dist', 'wasm-core');
const syncularRuntimeMountPath = '/syncular/wasm-core/';
const syncularRuntimeContentTypes = new Map([
  ['syncular.js', 'text/javascript; charset=utf-8'],
  ['syncular_bg.wasm', 'application/wasm'],
]);
const syncularSmokeClearSiteDataPath = '/__syncular-smoke/clear-site-data';

type SyncularMiddlewareStack = {
  use(handler: SyncularMiddlewareHandler): void;
};

type SyncularMiddlewareServer = {
  middlewares: SyncularMiddlewareStack;
};

type SyncularMiddlewareHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void
) => void;

function syncularRuntimeAssets(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';

  return {
    name: 'syncular-runtime-assets',
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
    },
    configureServer(server) {
      installSyncularMiddlewares(server);
    },
    configurePreviewServer(server) {
      installSyncularMiddlewares(server);
    },
    async closeBundle() {
      await cp(
        syncularCoreRuntimeDir,
        resolve(root, outDir, 'syncular', 'wasm-core'),
        { recursive: true }
      );
    },
  };
}

function installSyncularMiddlewares(server: SyncularMiddlewareServer) {
  installSyncularSmokeMiddleware(server);
  installSyncularRuntimeMiddleware(server);
}

function installSyncularSmokeMiddleware(server: SyncularMiddlewareServer) {
  if (process.env.SYNCULAR_STARTER_SMOKE_FAILPOINTS !== '1') return;

  server.middlewares.use((request, response, next) => {
    const pathname = resolveRequestPathname(request.url);
    if (pathname !== syncularSmokeClearSiteDataPath) {
      next();
      return;
    }

    response.statusCode = 200;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('clear-site-data', '"storage"');
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('syncular smoke storage clear requested\n');
  });
}

function installSyncularRuntimeMiddleware(server: SyncularMiddlewareServer) {
  server.middlewares.use((request, response, next) => {
    void serveSyncularRuntimeAsset(request.url, response)
      .then((served) => {
        if (!served) next();
      })
      .catch(next);
  });
}

async function serveSyncularRuntimeAsset(
  requestUrl: string | undefined,
  response: ServerResponse
) {
  const asset = resolveSyncularRuntimeRequest(requestUrl);
  if (!asset) return false;

  const body = await readFile(join(asset.dir, asset.fileName));
  response.statusCode = 200;
  response.setHeader('content-type', asset.contentType);
  response.end(body);
  return true;
}

function resolveRequestPathname(requestUrl: string | undefined): string | null {
  if (!requestUrl) return null;
  return new URL(requestUrl, 'http://syncular.local').pathname;
}

function resolveSyncularRuntimeRequest(requestUrl: string | undefined) {
  const pathname = resolveRequestPathname(requestUrl);
  if (!pathname) return null;
  if (!pathname.startsWith(syncularRuntimeMountPath)) return null;
  const fileName = pathname.slice(syncularRuntimeMountPath.length);
  const contentType = syncularRuntimeContentTypes.get(fileName);
  return contentType
    ? { contentType, dir: syncularCoreRuntimeDir, fileName }
    : null;
}

export default defineConfig({
  plugins: [syncularRuntimeAssets()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
});
