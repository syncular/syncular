# syncular-runtime

This is the shared Rust runtime foundation for Syncular's SQLite-backed native
and browser clients. The developer-facing Rust SDK package lives in
`rust/crates/client` as `syncular-client` and re-exports this runtime.

The native path intentionally uses Diesel for local SQLite access:

- Diesel-backed app-table adapters and generated typed query modules
- Diesel-managed internal sync tables
- SQL migrations as schema source of truth
- generated, checked-in Diesel schema from SQLite migration introspection
- HTTP protocol with `reqwest`
- serde protocol structs

The current goal is to keep the foundation small and reliable while proving
that a Rust/Diesel client can:

1. write to local SQLite
2. enqueue a Syncular outbox operation
3. push over HTTP
4. pull snapshots/commits
5. apply remote rows locally
6. connect to Syncular WebSocket realtime and pull after `sync` wake-ups

## Shape

The Rust runtime is split into SDK-shaped modules while preserving stable public
module names:

- `src/core`: sync orchestration, wire protocol types, worker lifecycle, and SDK errors
- `src/storage`: storage traits plus Diesel and rusqlite SQLite implementations
- `src/transport`: native HTTP, snapshot chunk, and WebSocket transport
- `src/native`: binding-oriented facade and narrow C ABI
- `src/bindings`: generated-binding surfaces such as BoltFFI
- `src/fixtures/todo`: checked-in todo-app fixture output and demo helpers used
  by runtime tests and the CLI demo feature

That keeps the Rust SDK/CLI thin while leaving a reusable core behind
Swift/Kotlin/TypeScript bindings or a different storage/transport adapter.
rusqlite remains useful as a fixture/test parity backend, but Diesel is the
supported native SQLite store. Browser/WASM uses Rust-owned SQLite through
`sqlite-wasm-rs`/`sqlite-wasm-vfs` instead of a JavaScript host store.

Feature flags now make that boundary explicit:

- default features build the native runtime, Diesel storage, native
  HTTP/WebSocket transport, native facade, C ABI, and BoltFFI surface
- `native` owns Diesel/rusqlite storage, reqwest/tungstenite transport, generated
  Diesel table adapters, and native binding surfaces
- `boltffi-bindings` owns the cross-language BoltFFI export surface
- `web-transport` owns browser `fetch`/`WebSocket` primitives for
  `wasm32-unknown-unknown`
- `web-client` owns the first async browser facade and async store boundary over
  `web-transport`
- `web-store` owns the first wasm-only persistent-store integration boundary,
  currently a legacy JavaScript-hosted Promise bridge used by parity tests
- `syncular-client` owns the demo command-line binary and depends on this
  runtime's `native` feature
- `syncular-codegen` owns the schema generator binary
- `--no-default-features --lib` builds the protocol/orchestration/trait layer
  without native storage or networking, and checks for `wasm32-unknown-unknown`

`web-transport` exposes an async browser transport surface. Browser networking
cannot implement the blocking native `SyncTransport` trait directly, so a future
browser client/facade should drive the async transport plus a web storage
backend.
`web-client` adds `WebSyncularClient`, `AsyncWebStore`, and `WebMemoryStore`.
The client performs async push/pull requests, fetches snapshot chunks, applies
snapshots/commits through the async store, and returns JSON-friendly
changed-table/subscription results. The async store boundary now includes local
operation application, pending outbox status transitions, conflict summaries,
manual conflict resolution, and keep-local conflict retry. `WebMemoryStore` is a
testable placeholder for the eventual OPFS/sqlite-wasm or JS-hosted persistent
store.

`web-store` adds `WebHostStore`, a wasm-only adapter that implements
`AsyncWebStore` by delegating to a JavaScript object. That path is legacy
scaffolding for parity tests and custom experiments; the browser product
direction is Rust-owned SQLite. The host object must return Promises from these
methods. The runtime tests keep a local `createSyncularWebStoreHost()` fixture
backed by a Kysely SQLite database:

