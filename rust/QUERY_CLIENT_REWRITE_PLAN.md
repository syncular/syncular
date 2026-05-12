# Query Client Rewrite Plan

This plan tracks the move from table-specific native helpers toward a stable
Rust-owned SQLite runtime, generic platform clients, and app-owned generated
typed schema modules.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked
or needs a design decision.

## Principles

- Low-level bindings are stable and schema-agnostic.
- The framework ships clients and generators, not app-specific generated
  clients as framework packages.
- App-specific generated code belongs in the consuming app. In this repo it may
  exist only as test fixtures, examples, or generator snapshots.
- Reads may use SQL/query-builder output, but Rust must validate the request.
- Writes must go through Syncular mutations so local rows, outbox entries,
  conflict handling, and sync semantics cannot be bypassed.
- `syncular-client` is the canonical Rust SDK and uses Diesel canonically for
  Rust query building.
- Diesel is not the cross-platform foundation. The shared foundation is schema
  metadata plus a query/mutation contract, not one language's type system.
- Crate folder names omit the `syncular-` prefix because this repo already
  provides that context. Crate package names may still use `syncular-*`.

## Architecture Decisions

- Framework crates should be laid out as folder names `runtime`, `client`, and
  `codegen`, with package names `syncular-runtime`, `syncular-client`, and
  `syncular-codegen`.
- `runtime` is the schema-agnostic engine shared by browser/native bindings:
  SQLite, sync, outbox, conflicts, realtime, blobs, auth, `queryJson`, and
  `applyMutationJson`.
- `client` is the developer-facing Rust SDK. It depends on `runtime`, owns the
  Rust API, and uses Diesel canonically. Do not create a separate
  `syncular-diesel` package.
- `codegen` owns generator logic and target emitters for TypeScript, Rust,
  Swift, Kotlin, and other bindings.
- `bindings/*` are generic platform clients/runtime bindings. They are not
  nested under a generator/tool name such as `boltffi`; BoltFFI can remain an
  implementation detail of how native bindings are generated.
- Generated output belongs to apps and should plug into generic clients as:
  `generic platform client + generated schema descriptor = typed app client`.

## Target Shape

```text
runtime crate
  sync protocol
  schema metadata
  SQLite execution
  read-only query validation
  mutation/outbox/conflict path
  live-query invalidation
  blobs/auth/realtime

generic platform clients / bindings
  queryJson(read-only SQL + params + declared tables)
  applyMutationJson / applyLocalOperationJson
  registerQueryJson / unregisterQuery
  poll events
  sync/auth/blob APIs
  schema metadata JSON

codegen crate
  reads migrations + syncular config
  emits app-local generated schema modules
  emits per-platform type descriptors, query metadata, mutation builders,
  subscription descriptors, and codecs

app-owned generated modules
  TypeScript: Kysely DB type + schema descriptor + codecs/mutations
  Rust: Diesel schema/table descriptors + `SyncularSchema` impls in app crate
  Swift: row/input/patch/table descriptors + query-builder adapters
  Kotlin: row/input/patch/table descriptors + generated DSL/adapters

Rust SDK
  syncular-client package from crates/client
  Diesel-first developer-facing Rust API
```

## P0: Stable Low-Level Binding Contract

- `[x]` Add read-only `queryJson` to native Rust, C FFI, and BoltFFI.
- `[x]` Rename the write path conceptually from local operation to mutation in
  public docs while keeping compatibility aliases where needed.
- `[x]` Require generated schema modules to send declared table dependencies for
  queries.
- `[x]` Reject mutating SQL through the query path.
- `[x]` Validate query table access against generated app-table metadata.
- `[x]` Keep raw SQLite `INSERT`/`UPDATE`/`DELETE` unavailable through public
  low-level bindings.

## P0: Canonical Schema Metadata

- `[x]` Generate Rust app-table metadata from migrations/config.
- `[x]` Replace `appTableMetadataJson` as the schema seed with generated
  `syncular.schema.json`.
- `[x]` Define a versioned `syncular.schema.json` shape for client generators.
- `[x]` Include column SQL type, app type, nullability, primary key,
  server-version column, soft-delete column, blob columns, scopes, and
  subscriptions.
- `[x]` Add schema JSON drift tests independent of Swift/Kotlin/TS generated
  output snapshots.

