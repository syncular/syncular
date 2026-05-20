# WP-15 Error Taxonomy And Recovery Semantics

Status: `[~]` in progress

## Goal

Standardize public Syncular errors across browser, native, server, transports,
and generated clients so apps know what happened and what recovery action is
valid.

## Scope

- Stable public error codes.
- Error classification: retryable, fatal, auth-required, schema-mismatch,
  integrity-rejected, conflict, scope-revoked, offline, transport, and storage.
- User-facing recovery hints for generated clients and diagnostics.
- Browser/native/server parity for error envelopes.
- Tests asserting exact codes for important recovery and failure paths.
- Integration with WP-13 diagnostic events and WP-14 generated APIs.

## Non-Scope

- Turning errors into silent fallback behavior.
- Reintroducing old client/protocol compatibility paths.
- Allowing apps to bypass verification, mutation/outbox, or server authority
  when an error occurs.

## Acceptance Criteria

- Public errors carry stable `code`, `category`, `retryable`, and
  `recommendedAction` fields where applicable.
- Auth, schema mismatch, integrity rejection, scope revocation, conflict,
  websocket recovery, artifact corruption, and storage fallback cases have
  explicit codes.
- Generated clients expose typed errors without losing the underlying diagnostic
  metadata.
- Tests assert exact codes for representative browser, native, server, and
  transport failures.
- Console and client diagnostic snapshots can group failures by stable code.

## Required Gates

- Core error-schema tests.
- Browser worker error tests.
- Server route tests for push, pull, artifact, blob, auth, and console errors
  where touched.
- Runtime/native tests for Rust error envelope changes.
- Generated client smokes where public bindings change.

## Accept / Reject Rule

- Retain only errors that make recovery explicit and preserve fail-closed sync
  behavior.
- Reject generic string-only public errors on new surfaces.
- Reject retry hints that would cause apps to advance cursors, trust
  unverified data, or ignore authorization failures.

## Current Evidence

The repo already has structured diagnostics, request events, transport stats,
conflict state, and server outcome fields. Those pieces need a stable public
error taxonomy so app code and console investigation do not parse message text.

## Next Action

Continue expanding the same stable error envelope beyond the browser worker:
native facade/BoltFFI, direct browser Rust client errors, server JSON error
responses, blob failures, and generated typed errors.

## Progress

- Browser worker error payloads now support stable public error `code`,
  `category`, `retryable`, and `recommendedAction` fields.
- `SyncularV2WorkerError` exposes those fields directly for app code.
- Runtime errors surfaced through the browser worker now classify representative
  recovery-critical failures:
  `sync.auth_required`, `sync.schema_mismatch`, and
  `sync.integrity_rejected`.
- Worker diagnostics now use the stable classified code when available and copy
  the error envelope fields into diagnostic details, so app tooling does not
  parse message text.
- Browser/Hono WASM tests assert exact error envelopes for auth-required,
  server-required schema mismatch, and corrupted snapshot chunk integrity
  rejection.

## Latest Evidence

- `bun run --cwd rust/bindings/browser tsgo`
- `bun test rust/bindings/browser/src/worker-client.test.ts rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "structured worker errors|revoked sessions|server-required schema|corrupted snapshot chunk"`
