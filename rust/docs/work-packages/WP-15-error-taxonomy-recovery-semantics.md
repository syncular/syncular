# WP-15 Error Taxonomy And Recovery Semantics

Status: `[~]` in progress

## Goal

Standardize public Syncular errors across browser, native, server, transports,
and generated clients so apps know what happened and what recovery action is
valid.

## Scope

- Stable public error codes.
- Error classification: retryable, fatal, auth-required, schema-mismatch,
  integrity-rejected, conflict, scope-revoked, offline, transport, and storage.
- User-facing recovery hints for generated clients and diagnostics.
- Browser/native/server parity for error envelopes.
- Tests asserting exact codes for important recovery and failure paths.
- Integration with WP-13 diagnostic events and WP-14 generated APIs.

## Non-Scope

- Turning errors into silent fallback behavior.
- Reintroducing old client/protocol compatibility paths.
- Allowing apps to bypass verification, mutation/outbox, or server authority
  when an error occurs.

## Acceptance Criteria

- Public errors carry stable `code`, `category`, `retryable`, and
  `recommendedAction` fields where applicable.
- Auth, schema mismatch, integrity rejection, scope revocation, conflict,
  websocket recovery, artifact corruption, and storage fallback cases have
  explicit codes.
- Generated clients expose typed errors without losing the underlying diagnostic
  metadata.
- Tests assert exact codes for representative browser, native, server, and
  transport failures.
- Console and client diagnostic snapshots can group failures by stable code.

## Required Gates

- Core error-schema tests.
- Browser worker error tests.
- Server route tests for push, pull, artifact, blob, auth, and console errors
  where touched.
- Runtime/native tests for Rust error envelope changes.
- Generated client smokes where public bindings change.

## Accept / Reject Rule

- Retain only errors that make recovery explicit and preserve fail-closed sync
  behavior.
- Reject generic string-only public errors on new surfaces.
- Reject retry hints that would cause apps to advance cursors, trust
  unverified data, or ignore authorization failures.

## Current Evidence

The repo already has structured diagnostics, request events, transport stats,
conflict state, and server outcome fields. Those pieces need a stable public
error taxonomy so app code and console investigation do not parse message text.

## Next Action

Audit any remaining package-specific error surfaces that still expose raw
strings or route-local codes, then either migrate them into the stable taxonomy
or record a deliberate exception in the compatibility register.

## Progress

- Browser worker error payloads now support stable public error `code`,
  `category`, `retryable`, and `recommendedAction` fields.
- `SyncularV2WorkerError` exposes those fields directly for app code.
- Runtime errors surfaced through the browser worker now classify representative
  recovery-critical failures:
  `sync.auth_required`, `sync.schema_mismatch`, and
  `sync.integrity_rejected`.
- Worker diagnostics now use the stable classified code when available and copy
  the error envelope fields into diagnostic details, so app tooling does not
  parse message text.
- Browser/Hono WASM tests assert exact error envelopes for auth-required,
  server-required schema mismatch, and corrupted snapshot chunk integrity
  rejection.
- The browser package now has a shared `SyncularV2ClientError` classifier used
  by both the worker bridge and the direct Rust client sync path, so apps get
  the same stable envelope without being forced through the worker.
- `@syncular/core` now owns the public error response taxonomy and JSON schema
  extensions for `code`, `category`, `retryable`, `recommendedAction`, and
  structured `details`.
- Hono sync, snapshot chunk/artifact, realtime connection-limit, rate-limit,
  API-key auth, and blob HTTP failures now return stable error envelopes
  instead of string-only public error bodies.
- Browser error classification now recognizes server error envelopes embedded
  in Rust transport failures, so server-side `sync.forbidden`,
  `sync.rate_limited`, blob errors, and future codes do not depend on parsing
  message text.
- Rust runtime errors now have a shared classifier that maps server envelopes,
  bare HTTP 401/403 failures, schema mismatch, integrity rejection, generic
  transport failures, local storage failures, config failures, and internal
  runtime failures into stable `code`, `category`, `retryable`, and
  `recommendedAction` fields.
- Native `NativeErrorInfo` and error diagnostics now expose the same stable
  classification fields. HTTP 403 is now `sync.forbidden`; only
  `sync.auth_required` / HTTP 401 becomes an `AuthExpired` event.
- The shared TS public taxonomy now includes runtime transport/storage/internal
  classifications so browser and native can use the same public code space.
- Generated Swift and Kotlin native app clients now expose
  `SyncularNativeErrorInfo` as `event.error`; the Java event parser exposes the
  same `ErrorInfo` shape. Swift/Kotlin generated-client smokes decode
  `sync.forbidden` from native event JSON instead of inspecting raw JSON.
- Console gateway routes now use stable `console.*` error envelopes for auth,
  forbidden websocket origins, invalid target selection, not found resources,
  downstream unavailability, and invalid downstream responses. Downstream
  failure metadata now lives under structured `details`.
- Hono request validation now goes through Syncular-owned validators so sync,
  blob, and console validation failures return stable `sync.invalid_request`,
  `blob.invalid_request`, or `console.invalid_request` envelopes before route
  handlers run.
