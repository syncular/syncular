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

Three features exist, all off by default so the core's dependency tree stays small:

- `native-transport`: `HostTransport`, a blocking HTTP client (`ureq`) and a WebSocket client (`tungstenite`) with a reader thread.
- `crdt-yjs`: the native CRDT helpers `crdt_text`, `crdt_insert_text`, `crdt_delete_text`, and `crdt_apply_update` over `yrs`, wire-compatible with `@syncular/crdt-yjs`.
- `e2ee`: client-side encryption, installed with `set_encryption`.

::checkpoint[`cargo check` resolves `syncular-client` and its dependencies.]
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
- `SyncClient::open_path_with_identity(Option<client_id>, schema, limits, path)`: on-disk, enables WAL after schema validation, and reuses the persisted client id when you pass `None`. It fails with `sync.invalid_request` if WAL is unavailable, so an empty path or `:memory:` fails.
- `SyncClient::with_connection(client_id, schema, limits, conn)`: your own fresh rusqlite `Connection`.

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
