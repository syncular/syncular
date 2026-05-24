# WP-18 Production Hardening And Limits

Status: `[x]` accepted

## Goal

Define and enforce operational limits before real apps discover them through
slow sync, memory growth, unbounded queues, or unclear failures.

## Scope

- Maximum subscriptions per client.
- Maximum scopes per subscription and scope-values-per-client guidance.
- Maximum outbox size and queued mutation payload size.
- Snapshot, artifact, chunk, websocket frame, and pull response size limits.
- Blob, CRDT update, checkpoint, and upload queue limits.
- Bounded diagnostic buffers and payload snapshots.
- Clear limit errors and console visibility.
- Stress tests for configured limits.

## Non-Scope

- Optimizing for full-partition visibility.
- Silent degradation or hidden fallback paths when limits are exceeded.
- Product claims that the system supports unbounded row-level scopes or
  unlimited realtime fanout without explicit benchmarks.

## Acceptance Criteria

- Public limits are documented and configurable where appropriate.
- Limit failures emit WP-15 stable errors and WP-13 diagnostics.
- Console surfaces show limit pressure for clients, subscriptions, queues,
  artifacts, blobs, and CRDT streams.
- Stress tests cover at least subscription count, scope count, outbox growth,
  artifact/chunk size, websocket overflow, and diagnostic buffer bounds.
- Performance-sensitive limits have benchmark evidence in `BENCHMARK_LOG.md`.

## Required Gates

- Runtime/native store tests for queue and buffer limits.
- Browser worker tests for websocket, diagnostic, and storage limits.
- Server route tests for push, pull, artifact, blob, and console limit handling.
- Targeted server perf and browser E2E benchmarks for hot-path limit changes.

## Accept / Reject Rule

- Retain hardening changes that fail clearly before unsafe memory, storage, or
  protocol behavior.
- Reject hidden retries or fallbacks that mask limit pressure.
- Reject default limits that contradict scoped/subscription-shaped access.

## Current Evidence

Existing docs already call out row-level scopes and thousands of scope values
as stress cases needing explicit design and benchmarks. Artifact and realtime
work also introduced size, cache, and overflow-sensitive paths that need
product-level limits.

## Next Action

Move to WP-19 security/privacy review. Future limit additions should extend
`RUNTIME_LIMITS.md` and cite this WP as the accepted baseline.

## Acceptance Review

- Public Rust/native/browser/server limits are documented in
  `RUNTIME_LIMITS.md` and visible through runtime manifests/diagnostics where
  app hosts need them.
- Limit failures use stable `runtime.limit_exceeded` envelopes or native error
  classifications instead of silent clamping.
- Console visibility now covers request/response limit pressure, client and
  subscription pressure, blob storage routes, snapshot chunk/artifact pressure,
  and native diagnostic queue/blob/CRDT pressure.
- Stress coverage exists for subscription/scope limits, mutation/outbox
  payloads, unresolved outbox growth, artifact/chunk size gates, websocket
  overflow, event-stream overflow, and diagnostic payload bounds.
- No hot sync/apply/query path changed in the final console/outbox-pressure
  closure slices, so benchmark gates were not applicable for those slices.

## Progress

- Started the limits inventory and created
  [`RUNTIME_LIMITS.md`](../reference/RUNTIME_LIMITS.md) as the public
  Rust-first limit register.
- Centralized the native/Rust runtime defaults for worker command queues,
  event streams, recent diagnostic events, native read statement cache, pull
  request sizing, outbox push batch size, CRDT queue/log sizing, and Yjs
  coalescing.
- Native runtime manifests and native diagnostic snapshots now expose the same
  `limits` object, so app hosts and support tools can see current runtime
  pressure boundaries before failures happen.
- Rust/native/browser subscription setters now enforce max subscriptions, scope
  keys, scope values per subscription, total scope values, and params keys with
  a stable `runtime.limit_exceeded` classification instead of accepting
  unbounded subscription state.
- Rust/native/browser mutation paths now reject oversized low-level operation
  JSON, local-row JSON, batch JSON, typed mutation batches, and serialized
  outbox operation JSON with the same stable `runtime.limit_exceeded`
  classification.
- Blob and CRDT/Yjs paths now expose and enforce maximum blob payload, CRDT
  request JSON, Yjs update/state/state-vector payload, and CRDT text limits.
