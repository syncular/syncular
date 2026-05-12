# Rust Client Feature Parity Plan

This file tracks the Rust-first Syncular client work needed to reach feature
parity with the existing JS client principles:

- typed query building stays consumer-facing through generic platform clients
  plus app-owned generated schema modules.
- this repo ships clients and generators, not final generated app clients.
- SQLite is the only storage target, but it must work on native and web.
- Rust owns sync, local persistence, conflict handling, realtime, and blob
  protocol behavior.
- browser JS should cross the JS/WASM boundary in coarse operations, not per
  row or per query-builder step.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked
or needs a design decision.

## Current Baseline

- `[x]` Rust crate with Diesel native SQLite store and migrations.
- `[x]` Rust-owned browser SQLite via WASM package path.
- `[x]` Browser v2 package under `rust/bindings/browser`.
- `[x]` Kysely-facing browser v2 API over Rust-owned SQLite.
- `[x]` Generated app table metadata and generated browser schema installer.
- `[x]` HTTP pull/push sync path.
- `[x]` Basic native websocket push/watch path.
- `[x]` Outbox, local writes, conflict persistence, retry/resolve hooks.
- `[x]` Snapshot chunk fetch and hash validation.
- `[x]` Table-level live-query invalidation for browser v2.
- `[x]` Native FFI/BoltFFI-generated binding shape for app integrations.
- `[x]` Runtime/package manifests for browser and native.

## Package Architecture Decisions

- Crate folder names should omit the `syncular-` prefix. Use
  `rust/crates/runtime`, `rust/crates/client`, and `rust/crates/codegen` while
  keeping published/package crate names `syncular-runtime`, `syncular-client`,
  and `syncular-codegen`.
- `client` is the canonical Rust SDK and uses Diesel canonically. Do not split
  Diesel into a separate `syncular-diesel` package.
- `runtime` is the shared low-level engine for bindings: SQLite, sync, outbox,
  conflicts, realtime, blobs, auth, `queryJson`, and `applyMutationJson`.
- `codegen` is the framework generator package. App-specific generated output
  is emitted into the consuming app and only lives in this repo as fixtures,
  examples, or snapshots.
- Generic platform clients live directly under `rust/bindings/*`:
  `browser`, `swift`, `kotlin`, `java`, and `c`. Do not wrap them in
  `rust/bindings/boltffi`; BoltFFI is a tooling/detail, not a product folder.
- The cross-platform construction principle is:
  `generic platform client + generated schema descriptor = typed app client`.

## P0: Auth And Session Contract

Goal: match the JS client's auth principle: app code owns auth, Syncular asks for
fresh request headers and applies them consistently to sync transports.

- `[x]` Add dynamic auth headers to Rust HTTP transports.
- `[x]` Add dynamic auth headers to browser v2 worker client without changing
  typed Kysely consumer APIs.
- `[x]` Expose dynamic auth headers through native FFI and BoltFFI.
- `[x]` Define websocket auth behavior for browsers, where custom headers are
  unavailable: same-origin cookies first, optional server-supported realtime
  query params when needed.
- `[x]` Add auth retry/lifecycle behavior equivalent to JS `authLifecycle`
  (browser v2 sync retry is implemented; native bindings use structured
  `AuthExpired` events with `operation`/`status`, after which host apps refresh
  credentials and call the existing set-headers/trigger-sync methods).
- `[x]` Add server-backed parity tests for 401/403, refreshed headers, revoked
  sessions, and client-id ownership
  (Hono-backed browser/WASM coverage now verifies sync auth refresh,
  server-gated 403 refresh, client-id ownership conflicts, and revoked
  subscription clearing).
- `[x]` Remove implicit dev actor auth headers from Rust transports so app code
  must provide real auth headers when the server requires them.

## P0: Realtime Websocket Parity

Goal: Rust client keeps subscribed queries and subscribers accurately, receives
server wakeups, pulls deltas, and emits only affected live query updates.

- `[x]` Native websocket can push pending commits.
- `[x]` Browser live-query registry can rerun affected SQL after local/sync
  table changes.
- `[x]` Browser v2 worker owns live-query subscribers.
- `[x]` Browser websocket connection path with reconnect/backoff
  (worker-level reconnect/backoff coverage exists, byte-delivered text frames
  are handled, and Hono/Bun server-backed websocket smoke passes).
- `[x]` Server wakeup handling that triggers HTTP pull and drains live events
  (Hono/Bun server-backed smoke verifies a second client push wakes a worker,
  performs HTTP pull, and emits a live-query update).
- `[x]` Per-query/table dependency tracking generated from Kysely execution and
  generated app-table metadata
  (nested subqueries are discovered, CTE aliases are filtered, and explicit
  table lists are validated against the generated schema).
- `[x]` Subscription lifecycle cleanup when queries unsubscribe or auth changes
  (subscription scope changes now reset cursors and clear stale scoped rows;
  browser live query unregister/destroy cleanup is implemented; browser
  realtime restarts with freshly resolved auth/query params when headers
  change).
