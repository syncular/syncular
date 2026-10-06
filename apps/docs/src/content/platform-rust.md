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

- `crdt-yjs`: the §5.10.5 native CRDT helpers (`crdt_text`,
  `crdt_insert_text`, `crdt_delete_text`, `crdt_apply_update`) over `yrs`,
  Yjs-wire-compatible with the web `@syncular/crdt-yjs` helper.
- `e2ee`: §5.11 client-side encryption (installed via `set_encryption`).

The wire codec lives in `syncular-ssp2` (library name `ssp2`, also
`0.0.0` on crates.io); it arrives as a dependency and you rarely need it
directly.

## The API shape

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
`open_path_with_identity` also persists the client identity and enables WAL
after schema validation. It checks SQLite's returned journal mode and fails
with `sync.invalid_request` if WAL is unavailable. Pass a persistent file
path; an empty path or `:memory:` cannot enter WAL mode.

## Transport gate

Call `client.set_transport_enabled(&mut transport, false)` before releasing
startup intents when the app has local authorization but no fresh bearer.
`transport_enabled()` reads this host-owned state. Local queries, mutations and
staged blobs continue; new sync rounds, realtime connects, presence sends and
uncached blob downloads refuse with `sync.offline` before invoking transport.
Reopening emits one interactive sync intent. Update the transport's headers
before reopening and let the existing host scheduler drain the queued commits.

The gate defaults open on each newly created core and is never persisted.
Security activation, header changes and schema resets retain its current value.
An already-prepared round retains its atomic apply and revocation checks.
A split-round host continues the captured exchange, applies it, then calls
`set_transport_enabled(&mut transport, false)` again if the gate is still closed
to release the socket. It sends no returned control frames and starts no
follow-up round while paused. Tauri implements this owner policy directly.

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

Final results are also journaled durably. `commit_outcome`, `commit_outcomes`,
and `resolve_commit_outcome` restore correction UI after restart and keep
active conflicts/rejections until the application explicitly resolves them.

For a validated device or key-revocation directive,
`purge_local_data(&input)` applies the same bounded, idempotent local cleanup as
the web and native bridges. Gate the affected subscriptions first; see
[Authorized local purge](/concepts-local-data-purge/).

## Generated named queries

Raw `query` remains available, but applications can generate typed Rust reads
from the same `.sql` and `.syql` files as the other clients. Add the Rust
output to `syncular.json`:

```json
{
  "output": {
    "ir": "./syncular.ir.json",
    "rust": {
      "queriesPath": "./src/syncular_queries.rs",
      "clientCrate": "syncular_client"
    }
  }
}
```

`clientCrate` is optional. Set it only when Cargo aliases the
`syncular-client` dependency. Then include the generated module and use the
query-specific API:

```rust
mod syncular_queries;

use syncular_queries::list_todos;

let mut params = list_todos::Params::new("groceries".to_owned());
params.page_size = Some(100);

let rows: Vec<list_todos::Row> = list_todos::run(&client, &params)?;
let view = list_todos::snapshot(&mut client, &params)?;
println!("revision={}, complete={}", view.revision, view.coverage.complete);
```

Generated snapshots pass the descriptor id and table dependencies as the read
owner. A failed read appears in `diagnostics_snapshot().query_failures` until
the same query reads successfully. The entry contains no SQL, parameters, rows,
or SQLite error prose. SQLite corruption and I/O failures use
`client.storage_corrupt`, `client.storage_io` and `client.storage_full`; every other read failure uses
`client.query_failed` in diagnostics.

The generated `select` function exposes the exact compiler-checked SQL and
positional values for diagnostics. `DESCRIPTOR` additionally carries the
QueryIR-hash identity, table and scope dependencies, `WindowCoverage`, and an
optional proven row-key function. A Rust host can combine those facts with
`drain_change_batches()` to build its own observer; codegen does not impose an
async runtime or UI framework.

SYQL `integer` is `i64`. Optional nullable inputs use
`SyqlPresence<Option<T>>`, preserving absent versus present `NULL`. Result
decoding accepts the core's lossless `$bigint` and `$bytes` envelopes and
returns a column-specific `QueryError` instead of dropping a malformed row.
Both the generated schema IR and `.rs` file are byte-gated by
`syncular generate --check`.

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

