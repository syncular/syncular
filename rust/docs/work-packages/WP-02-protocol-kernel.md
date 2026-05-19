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

Third retained slice:

- `syncular-protocol` now owns binary snapshot table/row/payload decoding and
  row-frame decoding.
- Runtime `binary_snapshot` is now a thin adapter that keeps
  `SnapshotChunkRows` and runtime-error SQLite visitor adapters.
- Binary sync-pack row groups now call the protocol binary snapshot decoder
  instead of maintaining a duplicate private table decoder.
- Release WASM packaging now runs `wasm-opt --all-features`; this reduced the
  current full artifact from `3,417,217` raw bytes to `3,375,951` raw bytes and
  restored budget headroom.
- Store tests no longer rely on outbox commit timestamp ordering for encrypted
  CRDT assertions.
- Browser 100k scoreboard stayed inside the accepted regression gate:
  `rust_bootstrap_ms` `138.04 -> 141.24`, `rust_pull_apply_ms` `73 -> 74`,
  `rust_snapshot_chunk_apply_ms` `62 -> 65`, and served WASM bytes
  `3,326,638 -> 3,375,951` (`+1.48%`, under budget).

Fourth retained slice:

- `syncular-protocol` now owns wire commit digest/root calculation, commit
  integrity metadata validation, subscription verified-root recomputation,
  snapshot manifest digesting, and snapshot manifest validation.
- Runtime `core/protocol.rs` keeps thin wrapper functions that convert protocol
  errors into `SyncularError`, preserving runtime error kinds without owning
  the protocol rules.
- The protocol crate now has direct unit tests for verified roots and snapshot
  manifests.
- No storage, browser apply, server encoder, or wire bytes changed in this
  slice; no performance benchmark was required.

Gates run:

- `bun test packages/core/src/__tests__/protocol-fixtures.test.ts packages/core/src/__tests__/sync-packs.test.ts packages/server/src/commit-integrity.test.ts`
- `PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"`
- `bun run --cwd rust/bindings/browser build:wasm`
- `bun tests/runtime/scripts/browser-e2e-scoreboard.ts --baseline=.context/benchmarks/browser-e2e-100k-baseline.json --fail-on-regression`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,e2ee,demo-todo-native-fixture`
- `CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,e2ee,demo-todo-native-fixture --test protocol_contract --test protocol_fixtures --test store_backends`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`

## Next Action

Move blob wire structs and pure blob hash/validation helpers into
`syncular-protocol`, while keeping blob upload/download transport, queueing,
cache pruning, and store behavior in runtime. After that, inventory realtime
message structs for the same protocol/runtime split.
