# Platform specifics (Rust)

Reference for hosts that implement or tune the pieces around `SyncClient`: the `Transport` trait, the native transport policy, live progress, authoring and storage failures, and the snapshot sidecar.

::meta{for="Rust host authors and maintainers of native bindings" time="15 minutes"}

:::note{title="Who reads this page"}
Most Rust hosts use `HostTransport` and never touch this page. Read it when you implement `Transport`, bound network work, or build a status or support surface.
:::

## The Transport trait

`syncular_client::Transport` is the seam to the network. The core never opens a socket; it calls the `&mut dyn Transport` you hand each network-touching method.

| Method | Required | Purpose |
|---|---|---|
| `sync(&mut self, request: &[u8])` | yes | One combined push and pull round (`POST /sync`, or loopback) |
| `realtime_sync(&mut self, request: &[u8])` | yes | The same round over the connected socket (SPEC §8.7); the host owns WebSocket framing |
| `download_segment(&mut self, request, on_progress)` | yes | Bootstrap segment fetch (SPEC §5.5) |
| `realtime_connect`, `realtime_send`, `realtime_close` | yes | Socket lifecycle and client-to-server control messages |
| `supports_url_fetch`, `fetch_url(url, on_progress)` | no | Signed-URL fetches; the default returns an error |
| `blob_upload`, `blob_download`, `blob_upload_grant`, `blob_put_url`, `fetch_blob_url` | no | Blob endpoints; the defaults return an error |
| `remote_operation` | no | The remote operation endpoint; the default returns `client.remote_operations_unconfigured` |
| `realtime_connect_for_client`, `round_deadline`, `set_round_deadline` | no | Per-client connect and the round deadline hooks |

`download_segment` and `fetch_url` receive `&mut dyn FnMut(u64)` as their last argument. Report cumulative decoded body bytes through it. A buffered transport can leave it unused; the core then reports the final count. `HostTransport` reports intermediate download bytes.

`HostTransport` (behind `native-transport`) is the reference implementation: blocking HTTP through `ureq` and a `tungstenite` realtime socket with a reader thread. See [`native_transport.rs`](https://github.com/syncular/syncular/blob/main/rust/crates/client/src/native_transport.rs). The FFI and the Tauri plugin share it. If your host already owns an HTTP client, implement the trait over it.

## Native transport policy

`HostTransportPolicy` bounds the network work of `HostTransport`. The deadline and size fields are optional and default to unbounded; `redirects` defaults to `Deny`.

:::figure{title="Which bound covers what" note="Round deadline anchors on the first network call"}
<div class="d-stack">
<div class="node cool"><span class="t">round_deadline</span>uploads, continuations, main request, every segment fetch, a realtime round's send and wait</div>
<div class="node"><span class="t">request_timeout</span>one HTTP request, end to end</div>
<div class="node"><span class="t">max_request_bytes / max_response_bytes</span>one HTTP body, checked before I/O and after decompression</div>
</div>
:::

```rust title="src/main.rs"
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

- `request_timeout`: a bound that elapses returns `transport.timeout`.
- `round_deadline`: the client anchors it on the round's first network call and keeps the anchor across continuations. A bound that elapses returns `transport.timeout`. It covers network work only; local SQLite and CPU time are not interrupted. Local work before the first network call does not consume the budget, and local work between continuations runs against the remaining budget.
- `max_request_bytes`: a larger HTTP request body is refused before any network I/O with `transport.request_too_large`. It does not cap a realtime socket buffer.
- `max_response_bytes`: a larger decoded response body is refused with `transport.response_too_large`, counted after decompression. It does not cap a realtime socket buffer.
- `redirects`: `Deny` or `Follow`. `Follow` follows a redirect only for a request with no configured headers, no base-URL userinfo, and no signed capability URL. A credential-bearing request is refused with `transport.redirect` under both policies. The WebSocket handshake obeys the same rule and additionally refuses a realtime URL with userinfo or a query.

Build the transport with `HostTransport::from_config_with_policy`, or replace the policy with `HostTransport::set_policy`. A JSON config (the `new` command) sets the same fields with `requestTimeoutMs`, `roundDeadlineMs`, `maxRequestBytes`, `maxResponseBytes`, and `redirects`. Each numeric bound is a `u64` token of at least 1, so a binding that derives the JSON from a floating-point value must serialize the bound losslessly. An invalid policy fails with `sync.invalid_request` and leaves the current policy in force.

## Live progress

`client.progress()` returns a cloneable observer that another thread can read while the owning thread runs sync. Keep the subscription guard alive to receive updates; dropping it unsubscribes without cancelling sync.

```rust title="src/main.rs"
let observer = client.progress();
let subscription = observer.subscribe(|progress| {
    println!("{:?}: {} bytes, {} rows", progress.phase,
             progress.bytes_received, progress.rows_processed);
});
let outcome = client.sync(&mut transport);
let latest = observer.snapshot();
drop(subscription);
```

The observer supplies its latest snapshot on subscribe when one exists. Each round gets a new `attempt`, and retries reset counters and errors. `ProgressPhase` is `Request`, `Download`, or `Import`; `ProgressState` is `Running`, `Complete`, or `Failed`. Totals stay absent when unknown. `rows_processed` counts work inside the import transaction, and a failure can roll it back. `Complete` follows checkpoint persistence and read-model reconciliation for the round. Listeners run on the sync thread, so hand expensive work to the UI thread.

The command surface exposes `progressSnapshot`. FFI hosts receive coalesced `{"type": "progress", "progress": {...}}` events through `poll_event`, also while a sync command runs; the queue keeps only the newest. Tauri forwards the same event to its webview. The JSON fields are camelCase, matching the JavaScript progress API.

## Structured authoring failures

`mutate` and `patch` return a `ClientError`: a stable `code`, a static `message`, optional `details`, and `retryable`. A failure with no code identity reports `client.failed`. When a legacy cause string embedded table or row values, the static message carries fixed text and `details.legacyCause` preserves the original.

Both validate the caller's values before recording anything. These report `sync.invalid_request` with the fixed message `the authoring request is invalid` and the dynamic cause in `details.legacyCause`:

- an unknown column or an internal `_sync_` column;
- a value whose JSON form does not match the column type;
- an absent required column in a full-row upsert;
- a primary key the wire cannot render.

A rejected call preserves the outbox, the optimistic rows, and the local revision. `SyncRemoteClient::prepare_commit` classifies the same failures with the same code.

Two rules decide whether a value survives the outbox form. A `bytes` or `crdt` column accepts only the envelope `{"$bytes": "<hex>"}` with exactly one `$bytes` key holding hexadecimal digit pairs; uppercase is accepted and encoders emit lowercase. A `float` column accepts a finite number, because JSON serialization turns `NaN` and infinities into `null`. An explicit `null` is a nullability question: a nullable column accepts it, and a non-nullable column reports the required-column failure.

A commit persisted with a value the current codec refuses (a formerly tolerated envelope or declared type) leaves the outbox at the startup or reset reconciliation boundary, inside that boundary's transaction, as a rejection with code `sync.outbox_incompatible`, the static message `the persisted commit carries values the current codec refuses`, and `details.reason` of `invalid_stored_values`. The recovery runs before any replay, so the commit reads as rejected right after open and later commits still drain. A commit naming a table the schema removed keeps the send-time classification. An unresolved encryption key is never this recovery: keys may be configured after open, so key resolution stays with the send seam.

Each authoring call classifies its own failure; a storage failure retained from an earlier operation cannot classify a later call. A failed call leaves no outbox entry, no visible row, and no local revision publication, and a retry after the fault clears enqueues the commit once. The command and FFI boundaries forward `code`, `message`, `retryable`, and `details` to the host.

## Storage failures

A full local database reports `client.storage_full` with SQLite result code 13. The failed outcome carries `details.sqliteCode` and `details.sqliteMessage`; a failed rollback adds `details.rollbackFailure` with its own code and message. The core keeps the first storage failure as the reported error and releases its transaction state before the next import. After the host restores capacity, an explicit sync imports the pending rows on the same connection.

`SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6), including extended codes, report retryable `client.storage_busy`; `SQLITE_LOCKED` can involve another statement on the same connection. The other classified storage codes (`client.storage_corrupt`, `client.storage_io`, `client.storage_full`) are not retryable.

