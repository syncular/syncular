# syncular · Tauri bindings

A **native syncular instance inside the Tauri process**, exposed to the webview
as Tauri commands + events, with a JS bridge implementing the same
`SyncClientLike` interface the React package normalizes — so the hooks work
unchanged. This is the fourth host of one interface, after the direct
`SyncClient`, the worker-leader `SyncClientHandle`, and the multi-tab follower.

Two pieces:

- **`plugin/`** — `tauri-plugin-syncular` (Rust). Runs the `syncular-client`
  core DIRECTLY (no FFI), with a real file DB and the native HTTP+WS transport.
  Exposes `syncular_command` / `syncular_query` commands and a `syncular://event`
  event stream.
- **`../../packages/tauri`** — `@syncular-v2/tauri` (JS). `createTauriSyncClient()`
  returns a `SyncClientLike` over `@tauri-apps/api`'s `invoke` / `listen`.

## Architecture: why a native instance, not JS-in-the-webview

Decided 2026-07-03 (see [ROADMAP block 1](../../ROADMAP.md#1-native-bindings-block-the-one-real-parity-gap)):
we do **not** run JS syncular in the webview. Webview OPFS is eviction-prone and
inconsistent across WKWebView / webkitgtk; the Rust core gives a real on-disk
SQLite database and native performance. So a full syncular client runs in the
Tauri host process, and the webview is a thin RPC client of it — the same shape
as the browser worker mode, but the "worker" is the native process and the RPC
is Tauri IPC.

```
┌── webview ────────────────┐        ┌── tauri host process ──────────────┐
│ @syncular-v2/react hooks  │        │ tauri-plugin-syncular              │
│   │ SyncClientLike        │  IPC   │   owning thread (mailbox)          │
│ @syncular-v2/tauri  ──────┼───────▶│     SyncClient (rusqlite FILE db)  │
│   invoke / listen         │◀───────┤     HostTransport (HTTP + WS)      │
└───────────────────────────┘ events │     §8.4 host loop (auto-sync)     │
                                      └────────────────────────────────────┘
```

## The command + event surface

The plugin is the THIRD consumer of the shared `syncular-command` router (after
the conformance shim and the C-ABI FFI), so its command surface is
conformance-locked: whatever the shim exercises, the plugin inherits.

- **`syncular_command(command)`** — the whole surface in one command. `command`
  is `{ "method": "...", "params": {...} }` (create / subscribe / mutate / sync
  / syncUntilIdle / conflicts / presence / setPresence / …). Reply is
  `{ "result": ... }` or `{ "error": { "code", "message" } }`.
- **`syncular_query(sql, params)`** — the live-query fast path (arbitrary
  read-only SQL over the local tables). Routed through the router's `query`
  command so there is one implementation.
- **`syncular://event`** — the derived client-observable events, mirroring the
  FFI `poll_event` set: `invalidate` (live queries re-run), `presence`,
  `sync-needed`, `conflict`, `rejection`, `schema-floor`, `lease`. Bytes ride as
  `{ "$bytes": "<hex>" }` everywhere, the driver-protocol convention.

## Thread-safety (honest)

`SyncClient` is synchronous and owns a rusqlite connection — it is **not**
`Sync`. The plugin uses the shim/FFI pattern: exactly ONE owning thread holds
the core, and every access arrives over a command **mailbox** (an mpsc channel).
The Tauri commands post a request and await the reply; they never touch the
client. The §8.4 background host loop (wake-driven `syncUntilIdle` with jitter)
runs ON that same owning thread, interleaved with mailbox requests, so the
connection is never accessed concurrently.

## Setup

`Cargo.toml`:

```toml
[dependencies]
tauri-plugin-syncular = { path = "…/bindings/tauri/plugin", features = ["native-transport"] }
```

`lib.rs`:

```rust
use tauri::Manager;
use tauri_plugin_syncular::SyncularConfig;

tauri::Builder::default()
    .setup(|app| {
        let db_path = app.path().app_data_dir().ok().map(|dir| {
            let _ = std::fs::create_dir_all(&dir);
            dir.join("syncular.db").to_string_lossy().into_owned()
        });
        let config = SyncularConfig {
            base_url: Some("https://your.server".into()),
            db_path,
            wake_jitter_ms: 250,
            auto_sync: true,
            ..Default::default()
        };
        app.handle().plugin(tauri_plugin_syncular::init(config))?;
        Ok(())
    })
    // …
```

Grant the plugin's default permission in a capability
(`src-tauri/capabilities/*.json`):

```json
{ "identifier": "syncular", "windows": ["main"], "permissions": ["syncular:default"] }
```

Webview:

```ts
import { createTauriSyncClient } from '@syncular-v2/tauri';
import { schema } from './syncular.generated';

const client = await createTauriSyncClient({ clientId: 'device-1', schema });
// Pass to React: <SyncProvider client={client}> — every hook works unchanged.
```

## IPC latency & pagination

Every `useSyncQuery` run is **one IPC round trip** — fine at Tauri IPC latency
for typical view queries. For very large result sets, the round-trip
serialization dominates: paginate with `LIMIT`/`OFFSET` (or keyset pagination)
in the SQL you pass, exactly as you would for any query API. The native core
holds the whole database; the webview should pull windows of it, not the lot.

## The example (`example/`)

A minimal Tauri app proving the wiring compiles: `example/src-tauri` registers
the plugin (with `native-transport`) and points at a local dev server;
`example/src/frontend` is a vanilla `createTauriSyncClient` + live-query demo
(vanilla, not React, so the example needs no bundler toolchain — the React hooks
are proven unchanged by `@syncular-v2/tauri`'s shape-parity test).

Build it: `cargo build -p syncular-tauri-example` (from `bindings/tauri`).
`cargo tauri dev` opens a window — that needs a human hand (a real display and,
on Linux, webkit2gtk); a compile plus the mock-runtime tests are this rung's
automated bar. The frontend uses `.ts` sources referenced as `.js`; wire your
own bundler (Vite/tsc) if you run the window — the Rust side is complete.

## Tests & gates

This is a **separate cargo workspace** from `v2/rust` on purpose: Tauri's crate
tree is heavy and must not bloat the main workspace's cargo gate. Run its gate
with `./check.sh` (fmt + clippy with and without `native-transport` + test +
example build). CI runs it as the `tauri-bindings` job, gated on
`v2/bindings/tauri/**`.

- **Rust tests**: the plugin core (router round-trip, event derivation, file-DB
  persistence, config validation) and the owner-thread mailbox loop are plain
  Rust tests. The Tauri shell is exercised by mock-runtime tests
  (`tauri::test`) that build an app with the plugin and a window; invoking the
  namespaced commands through the mock IPC additionally needs the plugin's ACL
  manifest (produced at the consuming app's build, not by `mock_context`), so
  command *behavior* is proven by the core tests and the shell wiring by the
  example.
- **JS tests**: `@syncular-v2/tauri`'s bridge unit tests (injected
  invoke/listen doubles) assert the `SyncClientLike` contract, event fanout, and
  the bytes convention, plus a shape-parity test against the real React
  `normalizeClient`.
