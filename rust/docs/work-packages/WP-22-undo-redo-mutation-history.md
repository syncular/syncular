# WP-22 Undo/Redo Mutation History

Status: `[x]` complete

## Goal

Provide app-facing undo/redo for generated mutations by recording command
history and emitting new compensating mutations, without rewriting Syncular
history.

## Scope

- Generated inverse mutations for normal create, update, delete, and batch
  operations.
- Grouped command history so multi-operation app actions undo/redo as one
  unit.
- Conflict-aware undo failures with stable error codes and diagnostics.
- Browser/native parity for command history storage and generated API behavior.
- Optional app-provided command labels/metadata for UI and diagnostics.
- Integration with outbox, conflict tracking, scoped access, encrypted fields,
  blobs, and CRDT fields where safe.

## Non-Scope

- Rewriting server commits, local cursors, verified roots, or audit history.
- Global database rollback.
- Undoing another actor's later intent by default.
- Silent undo after scope revocation or authorization loss.
- Editor-specific CRDT undo stacks inside Syncular core.

## Acceptance Criteria

- Undo/redo emits new mutations through the same mutation/outbox path as normal
  app writes.
- Generated inverse mutations are available for supported app-table
  create/update/delete operations.
- Batched command groups preserve operation order and undo/redo atomically where
  the runtime can safely do so.
- Undo fails clearly when the row, scope, base version, encrypted/blob/CRDT
  state, or server authority makes the inverse unsafe.
- Browser and native clients expose semantically aligned command-history APIs.
- Tests prove undo/redo does not rewrite server history or advance cursors
  outside normal verified sync.

## Required Gates

- Runtime/native mutation, outbox, and conflict tests.
- Browser worker/WASM mutation-history tests.
- Generator checks for inverse mutation APIs.
- Server push/conflict tests when undo-generated mutations touch validation.
- CRDT/blob/encryption tests for any supported inverse behavior on those fields.

## Accept / Reject Rule

- Retain only command-level undo/redo that represents new local intent.
- Reject rollback behavior that rewrites commits, cursors, roots, or audit
  records.
- Reject inverse generation for fields or operations whose prior state cannot
  be restored safely under scoped/server-authoritative semantics.

## Current Evidence

Generated safe mutations, outbox persistence, conflict base-version machinery,
and local SQLite reads already exist. Those are enough for a first undo/redo
slice over normal row create/update/delete operations, but collaborative undo
requires explicit conflict-aware semantics.

First browser/generated-client slice is implemented:

- `@syncular/client-rust` exports a generic command-history controller for the
  browser TypeScript client.
- Generated TypeScript app clients wire `database.commandHistory` and wrap
  `database.mutations` / `database.leasedMutations`.
- Command history records before/after row snapshots and persists command
  groups in local SQLite table `sync_command_history`.
- Undo/redo replays snapshots through the normal generated mutation API, so
  each undo/redo produces a normal local outbox commit instead of rewriting
  commits, cursors, roots, or audit history.
- Stale-row undo/redo fails with stable
  `sync.command_history_conflict`.
- Blob, encrypted, and CRDT-backed field changes are rejected during replay
  with stable `sync.command_history_unsafe_field` until each field class has
  explicit safe inverse semantics.
- Browser generated-client coverage now includes `update -> undo -> redo`,
  insert undo/redo, hard-delete undo/redo, soft-delete undo/redo, and grouped
  multi-row commits. The update proof verifies three normal mutation intents.

Native/Rust parity foundation is implemented:

- Runtime owns the shared `sync_command_history` system table.
- Diesel storage exposes typed command-history record/latest/mark methods.
- `SyncularCommandHistoryExecutor` gives generated Rust clients a stable trait
  boundary for reading current rows, recording command snapshots, replaying
  normal/leased mutation batches, and marking undo/redo commits.
- Generated Rust clients expose `commit_with_history(...)`,
  `commit_leased_with_history(...)`, and
  `command_history().undo_last()` / `redo_last()`.
- Generated Rust replay strips primary-key, server-version, and CRDT state
  columns from snapshot payloads, rejects blob/encrypted/CRDT field changes as
  unsafe, and emits compensating operations through the normal outbox path.
- Example-app coverage proves tracked Rust update -> undo -> redo produces
  four normal outbox commits including the seed insert, and stale-row undo
  fails with `sync.command_history_conflict` before a replay commit is written.
- Rust coverage also proves grouped insert undo/redo, hard-delete undo/redo,
  and soft-delete undo/redo on the generated `comments.deleted` soft-delete
  column.
- Rust coverage proves undo-generated commits persist server push conflicts
  through the normal conflict table/path.
- Current field-class decision: blob columns, encrypted fields, CRDT logical
  fields, and CRDT state columns are not automatically inverted. Replay rejects
  commands that changed those fields with
  `sync.command_history_unsafe_field` before writing a compensating commit.
- Native Diesel tracked commits record command history inside the same SQLite
  transaction as the mutation/outbox write. The trait keeps a non-atomic
  default for alternate clients, but the canonical native runtime path is
  atomic.
- Leased undo fails closed after auth lease revocation without changing the
  local row, without writing a replay commit, and while keeping the command
  undoable for a future valid lease.
- Swift/Kotlin generated command-history wrappers are deferred until those
  generated mutation APIs are mature enough to avoid baking a second app-facing
  shape.

Gates:

- `bun test rust/bindings/browser/src/generated-app-conformance.test.ts`
- `bun run --cwd rust/bindings/browser test`
- `bun run --cwd rust/bindings/browser tsgo`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends diesel_store_persists_command_history_records --features native,crdt-yjs,e2ee,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends diesel_generated_leased_command_history_undo_fails_after_lease_revocation --features native,crdt-yjs,e2ee,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-todo-app-example command_history`

## First Slice

Implement generated inverse command records for basic row create/update/delete
in one TypeScript generated example:

1. Record command groups and prior local row state before emitting a supported
   mutation.
2. Expose `undoLast()` and `redoLast()` as generated-client helpers.
3. Emit compensating mutations through the normal outbox path.
4. Fail with a stable code when the row has changed incompatibly or scope has
   been revoked.

## Deferred Follow-Ups

1. Add optional command labels/metadata when apps need UI history lists.
2. Revisit safe inverse semantics for blob/encrypted/CRDT fields only after
   those field classes have explicit app/runtime restore policies.
3. Add Swift/Kotlin command-history wrappers once their generated mutation APIs
   settle.
