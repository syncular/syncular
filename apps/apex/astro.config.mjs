import { fileURLToPath } from 'node:url';
import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

const syncularUiSource = fileURLToPath(
  new URL('../../packages/ui/src', import.meta.url)
);
const syncularUiDist = fileURLToPath(
  new URL('../../packages/ui/dist', import.meta.url)
);

export default defineConfig({
  site: 'https://syncular.dev',
  output: 'static',
  build: {
    assets: '_astro',
  },
  image: {
    remotePatterns: [],
  },
  integrations: [react()],
  vite: {
    resolve: {
      alias: [
        {
          find: 'syncular/ui/observable-universe',
          replacement: `${syncularUiSource}/observable-universe/index.ts`,
        },
        {
          find: 'syncular/ui/styles.css',
          replacement: `${syncularUiDist}/styles.css`,
        },
      ],
    },
  },
});
