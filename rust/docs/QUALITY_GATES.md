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

```bash
cd /Users/bkniffler/GitHub/sync/offline-sync-bench

bun run --cwd /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser build:wasm

SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis \
  docker compose -f stacks/syncular/docker-compose.yml up --build -d

export SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1
export SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist
export SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis

bun run bench:run -- --stack syncular --scenario bootstrap
bun run bench:run -- --stack syncular-rust --scenario bootstrap

bun run bench:run -- --stack syncular --scenario local-query
bun run bench:run -- --stack syncular-rust --scenario local-query

bun run bench:run -- --stack syncular --scenario online-propagation
bun run bench:run -- --stack syncular-rust --scenario online-propagation

bun run bench:run -- --stack syncular --scenario reconnect-storm
bun run bench:run -- --stack syncular-rust --scenario reconnect-storm
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