- `[x]` Tests for wakeup, reconnect, duplicate events, and query update ordering
  (worker-level wakeup/reconnect coverage and real Hono websocket smoke exist;
  stale socket wakeups after reconnect are ignored, and in-flight wakeups are
  coalesced into ordered follow-up pulls).

## P0: Blob Parity

Goal: support content-addressed blobs with local queueing and server exchange
like the JS client.

- `[x]` Model blob metadata tables in Rust migrations/codegen.
- `[x]` Local blob staging APIs for native and browser.
- `[x]` HTTP upload/download transport with auth headers and retry semantics
  (browser v2 and native use Rust transport paths; native local HTTP transport
  smoke and Hono-backed browser/WASM success/failure smoke exist; blob upload
  queues now persist due-time backoff across native and browser SQLite).
- `[x]` Sync integration for blob references in mutations
  (generated browser Kysely types/codecs support configured blob columns, v2
  mutations keep protocol payloads app-shaped while encoding local SQLite rows,
  and server handlers store/emit BlobRef columns through the same codecs).
- `[x]` Browser storage decision: SQLite blob table first; OPFS sidecar files
  stay a future optimization for large blobs.
- `[x]` Native FFI/BoltFFI blob file-path APIs
  (file-path staging/retrieval is implemented through C FFI, BoltFFI, and
  Swift/Kotlin wrappers).
- `[x]` Tests for dedupe, interrupted upload, missing blob, and auth failure.

## P0: CRDT/Yjs Parity

Goal: move the old JS Yjs plugin semantics into the Rust-first runtime while
keeping typed app clients on generated mutation/query APIs.

- `[x]` Add a Rust/Yrs CRDT core for text updates, base64 state snapshots,
  envelope validation, row materialization, and JSON host helpers.
- `[x]` Add `crdtYjsFields` to the stable codegen/schema contract so table
  field, state-column, container-key, row-id, kind, and sync-mode metadata are
  generated from app config.
- `[x]` Generate typed Rust and TypeScript mutation payload support for `__yjs`
  envelopes without introducing table-specific low-level bindings.
- `[x]` Materialize Yjs envelopes before local SQLite writes in Diesel/native
  and Rust-owned browser SQLite.
- `[x]` Preserve `__yjs` envelopes in outbox operations so server-side CRDT
  merge plugins can apply concurrent updates against the canonical server row.
- `[x]` Materialize CRDT-backed rows from state when remote snapshots/changes
  are applied locally.
- `[x]` Expose Yjs helper APIs through browser Worker/WASM and BoltFFI source
  so JS/Swift/Kotlin hosts can build/apply document updates without linking the
  JS Yjs package.
- `[x]` Add the encrypted CRDT system-table foundation: `syncMode:
  "encrypted-update-log"` metadata, shared `sync_crdt_updates` and
  `sync_crdt_checkpoints` tables, SQLite/Postgres server DDL, reusable JS
  server hidden handlers, and Rust/browser local storage acceptance for hidden
  rows.
- `[x]` Encrypted CRDT client materialization now decrypts hidden
  update/checkpoint rows, applies them to local Yrs state, and writes the
  materialized app row for native Diesel and Rust-owned browser SQLite.
- `[x]` Encrypted CRDT mutation ergonomics now have generated Rust app-client
  helpers for text fields that create hidden update operations without exposing
  the system table payload. Browser/worker config plumbing is also in place.
- `[x]` Checkpoint retention/GC for encrypted CRDT update logs:
  clients can create encrypted checkpoint mutations from local Yrs state,
  hidden rows preserve server update sequence separately from local row ids, and
  native/browser storage plus server utilities prune only same-key updates
  covered by retained server-observed checkpoints.
- `[x]` Native UI-worker composition for encrypted CRDT:
  the worker can receive encrypted CRDT config, enqueue encrypted Yjs update
  writes/checkpoints, emit ordered native events for those writes, and keep
  plaintext update bodies out of outbox payloads.
- `[x]` Generated native app-client helpers for encrypted CRDT:
  Swift/Kotlin generators conditionally require the `queued-encrypted-crdt`
  native capability and expose typed field helpers for encrypted text updates
  and checkpoints on top of the generic native JSON ABI.
- `[~]` Rich-editor host integration remains app-layer work: the runtime now
  supplies text/state/envelope primitives, while ProseMirror/XML editor
  bindings still need platform-specific adapters over those primitives.
- `[ ]` Server-side Rust push plugin is still future work if/when Syncular
  server moves to Rust. The current Rust client is compatible with the existing
  JS server Yjs plugin because pushed operations keep `__yjs`.

## P0: Client-Side E2EE Parity

Goal: port the existing JS field-encryption and key-sharing principles into
the Rust-first client without requiring server-side plaintext access.

- `[x]` Keep wire compatibility with the JS encryption envelope:
  `dgsync:e2ee:1:<kid>:<nonce>:<ciphertext>`.
- `[x]` Implement field encryption with XChaCha20-Poly1305, 32-byte keys,
  24-byte random nonces, and stable AAD over `scope/table/rowId/field`.
