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

The current overhead is documented in [`../BENCHMARK_LOG.md`](../BENCHMARK_LOG.md).

## Next Action

Move from per-commit integrity metadata toward page/subscription-level roots
plus compact binary metadata. Keep clear failure behavior and no compatibility
fallback branch.
