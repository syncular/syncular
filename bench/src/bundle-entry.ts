/**
 * Minimal browser entry for the bundle-size measurement: the SyncClient
 * core plus the sqlite-wasm database backend — exactly what a web app
 * ships. The sqlite3.wasm binary stays an external asset (it is fetched
 * at runtime, never inlined).
 */
import {
  httpSegmentDownloader,
  httpSyncTransport,
  SyncClient,
  webSocketRealtimeConnector,
} from '@syncular/client';
import { openWasmDatabase } from '@syncular/client/wasm';

export async function boot(): Promise<SyncClient> {
  const client = new SyncClient({
    database: await openWasmDatabase(),
    schema: { version: 1, tables: [] },
    transport: httpSyncTransport('/sync'),
    segments: httpSegmentDownloader('/segments'),
    realtime: webSocketRealtimeConnector('/realtime'),
  });
  await client.start();
  return client;
}

// Keep everything reachable from the entry (no tree-shake cheating).
(globalThis as Record<string, unknown>).__syncularBoot = boot;
