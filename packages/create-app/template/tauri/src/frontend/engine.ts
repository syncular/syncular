/**
 * The engine seam — the ONE file that knows about hosts.
 *
 * Everything in `@syncular/react` targets one structural interface,
 * `SyncClientLike`. The browser worker handle implements it, the Tauri
 * bridge implements it, and `SyncProvider` normalizes either one — the
 * hooks never see the difference. This file picks the client:
 *
 * - Inside a Tauri webview (Tauri v2 injects `__TAURI_INTERNALS__`), the
 *   NATIVE Rust core runs in the host process — the webview is a thin RPC
 *   proxy. The plugin owns the database path and the transport
 *   (see `src-tauri/src/lib.rs`).
 * - In a plain browser, the whole TypeScript core runs in a Web Worker on a
 *   persistent OPFS database; the first tab leads, further tabs follow over
 *   a BroadcastChannel.
 *
 * The dynamic imports keep each host's machinery out of the other's bundle:
 * the web build never ships the Tauri bridge, and the Tauri webview never
 * loads sqlite-wasm.
 */

import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
} from '@syncular/client';
import type { SyncClientLike } from '@syncular/react';
import { schema } from '../syncular.generated';

/**
 * What the app gets back: the hook surface (`SyncClientLike`) plus the
 * lifecycle both concrete clients share, still fully host-agnostic.
 */
export interface Engine extends SyncClientLike {
  syncUntilIdle(maxRounds?: number): unknown | Promise<unknown>;
  connectRealtime(): Promise<void>;
  disconnectRealtime(): void | Promise<void>;
  close(): Promise<void>;
}

/** Tauri v2 injects this into every webview it hosts. */
const isTauri = () => '__TAURI_INTERNALS__' in window;

export async function createEngine(): Promise<Engine> {
  // Both hosts hand this view a shared transport — the Tauri core lives in
  // the host process behind every webview, and the browser handle is
  // multi-tab (followers proxy to one leader socket) — so `sharedTransport`
  // keeps a hidden view from tearing down realtime for a visible sibling.
  const supervise = <Client extends Engine>(client: Client): Client =>
    installRealtimeSupervisor(client, {
      connectivity: browserConnectivitySignal(),
      lifecycle: documentLifecycleSignal(),
      sharedTransport: true,
    });
  if (isTauri()) {
    // Desktop: the native Rust core in the Tauri process.
    const { createTauriSyncClient } = await import('@syncular/tauri');
    return supervise(await createTauriSyncClient({ schema }));
  }
  // Web: the whole core in a worker, persisted on OPFS.
  const { createSyncClientHandle } = await import('@syncular/client');
  const WS = location.protocol === 'https:' ? 'wss' : 'ws';
  return supervise(
    await createSyncClientHandle({
      worker: () => new Worker('/worker.js', { type: 'module' }),
      schema,
      database: { mode: 'persistent', name: 'app' },
      endpoints: {
        syncUrl: '/sync',
        segmentsUrl: '/segments',
        realtimeUrl: `${WS}://${location.host}/realtime?clientId={clientId}`,
      },
    }),
  );
}
