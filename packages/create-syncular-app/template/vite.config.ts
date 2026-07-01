import { cp, readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

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
      installSyncularRuntimeMiddleware(server);
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

function installSyncularRuntimeMiddleware(server: ViteDevServer) {
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

function resolveSyncularRuntimeRequest(requestUrl: string | undefined) {
  if (!requestUrl) return null;
  const pathname = new URL(requestUrl, 'http://syncular.local').pathname;
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
