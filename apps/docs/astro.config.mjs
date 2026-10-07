// Astro replaces the hand-rolled generator: markdown + Shiki highlighting
// (css-variables theme, colored by the teletype palette in src/docs.css),
// same URLs, still a fully static dist/. The site serves at the domain root,
// so authored links, the search index, and search result links are
// root-absolute.
import { satteri } from '@astrojs/markdown-satteri';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { reflectReleaseVersion } from './scripts/release-version.mjs';
import { docsComponents } from './src/markdown-components.ts';
import { SYQL_HIGHLIGHTER_LANGUAGES } from './src/syql-highlighting.ts';

export default defineConfig({
  site: 'https://syncular.dev',
  compressHTML: true,
  server: { port: 3100 },
  devToolbar: { enabled: false },
  // Every page runs under the client router; links prefetch their page on
  // hover so a navigation swaps in without waiting on the network.
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
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
      tailwindcss(),
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
    // Content components (callouts, steps, figures, tabs, …) are `:::`
    // directives handled by src/markdown-components.ts.
    processor: satteri({
      features: { directive: true },
      mdastPlugins: [docsComponents],
    }),
    shikiConfig: {
      theme: 'css-variables',
      langs: SYQL_HIGHLIGHTER_LANGUAGES,
    },
  },
  build: { format: 'directory' },
});
