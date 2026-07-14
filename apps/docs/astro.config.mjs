// Astro replaces the hand-rolled generator: markdown + Shiki highlighting
// (css-variables theme, colored by the teletype palette in public/style.css),
// same URLs, still a fully static dist/. Subpath deploys (GitHub Pages
// project site) are handled by the post-build rebase step (see package.json
// build script + scripts/rebase.mjs), not Astro's `base`, so authored links
// stay root-absolute exactly as before.
import { defineConfig } from 'astro/config';
import sqlGrammar from '@shikijs/langs/sql';
import { reflectReleaseVersion } from './scripts/release-version.mjs';
import syqlGrammar from '../../editors/vscode-syql/syntaxes/syql.tmLanguage.json' with {
  type: 'json',
};

export default defineConfig({
  server: { port: 3100 },
  devToolbar: { enabled: false },
  vite: {
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
      langs: [
        ...sqlGrammar,
        {
          ...syqlGrammar,
          name: 'syql',
          embeddedLangs: ['sql'],
        },
      ],
    },
  },
  build: { format: 'directory' },
});
