# WP-18 Production Hardening And Limits

Status: `[ ]` planned

## Goal

Define and enforce operational limits before real apps discover them through
slow sync, memory growth, unbounded queues, or unclear failures.

## Scope

- Maximum subscriptions per client.
- Maximum scopes per subscription and scope-values-per-client guidance.
- Maximum outbox size and queued mutation payload size.
- Snapshot, artifact, chunk, websocket frame, and pull response size limits.
- Blob, CRDT update, checkpoint, and upload queue limits.
- Bounded diagnostic buffers and payload snapshots.
- Clear limit errors and console visibility.
- Stress tests for configured limits.

## Non-Scope

- Optimizing for full-partition visibility.
- Silent degradation or hidden fallback paths when limits are exceeded.
- Product claims that the system supports unbounded row-level scopes or
  unlimited realtime fanout without explicit benchmarks.

## Acceptance Criteria

- Public limits are documented and configurable where appropriate.
- Limit failures emit WP-15 stable errors and WP-13 diagnostics.
- Console surfaces show limit pressure for clients, subscriptions, queues,
  artifacts, blobs, and CRDT streams.
- Stress tests cover at least subscription count, scope count, outbox growth,
  artifact/chunk size, websocket overflow, and diagnostic buffer bounds.
- Performance-sensitive limits have benchmark evidence in `BENCHMARK_LOG.md`.

## Required Gates

- Runtime/native store tests for queue and buffer limits.
- Browser worker tests for websocket, diagnostic, and storage limits.
- Server route tests for push, pull, artifact, blob, and console limit handling.
- Targeted server perf and browser E2E benchmarks for hot-path limit changes.

## Accept / Reject Rule

- Retain hardening changes that fail clearly before unsafe memory, storage, or
  protocol behavior.
- Reject hidden retries or fallbacks that mask limit pressure.
- Reject default limits that contradict scoped/subscription-shaped access.

## Current Evidence

Existing docs already call out row-level scopes and thousands of scope values
as stress cases needing explicit design and benchmarks. Artifact and realtime
work also introduced size, cache, and overflow-sensitive paths that need
product-level limits.

## Next Action

Inventory current implicit limits across server pull/push, browser worker,
runtime queues, artifacts, blobs, CRDT streams, and diagnostics; then document
the first explicit limit set.