- `[x]` Keep local SQLite and outbox rows plaintext, encrypt outbound push
  payloads just-in-time, and decrypt pull/snapshot/chunk/conflict rows before
  local apply.
- `[x]` Implement static key-provider JSON config for Rust, browser Worker/WASM,
  C FFI, and BoltFFI native bindings.
- `[x]` Implement symmetric key helpers: secure random keys, base64url,
  BIP39 mnemonic roundtrip, share URLs, and legacy scoped PBKDF2 derivation for
  compatibility with the existing demo.
- `[x]` Implement asymmetric key-sharing helpers with X25519 + HKDF-SHA256 +
  XChaCha20-Poly1305 wrapping, including low-order shared-secret rejection.
- `[x]` Add Argon2id passphrase derivation for new Rust-first passphrase flows
  while keeping PBKDF2 available for compatibility/FIPS-style deployments.
- `[x]` Expose encryption helper APIs through browser Worker/WASM, C FFI, and
  BoltFFI Swift/Kotlin/Java bindings.
- `[x]` Add runtime tests for push/pull encryption, incremental decryption,
  mnemonic/share URL helpers, and asymmetric wrapping.
- `[x]` Generated encrypted-field metadata:
  `syncular.codegen.json`/`syncular.schema.json` now carry stable
  `encryptedFields` semantics. Generated Rust, TypeScript, Swift, and Kotlin
  app clients expose encryption-rule/config helpers so apps provide key
  material without hand-writing table/field rules.
- `[x]` E2EE + CRDT/Yjs product direction is now explicit:
  encrypted collaborative fields use encrypted update-log/checkpoint system
  rows, not plaintext server-side CRDT merge; plaintext `__yjs` remains
  available for fields that choose server-side merge over E2EE.

## P0: Sync Protocol Correctness

Goal: the Rust client must obey the same protocol invariants as JS under
offline, conflict, revocation, snapshot, and schema-version flows.

- `[x]` Push/pull combined request support.
- `[x]` Outbox ack/fail/conflict persistence.
- `[x]` Snapshot chunks with gzip/SRF1 hash validation.
- `[x]` Revocation clears scoped local data.
- `[x]` Schema-version validation for outbox and server responses.
- `[x]` Backend parity tests cover local writes/outbox/snapshots/revocation.
- `[x]` More parity tests for retries, conflict resolution, stale schema,
  partial snapshot, chunk failure, and revoked subscriptions
  (server-backed browser/WASM coverage now exercises revoked subscription
  clearing and client-id ownership conflicts; Rust protocol coverage now verifies
  duplicate delivery idempotency and durable sync retry backoff; backend parity
  covers retry due-times for Diesel and the rusqlite fixture; Hono/WASM coverage
  verifies failed chunk fetches do not partially apply chunked snapshots).
- `[x]` Durable backoff/retry queue policy for background sync.
- `[x]` Idempotency tests for duplicate push responses and repeated pulls.

## P1: Generator Contract

Goal: app-owned generated schema modules must come from a stable framework
generator contract, not demo fixtures or hand-maintained table assumptions.

- `[x]` Generate app table metadata from migrations/config.
- `[x]` Generate browser schema installer from the same source.
- `[x]` Generate Kysely table types and mutation helpers for browser v2.
- `[x]` Generate Rust mutation/table metadata used by native and WASM stores.
- `[x]` Remove remaining `tasks`-specific public examples from native APIs
  (C FFI/header and native facade now expose generic operation/table APIs;
  demo task helpers remain isolated in Rust test/CLI internals).
- `[x]` Add config semantics for scopes, server-version columns, soft deletes,
  blob columns, and generated subscriptions
  (`blobColumns` and `softDeleteColumn` are now validated codegen fields for
  browser/native metadata; generated delete helpers and browser v2 mutations use
  soft-delete upserts for configured tables; generated subscriptions now carry
  validated static `subscriptionParams` and browser generated app creation can
  use defaults, explicit subscriptions, a subscription factory, or
  `subscriptions: false`).
- `[x]` Add generated-output drift tests for Rust/TS/native bindings
  (`syncular-codegen --check` now runs as an integration test over Rust schema,
  generated metadata, browser TS, Swift, Kotlin, Android Kotlin, and the example
  app outputs).
- `[x]` Split generator implementation into `rust/crates/codegen` with target
  emitters for TypeScript, Rust, Swift, Kotlin, and future platforms.
- `[x]` Define `syncular.schema.json` as the stable generator input/output
  contract for all platform generators.
- `[x]` Replace framework-owned generated app-client outputs with app-local
  fixture/example outputs used only for tests and documentation.
- `[x]` Compile app-owned generated Rust output in `rust/examples/todo-app`
  against `syncular-client`, including generated Diesel schema, generated
  Diesel table adapters, generated mutations, and generated subscriptions.
- `[x]` Generate app-local Rust migrations and expose a runtime `AppSchema`
  contract so external Rust apps can pass their generated metadata, migrations,
  subscriptions, and Diesel adapters into `SyncularClient::open_with_schema`.