```ts
type SyncularWebStoreHost = {
  applyLocalOperation(operation: SyncOperation, localRow: unknown | null): Promise<string>
  pendingOutbox(limit: number): Promise<OutboxCommit[]>
  markOutboxSending(rowId: string): Promise<void>
  markOutboxAcked(rowId: string, response: PushCommitResponse): Promise<void>
  markOutboxFailed(rowId: string, error: string, response: PushCommitResponse): Promise<void>
  insertConflict(outbox: OutboxCommit, result: OperationResult): Promise<void>
  conflictSummaries(): Promise<ConflictSummary[]>
  resolveConflict(id: string, resolution: string): Promise<void>
  retryConflictKeepLocal(id: string): Promise<string>
  subscriptionState(subscriptionId: string): Promise<WebSubscriptionState | null>
  upsertSubscriptionState(state: WebSubscriptionState): Promise<void>
  deleteSubscriptionState(subscriptionId: string): Promise<void>
  clearTableForScopes(table: string, scopes: Record<string, unknown>): Promise<void>
  upsertRow(table: string, row: unknown): Promise<void>
  applyChange(change: SyncChange): Promise<void>
  listTableJson(table: string): Promise<string>
}
```

When compiled for `wasm32-unknown-unknown` with `--features web-owned-sqlite`,
the crate exports `openSyncularRustOwnedSqlite()` and
`openSyncularRustOwnedSqliteClient()` through `wasm-bindgen`. This is now the
package default for browser Rust work: SQLite is opened from Rust through
`sqlite-wasm-rs` and `sqlite-wasm-vfs`, Kysely forwards compiled SQL into that
same handle, and sync/local writes/live-query invalidation all share one Rust
store. The older `web-store` feature can still export `SyncularWasmClient` for a
JavaScript host-store bridge, but that path is legacy scaffolding rather than
the browser product direction.

`sqlite-wasm-rs` compiles SQLite C code for `wasm32-unknown-unknown`, so local
Mac builds need a clang with the wasm backend. The browser runtime server uses
`CC_wasm32_unknown_unknown` when provided and falls back to common Homebrew LLVM
paths. Apple clang alone is not enough.

The browser runtime suite builds the package-owned development artifact with:

```bash
bun --cwd rust/bindings/browser run build:wasm:dev
```

Package builds use the release artifact:

```bash
bun --cwd rust/bindings/browser run build:wasm
```

Both commands compile this crate with `web-owned-sqlite` and place the
wasm-bindgen glue plus `.wasm` file under
`rust/bindings/browser/dist/wasm`. The v2 TypeScript wrapper loads those files
inside a dedicated browser Worker by default, so app code normally does not pass
explicit module or asset URLs. Omitting browser `storage` opens Rust-owned
SQLite through OPFS SAH first; if the browser cannot create the sync access
handle, the Worker client retries IndexedDB and reports that fallback through
`runtimeInfo().storageFallback`.

The WASM entrypoint installs a panic hook so unexpected Rust panics are reported
to the browser console with Syncular context. Normal Rust errors cross the
`wasm-bindgen` boundary as JavaScript `Error` objects with `syncularKind` and
`syncularDebug` properties for worker-side diagnostics.
The browser Worker passes an `AbortSignal` into Rust for long sync/blob
requests, so request timeouts can abort fetches and snapshot chunk downloads
instead of only ignoring the eventual response.

That packaged client is smoke-tested in Chromium through the generated
OPFS-first v2 Worker path, Kysely/live queries over Rust-owned SQLite, and a
local operation -> push -> pull flow over the existing Syncular HTTP server. The
browser suite still keeps separate wa-sqlite, IndexedDB, and host-store contract
checks for parity, but those do not define the packaged Rust client artifact.

