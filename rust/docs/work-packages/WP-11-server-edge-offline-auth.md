# WP-11 Server Edge And Offline Auth

Status: `[~]` in progress

## Goal

Keep server/edge work sequenced behind the Rust client foundation while
designing offline auth leases honestly.

## Scope

- Rust edge proxy investigation.
- Pure Rust server only if protocol/client foundation proves it is worth it.
- Offline auth lease model.
- Revocation/expiry/refresh semantics.
- Server protocol support for verified deltas, resumable manifests, and
  subscription indexes.

## Acceptance Criteria

- No CF Worker Rust rewrite starts before the protocol kernel is stable.
- Offline auth leases do not imply unsafe authorization guarantees.
- Server protocol changes are benchmarked against Rust client behavior.

## Required Gates

- Server tests for changed protocol behavior.
- Protocol fixture tests.
- Perf gates for server hot paths.

## Accept / Reject Rule

- Retain server/edge changes only when they support the Rust-client protocol
  foundation or clearly improve measured hot paths.
- Reject a Rust/CF Worker server rewrite until the protocol kernel and client
  performance foundation are stable.
- Reject offline-auth designs that imply authorization after server-side
  revocation without an explicit lease model and user-visible limits.

## Current Evidence

The current decision is to defer a pure Rust server. Offline auth must not
weaken strict online `/sync` authorization. The legacy JS offline-auth package
is a local UX/session-cache primitive, not a signed server authorization model.
The Rust foundation now covers protocol/testkit lease types, local client
storage, replay provenance, server handler context, stable rejection
diagnostics, current-auth Hono lease issue, signed replay-token validation,
per-operation signed-scope/current-scope validation, strict Rust generated
leased mutations, native binding leased mutations, and browser generated/Kysely
leased mutations. Native JSON, C FFI, BoltFFI, Swift, Kotlin, Java, browser
worker, and browser Rust-owned SQLite now have strict leased mutation entry
points. Browser and Rust/native hosts now have first-class auth lease issue
APIs that post through the normal auth transport, validate/store the returned
signed lease, and feed generated leased mutations. Leases remain offline
intent/audit records only; they do not bypass normal reconnect authorization.
Local leased mutations now also classify a stored covering-but-expired lease as
`sync.auth_lease_expired` before materializing the row or outbox write, while
`activeAuthLeases(...)` continues to expose only time-valid leases.

## Next Action

Next narrow slice is server/proxy sequencing and any remaining app-shell UX
validation around lease revocation. Do not add manual outbox lease marking to
app-facing APIs; generated leased mutations must keep selecting stored lease
provenance transactionally.

## Progress

- Added [`../reference/OFFLINE_AUTH_LEASE_MODEL.md`](../reference/OFFLINE_AUTH_LEASE_MODEL.md)
  as the explicit lease contract before implementation. The model keeps the
  server authoritative, uses signed bounded leases only for offline intent
  capture, records lease provenance on queued commits, and requires normal
  request auth plus current handler authorization at replay.
- The model defines v1 token shape, recommended `ES256` signature header,
  lease payload fields, client storage/outbox provenance, server replay order,
  stable `sync.auth_lease_*` error codes, diagnostics, and testkit/conformance
  requirements.
- Added Rust protocol structs/constants for the v1 offline-auth lease contract:
  protected header, payload, scopes, capabilities, validation result, outbox
  provenance, and stable `sync.auth_lease_*` codes.
- Added `syncular-testkit` deterministic ES256 lease helpers:
  `TestAuthLeaseKeyPair`, `issue_test_auth_lease`, and
  `verify_test_auth_lease`.
- Added smoke coverage for valid, expired, and tampered test auth lease tokens.
- Added runtime schema v8 with `sync_auth_leases` and nullable auth-lease
  provenance columns on `sync_outbox_commits`.
- Added shared `AuthLeaseRecord` storage APIs and optional
  `AuthLeaseProvenance` on outbox commits/summaries.
- Implemented lease storage/provenance read paths in the native Diesel store,
  browser owned SQLite store, browser memory store, native facade, C FFI, and
  BoltFFI wrapper.
- Added native store coverage for lease roundtrip, active-lease filtering, and
  outbox provenance on summaries plus pending push rows.
- Added optional `authLease` provenance to HTTP and websocket push requests in
  the Rust protocol/runtime/browser paths. Replay still uses normal request
  auth; the lease is audit/recovery context only.
- Added server-side `authLease` propagation into push handler context and
  commit metadata, including Hono HTTP batch/single pushes, websocket pushes,
  and request payload snapshots.
- Added stable core taxonomy entries for `sync.auth_lease_*` rejection modes and
  regenerated the Rust error taxonomy fixture.
