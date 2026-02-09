import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function normalizeViteBase(base: string | undefined): string {
  const value = base?.trim();
  if (!value) return '/';
  if (value === './' || value === '.') return './';
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.endsWith('/')
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

export default defineConfig(({ command }) => {
  // Default behavior:
  // - dev server: `/` (normal)
  // - build: `./` so the output can be hosted under any path prefix
  const base =
    command === 'serve'
      ? '/'
      : normalizeViteBase(process.env.SYNCULAR_CONSOLE_BASE ?? './');

  return {
    base,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    server: {
      port: 9812,
    },
    build: {
      target: 'esnext',
    },
  };
});