The first native-facing facade is `NativeSyncularClient`. It deliberately uses
Diesel as the default storage backend, starts a background `SyncWorker`, and
coalesces sync triggers after local writes. rusqlite remains useful as a
trait-boundary/parity backend, but it is not the native default.
The C ABI catches Rust panics at exported boundaries and returns structured
`Internal` errors through `error_out` instead of unwinding into Swift/Kotlin/C.
Native hosts receive binding-safe events from the native event stream:
`SyncCompleted`, `SyncFailed` with structured `{ kind, message, debug? }` error
info, or `RowsChanged` with affected table names and additive `changedRows`
row/field summaries. Local writes emit `RowsChanged` immediately. Successful
syncs return a `SyncReport`: if the server changed app tables, the stream emits
`SyncCompleted` followed by `RowsChanged` for the actual affected generated
tables. Both events include the same generic row deltas when Syncular can
determine them: table, row id, insert/update/delete operation, changed fields,
CRDT/Yjs state fields, subscription id, server version, and commit metadata.
The JSON payload for row events also includes a generic `source` (`localWrite`
or `remotePull`), so app bridges can update active documents, sidebars, and
conflict UI without guessing from table names. Sync-created conflicts, conflict
resolution, and keep-local retry emit `ConflictsChanged`. C hosts subscribe with
`syncular_native_client_subscribe_events_json(...)`; BoltFFI hosts use
`startEventStream(capacity)`, read ordered JSON events with `nextEventJson()`
from a background task, and close the stream with `closeEventStream()`.
Rust hosts that wrap `SyncWorker` directly can use the same event source without
going through `NativeSyncularClient`:

```rust
use syncular_runtime::native::NativeWorkerEventConverter;
use syncular_runtime::worker::SyncWorker;

let worker = SyncWorker::start(client);
let events = worker.subscribe_events(256);
let converter = NativeWorkerEventConverter::new();

while let Some(worker_event) = events.next_event() {
    for native_event_json in converter.convert_json(worker_event)? {
        // Forward the stable NativeEvent JSON shape to the app bridge.
    }
}
```

`subscribe_events` is fan-out: each subscriber receives its own copy of worker
events. The queue is bounded per subscriber; if a subscriber stops draining,
Syncular emits `EventsOverflowed` with `droppedCount` and
`resyncRequired=true`, then closes that overflowing subscription after the
event is delivered. Generated clients must treat that as event-stream loss:
discard the subscription, subscribe again, trigger sync if appropriate, and
refresh live queries from SQLite before trusting incremental events again. The
worker never blocks sync or local writes on a slow event consumer.
For generated host wrappers, `app_tables_json` lists generated app tables and
`query_json(request)` executes read-only SQL/query-builder output against
declared generated app-table dependencies while rejecting internal tables and
mutating SQL. Native `query_json` uses a read-only SQLite connection with a
bounded prepared-statement cache keyed by SQL, schema version, and declared
table dependencies. `list_table_json(table)` still exists as a low-level
debugging and compatibility helper, but generated app clients should prefer
typed query builders that feed `query_json`. `apply_mutation_json(mutation, localRow)`
accepts Syncular mutation JSON, applies it locally against a generated app
table, enqueues it in the outbox, emits `RowsChanged`, and optionally triggers
sync. `apply_local_operation_json` remains as the compatibility alias for older
wrappers, but generated app clients should use mutation naming.
`native_ffi` adds a narrow C ABI over the same facade: JSON config in, opaque
handle out, explicit string free, JSON reads/callback events, and the same JSON error
payloads as native events. `rust/bindings/c/syncular_native.h` remains a
low-level ABI and debugging artifact.

The primary native binding direction is BoltFFI. `boltffi.toml` defines the
Swift, Android/Kotlin, and JVM targets, and `src/bindings/boltffi.rs` exposes a
JSON-oriented Syncular client boundary over `NativeSyncularClient`. Methods that
can fail return encoded `Result` payloads; constructor failures are made
available through `syncularTakeLastOpenError()` because BoltFFI 0.24 object
constructors return nullable handles. Browser support is deliberately packaged
through `rust/bindings/browser` with wasm-bindgen, the dedicated Worker,
Rust-owned SQLite, and the custom Kysely dialect; it is not a BoltFFI WASM
target. The explicit Syncular lifecycle method is named `shutdown()` in the
BoltFFI surface so Kotlin/Java can reserve `AutoCloseable.close()` for generated
handle disposal.