- Added server coverage proving an expired lease returned from handler
  authorization is surfaced as `sync.auth_lease_expired`, does not materialize
  the row, and persists lease provenance in `sync_commits.meta`.
- Added Rust runtime coverage proving Diesel-backed queued commits send
  provenance on sync, preserve rejected lease diagnostics as local conflicts,
  and keep the failed outbox row with provenance for recovery.
- Fixed the testkit websocket app-server push parser so production realtime
  push messages can carry `authLease` into stateful test servers.
- Added shared TS/core schemas and constants for auth lease protected headers,
  payloads, capabilities, issue requests, and issue responses.
- Added framework-agnostic TS server helpers for issuing signed auth lease
  tokens, WebCrypto ES256 signing, token verification, and scope coverage
  checks.
- Added `POST /auth-leases/issue` to Hono sync routes behind normal
  `authenticate()`. The route resolves requested scopes through the existing
  Syncular table-handler scope logic, returns only effective scopes, rejects
  unauthenticated requests with `sync.auth_required`, and rejects fully
  disallowed scope requests with `sync.auth_lease_scope_mismatch`.
- Added Hono route coverage for successful signed lease issue/verification,
  auth-required failure, disallowed-scope failure, malformed scope requests,
  and expiry diagnostics.
- Added `leaseToken` to the TS push `authLease` contract so replay can carry
  the signed lease alongside bounded provenance.
- Added a generic server push commit validator hook that runs after idempotent
  commit insertion but before operation application, so commit-level auth
  rejections persist normal `sync_commits` audit/result metadata.
- Wired Hono auth lease config into push replay validation. Leased commits now
  require a token when auth leases are configured, and the server verifies
  signature, issuer, audience, schema version, actor id, lease id, and expiry
  before applying operations. Normal unleased commits still use normal request
  auth and handler authorization.
- Added Hono coverage proving an expired signed lease rejects the pushed commit
  with `sync.auth_lease_expired` and leaves the app row unapplied.
- Added `leaseToken` to Rust `AuthLeaseProvenance` and runtime
  `sync_outbox_commits` storage so Rust/native/browser replay can carry the
  signed lease token on HTTP and websocket pushes.
- Updated native Diesel, browser Rust-owned SQLite, browser memory store, and
  the demo rusqlite fixture to persist/read outbox lease tokens. When
  `set_outbox_auth_lease` receives provenance without a token, supported stores
  fill it from the stored `sync_auth_leases` record.
- Added Rust storage/protocol coverage proving outbox summaries and pending
  push rows include the filled token and auth lease replay JSON includes
  `leaseToken`.
- Added reusable server-side auth lease operation validation that derives row
  scopes through the table handler, checks the signed lease covers each
  operation/table/scope, and re-resolves current handler scopes to reject
  revoked access before writes.
- Added Hono replay coverage for signed-scope mismatch and current-scope
  revocation. Both reject the commit with stable `sync.auth_lease_*` codes and
  leave app rows unapplied.
- Added Rust `SyncularLeasedMutationExecutor` plus generated
  `leased_mutations()` and `commit_leased()` APIs. Native Diesel selects an
  active stored lease covering the generated mutation batch, tags the outbox
  commit with signed provenance, and rolls back the local row/outbox write if no
  covering lease exists.
- Updated generated Rust fixture/example outputs and documented the Rust
  leased mutation API in
  [`../reference/GENERATED_CLIENT_API.md`](../reference/GENERATED_CLIENT_API.md).
- Added schema-agnostic `apply_leased_mutation_json` and
  `enqueue_leased_mutation_json` to the native runtime, worker, C FFI, and
  BoltFFI bindings. These methods select and attach active auth lease
  provenance in the same SQLite transaction as the local row/outbox write, and
  fail closed when no covering lease exists.
- Regenerated Swift, Kotlin, Android Kotlin, Java, and BoltFFI outputs with
  leased mutation methods plus generated `leasedMutations` and
  `queuedLeasedMutations` app helpers. Native smoke adapters now compile
  against the stricter low-level protocol.
- Added shared Rust active-auth-lease selection logic so native Diesel,
  browser memory, and browser Rust-owned SQLite use the same scope matching and
  stable `sync.auth_lease_*` failure semantics.
- Added browser client auth lease management APIs:
  `upsertAuthLease`, `authLease`, and `activeAuthLeases`.
- Added browser strict leased mutation APIs through the worker protocol,
  Rust-owned SQLite WASM exports, high-level `SyncularV2Client`, and generated
  Kysely database surface. App code can now use
  `database.leasedMutations.tasks.insert(...)` and
  `database.leasedMutations.$commit(...)`; the runtime transactionally selects
  a covering active lease and rolls back local row/outbox writes when none
  exists.
- Added browser core-WASM coverage proving generated leased mutations fail
  closed without a covering lease, do not materialize the row on failure, and
  succeed after storing a covering active lease.
