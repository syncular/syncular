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

Gates run:

- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,e2ee,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,e2ee,demo-todo-native-fixture --test protocol_contract --test protocol_fixtures`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`

## Next Action

Move the binary sync-pack decoder/reader into `syncular-protocol` behind a
small protocol error type or conversion layer, then keep runtime as a thin
adapter over the protocol decoder.