## Blob bytes

Use `fetch_blob_bytes` when a Rust host needs a complete attachment:

```rust
let blob = client.fetch_blob_bytes(&mut transport, &blob_ref)?;
assert_eq!(blob.byte_length, blob.bytes.len() as i64);
```

The returned `FetchedBlob` owns its `Vec<u8>`. Its bytes remain valid after
later client calls and after the client closes. The shared command router
encodes those bytes as `{"$bytes":"<lowercase-hex>"}` at the JSON boundary used
by the C ABI and native bindings.

## The `Transport` trait

You implement `syncular_client::Transport` and pass it to every
network-touching call. The required methods:

- `sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError>`: one
  combined push+pull round over `POST /sync` (or loopback).
- `realtime_sync(&mut self, request: &[u8])`: the same round over the
  connected realtime socket (§8.7); the host owns the WS framing.
- `download_segment(&mut self, request: &SegmentRequest)`: bootstrap
  segment fetch (§5.5).
- `realtime_connect` / `realtime_send` / `realtime_close`: the socket
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

## Native transport policy

The shared native transport (behind `syncular-client`'s
`native-transport` feature, re-exported by `syncular-ffi` and
`tauri-plugin-syncular`) bounds its network work through
`HostTransportPolicy`. The deadline and size fields are optional; their
defaults are unbounded. `redirects` defaults to `Deny`.

```rust
use std::time::Duration;
use syncular_client::native_transport::{HostTransportPolicy, RedirectPolicy};

let policy = HostTransportPolicy {
    request_timeout: Some(Duration::from_secs(20)),
    round_deadline: Some(Duration::from_secs(60)),
    max_request_bytes: Some(32 * 1024 * 1024),
    max_response_bytes: Some(32 * 1024 * 1024),
    redirects: RedirectPolicy::Deny,
};
```

- `request_timeout` bounds one HTTP request end to end. A bound that
  elapses returns `transport.timeout`.
- `round_deadline` bounds one sync round: uploads, continuations, the
  main request, every segment fetch, and a realtime round's socket send
  and wait. The client anchors it on the round's first network call and
  keeps the anchor across continuations. A bound that elapses returns
  `transport.timeout`.
- `max_request_bytes` refuses a larger HTTP request body before any
  network I/O with `transport.request_too_large`. It does not cap a
  realtime socket buffer.
- `max_response_bytes` refuses a larger decoded HTTP response body with
  `transport.response_too_large`. The count applies after decompression,
  and it does not cap a realtime socket buffer.
- `redirects` selects `Deny` (the default) or `Follow`. `Follow` follows
  a redirect only for a request with no configured headers, no base-URL
  userinfo, and no signed capability URL. A credential-bearing request is
  refused with `transport.redirect` under both policies. The WebSocket
  handshake obeys the same policy: a handshake may follow a redirect only
  when it carries no configured headers and its realtime URL has neither
  userinfo nor a query.

Build the transport with the policy through
`HostTransport::from_config_with_policy`, or replace it later with
`HostTransport::set_policy`. `SyncularCore::set_transport_policy` is the
same seam on the plugin core. A host that supplies JSON config (the
`new` command) sets the same fields with the keys `requestTimeoutMs`,
`roundDeadlineMs`, `maxRequestBytes`, `maxResponseBytes`, and `redirects`.
Each numeric bound is a `u64` integer token, so a binding that derives the
JSON from a floating-point value must serialize the bound losslessly.
An invalid policy is rejected with a `sync.invalid_request` message and
leaves the current policy in force.

The whole-round deadline covers network work. It does not interrupt local
SQLite or CPU time. Local work before the round's first network call does
not consume the budget; after the anchor the deadline is absolute, so local
work between continuations runs against the remaining budget.

## Realtime

The core has no callbacks. Connect with
`client.connect_realtime(&mut transport)?`, then feed inbound frames from
your socket reader into the core:

- `client.on_realtime_text(&text)`: JSON control messages.
- `client.on_realtime_binary(&mut transport, &bytes)`: binary delta frames.

