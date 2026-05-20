# syncular-testkit

Rust-first testing utilities for Syncular apps and SDK bindings.

The crate mirrors the value of `@syncular/testkit`: tests should use real SQLite
stores, generated app schema metadata, scripted transports, fault injection, and
assertions instead of mocking Syncular internals.

Initial scope:

- `TempDbPath` for disposable SQLite databases, including `-wal`, `-shm`, and
  `-journal` cleanup.
- `TestTransport` for in-process sync, websocket, auth-header, chunk, and blob
  assertions, including static and request-dependent scripted responses.
- `TestSyncServer` for disposable HTTP sync endpoints in native/client tests.
- `AppTestServer` for stateful generated-schema app tests: it stores rows,
  applies pushed commits, returns later pull snapshots/commits, merges
  server-merge CRDT/Yjs payloads, filters self commits, can reverse/duplicate
  delivery, and emits realtime sync wakeups.
- `AppTestHttpServer` for stateful HTTP/WebSocket app tests over the production
  native transport shape.
- `TestBlobServer` for local HTTP blob upload/download integration tests.
- `FaultTransport` for scripted transport failures and latency.
- Protocol builders for snapshot pages/chunks, pull commits, conflict,
  revoked, schema-required/latest, and not-ok server responses.
- `AppFixture` helpers that accept a generated `AppSchema` from consuming apps,
  including file-backed temp DBs and Rust-only in-memory DBs.
- `TodoFixture` helpers backed by the generated todo schema and Diesel SQLite.
- Native fixture helpers for opening real `NativeSyncularClient` instances with
  embedded schema JSON or direct app schemas, plus event waiters.
- CRDT field helpers for applying text updates and asserting materialized
  Rust/native field values.
- Assertions for outbox, conflicts, blob queue, and blob cache state.

## App Usage

Add the local testkit crate as a dev dependency while testing against this
workspace:

```toml
[dev-dependencies]
syncular-testkit = { path = "/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/crates/testkit" }
syncular-runtime = { path = "/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/crates/runtime" }
```

Use your generated app schema, not the repo todo fixture:

```rust
use syncular_testkit::{
    assert_outbox_statuses, assert_table_row_count, open_app_client,
    snapshot_combined_response,
};

#[test]
fn syncs_remote_rows_without_mocking_syncular() {
    let mut fixture = open_app_client(my_app::generated::app_schema()).unwrap();

    fixture.transport.push_http_response(snapshot_combined_response(
        "sub-notes",
        "notes",
        vec![serde_json::json!({
            "id": "note-1",
            "title": "Remote note",
            "owner_id": "user-rust",
            "server_version": 1
        })],
        syncular_testkit::actor_project_scopes("user-rust", None),
        1,
    ));

    fixture.client.sync_http().unwrap();
    assert_table_row_count(&mut fixture.client, "notes", 1);
    assert_outbox_statuses(&mut fixture.client, &[]);
}
```

For multi-client app behavior, use `AppTestServer`. It is generic over the
generated `AppSchema`, so app-specific tests only need to provide seed rows and
assert app-specific fields:

```rust
use syncular_testkit::{
    AppFixtureOptions, AppTestServer, assert_table_has_row,
    open_app_client_with_server,
};

#[test]
fn two_clients_sync_through_stateful_test_server() {
    let app_schema = my_app::generated::app_schema();
    let server = AppTestServer::new(app_schema);

    let mut writer = open_app_client_with_server(
        app_schema,
        server.clone(),
        AppFixtureOptions {
            client_id: "writer".to_string(),
            ..AppFixtureOptions::default()
        },
    ).unwrap();
    let mut reader = open_app_client_with_server(
        app_schema,
        server.clone(),
        AppFixtureOptions {
            client_id: "reader".to_string(),
            ..AppFixtureOptions::default()
        },
    ).unwrap();

    writer.client.apply_mutation_json(
        &serde_json::json!({
            "table": "notes",
            "row_id": "note-1",
            "op": "upsert",
            "payload": { "title": "From writer", "owner_id": "user-rust" },
            "base_version": 0
        }).to_string(),
        None,
    ).unwrap();
    writer.client.sync_http().unwrap();

    reader.client.sync_http().unwrap();
    assert_table_has_row(&mut reader.client, "notes", "id", "note-1");
}
```

