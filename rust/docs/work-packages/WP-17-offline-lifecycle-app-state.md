# WP-17 Offline Lifecycle And App State Integration

Status: `[~]` started

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

Add native/runtime parity for the same lifecycle contract so app-specific Rust
wrappers can consume the canonical event stream without rebuilding state
machines.

## Progress

- Activated after WP-16 accepted the schema-evolution safety slice.
- Added the first browser lifecycle surface: `lifecycleState()` plus
  `lifecycleChanged` events. The state reports `offline`, `connecting`,
  `syncing`, `recovering`, `authRequired`, `degraded`, `complete`, and
  `closed` phases with realtime, bootstrap, outbox, conflict, diagnostic, and
  pending-request context.
- Worker client tests now prove lifecycle transitions for connecting,
  resync-required recovery, auth-required action, and final complete state.
- Browser/Hono integration now proves a production-shaped flow: generated
  mutations queue while the server is offline, the public lifecycle state shows
  pending outbox and failed sync state, retry backoff is honored, reconnect
  pushes the queued commit, and lifecycle reaches `complete` after the server
  has the row.

## Latest Evidence

- `bun test rust/bindings/browser/src/worker-client.test.ts -t "lifecycle"`
- `bun test rust/bindings/browser/src/worker-client.test.ts rust/bindings/browser/src/client.test.ts`
- `bun run --cwd rust/bindings/browser tsgo`
- `bun test rust/bindings/browser/src/public-api.test.ts rust/bindings/browser/src/react.test.ts`
- `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts -t "lifecycle state"`
- `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts`
