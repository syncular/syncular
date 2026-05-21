# WP-30 Rust Realtime Fanout

Status: `[!]` blocked pending WP-27 evidence and realtime product pressure

## Goal

Extract a Rust-owned realtime fanout component for high-throughput websocket
connection management and delivery, without moving app mutation semantics or
scope resolution into Rust.

## Why

Realtime is already a Rust-first client concern: websocket deltas are the fast
path, HTTP pull remains recovery, and binary sync-pack deltas must preserve
subscription integrity. A Rust fanout component could eventually share protocol
validation, ACK/overflow semantics, and connection lifecycle logic across relay,
edge proxy, and future server deployments.

## Scope

- Connection registry and owner-key model.
- ACK tracking, replay window policy, overflow handling, and explicit
  pull-required recovery messages.
- Validation of server-prepared binary sync-pack realtime frames through
  `syncular-protocol`.
- Presence message validation and fanout where presence is part of the selected
  product target.
- Metrics for connected clients, sent bytes, dropped frames, ACK latency,
  reconnects, and HTTP recovery count.
- Integration boundary that lets the current JS server or relay provide
  already-authorized, subscription-shaped payloads.

## Non-Scope

- No app table handlers.
- No server-side scope resolution in Rust.
- No commit building from app operations.
- No replacement for HTTP pull recovery.
- No old wakeup-only realtime protocol path.

## Acceptance Criteria

- Rust fanout can deliver server-prepared binary realtime frames while
  preserving ACK, overflow, dropped-count, and pull-required semantics.
- Clients that cannot receive a valid binary frame get explicit pull-required
  recovery, not inline JSON deltas.
- Reconnect and replay behavior matches WP-04 semantics.
- Metrics expose HTTP fallback/recovery count and fanout pressure.
- Integration tests cover direct server use and relay/proxy-style use if both
  are in scope for the product target.

## Required Gates

- WP-27 gates.
- Browser realtime E2E incremental/realtime gate.
- Server/Hono websocket manager tests or their Rust equivalent.
- Relay websocket tests if relay integration is touched.
- Targeted fanout throughput and reconnect benchmark for the selected runtime.

## Accept / Reject Rule

- Retain only if the Rust component is fed already-authorized,
  subscription-shaped payloads and does not become a hidden server rewrite.
- Reject if apps have to babysit reconnects or if HTTP recovery becomes
  invisible.
- Reject JSON inline realtime deltas or synthetic rootless subscriptions.

## Current Evidence

- WP-04 accepted binary websocket deltas as the current fast path and removed
  public inline JSON websocket apply.
- Server/Hono currently owns websocket connection management and binary
  realtime pack preparation.

## Next Action

Wait for WP-27 and a concrete realtime bottleneck. Then define the boundary
between server-prepared payload generation and Rust-owned fanout before
implementation.
