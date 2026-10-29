# Install & first sync (Rust)

Add `syncular-client`, open a replica, and run one sync round against the quickstart server.

::meta{for="Rust developers adding the client core to a host program" time="10 minutes"}

:::terms
- **Replica**: The local SQLite database that holds synced rows, the outbox, and cursors.
- **Client IR**: The JSON schema description (SPEC §2.4) that typegen emits and `SyncClient` takes.
- **`HostTransport`**: The bundled blocking HTTP and WebSocket transport, behind `native-transport`.
:::

::::::steps
:::::step{title="Add the crate" time="2 min"}
The crate is on crates.io.

```toml title="Cargo.toml"
[dependencies]
syncular-client = { version = "0.0.0", features = ["native-transport"] }
```

Four features exist, all off by default so the core's dependency tree stays small:

- `native-transport`: `HostTransport`, a blocking HTTP client (`ureq`) and a WebSocket client (`tungstenite`) with a reader thread.
- `local-authority`: `HostTransport` routes sync rounds to an in-process local authority (`syncular-authority`, SPEC §12) when its config names `localAuthorityPath` ([Platform specifics](/platform-rust-specifics/#local-authority)).
- `crdt-yjs`: the native CRDT helpers `crdt_text`, `crdt_insert_text`, `crdt_delete_text`, and `crdt_apply_update` over `yrs`, wire-compatible with `@syncular/crdt-yjs`.
- `e2ee`: client-side encryption, installed with `set_encryption`.

::checkpoint[`cargo check` resolves `syncular-client` and its dependencies.]
:::::

:::::step{title="Build for wasm32 (optional)" time="2 min"}
`wasm32-unknown-unknown` is a supported target. `cargo check -p syncular-client --target wasm32-unknown-unknown` passes with and without `e2ee`, and rusqlite builds the replica on `sqlite-wasm-rs` for that target.

The host supplies three things the target cannot:

- A clock. Every timestamp the core reads comes from one function, and on this target it reads `Date.now()` through `js-sys` because `std::time::SystemTime::now()` panics there.
- A CSPRNG. The crate enables uuid's `js` feature and getrandom's JS backends (`0.2` under `js`, `0.4` under `wasm_js`), so the host must expose `crypto.getRandomValues`: a browser, a worker, or Node 19 and later. getrandom `0.3` is the one version that wants a `getrandom_backend` cfg flag instead; the crate does not depend on it, so no `RUSTFLAGS` are needed.
- A `Transport`. `native-transport` (`ureq`, `tungstenite`) does not build for this target, so implement the trait over `fetch` and a WebSocket. Leave `round_deadline` at its default `None`: the core anchors that budget on `std::time::Instant`, which this target does not have, and a transport that returns a budget fails the round with `sync.invalid_request` instead of panicking.

A wasm build is untested against a real server in this repository; the native gate is `cargo test`.

`sqlite-wasm-vfs` 0.2.0's `opfs-sahpool` reports a reserved lock unconditionally (`xCheckReservedLock` writes 1), so SQLite would skip hot-journal rollback after a worker is killed mid-commit. `syncular-client` wraps the VFS's `xOpen` before the first connection opens its file and makes the file methods report 0, which lets SQLite replay the journal. Install the VFS before opening the replica.

The core does not acquire a cross-context lock. A host that can have two documents or workers on one pool serializes them itself; the TypeScript binding takes a Web Lock keyed by the pool directory in `packages/web-client/src/wasm-database.ts`, and a Rust browser host needs the same guard.
:::::

:::::step{title="Get the schema" time="2 min"}
`SyncClient` takes the client IR as `serde_json::Value`. Run `syncular generate` to write `syncular.ir.json`, then load it ([Schema & typegen](/guide-schema/)). A Rust client and a TypeScript client can share one generated schema. A hand-written IR looks like this:

```rust title="src/main.rs"
let schema = serde_json::json!({
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
```

::checkpoint[`schema` parses; `open_path` validates it in the next step.]
:::::

:::::step{title="Open a replica" time="2 min"}
```rust title="src/main.rs"
use syncular_client::{ClientLimits, SyncClient};

let mut client = SyncClient::open_path(
    "device-1".to_owned(),      // stable client id
    &schema,
    ClientLimits::default(),
    "/path/to/syncular.db",     // persists across restarts
)?;
```

Constructors:

- `SyncClient::new(client_id, schema, limits)`: in-memory.
- `SyncClient::open_path(client_id, schema, limits, path)`: on-disk; `CREATE TABLE IF NOT EXISTS` makes a reopen reuse persisted rows.
- `SyncClient::open_path_with_identity(Option<client_id>, schema, limits, path)`: on-disk, and reuses the persisted client id when you pass `None`. On native targets it enables WAL after schema validation and fails with `sync.invalid_request` if WAL is unavailable, so an empty path or `:memory:` fails. On `wasm32-unknown-unknown` it accepts the sqlite-wasm worker's journal mode instead, because that VFS has no WAL and the wasm host has no independent snapshot reader.
- `SyncClient::with_connection(client_id, schema, limits, conn)`: your own fresh rusqlite `Connection`.
- `SyncClient::reset_replica(path)`: deletes a file replica and its `-journal`, `-wal`, and `-shm` files through the VFS. Close the client and any `FileQuerySnapshotReader` on that path first. Call it after `client.storage_corrupt`; the next open creates a fresh replica and re-bootstraps from the server. An OPFS SAH pool stores its files under opaque names, so this is the supported reset instead of deleting the pool directory.

Use a file path in an app. An in-memory replica loses the outbox on exit.

::checkpoint[`open_path` returns `Ok`, and the database file exists.]
:::::

:::::step{title="Write and sync" time="3 min"}
```rust title="src/main.rs"
use serde_json::{json, Map, Value};
use syncular_client::native_transport::HostTransport;
use syncular_client::{Mutation, SyncOutcome};

let mut transport = HostTransport::from_config(&json!({"baseUrl": "http://localhost:8787"}))?;
client.subscribe("todos".to_owned(), "todos".to_owned(),
    vec![("list_id".to_owned(), vec!["groceries".to_owned()])], None)?;

let mut values = Map::new();
values.insert("id".to_owned(), Value::from("t1"));
values.insert("list_id".to_owned(), Value::from("groceries"));
values.insert("title".to_owned(), Value::from("Buy milk"));
client.mutate(vec![Mutation::Upsert { table: "todos".to_owned(), values, base_version: None }])?;

match client.sync_until_idle(&mut transport, None) {
    SyncOutcome::Ok(report) => println!("pushed {}", report.pushed),
    other => eprintln!("sync did not finish: {other:?}"),
}
```

`baseUrl` is the server mount; `HostTransport` appends `/sync`, `/segments/{id}`, `/blobs/{id}`, and `/realtime`.

::checkpoint[The program prints `pushed 1`, and `client.pending_commit_ids()` is empty. Run `bun run clients` from the quickstart to read the row from a second client.]
:::::
::::::

Next: [Reads & writes](/platform-rust-reads-writes/).