## P1: Generator And Client Split

- `[x]` Stop treating generated Swift/Kotlin table helpers as low-level binding
  outputs.
- `[x]` Remove predefined Swift/Kotlin `list*()` read helpers; generated native
  reads now go through caller-supplied `queryJson` requests.
- `[x]` Stop treating generated app code as framework packages; keep it only as
  app-local output, examples, fixtures, or generator snapshots
  (root workspaces include the generic Rust browser binding package, but not
  the generated todo app fixture).
- `[x]` Remove table-specific native examples from low-level docs/tests
  (remaining `tasks` references are app-fixture schema data or demo CLI flows;
  generic native bindings are golden-tested to contain no task-specific API).
- `[x]` Generate app-local schema modules from canonical schema JSON rather
  than binding scaffolds.
- `[x]` Compile app-owned generated Rust modules against the Rust SDK and
  generated Diesel schema in the example app.
- `[x]` Generate app-local Rust migrations and prove the generated app schema
  can drive the generic SDK store through `SyncularClient::open_with_schema`.
- `[x]` Add golden tests proving generated schema modules plug into generic
  clients and call only low-level `queryJson`, `applyMutationJson`,
  subscription, and sync/blob methods.

## P1: Platform Query Builders

- `[x]` TypeScript uses Kysely over the Rust-owned SQLite dialect.
- `[x]` Swift builder choice: generate a small driverless typed SQL DSL that
  feeds `queryJson`; third-party builders can still be evaluated later without
  changing the low-level ABI.
- `[x]` Kotlin builder choice: generate the same small DSL shape before
  adopting any third-party dependency.
- `[x]` Rust builder choice: Diesel is canonical in `syncular-client`; no
  separate `syncular-diesel` package.
- `[x]` Rust reads keep full Diesel query-builder semantics through
  `client.read(query)`, so app code never passes the SQLite connection around.
- `[x]` Rust generated mutation APIs mirror the pre-Rust JS outbox shape
  without becoming an ORM: generated table namespaces expose
  `insert`, `insert_many`, `update`, `delete`, and `commit` over typed mutation
  DTOs, with automatic base-version reads and batched outbox commits.
- `[x]` Define conformance tests shared by TS, Swift, Kotlin, and Rust
  generators, including local behavioral smokes for generated TS, Swift, and
  Kotlin task query/mutation/live-query flows.

## P2: Live Query Semantics

- `[x]` Browser Worker tracks live query subscriptions and table dependencies.
- `[x]` Native low-level binding can register table-dependent query observers.
- `[x]` Generated schema modules register query dependencies next to query
  execution through generic `registerQueryJson`/`unregisterQuery` calls.
- `[x]` Native app helpers can rerun affected live queries through `queryJson`
  after `QueriesChanged` events.
- `[x]` Rust SDK has a typed Diesel live-query handle. App code supplies table
  dependencies and a normal Diesel query builder closure; the handle refreshes
  through `client.read(query)` only when a sync report touches those tables.
- `[x]` Add duplicate, unsubscribe, auth-change, and sync-pull ordering tests
  for native generated schema modules plugged into generic clients
  (duplicate replacement, idempotent unsubscribe, and sync-pull ordering are
  covered at the runtime observer layer; dynamic auth headers are verified
  against a server-backed native sync request; Swift and Kotlin BoltFFI host
  smokes cover app-level event polling, unregister, and live-query refresh).

## P2: Package Layout

- `[x]` Rust rewrite lives under `rust/`.
- `[x]` Browser Rust package lives under `rust/bindings/browser`.
- `[x]` Restructure crates to `rust/crates/runtime`, `rust/crates/client`, and
  `rust/crates/codegen` while keeping crate package names
  `syncular-runtime`, `syncular-client`, and `syncular-codegen`.
- `[x]` Move generic platform bindings directly under `rust/bindings/browser`,
  `rust/bindings/swift`, `rust/bindings/kotlin`, `rust/bindings/java`, and
  `rust/bindings/c`; do not wrap them in `rust/bindings/boltffi`.
- `[x]` Keep app-specific generated output out of framework package layout,
  except for explicit examples, fixtures, and generator snapshots.
- `[x]` Ensure binary package artifacts are generated by packaging jobs, not
  committed ad hoc.

## Work Log