Wrappers can call `syncular_runtime_manifest_json()` before opening a database
to verify ABI version, crate version, generated schema version, Diesel-backed
native storage, transport capabilities, and generated app-table metadata.
Native apps can update sync auth with `set_auth_headers_json` /
`syncular_native_client_set_auth_headers_json`; the headers are applied to the
foreground writer and the background sync worker before subsequent HTTP sync
requests. Generated/native wrappers should expose this as `setAuthHeaders`.
HTTP 401/403 sync failures are normalized to `AuthExpired` native events that
carry the original sync `command_id`, allowing hosts to refresh headers and
retry without reopening the native client.
Native apps that open with injected app schema JSON can update subscriptions
with `set_subscriptions_json` /
`syncular_native_client_set_subscriptions_json` before sync. Generated
Swift/Kotlin app clients emit `SyncularSubscriptionSpec`, per-table
subscription helpers, and `syncularSubscriptionsJson(...)` so UI shells do not
hand-roll subscription JSON.
Native apps can also call `compact_storage_json` /
`syncular_native_client_compact_storage_json` to prune old acked outbox rows,
resolved conflicts, optional failed blob uploads, optional inactive
subscription state, blob cache bytes, and server-version-bounded tombstones.
Tombstones require an explicit `maxTombstoneServerVersion`; age-based tombstone
cleanup is deliberately not enough.
For large native blob files, `store_blob_file_json` accepts
`{"cacheLocal":false,"immediate":true}` to hash and upload the file as a stream
without writing the blob body into local SQLite. Retrieval has a matching
`retrieve_blob_file_with_options` / `retrieveBlobFile(..., optionsJson:)` path
with `{"cacheLocal":false}` that streams the remote body to a temp file,
validates the digest, and renames it into place.
`syncular-codegen` emits app-specific native scaffolds into the consuming app.
In this repo the example app owns them under `rust/examples/todo-app/generated`:
Swift and Kotlin row/input/patch shapes, runtime manifest checks, Syncular
operation builders, typed query-builder adapters, and tiny host-client
protocols/interfaces over `applyMutationJson` and `queryJson`. Those files
deliberately avoid predefined read queries and untyped table constants.
The example also includes local native generated-client smokes. They first
compile and run generated Swift/Kotlin app clients against mock generic native
clients, then build the Rust runtime dylib, link generated Swift through
BoltFFI, package the JVM native library, and run generated Kotlin through the
actual Kotlin/JNI binding against a real local SQLite database. The same smoke
then starts a local Hono sync server and proves Swift plus Kotlin/JVM can set
auth, set generated subscriptions, receive command-correlated `AuthExpired` for
stale auth, refresh headers on the hot worker, enqueue sync, receive
`SyncCompleted`, and query pulled rows. It also pushes generated task mutations,
pushes one generated mutation through the WebSocket transport, resolves a
Hono-backed version conflict with keep-local retry, clears non-retry conflicts
with keep-server/dismiss, and pulls those rows into a second native client:

```bash
bun run rust:native-smoke
```

The crate is configured to build `rlib`, `staticlib`, and `cdylib` artifacts.
Native BoltFFI packaging should use the repo-owned packaging script so Swift
headers, Swift wrappers, Android Kotlin wrappers, JNI glue, and native
libraries are regenerated together:

```bash
bash rust/scripts/package-native-bindings.sh --all
```

The script writes to `.context/native-packages` by default. See
`rust/docs/reference/NATIVE_PACKAGING.md` for output layout, Android SDK/NDK
environment variables, targeted `--apple` / `--android` / `--java` commands,
Linux JVM cross-packaging notes, SwiftPM checksums, and the Android AAR/Maven
publication flow.
Android packaging requires bundled SQLite, so `native` enables
`libsqlite3-sys/bundled` instead of linking a device/sysroot `sqlite3`.

Reusable runtime APIs return `syncular_runtime::error::Result<T>`.
`SyncularError::kind()` currently distinguishes config, storage, transport,
protocol, schema, codegen, and internal failures. The CLI and schema generator
still use `anyhow` at their executable boundaries.

The CLI and native facade default to the Diesel store. Use `--store rusqlite`
only when validating the alternate storage backend:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --store rusqlite \
  --base-url http://127.0.0.1:65024/sync \
  --db .context/syncular-rusqlite-poc.sqlite \
  --actor-id user-rust \
  --project-id p0 \
  sync-ws
```

Both stores apply embedded SQL migrations and record applied versions in the
local `sync_migrations` table. Inspect migration state with:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --store rusqlite \
  --db .context/syncular-rusqlite-poc.sqlite \
  migrations
```