- Added local expiry UX coverage for Rust Diesel and browser Rust-owned SQLite:
  a stored covering lease that is no longer time-valid produces
  `sync.auth_lease_expired`, leaves app rows/outbox untouched, and
  `activeAuthLeases(...)` remains filtered to currently usable leases.
- Fixed the browser TypeScript wrapper for `activeAuthLeases(...)` to pass
  wasm `i64` timestamps as `bigint`, matching the generated wasm-bindgen
  binding instead of relying on mocked worker coverage.
- Added browser host-facing `client.issueAuthLease(...)`. It posts to the Hono
  `/auth-leases/issue` route, uses the existing auth refresh lifecycle on
  `401`/`403`, stores the returned signed lease, and returns the stored
  `SyncularV2AuthLeaseRecord`.
- Added browser/Hono app-style coverage proving stale auth refreshes during
  auth lease issue, the refreshed lease is stored, a generated leased mutation
  can use it locally, and server replay accepts the signed lease on push.
- Added Rust protocol issue request/response structs and an `AUTH_LEASE_PROTOCOL_VERSION`
  constant matching the TypeScript core schema.
- Added native HTTP auth lease issue through `HttpSyncTransport`, using the same
  dynamic auth headers/signing path as `/sync` and posting to
  `/auth-leases/issue`.
- Added `SyncularClient::issue_auth_lease(...)` /
  `issue_auth_lease_json(...)`, converting a valid issue response into a stored
  active `AuthLeaseRecord` before returning it to host code.
- Added native facade, C FFI, BoltFFI, Java, Swift, and Kotlin issue methods.
  Generated Swift/Kotlin clients now include typed `SyncularAuthLeaseIssueRequest`,
  `SyncularAuthLeaseScope`, `SyncularAuthLeaseRecord`, and `issueAuthLease(...)`
  helpers.
- Documented Rust, Swift, and Kotlin lease issue usage plus expiry/revocation
  recovery guidance in
  [`../reference/GENERATED_CLIENT_API.md`](../reference/GENERATED_CLIENT_API.md).
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol -p
  syncular-testkit` passed with `15` protocol tests and `36` testkit smoke
  tests.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  protocol_contract` passed with `42` tests after replay provenance.
- Gate: `bun test packages/core/src/__tests__/error-responses.test.ts` passed
  after adding auth-lease taxonomy entries.
- Gate: `bun test packages/server/src/push-operation-codes.test.ts` passed with
  the auth-lease rejection/metadata coverage.
- Gate: `bun run --cwd packages/core tsgo`, `bun run --cwd packages/server
  tsgo`, and `bun run --cwd packages/server-hono tsgo` passed after the wire
  contract slice.
- Gate: `bun test packages/server-hono/src/__tests__/auth-leases.test.ts`
  passed after the issue-route slice.
- Gate: `bunx biome check packages/core/src/schemas/sync.ts
  packages/server/src/auth-leases.ts packages/server-hono/src/routes.ts
  packages/server-hono/src/__tests__/auth-leases.test.ts` passed after the
  issue-route slice.
- Gate: `bun run --cwd packages/core tsgo`, `bun run --cwd packages/server
  tsgo`, and `bun run --cwd packages/server-hono tsgo` passed after the replay
  token validation slice.
- Gate: `bun test packages/server-hono/src/__tests__/auth-leases.test.ts`
  passed with `5` tests after the replay token validation slice.
- Gate: `bun test packages/server/src/push-operation-codes.test.ts` passed
  after adding the generic push commit validator hook.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
  passed after adding `leaseToken` to Rust wire provenance.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  store_backends` passed with `36` tests after Rust token persistence.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  protocol_contract` passed with `42` tests after Rust token replay.
- Gate: `bun run build:wasm:dev` passed in `rust/bindings/browser` after
  browser Rust-owned SQLite token persistence.
- Gate: `bun run --cwd packages/server tsgo` and `bun run --cwd
  packages/server-hono tsgo` passed after per-operation lease scope/revocation
  validation.
- Gate: `bun test packages/server-hono/src/__tests__/auth-leases.test.ts`
  passed with `7` tests after per-operation lease scope/revocation validation.
- Gate: `bun test packages/server/src/push-operation-codes.test.ts` passed
  after per-operation lease scope/revocation validation.
- Gate: `bunx biome check packages/server/src/auth-leases.ts
  packages/server-hono/src/routes.ts
  packages/server-hono/src/__tests__/auth-leases.test.ts` passed after
  per-operation lease scope/revocation validation.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  store_backends` passed with `38` tests after Rust generated leased mutation
  selection and fail-closed rollback coverage.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  protocol_contract` passed with `42` tests after Rust generated leased
  mutations.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
  passed after regenerating Rust fixture/example outputs for
  `leased_mutations()` / `commit_leased()`.
