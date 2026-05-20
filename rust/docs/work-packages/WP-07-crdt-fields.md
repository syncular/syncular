# WP-07 CRDT Fields

Status: `[x]` complete

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

The Rust runtime now has a generic CRDT document-field primitive with native,
browser, encrypted update-log, diagnostics, recovery, and convergence coverage.

Latest accepted slice:

- `changedRows` now include structured `crdtFieldChanges` metadata for
  CRDT-backed app fields: logical field, state column, container key,
  row-id field, kind, and sync mode.
- Native remote pulls derive generic `CrdtFieldChanged` events from
  CRDT-backed row changes. The event payload carries source, operation,
  commit/subscription/server-version diagnostics, changed fields, and CRDT
  state columns so UI bridges can refresh active documents without guessing
  from table-level changes.
- Worker-coalesced Yjs writes now resolve the same CRDT field metadata before
  emitting local row-change events, so queued editor bursts report the state
  column and logical CRDT field consistently.
- Browser worker/runtime row-change events expose the same
  `crdtFieldChanges` shape, and generated TypeScript/Swift/Kotlin clients plus
  the Java native event parser surface it to app code.
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
- Pull requests now carry explicit per-subscription `crdtStateVectors` hints.
  Native Diesel and browser owned-SQLite collect hints from
  `sync_crdt_documents`, scope-filter them against the app row, and attach
  `(rowId, field, stateColumn, stateVectorBase64, syncMode, updatedAt)` to the
  subscription. This keeps CRDT catch-up optimization aligned with scoped access
  instead of whole-table or whole-partition assumptions.
- Server-side pull resolution preserves those scoped CRDT state-vector hints
  through authorization/scope intersection and exposes a generic pull-change
  plugin hook before wire integrity is calculated.
- `@syncular/server-plugin-yjs` now uses the hints for incremental pulls:
  eligible server-merge CRDT fields are emitted as `__yjs` update envelopes
  instead of full state columns, while non-CRDT row fields remain in the row
  payload.
- The Yjs server plugin now also carries existing row columns forward for
  CRDT-only mutation payloads, so default upsert handlers do not reject
  existing-row updates on required non-CRDT columns.
- Rust remote apply now merges non-CRDT fields from a diff-envelope row into
  the existing local row before applying the CRDT update, so server-side Yjs
  diffs do not drop ordinary row changes.
- Browser/Hono coverage now runs the actual Yjs server plugin instead of a fake
  sync-route response, verifies a second Rust WASM client sends a state-vector
  hint after snapshotting the CRDT field, and confirms the server returns an
  incremental `__yjs` diff row without the full state column.
- Native Diesel coverage applies the same incremental diff-envelope shape,
  verifies ordinary row fields in the payload are preserved, and confirms the
  native pull request includes the CRDT state-vector hint.
- CRDT state-vector hints intentionally affect incremental pull changes only.
  Bootstrap/rebootstrap snapshots remain full-state rows because reset paths may
  clear scoped local rows before apply, and cached snapshot chunks/artifacts are
  scope/table/version artifacts, not per-client CRDT-state artifacts.
- Any future snapshot CRDT optimization must be a separate side channel with an
  explicit local-state requirement and a full-state recovery path. It must not
  rewrite canonical snapshot rows or weaken scoped reset/revocation semantics.
- Server-generated Yjs diff envelopes now carry `requiresStateVectorBase64`.
  Rust and server-side Yjs materialization reject required-base diffs when the
  local CRDT state is missing or at a different state vector, with an explicit
  "full snapshot resync required" diagnostic instead of silently applying a
  partial document update.
- Native `SyncFailed` events now set `resyncRequired` and use the
  `sync.resync_required` diagnostic code for required-base CRDT diff failures.
  Direct Rust worker consumers can use `SyncWorkerEvent::requires_full_refresh()`
  for the same decision, and the browser worker includes `resyncRequired` in
  failed sync diagnostics/errors.
- Rust/native/browser clients now expose a force-bootstrap helper that deletes
  local subscription cursor/root state so the next pull re-enters canonical
  snapshot bootstrap. Browser managed lifecycle automatically calls it and
  resyncs when a sync diagnostic reports `resyncRequired`.
- Native Diesel recovery coverage now exercises the full path: required-base
  CRDT diff fails without local state, `force_subscriptions_bootstrap` resets
  subscription state, and the next pull requests cursor `-1` and recovers from a
  full snapshot row.
- Browser/Hono worker coverage mirrors the same recovery path: clearing the
  local app row's materialized Yjs state while preserving CRDT state-vector hints
  produces a `sync.resync_required` diagnostic, then
  `forceSubscriptionsBootstrap()` resets the subscription and the next worker
  sync restores the row from snapshot.
- Encrypted update-log CRDT updates now carry required-base state vectors inside
  the encrypted plaintext envelope. Missing or mismatched local base state fails
  with the same full-snapshot-resync diagnostic instead of applying a partial
  encrypted update against an empty document.
- Pull request construction now skips CRDT state-vector hints for encrypted CRDT
  system-table subscriptions. Those subscriptions bootstrap/recover through
  `sync_crdt_updates` and `sync_crdt_checkpoints`, not app-row Yjs diff hints.
- Native Diesel coverage now proves encrypted update-log recovery: a required
  encrypted update fails without the base, `force_subscriptions_bootstrap`
  resets the app/update/checkpoint subscriptions, and a checkpoint snapshot
  rematerializes the encrypted field without plaintext wire leakage.

Gate evidence:

- `bun test plugins/yjs/server/src/index.test.ts`
- `bun test packages/server/src/pull-plugins.test.ts`
- `bun test --cwd rust/bindings/browser src/__tests__/sync-hono.wasm.test.ts -t "applies a generated app server-merge CRDT field through the Rust WASM worker"`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test crdt_field`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test crdt_field diesel_client_applies_server_merge_crdt_diff_pull_with_row_fields`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features crdt-yjs diff_envelope_remote_rows_preserve_non_crdt_payload_fields`
- `bun run tsgo`
- `bunx biome check packages/server/src/plugins/types.ts packages/server/src/pull.ts packages/server/src/subscriptions/resolve.ts packages/server/src/pull-plugins.test.ts packages/server-hono/src/routes.ts plugins/yjs/server/src/index.ts plugins/yjs/server/src/index.test.ts`
- `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
- `bun run tsgo` from `rust/bindings/browser`
- `bun run build:wasm:dev` from `rust/bindings/browser`
- `bun test src/__tests__/sync-hono.wasm.test.ts -t "applies a generated app server-merge CRDT field through the Rust WASM worker"` from `rust/bindings/browser`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test crdt_field`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_facade`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract canonical_commit_integrity_verifies_wire_payload_before_decrypting_pull`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_binding_scaffold`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --features native,boltffi-bindings`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
- `bun run --cwd rust/bindings/crdt-adapters test`
- `bun run --cwd rust/bindings/browser tsgo`
- `bun test --cwd rust/bindings/browser src/generated-app-conformance.test.ts`
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

WP-07 is complete. Related follow-up work should continue in WP-13 for richer
CRDT observability diagnostics and WP-15 for broader error taxonomy/recovery
semantics.
