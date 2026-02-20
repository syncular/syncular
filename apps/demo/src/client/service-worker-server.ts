import { configureServiceWorkerServer } from '@syncular/server-service-worker';

const SW_SERVER_SCRIPT_PATH = '/__demo/sw-server.js';
const SW_HEALTH_PATH = '/api/health';

export async function configureDemoServiceWorkerServer(): Promise<boolean> {
  const ready = await configureServiceWorkerServer({
    enabled: true,
    scriptPath: SW_SERVER_SCRIPT_PATH,
    healthPath: SW_HEALTH_PATH,
  });

  if (ready) {
    console.info(
      '[demo] Service Worker server enabled. API requests now resolve from browser-local SQLite.'
    );
  }

  return ready;
}
