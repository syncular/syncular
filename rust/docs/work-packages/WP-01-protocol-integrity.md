# WP-01 Protocol Integrity

Status: `[~]` in progress

## Goal

Keep the verified sync/root correctness contract while removing avoidable
server and wire-format overhead from the current per-commit metadata shape.

## Why

Rust clients should reject corrupted or mismatched pull responses before local
SQLite apply and before cursor/root advancement. The first implementation does
that, but dense incremental pulls regressed because every commit now carries
large hex metadata and uses canonical JSON hashing in the hot path.

## Scope

- Pull integrity metadata.
- `binary-sync-pack-v1` metadata encoding.
- Rust native/browser verification.
- Persisted verified root handling.
- Server perf tests and browser/offline-sync benchmark gates.

## Acceptance Criteria

- Client still verifies the delivered subscription stream before apply.
- Bad digest/root responses fail before local rows are mutated.
- Latest verified root is persisted after successful apply.
- Integrity metadata is not repeated unnecessarily per delivered commit.
- Dense incremental perf moves back toward the pre-verification baseline, or
  any remaining regression is explicitly justified.

## Required Gates

- Protocol / wire format gate from [`../QUALITY_GATES.md`](../QUALITY_GATES.md).
- Targeted server perf gate.
- Browser E2E incremental/realtime gate.
- External app-style benchmark when the change touches pull/bootstrap behavior.

## Accept / Reject Rule

- Retain correctness-preserving verification changes even if they regress, but
  log the regression and immediately create a recovery next action.
- Retain performance recovery only if dense incremental build/encode moves
  toward the pre-verification baseline without weakening scoped verification.
- Revert protocol-shape complexity that does not improve overhead or
  correctness.

## Current Evidence

Latest retained correctness commit: `ec5adcfa`.

Latest perf note commit: `ab142e5f`.

Current working slice restored Hono pull forwarding for client-provided
`verifiedRoot`, so browser workers can keep root continuity across ordered
live-query refreshes instead of tripping a `previousChainRoot` mismatch.

Current working slice also moved pull integrity to subscription-level metadata
and advanced the binary sync-pack wire version to `13`. Per-commit
`partitionId` / `previousChainRoot` / `commitDigest` / `commitChainRoot`
metadata is no longer part of the current `SyncCommit` contract.

Targeted server perf moved in the intended direction:

- Dense binary response bytes: `2535.6KiB -> 1419.1KiB`.
- Dense build: `41.6-43.7ms -> 39.4ms`.
- Dense binary encode: `43.0-45.2ms -> 42.2ms`.

External app-style bootstrap completed after rebuilding the branch server:
Rust 500k bootstrap is `6354.51ms` versus TS `3730.62ms`; Rust local apply is
`1840ms` versus TS `1978.08ms`. The current Rust gap in that run is dominated
by `derived_schema_ms` (`3210.75ms`) and memory, not binary decode.

The current overhead is documented in [`../BENCHMARK_LOG.md`](../BENCHMARK_LOG.md).

## Next Action

Update the external offline-sync-bench Rust adapter to the current
`applyMutationJson` API so online-propagation and reconnect can be measured
again, then continue reducing canonical JSON allocation in the integrity hot
path.
