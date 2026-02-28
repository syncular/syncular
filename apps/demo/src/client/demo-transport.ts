import type { SyncTransport } from '@syncular/core';
import { createServiceWorkerWakeTransport } from '@syncular/server-service-worker';
import { getDemoAuthHeaders } from './demo-identity';

// Keep SW demo responsive but reduce background churn a bit.
// Effective sync loop performs both push and pull; lower poll frequency helps UI smoothness.
export const DEMO_POLL_INTERVAL_MS = 4_000;
export const DEMO_DATA_CHANGE_DEBOUNCE_MS = 250;
export const DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_SYNCING = 250;
export const DEMO_DATA_CHANGE_DEBOUNCE_MS_WHEN_RECONNECTING = 250;

export function createDemoPollingTransport(actorId: string): SyncTransport {
  return createServiceWorkerWakeTransport({
    baseUrl: '/api',
    getHeaders: () => getDemoAuthHeaders(actorId),
  });
}
