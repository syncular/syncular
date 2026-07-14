# Tauri

A Tauri app runs a native syncular instance inside the host process:
`tauri-plugin-syncular` (Rust) consumes the client core directly as a crate,
with no FFI layer, and the webview talks to it through a thin JS bridge,
`@syncular/tauri`, that implements the same `SyncClientLike` interface every
other host does. Every `@syncular/react` hook works unchanged.

## Why the client lives in the host process

Webview OPFS is eviction-prone and inconsistent across WKWebView and
webkitgtk. The Rust core gives a real on-disk SQLite database (rusqlite) and
native performance. So the full client runs in the Tauri host process and the
webview is a thin RPC client of it. This is the same shape as the browser
worker mode, except the "worker" is the native process and the RPC is Tauri
IPC.

## Install

Two pieces. The JS bridge is on npm:

```sh
bun add @syncular/tauri @syncular/react
```

The Rust plugin is on crates.io:

```toml
[dependencies]
tauri-plugin-syncular = { version = "0.5", features = ["native-transport"] }
```

To track unreleased changes, consume it as a git dependency instead — cargo
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
        // restarts — the whole point of the native instance.
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
// <SyncProvider client={client}> … useQuery / useRawSql / useMutation / usePresence
```

The JS side supplies the schema and optional `limits`; the native side owns
the database path (plugin config). On first open the core generates and stores
a cryptographically random client id in that database. Later opens restore it.
An explicit `clientId` can initialize a new database, but a different id for
an existing database fails with `client.identity_mismatch` instead of silently
rebinding identity. The bridge resolves
`@tauri-apps/api` automatically (or the ambient `window.__TAURI__` when
`withGlobalTauri` is enabled); tests inject `invoke`/`listen` doubles.

## The command and event surface

The plugin dispatches through the shared `syncular-command` router — the same
router the conformance shim and the C-ABI FFI use, so the surface is
conformance-locked.

- **`syncular_command(command)`** — the whole surface in one command.
  `command` is `{ "method": "...", "params": {...} }` (create, subscribe,
  mutate, sync, syncUntilIdle, conflicts, presence, setPresence, …). The reply
  is `{ "result": ... }` or `{ "error": { "code", "message" } }`.
- **`syncular_query(sql, params)`** — the raw read-only SQL fast path.
- **`querySnapshot` through `syncular_command`** — one IPC read for rows,
  window completeness, and exact local revision.
- **`syncular_set_headers(headers)`** — replace the native transport's
  request headers at runtime (see below).
- **`syncular://event`** — exact revisioned `change` batches plus `presence`
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
Real apps rotate JWTs, so the bridge exposes a runtime replacement:

```ts
await client.setHeaders({ authorization: `Bearer ${freshToken}` });
```

Pass the FULL header set each time — it replaces the previous set. HTTP
requests (sync rounds, segments, blobs) use the new headers from the next
call; the realtime WebSocket sends headers at handshake time, so a live
socket keeps its old set until it reconnects. To force the new auth onto the
socket immediately, call `disconnectRealtime()` followed by
`connectRealtime()` after `setHeaders`.

## Threading

`SyncClient` is synchronous, owns a rusqlite connection, and is not
`Sync`. The plugin therefore keeps exactly one owning thread holding the
core, and every access arrives over a command mailbox (an mpsc channel):
the Tauri commands post a request and await the reply, and only the owning
thread touches the client. The §8.4 host loop blocks on that mailbox or one
explicit retry deadline. Interactive mutation/window/realtime intents preempt
the deadline; idle clients have zero periodic wakeups. All access to the
connection remains serialized.

## Native transport

With `native-transport`, the plugin owns the network: blocking HTTP via
`ureq` (`POST /sync`, segment and blob endpoints) and the realtime socket via
`tungstenite`, with a reader thread routing inbound frames. When the socket
is connected, each combined push+pull round runs over the socket in the
§8.7 one-loop shape, the same behavior as the web client; with no socket the
round runs over `POST /sync`. One round is in flight per connection, and a
mid-round socket drop fails the round immediately.

Each unique live query is one atomic IPC round trip per relevant revision,
shared by equal observers. Status/conflict-only changes do not rerun SQL. For
large result sets serialization can dominate, so prefer indexed keyset
pagination and bounded windows.

## The example

[`bindings/tauri/example`](https://github.com/syncular/syncular/tree/main/bindings/tauri/example)
is a minimal Tauri app proving the loop end to end: `src-tauri` registers the
plugin with `native-transport` pointed at a local dev server, and the
frontend is a React todo list over `createTauriSyncClient`; the same generated
query phases, typed mutations, and status hooks used by browser clients apply.
The only Tauri-specific line is client construction.

## Where to go next

- **[React hooks](/platform-react/)** — the hook surface the bridge feeds.
- **[Rust](/platform-rust/)** — the `syncular-client` crate the plugin
  consumes directly.
- **[Realtime](/concepts-realtime/)** — sockets, deltas, and sync rounds over
  the socket.
- **[Server setup](/guide-server/)** — the server this native instance syncs
  against.
