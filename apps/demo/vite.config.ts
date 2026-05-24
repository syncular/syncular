import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    fs: {
      allow: [path.resolve(__dirname, '../..')],
    },
  },
});