- Relay server-role `/pull` and `/push` routes now return stable sync error
  envelopes for unauthenticated requests, malformed requests, and push
  operation-limit rejection instead of uppercase string-only errors.
- Server-Hono proxy websocket pre-upgrade failures now use stable `proxy.*`
  envelopes for forbidden origins, missing auth, and connection-limit
  rejection.
- Direct Server-Hono console routes now use shared error-envelope schema and
  stable `console.*` / `blob.*` codes for schema-unavailable, auth, not-found,
  invalid request, and storage-not-configured failures.
- Cloudflare scope-cache Durable Object and server-service-worker default
  handler failures now return stable envelope JSON instead of plaintext
  adapter errors. The shared core error helper now typechecks under the
  Cloudflare Worker type profile.
- Public per-operation push result codes now use the stable Syncular taxonomy
  instead of legacy uppercase strings. Server handlers, encrypted CRDT
  operations, testkit fixtures, Rust app-server fixtures, browser worker tests,
  demo handlers, docs, generated protocol fixtures, and todo conformance
  scenarios now agree on `sync.version_conflict`, `sync.unknown_table`,
  `sync.row_missing`, `sync.empty_commit`, `sync.unsupported_operation`,
  `sync.missing_scopes`, `sync.idempotency_cache_miss`, and
  `sync.constraint_violation`.
- Browser worker public error payloads now use namespaced taxonomy codes
  (`worker.closed`, `worker.not_open`, `worker.protocol_mismatch`,
  `worker.request_timeout`, `worker.failed`, and
  `worker.message_unreadable`) instead of underscore/local codes. The shared
  core taxonomy owns those definitions, worker payload creation fills
  category/retry/recovery metadata, and the Rust runtime classifier recognizes
  the expanded shared code set when it sees server-style envelopes.
- The shared TS error taxonomy now has a generated
  `error-taxonomy-v1.json` fixture consumed by Rust runtime tests. Core tests
  fail if the checked-in fixture drifts from `SYNCULAR_ERROR_DEFINITIONS`, and
  Rust tests fail if its classifier stops matching any shared code.
- Blob upload completion now carries stable manager-level error codes instead
  of requiring Hono routes to compare message strings. Completion failures map
  through `blob.invalid_request`, `blob.not_found`, `blob.forbidden`, or
  `blob.size_mismatch`; the route preserves `blob.forbidden` as a 403.
- Scope revocation and offline transport failures now have first-class
  taxonomy entries: `sync.scope_revoked` uses the `scope-revoked` category and
  `sync.offline` uses the `offline` category. Rust and browser classifiers
  recognize offline transport failures, and browser worker/direct sync paths
  emit a `sync.scope_revoked` diagnostic with revoked subscription ids when a
  pull clears a revoked subscription.

## Latest Evidence

