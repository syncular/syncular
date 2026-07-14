/**
 * Static demo build: the backend-free bundle published at demo.syncular.dev.
 * Emits `dist/` — index.html, app.js (the page, with the embedded flag
 * baked in), server-worker.js (the WHOLE sync server, running in a Web
 * Worker over sqlite-wasm wearing the D1 shape), and the sqlite-wasm
 * vendor files. Cloudflare serves it as plain static assets; there is no
 * server-side compute anywhere.
 *
 * Two bundler tricks, both also used by the dev server (`src/server.ts`):
 * - `@sqlite.org/sqlite-wasm` stays external and its bare specifier is
 *   rewritten to the served vendor path (module workers do not inherit the
 *   page's import map, so a rewrite beats an import map);
 * - `bun:sqlite` is stubbed out: `@syncular/server`'s index exports the
 *   Bun-specific sqlite stores, which the embedded server never
 *   instantiates (it runs `D1ServerStorage`), but a browser bundle still
 *   has to resolve the import.
 */
import { dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';
import rootPackage from '../../../package.json';

const appDir = join(import.meta.dir, '..');
const frontendDir = join(appDir, 'src', 'frontend');
const outDir = join(appDir, 'dist');

function reflectReleaseVersion(text: string): string {
  if (text.split('0.0.0').length - 1 !== 1) {
    throw new Error('demo index must contain exactly one 0.0.0 placeholder');
  }
  return text.replace('0.0.0', rootPackage.version);
}

const bunSqliteStub: BunPlugin = {
  name: 'bun-sqlite-stub',
  setup(build) {
    build.onResolve({ filter: /^bun:sqlite$/ }, () => ({
      path: 'bun-sqlite-stub',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export class Database {
  constructor() {
    throw new Error('bun:sqlite is unavailable in the browser (the embedded demo runs D1ServerStorage over sqlite-wasm)');
  }
}
`,
      loader: 'js',
    }));
  },
};

const build = await Bun.build({
  entrypoints: [
    join(frontendDir, 'main.ts'),
    join(frontendDir, 'server-worker.ts'),
  ],
  target: 'browser',
  // Workspace packages resolve their `bun` condition (TS source) so the
  // build works without `build:packages` (the published `browser`
  // condition points at compiled dist, RFC 0002 §1.1).
  conditions: ['bun'],
  minify: true,
  define: { SYNCULAR_DEMO_EMBEDDED: 'true' },
  external: ['@sqlite.org/sqlite-wasm'],
  plugins: [bunSqliteStub],
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error('static demo build failed');
}

async function bundleText(basename: string): Promise<string> {
  const artifact = build.outputs.find((output) =>
    output.path.endsWith(`/${basename}`),
  );
  if (artifact === undefined) {
    throw new Error(`static build produced no ${basename}`);
  }
  // Same rewrite as the dev server: the external bare specifier becomes the
  // served vendor path, valid in both the page and the module worker.
  const text = await artifact.text();
  return text.replaceAll(
    /(["'])@sqlite\.org\/sqlite-wasm\1/g,
    '"/vendor/sqlite-wasm/index.mjs"',
  );
}

const wasmDir = dirname(
  Bun.resolveSync('@sqlite.org/sqlite-wasm', import.meta.dir),
);
/** Only the files the sqlite-wasm ESM entry actually references. */
const WASM_FILES = [
  'index.mjs',
  'sqlite3.wasm',
  'sqlite3-opfs-async-proxy.js',
  'sqlite3-worker1.mjs',
];

import { mkdir, rm } from 'node:fs/promises';

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'vendor', 'sqlite-wasm'), { recursive: true });

await Bun.write(join(outDir, 'app.js'), await bundleText('main.js'));
await Bun.write(
  join(outDir, 'server-worker.js'),
  await bundleText('server-worker.js'),
);
await Bun.write(
  join(outDir, 'index.html'),
  reflectReleaseVersion(await Bun.file(join(frontendDir, 'index.html')).text()),
);
await Bun.write(
  join(outDir, 'version.json'),
  `${JSON.stringify({ version: rootPackage.version }, null, 2)}\n`,
);
for (const name of WASM_FILES) {
  await Bun.write(
    join(outDir, 'vendor', 'sqlite-wasm', name),
    Bun.file(join(wasmDir, name)),
  );
}

console.log(`static demo built → ${outDir}`);