- `[x]` Add versioned schema JSON drift/contract tests independent of platform
  binding snapshots.
- `[x]` Route Rust, TypeScript/Kysely, Swift, Kotlin, and Android Kotlin
  generation through the parsed `syncular.schema.json` contract.

## P1: Native App Surface

Goal: make Swift/Kotlin/etc. bindings useful without exposing Rust internals.

- `[x]` C FFI handle and JSON method surface.
- `[x]` BoltFFI starter surface
  (`boltffi.toml` and `src/bindings/boltffi.rs` expose the JSON-oriented
  native client boundary; void-like fallible commands return boolean `Result`s
  so generated TypeScript/Swift/Kotlin surfaces preserve errors).
- `[x]` Runtime manifest exposes metadata/capabilities.
- `[x]` Query-observer events exist at table dependency level
  (native facade emits `QueriesChanged` for registered table dependencies;
  generated host wrappers can layer live-query subscriptions on top of the event
  stream).
- `[x]` Dynamic auth headers over C FFI and BoltFFI.
- `[x]` Generated-schema-friendly query/mutation APIs, beyond JSON escape
  hatches (Swift/Kotlin generator fixtures expose row shapes, caller-supplied
  `queryJson` execution, and typed mutation apply helpers over the generic JSON
  ABI via `applyMutationJson`; predefined generated `list*()` reads were
  removed so query builders own read composition; native binding goldens now
  assert generic bindings stay app-agnostic and app-generated helpers route only
  through `applyMutationJson`/`queryJson`; generated Swift/Kotlin live-query
  wrappers register table dependencies through the generic observer ABI and
  refresh affected query-builder output through `queryJson`).
- `[x]` Local generated Swift/Kotlin app-client smoke coverage
  (`bun run rust:native-smoke` compiles and runs the generated todo Swift and
  Kotlin clients against a mock `SyncularNativeJsonClient`, covering query
  builder SQL, mutation JSON, live-query registration, event filtering, and
  refresh behavior without GitHub CI).
- `[x]` Real host-language generated client smokes over BoltFFI/JNI
  (`bun run rust:native-smoke` now also builds the Rust runtime dylib, links the
  generated Swift app client against the generated BoltFFI Swift binding, packs
  the JVM native library, and runs the generated Kotlin app client through the
  actual Kotlin/JNI BoltFFI binding. Both smokes cover manifest checks, auth
  header updates, pause/resume/shutdown, typed mutation writes, typed query
  reads, observed query registration, native event polling, and live-query
  refresh).
- `[x]` Background worker lifecycle controls for mobile/desktop apps
  (native facade, C FFI/header, and BoltFFI expose pause/resume/running state;
  paused local writes stay queued).
- `[~]` Platform packaging tests for iOS/macOS/Linux/Windows/Android
  (local BoltFFI packaging smokes cover Apple, Android arm64/x86_64 with
  bundled SQLite, and JVM; workflow definitions exist for Linux/Windows native
  artifacts but remote CI execution is intentionally pending until this branch
  is pushed. Browser WASM is intentionally handled by the separate wasm-bindgen
  Worker/Kysely package, not BoltFFI).

## P1: Browser/WASM Package

Goal: the browser v2 package is the Rust-first JS client, not a parallel JS
store implementation.

- `[x]` Separate `rust/bindings/browser` package.
- `[x]` Dedicated worker path is always used.
- `[x]` Rust-owned SQLite is the storage engine.
- `[x]` Kysely dialect/driver executes SQL through Rust-owned SQLite.
- `[x]` Live queries rerun in worker and emit to JS.
- `[x]` Dynamic auth headers from app code to worker to Rust.
- `[x]` Browser websocket/realtime path.
- `[x]` Package exports and docs should make v2 the only Rust-first path
  (`@syncular/client-rust` no longer depends on the v1 client package for its
  mutation proxy, and README/API docs point generated app code at the v2
  worker/Rust-owned SQLite path).
- `[x]` Benchmarks for host-store vs Rust-owned SQLite remain reproducible
  (`@syncular/client-rust` exposes `benchmark:browser`, the benchmark labels the
  JS/wa-sqlite host-store as a baseline-only fixture, prints Rust-owned
  IndexedDB/OPFS Worker ratios and speedups, and can write JSON reports).

## P1: Rust SDK Package

Goal: Rust users get a first-class canonical client, not a thin binding over a
different language's model.

- `[x]` Make `rust/crates/client` the canonical Rust SDK folder with package
  name `syncular-client`.
- `[x]` Keep Diesel as the Rust SDK's canonical query builder/schema
  integration.
- `[x]` Move shared engine pieces that bindings need into
  `rust/crates/runtime` with package name `syncular-runtime`.
- `[x]` Ensure Rust app code consumes app-local generated schema modules from
  the generator rather than a framework-owned generated-client package.
- `[x]` Add a Rust example-app compile/runtime smoke for generated Diesel schema
  and generated Syncular mutation/subscription helpers.
- `[x]` Make the Diesel SQLite store schema-injectable, so the canonical Rust
  SDK can run against app-owned generated migrations/adapters instead of the
  framework's demo schema.
