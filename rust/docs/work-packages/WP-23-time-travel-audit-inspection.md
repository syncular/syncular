# WP-23 Time Travel And Audit Inspection

Status: `[~]` in progress

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

The first server API slice now exists:

- `ServerSyncDialect.readAuditRowHistory(...)` applies partition, table, row
  id, commit range, and resolved scope filtering before route code sees rows.
- SQLite and Postgres dialects implement the scoped row-history query.
- `GET /audit/rows/:table/:rowId` returns redacted row history with commit
  metadata, operation, row version, payload field names, and scope field names.
  It does not return stored row payloads by default.
- Unauthorized scope attempts return `sync.not_found` and tests assert the
  hidden title/commit id is not leaked.
- Console now has `GET /row-history/:table/:rowId`, which returns the same
  redacted history shape for an operator-selected partition and links each
  entry to existing request/timeline evidence through request event ids,
  request ids, and trace ids.
- Row-history responses now include stable redaction metadata:
  `changeKind`, `sensitiveFields`, and `redaction`. The shared classifier
  distinguishes app rows, deletes, blob references, encrypted field envelopes,
  encrypted CRDT updates, and encrypted CRDT checkpoints without returning
  payload values.
- `GET /audit/commits/:commitSeq` now returns only visible scoped changes for
  the authenticated actor and uses the same redacted summary shape. If the
  commit has no visible changes for that actor, the route fails as
  `sync.not_found` rather than leaking commit payloads from another scope.
- Console commit details also use redacted change summaries instead of raw
  `rowJson` payloads.
- `@syncular/testkit` now exports audit assertions for canonical redaction
  markers and forbidden-payload leak checks so app tests can verify Syncular
  audit responses without mocking the runtime.
- OpenAPI/transport types now include the row-history endpoints and redacted
  commit-change shape. The console Stream view renders change kind, field
  names, sensitive field names, and redaction state instead of raw row JSON.

Evidence:

- `bun test packages/server-hono/src/__tests__/audit-routes.test.ts`
- `bun test packages/server-hono/src/__tests__/console-routes.test.ts`
- `bun test packages/testkit/src/audit.test.ts`
- `bun --cwd packages/server tsgo`
- `bun --cwd packages/server-dialect-sqlite tsgo`
- `bun --cwd packages/server-dialect-postgres tsgo`
- `bun --cwd packages/server-hono tsgo`
- `bun --cwd packages/testkit tsgo`
- `bun --cwd packages/transport-http tsgo`
- `bun --cwd packages/console tsgo`

## Interface Impact

Canonical semantics:

- Audit/time-travel inspection is read-only, redacted, scoped, and server
  authoritative.
- Normal clients should not receive hidden rows, raw row payload snapshots, or
  history outside current authorization.
- Debug exports are support artifacts with explicit redaction and size limits,
  not a client-side rollback or raw data export surface.

TypeScript/browser:

- TypeScript host bindings may consume transport types and support-bundle
  helpers, but normal app clients should not expose broad audit routes by
  default.
- Any support/debug export API must preserve redacted commit-change shapes and
  stable error taxonomy.

React:

- React should not add general app hooks for audit history unless a product
  support UI needs them. Support hooks, if added, should consume the same
  redacted server/export surface.

Tauri/React Native/Expo:

- Bridge packages should expose only support-bundle/debug-export primitives
  when needed and must not bridge raw row/request payloads to shells.

Testkit/docs:

- Testkit should provide reusable assertions for row history, commit diffs,
  revocation, redacted exports, and forbidden-payload leak checks.

## First Slice

Add read-only row history and commit diff inspection for server audit APIs:

1. `[x]` Define scoped audit query inputs for `table`, `rowId`, and commit range.
2. `[x]` Return redacted change summaries rather than raw hidden payloads by default.
3. `[x]` Link audit results to existing console timeline/request events.
4. `[x]` Prove unauthorized row history requests fail without leaking existence or
   payload details.

## Next Action

Add a redacted debug export route and decide how much of WP-23 should move into
shared conformance/testkit scenarios versus server-specific route tests.
