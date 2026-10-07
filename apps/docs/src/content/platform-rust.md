# Rust

`syncular-client` is the Rust client core: the engine the Tauri plugin, the C FFI, and every native binding run. A Rust host drives a synchronous `SyncClient` on rusqlite and owns the transport and the sync schedule. This page shows the shape of the API and a first sync; the sub-pages cover install, daily use, the sync loop, reference material, and fixes.

::meta{for="Rust developers embedding the client core in a host program" time="5 minutes"}

| Property | Value |
|---|---|
| **Runs on** | Any target rusqlite (bundled SQLite) builds for |
| **Package** | `syncular-client = "0.0.0"` on crates.io; the wire codec arrives as `syncular-ssp2` |
| **Core** | This crate is the core; there is no FFI layer |
| **Threading** | Synchronous and thread-affine: `SyncClient` is not `Sync`. Drive it from one thread |
| **Reading time** | 5 minutes here, about 25 for the full set |

:::figure{title="Who drives what" note="The core never opens a socket or starts a thread" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Your host</span>decides when to call<br><code>sync()</code></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">SyncClient</span>rusqlite replica, outbox,<br>round logic</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Transport</span>a trait you implement,<br>or <code>HostTransport</code></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Server</span><code>POST /sync</code>,<br>segments, realtime</div>
</div>

::caption[Every network-touching call takes a `&mut dyn Transport`. [Realtime & lifecycle](/platform-rust-realtime/) covers scheduling.]
:::

## First sync

The code below needs `syncular-client` with the `native-transport` feature, which provides `HostTransport`.

```rust
use serde_json::{json, Map, Value};
use syncular_client::native_transport::HostTransport;
use syncular_client::{ClientLimits, Mutation, SyncClient};

let mut client = SyncClient::open_path(
    "device-1".to_owned(), &schema, ClientLimits::default(), "syncular.db")?;
let mut transport = HostTransport::from_config(&json!({"baseUrl": "http://localhost:8787"}))?;

client.subscribe("todos".to_owned(), "todos".to_owned(),
    vec![("list_id".to_owned(), vec!["groceries".to_owned()])], None)?;
let mut values = Map::new();
values.insert("id".to_owned(), Value::from("t1"));
values.insert("list_id".to_owned(), Value::from("groceries"));
values.insert("title".to_owned(), Value::from("Buy milk"));
client.mutate(vec![Mutation::Upsert { table: "todos".to_owned(), values, base_version: None }])?;
client.sync_until_idle(&mut transport, None);
println!("{:?}", client.query("SELECT id, title FROM todos", &[])?);
```

`schema` is the client IR JSON that typegen emits ([Install & first sync](/platform-rust-install/) shows its shape).

## The pages

- **[Install & first sync](/platform-rust-install/)**: the crate, its features, constructors, and a first round.
- **[Reads & writes](/platform-rust-reads-writes/)**: subscribe, mutate, read, outcomes, generated queries, and blob bytes.
- **[Realtime & lifecycle](/platform-rust-realtime/)**: `sync`, `sync_until_idle`, realtime frames, the realtime policy, and the transport gate.
- **[Platform specifics](/platform-rust-specifics/)** (advanced): the `Transport` trait, native transport policy, live progress, authoring failures, storage failures, and the snapshot sidecar.
- **[Troubleshooting](/platform-rust-troubleshooting/)**: failed outcomes, `sync.offline`, and storage codes.

The same crate packaged behind a C ABI is [Embedding via C FFI](/platform-ffi/); a desktop app that hosts it in-process is [Tauri](/platform-tauri/).