- `[x]` Expose ergonomic Rust reads without passing the connection through app
  code: app code supplies a normal Diesel query builder expression and
  `client.read(query)` executes it on the owned SQLite connection.
- `[x]` Generate JS-semantics Rust mutation APIs for app tables
  (`client.mutations().tasks().insert/update/delete`, generated
  `SyncularGeneratedMutationsExt::commit`, typed mutation DTOs, automatic
  base-version reads for updates/deletes, and one outbox commit per batch).
- `[x]` Add ergonomic Rust conflict helpers over the durable conflict store
  (`client.conflicts().pending/is_empty/keep_local/accept_server/dismiss` plus
  typed `ConflictResolutionReceipt`), while keeping the lower-level summary and
  retry APIs available.
- `[x]` Add a typed Rust live-query handle over Diesel reads. App code declares
  affected table dependencies, keeps a normal Diesel query-builder expression,
  and refreshes only when a `SyncReport` includes those tables.

## P2: Operations And Hardening

- `[x]` Structured logs/diagnostics for sync, auth, websocket, and storage
  (browser v2 accepts diagnostic listeners, forwards worker diagnostic events,
  reports auth refresh/expiry, storage fallback, request timeout, sync/blob
  request outcomes, and realtime reconnect/wakeup diagnostics; native event JSON
  includes optional diagnostic payloads and the manifest advertises
  `structured-diagnostics`).
- `[x]` Panic/error boundary rules for FFI and WASM
  (C FFI exported calls use `catch_unwind` and preserve panic payloads as
  structured `Internal` errors; WASM installs a startup panic hook and maps
  regular Rust errors into JavaScript `Error` objects with `syncularKind` and
  `syncularDebug` fields for worker diagnostics).
- `[x]` Cancellation semantics for long sync pulls and snapshot fetches
  (browser Worker request timeouts now send cancel messages and abort active
  Rust-owned fetches through `AbortSignal`, covering sync pull/push/once,
  snapshot chunk downloads, immediate blob upload/download, and blob queue
  processing; canceled worker responses stay suppressed).
- `[x]` Connection health/state APIs for UI
  (browser v2 exposes `client.connectionState()` with closed state, pending
  Worker request count, realtime state, storage fallback, latest diagnostic, and
  latest worker error).
- `[x]` Storage compaction/cleanup for tombstones, outbox, blobs, and old state
  (Diesel/native and Rust-owned browser SQLite expose a shared JSON compaction
  contract. Age-based cleanup covers acked outbox and resolved conflicts by
  default; failed blob uploads and inactive subscription state are opt-in; blob
  cache can be byte-pruned; tombstones require an explicit
  `maxTombstoneServerVersion` so soft-deleted app rows are not dropped by age
  alone).
- `[x]` Optional streaming/zero-copy native blob APIs for very large files
  (native file APIs now support `cacheLocal:false` for immediate file upload
  and retrieval. Upload hashes the file as a stream and sends a streaming HTTP
  body; retrieval streams to a temporary file, validates size/hash, and renames
  it into place. This avoids Swift/Kotlin byte-array copies and avoids SQLite
  blob-cache writes when the host explicitly opts out of local caching).
- `[x]` CI jobs for native, wasm, package typecheck, and generated snapshots
  (`checks.yml` now has Rust native tests/fmt/codegen drift, browser
  package tests/typecheck/WASM build/size, Linux/Windows native library
  artifacts, and BoltFFI Apple/Android/JVM package smokes).

## Work Log

- 2026-05-08: Created this parity tracker and started P0 auth/session contract.
- 2026-05-08: Added `SyncAuthHeaders` transport plumbing, v2 `getHeaders`
  bridge, worker protocol `setAuthHeaders`, and WASM `setAuthHeadersJson`.
- 2026-05-08: Extended dynamic auth headers through native background workers,
  C FFI, BoltFFI, Swift/Kotlin wrappers, and native runtime capabilities.
- 2026-05-08: Added browser v2 `authLifecycle` handling with one sync retry
  after HTTP 401/403 and single-flight credential refresh.
- 2026-05-08: Added browser v2 Worker realtime start/stop protocol, websocket
  reconnect/heartbeat loop, sync wakeup pulls, and live-query event forwarding.
- 2026-05-08: Split browser v2 Worker realtime into a dedicated controller and
  added unit coverage for URL resolution, wakeup recognition, duplicate wakeup
  coalescing, and stale event suppression after stop.
- 2026-05-08: Added Rust internal blob migrations, browser Rust-owned SQLite
  blob cache/outbox primitives, v2 `syncular.blobs` API, Rust/WASM
  upload/download transport calls, and Worker auth retry coverage for immediate
  blob upload.
- 2026-05-08: Extended blob staging to native Diesel SQLite, added native HTTP
  upload/download transport support, exposed file-path blob APIs through C FFI
  and BoltFFI, and added native FFI coverage for local blob cache/outbox flows.
