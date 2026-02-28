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
- Relay duplicate/out-of-order delivery handling with concurrent stale/fresh pull responses.
- Subscription reshape stress loop (add/remove/narrow/expand) under active writes.
- Partition isolation under high churn + reconnect + maintenance.
- Maintenance churn while prune/compact run concurrently.
- Maintenance race matrix across aggressive/moderate prune windows under concurrent push/pull.
- Snapshot chunk fault matrix: missing, 500, truncated, checksum mismatch, expired, unauthorized.
- Outbox restart durability for pending and stale in-flight (`sending`) commits.
- Outbox failed-commit remediation path across restart with exact-once replay after ACK loss.
- Outbox mixed-state crash recovery for pending/sending/failed replay semantics.
- E2EE offline writes + key rotation + reconnect across authorized and unauthorized keysets.
- Retry/backoff correctness for 429/503 across pull/push/chunk fetch paths.
- Perf benchmarks: bootstrap 1k/10k, push single/batch, incremental pull, reconnect catchup, reconnect storm, forced rebootstrap.

## High-Value Functional Tests (Remaining + Expanded)
- No open `P0`/`P1`/`P2` functional gaps from this plan.

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
  - stable perf lane with 5-run median-of-medians and artifact upload
  - consecutive-run perf regression gate (hard fail on PR only)
- Nightly jobs:
  - full integration matrix
  - macro load scenarios (`push-pull`, `reconnect-storm`, `bootstrap-storm`, `maintenance-churn`, `mixed-workload`)
  - stable perf lane with 7 runs (artifact + summary)
  - historical trend/change-point analysis against prior nightly artifacts

## Launch Exit Criteria
- No `P0` gaps open.
- All PR-fast benchmarks within thresholds for 7 consecutive days.
- Nightly macro runs stable (no untriaged regressions) for 5 consecutive days.
- Documented playbook for perf regression triage and rollback.
