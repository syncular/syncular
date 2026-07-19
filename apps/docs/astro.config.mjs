// Astro replaces the hand-rolled generator: markdown + Shiki highlighting
// (css-variables theme, colored by the teletype palette in public/style.css),
// same URLs, still a fully static dist/. Subpath deploys (GitHub Pages
// project site) are handled by the post-build rebase step (see package.json
// build script + scripts/rebase.mjs), not Astro's `base`, so authored links
// stay root-absolute exactly as before.
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { reflectReleaseVersion } from './scripts/release-version.mjs';
import { SYQL_HIGHLIGHTER_LANGUAGES } from './src/syql-highlighting.ts';

export default defineConfig({
  site: 'https://syncular.dev',
  server: { port: 3100 },
  devToolbar: { enabled: false },
  vite: {
    resolve: {
      alias: {
        '@syncular/typegen/syql-browser': fileURLToPath(
          new URL(
            '../../packages/typegen/src/syql-browser.ts',
            import.meta.url,
          ),
        ),
      },
    },
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
    plugins: [
      {
        name: 'syncular-release-version-in-markdown',
        enforce: 'pre',
        transform(code, id) {
          const path = id.split('?', 1)[0];
          if (path?.includes('/src/content/') && path.endsWith('.md')) {
            return reflectReleaseVersion(code);
          }
        },
      },
    ],
  },
  markdown: {
    shikiConfig: {
      theme: 'css-variables',
      langs: SYQL_HIGHLIGHTER_LANGUAGES,
    },
  },
  build: { format: 'directory' },
});