- 2026-05-08: Added native blob HTTP transport smoke coverage for upload init,
  presigned upload, complete, download URL, direct download, and auth header
  forwarding.
- 2026-05-08: Added Swift and Kotlin wrapper methods for native blob file
  staging, retrieval, queue processing, cache stats, pruning, and clearing.
- 2026-05-08: Added Hono-backed browser/WASM blob smoke coverage for queued
  upload, cache clear, server download, auth forwarding, and Rust-owned SQLite
  blob cache stats; browser presigned upload headers now skip forbidden fetch
  headers such as `content-length`.
- 2026-05-08: Expanded Hono-backed browser/WASM blob coverage for local dedupe,
  retryable auth failures, interrupted direct upload retries, and missing
  remote blob retrieval without local cache pollution.
- 2026-05-08: Added validated `blobColumns` codegen config, generated browser
  `BlobRef` Kysely types/codecs, v2 codec-aware mutation local-row encoding,
  and regression coverage that protocol payloads stay app-shaped while local
  Rust-owned SQLite stores DB-shaped JSON text.
- 2026-05-08: Added server-handler regression coverage showing generated
  `BlobRef` codecs store JSON text in SQLite and emit app-shaped rows for
  snapshots/change notifications.
- 2026-05-08: Added Hono-backed browser/WASM auth parity coverage for worker
  `authLifecycle` retry after HTTP 401 from real sync auth and HTTP 403 from a
  server-side gate, including refreshed header forwarding through Rust/WASM.
- 2026-05-08: Added shared Hono browser/WASM sync harness plus server-backed
  coverage for client-id ownership conflicts and revoked subscription clearing.
  Fixed Rust subscription scope changes so updated scopes are sent to the
  server, cursor/bootstrap state resets on scope changes, and old scoped rows
  are cleared when effective scopes change.
- 2026-05-08: Hardened browser worker realtime message parsing for websocket
  runtimes that deliver text frames as bytes, with worker-level unit coverage.
- 2026-05-08: Added Hono/Bun browser/WASM realtime smoke that opens the real
  worker websocket path, pushes from a second Rust-owned SQLite worker, pulls
  on server wakeup, and emits a live-query update. Fixed the worker runtime
  origin fallback for Bun workers where `self.location` is absent.
- 2026-05-08: Removed implicit `x-user-id`/`x-actor-id` auth header fallback
  from Rust native and WASM transports. App-provided headers are now the only
  credentials forwarded to sync, snapshot, blob, and native websocket requests.
- 2026-05-08: Drove browser live-query dependency tracking from generated app
  table metadata. Kysely OperationNode scanning now catches nested subqueries,
  filters CTE aliases, validates explicit dependency lists, and unregisters
  active Rust live queries during dialect/database cleanup.
- 2026-05-08: Added Rust protocol idempotency regressions for duplicate push
  commit responses and repeated pull commits so outbox acking and local row
  application remain stable under duplicate server delivery.
- 2026-05-08: Added durable `next_attempt_at` retry scheduling for sync outbox
  and blob upload queues across Diesel/native SQLite and Rust-owned browser
  SQLite. Transport/protocol push failures now requeue with exponential backoff,
  terminal failures stop retrying, stale `sending`/`uploading` rows recover, and
  browser Hono sync/blob retries wait for due-time backoff in tests. Browser
  sync push transport failures recover `sending` rows through a synchronous WASM
  hook so failed fetches do not leave the worker in a trapped async frame.
- 2026-05-08: Hardened browser pull application for chunked snapshots by fetching
  all snapshot chunk rows before clearing/upserting local rows. Added Hono/WASM
  regression coverage that a failed snapshot chunk fetch leaves existing local
  scoped rows untouched.
- 2026-05-08: Defined the native auth lifecycle shape as an event-driven FFI
  contract. Sync HTTP 401/403 failures now emit `AuthExpired` events with
  operation/status metadata, and the runtime manifest advertises
  `auth-expired-events`.
- 2026-05-08: Closed the browser realtime auth-change gap by having the worker
  client remember the original realtime options and restart the active
  websocket with freshly resolved params after auth headers change.
- 2026-05-08: Added Diesel/rusqlite store parity coverage for durable sync
  retry due-times, proving failed pushes stay pending without immediate re-push
  and are acked once backoff is due.
- 2026-05-08: Added browser worker realtime reconnect coverage that ignores
  stale socket wakeups after reconnect and preserves ordered follow-up pulls for
  wakeups received during an in-flight pull.
- 2026-05-08: Removed demo task convenience exports from the native C
  ABI/header and facade tests. Native bindings now stay on the generic
  generated-operation/list-table contract.
- 2026-05-08: Added a generated-output drift integration test that runs
  `syncular-codegen --check`, covering Rust, browser TypeScript, Swift, Kotlin,
  and Android Kotlin generated files.
- 2026-05-08: Moved the typed mutation proxy into `rust/bindings/browser` and
  removed its dependency on the v1 `@syncular/client` package, keeping browser
  v2 on a Rust-first package surface.
