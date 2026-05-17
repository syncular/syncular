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
bun run test:perf:rust
bun run test:perf:rust:stable
```

Useful knobs:

```bash
PERF_STABLE_RUNS=7 bun --cwd tests/perf stable-ci
bun run test:perf:rust:stable
PERF_RUST_ONLY=true PERF_STABLE_RUNS=5 bun --cwd tests/perf stable-ci
PERF_STABLE_OUTPUT_JSON=.tmp/perf-summary.json bun --cwd tests/perf stable-ci
PERF_TREND_CURRENT_PATH=.tmp/perf-summary.json PERF_TREND_HISTORY_DIR=perf-history bun --cwd tests/perf trend-ci
```

`stable-ci` emits suite-neutral gate markers:

- `PERF_GATE_REGRESSION=true|false`
- `PERF_GATE_MISSING_BASELINE=true|false`

The legacy `PERF_GATE_SYNC_*` markers are still printed as compatibility
aliases. Summary JSON includes a `suite` field per metric (`sync`,
`rust-native`, `rust-e2e`, `rust-http`, `rust-ws`, `rust-browser`, or `dialect`) so CI
summaries make ownership obvious.

## Rust Client Metrics

The stable perf lane also runs `tests/perf/rust-client.perf.test.ts`, which
tracks the Rust-first client alongside the existing TypeScript sync metrics.

Tracked PR-safe metrics:

- `rust_native_open_client`: native Rust client open plus in-memory SQLite migration/schema setup.
- `rust_native_insert_batch_100`: generated Rust mutations inserting 100 task rows in one local commit.
- `rust_native_update_batch_100`: generated Rust mutations updating 100 task rows in one local commit.
- `rust_native_list_tasks_json_400`: Rust-owned SQLite app-row JSON read over a 400-row local table.
- `rust_native_crdt_text_updates_100`: 100 server-merge CRDT text updates through the native client.
- `rust_e2e_push_batch_100`: Rust client local outbox pushed to the Rust stateful test server.
- `rust_e2e_pull_catchup_100`: Rust client catches up from rows committed on the Rust stateful test server.
- `rust_e2e_client_to_client_catchup_100`: Rust writer client pushes to the Rust stateful test server, then a Rust reader client pulls the batch.
- `rust_http_push_batch_100`: Rust client local outbox pushed over the production HTTP transport to a deterministic Rust stateful server.
- `rust_http_pull_catchup_100`: Rust client catches up over the production HTTP transport from rows committed on the deterministic Rust stateful server.
- `rust_http_client_to_client_catchup_100`: Rust writer client pushes over HTTP, then a Rust reader client pulls over HTTP.
- `rust_ws_push_batch_100`: Rust client local outbox pushed over the production native WebSocket realtime transport, followed by the Rust client's normal HTTP pull phase.
- `rust_ws_client_to_client_catchup_100`: Rust writer client pushes over WebSocket, then a Rust reader client pulls over HTTP.
- `rust_browser_wasm_raw_kib` and `rust_browser_wasm_gzip_kib`: browser Rust WASM size, expressed in KiB so it can use the same baseline machinery.

Nightly-only browser latency metrics can be enabled with
`PERF_RUST_BROWSER_BENCHMARK=true`:

- `rust_browser_local_mutations_indexeddb_50`: Rust-owned browser SQLite local mutation batches with IndexedDB storage.
- `rust_browser_local_mutations_opfs_worker_50`: Rust-owned browser SQLite local mutation batches through the OPFS worker path.

The TS-vs-Rust browser E2E scoreboard can be included in the Rust perf lane
with `PERF_RUST_BROWSER_E2E_SCOREBOARD=true`:

- `rust_browser_e2e_ts_bootstrap_ms` and `rust_browser_e2e_rust_bootstrap_ms`.
- Rust sync buckets such as `rust_browser_e2e_rust_pull_request_ms`,
  `rust_browser_e2e_rust_snapshot_fetch_ms`, and
  `rust_browser_e2e_rust_pull_apply_ms`.
- TS/Rust local list, search, and aggregate p50/p95 metrics.
- Request/response bytes are emitted as KiB metrics.

Run only the Rust client perf slice from repo root:

```bash
bun run test:perf:rust
```

Run the Rust HTTP, WebSocket, and long-lived realtime stress slice separately
from the regression gate:

```bash
bun run test:perf:rust:stress
```

The stress slice drives multiple Rust writer clients through the production
HTTP transport and native WebSocket realtime transport into a deterministic
Rust stateful server. It also keeps reader WebSocket connections open, consumes
server `sync` wakeups, pulls from those wakeups, and asserts that every reader
converges to the server row count. It prints push, pull, wakeup catchup, and
full client-server-client timings, but does not compare against `baseline.json`.

Useful knobs:

```bash
PERF_RUST_NATIVE_OPERATIONS=200 PERF_RUST_NATIVE_ROUNDS=7 bun run test:perf:rust
PERF_RUST_BROWSER_BENCHMARK=true PERF_RUST_BROWSER_OPERATIONS=50 PERF_RUST_BROWSER_ROUNDS=3 bun run test:perf:rust
PERF_RUST_BROWSER_E2E_SCOREBOARD=true PERF_RUST_BROWSER_E2E_ROWS=1000 PERF_RUST_BROWSER_E2E_QUERY_ITERATIONS=10 bun run test:perf:rust
PERF_RUST_STRESS_WRITERS=4 PERF_RUST_STRESS_READERS=4 PERF_RUST_STRESS_BATCHES=20 PERF_RUST_STRESS_BATCH_SIZE=250 bun run test:perf:rust:stress
PERF_RUST_STRESS_TRANSPORT=ws bun run test:perf:rust:stress
PERF_RUST_STRESS_REALTIME=false bun run test:perf:rust:stress
```

The browser Rust benchmark uses the worker runtime by default. To include the
old direct IndexedDB Rust-owned storage diagnostic in the standalone benchmark,
run `bun --cwd rust/bindings/browser run benchmark:browser --include-direct-rust`.

Run the browser E2E TS-vs-Rust scoreboard for bootstrap and local-query
comparisons:

```bash
bun --cwd rust/bindings/browser run benchmark:browser:e2e --rows=100000 --query-iterations=25 --wasm-profile=release
SYNCULAR_BROWSER_PERF_ROWS=500000 bun --cwd rust/bindings/browser run benchmark:browser:e2e --query-iterations=25 --wasm-profile=release
```

This scoreboard seeds a same-origin sync server, runs Chromium against the
release WASM browser runtime, and emits TS/Rust bootstrap, Rust transport/apply
buckets, payload/chunk counts, and local list/search/aggregate p50/p95 metrics.

Operation counts are part of the metric name. For example,
`PERF_RUST_NATIVE_OPERATIONS=200` emits `rust_native_insert_batch_200`, which
will require its own baseline instead of being compared against the default
`_100` metric.

The Rust native runner lives at `syncular-rust-perf` in
`rust/crates/client`. It emits JSON so future native, Swift/Kotlin/JVM, or
browser runtime workloads can be added without changing the aggregation format.

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
- Check the `suite` column before routing: `rust-native`, `rust-e2e`,
  `rust-http`, `rust-ws`, and `rust-browser` belong to the Rust client lane, while `sync`
  covers the TypeScript sync perf suite.

4. Reproduce locally in stable mode.
- Run `PERF_STABLE_RUNS=7 bun --cwd tests/perf stable-ci`.
- If needed, run on an idle machine and repeat once.

5. Map metric to likely subsystem.
- `bootstrap_*`: snapshot/chunk encode/decode, bootstrap query paths.
- `push_*`: push validation, write path, conflict handling.
- `incremental_pull`: pull query path, cursor filtering, payload shape.
- `reconnect_*`: reconnect logic, realtime wakeups, catchup pull path.
- `pglite_push_contention`: concurrent commit insertion/write-path contention on postgres/pglite lanes.
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
4. Confirm provenance metadata is populated (`commit`, `source`, `environment`) for each updated metric.
5. In commit/PR description, include:
- reason for baseline change
- before/after values for affected metrics
- links to CI run artifacts

## Fast Decision Matrix

- Single noisy metric, no local repro: re-run, do not update baseline.
- Multiple metrics regress, local repro confirmed: block/revert/fix.
- Intentional architecture change with stable new numbers: update baseline with rationale.
- Nightly change-point only, PR lane clean: monitor next nightly, then triage if repeated.
