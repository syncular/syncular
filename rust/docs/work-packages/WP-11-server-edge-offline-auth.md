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
diagnostics, and the first current-auth Hono lease issue route. Leases remain
offline intent/audit records only; they do not bypass normal reconnect
authorization.

## Next Action

Next narrow slice is generated/local mutation lease policy plus full
per-operation lease scope/revocation validation. The Rust stores can now attach
the stored token once an outbox commit is marked with lease provenance, but
generated mutation APIs still need a strict leased-offline mode that selects an
active covering lease automatically. The server validator still needs to check
the signed lease scopes against each operation and revocation state instead of
only validating token issuer/audience/schema/actor/expiry before current
handler auth.

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