- 2026-05-08: Added native background worker lifecycle controls
  (`pauseSyncWorker`, `resumeSyncWorker`, and running-state checks) through the
  facade, C ABI/header, and BoltFFI surface.
- 2026-05-08: Added validated `softDeleteColumn` codegen config. Rust,
  browser TypeScript, Swift, Kotlin, and Android Kotlin generated delete
  helpers now emit soft-delete upserts for configured tables, and browser v2
  Kysely mutations consume generated table metadata without changing app-facing
  mutation APIs.
- 2026-05-08: Finished generated subscription config semantics:
  `subscriptionParams` is now a validated codegen field, generated Rust/browser
  subscription helpers include configured params, generated table config exposes
  subscription ids/params, and browser `createSyncularAppDatabase()` supports
  default, explicit, factory, and disabled subscription modes.
- 2026-05-08: Added generated native convenience APIs on top of the stable
  generic ABI. Swift/Kotlin generated app code now has typed row shapes plus
  typed `applyNew*`, `apply*Patch`, and `apply*Delete` helpers, and native smoke
  scaffolds exercise the typed helpers instead of table-name JSON strings where
  the wrapper implements the generated interface.
- 2026-05-08: Expanded local native packaging verification. Swift generated
  sources typecheck, Kotlin/JVM BoltFFI generated sources compile, and Android
  debug Kotlin compiles against a local SDK installed under
  `.context/android-sdk`. This needs rerun against the BoltFFI-only scaffold.
- 2026-05-08: Promoted the browser Rust-owned SQLite local mutation benchmark to
  a v2 package script with clear baseline labels, speedup/ratio reporting, JSON
  output, and a smoke run against the real browser worker/WASM runtime.
- 2026-05-08: Added structured diagnostics across the Rust-first browser worker
  and native event JSON surfaces, covering auth, sync, realtime/websocket,
  storage fallback, blob requests, timeouts, and native row/query/conflict
  events.
- 2026-05-08: Hardened host boundary error behavior. Native FFI panic catches
  now preserve panic payloads in structured errors with a regression test, and
  the WASM build installs a panic hook while returning Rust errors as JS
  `Error` objects with Syncular-specific metadata.
- 2026-05-08: Added browser cancellation plumbing from Worker request timeout to
  Rust-owned WASM fetches. The worker now owns per-request `AbortController`s for
  long sync/blob operations, passes their signals into Rust, and aborts snapshot
  chunk/blob fetches on cancel.
- 2026-05-08: Added a browser v2 connection state snapshot for UI surfaces,
  covering closed state, pending Worker requests, realtime state, storage
  fallback, latest diagnostic, and latest worker error.
- 2026-05-08: Added storage compaction across Diesel/native and Rust-owned
  browser SQLite, surfaced through browser v2 Worker APIs, native facade, C
  FFI/header and BoltFFI. Tombstone pruning is
  server-version bounded instead of age-only.
- 2026-05-08: Added native large-file blob paths with explicit `cacheLocal:false`
  semantics. Immediate upload now hashes the source file incrementally and uses
  a streaming reqwest body; retrieval can stream to a validated temp file
  without populating the SQLite blob cache.
- 2026-05-09: Restructured the Rust rewrite into `rust/crates/runtime`,
  `rust/crates/client`, `rust/crates/codegen`, and direct `rust/bindings/*`
  platform folders. The example todo app now owns generated TS/Swift/Kotlin/Rust
  outputs under `rust/examples/todo-app/generated`, and generated-output drift
  checks run the generator against both the runtime internals and the example
  app.
- 2026-05-09: Verified native BoltFFI packaging locally for Apple
  iOS/simulator/macOS, Android arm64/x86_64, and JVM darwin-arm64. Android now
  bundles SQLite through `libsqlite3-sys` instead of linking `-lsqlite3`, and
  BoltFFI WASM is disabled because browser support uses the dedicated
  wasm-bindgen Worker/Kysely package.
- 2026-05-09: Added the native `queryJson` read path across Rust facade, C FFI,
  BoltFFI, and generated Swift/Kotlin scaffolds. It accepts read-only
  SQL/query-builder output plus params and declared app-table dependencies,
  rejects internal tables and mutating SQL, and replaces predefined generated
  native `list*()` reads. The write path also gained `applyMutationJson`
  aliases while keeping `applyLocalOperationJson` for compatibility.
- 2026-05-09: Clarified package architecture. The framework should ship generic
  platform clients and generators, while app-specific generated schema modules
  are emitted into consuming apps. Crate folders should be `runtime`, `client`,
  and `codegen`; crate package names keep the `syncular-*` prefix. The Rust
  SDK `client` is Diesel-first, and bindings should live directly under
  `rust/bindings/*` instead of a `boltffi` wrapper folder.
- 2026-05-09: Added native generated live-query wrappers for Swift/Kotlin app
  modules. The low-level bindings remain schema-agnostic, while generated app
  code can register query dependencies, decode native event JSON, refresh
  affected rows via `queryJson`, and unsubscribe via the generic observer API.
