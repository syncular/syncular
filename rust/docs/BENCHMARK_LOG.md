# Rust Client Benchmark Log

Append benchmark evidence here whenever performance-sensitive work is retained
or rejected.

## Entry Template

```text
Date:
Commit:
Work package:
Machine / power mode:
Command:
Previous accepted:
Candidate:
Delta:
Decision:
Notes:
```

## 2026-05-19 - Wire Commit Root Verification

Commit: `ab142e5f`

Work package: [`WP-01 Protocol Integrity`](work-packages/WP-01-protocol-integrity.md)

Command:

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

Previous accepted ranges:

- sparse scoped guard: about `2.2-2.7ms`
- dense build: about `33.9-36.5ms`
- dense binary encode: about `37.8-41.6ms`
- dense generated encode: about `36.1-43.4ms`

Candidate runs:

- Run 1:
  - scoped fanout 5000/20: `3.2ms`
  - dense build 5000/500: `41.6ms`
  - dense binary encode: `45.2ms`
  - dense generated binary encode: `46.9ms`
  - response bytes: `2535.6KiB`
- Run 2:
  - scoped fanout 5000/20: `3.4ms`
  - dense build 5000/500: `43.7ms`
  - dense binary encode: `43.0ms`
  - dense generated binary encode: `44.5ms`
  - response bytes: `2535.6KiB`

Decision:

- Retained because this is correctness work.
- Follow-up required: reduce overhead by moving integrity metadata to
  page/subscription-level roots, compacting binary root metadata, and avoiding
  canonical JSON allocation on hot paths.

## 2026-05-19 - Subscription-Level Pull Integrity

Commit: uncommitted working tree before this slice was committed

Work package: [`WP-01 Protocol Integrity`](work-packages/WP-01-protocol-integrity.md)

Machine / power mode: Apple M3 Max, normal power.

Command:

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

Previous accepted:

- scoped fanout 5000/20: `3.2-3.4ms`
- dense build 5000/500: `41.6-43.7ms`
- dense binary encode: `43.0-45.2ms`
- dense generated binary encode: `44.5-46.9ms`
- dense binary response bytes: `2535.6KiB`

Candidate:

- scoped fanout 5000/20: `3.2ms`
- dense build 5000/500: `39.4ms`
- dense binary encode: `42.2ms`
- dense generated binary encode: `42.4ms`
- dense binary response bytes: `1419.1KiB`
- sync-pack 50k binary response bytes: `9478.3KiB`
- sync-pack 50k generated binary response bytes: `5104.5KiB`

Delta:

- Dense response bytes: `2535.6KiB -> 1419.1KiB` (`-44.0%`).
- Dense build: `41.6-43.7ms -> 39.4ms`.
- Dense binary encode: `43.0-45.2ms -> 42.2ms`.
- Dense generated encode: `44.5-46.9ms -> 42.4ms`.

External app-style bootstrap after rebuilding the branch server and Rust WASM:

- TS bootstrap 500k: `3730.62ms`; pull request `1123.72ms`; local apply
  `1978.08ms`; response bytes `3652743`; peak memory `462.69MB`.
- Rust bootstrap 500k: `6354.51ms`; pull request `1089ms`; local apply
  `1840ms`; response bytes `3303205`; peak memory `681.2MB`;
  derived schema `3210.75ms`.
- Current Rust vs TS: Rust is `1.70x` slower overall at 500k, but local apply
  is now faster in this run; the remaining measured gap is dominated by
  benchmark-side derived schema time and higher memory.

External local-query after the same rebuild:

- TS list/search/aggregate p50: `0.11ms` / `0.07ms` / `5.36ms`.
- Rust list/search/read-model aggregate p50: `0.51ms` / `0.80ms` / `0.07ms`.
- Rust raw aggregate p50: `59.7ms`.

External online-propagation:

- TS failed with the known snapshot chunk integrity mismatch.
- Rust failed because the external benchmark adapter still calls the removed
  `applyLocalOperationJson` compatibility alias. This is an external harness
  update, not a retained Syncular fallback.

Decision:

- Retained. The change removes per-commit integrity metadata from the current
  binary pack, keeps Rust root verification/persistence, and materially reduces
  dense incremental wire bytes without a measured regression in the targeted
  gate.
- Follow-up: update the external app-style Rust adapter to the current
  `applyMutationJson` API before using online-propagation/reconnect numbers.
