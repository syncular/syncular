/**
 * Bundle the React frontend to `dist/` — the `frontendDist` the Tauri window
 * loads (`src-tauri/tauri.conf.json` runs this as `beforeDevCommand` /
 * `beforeBuildCommand`).
 *
 * Dependency-light on purpose: no Vite, no webpack. Bun's bundler transpiles
 * the TSX (automatic JSX runtime) and bundles React + the syncular packages
 * into one `dist/app.js`; `index.html` is copied verbatim (it references
 * `/app.js`). `@tauri-apps/api` is bundled too, so the `@syncular/tauri`
 * bridge's dynamic import resolves inside the webview.
 *
 * The web half never runs this — `src/server.ts` builds its own bundles at
 * startup (including the worker; the Tauri webview has no worker to build).
 *
 * Run: `bun run build-frontend`.
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = import.meta.dir;
const frontend = join(root, 'src', 'frontend');
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const build = await Bun.build({
  entrypoints: [join(frontend, 'main.tsx')],
  outdir: dist,
  target: 'browser',
  // Workspace packages resolve their `bun` condition (TS source) so the
  // build works without a compiled dist (the published `browser` condition
  // points at compiled output for external bundlers).
  conditions: ['bun'],
  minify: true,
  sourcemap: 'linked',
  naming: { entry: 'app.js' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error('frontend build failed');
}

await copyFile(join(frontend, 'index.html'), join(dist, 'index.html'));
console.log(`frontend built → ${dist}`);
