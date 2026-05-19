# WP-07 CRDT Fields

Status: `[ ]` planned

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

## Next Action

Add one focused CRDT stream-polish slice: state-vector pull hints or compaction
diagnostics, with convergence and no-blanking tests.