- `bun run --cwd packages/core tsgo`
- `bun run --cwd packages/server-cloudflare tsgo`
- `bun run --cwd packages/server-service-worker tsgo`
- `bun test packages/server-cloudflare/src/scope-cache.test.ts packages/server-service-worker/src/index.test.ts packages/core/src/__tests__/error-responses.test.ts`
- `bun run --cwd packages/core tsgo`
- `bun run --cwd packages/server-hono tsgo`
- `bun test packages/core/src/__tests__/error-responses.test.ts packages/server-hono/src/__tests__/console-routes.test.ts packages/server-hono/src/__tests__/create-server.test.ts`
- `bun run --cwd packages/core tsgo`
- `bun run --cwd packages/server-hono tsgo`
- `bun test packages/core/src/__tests__/error-responses.test.ts packages/server-hono/src/__tests__/proxy-routes.test.ts`
- `bun run --cwd packages/relay tsgo`
- `bun test packages/relay/src/__tests__/relay.test.ts`
- `bun run --cwd packages/core tsgo`
- `bun run --cwd packages/server-hono tsgo`
- `bun run --cwd rust/bindings/browser tsgo`
- `bun test packages/core/src/__tests__/error-responses.test.ts`
- `bun run --cwd packages/core fixtures:protocol`
- `bun run --cwd packages/core tsgo`
- `bun run --cwd packages/server tsgo`
- `bun run --cwd packages/testkit tsgo`
- `bun test packages/server/src/push-operation-codes.test.ts packages/core/src/__tests__/error-responses.test.ts packages/core/src/__tests__/sync-packs.test.ts packages/server/src/encrypted-crdt.test.ts`
- `bun run --cwd apps/demo tsgo`
- `bun run --cwd rust/bindings/browser tsgo`
- `bun test rust/bindings/browser/src/worker-client.test.ts rust/bindings/browser/src/__tests__/auth-hono.wasm.test.ts`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit --test testkit_smoke`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_facade --features native,crdt-yjs`
- `bun run --cwd packages/server-hono tsgo`
- `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`
- `git diff --check`
- `rg -n "\\b(VERSION_CONFLICT|UNKNOWN_TABLE|ROW_MISSING|EMPTY_COMMIT|INVALID_SCOPE|UNSUPPORTED_OPERATION|FORBIDDEN|INVALID_REQUEST|READ_ONLY|MISSING_PROJECT_ID|MISSING_SCOPES|IDEMPOTENCY_CACHE_MISS|CONSTRAINT_VIOLATION|NOT_NULL_CONSTRAINT|UNIQUE_CONSTRAINT|FOREIGN_KEY_CONSTRAINT)\\b" packages/server packages/testkit packages/core apps/demo apps/docs rust/bindings/browser rust/crates/testkit rust/crates/runtime rust/examples/todo-app -g '!node_modules' -g '!target'`
- `bun run --cwd packages/core tsgo`
- `bun run --cwd rust/bindings/browser tsgo`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime error::tests --lib`
- `bun test packages/core/src/__tests__/error-responses.test.ts`
- `bun test rust/bindings/browser/src/worker-client.test.ts`
- `bun test rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/errors.test.ts`
- `bun run --cwd packages/server-hono tsgo`
- `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`
- `git diff --check`
- `bun run --cwd packages/core fixtures:protocol`
- `bun run --cwd packages/core tsgo`
- `bun test packages/core/src/__tests__/error-responses.test.ts`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test error_taxonomy`
- `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`
- `bun run --cwd packages/core tsgo`
- `bun run --cwd packages/server tsgo`
- `bun run --cwd packages/server-hono tsgo`
- `bun test packages/server-hono/src/__tests__/blob-routes.test.ts`
- `bun run --cwd packages/core fixtures:protocol`
- `bun run --cwd packages/core tsgo`
- `bun run --cwd rust/bindings/browser tsgo`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime error::tests --lib`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test error_taxonomy`
- `bun test packages/core/src/__tests__/error-responses.test.ts rust/bindings/browser/src/errors.test.ts`
- `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "clears scoped local rows"`
- `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "revoked sessions|server-required schema|corrupted snapshot chunk"`
- `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`
- `git diff --check`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen native_modules_support_runtime_contract_and_operation_builders`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime generated_app_bindings_target_boltffi_layout --test native_binding_scaffold`
- `swiftc rust/examples/todo-app/generated/swift/SyncularApp.swift rust/examples/todo-app/native-smokes/swift/GeneratedClientSmoke.swift -o .context/generated-swift-smoke && .context/generated-swift-smoke rust/examples/todo-app/conformance/generated-client.json rust/examples/todo-app/conformance/sync-scenarios.json`
- `KOTLIN_CP=".context/native-smokes/kotlin-libs/kotlinx-serialization-json-jvm-1.9.0.jar:.context/native-smokes/kotlin-libs/kotlinx-serialization-core-jvm-1.9.0.jar" && kotlinc -cp "$KOTLIN_CP" rust/examples/todo-app/generated/kotlin/SyncularApp.kt rust/examples/todo-app/native-smokes/kotlin/GeneratedClientSmoke.kt -d .context/generated-kotlin-smoke.jar && kotlin -cp "$KOTLIN_CP:.context/generated-kotlin-smoke.jar" GeneratedClientSmokeKt rust/examples/todo-app/conformance/generated-client.json rust/examples/todo-app/conformance/sync-scenarios.json`
- `javac -d .context/java-smoke rust/bindings/java/dev/syncular/client/SyncularNativeEvent.java`
- `bun test packages/server-hono/src/__tests__/console-gateway-routes.test.ts packages/server-hono/src/__tests__/console-gateway-live-routes.test.ts packages/server-hono/src/__tests__/create-server.test.ts`
- `bun test packages/server-hono/src/__tests__/validation.test.ts`
- `bun test packages/server-hono/src/__tests__/blob-routes.test.ts`
- `bun test packages/server-hono/src/__tests__/pull-chunk-storage.test.ts --test-name-pattern "snapshot chunk|snapshot artifact|artifact"`
- `bun test packages/server-hono/src/__tests__/blob-routes.test.ts packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/pull-chunk-storage.test.ts packages/server-hono/src/__tests__/rate-limit.test.ts`
- `bun test rust/bindings/browser/src/errors.test.ts rust/bindings/browser/src/worker-client.test.ts`
- `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "revoked sessions|server-required schema|corrupted snapshot chunk"`
- `bun test rust/bindings/browser/src/worker-client.test.ts rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "structured worker errors|revoked sessions|server-required schema|corrupted snapshot chunk"`
- `bun test rust/bindings/browser/src/errors.test.ts rust/bindings/browser/src/worker-client.test.ts rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "browser errors|structured worker errors|revoked sessions|server-required schema|corrupted snapshot chunk"`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime error::tests --lib`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime native_sync_failed --lib --features native,crdt-yjs`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime native_local_write_failed --lib --features native,crdt-yjs`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`
- `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`
- `bun run --cwd packages/core tsgo`
- `bun run --cwd packages/server-hono tsgo`
- `bun run --cwd rust/bindings/browser tsgo`
- `bun test packages/core/src/__tests__/error-responses.test.ts`