New local writes also stamp each outbox commit with the embedded schema version
from `src/migrations.rs`. Inspect queued commits with:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --store rusqlite \
  --db .context/syncular-rusqlite-poc.sqlite \
  outbox
```

Before a sync sends pending commits, the client validates that queued schema
versions are valid for the current binary and the Syncular protocol
(`schemaVersion >= 1`). Older commit schema versions are allowed so the server
can run inbound transforms; future or invalid versions fail with
`ErrorKind::Schema` before the row is marked as sending.

The native HTTP transport also sends `x-syncular-schema-version` with
`current_schema_version()` on sync requests, and WebSocket connections send the
same value as both a header and `schemaVersion` query parameter. Servers may
optionally include `requiredSchemaVersion` and `latestSchemaVersion` on combined
sync responses. A `requiredSchemaVersion` newer than this binary is rejected as
`ErrorKind::Schema`; a newer `latestSchemaVersion` is advisory and tolerated so
compatible rolling upgrades can continue.

Rejected operations that return conflict or error results are stored in
`sync_conflicts`. Inspect them with:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --store rusqlite \
  --db .context/syncular-rusqlite-poc.sqlite \
  conflicts
```

Resolve a pending conflict by marking it with a strategy string:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --store rusqlite \
  --db .context/syncular-rusqlite-poc.sqlite \
  resolve-conflict <conflict-id> keep-server
```

`keep-server` or a custom strategy string only marks the conflict resolved. For
`keep-local`, use the retry helper:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --store rusqlite \
  --db .context/syncular-rusqlite-poc.sqlite \
  retry-conflict-keep-local <conflict-id>
```

That resolves the pending conflict, copies the rejected operation into a fresh
outbox commit, and updates its `base_version` to the server version reported by
the conflict. The retry is then sent by the next sync.

Today `diesel_tables` is generated from the Rust client migrations and contains only
table adapters plus a registry. Demo-specific task listing/local mutation code
lives in `demo_tasks`, so generated Diesel code does not depend on the sample
app's `Task` type. For the actual SDK, this is the module shape that Syncular
codegen should emit: one adapter per table plus a small registry used by
`DieselSqliteStore`. The adapters now also expose generated JSON row reads so
native bindings can use Diesel without a separate rusqlite query path.

The generator emits subscription functions, full-row upsert helpers, partial
upsert helpers, typed delete helpers, and app-table metadata from the app tables
found in migrations.
`syncular.codegen.json` supplies Syncular-specific metadata: named protocol
scopes, their local SQLite columns, where default subscription values come from,
the subscription id, server version column, soft-delete column, and blob
columns. The generator turns migrations plus config into a versioned
`syncular.schema.json` contract, then emits Rust, TypeScript/Kysely, Swift, and
Kotlin app-local modules from that contract. Every app table must have metadata,
scope sources must be declared, deprecated
`actorScopeColumn`/`projectScopeColumn` shortcuts are rejected, the server
version column must exist, and each app table must have exactly one primary key.
Native low-level bindings stay app-agnostic: app-generated Swift/Kotlin helpers
route through `applyMutationJson` and `queryJson` instead of binding-specific
table methods or predefined read queries.

## Run

Start a Syncular server first. For a small Bun-native local server using
`@syncular/dialect-bun-sqlite`:

```bash
bun --cwd tests/runtime apps/bun-sqlite/server.ts
```

It prints a JSON line such as `{"port":65024}`. Then, from the repo root:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --base-url http://127.0.0.1:65024/sync \
  --db .context/syncular-client.sqlite \
  --actor-id user-rust \
  --project-id p0 \
  add-task "Rust task"

cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --base-url http://127.0.0.1:65024/sync \
  --db .context/syncular-client.sqlite \
  --actor-id user-rust \
  --project-id p0 \
  sync

cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --db .context/syncular-client.sqlite \
  list-tasks
```

To exercise a generated partial upsert helper through the demo CLI:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --base-url http://127.0.0.1:65024/sync \
  --db .context/syncular-client.sqlite \
  --actor-id user-rust \
  --project-id p0 \
  patch-task-title <task-id> "Renamed task"
```

## WebSocket wake-up mode