Applied deltas update the local tables directly; `sync_needed()` flips when a
round is warranted. `disconnect_realtime` closes the lane. While the socket
is connected the core routes sync rounds through `Transport::realtime_sync`;
the connected socket carries the sync rounds themselves. See
[Realtime](/concepts-realtime/).

`set_realtime_policy(RealtimePolicy::Required)` designates the socket as the
sync path. While the socket is not connected, `sync` returns
`SyncOutcome::RealtimeUnavailable { state, reason_code, retry_delay_ms }`
without calling `Transport::sync`, and `realtime_state()` reports
`connecting`, `disconnected`, `lost`, `refused`, or `disabled`. The policy
defaults to `RealtimePolicy::Optional`, which keeps the HTTP round.

## Where to go next

- **[Embedding via C FFI](/platform-ffi/)**: this crate packaged as
  `libsyncular` with a five-function C ABI, plus the bundled native
  transport.
- **[Tauri](/platform-tauri/)**: a plugin that consumes this crate directly
  in a desktop app.
- **[Conformance](/guide-conformance/)**: the catalog that proves the Rust
  and TypeScript cores implement one protocol.
- **[Commits & the outbox](/concepts-commits/)**: what `mutate` and a sync
  round actually do.

## Live sync progress

`client.progress()` returns a cloneable observer that can be read from another
thread while the owning thread runs sync. Keep the subscription guard alive to
receive updates; dropping it unsubscribes without cancelling sync.

```rust
let observer = client.progress();
let subscription = observer.subscribe(|progress| {
    println!("{:?}: {} bytes, {} rows", progress.phase,
             progress.bytes_received, progress.rows_processed);
});
let outcome = client.sync(&mut transport);
let latest = observer.snapshot();
drop(subscription);
```

The observer immediately supplies its latest snapshot when one exists. Each
round gets a new `attempt`; retries reset counters and errors. `ProgressPhase`
is `Request`, `Download`, or `Import`. `ProgressState` is `Running`, `Complete`,
or `Failed`. Optional totals remain absent when unknown. `rows_processed` counts
work inside the import transaction; failure can roll it back. `Complete` follows
checkpoint persistence and read-model reconciliation for one round.

Custom `Transport::download_segment` and `Transport::fetch_url` implementations
now receive `&mut dyn FnMut(u64)` as their last argument. Report cumulative decoded
body bytes through it. Buffered transports can leave it unused; the core reports
the final count. The native HTTP transport reports intermediate download bytes.
Listeners run on the sync thread and should hand expensive work to the UI thread.

The JSON command surface exposes `progressSnapshot`. FFI hosts receive coalesced
`{ "type": "progress", "progress": { ... } }` events through `poll_event`, including
while a sync command is running. Tauri forwards the same event directly to its
webview. Camel-case JSON fields match the JavaScript progress API.


## Storage failures during import

A full local database reports `client.storage_full` with SQLite result code 13.
The failed sync outcome carries `details.sqliteCode` and `details.sqliteMessage`.
A failed rollback adds `details.rollbackFailure` with its own code and message.
The core keeps the first storage failure as the reported error and releases its
transaction state before the next import. After the host restores capacity, an
explicit sync can import the pending rows on the same connection.

## Structured authoring failures

`mutate` and `patch` return a `ClientError` instead of a string: a stable
`code`, a static `message`, optional `details`, and `retryable`. A verified
code identity is kept; a failure with no code identity reports `client.failed`.
When a legacy cause string embedded table or row values, the static message
carries the fixed text and `details.legacyCause` preserves the original.

A storage failure during authoring carries `details.sqliteCode` and
`details.sqliteMessage`, and a failed rollback adds `details.rollbackFailure`.
SQLite `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6), including extended codes,
report retryable `client.storage_busy`. Retry after resolving lock contention;
`SQLITE_LOCKED` can involve another statement on the same connection. The
other classified storage codes stay non-retryable.

Each authoring call classifies its own failure. A storage failure retained by
an earlier operation cannot classify a later call, so an unrelated validation
failure reports its own code. A failed authoring call leaves no outbox entry,
no visible row from the failed commit, and no local revision publication; a
retry after the fault clears enqueues the commit once. The command and FFI
boundaries forward `code`, `message`, `retryable`, and `details` to the host.
