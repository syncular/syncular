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
  the changed output. Use `bun run rust:codegen:check` for the todo fixture so
  the typed app contract, generated `syncular.codegen.json` handoff, and Rust
  codegen output are checked together.

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

Use the app-shell lifecycle lane when native UI lifecycle behavior changes and
the local simulator/emulator toolchains are available:

```bash
bun run rust:native:lifecycle:ios
bun run rust:native:lifecycle:android
```

The same lane can be invoked through the conformance runner:

```bash
bash rust/scripts/run-conformance-gates.sh --native-app-shell
```

## Browser / WASM

```bash
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
  cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features web-owned-sqlite \
  --target wasm32-unknown-unknown
```

```bash
bun run --cwd rust/bindings/javascript build:wasm
```

## TypeScript Packages

```bash
bun run --cwd packages/core tsgo
bun run --cwd packages/server tsgo
bun run --cwd packages/server-dialect-sqlite tsgo
bun run --cwd packages/server-dialect-postgres tsgo
```

## Browser E2E Performance Guardrails

The legacy TypeScript-vs-Rust browser scoreboard was removed with the pure
TypeScript client. Use Rust browser conformance and WASM size gates for package
changes until the next Rust-only external benchmark harness is checked in.

```bash
bun run client:test
bun run javascript-bindings:build:wasm
bun run javascript-bindings:size
```

Performance-sensitive runtime changes still need before/after evidence in
[`BENCHMARK_LOG.md`](BENCHMARK_LOG.md), using either targeted Rust benches or
the external app-style benchmark below.

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

bun run --cwd /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/javascript build:wasm

SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis \
SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=0 \
  docker compose -f stacks/syncular/docker-compose.yml up --build -d

export SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1
export SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/javascript/dist
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
