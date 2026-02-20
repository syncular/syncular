import { configureServiceWorkerServer } from '@syncular/server-service-worker';

const SW_SERVER_SCRIPT_PATH = '/__demo/sw-server.js';
const SW_HEALTH_PATH = '/__demo/sw-health';

export async function configureDemoServiceWorkerServer(): Promise<boolean> {
  const ready = await configureServiceWorkerServer({
    enabled: true,
    scriptPath: SW_SERVER_SCRIPT_PATH,
    scope: '/',
    healthPath: SW_HEALTH_PATH,
    healthTimeoutMs: 60_000,
    logger: console,
  });

  if (ready) {
    console.info(
      '[demo] Service Worker server enabled. API requests now resolve from browser-local SQLite.'
    );
  }

  return ready;
}