- 2026-05-09: Created this plan. Started P0 low-level `queryJson` work so
  native app-owned generated schema modules can execute read-only query-builder
  output without table-specific FFI methods.
- 2026-05-09: Wired `queryJson` through Rust native, C FFI, BoltFFI, and
  generated Swift/Kotlin app scaffolds. The read path validates declared
  generated app-table dependencies, rejects mutating SQL, and removed
  predefined generated native `list*()` helpers.
- 2026-05-09: Added `applyMutationJson` aliases across native, C FFI, BoltFFI,
  and generated Swift/Kotlin scaffolds. `applyLocalOperationJson` remains for
  compatibility, but new generated app schema modules use mutation
  terminology.
- 2026-05-09: Clarified architecture: the framework ships generic clients plus
  generators, not generated app-client packages. `client` is the canonical
  Diesel-first Rust SDK, `runtime` is the shared engine for all bindings, and
  `codegen` owns generators. Folder names omit the `syncular-` prefix while
  crate package names keep it.
- 2026-05-09: Moved the generator into `rust/crates/codegen`, moved generic
  native binding output directly under `rust/bindings/swift`, `kotlin`, `java`,
  and `c`, split the shared engine/binding crate into `rust/crates/runtime`,
  kept `rust/crates/client` as the Diesel-first Rust SDK package, and made
  `rust/examples/todo-app/generated` the app-owned generated output fixture for
  TS, Rust, Swift, and Kotlin.
- 2026-05-09: Added generated `syncular.schema.json` as contract version 1 for
  app metadata across platforms, with schema JSON drift/contract tests separate
  from language-specific generated output snapshots.
- 2026-05-09: Routed Rust, TypeScript/Kysely, Swift, Kotlin, and Android Kotlin
  generation through the parsed `syncular.schema.json` contract before
  emitting target code, so migrations/config now feed the contract and targets
  consume the contract.
- 2026-05-09: Tightened native binding goldens so the generic BoltFFI
  Swift/Kotlin/Java bindings stay app-agnostic and generated app Swift/Kotlin
  helpers are proven to route typed writes through `applyMutationJson` and typed
  reads through `queryJson`.
- 2026-05-09: Added generated Swift/Kotlin live-query helpers over the generic
  native JSON ABI. App-generated modules now emit `SyncularLiveQueryRegistration`
  and `SyncularNativeLiveQuery` wrappers that register table dependencies,
  decode native event JSON, refresh affected queries through `queryJson`, and
  unregister through `unregisterQuery` without adding table-specific low-level
  binding methods.
- 2026-05-09: Added the ergonomic Rust SDK surface. Generated Diesel row
  structs are public for typed `client.read(query)` calls, and generated Rust
  mutation namespaces provide JS-like outbox-safe `insert`, `insert_many`,
  `update`, `delete`, and `commit` APIs over typed DTOs.
- 2026-05-09: Added Rust SDK conflict helpers and typed Diesel live queries.
  `client.conflicts()` now wraps pending checks, keep-local retries, server-win
  resolution, and dismissal. `client.live_query(["table"], || query)` owns the
  current rows and refreshes from table-level `SyncReport` invalidation.
- 2026-05-10: Added generated Swift/Kotlin query-builder DSLs that expose typed
  table namespaces, typed columns, `filter`, `orderBy`, `limit`, `fetch`, and
  `liveQuery` over the generic `queryJson`/observer ABI. Added cross-platform
  conformance tests for the shared Rust/TS/Swift/Kotlin schema contract, removed
  the generated todo app from root workspaces, and added CI jobs for Rust
  native, browser/WASM package checks, generated-output drift, Linux/Windows
  native artifacts, and BoltFFI Apple/Android/JVM package smokes.
- 2026-05-10: Added local generated-client behavioral smokes. Swift and Kotlin
  now compile and run the generated todo app clients against mock generic native
  clients, and TypeScript has a generated-app conformance test for operation,
  subscription, and Kysely query semantics.
- 2026-05-10: Added real BoltFFI host-language smokes for generated native app
  clients. Swift now links the generated BoltFFI Swift wrapper against the Rust
  runtime dylib; Kotlin compiles the generated app client with the generated
  Kotlin/JNI binding and packaged JVM native library. Both run manifest,
  auth-header, worker lifecycle, mutation, query, observer, event polling, and
  live-query refresh flows against a real SQLite database.
