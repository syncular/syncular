# WP-22 Undo/Redo Mutation History

Status: `[~]` in progress

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
- Browser generated-client coverage now includes `update -> undo -> redo`,
  insert undo/redo, hard-delete undo/redo, soft-delete undo/redo, and grouped
  multi-row commits. The update proof verifies three normal mutation intents.

Gates:

- `bun test rust/bindings/browser/src/generated-app-conformance.test.ts`
- `bun run --cwd rust/bindings/browser test`
- `bun run --cwd rust/bindings/browser tsgo`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`

## First Slice

Implement generated inverse command records for basic row create/update/delete
in one TypeScript generated example:

1. Record command groups and prior local row state before emitting a supported
   mutation.
2. Expose `undoLast()` and `redoLast()` as generated-client helpers.
3. Emit compensating mutations through the normal outbox path.
4. Fail with a stable code when the row has changed incompatibly or scope has
   been revoked.

## Next Action

Extend the command-history proof beyond browser TypeScript:

1. Add native/Rust command-history storage and generated API alignment.
2. Add create/delete/batch coverage, including soft-delete tables.
3. Decide which blob, encrypted-field, and CRDT-field mutations are safe to
   invert automatically and reject unsafe cases with stable diagnostics.
4. Add sync/conflict tests proving undo-generated commits interact with server
   validation and conflict persistence through the normal outbox path.
