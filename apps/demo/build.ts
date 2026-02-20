/**
 * Demo static asset builder.
 *
 * Builds the demo SPA and copies runtime WASM/worker assets into `dist/`.
 */

import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { getPgliteAssetPaths } from '@syncular/dialect-pglite';
import {
  getWaSqliteWasmPaths,
  getWaSqliteWorkerEntrypointPaths,
} from '@syncular/dialect-wa-sqlite';
import type { BunPlugin } from 'bun';
import tailwind from 'bun-plugin-tailwind';

const ROOT = resolve(import.meta.dirname);
const OUT = join(ROOT, 'dist');

// 1. Build SPA
const result = await Bun.build({
  entrypoints: [join(ROOT, 'index.html')],
  outdir: OUT,
  target: 'browser',
  minify: true,
  sourcemap: 'linked',
  plugins: [tailwind as BunPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`[build] SPA: ${result.outputs.length} files`);

stampSentryMetaTags(join(OUT, 'index.html'));
writeCloudflareHeaders(join(OUT, '_headers'));

// 2. Favicon assets (copied as-is, referenced via absolute paths in HTML)
const faviconDir = resolve(ROOT, '../../assets/favicon');
for (const file of readdirSync(faviconDir)) {
  cpSync(join(faviconDir, file), join(OUT, file));
}

// 3. PGlite WASM
const pgliteDir = join(OUT, '__demo', 'pglite');
mkdirSync(pgliteDir, { recursive: true });
const { fsBundlePath, wasmPath } = getPgliteAssetPaths();
cpSync(fsBundlePath, join(pgliteDir, 'pglite.data'));
cpSync(wasmPath, join(pgliteDir, 'pglite.wasm'));

// 4. wa-sqlite worker + WASM
const wasqliteDir = join(OUT, '__demo', 'wasqlite');
mkdirSync(wasqliteDir, { recursive: true });

const { moduleWorkerPath } = getWaSqliteWorkerEntrypointPaths();
const workerBuild = await Bun.build({
  entrypoints: [moduleWorkerPath],
  outdir: wasqliteDir,
  target: 'browser',
  format: 'esm',
  splitting: false,
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
assertSingleNamedBundle(
  workerBuild.outputs.map((output) => output.path),
  'build',
  'worker.js'
);

const { asyncWasmPath, syncWasmPath } = getWaSqliteWasmPaths();
cpSync(asyncWasmPath, join(wasqliteDir, 'wa-sqlite-async.wasm'));
cpSync(syncWasmPath, join(wasqliteDir, 'wa-sqlite.wasm'));

// 5. Service worker server script
const demoAssetsDir = join(OUT, '__demo');
mkdirSync(demoAssetsDir, { recursive: true });
const swServerBuild = await Bun.build({
  entrypoints: [join(ROOT, 'src', 'sw', 'server.ts')],
  outdir: demoAssetsDir,
  target: 'browser',
  format: 'esm',
  splitting: false,
  minify: true,
  conditions: ['bun'],
  naming: {
    entry: 'sw-server.js',
    chunk: 'chunk-[hash].js',
    asset: 'asset-[hash].[ext]',
  },
});
if (!swServerBuild.success) {
  for (const log of swServerBuild.logs) console.error(log);
  process.exit(1);
}
assertSingleNamedBundle(
  swServerBuild.outputs.map((output) => output.path),
  'build',
  'sw-server.js'
);

console.log('[build] Done');

function stampSentryMetaTags(indexPath: string): void {
  const replacements = [
    {
      name: 'syncular-sentry-dsn',
      value: process.env.SYNCULAR_SENTRY_DSN ?? '',
    },
    {
      name: 'syncular-sentry-environment',
      value: process.env.SYNCULAR_SENTRY_ENVIRONMENT ?? '',
    },
    {
      name: 'syncular-sentry-release',
      value: process.env.SYNCULAR_SENTRY_RELEASE ?? '',
    },
  ];

  let html = readFileSync(indexPath, 'utf8');
  for (const replacement of replacements) {
    const escapedValue = replacement.value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;');
    const pattern = new RegExp(
      `<meta name="${replacement.name}" content="[^"]*"\\s*/?>`
    );
    html = html.replace(
      pattern,
      `<meta name="${replacement.name}" content="${escapedValue}" />`
    );
  }
  writeFileSync(indexPath, html);
}

function writeCloudflareHeaders(headersPath: string): void {
  const headers = [
    '/*',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cross-Origin-Embedder-Policy: require-corp',
    '  Cross-Origin-Resource-Policy: cross-origin',
    '',
    '/__demo/sw-server.js',
    '  Service-Worker-Allowed: /',
    '',
  ].join('\n');

  writeFileSync(headersPath, headers);
}

function assertSingleNamedBundle(
  outputPaths: readonly string[],
  buildContext: string,
  expectedEntry: string
): void {
  const outputNames = outputPaths
    .map((outputPath) => outputPath.split('/').at(-1))
    .filter((name): name is string => Boolean(name));
  const extraOutputs = outputNames.filter((name) => name !== expectedEntry);

  if (extraOutputs.length === 0) return;

  throw new Error(
    `[${buildContext}] ${expectedEntry} build produced unexpected artifacts (${extraOutputs.join(', ')}). ` +
      'Keep this bundle unsplit.'
  );
}