Syncular WebSocket realtime is a wake-up channel. Data still flows through the
normal HTTP pull path. To watch for realtime events:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --base-url http://127.0.0.1:65024/sync \
  --db .context/syncular-watch.sqlite \
  --client-id rust-watch \
  --actor-id user-rust \
  --project-id p0 \
  sync

cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --base-url http://127.0.0.1:65024/sync \
  --db .context/syncular-watch.sqlite \
  --client-id rust-watch \
  --actor-id user-rust \
  --project-id p0 \
  watch --seconds 30
```

The initial `sync` is important because the server uses the client's last-known
effective scopes to route realtime wake-ups.

## WebSocket push mode

The Rust client also supports Syncular's optional WebSocket push path:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --base-url http://127.0.0.1:65024/sync \
  --db .context/syncular-ws-push.sqlite \
  --client-id rust-ws-push \
  --actor-id user-rust \
  --project-id p0 \
  add-task "WS push task"

cargo run --manifest-path rust/Cargo.toml -p syncular-client -- \
  --base-url http://127.0.0.1:65024/sync \
  --db .context/syncular-ws-push.sqlite \
  --client-id rust-ws-push \
  --actor-id user-rust \
  --project-id p0 \
  sync-ws
```

`sync-ws` sends pending outbox commits over WebSocket and then performs the pull
phase over HTTP, matching Syncular's transport model.

Native host bindings expose the same path as `enqueueSyncWebsocket()` for
queued UI work and `triggerSyncWebsocket()` for direct CLI/test work. The local
Swift/Kotlin/JVM native smoke validates the queued WebSocket push path against a
Bun-backed Hono route with WebSocket upgrades enabled. The same native smoke
mounts the Hono blob routes and validates native file blob store, queued upload,
generated `BlobRef` row sync, second-client pull, and native file retrieval. It
also validates stale-auth blob upload retry/fail behavior while keeping local
cache bytes available, plus missing remote blob 404 behavior without local
caching. It also validates generated field-level E2EE config by pushing an
encrypted title, observing the server-stored envelope from a plain reader, and
pulling plaintext from a configured reader. It also verifies subscription
revocation by switching
the generated task subscription to an unauthorized scope, clearing scoped rows,
then restoring the valid subscription and pulling the row again. Generated
Swift/Kotlin live queries are registered before the reader sync and refresh
typed rows from the native `QueriesChanged` event after `SyncCompleted`.
Native schema negotiation is also covered: a future required schema version
surfaces as `SyncFailed`, while a future latest schema version is tolerated.
Client-id ownership conflicts also surface as command-correlated `SyncFailed`
events when another authenticated actor reuses the same client id.

Pull handling performs bounded follow-up rounds when the server returns a
bootstrap continuation state, so large snapshots can complete across multiple
pull requests. Snapshot chunk references are fetched through the transport and
applied through the same table adapter path as inline snapshot rows.

If a subscription is revoked, the client clears rows for the previously stored
scopes and deletes local subscription state. The next pull for that subscription
starts from cursor `-1`.

Realtime WebSocket `sync` wake-ups trigger the normal HTTP sync path. Data still
flows through HTTP pull unless a future transport adds inline realtime changes.

## Concurrency

The Rust client enforces one active sync per local database path in the current process.
If two client handles try to sync the same SQLite file at the same time, the
second call returns `ErrorKind::Busy`. Local writes are still synchronous through
the selected store backend and are not hidden behind the sync lock. If a local
write happens after a sync has already selected its pending outbox batch, that
write is queued for the next sync round. Native apps should call
`trigger_sync()` after local mutations or let their binding layer coalesce those
write-triggered sync requests.

`SyncWorker` can own a `SyncularClient` on a background thread. Calling
`trigger_sync()` schedules work; triggers received while a sync is running are
coalesced into one follow-up sync. `recv_result_timeout()` returns completed
sync results. `request_stop()` queues a stop request, `join()` waits for the thread,
and `stop()` is the convenience form that does both. Cancellation is cooperative:
an in-flight sync is not aborted, but no further queued work is run after stop.