## Snapshot read sidecar

A file-backed replica exposes `FileQuerySnapshotReader`, a read-only SQLite connection independent of the mutable core owner. `snapshot_read` resolves one request in a single read transaction and returns the local revision, the rows of every requested read-only statement, the requested window coverage, the requested subscription catch-up states, and the requested commit deliveries. Every statement passes the read-only guard, and a failure in any statement rolls the whole read back and releases the connection. `SyncClient::snapshot_read` returns the same shape on the owner connection, so an in-memory replica and the command surface share one contract. `subscription_catchup(id)` and `commit_delivery(id)` are one-entry reads.

```rust title="src/main.rs"
use syncular_client::{FileQuerySnapshotReader, SnapshotReadRequest, SnapshotStatement};

let mut reader = FileQuerySnapshotReader::new("/path/to/syncular.db");
let read = reader.snapshot_read(&SnapshotReadRequest {
    statements: vec![SnapshotStatement { sql: "SELECT id FROM todos ORDER BY id", params: &[] }],
    coverage: &[],
    subscriptions: vec!["todos".to_owned()],
    commit_ids: vec![commit_id.clone()],
})?;
```

A subscription catch-up state is `unknown` when the client does not hold the subscription. Otherwise it is `known` with the persisted status (`active`, `revoked`, or `failed`; a reset stays `active` with `cursor < 0` and a reason code), the cursor, `hasResumeToken`, and two derived fields. `bootstrapComplete` is true only for an `active` subscription with `cursor >= 0` and no resume token. `knownPendingPages` is true for an `active` subscription while a resume token remains or `cursor < 0`. Both name local progress and say nothing about server freshness.

A commit delivery is `pending` while the id has an outbox entry, otherwise the persisted retained outcome, otherwise `unknown`. The sidecar reports the persisted outcome fields (status, every result with its conflict or rejection code, the retained operation envelope, and the resolution) and omits the owner-derived `retainedRows` images. Invalid SQLite metadata types (including BLOB where text is required), invalid stored field types, fractional indexes or versions, unsafe integer metadata, malformed conflict columns, invalid rejection details, contradictory outcome statuses, and malformed stored operations fail with `sync.local_corrupt`. Stored upserts require row values and stored deletes omit them. Security purges clear results and retained operations while keeping the outcome status readable. Subscription effective scopes must be absent or map scope names to arrays of strings.

`local_revision` reads the durable revision without a dummy query; a non-canonical marker fails with `sync.local_corrupt` instead of reading as zero, and the `localRevision` command fails the same way. The TypeScript core exposes `SyncClient.snapshotRead`, `subscriptionCatchup`, and `commitDelivery` over the same one-transaction contract. Tauri exposes the read as `syncular_snapshot_read` and the bridge method `snapshotRead`.
