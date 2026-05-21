# WP-19 Security And Privacy Review

Status: `[~]` started

## Goal

Make Syncular's security and privacy posture explicit, testable, and aligned
with scoped access, server authority, verification, encryption, artifacts,
CRDTs, blobs, and observability.

## Scope

- Auth boundary tests for push, pull, realtime, artifacts, blobs, CRDT fields,
  and console routes.
- Redaction guarantees for diagnostics, request events, payload snapshots, and
  debug bundles.
- Encrypted field/blob/CRDT diagnostic safety.
- Artifact authorization and scoped manifest invariants.
- Replay, cursor, reconnect, and revocation edge cases.
- Threat model documentation.
- Security-focused testkit scenarios.

## Non-Scope

- Claiming global transparency or non-equivocation guarantees beyond the
  current scoped verification model.
- Persisting plaintext encrypted fields, secrets, or tokens in diagnostics.
- Allowing debug/export tools to mutate sync history.

## Acceptance Criteria

- Threat model covers server authority, scoped access, local replicas, offline
  mode, artifacts, realtime, blobs, CRDTs, E2EE envelopes, and console access.
- Tests prove unauthorized actors cannot receive, apply, debug-export, or
  inspect data outside effective scopes.
- Diagnostics and debug bundles redact sensitive fields by default.
- Artifact and realtime recovery paths fail closed on auth, scope, digest,
  cursor, or root mismatch.
- Console routes enforce partition/auth boundaries for timeline, payload,
  client, operation, and future audit/time-travel surfaces.

## Required Gates

- Server auth and console route tests.
- Runtime protocol/integrity tests for scoped verification.
- Browser/WASM tests for artifact and realtime auth/recovery behavior.
- CRDT/blob/encryption tests where those surfaces are touched.
- Testkit fault-injection tests for revocation, replay, and unauthorized access.

## Accept / Reject Rule

- Retain only behavior that preserves scoped access and fails closed.
- Reject observability/debuggability features that leak unauthorized data.
- Reject convenience APIs that blur server authority or rewrite history.

## Current Evidence

The product contract already treats scoped access, verification, E2EE, blobs,
CRDTs, and auditability as core. This WP consolidates those rules into an
explicit security/privacy review and test plan.

The first threat model draft is now recorded in
[`SECURITY_PRIVACY_THREAT_MODEL.md`](../reference/SECURITY_PRIVACY_THREAT_MODEL.md).

The first cross-surface server test now proves the same unauthorized
actor/scope mismatch is denied across pull, scoped snapshot artifact download,
and realtime wakeups. It covers the Hono server factory, scoped artifact route,
client cursor/effective-scope state, and websocket connection manager in one
flow:
`packages/server-hono/src/__tests__/create-server.test.ts` ->
`keeps unauthorized scopes denied across pull, realtime, and artifacts`.

Blob URL authorization now has a negative minting test for an existing completed
blob: a forbidden actor receives `blob.forbidden`, and the storage adapter's
`signDownload` path is not called.

Encrypted CRDT local outbox coverage now proves durable pending operations carry
the encrypted system-table payload (`ciphertext`) and do not persist plaintext
text or raw `update_base64` / `state_base64` fields in the server-bound
operation JSON.

Native diagnostic snapshot coverage now also sets dynamic auth headers before
capturing diagnostics and proves bearer/API-key values and header names are not
serialized into the diagnostic snapshot.

## Next Action

Use the pull/realtime/artifact, blob-token, and encrypted-CRDT outbox tests as
templates for the remaining privacy surfaces: encrypted CRDT denial/revocation
edges, console partition/detail denial, and broader debug-bundle redaction.

## Progress

- Drafted the initial Rust-first security/privacy threat model with protected
  assets, trust boundaries, core invariants, surface-specific threats/controls,
  non-goals, and the required cross-surface test shape.
- Added the first Hono cross-surface auth-boundary test. Actor `u2` requesting
  `u1` data gets a revoked pull subscription, cannot download `u1`'s scoped
  snapshot artifact, and opens realtime with zero scopes so `u1` wakeups are not
  delivered.
- Added blob route coverage proving forbidden actors cannot mint signed download
  URLs for an existing completed blob.
- Added encrypted CRDT outbox privacy coverage proving server-bound pending
  operation JSON contains ciphertext, not plaintext text or raw Yjs
  update/state fields.
- Extended native diagnostic snapshot redaction coverage to prove host auth
  headers are not included in diagnostics.
- Gates run in `packages/server-hono`:
  `bun test src/__tests__/create-server.test.ts`,
  `bun test src/__tests__/blob-routes.test.ts`, `bun test src/__tests__`, and
  `bun run tsgo`.
- Gates run for runtime CRDT coverage:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test crdt_field rust_client_exposes_encrypted_crdt_field_through_same_identity --features native,crdt-yjs,demo-todo-native-fixture`,
  and
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test crdt_field --features native,crdt-yjs,demo-todo-native-fixture`.
- Gates run for native diagnostic redaction:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_facade native_facade_exposes_redacted_diagnostic_snapshot --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings`
  and
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_facade --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings`.
