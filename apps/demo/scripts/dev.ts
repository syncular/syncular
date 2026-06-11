import { existsSync } from 'node:fs';
import path from 'node:path';
import { $ } from 'bun';
import { createServer as createViteServer, preview } from 'vite';
import { startDemoSyncServer } from '../src/server/sync-server';

const previewMode = process.argv.includes('--preview');
const repoRoot = path.resolve(import.meta.dir, '../../..');

async function ensureBrowserWasmArtifact() {
  const javascriptBindingsDir = path.join(repoRoot, 'rust/bindings/javascript');
  const wasmPath = path.join(
    javascriptBindingsDir,
    'dist/wasm/syncular_bg.wasm'
  );

  if (existsSync(wasmPath)) {
    return;
  }

  console.log('[syncular-demo] building Rust browser WASM artifact');
  await $`bun --cwd ${javascriptBindingsDir} build:wasm`;
}

await ensureBrowserWasmArtifact();
const syncServer = await startDemoSyncServer({ port: 4101 });

async function stop() {
  await syncServer.close();
}

process.on('SIGINT', () => {
  void stop().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void stop().finally(() => process.exit(0));
});

if (previewMode) {
  const previewServer = await preview({
    preview: {
      host: '127.0.0.1',
      port: 4173,
    },
  });
  previewServer.printUrls();
} else {
  const vite = await createViteServer({
    server: {
      host: '127.0.0.1',
      port: Number(process.env.PORT ?? 5173),
      strictPort: false,
    },
  });
  await vite.listen();
  vite.printUrls();
}

console.log(`[syncular-demo] sync server listening at ${syncServer.origin}`);
await new Promise(() => {});
