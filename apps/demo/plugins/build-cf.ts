/**
 * Cloudflare static asset builder.
 *
 * Builds the demo SPA and copies WASM assets into dist-cf/.
 * Used by wrangler via [build] command so `wrangler dev` and `wrangler deploy`
 * produce assets automatically — no separate build step needed.
 */

import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPgliteAssetPaths } from '@syncular/dialect-pglite';
import {
  getWaSqliteWasmPaths,
  getWaSqliteWorkerEntrypointPaths,
} from '@syncular/dialect-wa-sqlite';
import type { BunPlugin } from 'bun';
import tailwind from 'bun-plugin-tailwind';
import workspaceSource from './workspace-source';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist-cf');

// 1. Build SPA
const result = await Bun.build({
  entrypoints: [join(ROOT, 'index.html')],
  outdir: OUT,
  target: 'browser',
  minify: true,
  plugins: [tailwind as BunPlugin, workspaceSource],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`[build-cf] SPA: ${result.outputs.length} files`);

// 2. PGlite WASM
const pgliteDir = join(OUT, '__demo', 'pglite');
mkdirSync(pgliteDir, { recursive: true });
const { fsBundlePath, wasmPath } = getPgliteAssetPaths();
cpSync(fsBundlePath, join(pgliteDir, 'pglite.data'));
cpSync(wasmPath, join(pgliteDir, 'pglite.wasm'));

// 3. wa-sqlite worker + WASM
const wasqliteDir = join(OUT, '__demo', 'wasqlite');
mkdirSync(wasqliteDir, { recursive: true });

const { moduleWorkerPath } = getWaSqliteWorkerEntrypointPaths();
const workerBuild = await Bun.build({
  entrypoints: [moduleWorkerPath],
  outdir: wasqliteDir,
  target: 'browser',
  format: 'esm',
  splitting: true,
  sourcemap: 'inline',
  naming: {
    entry: 'worker.js',
    chunk: 'chunk-[hash].js',
    asset: 'asset-[hash].[ext]',
  },
});
if (!workerBuild.success) {
  for (const log of workerBuild.logs) console.error(log);
  process.exit(1);
}

const { asyncWasmPath, syncWasmPath } = getWaSqliteWasmPaths();
cpSync(asyncWasmPath, join(wasqliteDir, 'wa-sqlite-async.wasm'));
cpSync(syncWasmPath, join(wasqliteDir, 'wa-sqlite.wasm'));

// 4. CF _headers (COOP/COEP/CORP for SharedArrayBuffer/OPFS)
writeFileSync(
  join(OUT, '_headers'),
  `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: cross-origin
`
);

console.log('[build-cf] Done');
