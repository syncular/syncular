# WP-11 Server Edge And Offline Auth

Status: `[~]` in progress

## Goal

Keep server/edge work sequenced behind the Rust client foundation while
designing offline auth leases honestly.

## Scope

- Rust edge proxy investigation.
- Pure Rust server only if protocol/client foundation proves it is worth it.
- Offline auth lease model.
- Revocation/expiry/refresh semantics.
- Server protocol support for verified deltas, resumable manifests, and
  subscription indexes.

## Acceptance Criteria

- No CF Worker Rust rewrite starts before the protocol kernel is stable.
- Offline auth leases do not imply unsafe authorization guarantees.
- Server protocol changes are benchmarked against Rust client behavior.

## Required Gates

- Server tests for changed protocol behavior.
- Protocol fixture tests.
- Perf gates for server hot paths.

## Accept / Reject Rule

- Retain server/edge changes only when they support the Rust-client protocol
  foundation or clearly improve measured hot paths.
- Reject a Rust/CF Worker server rewrite until the protocol kernel and client
  performance foundation are stable.
- Reject offline-auth designs that imply authorization after server-side
  revocation without an explicit lease model and user-visible limits.

## Current Evidence

The current decision is to defer a pure Rust server. Offline auth must not
weaken strict online `/sync` authorization. The legacy JS offline-auth package
is a local UX/session-cache primitive, not a signed server authorization model.
The first Rust slice now exists as protocol/testkit foundation only: typed lease
payload/header/provenance/result structs and deterministic ES256 testkit token
helpers.

## Next Action

Next narrow slice is local lease storage and outbox provenance behind a
migration. Do not start a Rust server rewrite, and do not let a lease bypass
normal reconnect authorization.

## Progress

- Added [`../reference/OFFLINE_AUTH_LEASE_MODEL.md`](../reference/OFFLINE_AUTH_LEASE_MODEL.md)
  as the explicit lease contract before implementation. The model keeps the
  server authoritative, uses signed bounded leases only for offline intent
  capture, records lease provenance on queued commits, and requires normal
  request auth plus current handler authorization at replay.
- The model defines v1 token shape, recommended `ES256` signature header,
  lease payload fields, client storage/outbox provenance, server replay order,
  stable `sync.auth_lease_*` error codes, diagnostics, and testkit/conformance
  requirements.
- Added Rust protocol structs/constants for the v1 offline-auth lease contract:
  protected header, payload, scopes, capabilities, validation result, outbox
  provenance, and stable `sync.auth_lease_*` codes.
- Added `syncular-testkit` deterministic ES256 lease helpers:
  `TestAuthLeaseKeyPair`, `issue_test_auth_lease`, and
  `verify_test_auth_lease`.
- Added smoke coverage for valid, expired, and tampered test auth lease tokens.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol -p
  syncular-testkit` passed with `15` protocol tests and `36` testkit smoke
  tests.
- Gate: `bun run rust:conformance:fast` passed after the protocol/testkit
  lease slice.
- Gate: `bun run rust:check:no-default` passed without warnings after cleaning
  an existing CRDT-only cfg import.
- Gate: `bun run rust:check:client-native-crdt` passed.
