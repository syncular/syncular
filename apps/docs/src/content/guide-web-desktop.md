# One codebase, web + desktop

The same React tree runs over two radically different hosts: in the browser,
the client core lives in a Web Worker on OPFS; on desktop, a native Rust
core lives inside the Tauri process with a real file database. Every hook,
every component, and every query is identical — the only code that knows
which host it's on is a ~40-line engine seam that picks the client.

This works because everything in `@syncular/react` targets one structural
interface, `SyncClientLike`. The worker handle implements it, the Tauri
bridge implements it, and `SyncProvider` normalizes either one; the hooks
never see the difference.

## The engine seam

```ts
// engine.ts — the ONE file that knows about hosts.
import type { SyncClientLike } from '@syncular/react';
import { schema } from './syncular.generated';

/** Tauri v2 injects this into every webview it hosts. */
const isTauri = () =>
  '__TAURI_INTERNALS__' in window ||
  import.meta.env.VITE_FORCE_ENGINE === 'tauri';

export async function createEngine(): Promise<SyncClientLike> {
  if (isTauri()) {
    // Desktop: the native Rust core in the Tauri process. The plugin owns
    // the database path and the transport; the webview is a thin RPC proxy.
    const { createTauriSyncClient } = await import('@syncular/tauri');
    return createTauriSyncClient({ schema });
  }
  // Web: the whole core in a worker, persisted on OPFS. The first tab
  // leads; further tabs follow it over a BroadcastChannel.
  const { createSyncClientHandle } = await import('@syncular/client');
  const WS = location.protocol === 'https:' ? 'wss' : 'ws';
  return createSyncClientHandle({
    worker: () =>
      new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    schema,
    database: { mode: 'persistent', name: 'app' },
    endpoints: {
      syncUrl: '/sync',
      segmentsUrl: '/segments',
      realtimeUrl: `${WS}://${location.host}/realtime?clientId={clientId}`,
    },
  });
}
```

The dynamic imports keep each host's machinery out of the other's bundle:
the web build never ships the Tauri bridge, and the Tauri webview never
loads sqlite-wasm. The `VITE_FORCE_ENGINE` override is for developing the
Tauri UI in a plain browser tab.

## One provider, one tree

```tsx
import { SyncProvider } from '@syncular/react';
import { createEngine } from './engine';

const client = await createEngine();

root.render(
  <SyncProvider client={client}>
    <App /> {/* useQuery / useRawSql / useMutation / usePresence — unchanged */}
  </SyncProvider>,
);
```

That is the entire host split. `App` and everything under it is shared code:
the same `useQuery` calls, the same optimistic `useMutation` writes, the
same presence and conflict surfaces, converging against the same server.

## What differs per host

| | Web (worker) | Desktop (Tauri) |
| --- | --- | --- |
| Core | TypeScript client in a Web Worker | Rust client in the host process |
| Storage | OPFS (`opfs-sahpool`) | On-disk SQLite under app-data |
| Transport | `fetch` + WebSocket from the worker | `ureq` + `tungstenite` in Rust |
| Query round trip | postMessage RPC | Tauri IPC to an independent read-only SQLite owner |
| Setup | [Vite config](/guide-vite/) | [plugin registration](/platform-tauri/) |

The desktop side needs the plugin registered in `src-tauri` with a
`SyncularConfig` (base URL, database path) and the `syncular:default`
permission granted — the [Tauri page](/platform-tauri/) walks through it.
Auth rotation on desktop goes through `client.setHeaders(...)`; on the web
the worker's transport sends whatever your reverse proxy/session carries.

## Scaffold it

`bun create syncular-app my-app --template tauri` writes this whole story as
a runnable project: the engine seam, the shared React tree, the sync server,
and a `src-tauri/` host with `tauri-plugin-syncular` from crates.io — run the
web half with `bun run dev` and the desktop half with `cargo tauri dev`.

## Where to go next

- **[Tauri](/platform-tauri/)** — plugin registration, config, the command
  surface, rotating auth.
- **[Vite](/guide-vite/)** — the web half's three-line config.
- **[React](/platform-react/)** — the hook surface both hosts feed.
