import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

const require = createRequire(import.meta.url);
const syncularClientRoot = dirname(
  require.resolve('@syncular/client/package.json')
);
const syncularClientDistDir = join(syncularClientRoot, 'dist');
const syncularCoreRuntimeDir = join(syncularClientRoot, 'dist', 'wasm-core');
const syncularRuntimeMountPath = '/syncular/wasm-core/';
const syncularClientRuntimeMountPath = '/syncular/client/';
const syncularClientRuntimeDirs = ['', 'wasm-bindings'] as const;
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
      await Promise.all([
        cp(
          syncularCoreRuntimeDir,
          resolve(root, outDir, 'syncular', 'wasm-core'),
          { recursive: true }
        ),
        copySyncularClientRuntimeAssets(
          resolve(root, outDir, 'syncular', 'client')
        ),
      ]);
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
  const asset =
    resolveSyncularRuntimeRequest(requestUrl) ??
    resolveSyncularClientRuntimeRequest(requestUrl);
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

function resolveSyncularClientRuntimeRequest(requestUrl: string | undefined) {
  if (!requestUrl) return null;
  const pathname = new URL(requestUrl, 'http://syncular.local').pathname;
  if (!pathname.startsWith(syncularClientRuntimeMountPath)) return null;
  const fileName = pathname.slice(syncularClientRuntimeMountPath.length);
  if (!/^(?:[a-z0-9-]+|wasm-bindings\/[a-z0-9-]+)\.js$/i.test(fileName)) {
    return null;
  }
  return {
    contentType: 'text/javascript; charset=utf-8',
    dir: syncularClientDistDir,
    fileName,
  };
}

async function copySyncularClientRuntimeAssets(targetDir: string) {
  await Promise.all(
    syncularClientRuntimeDirs.map(async (runtimeDir) => {
      const sourceDir = join(syncularClientDistDir, runtimeDir);
      const outputDir = join(targetDir, runtimeDir);
      await mkdir(outputDir, { recursive: true });
      const entries = await readdir(sourceDir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
          .map((entry) =>
            cp(join(sourceDir, entry.name), join(outputDir, entry.name))
          )
      );
    })
  );
}

export default defineConfig({
  plugins: [syncularRuntimeAssets()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
});
