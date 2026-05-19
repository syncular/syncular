# WP-11 Server Edge And Offline Auth

Status: `[ ]` planned

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

The current decision is to defer a pure Rust server. Offline auth remains a
design item and should not weaken strict online `/sync` authorization.

## Next Action

Write the offline auth lease model before implementation: lease issue/expiry,
revocation behavior, local UX state, and how sync reports expired or revoked
leases.
