# Syncular Testing Plan

## Goals
- Prevent correctness regressions across reconnect, rebootstrap, and maintenance churn.
- Catch data-leak and authorization regressions before GA.
- Detect latency/throughput regressions with deterministic CI gates.

## Scope
- Functional integration coverage for push/pull, subscriptions, relay/direct parity, realtime wakeups, maintenance races, and E2EE.
- Performance coverage for bootstrap, incremental pull, reconnect catchup, and maintenance operations.
- Load/stress coverage for reconnect storms, bootstrap storms, and mixed traffic under maintenance.

## Current Baseline (Implemented)
- Reconnect with push ACK loss idempotency.
- Reconnect stale-scope revocation and no-leak guarantees.
- Reconnect storm with repeated auth identity/scope changes and revocation checks.
- Rebootstrap after prune + compaction in one window.
- Cursor monotonicity under reconnect storms.
- WS/direct/relay transport parity for push/pull conflict outcomes and final state.
- Subscription reshape stress loop (add/remove/narrow/expand) under active writes.
- Partition isolation under high churn + reconnect + maintenance.
- Maintenance churn while prune/compact run concurrently.
- Snapshot chunk fault matrix: missing, 500, truncated, checksum mismatch, expired, unauthorized.
- Outbox restart durability for pending and stale in-flight (`sending`) commits.
- Retry/backoff correctness for 429/503 across pull/push/chunk fetch paths.
- Perf benchmarks: bootstrap 1k/10k, push single/batch, incremental pull, reconnect catchup, reconnect storm, forced rebootstrap.

## High-Value Functional Tests (Remaining + Expanded)
- `P0` Relay duplicate/out-of-order notification delivery invariance with concurrent pull calls and stale response arrival.
- `P0` Outbox durability across restart for failed-commit remediation path (failed -> user fix -> pending -> acked), exactly-once semantics.
- `P1` Maintenance race matrix: prune/compact while high-volume push/pull runs; assert no deadlocks and deterministic fallback.
- `P1` E2EE offline writes + key rotation + reconnect for authorized and unauthorized key sets.
- `P2` Process crash simulation around outbox state transitions beyond stale-send recovery (for example: failed commit recovery workflow).

## Where Tests Live
- Feature scenarios: `tests/integration/scenarios/*`.
- Feature runner: `tests/integration/__tests__/features.test.ts`.
- Matrix runner: `tests/integration/__tests__/matrix.test.ts`.
- Realtime/server bridge: `packages/server-hono/src/__tests__/realtime-bridge.test.ts`.
- Client realtime integration: `packages/client-react/src/__tests__/integration/realtime-sync.test.ts`.
- Core pull/outbox correctness: `packages/client/src/*.test.ts`.

## Performance Regression Plan

### PR-fast Benchmarks (must run on PR)
- `bootstrap_1k`
- `push_single_row`
- `push_batch_100`
- `incremental_pull`
- `reconnect_catchup`
- `maintenance_prune`

### Nightly / Scheduled Benchmarks
- `bootstrap_10k`
- forced rebootstrap after prune under larger datasets
- reconnect storm latency and convergence
- bootstrap storm (many concurrent bootstrapping clients)
- mixed push/pull workload with maintenance enabled
- transport lane comparison (direct vs relay vs realtime-triggered catchup)

### Metrics to Record per Run
- p50/p95/p99 latency per benchmark
- throughput ops/sec where applicable
- error rate
- memory (RSS + heap delta)
- DB query count/time (where instrumentation is available)

### Regression Gating
- Keep strict thresholds on low-noise microbenches.
- Use softer thresholds for noisy macrobenches.
- Store JSON artifacts per commit and compare against rolling baseline.
- Fail strict perf gate on confirmed regressions; soft-fail when baseline is missing.
- Promote nightly metrics into baseline after verification.

## Load/Stress Plan
- Extend `tests/load/scripts` with:
  - reconnect storm scenario
  - bootstrap storm scenario
  - mixed maintenance traffic scenario (prune/compact while load runs)
- Keep smoke profiles for PR sanity checks.
- Run high-volume profiles nightly and archive raw outputs.

## CI Wiring
- PR jobs:
  - core unit + integration features + matrix quick set
  - PR-fast perf benchmarks with gates
- Nightly jobs:
  - full integration matrix
  - load scenarios
  - macro perf workloads
  - artifact upload and trend report generation

## Launch Exit Criteria
- No `P0` gaps open.
- All PR-fast benchmarks within thresholds for 7 consecutive days.
- Nightly macro runs stable (no untriaged regressions) for 5 consecutive days.
- Documented playbook for perf regression triage and rollback.
