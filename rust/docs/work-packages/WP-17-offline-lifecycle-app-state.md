# WP-17 Offline Lifecycle And App State Integration

Status: `[ ]` planned

## Goal

Make offline, online, reconnect, and background-resume behavior ergonomic for
apps without weakening offline correctness or server authority.

## Scope

- App-facing network and sync lifecycle states.
- Queued mutation visibility and outbox progress.
- Optimistic state reconciliation guidance.
- Background resume hooks for browser and native runtimes.
- Mobile app lifecycle hooks for suspend, resume, foreground, and background
  sync policy.
- Battery/network-aware sync policy where supported.
- Integration with WP-05 readiness, WP-13 diagnostics, and WP-15 error codes.

## Non-Scope

- Letting offline mode pretend unauthorized data is valid after revocation.
- Making apps babysit websocket reconnect loops.
- Raw app-table writes as an offline synced write API.

## Acceptance Criteria

- Apps can render clear states for online, offline, connecting, recovering,
  auth-required, degraded, and complete.
- Outbox, conflict, blob upload, and realtime recovery status are observable
  without polling internal tables.
- Background resume performs explicit recovery/checkpoint behavior instead of
  silent best-effort state changes.
- Native and browser lifecycle events are semantically aligned where supported.
- Tests cover offline mutation queueing, reconnect recovery, auth refresh, and
  scope revocation while offline.

## Required Gates

- Runtime/native store tests for outbox, reconnect, and recovery behavior.
- Browser worker/realtime tests for lifecycle events.
- Native binding smokes when lifecycle APIs change.
- Browser E2E reconnect/offline benchmarks when reconnect performance changes.

## Accept / Reject Rule

- Retain only lifecycle APIs that make sync state explicit and keep recovery
  runtime-owned.
- Reject app-facing states that imply incomplete or unauthorized data is valid.
- Reject policies that hide failed pushes, failed pulls, or revocation clearing.

## Current Evidence

The Rust-first roadmap already prioritizes runtime-owned realtime reconnect,
explicit recovery, and adaptive bootstrap readiness. This WP turns those
mechanics into app-state APIs that developers can render and test.

## Next Action

Define a stable lifecycle event shape and wire one browser worker test covering
offline mutation queueing, reconnect recovery, and final complete state.
