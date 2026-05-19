# WP-04 Realtime Runtime

Status: `[~]` started

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

## Current Evidence

Retained first slice:

- Browser worker realtime now treats `requiresPull=true` and `droppedCount > 0`
  as authoritative recovery metadata. If a websocket sync event includes inline
  changes but also says recovery is required, the worker runs HTTP pull and does
  not apply the inline changes.
- Correctness gates passed:
  `bun test rust/bindings/browser/src/worker-realtime.test.ts`,
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`,
  and `bun run --cwd rust/bindings/browser tsgo`.
- Browser release E2E gate:
  `bun run --cwd rust/bindings/browser benchmark:browser:e2e -- --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --output=.context/benchmarks/wp04-realtime-requires-pull.json`.
- Result: `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`, `rust_realtime_live_ms=70.19`,
  `rust_realtime_live_p95_ms=71.7`.
- Decision: retained. The normal binary websocket fast path stayed active, and
  recovery-marked payloads no longer bypass pull recovery.

## Next Action

Unify websocket delta verification with the same stable event/root semantics
used by pull recovery.