- Native diagnostic snapshots now bound retained recent-event payloads by
  redacting oversized `payload_json` values with explicit truncation metadata.
- Snapshot chunk/artifact paths now reject oversized declared, compressed, and
  decompressed payloads before hash/decode/apply work where possible.
- Native websocket text frames and browser realtime binary sync-pack payloads
  now reject oversized frames with stable `runtime.limit_exceeded` errors.
- `@syncular/core` now includes `runtime.limit_exceeded` in the shared public
  error taxonomy, including the `limit-exceeded` category and `reduceInput`
  recovery action used by Rust.
- Hono sync routes now bound combined request JSON, JSON responses, binary
  sync-pack responses, snapshot chunk downloads, and scoped snapshot artifact
  downloads with stable `runtime.limit_exceeded` envelopes.
- Hono console request events now surface combined-level request/response limit
  pressure. Pre-parse combined request failures use the explicit `sync` event
  type, and oversized response failures are recorded as rejected events instead
  of successful pulls.
- Pull cursor recording, realtime subscription updates, and successful pull
  console events now happen only after the response-size gate passes, so a
  `runtime.limit_exceeded` response does not advance client-visible server
  cursor state.
- Sync retry count, sending stale timeout, blob upload retry count, blob upload
  stale timeout, blob upload batch size, and SQLite busy timeout are now visible
  runtime limits in native manifests and diagnostics.
- Rust/native/browser local writes now cap unresolved outbox commits with
  `maxUnresolvedOutboxCommits`. Pending, sending, and failed commits count
  toward the cap; acked commits do not. Full outbox pressure fails the local
  write transaction with `runtime.limit_exceeded` before a new commit is
  retained.
- Console stats now include first-class snapshot chunk/artifact cache pressure
  counters: total cached rows, total bytes, expired rows, and expired bytes.
  The counters honor partition filters and the console gateway sums them across
  selected instances. The command dashboard surfaces total and expired snapshot
  cache pressure as top-level KPIs.

## Latest Evidence

- `bun test src/__tests__` from `packages/server-hono`
- `bun test --pass-with-no-tests` from `packages/server`
- `bun test src/__tests__` from `packages/console`
- `bun run tsgo` from `packages/server`
- `bun run tsgo` from `packages/server-hono`
- `bun run tsgo` from `packages/console`
- `bun run tsgo` from `packages/ui`
- `bun run tsgo` from `packages/transport-http`
- `git diff --check`
- Benchmark gate not run: this slice adds console summary reads and generated
  stats typing. It does not change client sync/apply/query hot paths.
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends diesel_store_rejects_local_writes_when_unresolved_outbox_is_full --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_ffi native_ffi_exposes_runtime_manifest_without_handle`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade native_facade_exposes_redacted_diagnostic_snapshot`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`
- `CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown`
- `git diff --check`
- Benchmark gate not run: this slice adds a hard local-write capacity check and
  limit manifest fields, not snapshot/apply/query hot-path behavior.
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_ffi native_ffi_exposes_runtime_manifest_without_handle`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade native_facade_exposes_redacted_diagnostic_snapshot`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade native_facade_rejects_subscription_limit_with_stable_error`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade native_facade_rejects_mutation_payload_limit_with_stable_error`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade native_facade_rejects_crdt_payload_limits_with_stable_error`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings native::tests::recent_diagnostic_event_payload_is_redacted_when_too_large`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime protocol::tests::oversized_blob_ref_returns_stable_limit_error`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime protocol::tests::oversized_snapshot_refs_return_stable_limit_errors`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime protocol::tests::oversized_realtime_payloads_return_stable_limit_errors`
- `bun test src/__tests__` from `packages/core`
- `bun test src/__tests__` from `packages/server-hono`
- `bun run tsgo` from `packages/core`
- `bun run tsgo` from `packages/server-hono`
- `bun run tsgo` from `packages/console`
- `bun run tsgo` from `packages/transport-http`
- `bun run tsgo` from `packages/ui`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime error_taxonomy`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_ffi native_ffi_exposes_runtime_manifest_without_handle`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade native_facade_exposes_redacted_diagnostic_snapshot`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`
- `CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown`
- `git diff --check`
