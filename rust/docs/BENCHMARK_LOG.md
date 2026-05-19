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
