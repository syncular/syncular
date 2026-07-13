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
import type { SyncClientLike } from '@syncular/react';
import { schema } from '../syncular.generated';

/**
 * What the app gets back: the hook surface (`SyncClientLike`) plus the
 * lifecycle both concrete clients share — enough for the boot sequence in
 * `main.tsx`, still fully host-agnostic.
 */
export interface Engine extends SyncClientLike {
  subscribe(input: {
    readonly id: string;
    readonly table: string;
    readonly scopes: Record<string, readonly string[]>;
  }): Promise<unknown>;
  connectRealtime(): Promise<void>;
  close(): Promise<void>;
}

/** Tauri v2 injects this into every webview it hosts. */
const isTauri = () => '__TAURI_INTERNALS__' in window;

/** A stable per-browser client id (the native side persists its own db). */
function clientId(): string {
  const KEY = 'syncular-client-id';
  const existing = localStorage.getItem(KEY);
  if (existing !== null) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(KEY, id);
  return id;
}

export async function createEngine(): Promise<Engine> {
  if (isTauri()) {
    // Desktop: the native Rust core in the Tauri process.
    const { createTauriSyncClient } = await import('@syncular/tauri');
    return createTauriSyncClient({ clientId: clientId(), schema });
  }
  // Web: the whole core in a worker, persisted on OPFS.
  const { createSyncClientHandle } = await import('@syncular/client');
  const WS = location.protocol === 'https:' ? 'wss' : 'ws';
  return createSyncClientHandle({
    worker: () => new Worker('/worker.js', { type: 'module' }),
    schema,
    clientId: clientId(),
    database: { mode: 'persistent', name: 'app' },
    endpoints: {
      syncUrl: '/sync',
      segmentsUrl: '/segments',
      realtimeUrl: `${WS}://${location.host}/realtime?clientId={clientId}`,
    },
  });
}
