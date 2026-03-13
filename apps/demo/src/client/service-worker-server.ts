import { configureServiceWorkerServer } from '@syncular/server-service-worker';

const SW_SERVER_SCRIPT_PATH = '/__demo/sw-server.js';
const SW_HEALTH_PATH = '/api/health';
const SW_HEALTH_HEADER_NAME = 'x-syncular-sw-server';
const SW_HEALTH_HEADER_VALUE = '1';
const SENTRY_RELEASE_META = 'syncular-sentry-release';

function readServiceWorkerVersion(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const meta = document.querySelector<HTMLMetaElement>(
    `meta[name="${SENTRY_RELEASE_META}"]`
  );
  const content = meta?.content?.trim();
  return content && content.length > 0 ? content : undefined;
}

export async function configureDemoServiceWorkerServer(): Promise<boolean> {
  const fetchImpl =
    typeof window !== 'undefined' ? window.fetch.bind(window) : undefined;

  const ready = await configureServiceWorkerServer({
    enabled: true,
    scriptPath: SW_SERVER_SCRIPT_PATH,
    scriptVersion: readServiceWorkerVersion(),
    scope: '/',
    healthPath: SW_HEALTH_PATH,
    healthCheck: (response) =>
      response.headers.get(SW_HEALTH_HEADER_NAME) === SW_HEALTH_HEADER_VALUE,
    healthTimeoutMs: 60_000,
    healthRequestTimeoutMs: 10_000,
    ...(fetchImpl ? { fetchImpl } : {}),
    logger: console,
  });

  if (ready) {
    console.info(
      '[demo] Service Worker server enabled. API requests now resolve from browser-local SQLite.'
    );
  }

  return ready;
}