- Gate: `bun run rust:check:no-default` passed after adding the public leased
  mutation executor trait.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
  passed after adding Swift/Kotlin leased mutation generation assertions.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime
  --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test
  store_backends` passed with `40` tests after adding leased JSON and worker
  leased mutation coverage.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime
  --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test
  protocol_contract` passed with `42` tests after the native leased JSON slice.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime
  --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test
  native_facade --test native_ffi --test native_binding_scaffold` passed after
  regenerating low-level native bindings.
- Gate: `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime
  --no-default-features --features native,crdt-yjs,boltffi-bindings` passed for
  the Notsuru-style native feature profile.
- Gate: `bun run rust:check:no-default` passed after the native leased JSON
  slice.
- Gate: `bash rust/examples/todo-app/native-smokes/run-local.sh` passed,
  compiling and running Swift generated, Swift Bolt host, Swift lifecycle,
  Kotlin generated, Kotlin Bolt host, Kotlin lifecycle, and Swift/Kotlin Hono
  server-sync smokes against the new leased binding contract.
- Gate: `cargo fmt` passed after browser leased mutation parity.
- Gate: `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime
  --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings` passed
  after sharing lease selection.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
  passed after adding generated browser `leasedMutations` to the TypeScript
  app database contract.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime
  --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test
  store_backends --test protocol_contract` passed after the shared-selection
  refactor.
- Gate: `bun run --cwd rust/bindings/browser tsgo` passed after browser
  strict leased mutations.
- Gate: `bun test rust/bindings/browser/src/database.test.ts
  rust/bindings/browser/src/generated-app-conformance.test.ts
  rust/bindings/browser/src/worker-client.test.ts` passed after browser
  worker/auth-lease API coverage.
- Gate: `bun run --cwd rust/bindings/browser build:wasm:dev` and
  `bun run --cwd rust/bindings/browser build:wasm:core` passed after adding the
  leased WASM exports.
- Gate: `bun test rust/bindings/browser/src/__tests__/variant-core.wasm.test.ts`
  passed after core-WASM leased mutation fail-closed coverage.
- Gate: `bun run --cwd packages/core tsgo` and `bun run --cwd
  rust/bindings/browser tsgo` passed after adding browser auth lease issue.
- Gate: `bun test rust/bindings/browser/src/worker-client.test.ts` passed with
  auth lease issue/storage worker coverage.
- Gate: `bun test rust/bindings/browser/src/__tests__/auth-hono.wasm.test.ts`
  passed with the real Hono auth lease issue + leased mutation push flow.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
  passed after adding generated Swift/Kotlin auth lease issue helpers.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
  passed after adding Rust auth lease issue protocol structs.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime
  --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test
  native_facade --test native_ffi --test native_binding_scaffold` passed after
  native/Rust auth lease issue implementation and binding regeneration.
- Gate: `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime
  --no-default-features --features native,crdt-yjs,boltffi-bindings` passed for
  the Notsuru-style native feature profile.
- Gate: `bash rust/examples/todo-app/native-smokes/run-local.sh` passed after
  regenerating the Swift/Kotlin/Java BoltFFI and generated app surfaces.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  store_backends` passed with `36` tests after the local lease storage slice.
- Gate: `bun run rust:conformance:fast` passed after the protocol/testkit
  lease slice. Final reruns after the storage API slice hit unrelated
  timing-sensitive native HTTP/event smokes; the exact failed smokes passed when
  rerun directly, and the constituent runtime, todo-example, and browser
  generated-app gates passed.
- Gate: `bun run rust:check:no-default` passed without warnings after cleaning
  an existing CRDT-only cfg import.
- Gate: `bun run rust:check:client-native-crdt` passed.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  protocol_contract --test blob_transport --test crdt_field` passed after the
  local storage API slice.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p
  syncular-todo-app-example` passed after the local storage API slice.
- Gate: `bun test rust/bindings/browser/src/generated-app-conformance.test.ts`
  passed after the local storage API slice.
- Gate: `bun run build:wasm:dev` passed in `rust/bindings/browser` after adding
  browser owned SQLite lease APIs.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test
  store_backends` passed with `41` tests after local expired-lease
  classification.
- Gate: `bun run --cwd rust/bindings/browser build:wasm:core`,
  `bun run --cwd rust/bindings/browser tsgo`, and
  `bun test rust/bindings/browser/src/__tests__/variant-core.wasm.test.ts`
  passed after browser active-lease timestamp and expired-lease coverage.
- Gate: `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime
  --no-default-features --features native,crdt-yjs` and `cargo test
  --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract
  --features native,crdt-yjs,demo-todo-native-fixture` passed after the shared
  selector change.
