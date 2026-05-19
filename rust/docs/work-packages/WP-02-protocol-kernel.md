# WP-02 Protocol Kernel

Status: `[~]` in progress

## Goal

Make `rust/crates/protocol` the real home for shared Rust protocol types,
canonical encoding, hashing, binary codecs, and fixtures before binary v2 grows
the protocol surface again.

## Scope

- Pull/push request and response structs.
- Commit/change records.
- Snapshot chunk metadata and binary chunk decoding.
- Binary sync-pack metadata.
- Blob references.
- Realtime messages.
- Verification metadata.
- Cross-language protocol fixtures.

## Acceptance Criteria

- Runtime imports protocol types/codecs from `syncular-protocol` instead of
  owning duplicate protocol logic.
- TypeScript fixture generation and Rust fixture tests cover JSON and binary
  protocol paths.
- New protocol work has one Rust entry point.
- No old protocol fallback branches are introduced.

## Required Gates

- Protocol / wire format gate.
- TypeScript package typecheck for touched packages.
- WASM check if browser protocol code is touched.

## Accept / Reject Rule

- Retain extraction only when runtime code actually depends on the protocol
  crate and fixture coverage proves TypeScript/Rust compatibility.
- Reject moves that only rename files without reducing duplicated protocol
  ownership.

## Current Evidence

First retained slice:

- `syncular-protocol` now owns shared request/response structs, operation
  results, subscription integrity metadata, commit/change records, snapshot
  metadata, current sync-pack/snapshot encoding constants, and the binary
  sync-pack wire version.
- Runtime re-exports the shared protocol types to avoid downstream import churn
  while moving ownership into the protocol crate.
- Runtime still owns mutation ergonomics, validation/application behavior,
  snapshot manifest digest helpers, blob APIs, and binary decoder
  implementation.

Second retained slice:

- `syncular-protocol` now owns the binary sync-pack decoder/reader and a small
  protocol-local error type.
- Runtime keeps only a thin adapter that converts protocol errors into runtime
  errors.
- The protocol crate decodes the current TypeScript binary sync-pack fixture
  directly and rejects older wire versions with a clear protocol error.
- Full binary snapshot streaming decode is not moved yet because the public
  visitor traits are still coupled to runtime storage errors. The next split
  should separate pure snapshot chunk decoding from runtime apply visitors.
- Targeted sync-pack/server perf sanity stayed in the accepted noise band for a
  protocol extraction: scoped fanout `3.3ms -> 3.5ms`, dense build
  `38.4ms -> 41.8ms`, dense binary encode `42.7ms -> 41.4ms`, generated binary
  encode `42.4ms -> 42.2ms`, with response bytes unchanged.

Gates run:

- `bun test packages/core/src/__tests__/protocol-fixtures.test.ts packages/core/src/__tests__/sync-packs.test.ts packages/server/src/commit-integrity.test.ts`
- `PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,e2ee,demo-todo-native-fixture`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,e2ee,demo-todo-native-fixture --test protocol_contract --test protocol_fixtures`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`

## Next Action

Separate pure binary snapshot chunk decoding from runtime storage visitor
traits so `syncular-protocol` can own the wire codec without importing runtime
store errors.
