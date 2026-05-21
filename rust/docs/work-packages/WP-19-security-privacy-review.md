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

## Next Action

Draft the threat model and add one cross-surface auth-boundary test that covers
pull, realtime, and artifact access for the same unauthorized scope.