Native UI shells should prefer the additive queued runtime methods for unbounded
or bursty work. `enqueue_local_operation_json()`, `enqueue_mutation_json()`,
`enqueue_yjs_update_json()`, `enqueue_sync_now()`, and
`enqueue_resolve_conflict()` return a command id immediately; durability and
sync state are reported later through ordered native events. Snapshot refresh,
storage compaction, and local blob-cache file work also have queued variants:
`enqueue_refresh_snapshot_json()`, `enqueue_compact_storage_json()`,
`enqueue_store_blob_file_json()`, `enqueue_retrieve_blob_file_json()`,
`enqueue_prune_blob_cache()`, and `enqueue_clear_blob_cache()`. The worker
command queue is bounded, so callers get `ErrorKind::Busy` instead of unbounded
memory growth when a UI produces work faster than the runtime can drain it.

Yjs persistence uses a short coalescing window before SQLite/outbox writes.
Multiple updates for the same `(table, row_id, field)` are written as one local
operation, while the UI can keep applying editor updates in memory immediately.
The direct synchronous APIs remain available for CLI/tests/simple apps and for
bounded, measured local operations.

## Native App Lifecycle

The native bindings are shaped for UI hosts that keep Syncular work off the
main thread. The production path is a single writer actor: keep the native
worker hot and use queued methods for local writes, explicit sync, conflict
commands, CRDT updates, blob file work, snapshot refresh, and compaction. Reads
go through read-only query execution so UI views do not share the writer
connection. Open the database during app startup or scene/session activation,
start or resume the native worker, then subscribe to the native event stream
once and read
`nextEventJson()` from a background task, or use the C callback subscription,
then forward ordered events to the UI model by `event_seq` and `command_id`; do
not make view code wait synchronously for SQLite/outbox work.
If a native app has an app-specific Rust worker wrapper, prefer
`SyncWorker::subscribe_events(capacity)` over rebuilding an event hub in the app
layer. The worker-level subscription has the same fan-out and backpressure
semantics as the binding-facing native stream, and `NativeWorkerEventConverter`
keeps the JSON shape identical to the facade.
For live views, prefer the generic `changedRows` summaries on `RowsChanged`,
`QueriesChanged`, `SyncCompleted`, and `LocalWriteCommitted` over reloading
whole app tables. They are intentionally app-schema deltas, not editor-specific
events: a bridge can route CRDT-backed field changes to an active editor,
update list rows for title/preview changes, and handle deletes or conflicts
without a full bootstrap refresh.

Retry and realtime wakeups are runtime-owned. Retryable sync/blob failures
persist `next_attempt_at`; the worker arms a delayed wakeup for the next due
retry instead of requiring app polling. Persistent realtime can be started on
the native client so websocket `sync` events feed the sync worker directly with
reconnect/backoff and auth-header refresh support. Binding hosts can call
`startRealtimeWorker()`/`stopRealtimeWorker()` on the BoltFFI client or the
equivalent C ABI functions.

Startup can still include SQLite open, migration, schema validation, and native
library loading. Use the async native open path when that cost would sit on a
UI-critical path: Swift exposes `SyncularBoltClient(openAsync:)`, Kotlin/JVM
exposes `SyncularBoltClient.openAsync(config)`, and both wrappers provide
`openCommandId()`, `isOpenFinished()`, and `finishOpenTimeout(...)`. C hosts can
use `syncular_native_client_open_async_finish_timeout(...)` to wait for the
background open result. After async open finishes, the returned client is the
normal long-lived native runtime and all queued APIs behave the same as with
synchronous open.

When the app backgrounds, prefer leaving the worker alive if the platform allows
short background work, then enqueue a sync or compaction only within the host
platform's background execution budget. On foreground, refresh auth headers
first, then enqueue sync and refresh large views through the snapshot/query
refresh queue. On shutdown, call the explicit binding lifecycle method
(`shutdown()` in BoltFFI-generated Swift/Kotlin/Java wrappers), drain any
already-delivered events that matter to the host, and close the event stream
before releasing the native client.
When opening native clients with injected `appSchemaJson`, set generated
subscriptions with `setSubscriptionsJson` before the first foreground sync.

CRDT-backed editor fields should be initialized empty or with existing Yjs
state before queued text replacement. Replacing populated legacy plaintext
without Yjs state is rejected so the runtime cannot accidentally duplicate or
blank editor content.

