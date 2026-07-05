/**
 * Bundle the React frontend to `dist/` — the `frontendDist` Tauri points at.
 *
 * Dependency-light on purpose: no Vite, no webpack. Bun's bundler transpiles
 * the TSX (automatic JSX runtime) and bundles React + react-dom + the syncular
 * packages from the workspace into one `dist/app.js`. `index.html` is copied
 * verbatim (it references `/app.js`).
 *
 * `@tauri-apps/api` is bundled too, so the `@syncular/tauri` bridge's
 * dynamic import of `@tauri-apps/api/core` + `/event` resolves inside the
 * webview without relying on the ambient `window.__TAURI__` global.
 *
 * Run: `bun run build-frontend` (from bindings/tauri/example).
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = import.meta.dir;
const frontend = join(root, 'src', 'frontend');
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });

const build = await Bun.build({
  entrypoints: [join(frontend, 'main.tsx')],
  outdir: dist,
  target: 'browser',
  minify: true,
  sourcemap: 'linked',
  naming: { entry: 'app.js' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error('frontend build failed');
}

// Copy the HTML shell alongside the bundle.
await Bun.write(
  join(dist, 'index.html'),
  await Bun.file(join(frontend, 'index.html')).text(),
);

console.log(`frontend built → ${dist} (app.js, index.html)`);
