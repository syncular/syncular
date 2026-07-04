/**
 * Construct one SyncClient against the running server.
 *
 * The client core is plain library code — it runs on whatever database backend
 * and transport you give it. In the browser that is sqlite-wasm on OPFS + a
 * WebSocket; here it is bun:sqlite + fetch, so the whole thing runs in a
 * terminal with no browser. Everything else is identical to a web build (see
 * the `web` template for the browser story).
 */
import {
  httpSegmentDownloader,
  httpSyncTransport,
  SyncClient,
} from '@syncular-v2/web-client';
import { openBunDatabase } from '@syncular-v2/web-client/bun';
import { schema } from './syncular.generated';

export function makeClient(baseUrl: string, clientId: string): SyncClient {
  return new SyncClient({
    database: openBunDatabase(), // in-memory; pass a path to persist
    schema,
    clientId,
    transport: httpSyncTransport(`${baseUrl}/sync`),
    segments: httpSegmentDownloader(`${baseUrl}/segments`),
  });
}
