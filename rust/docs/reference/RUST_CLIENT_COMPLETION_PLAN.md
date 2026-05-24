# Rust Client Completion Plan

Reference note: this file preserves the long-form completion history. Current
status and next actions live in [`../ROADMAP.md`](../ROADMAP.md) and
[`../work-packages/`](../work-packages/).

This was the active plan for finishing the Rust-first Syncular client. It
superseded the older feature-parity, query-rewrite, native-client, FFI,
foundation, and WASM split notes before the operational roadmap was split into
the current docs structure.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked
or needs a design decision.

## Product Decisions

- Rust-owned SQLite is the foundation for native and browser. Do not maintain a
  parallel pure-JS store as a product path.
- Type-safe reads stay query-builder based:
  TypeScript uses Kysely, Rust uses Diesel, Swift/Kotlin use generated small
  SQL DSLs until a clearly better native library is proven.
- Writes must go through Syncular mutations, never raw app-table
  `INSERT`/`UPDATE`/`DELETE`, so local rows, outbox, conflicts, encryption,
  blobs, and sync stay coherent.
- Low-level bindings stay schema-agnostic. App-specific generated code belongs
  in consuming apps, with examples/fixtures only in this repo.
- `syncular-client` is the canonical Rust SDK and uses Diesel canonically. Do
  not create a separate `syncular-diesel` package.
- `rusqlite` is only a dev/test/backend-boundary fixture unless a concrete
  platform need appears.
- CRDT editor adapters stay app-layer. Syncular core owns durable CRDT field
  storage, Yrs merge/materialization, worker coalescing, sync transport,
  conflict/encryption/persistence semantics, and convergence tests. Apps own
  TipTap/ProseMirror schemas, derived previews/outlines, editor bridges, save
  policy, and transient UI state.
- Optional plugins/features are useful only if they remove shipped bytes for
  apps that do not use them. If a generated app requires CRDT/E2EE/blobs, the
  code will be loaded with the Rust package anyway.

## Investigation Findings

- Browser performance: Rust-owned SQLite is the right direction when operations
  are coarse. Latest local benchmark after size optimization showed JS batched
  local writes at about `35.88ms`, Rust-owned IndexedDB at about `16.56ms`
  (`2.17x` faster), and Rust-owned OPFS Worker at about `26.26ms` (`1.37x`
  faster). OPFS is viable but not automatically faster; reducing JS/WASM and
  host-store boundary crossings matters more.
- Browser package size: optimized release WASM is currently about `2.92 MiB`
  raw and `1.20 MiB` gzip after `wasm-opt -Oz` and custom-section stripping.
  The no-CRDT/no-E2EE/no-blob core artifact is about `2.19 MiB` raw and
  `925.6 KiB` gzip, a `303.2 KiB` gzip reduction. This is large enough to keep
  the feature boundary work. Variant builds now emit per-artifact manifests and
  a top-level ordered artifact catalog so generated apps can select the
  smallest compatible WASM artifact.
- Browser safety: the Kysely-facing `db` currently executes SQL through the
  Rust WASM `executeSql` path. That is good for reads, but app-table writes can
  bypass Syncular mutation/outbox/conflict semantics unless we harden the
  public SQL boundary.
- Runtime purity: generated app schema still exists inside the runtime crate
  for examples/tests. The product runtime should require injected app schema
  metadata and keep generated app output only under examples, fixtures, or
  snapshots.
- Native UI runtime: queued APIs now exist for local mutations, sync, conflict
  resolution, Yjs update bursts, large query/snapshot refresh,
  blob/compaction work, and async open/migration/schema validation for slow
  startup paths.
- Native event delivery: UI hosts should subscribe to a clean native event
  stream or C callback API from app code.
- Native transport: HTTP/WebSocket paths need production timeout defaults and
  consistent retry/cancellation behavior across desktop/mobile hosts.
- Platform integration: generated Swift/Kotlin code compiles, command-line
  lifecycle smokes run, and real iOS simulator plus Android emulator app-shell
  lifecycle tests now pass with native library linkage. macOS-specific shell
  validation and release packaging polish remain.
- Native server sync: low-level native bindings now support dynamic
  `setSubscriptionsJson` so injected-schema Swift/Kotlin/JVM apps can register
  subscriptions before sync. Generated Swift/Kotlin app clients emit typed
  subscription helpers, and the local native smoke proves Swift and Kotlin/JVM
  can surface stale-token `AuthExpired` events with command ids, hot-refresh
  auth headers, pull/query seeded rows, push generated task mutations, handle a
  Hono-backed keep-local version conflict, and pull the pushed/resolved rows
  into a second native client through the real Hono sync route. The same smoke
  now uses a Bun-backed Hono WebSocket route and proves explicit
  `enqueueSyncWebsocket` push from Swift and Kotlin/JVM. It also mounts the
  real Hono blob routes and proves native blob file upload/reference
  sync/retrieval, plus generated field-level E2EE config against the server:
  a reader without encryption sees the stored envelope and a configured reader
  pulls decrypted plaintext. The server-sync smoke also flips the generated
  task subscription to a scope outside the authenticated actor, proving native
  clients clear revoked scoped rows and can restore them after the subscription
  scope is valid again. The second native client registers a generated live
  query before pull and refreshes typed rows from the post-sync
  `QueriesChanged` event. The same smoke mounts future-schema routes and
  proves native clients fail fast on server-required future schemas while
  tolerating server-reported latest future schemas. It also proves server
  client-id ownership rejects reuse of one client id by a different
  authenticated actor.
- Conformance: smoke/schema coverage exists across TypeScript, Rust, Swift, and
  Kotlin, but shared end-to-end behavioral scenarios against the same server
  are not complete for every auth, sync, realtime, blobs, and E2EE edge case.
- CRDT: the generic document-field primitive now wraps Yrs, encrypted
  update-log storage, checkpoints, materialization, worker queueing, generated
  helpers, ordered events, and conformance. Optional editor adapters should
  stay above this core.

## P0: Safety And Runtime Cleanup

Goal: close correctness holes before adding more public API.

- `[x]` Harden the browser Kysely SQL boundary.
  Public Kysely reads may execute through Rust-owned SQLite, but app-table and
  Syncular-internal writes must be rejected unless they go through Syncular
  mutation APIs. Add tests for `insertInto`, `updateTable`, `deleteFrom`, raw
  mutating SQL, and internal table writes.
- `[x]` Decide the exact browser read/write API shape after hardening.
  Preferred shape: `db` remains the typed read/query-builder surface; generated
  `mutations` remains the only synced write surface. If local-only scratch
  tables are allowed later, require an explicit non-synced allowlist.
- `[x]` Move generated app schema out of `syncular-runtime` product paths.
  Runtime accepts injected `AppSchema`/schema JSON. Demo task schema is
  feature-gated under `fixtures::todo` for tests/examples and is not exposed as
  product API.
- `[x]` Demote `rusqlite` from public product surface.
  It is now behind the explicit demo/native fixture feature; no-default native
  product builds expose Diesel-backed runtime/client surfaces without
  `rusqlite`.
- `[x]` Add production transport timeout defaults for native HTTP/WebSocket.
  Cover connect, request, response body, websocket open, websocket idle, and
  shutdown behavior.
- `[x]` Replace host-facing native event waits with stream/callback delivery.
  Rust hosts can subscribe to `NativeEventSubscription`, C hosts use a callback
  subscription, and BoltFFI hosts use `startEventStream`/`nextEventJson`/
  `closeEventStream`.
- `[x]` Add queued native worker APIs for blob queue processing, blob cache
  pruning, storage compaction, and long snapshot/query refresh work.
- `[x]` Add optional worker-owned open/migration path.
  UI hosts should be able to move slow open/migration/schema validation off the
  main thread when needed.

## P0: Generic CRDT Document Fields

Goal: make CRDT-backed fields a first-class Syncular runtime primitive without
making TipTap, ProseMirror, Excalidraw, or any editor schema part of core.

- `[x]` Add a generic CRDT field identity type:
  `(table, row_id, field)` plus generated metadata validation for kind,
  state column, container key, sync mode, encryption rule, and scope.
- `[x]` Add host-facing document-field APIs across Rust, browser Worker/WASM,
  C/BoltFFI, Swift, Kotlin, and Java:
  `open_crdt_field`, `apply_yjs_update`, `materialize_json`,
  `snapshot_state_vector`, `compact`, and `observe_remote_updates`.
- `[x]` Define direct and queued variants.
  Direct APIs are acceptable for tests/CLI. UI apps should prefer queued worker
  APIs that return a command id immediately and report completion/events later.
- `[x]` Reuse the existing Yrs core for update application and
  materialization, but wrap it behind the field API so hosts never hand-roll
  update-log persistence, checkpoint selection, or decryption.
- `[x]` Add CRDT-specific ordered events.
  Events should include `event_seq`, `command_id`, field identity, changed
  tables, materialization state, checkpoint/compaction metadata, retry state,
  and error details.
- `[x]` Add state-vector and compaction semantics.
  The API should expose enough state-vector/checkpoint metadata for efficient
  editor sync and for pruning encrypted update logs without content loss.
- `[x]` Add encrypted CRDT field coverage.
  Multiple encrypted CRDT fields should share the same system tables while
  remaining partitioned by table/row/field/key/scope. Tests must prove hidden
  update/checkpoint rows never expose plaintext in outbox/server payloads.
- `[x]` Add no-blanking guards.
  Applying remote updates, replaying update logs, loading checkpoints, or
  compacting must never replace a previously materialized document with an
  accidental empty/default value.
- `[x]` Add app-layer adapter examples only.
  Provide small examples showing TipTap/ProseMirror or Excalidraw on top of the
  generic CRDT field API, but keep them out of Syncular core and out of the
  low-level binding contract.

## P0: CRDT Conformance Harness

Goal: prove CRDT behavior under the failure modes real editor apps hit.

