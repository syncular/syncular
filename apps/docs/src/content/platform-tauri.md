# Tauri

A Tauri app runs a native syncular instance inside the host process:
`tauri-plugin-syncular` (Rust) consumes the client core directly as a crate,
with no FFI layer, and the webview talks to it through a thin JS bridge,
`@syncular/tauri`, that implements the same `SyncClientLike` interface every
other host does. Every `@syncular/react` hook works unchanged.

## Why the client lives in the host process

Webview OPFS is eviction-prone and inconsistent across WKWebView and
webkitgtk. The Rust core gives a real on-disk SQLite database (rusqlite) and
native performance, so the full client runs in the Tauri host process and the
webview is a thin RPC client of it. The shape matches the browser worker
mode: the client core runs outside the UI thread, reached over RPC (here,
Tauri IPC).

## Install

Two pieces. The JS bridge is on npm:

```sh
bun add @syncular/tauri @syncular/react
```

The Rust plugin is on crates.io:

```toml
[dependencies]
tauri-plugin-syncular = { version = "0.0.0", features = ["native-transport"] }
```

To track unreleased changes, consume it as a git dependency instead; cargo
finds the package inside the repo by name (pin a `rev = "<commit>"` for
reproducible builds); with a local checkout, a path dependency to
[`bindings/tauri/plugin`](https://github.com/syncular/syncular/tree/main/bindings/tauri/plugin)
works too:

```toml
[dependencies]
tauri-plugin-syncular = { git = "https://github.com/syncular/syncular", features = ["native-transport"] }
```

The `native-transport` feature compiles the plugin's HTTP + WebSocket stack
(`ureq` + `tungstenite`, both blocking, with no async runtime). Without it the
plugin builds a client-local core: network commands return errors while local
reads and writes keep working.

## Register the plugin

Initialize with a `SyncularConfig` in your app's setup:

```rust
use tauri::Manager;
use tauri_plugin_syncular::SyncularConfig;

tauri::Builder::default()
    .setup(|app| {
        // Persist the database under the OS app-data dir so it survives
        // restarts.
        let db_path = app.path().app_data_dir().ok().map(|dir| {
            let _ = std::fs::create_dir_all(&dir);
            dir.join("syncular.db").to_string_lossy().into_owned()
        });
        let config = SyncularConfig {
            base_url: Some("https://your.server".into()),
            db_path,
            auto_sync: true,
            ..Default::default()
        };
        app.handle().plugin(tauri_plugin_syncular::init(config))?;
        Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running the app");
```

The config fields:

| Field | Meaning |
| --- | --- |
| `base_url` | Server base URL for the native HTTP+WS transport. Absent → client-local only. |
| `ws_url` | Optional realtime WebSocket URL; derived from `base_url` when absent. |
| `headers` | Extra request headers (auth, actor/project ids) as name/value pairs. |
| `db_path` | On-disk SQLite path. Absent → in-memory, nothing survives a restart. |
| `auto_sync` | Run the background host loop. Default `true`. |

Grant the plugin's permission in a capability file
(`src-tauri/capabilities/*.json`):

```json
{ "identifier": "syncular", "windows": ["main"], "permissions": ["syncular:default"] }
```

## Create the client in the webview

Install both the bridge and its required Tauri API peer so Vite/Bun can bundle
the `core` and `event` ESM entry points:

```sh
bun add @syncular/tauri @tauri-apps/api
```

```tsx
import { createTauriSyncClient } from '@syncular/tauri';
import { SyncProvider } from '@syncular/react';
import { schema } from './syncular.generated';

const client = await createTauriSyncClient({ schema });
// Every hook works unchanged:
// <SyncProvider client={client}> … useQuery / useMutation / useCommitOutcomes / usePresence
```

The JS side supplies the schema and optional `limits`; the native side owns
the database path (plugin config). On first open the core generates and stores
a cryptographically random client id in that database. Later opens restore it.
An explicit `clientId` can initialize a new database, but a different id for
an existing database fails with `client.identity_mismatch` instead of silently
rebinding identity. The bridge resolves
`@tauri-apps/api` automatically (or the ambient `window.__TAURI__` when
`withGlobalTauri` is enabled); tests inject `invoke`/`listen` doubles.

For encrypted schemas, build the plugin with its `e2ee` feature and pass the
portable keyring accepted by the browser worker too:

```ts
const client = await createTauriSyncClient({
  schema,
  encryption: {
    keys: { 'key-2026-07': activeKey, 'key-2026-06': previousKey },
    keyIdColumns: { patient_notes: 'encryption_key_id' },
  },
});
```

Raw keys cross only into the native command core and are never sent to the
server. See [Encryption keys](/concepts-encryption-keys/).

The bridge exposes the native durable outcome journal through `commitOutcome`,
`commitOutcomes`, and `resolveCommitOutcome`; React observes it with
`useCommitOutcomes()`.

`purgeLocalData({ purgeId, targets })` and the `securityPreflight` /
`activateSecurity` / `beginSecurityPreflight` lifecycle cross the same
command bridge to the native core, with the semantics defined in
[Authorized local purge](/concepts-local-data-purge/). `close()` shuts down
the native client.

Install the shared realtime supervisor on the returned client so a transient
startup failure or socket close cannot strand remote-only changes:

```ts
import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
} from '@syncular/client';

installRealtimeSupervisor(client, {
  connectivity: browserConnectivitySignal(),
  lifecycle: documentLifecycleSignal(),
  protection,
});
```

This baseline follows WebView connectivity/visibility. A desktop app with
native sleep/wake evidence should expose it through the same structural
lifecycle signal. The supervisor owns bounded reconnect and catch-up; the
native core guarantees repeated connect commands still own only one socket.
See [Realtime](/concepts-realtime/) for phases and diagnostics.

## One codebase, web and desktop

The same React tree runs over two hosts: in the browser, the client core
lives in a Web Worker on OPFS; on desktop, this plugin's native Rust core.
Everything in `@syncular/react` targets one structural interface,
`SyncClientLike`, so the only host-aware code is an engine seam that picks
the client:

```ts
// engine.ts: the one file that knows about hosts.
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

Render one `<SyncProvider client={await createEngine()}>` around the shared
tree. The dynamic imports keep each host's machinery out of the other's
bundle: the web build never ships the Tauri bridge, and the Tauri webview
never loads sqlite-wasm. The `VITE_FORCE_ENGINE` override is for developing
the Tauri UI in a plain browser tab.

What differs per host:

| | Web (worker) | Desktop (Tauri) |
| --- | --- | --- |
| Core | TypeScript client in a Web Worker | Rust client in the host process |
| Storage | OPFS (`opfs-sahpool`) | On-disk SQLite under app-data |
| Transport | `fetch` + WebSocket from the worker | `ureq` + `tungstenite` in Rust |
| Query round trip | postMessage RPC | Tauri IPC to an independent read-only SQLite owner |
| Setup | [Vite config](/guide-vite/) | plugin registration above |

Auth rotation on desktop goes through `client.setHeaders(...)` (below); on
the web the worker's transport sends whatever your reverse proxy or session
carries. `bun create syncular-app my-app --template tauri` scaffolds the
engine seam, the shared React tree, the sync server, and a `src-tauri/` host
as a runnable project: run the web half with `bun run dev` and the desktop
half with `cargo tauri dev`.

## The command and event surface

The plugin dispatches through the shared `syncular-command` router, the same
router the conformance shim and the C-ABI FFI use, so the surface is
conformance-locked.

- **`syncular_command(command)`**: the whole surface in one command.
  `command` is `{ "method": "...", "params": {...} }` (create, subscribe,
  mutate, sync, syncUntilIdle, conflicts, presence, setPresence, …). The reply
  is `{ "result": ... }` or `{ "error": { "code", "message" } }`.
- **`syncular_query(sql, params)`**: the raw read-only SQL fast path.
- **`syncular_query_snapshot(sql, params, coverage)`**: one IPC read for rows,
  window completeness, and exact local revision. A file-backed plugin serves
  this from an independent read-only SQLite connection, so network work on the
  mutable owner cannot stall reactive views.
- **`syncular_set_headers(headers)`**: replace the native transport's
  request headers at runtime (see below).
- **`syncular://event`**: exact revisioned `change` batches plus `presence`
  and lifecycle events. The Rust core originates table/scope/window/status/
  conflict domains; the bridge forwards them without counter diffing or a
  global-invalidation fallback. Bytes use `{ "$bytes": "<hex>" }`, and unsafe
  SQLite integers use `{ "$bigint": "<decimal>" }`.

Native CRDT text (plugin `crdt-yjs` feature) goes through `syncular_command`, and
`@syncular/tauri` exposes typed `crdtText` / `crdtInsertText` /
`crdtDeleteText` / `crdtApplyUpdate` methods, byte-compatible with the web
`@syncular/crdt-yjs` helper, so a Tauri app and a browser can edit the same
document. See [CRDT columns](/concepts-crdt/).

## Rotating auth

`SyncularConfig.headers` sets the initial header set at plugin registration.
The bridge replaces it at runtime for token rotation:

```ts
await client.setHeaders({ authorization: `Bearer ${freshToken}` });
```

Pass the FULL header set each time; it replaces the previous set. HTTP
requests (sync rounds, segments, blobs) use the new headers from the next
call; the realtime WebSocket sends headers at handshake time, so a live
socket keeps its old set until it reconnects. To force the new auth onto the
socket immediately, call `disconnectRealtime()` followed by
`connectRealtime()` after `setHeaders`.

## Threading

`SyncClient` is synchronous, owns a rusqlite connection, and is not `Sync`.
Exactly one owning thread holds the mutable core; commands and the §8.4 host
loop reach it over a mailbox. File-backed plugins add a second owner for a
read-only SQLite connection used only by atomic query snapshots. SQLite WAL
supplies the reader/writer snapshot boundary: network sync can block the
mutable owner without blocking local views, while no second mutable client or
writer exists. Interactive mutation/window/realtime intents preempt retry
deadlines, and both owners idle with zero periodic wakeups.

## Native transport

With `native-transport`, the plugin owns the network: blocking HTTP via
`ureq` (`POST /sync`, segment and blob endpoints) and the realtime socket via
`tungstenite`, with a reader thread routing inbound frames. When the socket
is connected, each combined push+pull round runs over the socket in the
§8.7 one-loop shape, the same behavior as the web client; with no socket the
round runs over `POST /sync`. One round is in flight per connection, and a
mid-round socket drop fails the round immediately.

FFI and Tauri re-export one transport implementation from `syncular-client`.
The socket URL carries the persisted database client id (while retaining other
configured query parameters), and the reader yields outside its short read
lock quantum so a quiet socket cannot starve round or acknowledgement sends.

Each unique live query is one atomic IPC round trip per relevant revision on
the independent read owner, shared by equal observers. Status/conflict-only
changes do not rerun SQL. For large result sets serialization can dominate, so
prefer indexed keyset pagination and bounded windows.

## Performance contract

For the isolated native read path, use `@syncular/tauri` and
`tauri-plugin-syncular` with a file-backed `db_path`:

- `querySnapshot` reads rows, window coverage, and local revision atomically on
  the independent SQLite owner. `auto_sync`, HTTP rounds, and realtime socket
  work on the mutable owner cannot queue ahead of that read.
- The native bridge release gate requires warm snapshot IPC p95 to remain at or
  below 5 ms. The budget covers the local read; React rendering,
  reconciliation, and painting are outside it.
- An in-memory configuration (`db_path: None`) falls back to the mutable
  owner: useful for tests, without the independent read-path latency contract
  or persistence across restarts.

A symptom-by-symptom checklist for slow, partial, or non-converging Tauri
views is in [Troubleshooting](/troubleshooting/#tauri).

## The example

[`bindings/tauri/example`](https://github.com/syncular/syncular/tree/main/bindings/tauri/example)
is a minimal Tauri app proving the loop end to end: `src-tauri` registers the
plugin with `native-transport` pointed at a local dev server, and the
frontend is a React todo list over `createTauriSyncClient`; the same generated
query phases, typed mutations, and status hooks used by browser clients apply.
The only Tauri-specific line is client construction.

## Where to go next

- **[React hooks](/platform-react/)**: the hook surface the bridge feeds.
- **[Rust](/platform-rust/)**: the `syncular-client` crate the plugin
  consumes directly.
- **[Realtime](/concepts-realtime/)**: sockets, deltas, and sync rounds over
  the socket.
- **[Server setup](/guide-server/)**: the server this native instance syncs
  against.
