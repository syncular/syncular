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

## Sync rounds over the socket (§8.7) — complete

With `native-transport`, the plugin's `HostTransport` runs each combined
push+pull round **over the connected realtime socket** in the one-loop shape
(§8.7), matching the web client: the request goes out as a `0x01`-tagged
binary chunk and the reader thread reassembles the `0x01` response stream to
its `END`, routing any `0x00` delta or text control frame that interleaves to
the inbound lane (tolerate-and-queue). One round in flight per connection is
enforced client-side; a mid-round socket drop fails the round rather than
hanging; with no socket the round rides `POST /sync` (the not-connected rule,
not a fallback pair). The transport-agnostic tag demux + reassembly is shared
with the FFI crate via `syncular_client::RealtimeRound` (unit-tested there and
in `ssp2::MessageStreamScanner`); the WS plumbing in
`plugin/src/transport.rs` is kept byte-for-byte parallel with
`rust/crates/ffi/src/transport.rs`, whose `round_tests` prove the framing
end-to-end against a scripted §8.7 WebSocket server.

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

A minimal Tauri app proving syncular works end to end: `example/src-tauri`
registers the plugin (with `native-transport`) and points its native instance at
a local dev server; `example/src/frontend` is a **React** todo list on
`@syncular-v2/react` hooks (`useSyncQuery` + `useMutation` + `useSyncStatus`)
over `createTauriSyncClient` — the exact hooks the browser demo uses, with the
only Tauri-specific line being the client construction. See
[`example/README.md`](example/README.md) for the full run recipe and the ~40
lines of integration.

The frontend bundles with **`bun run build-frontend`** (a dependency-light
`Bun.build` → `example/dist` — no Vite; React + the syncular packages come from
the workspace). `tauri.conf.json` points `frontendDist` at `../dist` and runs
the bundle as `beforeDevCommand`/`beforeBuildCommand`, so
`bun run build-frontend && cargo tauri dev` opens the window. The window is a
human step (a real display, and on Linux `webkit2gtk`); a `cargo build` plus the
mock-runtime tests are this rung's automated bar. Because
`tauri::generate_context!` validates `frontendDist` at compile time, the bundle
must exist before any cargo step — `check.sh` builds it first.

## Tests & gates

This is a **separate cargo workspace** from `rust` on purpose: Tauri's crate
tree is heavy and must not bloat the main workspace's cargo gate. Run its gate
with `./check.sh` (fmt + clippy with and without `native-transport` + test +
example build). CI runs it as the `tauri-bindings` job, gated on
`bindings/tauri/**`.

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
