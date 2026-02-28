# Performance Regression Playbook

This folder contains Syncular's performance regression tooling and baseline data.

Use this playbook when CI flags a perf regression, when nightly trend analysis reports a change-point, or before intentionally updating perf baselines.

## CI Lanes

- `perf` job (PR/push/manual):
  - Runs `stable-ci` with `PERF_STABLE_RUNS=5`.
  - Uses median-of-medians aggregation.
  - Applies regression gates against [`baseline.json`](./baseline.json).
  - Uses "2 consecutive runs" logic for hard-fail on PRs.
- `perf-nightly` job (schedule/manual):
  - Runs `stable-ci` with `PERF_STABLE_RUNS=7`.
  - Fetches historical nightly summaries (`fetch-history.ts`).
  - Runs change-point detection (`trend-ci.ts`).
  - Publishes trend and summary artifacts.

## Local Commands

Run from repo root:

```bash
bun --cwd tests/perf stable-ci
bun --cwd tests/perf regression
bun --cwd tests/perf update-baseline
bun --cwd tests/perf fetch-history
bun --cwd tests/perf trend-ci
```

Useful knobs:

```bash
PERF_STABLE_RUNS=7 bun --cwd tests/perf stable-ci
PERF_STABLE_OUTPUT_JSON=.tmp/perf-summary.json bun --cwd tests/perf stable-ci
PERF_TREND_CURRENT_PATH=.tmp/perf-summary.json PERF_TREND_HISTORY_DIR=perf-history bun --cwd tests/perf trend-ci
```

## Triage Workflow

1. Confirm signal quality.
- Check whether this is first detection or a consecutive detection.
- For PR failures, inspect current and previous failing runs.
- If only push/manual warns, do not treat as blocking until repeated.

2. Download and inspect artifacts.
- `perf-results.txt` or `perf-nightly-results.txt`
- `perf-summary.json` or `perf-nightly-summary.json`
- `perf-nightly-trend.json`
- `perf-history/index.json` (nightly)

3. Identify which metric regressed.
- Capture baseline, aggregated median, delta %, and run min/max.
- Mark if regression is isolated to one metric or broad across metrics.

4. Reproduce locally in stable mode.
- Run `PERF_STABLE_RUNS=7 bun --cwd tests/perf stable-ci`.
- If needed, run on an idle machine and repeat once.

5. Map metric to likely subsystem.
- `bootstrap_*`: snapshot/chunk encode/decode, bootstrap query paths.
- `push_*`: push validation, write path, conflict handling.
- `incremental_pull`: pull query path, cursor filtering, payload shape.
- `reconnect_*`: reconnect logic, realtime wakeups, catchup pull path.
- `maintenance_*`: prune/compact interactions and maintenance locks.
- `transport_*`: transport stack differences (direct/relay/ws wakeups).

6. Choose action.
- Unintended slowdown: fix or revert.
- Intentional behavior change: update baseline with rationale.
- Infra noise only: re-run and keep baseline unchanged.

## Rollback and Mitigation Policy

When the regression is real and launch risk is non-trivial:

1. Revert offending change first.
- Reverting to known-good behavior is preferred over threshold tuning.

2. If immediate revert is not possible, mitigate blast radius.
- Reduce affected feature usage (for example high-cost path frequency).
- Prefer deterministic fallback behavior over degraded latency spikes.

3. Open follow-up issue with:
- regressed metrics and deltas
- first bad commit range
- hypothesis and owner
- recovery plan with ETA

4. Only update baseline when one of these is true:
- Improvement is intentional and validated.
- Regression is intentional, accepted, and documented with justification.

Never update baseline just to make CI green.

## Baseline Update Procedure

1. Verify current branch has the intended perf behavior.
2. Run:

```bash
bun --cwd tests/perf update-baseline
```

3. Review changed metric values in [`baseline.json`](./baseline.json).
4. In commit/PR description, include:
- reason for baseline change
- before/after values for affected metrics
- links to CI run artifacts

## Fast Decision Matrix

- Single noisy metric, no local repro: re-run, do not update baseline.
- Multiple metrics regress, local repro confirmed: block/revert/fix.
- Intentional architecture change with stable new numbers: update baseline with rationale.
- Nightly change-point only, PR lane clean: monitor next nightly, then triage if repeated.
