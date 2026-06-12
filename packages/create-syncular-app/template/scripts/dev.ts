import { createServer as createViteServer, preview } from 'vite';
import { startSyncServer } from '../src/server/sync-server';

const previewMode = process.argv.includes('--preview');

const syncServer = await startSyncServer({
  port: Number(process.env.SYNC_PORT ?? 4100),
});

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

console.log(`[syncular] sync server listening at ${syncServer.origin}`);
await new Promise(() => {});
