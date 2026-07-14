# Rust

The `syncular-client` crate is the Rust client core itself, the same
engine the Tauri plugin, the C FFI, and every native binding run. Use it
directly when your host is a Rust program: you get a synchronous,
host-driven `SyncClient` on rusqlite, with your code owning the transport
and the sync schedule.

## Install

Published on crates.io:

```toml
[dependencies]
syncular-client = "0.0.0"
```

Feature flags (both off by default, which keeps the core's dependency tree
small):

```toml
[dependencies]
syncular-client = { version = "0.0.0", features = ["crdt-yjs", "e2ee"] }
```

- `crdt-yjs` — the §5.10.5 native CRDT helpers (`crdt_text`,
  `crdt_insert_text`, `crdt_delete_text`, `crdt_apply_update`) over `yrs`,
  Yjs-wire-compatible with the web `@syncular/crdt-yjs` helper.
- `e2ee` — §5.11 client-side encryption (installed via `set_encryption`).

The wire codec lives in `syncular-ssp2` (library name `ssp2`, also
`0.0.0` on crates.io); it arrives as a dependency and you rarely need it
directly.

## The character of the API

Three decisions shape the API:

- **Synchronous and host-driven.** There is no async runtime and no
  background thread inside the core. Your code calls `sync()` /
  `sync_until_idle()` when it decides to; the core exposes the coalesced
  exact `SyncIntent` values. The core classifies immediate work and transient
  retry backoff; the host owns the mailbox/deadline wait.
- **Thread-affine.** `SyncClient` owns a rusqlite connection and is not
  `Sync`. Drive one client from one thread; if other threads need access,
  use a mailbox (an mpsc channel to the owning thread), the pattern the
  Tauri plugin and the FFI use.
- **Transport is a seam.** The core never opens a socket. You hand every
  network-touching call a `&mut dyn Transport` you implement.

## Create a client

```rust
use serde_json::json;
use syncular_client::{ClientLimits, SyncClient};

let schema = json!({
    "version": 1,
    "tables": [{
        "name": "todos",
        "primaryKey": "id",
        "columns": [
            { "name": "id", "type": "string", "nullable": false },
            { "name": "list_id", "type": "string", "nullable": false },
            { "name": "title", "type": "string", "nullable": false }
        ],
        "scopes": [{ "pattern": "list:{list_id}", "column": "list_id" }]
    }]
});

let mut client = SyncClient::open_path(
    "device-1".to_owned(),      // stable client id
    &schema,
    ClientLimits::default(),
    "/path/to/syncular.db",     // persists across restarts
)?;
```

The schema JSON is the §2.4 client IR, the same shape
[typegen](/guide-schema/) emits (`syncular.ir.json` / the generated module),
so a Rust client and a TypeScript client can share one generated schema.
Three constructors cover the storage choices: `SyncClient::new` (in-memory),
`SyncClient::open_path` (on-disk file, `CREATE TABLE IF NOT EXISTS` so
re-opening reuses persisted rows), and `SyncClient::with_connection` (a
caller-supplied fresh rusqlite `Connection`).

## Subscribe, mutate, read

```rust
use serde_json::{Map, Value};
use syncular_client::Mutation;

client.subscribe(
    "todos".to_owned(),                                    // subscription id
    "todos".to_owned(),                                    // table
    vec![("list_id".to_owned(), vec!["groceries".to_owned()])],
    None,                                                  // params
)?;

let mut values = Map::new();
values.insert("id".to_owned(), Value::from("t1"));
values.insert("list_id".to_owned(), Value::from("groceries"));
values.insert("title".to_owned(), Value::from("Milk"));
let commit_id = client.mutate(vec![Mutation::Upsert {
    table: "todos".to_owned(),
    values,
    base_version: None,
}])?;

// Row-level read: version -1 = optimistic, else the server version.
let rows = client.read_rows("todos")?;

// Arbitrary read-only SQL over the local tables:
let rows = client.query("SELECT id, title FROM todos ORDER BY id", &[])?;
```

`mutate` records a local commit, applies it optimistically, and queues it in
the outbox; it works fully offline. `Mutation` has two arms: `Upsert
{ table, values, base_version }` and `Delete { table, row_id, base_version }`
(`base_version` drives [conflict detection](/concepts-conflicts/)).
Divergence surfaces through `conflicts()`, `rejections()`, and
`pending_commit_ids()`.

## The sync loop

`sync()` runs one combined push+pull round; `sync_until_idle()` repeats
rounds until nothing is pending (default cap 12 rounds):

```rust
use syncular_client::SyncOutcome;

match client.sync_until_idle(&mut transport, None) {
    SyncOutcome::Ok(report) => {
        // report.pushed, report.commits_applied, report.conflicts, …
    }
    SyncOutcome::Failed { error_code, message } => {
        eprintln!("sync failed: {error_code}: {message}");
    }
}
```

Transport and protocol failures come back as `SyncOutcome::Failed`;
`sync()` does not panic or error out-of-band. After a round, `sync_needed()`
tells you whether another round is already warranted.

## The `Transport` trait

You implement `syncular_client::Transport` and pass it to every
network-touching call. The required methods:

- `sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError>` — one
  combined push+pull round over `POST /sync` (or loopback).
- `realtime_sync(&mut self, request: &[u8])` — the same round over the
  connected realtime socket (§8.7); the host owns the WS framing.
- `download_segment(&mut self, request: &SegmentRequest)` — bootstrap
  segment fetch (§5.5).
- `realtime_connect` / `realtime_send` / `realtime_close` — the socket
  lifecycle and client→server control messages.

Optional methods (whose default implementations return an error) cover
signed-URL fetches
(`supports_url_fetch` + `fetch_url`) and the blob endpoints (`blob_upload`,
`blob_download`, `blob_upload_grant`, `blob_put_url`, `fetch_blob_url`).

The reference implementation is the `syncular-ffi` crate's native transport
(behind its `native-transport` feature): blocking HTTP via `ureq` and a
`tungstenite` realtime socket with a reader thread; see
[`rust/crates/ffi/src/transport.rs`](https://github.com/syncular/syncular/blob/main/rust/crates/ffi/src/transport.rs).
To reuse that stack, embed `syncular-ffi`; if your host already has an HTTP
client, the trait is small enough to implement over it.

## Realtime

The core has no callbacks. Connect with
`client.connect_realtime(&mut transport)?`, then feed inbound frames from
your socket reader into the core:

- `client.on_realtime_text(&text)` — JSON control messages.
- `client.on_realtime_binary(&mut transport, &bytes)` — binary delta frames.

Applied deltas update the local tables directly; `sync_needed()` flips when a
round is warranted. `disconnect_realtime` closes the lane. While the socket
is connected the core routes sync rounds through `Transport::realtime_sync`;
the connected socket carries the sync rounds themselves. See
[Realtime](/concepts-realtime/).

## Where to go next

- **[Embedding via C FFI](/platform-ffi/)** — this crate packaged as
  `libsyncular` with a five-function C ABI, plus the batteries-included
  native transport.
- **[Tauri](/platform-tauri/)** — a plugin that consumes this crate directly
  in a desktop app.
- **[Conformance](/guide-conformance/)** — the catalog that proves the Rust
  and TypeScript cores implement one protocol.
- **[Commits & the outbox](/concepts-commits/)** — what `mutate` and a sync
  round actually do.