- 2026-05-09: Finished the Rust SDK ergonomic API layer: Diesel remains the
  query builder while `client.read(query)` hides the connection, generated
  public Diesel row structs support `TaskRow::as_select()`, and generated
  table mutation namespaces mirror the JS outbox semantics for insert, update,
  delete, insert-many, and batched commits.
- 2026-05-09: Added Rust SDK conflict and live-query ergonomics. Conflicts now
  have a namespaced helper API for pending checks, keep-local retry, server-win
  resolution, and dismissal. Rust apps can also keep a typed Diesel live query
  and rerun it from table-level `SyncReport` invalidation without touching the
  SQLite connection directly.
- 2026-05-10: Added Rust CI hardening for native tests/fmt, no-default runtime
  checks, generated-output drift, browser package tests/typecheck/WASM build,
  Linux/Windows native library packaging, and BoltFFI Apple/Android/JVM package
  smokes. Generated Swift/Kotlin app modules now include a small typed
  query-builder DSL over `queryJson`, and cross-platform conformance tests
  assert the same schema contract across Rust, TypeScript, Swift, Kotlin, and
  Android Kotlin outputs.
- 2026-05-10: Added local generated-client smokes for Swift and Kotlin plus a
  TypeScript generated-app conformance test. The native smokes run generated
  query builder, mutation, and live-query flows against a mock native JSON
  client, while the browser test asserts generated TS operation/subscription
  semantics and Kysely SQL over the same task contract.
- 2026-05-10: Promoted the native smoke to a real host-language integration
  check. The smoke now builds the Rust runtime dylib, links generated Swift
  against the generated BoltFFI binding, packages the JVM native library, and
  runs generated Kotlin through the actual Kotlin/JNI binding. The BoltFFI
  lifecycle method was renamed from generated `close()` to `shutdown()` so
  Kotlin/Java can keep language-native `AutoCloseable.close()` for handle
  disposal. Added a server-backed native auth-header test proving refreshed app
  headers reach the background worker's HTTP sync request.
- 2026-05-10: Added Rust/Yrs CRDT support for Yjs-style text updates and
  `__yjs` payload envelopes. Codegen now emits CRDT field metadata and typed
  Rust/TypeScript mutation envelope helpers. Diesel/native and Rust-owned
  browser SQLite materialize local rows and remote rows from Yrs state, while
  outbox operations preserve `__yjs` so the existing JS server Yjs push plugin
  can perform server-side concurrent merge. Browser Worker/WASM and BoltFFI
  source expose JSON helper APIs for building/applying Yjs updates.
- 2026-05-10: Added Rust-first client-side field encryption and key-sharing
  support. The runtime now mirrors the JS plugin's XChaCha20-Poly1305 field
  envelope, decrypts pull/snapshot/chunk/conflict rows before local apply,
  exposes static encryption config through Rust/browser/native clients, and
  provides symmetric/asymmetric helper APIs for BIP39 shares, PBKDF2/Argon2id
  passphrase derivation, and X25519 key wrapping.
- 2026-05-10: Added the encrypted CRDT update-log foundation. Codegen now
  carries `crdtYjsFields[].syncMode`, server SQLite/Postgres schemas create one
  shared update table plus one shared checkpoint table, `@syncular/server`
  exposes hidden encrypted-CRDT handlers for append-only update/checkpoint
  rows, and Rust/browser local SQLite accepts the hidden rows without treating
  them as app tables.
- 2026-05-10: Completed the first encrypted CRDT client path. Native Diesel can
  generate encrypted hidden update mutations, keep plaintext out of the outbox,
  decrypt pulled hidden rows, and materialize app rows. Rust-owned browser
  SQLite uses the same hidden-row materialization path, and generated Rust
  clients now add encrypted text-update helpers plus hidden subscriptions for
  encrypted fields.
- 2026-05-10: Finished the encrypted CRDT checkpoint/retention foundation.
  Rust can build encrypted checkpoint mutations from materialized Yrs state,
  local hidden rows now store server sequence separately as `server_seq`, local
  storage compaction can prune same-key covered update rows and cap retained
  server-observed checkpoints per stream/key, and `@syncular/server` exposes
  `pruneEncryptedCrdtSystemRows()` with coverage proving old encrypted update
  rows are deleted only after a covering checkpoint exists.
- 2026-05-10: Wired encrypted CRDT into the native UI-worker path. The runtime
  now carries encrypted CRDT config through native facade pause/resume, C FFI,
  and BoltFFI Swift/Kotlin/Java bindings; exposes queued/direct encrypted
  update-log and checkpoint JSON commands; and adds worker coverage proving a
  Yjs update materializes the app row while the outbox stores only ciphertext.
- 2026-05-10: Added generated Swift/Kotlin encrypted CRDT app-client wrappers.
  Schemas with encrypted update-log text fields now generate typed
  update/text/checkpoint helpers while keeping low-level bindings table-agnostic.
- 2026-05-10: Added generated `encryptedFields` metadata and config helpers.
  Rust, TypeScript, Swift, and Kotlin generated app modules now derive field
  encryption rules from schema metadata; app code only supplies key material and
  optional key ids/error-mode settings.
