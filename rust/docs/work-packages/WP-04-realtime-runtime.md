# WP-04 Realtime Runtime

Status: `[ ]` planned

## Goal

Make websocket deltas the canonical fast path, with HTTP pull reserved for
recovery/checkpoint paths.

## Scope

- Persistent runtime-owned websocket.
- Reconnect/backoff/auth refresh.
- Verified delta cursor/replay.
- Runtime-owned sync wakeups.
- Overflow/resync events.
- Worker event stream parity across Rust, native facade, browser worker, and
  generated bindings.

## Acceptance Criteria

- Apps do not babysit reconnect loops.
- Slow event subscribers receive explicit overflow/resync semantics.
- Realtime deltas carry enough row/field metadata for precise live-query/app
  updates.
- HTTP fallback count stays visible in benchmarks.

## Required Gates

- Browser E2E incremental/realtime gate.
- Runtime worker event tests.
- Native event stream tests.

## Accept / Reject Rule

- Retain websocket-fast-path work only if it preserves pull recovery,
  authorization, ordering, and explicit overflow/resync semantics.
- Revert changes that make apps babysit reconnects or hide HTTP fallback.

## Next Action

Unify websocket delta verification with the same stable event/root semantics
used by pull recovery.