For binding or app-shell tests that need the production HTTP/WebSocket transport
shape, wrap the same stateful server in `AppTestHttpServer`:

```rust
use syncular_runtime::transport::{HttpSyncTransport, SyncTransportConfig};
use syncular_testkit::{
    AppFixtureOptions, AppTestHttpServer, assert_table_has_row,
    open_app_client_with_transport,
};

#[test]
fn syncs_against_stateful_http_server() {
    let app_schema = my_app::generated::app_schema();
    let server = AppTestHttpServer::start(app_schema).unwrap();
    let options = AppFixtureOptions {
        base_url: server.url(),
        client_id: "reader".to_string(),
        ..AppFixtureOptions::default()
    };
    let transport = HttpSyncTransport::new(SyncTransportConfig::new(
        options.base_url.clone(),
        options.client_id.clone(),
        options.actor_id.clone(),
    ));
    let mut fixture =
        open_app_client_with_transport(app_schema, transport, options).unwrap();

    server.app_server().commit_row("notes", serde_json::json!({
        "id": "note-1",
        "title": "Server note",
        "owner_id": "user-rust"
    })).unwrap();

    fixture.client.sync_http().unwrap();
    assert_table_has_row(&mut fixture.client, "notes", "id", "note-1");
}
```

For native-style tests, open a real native client with the same generated schema
or with generated schema JSON:

```rust
use std::time::Duration;
use syncular_runtime::native::NativeEventKind;
use syncular_testkit::{
    open_native_client_with_schema, wait_native_event, assert_native_rows_changed,
};

#[test]
fn native_local_write_emits_rows_changed() {
    let mut fixture = open_native_client_with_schema(my_app::generated::app_schema()).unwrap();

    fixture.client.apply_mutation_json(
        &serde_json::json!({
            "table": "notes",
            "row_id": "note-1",
            "op": "upsert",
            "payload": { "title": "Draft", "owner_id": "user-rust" },
            "base_version": 0
        }).to_string(),
        None,
    ).unwrap();

    let event = wait_native_event(
        &fixture.client,
        NativeEventKind::RowsChanged,
        Duration::from_secs(1),
    );
    assert_native_rows_changed(&event, &["notes"]);
    fixture.close().unwrap();
}
```

For host/HTTP integration tests, use `TestSyncServer` instead of standing up a
production server:

```rust
use syncular_testkit::{TestSyncServer, empty_success_response};

let server = TestSyncServer::spawn([empty_success_response()]).unwrap();
let base_url = server.url();
```

For request-dependent protocol cases, queue a response function. This is useful
for push conflicts or duplicate acknowledgements where the response needs the
client commit id from the actual request:

```rust
use syncular_testkit::{push_conflict_response, todo_task_row};

fixture.transport.push_http_response_fn(|request| {
    Ok(push_conflict_response(
        request,
        "version conflict",
        "VERSION_CONFLICT",
        todo_task_row("note-1", "Server row", 9),
        9,
    ))
});
```

Reusable runtime test patterns that should move here over time:

- `protocol_contract.rs`: most generic protocol scripting now uses
  `TestTransport`, protocol builders, and `FaultTransport`. The remaining local
  mock is intentionally scoped to encrypted row/chunk/blob fixtures and
  lock-reentrancy tests.
- `native_facade.rs` / `native_ffi.rs`: temp database paths, todo app schema JSON
  setup, native event waiters, and generated row assertions.
- `blob_transport.rs`: blob queue/cache assertions and local HTTP blob transport.
- `crdt_field.rs`: remaining encrypted CRDT system-table fixtures and
  ciphertext roundtrip assertions. Server-merge convergence fixtures now use
  `AppTestServer`.
- `store_backends.rs`: generic backend parity sync fixtures now use
  `TestTransport` and protocol builders. The remaining local transports are
  encrypted CRDT system-table fixtures.