- `[x]` Two clients edit the same CRDT field concurrently and converge.
- `[x]` Deterministic duplicate/reordered delivery tests.
- `[x]` Offline edits, reconnect, and catch-up tests.
- `[x]` Snapshot/checkpoint compaction tests with old update pruning.
- `[x]` Encrypted persistence roundtrip tests for updates and checkpoints.
- `[x]` Multi-field encrypted CRDT tests using one shared system table.
- `[x]` No UI-thread blocking assertions for queued document-field APIs.
- `[x]` Browser Worker/WASM CRDT tests covering local update, remote update,
  materialize, observe, compact, and close/reopen.
- `[x]` Native Swift/Kotlin/JVM smoke tests covering the same field API through
  generated bindings.

## P1: Cross-Platform Feature Parity Proof

Goal: move from local smokes to reliable behavioral parity.

- `[x]` Build a shared conformance runner that exercises the same scenarios
  against TypeScript browser, Rust SDK, Swift binding, Kotlin binding, and JVM
  binding where available.
- `[x]` Cover auth lifecycle: fresh headers, 401/403 refresh, revoked sessions,
  websocket reconnect after auth change, and client-id ownership.
- `[x]` Cover sync correctness: push/pull, offline queues, retry backoff,
  duplicate delivery idempotency, partial snapshots, chunk failure, and schema
  version negotiation.
- `[x]` Cover conflict behavior: persistence, keep-local retry, server-win,
  dismiss, and generated mutation base-version ergonomics.
- `[x]` Cover realtime/live queries: subscription setup, table dependency
  invalidation, duplicate/unsubscribe handling, reconnect wakeups, and ordered
  query refresh after sync pulls.
- `[x]` Cover blobs: staging, dedupe, upload retry, missing blob, auth failure,
  streaming native file paths, cache pruning, reference sync, and native
  binding upload/retrieve parity.
- `[x]` Cover E2EE: symmetric/asymmetric key helpers, push encryption, pull
  decryption, conflict rows, snapshot/chunk rows, and generated encrypted-field
  config.
- `[x]` Add real shell app validation:
  minimal macOS/iOS app, Android app, and JVM/desktop host lifecycle tests for
  open, background/foreground, queued writes, sync, live queries, and shutdown.

## P0: Rust Testkit And App Testing Harness `[x]`

Scope: recreate the public `@syncular/testkit` value for the Rust-first
client, so Syncular and app developers test with real SQLite clients,
in-process transports, disposable servers, generated schemas, fault injection,
and assertions instead of mocking Syncular internals.

- `[x]` Add a public `syncular-testkit` crate with temp/in-memory SQLite
  helpers, deterministic id/clock helpers, disposable resource helpers, and
  assertion helpers for rows, outbox, conflicts, blob queue/cache, native
  events, and CRDT materialization.
- `[x]` Add generated-schema app fixtures. The first fixture can target the
  repo todo schema, but the API must allow consuming apps to pass their own
  generated `AppSchema`, table adapters, generated mutations, and typed query
  modules.
- `[x]` Add in-process transport fixtures and fault injection equivalent to
  JS `withFaults`, covering before/after push/pull/chunk failures, latency,
  retry state inspection, duplicate delivery, schema negotiation, and auth
  failures.
- `[x]` Add optional native/BoltFFI-facing helpers for Swift/Kotlin/JVM smoke
  tests: temp DB paths, generated schema JSON injection, auth/subscription
  setup, event waiters, and typed row assertions.
- `[x]` Add a generic stateful `AppTestServer` for app-level convergence
  tests. It must accept arbitrary generated `AppSchema`, store app rows, apply
  pushed commits into server state, return later pull snapshots/commits from
  that state, merge server-merge CRDT/Yjs payloads using runtime metadata, and
  emit realtime sync wakeups after commits.
- `[x]` Migrate the Rust tests that currently hand-roll reusable fixture pieces:
  `protocol_contract.rs` mock transports, repeated `temp_db_path` helpers,
  app-schema JSON builders in native tests, blob queue assertions, CRDT
  convergence scaffolding, and generated todo fixture setup.
- `[x]` Document how apps use the testkit locally without starting a production
  server.

Progress:

- JS baseline reviewed: `@syncular/testkit` is a public package with
  in-process client/server fixtures, generic HTTP/Hono fixtures, deterministic
  clocks/IDs, disposable resources, protocol builders/parsers, realtime
  helpers, assertions, and `withFaults`. The Rust version should preserve that
  split: default generated-schema fixtures for quick tests, plus lower-level
  protocol/server/fault fixtures for Syncular conformance.
- Initial `syncular-testkit` crate added under `rust/crates/testkit` with
  disposable SQLite paths, deterministic ids/clocks, real Diesel todo fixtures,
  scriptable HTTP/realtime/blob `TestTransport`, `FaultTransport`, outbox/blob
  assertions, and smoke coverage.
- Added generic app fixtures that accept any generated `AppSchema`, so app test
  suites can open real isolated Diesel SQLite clients with their own generated
  schema instead of using the repo todo fixture or mocking Syncular.
- Added native-facing test helpers: open `NativeSyncularClient` with direct
  `AppSchema` or generated schema JSON, wait/drain native events, assert
  changed tables and JSON rows, build/apply todo operations, and run a
  disposable local HTTP sync server that captures real native requests.
- Added CRDT testkit helpers for Rust and native clients: build field request
  JSON, apply text updates, assert materialized values, and assert nonblank
  state/vector output.
- Added protocol builders and app-ready server helpers for snapshots, pull
  commits, duplicate pull commits, push conflicts, revoked subscriptions,
  schema-required/latest responses, not-ok responses, auth-expired HTTP
  responses, request waiting, dynamic request-dependent transport responses,
  and captured request JSON.
- Added Rust-only in-memory app fixtures for fast generated-schema tests; native
  fixtures intentionally use temp files because the native runtime opens
  multiple SQLite connections.
- Added `AppTestServer`, a stateful in-process server transport for app tests.
  It stores generated-schema rows, applies push commits with optimistic
  version checks, builds pull snapshots/commits from server state, emits
  realtime `Sync` events, keeps request/commit inspection hooks, stores test
  blobs, and uses the runtime Yjs metadata transformer for server-merge CRDT
  payloads. It filters self commits, can reverse/duplicate delivery for
  idempotency tests, and falls back to explicit `SyncChange.scopes` for
  envelope-only CRDT commits. Smoke coverage now proves writer/reader sync
  through server state, realtime wakeup pulls, and two-client server-merge
  CRDT convergence.
- Added `TestBlobServer`, a reusable local HTTP blob upload/download server;
  `blob_transport.rs` now uses it instead of a local copy.
- Syncular runtime tests now consume shared testkit helpers for native app
  schema JSON, temp DB/file paths, generic HTTP sync servers, and blob HTTP
  transport fixtures.
- Runtime `protocol_contract.rs` now uses public testkit primitives for generic
  HTTP snapshot sync, encrypted push capture, websocket push capture, bootstrap
  continuation, snapshot chunks, revocation, realtime wakeup pulls, worker auth
  headers, conflict responses, keep-local retry inspection, duplicate push/pull
  delivery, owner-conflict transport errors, retry backoff faults, not-ok
  responses, schema negotiation, and invalid-schema local rejection. Its local
  mock is narrowed to encrypted row/chunk/blob fixtures and lock-reentrancy.
- Runtime `crdt_field.rs` now uses `AppTestServer` for server-merge two-client
  convergence and duplicate/reordered delivery tests. The remaining local CRDT
  server is intentionally scoped to encrypted CRDT system-table assertions and
  ciphertext leak checks.
- Runtime `store_backends.rs` now uses `TestTransport` and protocol builders
  for generic backend parity flows: snapshot apply, revocation clearing,
  keep-local conflict retry, and retry-backoff deferral. The remaining local
  transports are scoped to encrypted CRDT system-table update/checkpoint
  payloads.
- App-facing usage examples are in `rust/crates/testkit/README.md`.
- Candidate migrations inventoried in `rust/crates/testkit/README.md`:
  remaining encrypted-specialized `protocol_contract.rs` fixtures,
  encrypted-specialized `store_backends.rs` fixtures, and any host smoke
  helpers that can be made app-generic without hiding important platform
  behavior.

Done when:

- Syncular's own Rust protocol/blob/CRDT/native tests use shared testkit
  primitives instead of local copies for common setup.
- A consuming Rust app can create an isolated SQLite-backed Syncular client
  with its generated schema, run local mutations/sync/CRDT/blob flows, and
  assert state without mocking Syncular.
- Swift/Kotlin/JVM smoke tests can share host-facing event/assertion helpers
  where practical.

Suggested verification:

- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`
- Representative migrated runtime tests after moving shared fixtures.
- `bun run rust:native-smoke` after native/BoltFFI-facing helpers land.

## P1: Browser Package Size And Performance

Goal: keep the Rust browser package shippable while preserving the Rust-only
architecture.

- `[x]` Add release WASM stripping with `wasm-opt -Oz` and custom-section
  removal.
- `[x]` Keep reproducible browser benchmarks for JS baseline versus Rust-owned
  IndexedDB and OPFS Worker storage.
- `[x]` Add checked package-size budgets for raw and gzip WASM outputs.
- `[x]` Add size attribution reports to the local release script so large
  changes identify the responsible crates/features.
- `[x]` Evaluate feature-gated package variants for blobs, E2EE, and CRDT.
  Only ship variants that actually remove bytes for apps that do not enable the
  corresponding generated schema features.
- `[x]` Keep OPFS Worker as an option, but avoid assuming it is faster than
  IndexedDB until benchmark data says so for the target workload.
- `[x]` Add benchmark scenarios for read-heavy live queries, CRDT updates,
  encrypted fields, blob metadata, large snapshots, and multi-table commits.

## P1: Native Packaging And Developer Experience

Goal: make the native bindings usable by real apps, not just generated smokes.

- `[x]` Finish local Linux JVM packaging verification.
- `[x]` Define and document Windows native packaging verification on a Windows
  host/runner.
- `[x]` Add Android Maven publication/signing decision and release process.
- `[x]` Add Swift XCFramework release checksum/package flow documentation.
- `[x]` Validate Android/iOS target matrices beyond the current local smokes.
- `[x]` Improve Swift/Kotlin generated query DSL ergonomics where real app
  integration shows friction.
- `[x]` Keep low-level bindings generic, but generate enough typed app helpers
  that app code does not handle raw JSON except at deliberate escape hatches.
- `[x]` Update local project integration docs after the P0 API cleanup and CRDT
  field API land.

## P2: Optional Server And Plugin Work

Goal: keep future work visible without blocking the Rust client foundation.

- `[!]` Rust server push plugin.
  Not required now because the Rust client keeps compatibility with the
  existing JS server. Blocked until a Rust server trait/ABI exists.
- `[x]` Pure Rust server or edge proxy investigation.
  Decision captured in `rust/docs/reference/SERVER_EDGE_INVESTIGATION.md`: do not start a
  Cloudflare Worker WASM server rewrite without a concrete product bottleneck.
- `[x]` Optional adapter packages for editor integrations.
  Current deliverable is `@syncular/client-crdt-adapters`; keep
  TipTap/ProseMirror, Excalidraw, and markdown-specific behavior outside core.
- `[x]` Optional storage/package variants for deployments that do not need
  blobs, E2EE, CRDT, or realtime.
  Decision captured in `rust/docs/reference/FEATURE_VARIANTS_DECISION.md`: the
  no-CRDT/no-E2EE/no-blob core build now has real byte savings, variant builds
  produce manifest/catalog metadata, and core conformance covers local schema
  opens plus Hono sync. Keep one npm package and avoid separate wrapper
  packages unless a concrete npm install-size requirement appears.

## Session Work Packages

Every implementation session should pick one work package, mark it `[~]`, keep
changes scoped to that package, and update its status/notes before stopping. If
a package grows too large, split it here instead of mixing unrelated work.

### WP-01 Browser SQL Safety `[x]`

Scope: harden the browser Kysely SQL boundary.

- Reject public `db` app-table writes that bypass Syncular mutations:
  `insertInto`, `updateTable`, `deleteFrom`, and raw mutating SQL.
- Reject public writes to Syncular internal tables from the Kysely SQL path.
- Preserve read/query-builder ergonomics for `select`, joins, filters, order,
  limits, and live queries.
- Keep generated `mutations` as the synced write API and prove it still writes
  local rows plus one outbox commit.
- Decide and document whether any explicit local-only scratch-table allowlist is
  needed later. Default is no.

Done when:

- `[x]` Browser tests prove mutating Kysely SQL fails with a clear error.
- `[x]` Generated mutation helpers still pass and still notify live queries.
- `[x]` The public README/API docs describe `db` as read/query-builder surface and
  `mutations` as the write surface.

Suggested verification:
`bun --cwd rust/bindings/browser test`, targeted browser runtime tests, and
`bun --cwd rust/bindings/browser tsgo`.

### WP-02 Runtime Schema Purity `[x]`

Scope: remove framework-owned generated app schema from product runtime.

- `[x]` Add an explicit app-schema JSON contract that can hydrate runtime
  `AppSchema` metadata without compiled app tables.
- `[x]` Wire browser Rust-owned SQLite to generated app-provided schema
  metadata instead of `crate::generated` todo metadata.
- `[x]` Generate TypeScript `syncularGeneratedAppSchema` and pass it to the
  Rust-owned SQLite Worker without changing the consumer-facing Kysely API.
- `[x]` Make the static native manifest schema-agnostic; app table metadata is
  now reported from the opened client handle's schema.
- `[x]` Add metadata-backed Diesel JSON fallback for native runtime operations
  when no compiled generated table adapter exists.
- `[x]` Add native `app_schema_json` injection and keep it across worker resume.
- `[x]` Generate Swift/Kotlin app-schema JSON constants with migrations and
  pass them through BoltFFI host smokes.
- `[x]` Split runtime system-table installation from demo app migrations for
  default Diesel and browser Rust-owned SQLite opens. Default opens now install
  Syncular system tables without creating `comments`, `projects`, or `tasks`.
- `[x]` Move demo/generated app schema out of `syncular-runtime` public product
  paths. The generated todo modules are crate-private and re-exposed only via
  the explicit `fixtures::todo` namespace.
- `[x]` Require injected `AppSchema`/schema JSON metadata for product runtime
  clients. Browser and generated native clients pass schema JSON; direct Rust
  and native defaults now open with empty app metadata. Demo CLI/tests opt into
  the demo schema explicitly.
- `[x]` Keep demo task schema only under examples, fixtures, or generator
  snapshots. Public access now goes through `fixtures::todo`; runtime fixture
  files now live under `src/fixtures/todo` behind fixture features.
- `[x]` Update tests and docs that currently rely on runtime-bundled generated
  app metadata. Tests now use `fixtures::todo` or host-provided schema JSON;
  runtime docs describe fixture-only generated app output.
- `[x]` Keep low-level bindings schema-agnostic. Browser and native bindings
  accept generic app-schema metadata; generated app code owns table-specific
  clients/helpers.

Remaining:

- Keep generated app schema/migration constants ergonomic; they are currently
  correct but emitted as large inline Swift/Kotlin strings.

Done when:

- `syncular-runtime` can be used without a compiled-in app schema.
- Example/test apps still generate and pass their own schema metadata.
- No product binding exposes task-specific or app-specific generated APIs.

Suggested verification:
Rust workspace tests, codegen drift checks, browser generated-app conformance,
and native smoke if touched.

### WP-03 Native Runtime Hardening `[x]`

Scope: make native UI runtime behavior production-shaped.

- `[x]` Add production timeout defaults for native HTTP/WebSocket transports.
- `[x]` Replace host-facing event waits with native stream/callback delivery.
- `[x]` Add queued worker APIs for blob queue processing, blob cache pruning, storage
  compaction, and long snapshot/query refresh work.
- `[x]` Add optional worker-owned open/migration/schema-validation path for UI apps.
- `[x]` Keep existing direct synchronous APIs for CLI/tests/simple apps.

Progress:

- Added `NativeClientOpenTask`, C FFI `syncular_native_client_open_async*`, and
  BoltFFI `openAsync`/`finishOpenTimeout` wrappers so Swift, Kotlin, JVM, and C
  hosts can open, migrate, and validate schema off UI-critical paths before
  using the normal native client.
- `SyncWorker` now exposes the same canonical event stream as the native
  facade through `subscribe_events(capacity)`. Each subscription is a fan-out
  stream with blocking `next_event()`, timeout `next_event_timeout(...)`, and
  `close()` wakeup semantics; slow bounded subscribers are closed instead of
  blocking the worker. The native facade event pump now consumes this worker
  subscription instead of owning the only clean event bus.
- Added `NativeWorkerEventConverter` plus helper functions for converting
  `SyncWorkerEvent` into the stable `NativeEvent`/JSON shape used by native
  bindings. This lets app-specific Rust wrappers keep their own worker layer
  while still using Syncular's ordered row/query/conflict/CRDT event contract.
- Added worker-owned retry wakeups for persisted outbox/blob retry timestamps.
  The worker computes the next due retry and arms `recv_timeout` for that exact
  wakeup, so retryable transport/blob failures no longer need an app-side
  manual trigger or polling loop.
- Added native SQLite runtime pragmas at connection open: WAL, busy timeout,
  foreign keys, and `synchronous=NORMAL`. Read-only query connections also set
  the busy timeout so UI reads wait briefly instead of failing immediately
  during writer activity.
- Native events now have explicit overflow semantics. Bounded worker/native
  event queues emit `EventsOverflowed` with `droppedCount` and
  `resyncRequired=true`, then close the overflowing subscription after that
  recovery event is delivered. Hosts must resubscribe and force a full
  live-query/bootstrap refresh before trusting incremental events again.
- Added a persistent realtime worker that owns websocket wakeups, reconnects
  with backoff, accepts auth header refreshes, and feeds `SyncWorkerTrigger`.
- Native `query_json` now uses a read-only executor with a persistent SQLite
  connection and a small prepared statement cache keyed by SQL, schema version,
  and declared table dependencies. The authorizer still runs when statements
  are prepared.

Done when:

- Native queued APIs cover local writes, sync, conflict commands, Yjs bursts,
  blob/compaction work, and long refresh work.
- Event delivery can block in a background stream reader without blocking
  unrelated queued commands.
- Timeout behavior has unit/integration coverage and clear error metadata.

Suggested verification:
Rust native tests, native facade tests, Swift/Kotlin/JVM binding smokes if FFI
surface changes.

### WP-04 CRDT Field Core `[x]`

Scope: implement the generic document-field primitive in Rust core.

- `[x]` Add `CrdtFieldId` or equivalent `(table, row_id, field)` identity.
- `[x]` Validate generated metadata for field kind, state column, container key, sync
  mode, encryption rule, and scope.
- `[x]` Add direct Rust APIs for `open`, `apply_yjs_update`, `materialize_json`,
  `snapshot_state_vector`, `compact`, and observe/refresh primitives.
- `[x]` Reuse existing Yrs state/update/envelope/materialization code.
- `[x]` Hide update-log persistence, checkpoint selection, and decryption details
  behind the field API.

Current notes:

- Rust direct APIs exist for opening a field, applying Yjs/text updates,
  materializing JSON, reading state vectors, and compacting/checkpointing.
- The first test covers the server-merge `__yjs` path without table-specific
  helpers.
- Encrypted update-log coverage uses the same field identity in Rust tests,
  browser Worker/WASM, native facades, and generated Swift/Kotlin/JVM helpers.
- Runtime validation now rejects invalid injected CRDT metadata for missing or
  non-text field/state columns, invalid scope columns, and field-level
  encryption overlap instead of trusting codegen-only validation.

Done when:

- Rust tests can open a field, apply updates, materialize JSON, read state
  vector metadata, compact/checkpoint, close/reopen, and retain content.
- Plaintext `__yjs` and encrypted update-log modes are both represented through
  the same field identity model.

Suggested verification:
Runtime CRDT tests and generated Rust app tests.

### WP-05 CRDT Host APIs `[x]`

Scope: expose the generic CRDT field primitive to hosts.

- `[x]` Add browser Worker/WASM APIs for the CRDT field operations.
- `[x]` Add queued native worker commands for CRDT field updates and
  compaction where UI hosts need nonblocking behavior.
- `[x]` Add C/BoltFFI, Swift, Kotlin, and Java wrapper methods.
- `[x]` Add CRDT-specific ordered events with `event_seq`, `command_id`, field
  identity, changed tables, materialization state, checkpoint/compaction
  metadata, retry state, and errors.
- `[x]` Keep TipTap/ProseMirror/Excalidraw out of low-level bindings.

Current notes:

- Native direct JSON APIs now expose `open_crdt_field`, text/Yjs updates,
  materialization, state-vector snapshots, and compaction through generic
  `(table, rowId, field)` identity.
- Native queued generic Yjs updates route to the correct server-merge or
  encrypted-update-log worker command based on generated schema metadata.
- Native queued generic text updates and compaction now run through the worker
  with `LocalWriteCommitted`, `CrdtFieldChanged`/`CrdtFieldCompacted`, and
  `WorkerCommandCompleted` events as appropriate. Direct materialization and
  state-vector reads remain synchronous read APIs.
- C FFI and regenerated BoltFFI Swift/Kotlin/Java wrappers expose the generic
  CRDT field methods without table-specific bindings.
- Browser Worker/WASM APIs now expose the same generic field shape for
  server-merge and encrypted update-log Yjs fields using the Rust-owned
  SQLite/Kysely runtime. The TypeScript wrapper delegates field persistence,
  materialization, state vectors, and compaction to Rust instead of duplicating
  update-log logic in TS.
- A dynamic-schema CRDT bug was fixed: server-merge CRDT updates now merge onto
  an existing row instead of constructing a partial required-column row from the
  `__yjs` envelope.
- Browser Hono/WASM coverage now proves generated app server-merge CRDT field
  writes, encrypted update-log writes, encrypted compaction, materialization,
  state-vector snapshots, and no plaintext leakage in encrypted outbox/system
  payloads.
- Native host events now include CRDT-specific `CrdtFieldChanged` and
  `CrdtFieldCompacted` events. Direct and queued field writes preserve existing
  `RowsChanged` behavior while adding ordered `event_seq`, `command_id` where
  applicable, field identity, changed tables, commit ids, duration metadata,
  and checkpoint metadata in `payload_json`.
- CRDT field events now also carry additive materialization metadata:
  `syncMode`, `kind`, state/container column names, `materializationAvailable`,
  `hasState`, and `stateVectorBase64` when available. Queued compaction
  completions include field identity and `minUncheckpointedUpdates` even when
  no checkpoint is created.
- Failed queued CRDT writes now emit `LocalWriteFailed` with additive
  `payload_json` containing operation, field identity, `failedBeforeCommit`,
  and `retryScheduled: false`, so UI hosts can correlate errors without
  maintaining a separate command-request cache.
- Generated Swift/Kotlin app clients include schema-derived queued CRDT text
  and queued CRDT compaction helpers, and the BoltFFI Swift/Kotlin headers and
  wrappers include the matching low-level methods.
- Added `@syncular/client-crdt-adapters` with generic Yjs document-field
  adapters. It shows how TipTap/ProseMirror or Excalidraw/Yjs app code can
  connect editor update hooks to Syncular CRDT fields without adding editor
  schemas or UI bridge behavior to Syncular core.

Done when:

- Browser, Swift, Kotlin, and JVM smokes can call the field API without raw
  Yjs persistence plumbing.
- Events are ordered and can be correlated to queued commands.

Suggested verification:
Browser Worker/WASM tests, native facade tests, Swift/Kotlin/JVM smokes.

### WP-06 CRDT Conformance `[x]`

Scope: prove CRDT behavior under real collaboration failures.

- `[x]` Two clients edit the same field concurrently and converge.
- `[x]` Deterministic duplicate and reordered remote delivery tests.
- `[x]` Offline edit, reconnect, catch-up, and close/reopen tests.
- `[x]` Snapshot/checkpoint compaction and old update pruning tests.
- `[x]` Encrypted update/checkpoint persistence roundtrip tests.
- `[x]` Multi-field encrypted CRDT tests sharing the same system tables.
- `[x]` No-blanking tests for remote apply, replay, checkpoint load, and
  compaction.
- `[x]` No UI-thread blocking assertions for queued document-field APIs.

Current notes:

- Added a deterministic in-memory CRDT sync server to the Rust conformance
  tests. It bootstraps clients, accepts offline server-merge Yjs commits,
  replays remote commits through `sync_http`, and verifies both clients converge
  to the same non-empty materialized value.
- The first conformance case also proves close/reopen persistence by reopening
  the SQLite database and materializing the same field state after convergence.
- Added an encrypted update-log conformance case using the same deterministic
  server. Two clients edit offline, sync ciphertext-only system-table rows,
  converge after catch-up, reopen from SQLite, and assert server state never
  contains plaintext Yjs payloads.
- Added a multi-field encrypted case that routes two different CRDT streams
  through the same `sync_crdt_updates` table and verifies a second client pulls
  and materializes each field independently without plaintext on the server.
- Added native and browser-owned SQLite coverage for encrypted checkpoint
  creation followed by covered-update pruning. This exposed and fixed missing
  server-sequence propagation for pushed encrypted CRDT system rows, so local
  updates/checkpoints can become checkpointable/prunable immediately after push
  ack.
- Browser storage compaction no longer asks for host time when no
  `olderThanMs` cutoff is configured, avoiding a `SystemTime` panic in
  `wasm32-unknown-unknown` for encrypted-CRDT-only compaction.
- This exposed and fixed a remote server-merge bug: pulled `__yjs` changes now
  merge against the existing local row before being applied in both Diesel
  SQLite and browser Rust-owned SQLite stores, preventing partial rows and
  accidental blanking.
- Fixed the pre-bootstrap no-blanking case for encrypted CRDT fields. Bootstrap
  snapshot clears now use a preserve-local-CRDT path, and app-row upserts keep
  existing encrypted CRDT materialized columns when a local Yjs state exists.
  Native and browser Hono/WASM tests now edit before the first bootstrap sync
  and verify the materialized text survives.
- Added a deterministic reversed-and-duplicated remote delivery mode to the
  in-memory CRDT server and verified a third client converges without blanking
  or replay drift after pulling the same remote Yjs commits out of order.
- Added a native facade busy-worker test that holds the sync worker inside a
  delayed HTTP sync, then verifies queued CRDT field updates return immediately
  and commit after the worker resumes.
- Generated Swift/Kotlin native app clients now expose generic CRDT field
  protocol methods plus schema-derived text-field helpers, including queued
  text and queued compaction helpers. The local native smoke applies,
  materializes, and validates queued helper JSON for the todo `tasks.title`
  CRDT field through the mock clients, Swift BoltFFI host, and Kotlin/JVM
  BoltFFI host.
- Added a runtime guard for non-empty text CRDT fields that have no stored Yjs
  state yet. The client now rejects ambiguous plain-text replacement instead
  of silently merging duplicate text; apps should initialize/migrate CRDT
  state before editing populated legacy text fields.
- Added encrypted checkpoint reopen coverage after local covered-update
  pruning. A client now materializes from the retained encrypted checkpoint
  after process reopen and verifies server payloads still contain no plaintext
  state or update material.

Done when:

- The CRDT harness fails deterministically on divergence, plaintext leakage,
  accidental blank materialization, or blocked queued API behavior.
- Browser and native binding smoke coverage exists for the same field flows.

Suggested verification:
Runtime CRDT harness, browser CRDT tests, native binding smokes.

### WP-07 Browser Size And Performance `[x]`

Scope: keep the Rust browser package shippable.

- `[x]` Add raw/gzip WASM size budgets to package checks.
- `[x]` Add size attribution reports to the release/build script.
- `[x]` Track the current optimized baseline: about `2.93 MiB` raw and
  `1.20 MiB` gzip after `wasm-opt -Oz` plus custom-section stripping.
- `[x]` Evaluate feature-gated variants for blobs, E2EE, and CRDT only if they
  measurably reduce shipped bytes for apps that do not use those features.
- `[x]` Expand benchmarks for read-heavy live queries, CRDT updates, encrypted
  fields, blob metadata, large snapshots, and multi-table commits.
- Keep OPFS Worker as an option, but let data decide whether it is preferred
  over IndexedDB for each workload.

Current notes:

- `build:wasm` now runs `size-syncular-wasm.ts --check` after the optimized
  release build and writes an attribution report to
  `.context/wasm-size/syncular-wasm-size.txt`.
- Current budgets are `3.25 MiB` raw and `1.35 MiB` gzip, overrideable through
  `SYNCULAR_WASM_RAW_BUDGET_BYTES` and `SYNCULAR_WASM_GZIP_BUDGET_BYTES` for
  deliberate release-size decisions.
- Latest local browser CI verification: `bun run rust:ci:browser` passes,
  including browser unit tests, TypeScript checking, the CRDT adapter example
  test, release WASM build, and size budget check. The release artifact measured
  `2.92 MiB` raw and `1.20 MiB` gzip, leaving `339.4 KiB` raw and `152.6 KiB`
  gzip headroom.
- The first attribution report is section-level plus `twiggy top`. Because the
  shipping artifact strips custom sections, function names are intentionally
  not preserved in the released WASM; deeper crate-level attribution should use
  a separate non-shipping profiling artifact if needed.
- The old browser feature benchmark scripts were removed with the legacy
  TypeScript client/perf tree. Use the Rust browser `tsgo`, test, WASM build,
  size, generated-code, and conformance gates as the current browser package
  validation path.
- The old local mutation benchmark was updated to install the generated app
  schema explicitly for low-level Rust-owned SQLite opens, matching the
  schema-agnostic runtime decision instead of relying on bundled app tables.
- Latest local feature run with `operations=50`, `rounds=5`,
  `storage=indexedDb` reported median times: read-heavy query `36.54ms`, live
  refresh `65.12ms`, CRDT text updates `200.68ms`, encrypted field push
  `11.41ms`, encrypted CRDT text updates `283.28ms`, blob metadata `19.33ms`,
  large local snapshot read `244.25ms`, and multi-table commit `9.89ms`.
- Feature variants are not worth shipping as package aliases right now. The
  current browser artifact is one canonical Rust-owned SQLite runtime; `cargo
  tree` shows `web-owned-sqlite` intentionally pulls CRDT support, and E2EE
  helpers are compiled into the low-level API. Publishing a second wrapper
  around the same WASM would not remove shipped bytes.
- The first feature boundary now exists: `crdt-yjs` owns the optional `yrs`
  dependency, so `--no-default-features` runtime builds no longer link Yrs and
  CRDT/Yjs calls return an explicit runtime capability error. The canonical
  browser artifact still enables `web-owned-sqlite`, which enables `crdt-yjs`.
- Verification for the first boundary: `cargo tree -p syncular-runtime
  --no-default-features --edges normal,build -i yrs` prints no shipped
  dependency path, while the same command with `--features crdt-yjs` shows the
  expected `yrs -> syncular-runtime` edge. `cargo check -p syncular-runtime
  --no-default-features` and the `web-owned-sqlite` wasm target check with
  Homebrew LLVM clang both pass.
- Dependency scan for the next boundary shows E2EE/crypto is the next real
  size candidate: no-default normal/build edges still include `argon2`,
  `bip39`, `chacha20poly1305`, `hkdf`, `pbkdf2`, `sha2`, and `x25519-dalek`.
  This should be a separate scoped chunk because encryption types are part of
  core, web, native, and binding APIs.
- The E2EE boundary now exists too: `e2ee` owns `argon2`, `bip39`,
  `chacha20poly1305`, `hkdf`, `pbkdf2`, `x25519-dalek`, and the runtime's
  direct `zeroize` feature edge. No-E2EE builds keep the public
  encryption/encrypted-CRDT API shape and return clear runtime capability
  errors from E2EE calls. The canonical browser artifact still enables
  `web-owned-sqlite`, which enables `e2ee`.
- Verification for the second boundary: no-default normal/build dependency
  trees no longer show the targeted E2EE crypto crates; the same tree with
  `--features e2ee` shows the expected direct `chacha20poly1305` and
  `x25519-dalek` edges. Native no-E2EE builds can still show `base64` through
  `reqwest` and `zeroize` through `rustls`, so those are not pure E2EE size
  signals. Default runtime checks, `--no-default-features --features
  e2ee,crdt-yjs`, native no-E2EE, BoltFFI no-E2EE, no-default runtime checks,
  and the `web-owned-sqlite` wasm target check with Homebrew LLVM clang pass.
- Internal optimized variant measurement now exists. The canonical
  `web-owned-sqlite` artifact measured `3,058,242` raw bytes and `1,258,293`
  gzip bytes. The internal `web-owned-sqlite-core` artifact, which removes
  CRDT/Yrs, E2EE crypto, and blob upload/cache helpers from the browser base,
  measured `2,296,548` raw bytes and `947,836` gzip bytes. Savings are
  `743.8 KiB` raw and `303.2 KiB` gzip, about `24.7%` of canonical gzip size.
  This clears the measurement gate for a possible no-CRDT/no-E2EE/no-blob
  browser artifact, but the product package should stay single-artifact until
  packaged artifact layout and per-variant conformance exist.
- Runtime capability validation now guards the split: Rust open rejects an
  injected app schema that requires missing `blobs`, `crdt-yjs`, or `e2ee`, and
  generated TypeScript app clients emit
  `syncularGeneratedRequiredRuntimeFeatures` from schema metadata instead of
  always requiring the full `web-owned-sqlite` feature.
- Generated browser artifact selection now exists. The browser runtime accepts
  an ordered `runtimeArtifacts` catalog, generated clients pass
  schema-derived `requiredRuntimeFeatures`, and the Worker opens the first
  compatible WASM glue/WASM URL pair. The current package still defaults to the
  canonical full artifact unless an app/package provides additional built
  artifacts.
- Direct Rust WebSocket transport is no longer a browser feature-boundary
  candidate. Browser app realtime lives in the TypeScript Worker controller,
  and Rust owns binary sync-pack decode/apply plus native WebSocket support.
  Removing browser Rust WebSocket ownership is a product-boundary cleanup, not
  a meaningful package-size lever.
- Browser variant builds now write `syncular-runtime-artifact.json` next to
  each optimized artifact and `dist/syncular-runtime-artifacts.json` as an
  ordered catalog. The public browser package exposes
  `resolveSyncularRuntimeArtifactCatalog` and
  `getSyncularPackagedRuntimeArtifacts`, so generated app clients can select
  the smallest compatible artifact by feature requirements without changing the
  query/mutation API. The browser package `build` now produces the full/core
  artifact pair plus the catalog.
- OPFS Worker remains available through the storage option, but local mutation
  and feature benchmark data currently favor IndexedDB for the default browser
  workload.

Done when:

- `[x]` Package checks fail on size regressions beyond the documented budget.
- `[x]` Benchmark output remains reproducible and records ratios for the important
  workloads.
- `[x]` Any proposed package variant has measured byte savings and a clear loading
  story.

Suggested verification:
`bun run --cwd rust/bindings/browser build:wasm`,
`bun --cwd rust/bindings/browser size:wasm`, browser benchmarks, and package
typecheck.

### WP-08 Shared Feature Conformance `[x]`

Scope: prove TypeScript, Rust, Swift, Kotlin, and JVM behave the same against
the same server scenarios.

- `[x]` Build a shared conformance runner/harness.
- `[x]` Cover auth lifecycle: fresh headers, 401/403 refresh, revoked sessions,
  websocket reconnect after auth change, and client-id ownership.
- `[x]` Cover sync correctness: push/pull, offline queues, retry backoff, duplicate
  delivery idempotency, partial snapshots, chunk failure, and schema version
  negotiation.
- `[x]` Cover conflicts: persistence, keep-local retry, server-win, dismiss, and
  generated mutation base-version ergonomics.
- `[x]` Cover realtime/live queries: subscriptions, table dependency invalidation,
  duplicate/unsubscribe behavior, reconnect wakeups, and ordered refresh after
  sync pulls.
- `[x]` Cover blobs and E2EE across the same scenarios.

Current notes:

- Added `examples/todo-app/conformance/generated-client.json` as the first
  shared scenario fixture for generated clients. It pins task mutation JSON,
  subscriptions, native query SQL/params/tables, TypeScript Kysely SQL, and
  generic CRDT request envelopes.
- TypeScript browser conformance and Rust SDK example tests now read the same
  fixture instead of duplicating operation/query constants.
- Swift and Kotlin generated-client command-line smokes now receive the same
  fixture from `native-smokes/run-local.sh` and compare generated operation,
  query, and CRDT helper JSON semantically.
- The shared fixture caught a Swift wire-contract mismatch for delete
  operations. `syncular-codegen` now emits custom Swift encoding for
  `SyncularGeneratedOperation` so optional `payload` and `base_version` are
  serialized as explicit JSON nulls, matching Rust, TypeScript, and Kotlin.
- Added `examples/todo-app/conformance/sync-scenarios.json` as the first
  shared server-behavior fixture. Browser Hono/WASM tests and Rust protocol
  contract tests now read the same actor ids, subscription ids, revoked-row
  scenario, retry-backoff scenario, and version-conflict scenario.
- Added browser Hono coverage for persisted version conflicts from the shared
  fixture. This exposed a server parity gap: generic server-handler conflicts
  now include stable `VERSION_CONFLICT` codes, matching the Rust conflict
  contract.
- Added `bun run rust:conformance` as the local shared conformance command for
  Rust protocol contracts, Rust generated SDK examples, browser generated
  client conformance, and browser Hono/WASM sync scenarios.
- Extended the shared sync scenario fixture into realtime. Browser Hono/WASM
  realtime and Rust protocol realtime tests now share actor/token, websocket
  token, client ids, presence event, expected event ordering, and wakeup task
  metadata. Rust worker auth header coverage also reads the shared fixture.
- Extended the same fixture into field-level E2EE. Rust protocol tests verify
  just-in-time encrypted push payloads and browser Hono/WASM tests verify the
  server receives encrypted field envelopes instead of plaintext.
- Extended the same fixture into blob transport. Rust native HTTP blob tests
  and browser Hono/WASM blob tests now share blob actor/auth identity,
  payloads, MIME types, retry expectations, upload/download paths, and queue
  result invariants. `bun run rust:conformance` now includes native blob
  transport plus the browser blob Hono suite.
- TypeScript, Swift, and Kotlin generated-client conformance now also consumes
  the shared sync-scenario E2EE rule/key/prefix fixture and verifies generated
  field-encryption config helpers produce the same contract.
- Chunked snapshot sync behavior now reads from the shared fixture too. Browser
  Hono/WASM covers failed chunk fetches without partial local apply, while the
  Rust protocol contract covers chunk metadata, scoped chunk fetches, and
  applied chunk rows from the same scenario.
- Added a shared auth-refresh scenario. Browser Hono/WASM now proves a stale
  auth header triggers the worker auth lifecycle refresh and retries the sync
  request with the refreshed header, with request header ordering pinned in the
  fixture.
- Added a shared revoked-session scenario. Browser Hono/WASM now proves a 401
  sync response calls the auth lifecycle, respects a declined refresh/retry,
  and surfaces the original auth error without looping. The standalone Hono
  auth refresh suite is now part of `bun run rust:conformance`.
- Added a shared repeated-pull idempotency scenario. Rust protocol tests use it
  for duplicate pull-commit delivery, while browser Hono/WASM uses the same row
  metadata to verify repeated pulls of server state stay single-row and keep
  the subscription cursor stable.
- Added a shared duplicate-push scenario. Rust protocol tests use duplicate
  transport responses to prove one outbox commit remains acked once, and browser
  Hono/WASM proves the generated mutation pushes once, the second push is empty,
  the server stores one row, and no conflicts are created.
- Exposed conflict summaries, keep-local retry, and resolve through the browser
  Rust client and Worker protocol instead of requiring unsafe SQL. Browser
  Hono/WASM conflict coverage now uses the public conflict API and verifies
  keep-local retry pushes the local row after rebasing to the server version.
- Browser Hono/WASM also covers the non-retry conflict resolution path now:
  `resolveConflict(..., "keep-server")` clears the persisted conflict via the
  public API without enqueuing a local retry.
- Canonical conflict resolution naming now matches the pre-Rust Syncular API:
  Rust `accept_server()` stores `keep-server`, and the shared fixture also
  covers `dismiss` without retrying local changes.
- Browser Hono/WASM realtime coverage now includes websocket reconnect after
  auth/header changes. The shared fixture pins the initial and refreshed
  websocket tokens, and the worker is proven to resolve fresh realtime params
  before reconnecting to the real Hono websocket route.
- Browser Hono/WASM live-query coverage now uses the shared sync scenario
  fixture to prove sync-pull invalidation order, table dependency refreshes,
  duplicate unsubscribe idempotency, and no stale live-query events after
  unsubscribe.
- Field-level E2EE conformance now covers pull-side decryption too. Browser
  Hono/WASM pushes ciphertext to the server and pulls plaintext through a
  second Rust/WASM client with the same key, while the Rust protocol contract
  applies encrypted snapshot rows and verifies local plaintext storage.
- E2EE conflict conformance now covers encrypted conflict `server_row` values.
  Rust protocol and browser Hono/WASM both prove the server can return
  ciphertext in a conflict response while the client persists decrypted,
  app-shaped `server_row_json` in local conflict metadata.
- E2EE snapshot-chunk conformance now covers successful encrypted chunk
  delivery. Rust protocol and browser Hono/WASM both fetch encrypted chunk rows
  and verify the local app table stores decrypted plaintext.
- Blob conformance now includes cache pruning. The shared fixture pins a
  two-entry byte budget, browser Hono/WASM and native Rust both prune the
  oldest cached blob, and the browser wrapper now converts WASM `i64` BigInt
  values at the `pruneBlobCache` boundary.
- Blob reference sync now has shared fixture coverage. Browser Hono/WASM uses
  the generated Kysely database and mutation surface to push a `BlobRef` row,
  uploads the referenced bytes through the real blob routes, verifies the Hono
  server stores the blob column as SQLite JSON text, verifies a second
  Rust-owned browser client reads the row back as an app-shaped `BlobRef`, and
  retrieves/caches the referenced bytes. The Rust protocol contract also proves
  the Diesel store persists app-shaped snapshot `BlobRef` rows as SQLite JSON
  text.
- Generated Swift and Kotlin clients now expose configured blob columns as
  `SyncularBlobRef?` instead of raw strings. Their generated row decoders accept
  SQLite JSON text or object-shaped JSON, generated mutation payloads emit
  app-shaped blob refs, and the native command-line smoke fixture proves the
  same blob reference used by browser/Rust conformance.
- Schema-version conformance now includes browser Hono/WASM coverage against
  the real Hono route for server-required future schemas, server-reported
  latest future schemas, and local future outbox schema rejection before any
  HTTP push is sent. The Hono route can now emit configured
  `requiredSchemaVersion` and `latestSchemaVersion`, and the shared protocol
  schema/generated HTTP client types expose those optional fields.
- The shared TS protocol schema now also carries conflict `code` on conflict
  results, matching the Rust protocol and server's stable
  `VERSION_CONFLICT` response.
- Client-id ownership conflict coverage now spans browser/Hono and Rust
  protocol contract tests from the same `ownerConflict` fixture. The Rust
  client records the shared client id, surfaces the server-style `HTTP 400`
  transport failure, and does not create push/outbox work for a pull-only
  ownership rejection.
- Native injected-schema clients now have the missing dynamic subscription
  path. `NativeSyncularClient`, C FFI, BoltFFI Swift/Kotlin/Java wrappers, and
  the generated Swift/Kotlin app clients expose subscription JSON helpers, and
  `native-smokes/run-local.sh` starts the real Hono sync server and proves
  Swift plus Kotlin/JVM can set auth, set the generated task subscription,
  enqueue sync, receive `SyncCompleted`, query pulled rows, push generated
  task mutations, then pull those pushed rows into a second native client.
- The same Hono-backed native smokes now cover auth refresh behavior for Swift
  and Kotlin/JVM: a stale bearer token produces a command-correlated
  `AuthExpired` native event, `setAuthHeadersJson` refreshes the hot worker in
  place, and the next sync succeeds without reopening the client.
- Native server-sync smokes now also cover version-conflict persistence and
  keep-local retry for Swift and Kotlin/JVM against the real Hono route. Each
  platform writes a stale-base generated task mutation, sees a stored conflict
  summary with stable code/server version, resolves it via queued
  `enqueueResolveConflict(..., "keep-local")`, pushes the retry commit, and
  proves a second native client pulls the local winner.
- Native server-sync smokes also cover non-retry conflict outcomes for Swift
  and Kotlin/JVM. Separate Hono-seeded rows prove
  `enqueueResolveConflict(..., "keep-server")` and
  `enqueueResolveConflict(..., "dismiss")` clear the pending conflict without
  returning a retry commit id.
- Native server-sync smokes now run against a Bun-backed Hono route with
  WebSocket upgrades enabled. Swift and Kotlin/JVM each enqueue one generated
  local write, push it through `enqueueSyncWebsocket`, and prove a second
  native client can pull the websocket-pushed row.
- Native server-sync smokes now mount the real Hono blob routes too. Swift and
  Kotlin/JVM store a local blob file through the native binding, drain the blob
  upload queue into the Hono server, enqueue a generated task mutation with the
  typed `BlobRef`, pull the synced row into a second native client, and
  retrieve the referenced bytes back through the native binding.
- The same native blob smoke now covers auth-failure retry semantics for Swift
  and Kotlin/JVM. A stale-auth upload remains pending through retryable
  failures, becomes failed after the configured max attempts, and keeps the
  local cache entry available for app recovery/inspection.
- Native Swift/Kotlin/JVM also now prove missing remote blob retrieval surfaces
  an HTTP 404 and does not create a local cache entry.
- Native server-sync smokes now also cover field-level E2EE against the real
  Hono route. The writer installs generated encryption config and pushes a
  task with an encrypted title; a normal reader sees the ciphertext envelope,
  while a second reader with the same generated config pulls decrypted
  plaintext.
- Native server-sync smokes now cover subscription revocation for Swift and
  Kotlin/JVM. Each client first pulls a scoped row, switches the generated
  subscription to an actor scope the authenticated user does not own, verifies
  the local row is cleared, restores the valid subscription, and pulls the row
  again.
- Native server-sync smokes now also prove generated live-query refresh after
  a real server pull. Swift and Kotlin/JVM register a typed generated live
  query before the reader sync, receive `QueriesChanged` after
  `SyncCompleted`, and refresh typed rows through the generated helper.
- Native server-sync smokes now cover schema-version negotiation for Swift and
  Kotlin/JVM against real Hono routes. A future `requiredSchemaVersion` route
  emits a command-correlated `SyncFailed` event containing the schema error,
  while a future `latestSchemaVersion` route still completes sync.
- Native server-sync smokes now cover client-id ownership conflicts for Swift
  and Kotlin/JVM. One native client claims a client id as the normal actor; a
  second native client reuses that id with another authenticated actor and gets
  a command-correlated `SyncFailed` event exposing the server's HTTP ownership
  error.
- Latest local verification for this work package: `bun run rust:conformance`
  and `bun run rust:conformance:native` passed. Coverage includes Rust
  protocol/blob, generated Rust SDK, browser Hono/WASM scenarios, Swift plus
  Kotlin/JVM generated clients, lifecycle smokes, native server sync, blob
  happy path, auth-failure retry/fail behavior, missing-blob failure, E2EE,
  revocation, live queries, schema negotiation, and client-id ownership.
- Latest combined local conformance verification: `bun run rust:conformance:all`
  passes end to end.

Done when:

- A single scenario definition can run against at least TypeScript browser and
  Rust SDK, with Swift/Kotlin/JVM wired where local toolchains are available.
- Failures identify the platform and invariant that diverged.

Suggested verification:
Shared conformance command plus platform-specific smoke commands.

### WP-09 Real Native App Lifecycle `[x]`

Scope: validate bindings in actual app lifecycle shells.

- `[x]` Add minimal iOS shell app validation.
- `[x]` Add minimal Android shell app validation.
- `[x]` Add JVM/desktop lifecycle validation where useful.
- `[x]` Exercise open, background/foreground, queued writes, sync, live queries,
  CRDT field updates, blobs, and shutdown.
- `[x]` Capture platform-specific thread and lifecycle constraints in docs.

Progress:

- Generated Swift/Kotlin clients now expose native event command metadata
  (`eventSeq`, `commandId`, `clientCommitId`, `durationMs`) so UI shells can
  correlate queued commands with native worker events.
- Native worker/facade events now expose generic app-schema row deltas through
  `changedRows` on local writes, sync completion, row/query invalidation, and
  queued write commits. The deltas include table, row id, operation, changed
  fields, CRDT/Yjs state fields, subscription id, server version, and commit
  metadata so app bridges can update active documents and list/read models
  without full table/bootstrap refreshes. Generated Swift/Kotlin clients decode
  the same `SyncularChangedRow` shape.
- Codegen now wraps those generic deltas in generated table-specific helpers
  across Rust, browser TypeScript, Swift, Kotlin/JVM, and Android. Hosts can
  ask for `taskChangedRows(event)`/`task_changed_rows(&rows)` and branch on
  typed field flags such as `changed.title`, `changed.completed`, and
  `crdt.title_yjs_state`/`titleYjsState` instead of open-coded table and column
  strings. Row mutation operations are normalized to `insert`, `update`, and
  `delete`; CRDT compaction remains a field-level CRDT event.
- Generated row-delta helpers are now exercised in Rust, Swift, and Kotlin
  generated-client smokes, not only string-checked. The smoke locks the
  cross-platform contract that unknown columns are retained in the raw event
  metadata but do not appear as known typed field changes.
- Generated Swift/Kotlin clients now include table-namespaced mutation helpers
  (`client.mutations.tasks.insert/update/delete` and
  `client.queuedMutations.tasks.insert/update/delete`) on top of the
  schema-agnostic low-level `applyMutationJson` and `enqueueMutationJson`.
- Added local Swift and Kotlin lifecycle shell smokes. They open a real
  BoltFFI-backed native client, keep the worker hot, register a live query,
  enqueue blob file storage, enqueue a typed generated mutation containing a
  `SyncularBlobRef`, enqueue a generated CRDT text update, refresh the live
  query from native events, enqueue an explicit sync command, verify
  command-correlated events/outbox state, and shut down cleanly.
- The lifecycle smoke documents a real CRDT constraint: a CRDT-backed text
  field should be initialized empty or with existing Yjs state before queued
  CRDT text replacement. Replacing non-empty plaintext without Yjs state is
  rejected by the runtime.
- Added an iOS simulator XCTest app harness under
  `examples/todo-app/native-smokes/ios-lifecycle`. It builds a fresh local
  simulator `Syncular.xcframework` into `.context`, links the generated Swift
  app client plus BoltFFI wrapper, opens the native worker inside an iOS app,
  runs queued blob/mutation/CRDT/live-query/sync-failure/shutdown flow, and
  passes on `iPhone 17`.
- Added an Android instrumentation app harness under
  `examples/todo-app/native-smokes/android-lifecycle`. It builds
  `syncular-runtime` for `aarch64-linux-android`, links generated JNI glue
  against the Rust staticlib into `libsyncular_runtime.so`, packages the
  generated Android Kotlin client plus BoltFFI wrapper, runs the same lifecycle
  flow on the `syncular_native_api36_arm64` emulator, and passes.
- The real app smokes exposed release-packaging drift: the checked-in Swift
  xcframework and Android packaged JNI libs can lag generated headers/glue.
  The smokes deliberately build fresh local artifacts under `.context`; WP-10
  needs to make this the repeatable release path.
- iOS currently emits UIKit/thread-performance diagnostics during the smoke:
  app hosts should keep open/migration/sync setup off the UI-critical path
  where startup cost matters.
- macOS-specific app lifecycle validation is still optional follow-up; iOS,
  Android, and JVM/desktop command-line host coverage now prove the generated
  binding APIs in real host runtimes.
- Runtime and local integration docs now capture the native app lifecycle
  rules: keep open/migration/schema validation off UI-critical paths, keep the
  worker hot, use queued APIs for bursty work, drain ordered events by
  `eventSeq`/`commandId`, refresh auth before foreground sync/realtime
  reconnect, respect platform background budgets, and call `shutdown()` during
  teardown.
- Command-line native server-sync smokes now run against the real Hono route
  for Swift and Kotlin/JVM. This caught and closed the dynamic-subscription gap
  for injected app schema JSON, and the generated clients now provide
  `SyncularSubscriptionSpec` builders so app code does not hand-roll
  subscription JSON for normal sync setup. The same smokes now cover
  native-to-server HTTP/WebSocket push, keep-local retry, keep-server, dismiss,
  and second-client pull for generated task mutations.

Done when:

- Generated Swift/Kotlin APIs are proven in real app shells, not only compile
  or command-line smokes.
- Any lifecycle constraints are documented as SDK rules or fixed in the native
  runtime.

Suggested verification:
Local Xcode/SwiftPM app smoke, Android emulator/device app smoke, JVM smoke.

### WP-10 Native Packaging And Release `[x]`

Scope: finish packaging and developer experience after API hardening.

- `[x]` Finish Linux JVM packaging verification.
- `[x]` Define Windows JVM packaging verification. With BoltFFI `0.24.1`,
  Windows JVM packaging is host-only and must run on a Windows runner/host.
- `[x]` Decide Android Maven publication/signing flow and document it.
- `[x]` Document Swift XCFramework zip/checksum release flow.
- `[x]` Validate Android/iOS target matrices beyond current local smokes.
- `[x]` Make Swift and Android release packaging regenerate headers/glue/native
  artifacts together. The iOS and Android lifecycle smokes now avoid stale
  checked-in artifacts by building local `.context` packages first.
- `[x]` Improve Swift/Kotlin generated query DSL ergonomics based on real app
  integration findings.
- `[x]` Update local project integration docs after WP-01 through WP-06 land.

Progress:

- Added `rust/scripts/package-native-bindings.sh` and root package scripts
  `rust:native:package`, `rust:native:package:apple`,
  `rust:native:package:android`, and `rust:native:package:java`.
- The packaging script writes fresh artifacts to `.context/native-packages` by
  default, using a BoltFFI overlay so verification does not mutate checked-in
  binding package outputs.
- Apple packaging now emits `Syncular.xcframework`, `Package.swift`, generated
  Swift wrappers, headers, `Syncular.xcframework.zip`, a SwiftPM checksum, and
  a standard SHA-256 digest. The generated local SwiftPM package parses and
  builds with `swift build --package-path .context/native-packages/apple`.
- Android packaging now regenerates Kotlin wrappers, C header, JNI glue, and
  both configured `arm64-v8a` and `x86_64` JNI libs. The script normalizes
  BoltFFI's `libsyncular-runtime.so` output to `libsyncular_runtime.so`, which
  is the library name the generated Kotlin wrapper loads on Android.
- Android Maven packaging now publishes the schema-agnostic low-level binding
  as `dev.syncular:syncular-android:<runtime-version>` into a local Maven
  repository under `.context/native-packages/android-maven/repository`.
  Publication includes the AAR, POM/module metadata, Gradle-generated checksums,
  and sources jar. Optional in-memory PGP signing is wired through
  `SYNCULAR_MAVEN_SIGNING_KEY` and `SYNCULAR_MAVEN_SIGNING_PASSWORD`.
- The Android packaging script now compiles a generated Gradle consumer smoke
  against the local Maven repository, proving the AAR resolves and exposes
  `SyncularBoltClientConfig` to a consuming Android project.
- JVM packaging now uses the same script and has a local `JAVA_HOME` fallback.
- The script now has an explicit Linux x86_64 JVM cross-packaging mode via
  `--java-linux-x86_64` or `SYNCULAR_JVM_HOST_TARGETS=current,linux-x86_64`.
  From macOS it uses `zig` as the linker and a generated temporary JNI include
  shim under `.context/native-packages`. The Zig wrapper normalizes
  `cc-rs` target arguments from `x86_64-unknown-linux-gnu` to Zig's
  `x86_64-linux-gnu` spelling.
- Windows JVM package verification is documented as Windows-host work because
  this BoltFFI release rejects Windows JVM cross-packaging from macOS.
- Added a dedicated Windows JVM packaging command:
  `rust:native:package:java:windows`, backed by
  `rust/scripts/package-native-bindings.sh --java-windows-x86_64`. The script
  now verifies the expected
  `java/native/windows-x86_64/syncular_runtime_jni.dll` artifact when that
  target is selected. This still needs to be executed on a Windows host/runner.
- Added `.github/workflows/checks.yml` job `rust-windows-jvm-package` on
  `windows-latest` to run the same packaging path and upload the
  `syncular_runtime_jni.dll` artifact. This still needs real GitHub runner
  execution to close the Windows packaging verification blocker.
- `rust/docs/reference/NATIVE_PACKAGING.md`, runtime README, and local project integration
  docs now describe the repeatable packaging command and real app-shell smokes.
- Rechecked Linux JVM packaging locally after WP-09: after seeding the Rust
  target download cache from a direct CDN download, `rustup target add
  x86_64-unknown-linux-gnu` succeeded, and
  `bun run rust:native:package:java:linux` produced
  `.context/native-packages/java/native/linux-x86_64/libsyncular_runtime_jni.so`.
- Local project integration docs now include current packaging outputs,
  generated-client/native lifecycle smoke commands, and native app lifecycle
  rules.
- Generated Swift/Kotlin query DSLs now support typed comparison operators,
  `isNotNull`, `isIn`/`notIn`, and grouped predicate `and`/`or`; the generated
  client smokes prove emitted SQL, params, and empty membership semantics.
- Generated Swift/Kotlin CRDT app helpers now decode native JSON into typed
  descriptors, write receipts, materializations, state vectors, and compaction
  receipts. The low-level `*Json` binding methods remain as explicit escape
  hatches, while app-level helpers no longer force raw JSON handling for normal
  CRDT flows.
- Generated Swift/Kotlin operation builders now preserve string primary keys as
  strings when building runtime row IDs, while non-string keys still convert to
  strings at the operation boundary. This removes redundant app-generated
  Kotlin `String.toString()` warnings.
- The checked-in Kotlin BoltFFI wrapper and native packaging script now
  normalize BoltFFI's redundant `1.toInt()` fallback output so local Kotlin
  smokes do not emit avoidable wrapper warnings.
- Revalidated local release packaging after the typed CRDT helpers landed:
  `bun run rust:native:package:apple` builds the Apple XCFramework, SwiftPM
  package, zip, checksum, and SHA-256 digest; `swift build --package-path
  .context/native-packages/apple` consumes the generated package; `bun run
  rust:native:package:android` builds Android arm64/x86_64 JNI libs, publishes
  the local AAR/Maven artifact, and compiles the generated Gradle consumer
  smoke; `bun run rust:native:package:java` and
  `bun run rust:native:package:java:linux` build current-host and Linux x86_64
  JVM packages.
- Added `rust:conformance:native` and `rust:conformance:all` script aliases so
  local conformance can include the Swift/Kotlin/JVM native smoke path when the
  required toolchains are available.
- `bun run rust:native-smoke` now also starts a local Hono sync server and runs
  Swift plus Kotlin/JVM native server-sync smokes with generated subscription
  helpers, stale-auth `AuthExpired` handling, hot auth refresh, seeded-row
  pull, generated mutation push over HTTP and WebSocket, keep-local conflict
  retry, keep-server/dismiss conflict resolution, and second-client pull. Its
  JVM host path now packages through `rust/scripts/package-native-bindings.sh`
  into `.context/native-smokes/native-packages`, so the smoke validates the
  same artifact shape without rewriting checked-in binding outputs.
- The native packaging script now sets a deterministic macOS deployment target
  default for Darwin packaging, eliminating the previous JNI linker warnings
  where Rust static libraries were built for a newer macOS version than the
  BoltFFI link step.
- Latest local verification: `bun run rust:conformance:native` passes with the
  packaged `.context` JVM artifacts, and `bun run rust:native:package:java`
  passes in release mode.
- Latest combined local conformance verification after adding the Windows JVM
  packaging command: `bun run rust:conformance:all` passes end to end.
- Latest native CI verification: `bun run rust:ci:native` passes, including
  `cargo fmt --check`, full Rust workspace tests, no-default runtime compile,
  and codegen output check.
- Latest JVM packaging regression check after adding the Windows target command:
  `bun run rust:native:package:java` still passes for the current macOS host
  and writes artifacts under `.context/native-packages`.
- Added `rust:native:release-check` as the local native release gate. It runs
  Apple packaging, Android AAR/local Maven packaging, current-host JVM
  packaging, Linux x86_64 JVM packaging, and the generated native smoke.
- Latest local native release verification: `bun run rust:native:release-check`
  passes end to end. The first run hit a transient Linux
  `cargo rustc --print=native-static-libs` failure, but the direct Linux
  target and the full aggregate rerun both passed.
- Added a separate docs section under `apps/docs/content/docs/rust-client` for
  the Rust-first client so browser/native/testkit/packaging docs do not get
  mixed into the older JavaScript-oriented client docs.
- Native packaging docs now call out FFI ABI version `2`, the generated-client
  runtime-manifest assertion, and the event-stream release contract
  (`startEventStream`, `nextEventJson`, `closeEventStream`).
- Latest WP-10 closeout verification after the ABI 2 event-stream cleanup:
  `bun run rust:native:release-check` passes end to end. It builds Apple,
  Android AAR/local Maven, current-host JVM, Linux x86_64 JVM, and generated
  Swift/Kotlin/JVM native smokes against the Hono sync server.

Done when:

- `[x]` A consuming app can follow docs to generate schema/client code and link
  local Rust/browser/native packages.
- `[x]` Release packaging has explicit repeatable commands and expected
  artifacts.
- `[x]` Host-only Windows packaging has a documented command and CI runner path.

Suggested verification:
Packaging scripts, local integration smoke, and docs review.

### WP-11 Optional Server And Adapters `[!]`

Scope: future-facing work that should not block the Rust client foundation.

- `[!]` Rust server push plugin if/when a Rust server exists.
- `[x]` Pure Rust server or edge proxy investigation for native/edge deployments.
- `[x]` Optional editor adapter packages above the generic CRDT field API.
- `[x]` Optional storage/package variants for deployments that do not need blobs,
  E2EE, CRDT, or realtime.

Progress:

- Hardened the app-layer Yjs document-field adapter package. It now prefers
  queued host writes when available, keeps failed local updates pending for
  retry instead of dropping editor state, exposes pending queue backpressure,
  and documents when apps should refresh materialized state versus applying raw
  remote Yjs updates.
- Added executable coverage for the CRDT adapter package:
  `bun run client-crdt-adapters:test`.
- Linked the adapter package from `rust/bindings/browser/README.md` so browser
  consumers can find the CRDT field guidance without treating it as core API.
- Added `rust/docs/reference/SERVER_EDGE_INVESTIGATION.md`. Current decision: do not start a
  Rust Cloudflare Worker server replacement now. A future Rust server should
  begin with a protocol-kernel crate or an edge proxy only when there is a
  concrete product target; Rust push plugins stay blocked until a Rust server
  trait model exists.
- Added root script `client-crdt-adapters:test` so the optional adapter example
  has a stable verification command.
- Wired `client-crdt-adapters:test` into `rust:ci:browser` so the example cannot
  rot separately from the browser package.
- Added `rust/docs/reference/FEATURE_VARIANTS_DECISION.md`. Current decision: keep one npm
  package, but publish full/core WASM artifacts inside that package and let
  generated apps choose by schema-derived runtime features.
- Landed the first concrete variant foundation step: `yrs` is optional behind
  `crdt-yjs`, and no-CRDT runtime builds keep the public JSON/API surface but
  fail CRDT/Yjs operations with a clear capability error.
- Landed the second concrete variant foundation step: field-level E2EE and
  encrypted CRDT crypto helpers are optional behind `e2ee`; no-E2EE builds keep
  the public JSON/API surface but fail E2EE operations with a clear capability
  error.
- Added internal browser variant measurement support:
  `build-syncular-wasm.ts --features ... --out-dir ...` and
  `size-syncular-wasm.ts --wasm ...`. Latest local optimized measurements:
  canonical full `2.92 MiB` raw / `1.20 MiB` gzip, internal core `2.19 MiB`
  raw / `925.6 KiB` gzip.
- Added runtime capability validation for the measured split. Rust rejects app
  schemas that require unavailable `blobs`, `crdt-yjs`, or `e2ee` features
  during open, and generated TypeScript clients assert schema-derived required
  features from `syncularGeneratedRequiredRuntimeFeatures`.
- Added explicit native app feature-profile coverage for
  `syncular-client = { default-features = false, features = ["native", "crdt-yjs"] }`.
  `syncular-testkit` is absent from that profile; client-only perf runner
  dependencies are gated by the CLI feature while native transport dependencies
  remain owned by `syncular-runtime`.
- Added generator-selected browser artifact loading. Generated TypeScript app
  clients pass `requiredRuntimeFeatures`; the browser package exposes
  `runtimeArtifacts` selection and forwards the chosen WASM glue/WASM URLs into
  the Worker and direct Rust client open path. Targeted browser tests now cover
  compatible artifact selection and missing-artifact rejection.
- Added repeatable internal core artifact commands:
  `build:wasm:core`, `build:wasm:variants`, `size:wasm:core`, and matching
  root aliases. The package `build` now writes the full artifact to
  `dist/wasm`, the no-CRDT/no-E2EE/no-blob core artifact to `dist/wasm-core`,
  and a top-level `dist/syncular-runtime-artifacts.json` catalog.
- Added first core-variant conformance coverage:
  `test:wasm:variants` builds `web-owned-sqlite-core`, opens a basic
  non-CRDT/non-E2EE app schema through the Worker, performs a local typed
  mutation/query, and proves a CRDT schema is rejected against the core
  artifact.
- Extended core-variant conformance through the real Hono sync routes. The same
  `test:wasm:variants` suite now provisions a basic non-CRDT/non-E2EE server
  table, pushes a typed local mutation from one core WASM client, and pulls the
  row into a second core WASM client.
- Split blob upload/cache helpers behind the `web-blobs` feature. The canonical
  full build keeps blobs; the internal core artifact omits them, generated
  TypeScript app clients require `blobs` when schema metadata has blob columns,
  and core-variant tests now prove blob schemas are rejected against the core
  artifact.
- Removed browser Rust WebSocket ownership as a browser package boundary. The
  browser package's app-facing realtime path is the TypeScript Worker
  controller, while Rust continues to own binary sync-pack decode/apply and
  native WebSocket transport.
- Added per-artifact manifests and catalog helpers. Each optimized artifact now
  writes `syncular-runtime-artifact.json` with runtime features, Rust
  features, files, profile, raw size, and gzip size. `catalog:wasm` combines
  those into the ordered runtime catalog, and the public browser API can
  resolve catalog-relative URLs for app serving.

Done when:

- A concrete product need exists and the work has a separate scoped plan.
- Optional adapters do not leak editor-specific behavior into Syncular core.

## Working Order

1. `WP-01 Browser SQL Safety`
2. `WP-02 Runtime Schema Purity`
3. `WP-03 Native Runtime Hardening`
4. `WP-04 CRDT Field Core`
5. `WP-05 CRDT Host APIs`
6. `WP-06 CRDT Conformance`
7. `P0 Rust Testkit And App Testing Harness`
8. `WP-07 Browser Size And Performance`
9. `WP-08 Shared Feature Conformance`
10. `WP-09 Real Native App Lifecycle`
11. `WP-10 Native Packaging And Release`
12. `WP-11 Optional Server And Adapters`

## Definition Of Ready For Rust Client Beta

- App-table writes cannot bypass Syncular mutations from public browser APIs.
- Runtime and bindings are schema-agnostic; app-generated output is app-local
  or fixture-only.
- Rust SDK uses Diesel ergonomically for reads and generated Syncular mutations
  for writes.
- Browser TypeScript uses Kysely for reads and generated mutation helpers for
  writes over one Rust-owned SQLite Worker.
- Native bindings expose generic low-level APIs plus generated typed app
  helpers for Swift/Kotlin/Java.
- Auth, sync, realtime, blobs, E2EE, conflicts, and CRDT have shared
  behavioral conformance coverage.
- Rust apps have a public testkit for generated-schema SQLite clients,
  in-process/faulted transports, assertions, and disposable resources.
- CRDT document fields expose safe generic field APIs and pass convergence,
  offline, compaction, encryption, and no-blanking tests.
- WASM package size has explicit budgets and documented feature-size tradeoffs.
- Local docs explain how to generate and use the Rust, browser, Swift, and
  Kotlin clients from an app schema.
