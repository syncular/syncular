# Rust Client Quality Gates

Run the smallest gate that proves the change. Performance-sensitive changes
also require a before/after comparison in [`BENCHMARK_LOG.md`](BENCHMARK_LOG.md).

## Gate Selection

- Protocol, sync-pack, snapshot, websocket message, or verification changes:
  run the protocol / wire-format gate.
- Runtime, native worker, store, conflict, blob, CRDT, or event changes:
  run the runtime / native store gate.
- Browser Worker, Kysely, WASM, package-size, or browser-owned SQLite changes:
  run the browser / WASM gate and the relevant browser E2E benchmark.
- Server pull, push, snapshot, scope, fanout, or integrity changes:
  run TypeScript package checks plus targeted server perf when performance is
  relevant.
- Generator or generated-client changes:
  run generator checks and at least one generated example/smoke that exercises
  the changed output.

## Protocol / Wire Format

```bash
bun test packages/core/src/__tests__/protocol-fixtures.test.ts packages/core/src/__tests__/sync-packs.test.ts packages/server/src/commit-integrity.test.ts
```

```bash
cargo test --manifest-path rust/Cargo.toml -p syncular-protocol
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract --features native,crdt-yjs,demo-todo-native-fixture
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures --features native,crdt-yjs,demo-todo-native-fixture
```

## Runtime / Native Store

```bash
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends --features native,crdt-yjs,demo-todo-native-fixture
cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs
```

## Rust-First Conformance

Use this as the repeatable fast app-facing conformance gate when touching the
testkit, runtime protocol/blob/CRDT behavior, generated Rust app API, or browser
generated-app contract.

```bash
bun run rust:conformance:fast
```

Use the heavier lanes when the affected surface needs production-shaped
browser/Hono sync or native binding proof.

```bash
bun run rust:conformance
bun run rust:conformance:native
```

## Browser / WASM

```bash
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
  cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features web-owned-sqlite \
  --target wasm32-unknown-unknown
```

```bash
bun run --cwd rust/bindings/browser build:wasm
```

## TypeScript Packages

```bash
bun run --cwd packages/core tsgo
bun run --cwd packages/server tsgo
bun run --cwd packages/server-dialect-sqlite tsgo
bun run --cwd packages/server-dialect-postgres tsgo
```

## Browser E2E Performance Guardrails

Use release WASM for retained decisions.

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --baseline=.context/benchmarks/browser-e2e-100k-baseline.json \
  --fail-on-regression
```

For scoped snapshot artifact work, run the artifact lane beside the row-chunk
lane and compare the generated reports:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=100000 --query-iterations=0 --wasm-profile=release \
  --output=.context/benchmarks/browser-e2e-100k-rowchunks.json
```

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=100000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts \
  --output=.context/benchmarks/browser-e2e-100k-sqlite-artifacts.json
```

For artifact page-size experiments, pass the row-limit explicitly and require
the report to show both the intended and observed request shape:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts \
  --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/browser-e2e-500k-sqlite-artifacts-50k.json
```

Keep a page-size change only if `benchmark_rust_observed_limit_snapshot_rows`
matches the requested limit, `benchmark_rust_observed_snapshot_artifacts=1`,
`rust_snapshot_chunk_binary_count=0`, and the retained run beats the previous
compact artifact baseline. The 100k probe on May 19, 2026 failed this gate by
falling back to `10` binary chunks.

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 \
  --baseline=.context/benchmarks/browser-e2e-incremental-realtime-baseline.json \
  --fail-on-regression
```

```bash
SYNCULAR_BROWSER_PERF_ROWS=500000 \
  bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --query-iterations=0 \
  --baseline=.context/benchmarks/browser-e2e-500k-baseline.json \
  --fail-on-regression
```

Run these from the repo root.

## Targeted Server Perf

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

## External App-Style Benchmark

Use for changes expected to affect real bootstrap, local query,
online-propagation, or reconnect behavior.

For the normal row-chunk baseline, set
`SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=0`; the external compose file may
default it on. For scoped artifact work, set it to `1` for both server startup
and benchmark runs. With the current external Rust harness
`limitSnapshotRows=20000` and the browser direct-artifact cap of `2` pages per
pull, the accepted baseline uses
`SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=40000`. Artifact lookup now
selects the largest scoped artifact whose row limit fits the pull capacity, so
smaller precomputed pages must stay on the artifact path instead of falling
back to row chunks.

```bash
cd /Users/bkniffler/GitHub/sync/offline-sync-bench

cargo run --manifest-path /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/Cargo.toml \
  -p syncular-codegen -- \
  --manifest-dir /Users/bkniffler/GitHub/sync/offline-sync-bench/stacks/syncular/syncular-app \
  --rust-output-dir /Users/bkniffler/GitHub/sync/offline-sync-bench/.tmp/syncular-bench-codegen/rust

bun run --cwd /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser build:wasm

SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis \
SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=0 \
  docker compose -f stacks/syncular/docker-compose.yml up --build -d

export SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1
export SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist
export SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=0

bun run bench:run -- --stack syncular --scenario bootstrap
bun run bench:run -- --stack syncular-rust --scenario bootstrap

bun run bench:run -- --stack syncular --scenario local-query
bun run bench:run -- --stack syncular-rust --scenario local-query

bun run bench:run -- --stack syncular --scenario online-propagation
bun run bench:run -- --stack syncular-rust --scenario online-propagation

bun run bench:run -- --stack syncular --scenario reconnect-storm
bun run bench:run -- --stack syncular-rust --scenario reconnect-storm
```

For the current scoped artifact lane, use the same commands but set both env
vars before server startup and benchmark execution:

```bash
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=1
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=40000
```

Results land in `.results/<runId>/<stack>/<scenario>.json`.

## Commit Checklist

- Change checked against `rust/docs/CLIENT_PRODUCT_CONTRACT.md`.
- `rust/docs/COMPATIBILITY_REGISTER.md` updated when a fallback, alias, old
  protocol path, or legacy behavior is added, retained, removed, or
  reclassified.
- Relevant commands selected from this file.
- Roadmap updated if priority/status changed.
- Work package updated.
- Benchmark log updated for perf work.
- Tests and benchmarks listed in the commit message or final handoff.
- No compatibility fallback branches added unless explicitly requested.
