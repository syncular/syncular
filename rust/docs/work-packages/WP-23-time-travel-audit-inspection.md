# WP-23 Time Travel And Audit Inspection

Status: `[ ]` planned

## Goal

Let developers and authorized operators inspect historical sync state, row
history, and commit diffs without exposing unauthorized hidden data or rewriting
history.

## Scope

- Row history queries for authorized app rows.
- Commit diffs and per-table/per-row change summaries.
- Console timeline integration with Stream/Ops and WP-13 diagnostics.
- Scoped historical reads that respect current and historical authorization
  semantics.
- Diagnostic/debug export for reproducing sync timelines with redaction.
- Server-side audit inspection APIs for commits, rows, scopes, request events,
  artifacts, realtime recovery, and client apply evidence where available.

## Non-Scope

- Client-side partition-wide hidden history.
- Global rollback as a normal client feature.
- Rewriting commits, cursors, verified roots, artifacts, or audit records.
- Exposing unauthorized rows through diffs, payload snapshots, or debug export.
- Replacing app-owned compliance audit tables.

## Acceptance Criteria

- Authorized operators can inspect row history and commit diffs through server
  audit APIs and console views.
- Historical reads are scoped honestly: clients and console users cannot inspect
  data they are not authorized to see.
- Commit diff views distinguish app-row changes, metadata changes, conflicts,
  scope changes, blobs, encrypted field envelopes, and CRDT update/checkpoint
  evidence where supported.
- Debug export is redacted, size-bounded, and linked to trace/request/client
  diagnostics.
- Time-travel inspection never mutates sync state or causes cursor/root
  advancement.
- Tests cover unauthorized historical read attempts and diff redaction.

## Required Gates

- Server audit route tests.
- Console route and UI/typecheck tests when views change.
- Protocol/integrity tests if historical roots or proofs are exposed.
- Security/privacy tests from WP-19 for scoped historical access.
- Testkit scenarios for row history, commit diffs, revocation, and redacted
  export.

## Accept / Reject Rule

- Retain only read-only audit/time-travel inspection unless a separate explicit
  admin compensating-commit design is accepted.
- Reject any feature that exposes hidden partition history to clients.
- Reject rollback semantics that rewrite history instead of creating new
  server-authoritative commits.

## Current Evidence

The server already stores commits, request events, trace IDs, scopes summaries,
and console timeline surfaces. The product contract allows audit history but
requires verification and scoped access to match what the client/user is
authorized to see.

## First Slice

Add read-only row history and commit diff inspection for server audit APIs:

1. Define scoped audit query inputs for `table`, `rowId`, and commit range.
2. Return redacted change summaries rather than raw hidden payloads by default.
3. Link audit results to existing console timeline/request events.
4. Prove unauthorized row history requests fail without leaking existence or
   payload details.

## Next Action

Design the scoped row-history API and add one server route test for authorized
history plus one unauthorized access test.