The demo app server usually mounts sync at `http://localhost:9811/api/sync`, but
its `tasks` table uses `user:{user_id}` scopes rather than the runtime test
server's project scopes.

## Migration and schema flow

The Rust client follows the same shape as Syncular's TypeScript migration/typegen flow:

1. Write SQL migrations under `migrations/`.
2. Run the schema generator:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app
```

3. The generator applies those migrations to a temporary SQLite database.
4. It introspects the database with `PRAGMA table_info`.
5. It reads `syncular.codegen.json` for Syncular table metadata:

```json
{
  "typescriptOutputPath": "generated/syncular.browser.ts",
  "typescriptRuntimeImportPath": "@syncular/client-rust",
  "tables": {
    "tasks": {
      "subscriptionId": "sub-tasks",
      "scopes": [
        {
          "name": "user_id",
          "column": "user_id",
          "source": "actorId",
          "required": true
        },
        {
          "name": "project_id",
          "column": "project_id",
          "source": "projectId",
          "required": false
        }
      ],
      "serverVersionColumn": "server_version",
      "softDeleteColumn": "deleted",
      "subscriptionParams": {
        "includeArchived": false
      }
    }
  }
}
```

6. It writes generated Diesel `table!` macros into the consuming app's generated
   Rust schema module.
7. It writes generated Diesel table adapters into the consuming app's generated
   Rust table-adapter module.
8. It writes generated subscriptions and mutation helpers into the consuming
   app's generated Rust client module.
9. It writes generated browser TypeScript helpers to `typescriptOutputPath`
   or `generated/syncular.browser.ts` by default. That file contains the app DB
   type, a typed `createSyncularAppDatabase()` helper, row/input/patch types,
   Kysely payload helpers, SyncOperation builders, and subscription helpers.
   The generated database helper imports the Rust SQLite runtime from
   `typescriptRuntimeImportPath`, defaulting to `@syncular/client-rust`,
   validates the v2 package/protocol/Rust schema runtime contract, validates and
   stamps the generated browser schema, and registers generated subscriptions
   on the client from the configured `actorId`/`projectId` by default. Apps can
   pass `subscriptions: false`, a subscription array, or a function from
   generated subscription args to override those defaults while keeping the
   same `SyncularSubscriptionSpec` shape as the JS client. Browser TypeScript
   output deliberately does not
   generate table/column constants or predefined query helpers; Kysely remains
   the type-safe query builder.

This avoids hand-written Diesel schema/table adapter/mutation code and keeps
migrations as the source of truth, while still giving rust-analyzer and the
compiler normal checked-in Rust files for dev-time typing. It is roughly
equivalent to `diesel migration run` followed by `diesel print-schema` plus
Syncular adapter codegen, but self-contained for the Rust client. The generator tests
also cover a synthetic multi-table app so browser TypeScript output does not
quietly regress to task-only assumptions.

At runtime, stores apply the same embedded migrations from `src/migrations.rs`.
Each applied migration is stored with version, name, checksum, and timestamp.
Opening a database with a recorded migration whose checksum no longer matches
the embedded SQL fails early. Outbox commits use
`current_schema_version()` from those embedded migrations, so push requests
carry the local schema version over HTTP and WebSocket.

CI can verify the generated schema is current with:

```bash
cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime
cargo test --manifest-path rust/Cargo.toml -p syncular-client
```

The Rust tests include storage backend parity checks and mock-transport protocol
contract checks for HTTP push/pull, schema-version propagation, rejected commit
state, persisted conflict summaries, snapshot application, bootstrap
continuation, snapshot chunk fetching, revoked subscription cleanup, server
schema negotiation, and realtime wake-up pulls. Conflict tests also verify
pending-only listing, mark-resolved behavior, and keep-local retry. Browser
store tests cover local rows/outbox state plus in-memory conflict
persistence/retry. Concurrency tests verify overlapping sync rejection for the
same local database, worker trigger coalescing, and graceful worker shutdown
during an in-flight sync.

For a production SDK, the likely flow is:

- Syncular migrations remain source of truth.
- Syncular Rust codegen emits Diesel schema, models, and safe table handlers.
- Advanced users can still override generated pieces when Diesel's type system
  gets too restrictive.
