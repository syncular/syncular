# WP-07 CRDT Fields

Status: `[~]` in progress

## Goal

Polish generic CRDT document fields as a first-class runtime primitive while
keeping editor adapters at app level.

## Scope

- Yrs/Yjs update merge/materialization.
- Encrypted update/checkpoint system tables.
- Compaction policy.
- State-vector hints.
- No-blank materialization guards.
- Remote update observation and diagnostics.

## Acceptance Criteria

- Two-client convergence tests cover online, offline, duplicate, and reordered
  delivery.
- Encrypted CRDT fields never expose plaintext in persisted sync payloads.
- Compaction cannot blank materialized content.
- Apps can build TipTap/ProseMirror adapters without reimplementing dangerous
  persistence/sync plumbing.

## Required Gates

- CRDT runtime tests.
- Browser Worker/WASM CRDT tests.
- Native generated binding smokes when host APIs change.

## Accept / Reject Rule

- Retain generic `(table, row_id, field)` runtime improvements.
- Reject editor-specific core APIs for TipTap, ProseMirror, Excalidraw, or
  app-defined document schemas.
- Revert compaction/materialization changes that can blank an existing
  document on malformed or missing updates.

## Current Evidence

The Rust runtime already has a generic CRDT document-field primitive. Remaining
work is polish: stream behavior, diagnostics, state-vector hints, and stronger
encrypted/convergence coverage.

Latest accepted slice:

- `compact_crdt_field` now returns a structured diagnostic receipt with
  before/after compaction stats instead of only `checkpointCreated`.
- Compaction stats intentionally omit the full CRDT state blob and include
  counters, state-vector, update timestamp, and compacted timestamp.
- Encrypted update-log fields include before/after stream checkpoint stats so
  hosts can see whether a checkpoint was actually useful.
- The same receipt shape is exposed through native JSON, browser WASM, and
  generated Swift/Kotlin clients.
- Runtime tests assert server-merge compaction timestamps, encrypted checkpoint
  stream stats, and no state-vector/content blanking.
- Native event streams now expose bounded timeout reads through BoltFFI and
  generated Swift/Kotlin/Java wrappers. Native smokes use these reads so missing
  events fail with diagnostics instead of hanging the lane.
- Pull integrity verification now runs against the encrypted wire response
  before field decryption; the verified root is then persisted while applying
  the decrypted local row. This keeps encrypted fields compatible with canonical
  commit-root verification on native and browser clients.

Gate evidence:

- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test crdt_field`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract canonical_commit_integrity_verifies_wire_payload_before_decrypting_pull`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_binding_scaffold`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --features native,boltffi-bindings`
- `bun run --cwd rust/bindings/crdt-adapters test`
- `bun run --cwd rust/bindings/browser tsgo`
- `bun run --cwd rust/bindings/crdt-adapters tsgo`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-client --no-default-features --features native,crdt-yjs`
- `swiftc rust/examples/todo-app/generated/swift/SyncularApp.swift rust/examples/todo-app/native-smokes/swift/GeneratedClientSmoke.swift -o .context/native-smokes/generated-swift-smoke && .context/native-smokes/generated-swift-smoke rust/examples/todo-app/conformance/generated-client.json rust/examples/todo-app/conformance/sync-scenarios.json`
- `kotlinc ... rust/examples/todo-app/generated/kotlin/SyncularApp.kt rust/examples/todo-app/native-smokes/kotlin/GeneratedClientSmoke.kt ... && kotlin ... GeneratedClientSmokeKt rust/examples/todo-app/conformance/generated-client.json rust/examples/todo-app/conformance/sync-scenarios.json`
- `bun run --cwd rust/bindings/browser build:wasm:dev`
- `bun test --cwd rust/bindings/browser src/__tests__/sync-hono.wasm.test.ts`
- `bun run rust:conformance:fast`
- `bash rust/examples/todo-app/native-smokes/run-local.sh`

Known local environment note:

- Direct `cargo check --target wasm32-unknown-unknown --features
  web-owned-sqlite` failed in this workspace because the default `clang` cannot
  compile `sqlite-wasm-rs` for `wasm32-unknown-unknown`. The repo browser build
  script succeeds and remains the active WASM gate here.

## Next Action

Continue with state-vector pull hints or remote update observation diagnostics.
