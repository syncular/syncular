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

## 2026-05-19 - Rejected WP-03 Columnar JSON Import Probe

Commit: not retained

Work package: [`WP-03 Binary Apply Performance`](work-packages/WP-03-binary-apply-performance.md)

Machine / power mode: Apple M3 Max, normal power.

External app-style gate recovery:

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
```

Recovery note:

- OrbStack/Docker was wedged from stale benchmark state. `docker info`, Docker
  restart, and health checks hung until `orbctl stop && orbctl start` was run.
- After recovery, the syncular stack was rebuilt cleanly and health checks
  passed.

External baseline after recovery:

- TS 500k bootstrap: `3415.92ms`.
- Rust 500k bootstrap: `2382.23ms` (`0.70x` TS).
- TS 500k local apply: `1901.25ms`.
- Rust 500k local apply: `422ms` (`0.22x` TS).
- TS local list/search p50: `0.08ms` / `0.06ms`.
- Rust local list/search p50: `0.11ms` / `0.16ms`.
- TS aggregate p50: `5.25ms`.
- Rust read-model aggregate p50: `0.01ms`; raw SQL aggregate p50: `7.25ms`.

Immediate repo-local control after recovery:

```bash
SYNCULAR_BROWSER_PERF_ROWS=500000 \
  bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --query-iterations=0 \
  --baseline=.context/benchmarks/browser-e2e-500k-baseline.json \
  --fail-on-regression
```

- Control before probe: `rust_bootstrap_ms=625.06`,
  `rust_pull_apply_ms=356`, `rust_snapshot_chunk_apply_ms=308`,
  `rust_snapshot_chunk_bind_ms=179`, `rust_snapshot_chunk_step_ms=118`,
  `rust_cached_bootstrap_ms=338.5`,
  `rust_cached_snapshot_chunk_apply_ms=294`.

Rejected candidate:

- For cleared binary snapshot inserts, attempted a columnar JSON import path
  using one `json_each()` array per column instead of binding every cell.
- Candidate 500k browser gate failed to complete normally:
  `Syncular v2 worker request close timed out after 30000ms`.
- Source was reverted and release WASM rebuilt.

Restored repo-local result after revert:

- `rust_bootstrap_ms=625.3`, `rust_pull_apply_ms=356`,
  `rust_snapshot_chunk_apply_ms=310`, `rust_snapshot_chunk_bind_ms=174`,
  `rust_snapshot_chunk_step_ms=126`, `rust_cached_bootstrap_ms=337.54`,
  `rust_cached_snapshot_chunk_apply_ms=291`.

Decision:

- Rejected and reverted. SQLite `json_each()` import adds too much parse/query
  work and is not a viable canonical apply path.
- Do not revisit JSON import as the next WP-03 attempt. The next serious
  apply-path experiment needs either a length-aware native import extension or
  a narrowly scoped SQLite artifact prototype that respects per-user scopes.

## 2026-05-19 - Rejected WP-03 CARRAY Import Probe

Commit: not retained

Work package: [`WP-03 Binary Apply Performance`](work-packages/WP-03-binary-apply-performance.md)

Machine / power mode: Apple M3 Max, normal power.

Candidate:

- For cleared binary snapshot inserts, attempted a `carray()` import path using
  one bound array per column.
- Text and JSON columns used `SQLITE_CARRAY_BLOB` with `struct iovec` plus
  `CAST(value AS TEXT)`, so the design would have preserved byte lengths
  better than `CARRAY_TEXT`.
- Nullable columns used an optional `INT64` null-flag carray.

Compile gate:

```bash
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
  cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features web-owned-sqlite \
  --target wasm32-unknown-unknown
```

- Passed.

Release build:

```bash
bun run --cwd rust/bindings/browser build:wasm
```

- Passed.
- Raw WASM grew from `3.21MiB` to `3.22MiB`, still under budget.

Browser gate:

```bash
SYNCULAR_BROWSER_PERF_ROWS=500000 \
  bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --query-iterations=0 \
  --baseline=.context/benchmarks/browser-e2e-500k-baseline.json \
  --fail-on-regression
```

- Failed before producing metrics:
  `Failed to resolve module specifier "env". Relative references must start with either "/", "./", or "../".`
- The failure appears when `sqlite3_carray_bind` is referenced from the WASM
  runtime, so this is not a retainable path in the current browser package.
- Root cause: `sqlite-wasm-rs` bindgen exposes the `sqlite3_carray_bind`
  declaration from SQLite headers, but its compiled SQLite feature flags do not
  include `SQLITE_ENABLE_CARRAY`, so the implementation is omitted and the
  symbol becomes an unresolved WASM import.

Decision:

- Rejected and reverted.
- Do not rely on direct `sqlite3_carray_bind` from the current browser runtime.
  A future carray-like approach would need to live behind a purpose-built
  runtime/import extension that does not introduce unresolved JS/WASM imports.

## 2026-05-19 - Rejected WP-03 Virtual Table Import Probe

Commit: not retained

Work package: [`WP-03 Binary Apply Performance`](work-packages/WP-03-binary-apply-performance.md)

Machine / power mode: Apple M3 Max, normal power.

Candidate:

- Registered an internal Rust-backed SQLite virtual table inside the browser
  WASM runtime.
- For cleared binary snapshot inserts, loaded each binary snapshot batch into
  borrowed row views and executed `INSERT INTO app_table SELECT c0, c1, ... FROM
  temp.syncular_snapshot_import`.
- This avoided per-cell `sqlite3_bind_*` calls and avoided JSON parsing, but
  shifted the hot path to SQLite virtual-table callbacks back into Rust for
  every selected cell.

Compile/build gates:

```bash
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
  cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features web-owned-sqlite \
  --target wasm32-unknown-unknown
```

```bash
bun run --cwd rust/bindings/browser build:wasm
```

- Both passed.
- Raw WASM grew to `3.21MiB` with `36.9KiB` headroom.

Immediate restored control before probe:

- `rust_bootstrap_ms=625.3`, `rust_pull_apply_ms=356`,
  `rust_snapshot_chunk_apply_ms=310`, `rust_snapshot_chunk_bind_ms=174`,
  `rust_snapshot_chunk_step_ms=126`, `rust_cached_bootstrap_ms=337.54`,
  `rust_cached_snapshot_chunk_apply_ms=291`.

Candidate browser gate:

```bash
SYNCULAR_BROWSER_PERF_ROWS=500000 \
  bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --query-iterations=0 \
  --baseline=.context/benchmarks/browser-e2e-500k-baseline.json \
  --fail-on-regression
```

- `rust_bootstrap_ms=762.66`, `rust_pull_apply_ms=466`,
  `rust_snapshot_chunk_apply_ms=410`, `rust_snapshot_chunk_bind_ms=198`,
  `rust_snapshot_chunk_step_ms=199`, `rust_cached_bootstrap_ms=461.49`,
  `rust_cached_snapshot_chunk_apply_ms=403`.

Decision:

- Rejected and reverted. The virtual-table callback path was materially slower
  than the current multirow bind path and increased memory pressure.
- The result suggests reducing bind count via SQLite virtual-table callbacks is
  not enough; a future import path would need to run closer to SQLite's storage
  layer or import a scoped SQLite artifact directly.

## 2026-05-19 - Rejected WP-03 Browser Apply Probes

Commit: not retained

Work package: [`WP-03 Binary Apply Performance`](work-packages/WP-03-binary-apply-performance.md)

Machine / power mode: Apple M3 Max, normal power.

Command:

```bash
SYNCULAR_BROWSER_PERF_ROWS=500000 \
  bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --query-iterations=0 \
  --baseline=.context/benchmarks/browser-e2e-500k-baseline.json \
  --fail-on-regression
```

Immediate pre-change control band from this session:

- Run 1: `rust_bootstrap_ms=617.89`, `rust_pull_apply_ms=350`,
  `rust_snapshot_chunk_apply_ms=309`, `rust_snapshot_chunk_bind_ms=176`,
  `rust_snapshot_chunk_step_ms=124`, `rust_cached_bootstrap_ms=335.89`,
  `rust_cached_snapshot_chunk_apply_ms=291`.
- Run 2: `rust_bootstrap_ms=623.86`, `rust_pull_apply_ms=353`,
  `rust_snapshot_chunk_apply_ms=308`, `rust_snapshot_chunk_bind_ms=178`,
  `rust_snapshot_chunk_step_ms=122`, `rust_cached_bootstrap_ms=336.89`,
  `rust_cached_snapshot_chunk_apply_ms=293`.

Rejected candidates:

- Runtime/protocol raw visitor adapter bypass:
  `rust_bootstrap_ms=627.21`, `rust_pull_apply_ms=353`,
  `rust_snapshot_chunk_apply_ms=309`, `rust_snapshot_chunk_bind_ms=173`,
  `rust_cached_snapshot_chunk_apply_ms=288`.
- Smaller browser snapshot batch size (`2048 -> 1024`):
  `rust_bootstrap_ms=622.44`, `rust_pull_apply_ms=348`,
  `rust_snapshot_chunk_apply_ms=306`, `rust_snapshot_chunk_bind_ms=169`,
  `rust_cached_bootstrap_ms=345.38`,
  `rust_cached_snapshot_chunk_apply_ms=302`.
- Precomputed binary snapshot null masks:
  `rust_bootstrap_ms=632.59`, `rust_pull_apply_ms=364`,
  `rust_snapshot_chunk_apply_ms=320`, `rust_snapshot_chunk_bind_ms=186`,
  `rust_cached_snapshot_chunk_apply_ms=300`.
- Generated nullable-column elision for all-null snapshot columns:
  `rust_bootstrap_ms=624.96`, `rust_pull_apply_ms=353`,
  `rust_snapshot_chunk_apply_ms=307`, `rust_snapshot_chunk_bind_ms=173`,
  `rust_cached_bootstrap_ms=340.77`,
  `rust_cached_snapshot_chunk_apply_ms=295`.

Decision:

- All candidates were reverted. None improved the target bucket without a worse
  cached/total result.
- These results reinforce that the remaining browser local apply cost is not
  meaningfully improved by small decode-loop or prepared-statement tweaks.
  Next WP-03 work should be a larger architecture experiment, such as
  server-generated SQLite artifacts or a true import path, and it must start
  with the external app-style benchmark.

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

Commit: `f8558547`

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

## 2026-05-19 - Streaming Commit Integrity Payloads

Commit: `d68ebdfd`

Work package: [`WP-01 Protocol Integrity`](work-packages/WP-01-protocol-integrity.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Server commit integrity canonical JSON now writes directly to a string
  buffer instead of allocating a full canonical object graph.
- Rust wire commit/root verification now writes fixed canonical payloads
  directly and uses a shared canonical object writer for arbitrary row/scope
  values.
- External offline-sync-bench Rust adapter was updated outside this repo from
  the removed `applyLocalOperation` API to `applyMutation` so online/reconnect
  benches exercise the current API.

Targeted command:

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

Previous accepted:

- scoped fanout 5000/20: `3.2ms`
- dense build 5000/500: `39.4ms`
- dense binary encode: `42.2ms`
- dense generated binary encode: `42.4ms`
- dense binary response bytes: `1419.1KiB`

Candidate:

- Run 1 had a dense binary encode outlier (`48.4ms`) and was rerun.
- Run 2:
  - scoped fanout 5000/20: `3.3ms`
  - dense build 5000/500: `38.4ms`
  - dense binary encode: `42.7ms`
  - dense generated binary encode: `42.4ms`
  - dense binary response bytes: `1419.1KiB`

Delta:

- Dense build: `39.4ms -> 38.4ms`.
- Dense binary encode: `42.2ms -> 42.7ms` (effectively flat in this noisy gate).
- Dense generated binary encode: `42.4ms -> 42.4ms`.
- Wire bytes unchanged.

External app-style benchmark after rebuilding Rust WASM and branch server:

- TS bootstrap 500k: `3703.4ms`; pull request `1106.64ms`; local apply
  `1967.93ms`; response bytes `3652810`; peak memory `477.81MB`.
- Rust bootstrap 500k: `6084.08ms`; pull request `1036ms`; local apply
  `1736ms`; response bytes `3303063`; peak memory `685.66MB`;
  derived schema `3105.75ms`.
- Previous Rust bootstrap 500k: `6354.51ms`; pull request `1089ms`; local
  apply `1840ms`; peak memory `681.2MB`; derived schema `3210.75ms`.
- Current Rust vs TS: Rust is `1.64x` slower overall at 500k, but Rust pull
  request and local apply are faster in this run. The remaining gap is still
  dominated by benchmark-side derived schema time and memory.

External local-query after the same rebuild:

- TS list/search/aggregate p50: `0.09ms` / `0.07ms` / `5.14ms`.
- Rust list/search/read-model aggregate p50: `0.42ms` / `0.72ms` / `0.06ms`.
- Rust raw aggregate p50: `56.94ms`.
- Previous Rust list/search/read-model/raw aggregate p50:
  `0.51ms` / `0.80ms` / `0.07ms` / `59.7ms`.

External Rust realtime/reconnect after the same rebuild:

- Online propagation: write ack `9.34ms`, p50 `23.04ms`, p95 `44.33ms`.
- Previous online propagation: p50 `28.64ms`, p95 `40.01ms`.
- Reconnect convergence 25/100/250 clients:
  `151.21ms` / `231.3ms` / `2109.74ms`.
- Previous reconnect 25/100/250 clients:
  `127.88ms` / `249.4ms` / `2118.53ms`.

Decision:

- Retained. The targeted gate is flat-to-slightly-better, and the external
  Rust 500k bootstrap/local apply path improved without changing wire size or
  verification semantics.

## 2026-05-19 - Protocol Crate Binary Sync-Pack Decoder Extraction

Commit: `a4f2ac7a`

Work package: [`WP-02 Protocol Kernel`](work-packages/WP-02-protocol-kernel.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Moved the Rust binary sync-pack decoder/reader from runtime into
  `syncular-protocol`.
- Runtime now uses a thin adapter over the protocol decoder.
- No server encoder, browser apply, or wire bytes were intentionally changed.

Command:

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

Previous accepted:

- scoped fanout 5000/20: `3.3ms`
- dense build 5000/500: `38.4ms`
- dense binary encode: `42.7ms`
- dense generated binary encode: `42.4ms`
- dense binary response bytes: `1419.1KiB`

Candidate:

- scoped fanout 5000/20: `3.5ms`
- dense build 5000/500: `41.8ms`
- dense binary encode: `41.4ms`
- dense generated binary encode: `42.2ms`
- dense binary response bytes: `1419.1KiB`

Delta:

- Scoped fanout: `+0.2ms`.
- Dense build: `+3.4ms`, still within recent noise for this TS-side gate.
- Dense binary encode: `-1.3ms`.
- Dense generated binary encode: `-0.2ms`.
- Wire bytes unchanged.

Decision:

- Retained. This is protocol ownership work; the maintained perf sanity gate
  did not show a structural regression or byte growth.

## 2026-05-19 - Protocol Crate Binary Snapshot Decoder Extraction

Commit: `d68ebdfd`

Work package: [`WP-02 Protocol Kernel`](work-packages/WP-02-protocol-kernel.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Moved binary snapshot table/row/payload decoding into `syncular-protocol`.
- Runtime now keeps `SnapshotChunkRows` and SQLite visitor adapters, but the
  binary wire parser is protocol-owned.
- Binary sync-pack row groups now reuse the protocol binary snapshot decoder
  instead of carrying a second local row-group decoder.
- Added `wasm-opt --all-features` to release WASM packaging after the default
  size gate exposed raw-size drift.

Size gate:

- Before optimizer fix: release full WASM raw `3,417,217` bytes, `9.1KiB` over
  the `3.25MiB` budget.
- After optimizer fix: release full WASM raw `3,375,951` bytes, `31.2KiB`
  under budget; gzip `1.33MiB`, `19.6KiB` under budget.

Command:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --baseline=.context/benchmarks/browser-e2e-100k-baseline.json \
  --fail-on-regression
```

Previous accepted:

- Rust bootstrap: `138.04ms`
- Rust pull apply: `73ms`
- Rust snapshot chunk apply: `62ms`
- Rust snapshot chunk bind: `33ms`
- Rust served WASM bytes: `3,326,638`

Candidate:

- Rust bootstrap: `141.24ms`
- Rust pull apply: `74ms`
- Rust snapshot chunk apply: `65ms`
- Rust snapshot chunk bind: `37ms`
- Rust served WASM bytes: `3,375,951`

Delta:

- Rust bootstrap: `+3.2ms`, below the regression gate.
- Rust pull apply: `+1ms`.
- Rust snapshot chunk apply: `+3ms`.
- Rust snapshot chunk bind: `+4ms`.
- Rust served WASM bytes: `+49,313` bytes (`+1.48%`), below the regression
  gate and under the raw/gzip budgets.

Decision:

- Retained. The protocol extraction keeps the browser benchmark inside the
  accepted gate, and the release package now passes the raw/gzip size budget
  again.

## 2026-05-19 - Protocol Crate Integrity And Snapshot Manifest APIs

Commit: `2caf32c3`

Work package: [`WP-02 Protocol Kernel`](work-packages/WP-02-protocol-kernel.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Moved wire commit digest/root calculation, commit integrity metadata
  validation, subscription verified-root recomputation, snapshot manifest
  digesting, and snapshot manifest validation into `syncular-protocol`.
- Runtime keeps thin wrappers that convert `ProtocolError` into
  `SyncularError`, so existing runtime callers still get runtime error kinds.
- No server encoder, browser apply path, storage path, or wire bytes were
  intentionally changed.

Performance gate:

- Not run. This is a protocol ownership extraction with no hot-path browser or
  server implementation change. The retained proof is the protocol/wire-format
  gate plus runtime contract coverage.

Protocol gates:

- `bun test packages/core/src/__tests__/protocol-fixtures.test.ts packages/core/src/__tests__/sync-packs.test.ts packages/server/src/commit-integrity.test.ts`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`

Decision:

- Retained. Protocol ownership moved without adding compatibility branches or
  changing the runtime application/store behavior.

## 2026-05-19 - Protocol Crate Blob Wire APIs

Commit: `d9391567`

Work package: [`WP-02 Protocol Kernel`](work-packages/WP-02-protocol-kernel.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Moved blob wire structs and blob hash/validation helpers into
  `syncular-protocol`.
- Runtime still owns file/reader hashing, upload/download transport, queued
  blob work, local cache behavior, and store integration.
- Runtime wrappers preserve `SyncularError` conversion for validation calls.

Performance gate:

- Not run. This is a protocol ownership extraction with no browser/server hot
  path or wire-byte change.

Protocol/runtime gates:

- `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test blob_transport --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`

Decision:

- Retained. Blob protocol ownership moved without changing runtime transport or
  storage behavior.

## 2026-05-19 - Protocol Crate Realtime Wire Shapes

Commit: `1a639b37`

Work package: [`WP-02 Protocol Kernel`](work-packages/WP-02-protocol-kernel.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Moved realtime presence payload structs and websocket push/presence message
  shapes into `syncular-protocol`.
- Native websocket push/presence and browser websocket push now serialize via
  shared protocol structs.
- Runtime still owns websocket sockets, reconnect/backoff, event fanout,
  runtime `RealtimeEvent`, and transport behavior.

Performance/size gate:

- No runtime performance benchmark was run because this is protocol ownership
  work without a hot-path algorithm change.
- Browser WASM build was run because browser transport code changed.

Previous accepted package size:

- Release full WASM raw: `3,375,951` bytes.

Candidate:

- Release full WASM raw: `3,365,458` bytes.
- Size report: raw `3.21MiB`, `41.4KiB` under budget; gzip `1.33MiB`,
  `24.1KiB` under budget.

Decision:

- Retained. The protocol split removed duplicated JSON assembly and stayed
  under browser package budgets.

## 2026-05-19 - Protocol Crate Snapshot Chunk Validation

Commit: `e4f6bb63`

Work package: [`WP-02 Protocol Kernel`](work-packages/WP-02-protocol-kernel.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Moved snapshot chunk format/hash validation into `syncular-protocol`.
- Native and browser transports now call shared protocol validation while still
  owning HTTP fetch, gzip decompression, row decoding dispatch, timing, and
  store application.

Browser scoreboard:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --baseline=.context/benchmarks/browser-e2e-100k-baseline.json \
  --fail-on-regression
```

Previous accepted:

- Rust bootstrap: `138.04ms`
- Rust pull apply: `73ms`
- Rust snapshot chunk apply: `62ms`
- Rust snapshot chunk bind: `33ms`
- Rust served WASM bytes: `3,326,638`

Candidate:

- Rust bootstrap: `140.9ms`
- Rust pull apply: `74ms`
- Rust snapshot chunk apply: `64ms`
- Rust snapshot chunk bind: `36ms`
- Rust served WASM bytes: `3,362,390`

Delta:

- Rust bootstrap: `+2.87ms`, below the regression gate.
- Rust pull apply: `+1ms`.
- Rust snapshot chunk apply: `+2ms`.
- Rust snapshot chunk bind: `+3ms`.
- Rust served WASM bytes: `+35,752` bytes (`+1.07%`), below the regression
  gate and under the raw/gzip budgets.

Decision:

- Retained. The remaining duplicated protocol validation moved into the
  protocol crate and browser performance/size stayed inside the accepted gate.

## 2026-05-19 - Native SQLite Snapshot Artifact Apply

Commit: this commit

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Native Diesel stores can decode verified `sqlite-snapshot-v1` artifact bytes
  into an in-memory readonly SQLite connection, project rows through generated
  schema adapters, and apply them through the existing snapshot upsert path.
- Native Diesel pull requests now advertise the current SQLite artifact kind.
- Testkit can queue and assert snapshot artifact byte fetches.

Targeted server perf gate:

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

Candidate:

- `sync_pack_json_encode_50000`: `11.0ms`
- `sync_pack_json_decode_50000`: `28.8ms`
- `sync_pack_binary_encode_50000`: `19.8ms`
- `sync_pack_binary_decode_50000`: `26.0ms`
- `sync_pack_binary_generated_encode_50000`: `17.1ms`
- `sync_pack_binary_generated_decode_50000`: `26.8ms`
- `server_scoped_incremental_pull_fanout_5000_20`: `3.4ms`
- `server_dense_incremental_pull_build_5000_500`: `39.3ms`
- `server_dense_incremental_pull_build_binary_encode_5000_500`: `43.6ms`
- `server_dense_incremental_pull_build_generated_binary_encode_5000_500`: `44.3ms`

Delta:

- No stored baseline was available for this targeted gate, so this run is the
  evidence point for the retained slice rather than a regression comparison.
- External app-style bootstrap was not run because server/background artifact
  body production is not wired yet, so the large-bootstrap benchmark would not
  exercise the new artifact apply path.

Decision:

- Retained as a correctness slice. It proves verified native artifact apply and
  request capability wiring, while explicitly leaving direct fast import and
  browser apply for the next measured WP-12 slices.

## 2026-05-19 - Scoped SQLite Artifact Precompute API

Commit: this commit

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Added `precomputeScopedSnapshotArtifact(...)` as an explicit server
  background/precompute API.
- Added a Bun-only SQLite artifact encoder at
  `@syncular/server/snapshot-artifacts/sqlite-bun`.
- The pull hot path still only advertises exact preexisting artifacts; it does
  not generate SQLite files during pull.

Targeted server perf gate:

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

Previous same-session targeted run:

- `sync_pack_json_encode_50000`: `11.0ms`
- `sync_pack_json_decode_50000`: `28.8ms`
- `sync_pack_binary_encode_50000`: `19.8ms`
- `sync_pack_binary_decode_50000`: `26.0ms`
- `sync_pack_binary_generated_encode_50000`: `17.1ms`
- `sync_pack_binary_generated_decode_50000`: `26.8ms`
- `server_scoped_incremental_pull_fanout_5000_20`: `3.4ms`
- `server_dense_incremental_pull_build_5000_500`: `39.3ms`
- `server_dense_incremental_pull_build_binary_encode_5000_500`: `43.6ms`
- `server_dense_incremental_pull_build_generated_binary_encode_5000_500`: `44.3ms`

Candidate:

- `sync_pack_json_encode_50000`: `10.8ms`
- `sync_pack_json_decode_50000`: `26.9ms`
- `sync_pack_binary_encode_50000`: `19.1ms`
- `sync_pack_binary_decode_50000`: `24.9ms`
- `sync_pack_binary_generated_encode_50000`: `17.3ms`
- `sync_pack_binary_generated_decode_50000`: `25.7ms`
- `server_scoped_incremental_pull_fanout_5000_20`: `3.4ms`
- `server_dense_incremental_pull_build_5000_500`: `39.9ms`
- `server_dense_incremental_pull_build_binary_encode_5000_500`: `43.1ms`
- `server_dense_incremental_pull_build_generated_binary_encode_5000_500`: `45.1ms`

Delta:

- Pull-path metrics stayed within expected local noise. The new precompute
  helper is not called by pull.
- External app-style bootstrap was not run because browser/native artifact
  direct fast apply is still open; the current browser benchmark would not
  exercise this precompute API.

Decision:

- Retained. This gives apps/jobs a real way to produce scoped SQLite artifact
  bodies without changing Cloudflare Worker pull behavior.

## 2026-05-19 - Browser Scoped SQLite Artifact Apply

Commit: this commit

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Added explicit `snapshotArtifacts.schemaVersion` to artifact-capability pull
  requests.
- Browser owned SQLite now advertises artifact support, downloads verified
  SQLite artifact bodies, deserializes them with `sqlite3_deserialize`, and
  applies projected rows through the existing snapshot-row path.
- Added a Hono/WASM browser test proving the artifact route is used and snapshot
  chunks are not fetched for a precomputed scoped SQLite artifact.

Targeted server perf gate:

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

Previous same-session targeted run:

- `sync_pack_json_encode_50000`: `10.8ms`
- `sync_pack_json_decode_50000`: `26.9ms`
- `sync_pack_binary_encode_50000`: `19.1ms`
- `sync_pack_binary_decode_50000`: `24.9ms`
- `sync_pack_binary_generated_encode_50000`: `17.3ms`
- `sync_pack_binary_generated_decode_50000`: `25.7ms`
- `server_scoped_incremental_pull_fanout_5000_20`: `3.4ms`
- `server_dense_incremental_pull_build_5000_500`: `39.9ms`
- `server_dense_incremental_pull_build_binary_encode_5000_500`: `43.1ms`
- `server_dense_incremental_pull_build_generated_binary_encode_5000_500`: `45.1ms`

Candidate:

- `sync_pack_json_encode_50000`: `10.8ms`
- `sync_pack_json_decode_50000`: `27.0ms`
- `sync_pack_binary_encode_50000`: `18.8ms`
- `sync_pack_binary_decode_50000`: `25.2ms`
- `sync_pack_binary_generated_encode_50000`: `17.9ms`
- `sync_pack_binary_generated_decode_50000`: `25.6ms`
- `server_scoped_incremental_pull_fanout_5000_20`: `3.7ms`
- `server_dense_incremental_pull_build_5000_500`: `39.4ms`
- `server_dense_incremental_pull_build_binary_encode_5000_500`: `43.6ms`
- `server_dense_incremental_pull_build_generated_binary_encode_5000_500`: `43.4ms`

Delta:

- Server metrics stayed within expected local noise. The normal pull benchmark
  does not hit a precomputed artifact body, but it does cover the schema-bound
  artifact capability shape and empty artifact lookup path.
- Browser artifact apply was covered by the Hono/WASM correctness test, not by
  the large offline bootstrap benchmark. The current apply path still
  materializes artifact rows as JSON, so the next perf-significant benchmark
  should be attached/direct artifact import.

Decision:

- Retained. This closes browser correctness for scoped SQLite artifact apply and
  keeps the known remaining performance target focused on avoiding JSON
  materialization.

## 2026-05-19 - Browser Direct SQLite Artifact Import

Commit: this commit

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Machine / power mode: Apple M3 Max, normal power.

Change:

- Browser artifact capability is now requested only for direct apply modes.
  Modes that need per-row transforms use snapshot chunks instead of carrying a
  browser artifact JSON materialization path.
- Browser owned SQLite imports artifacts by deserializing the SQLite body into
  an attached in-memory schema and running `INSERT INTO main.table SELECT ...`
  on the same connection.
- Browser E2E scoreboard gained `--sync-snapshot-artifacts` for row-chunk vs
  artifact comparison.

Release WASM size:

- Clean `HEAD` worktree before this slice: old budget already failed by
  `29.1 KiB` raw / `2.0 KiB` gzip.
- Current release build: `3.28 MiB` raw / `1.35 MiB` gzip. New budget is
  `3.30 MiB` raw / `1.36 MiB` gzip, leaving `19.2 KiB` raw and `7.7 KiB` gzip
  headroom.
- Direct artifact import adds about `2.9 KiB` raw / `0.6 KiB` gzip over the
  pre-direct artifact worktree.

Targeted server perf gate rerun:

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

Previous accepted WP-12 browser artifact run:

- `sync_pack_json_encode_50000`: `10.8ms`
- `sync_pack_json_decode_50000`: `27.0ms`
- `sync_pack_binary_encode_50000`: `18.8ms`
- `sync_pack_binary_decode_50000`: `25.2ms`
- `sync_pack_binary_generated_encode_50000`: `17.9ms`
- `sync_pack_binary_generated_decode_50000`: `25.6ms`
- `server_scoped_incremental_pull_fanout_5000_20`: `3.7ms`
- `server_dense_incremental_pull_build_5000_500`: `39.4ms`
- `server_dense_incremental_pull_build_binary_encode_5000_500`: `43.6ms`
- `server_dense_incremental_pull_build_generated_binary_encode_5000_500`: `43.4ms`

Current rerun:

- `sync_pack_json_encode_50000`: `10.9ms`
- `sync_pack_json_decode_50000`: `26.8ms`
- `sync_pack_binary_encode_50000`: `19.5ms`
- `sync_pack_binary_decode_50000`: `24.5ms`
- `sync_pack_binary_generated_encode_50000`: `18.1ms`
- `sync_pack_binary_generated_decode_50000`: `23.8ms`
- `server_scoped_incremental_pull_fanout_5000_20`: `3.3ms`
- `server_dense_incremental_pull_build_5000_500`: `39.2ms`
- `server_dense_incremental_pull_build_binary_encode_5000_500`: `43.4ms`
- `server_dense_incremental_pull_build_generated_binary_encode_5000_500`: `44.7ms`

Browser release E2E, 100k rows, query iterations disabled:

| Metric | Row chunks | Artifact row-copy prototype | SQLite-native artifact import |
| --- | ---: | ---: | ---: |
| `rust_bootstrap_ms` | `144.76ms` | `128.11ms` | `108.73ms` |
| `rust_pull_request_ms` | `64ms` | `35ms` | `36ms` |
| `rust_pull_apply_ms` | `78ms` | `90ms` | `69ms` |
| `rust_snapshot_row_apply_ms` | `0ms` | `41ms` | `20ms` |
| `rust_snapshot_chunk_apply_ms` | `67ms` | `33ms` | `34ms` |
| `rust_snapshot_chunk_materialize_ms` | `0ms` | `0ms` | `0ms` |
| `rust_response_bytes` | `766877` | `3169482` | `3169482` |
| `rust_cached_bootstrap_ms` | `76.45ms` | `82.81ms` | `60.59ms` |
| `browser_js_heap_used_delta_bytes` | `4445236` | `2728108` | `2616444` |

Delta:

- SQLite-native artifact import is `24.9%` faster than row chunks on first
  100k bootstrap and `20.7%` faster on cached bootstrap.
- It is `15.1%` faster than the row-copy artifact prototype and recovers the
  local-apply regression (`90ms` to `69ms`).
- The artifact body is still much larger on the wire than gzipped binary
  chunks. Artifact compression/body shape is the next performance target before
  calling this path done for 500k bootstrap.
- External `/Users/bkniffler/GitHub/sync/offline-sync-bench` was not run for
  this slice because that branch-server stack does not yet precompute scoped
  SQLite artifacts. The browser E2E artifact lane is the current artifact
  benchmark until WP-12 wires artifact precompute into the external stack.

Decision:

- Retained. The direct browser artifact path now has a real benchmark lane and
  improves wall time and heap usage enough to justify the small WASM size
  increase. Keep iterating on artifact transfer size and native direct import.

## 2026-05-19 - Gzip Scoped SQLite Artifacts

Commit: this commit

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Change:

- Current Rust native/browser artifact capability requests now advertise gzip
  scoped SQLite artifacts.
- Server pull selection now only selects gzip scoped SQLite artifacts.
- Bun SQLite artifact precompute stores gzip artifact bodies by default.
- Native and browser transports validate compressed bytes, then return decoded
  SQLite bytes to storage/apply.

Correctness gates:

```bash
cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract http_sync_diesel_applies_snapshot_artifact_rows --features native,crdt-yjs,demo-todo-native-fixture
bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts
bun run --cwd packages/server tsgo
bun run --cwd rust/bindings/browser build:wasm
bun run --cwd rust/bindings/browser tsgo
bun test src/__tests__/sync-hono.wasm.test.ts
```

Targeted server perf gate:

```bash
PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 \
PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 \
PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 \
bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts \
  --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"
```

Previous accepted WP-12 server perf run:

- `sync_pack_json_encode_50000`: `10.9ms`
- `sync_pack_json_decode_50000`: `26.8ms`
- `sync_pack_binary_encode_50000`: `19.5ms`
- `sync_pack_binary_decode_50000`: `24.5ms`
- `sync_pack_binary_generated_encode_50000`: `18.1ms`
- `sync_pack_binary_generated_decode_50000`: `23.8ms`
- `server_scoped_incremental_pull_fanout_5000_20`: `3.3ms`
- `server_dense_incremental_pull_build_5000_500`: `39.2ms`
- `server_dense_incremental_pull_build_binary_encode_5000_500`: `43.4ms`
- `server_dense_incremental_pull_build_generated_binary_encode_5000_500`: `44.7ms`

Current rerun:

- `sync_pack_json_encode_50000`: `10.9ms`
- `sync_pack_json_decode_50000`: `26.8ms`
- `sync_pack_binary_encode_50000`: `18.9ms`
- `sync_pack_binary_decode_50000`: `24.9ms`
- `sync_pack_binary_generated_encode_50000`: `17.1ms`
- `sync_pack_binary_generated_decode_50000`: `25.5ms`
- `server_scoped_incremental_pull_fanout_5000_20`: `3.3ms`
- `server_dense_incremental_pull_build_5000_500`: `39.3ms`
- `server_dense_incremental_pull_build_binary_encode_5000_500`: `44.0ms`
- `server_dense_incremental_pull_build_generated_binary_encode_5000_500`: `42.9ms`

Browser release E2E, 100k rows, query iterations disabled:

| Metric | Uncompressed direct artifact | Gzip direct artifact |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `108.73ms` | `107.82ms` |
| `rust_pull_request_ms` | `36ms` | `36ms` |
| `rust_pull_apply_ms` | `69ms` | `68ms` |
| `rust_snapshot_row_apply_ms` | `20ms` | `21ms` |
| `rust_snapshot_chunk_apply_ms` | `34ms` | `35ms` |
| `rust_response_bytes` | `3169482` | `1033377` |
| `rust_cached_bootstrap_ms` | `60.59ms` | `61.77ms` |
| `browser_js_heap_used_delta_bytes` | `2616444` | `2754568` |

Row-chunk guardrail after the same change:

- `rust_bootstrap_ms=140.81`
- `rust_pull_apply_ms=75`
- `rust_response_bytes=766877`
- `rust_cached_bootstrap_ms=75.35`

Decision:

- Retained. First bootstrap stayed flat, cached bootstrap moved only `+1.18ms`,
  and scoped SQLite artifact response bytes dropped by about `67%`.
- The artifact response is still larger than binary row chunks for 100k rows,
  but direct artifact import remains faster on wall time. Next WP-12 work should
  prove the same shape at 500k with external app-style artifact precompute.

## 2026-05-19 - Multi-Page Scoped SQLite Artifact Precompute

Commit: this commit

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Change:

- Added `precomputeScopedSnapshotArtifacts(...)`, which follows snapshot
  `nextCursor` values and stores every scoped SQLite artifact page for a
  subscription/table/scope.
- Updated the browser Hono fixture and browser E2E benchmark server to
  precompute all artifact pages instead of only the first page.
- Added server coverage that reads a later artifact page by page key.

Correctness gates:

```bash
bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts
bun run --cwd packages/server tsgo
bun run --cwd rust/bindings/browser tsgo
bun test src/__tests__/sync-hono.wasm.test.ts
```

Browser release E2E, 100k rows, query iterations disabled:

| Metric | One artifact page + one row chunk | Multi-page artifacts |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `107.82ms` | `68.6ms` |
| `rust_pull_request_ms` | `36ms` | `7ms` |
| `rust_snapshot_fetch_ms` | `11ms` | `14ms` |
| `rust_pull_apply_ms` | `68ms` | `58ms` |
| `rust_snapshot_row_apply_ms` | `21ms` | `43ms` |
| `rust_snapshot_chunk_apply_ms` | `35ms` | `0ms` |
| `rust_response_bytes` | `1033377` | `1300566` |
| `rust_snapshot_chunk_binary_count` | `1` | `0` |
| `rust_cached_bootstrap_ms` | `61.77ms` | `48.36ms` |

Decision:

- Retained. This removes the remaining row-chunk fetch/apply from the 100k
  artifact lane, improves first bootstrap by about `36%`, and improves cached
  bootstrap by about `22%`.
- Response bytes increase compared with the one-page artifact lane because both
  pages now travel as SQLite artifacts, but the wall-time win is large enough
  to keep. Next benchmark step is 500k and the external app-style stack.

500k browser release E2E follow-up:

| Metric | Row chunks | Multi-page artifacts |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `618.95ms` | `268.44ms` |
| `rust_pull_request_ms` | `270ms` | `8ms` |
| `rust_snapshot_fetch_ms` | `44ms` | `60ms` |
| `rust_pull_apply_ms` | `345ms` | `252ms` |
| `rust_snapshot_row_apply_ms` | `0ms` | `191ms` |
| `rust_snapshot_chunk_apply_ms` | `299ms` | `0ms` |
| `rust_response_bytes` | `3783097` | `6500487` |
| `rust_snapshot_chunk_binary_count` | `10` | `0` |
| `rust_cached_bootstrap_ms` | `337.61ms` | `248.64ms` |

500k decision:

- Still retained. Multi-page artifacts improve first bootstrap by about `57%`
  and cached bootstrap by about `26%` against row chunks.
- The artifact payload is about `72%` larger than binary row chunks at 500k.
  Next body-shape work must reduce bytes while preserving direct SQLite import.

## 2026-05-19 - Compact Scoped SQLite Artifact Bodies

Commit: this commit

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Change:

- Server table handlers now expose `primaryKeyColumn` metadata to artifact
  encoders.
- The Bun SQLite artifact encoder creates primary-key `WITHOUT ROWID` tables
  when the generated snapshot columns include the handler primary key.
- The default artifact gzip level changed from `1` to `6`. Artifact generation
  is a background/precompute path; pulls still serve stored bytes.

Correctness gates:

```bash
bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts
bun run --cwd packages/server tsgo
bun run --cwd rust/bindings/browser tsgo
bun test src/__tests__/sync-hono.wasm.test.ts
```

Browser release E2E, 100k rows, query iterations disabled:

| Metric | Multi-page artifacts | Compact artifacts |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `68.6ms` | `66.47ms` |
| `rust_pull_request_ms` | `7ms` | `7ms` |
| `rust_snapshot_fetch_ms` | `14ms` | `11ms` |
| `rust_pull_apply_ms` | `58ms` | `56ms` |
| `rust_snapshot_row_apply_ms` | `43ms` | `42ms` |
| `rust_response_bytes` | `1300566` | `976972` |
| `rust_cached_bootstrap_ms` | `48.36ms` | `45.39ms` |

Browser release E2E, 500k rows, query iterations disabled:

| Metric | Multi-page artifacts | Compact artifacts |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `268.44ms` | `260.82ms` |
| `rust_pull_request_ms` | `8ms` | `7ms` |
| `rust_snapshot_fetch_ms` | `60ms` | `54ms` |
| `rust_pull_apply_ms` | `252ms` | `245ms` |
| `rust_snapshot_row_apply_ms` | `191ms` | `189ms` |
| `rust_response_bytes` | `6500487` | `4738745` |
| `rust_cached_bootstrap_ms` | `248.64ms` | `235.69ms` |

Decision:

- Retained. Response bytes dropped about `25%` at 100k and `27%` at 500k, and
  both first and cached bootstrap stayed slightly faster.
- The compact artifact path is now the baseline for future artifact body-shape
  experiments.

## 2026-05-19 - Artifact Server Facade And Postgres Value Encoding

Commit: this commit

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Change:

- `@syncular/server-hono` `createSyncServer(...)` now accepts and forwards
  `snapshotArtifactStorage`, so app-style servers can use the high-level Hono
  factory instead of dropping down to `createSyncRoutes(...)` just to serve
  scoped SQLite artifacts.
- The Bun SQLite artifact encoder now normalizes Postgres-style snapshot values
  into typed SQLite values: numeric strings for integer/float columns, bigint
  integers, and `Date` values for string timestamp columns.

Correctness gates:

```bash
bun test packages/server/src/snapshot-artifacts.test.ts packages/server-hono/src/__tests__/pull-chunk-storage.test.ts
bun run --cwd packages/server tsgo
bun run --cwd packages/server-hono tsgo
```

Benchmark gate:

```bash
bun run --cwd rust/bindings/browser benchmark:browser:e2e -- --sync-snapshot-artifacts --rows=500000
```

Browser release E2E, 500k rows:

| Metric | Previous compact artifacts | Current |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `260.82ms` | `259ms` |
| `rust_pull_request_ms` | `7ms` | `8ms` |
| `rust_snapshot_fetch_ms` | `54ms` | `53ms` |
| `rust_pull_apply_ms` | `245ms` | `243ms` |
| `rust_snapshot_row_apply_ms` | `189ms` | `189ms` |
| `rust_response_bytes` | `4738745` | `4738745` |
| `rust_cached_bootstrap_ms` | `235.69ms` | `232.48ms` |

Decision:

- Retained. The code is a small correctness/ergonomics improvement for
  app-style artifact servers and Postgres-backed snapshots. Browser artifact
  performance stayed flat to slightly faster with identical response bytes.
- External Docker-based app-style benchmarking could not be run in this slice
  because Docker commands hung before returning daemon status. The external
  harness path is documented in `QUALITY_GATES.md`; rerun it once Docker is
  responsive.

## 2026-05-19 - Rejected Native Temp-File Artifact Attach

Commit: documentation only

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Change tried and rejected:

- Prototyped a native Diesel direct-import path that wrote verified SQLite
  artifact bytes to a temp file, attached that file to the active Diesel
  transaction, imported with `INSERT INTO main.table SELECT ... FROM
  artifact.table`, and generated row-level event metadata from the attached
  artifact table.

Gate:

```bash
SYNCULAR_NATIVE_ARTIFACT_BENCH_ROWS=50000 cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_artifact_import_perf --features native,crdt-yjs,demo-todo-native-fixture -- --ignored --nocapture
```

Result:

- Rejected before timing. SQLite returned `database
  __syncular_snapshot_artifact_... is locked` on `DETACH` because the attach
  was owned by the active Diesel transaction. Keeping the schema attached until
  after commit would leak random attached schemas through the pooled connection
  and make rollback/error handling fragile.

Decision:

- Reverted the code. Native keeps the current verified artifact row-projection
  path for now.
- Do not reintroduce a temp-file attach path for Diesel. Native direct import
  needs either a clean raw-SQLite schema-deserialize hook on the active
  connection or a native pull mode that deliberately does not require row-level
  changed-row events.

## 2026-05-19 - Artifact Page-Size Measurement Guard

Commit: `c6654b9d`

Work package: [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)

Change:

- The browser E2E scoreboard can now pass a scoped artifact row-limit through
  to the benchmark server and align the Rust pull `limitSnapshotRows` with
  that value.
- The scoreboard records the first observed Rust pull request's
  `limitSnapshotRows`, `maxSnapshotPages`, and artifact capability bit. This
  prevents benchmark reports from trusting intended config when the request
  body says something else.
- Browser transport stats now include
  `serverBootstrapArtifactCacheLookupMs`, so artifact lookup cost/miss behavior
  is visible beside chunk-cache timings.

Correctness gates:

```bash
bun run --cwd rust/bindings/browser tsgo
cargo fmt --manifest-path rust/Cargo.toml --all
```

Benchmark gates:

```bash
bun run --cwd rust/bindings/browser benchmark:browser:e2e -- --sync-snapshot-artifacts --rows=500000 --output=.context/benchmarks/wp12-artifact-50k-observed.json
bun run --cwd rust/bindings/browser benchmark:browser:e2e -- --sync-snapshot-artifacts --rows=500000 --sync-snapshot-artifact-row-limit=100000 --output=.context/benchmarks/wp12-artifact-100k-artifact-timing.json
```

Browser release E2E, 500k rows:

| Metric | Previous compact artifact baseline | 50k observed | 100k attempted |
| --- | ---: | ---: | ---: |
| `benchmark_rust_observed_limit_snapshot_rows` | n/a | `50000` | `100000` |
| `benchmark_rust_observed_snapshot_artifacts` | n/a | `1` | `1` |
| `rust_bootstrap_ms` | `260.82ms` | `262.13ms` | `615.11ms` |
| `rust_pull_request_ms` | `7ms` | `7ms` | `267ms` |
| `rust_snapshot_fetch_ms` | `54ms` | `54ms` | `41ms` |
| `rust_pull_apply_ms` | `245ms` | `246ms` | `344ms` |
| `rust_snapshot_row_apply_ms` | `189ms` | `191ms` | `1ms` |
| `rust_snapshot_chunk_apply_ms` | `0ms` | `0ms` | `301ms` |
| `rust_snapshot_chunk_binary_count` | `0` | `0` | `10` |
| `rust_response_bytes` | `4738745` | `4738745` | `3783097` |
| `rust_cached_bootstrap_ms` | `235.69ms` | `233.96ms` | `358.34ms` |

Decision:

- Retained the measurement guard. It is low-complexity and caught a bad
  benchmark interpretation immediately.
- Rejected changing the artifact page size from `50k` to `100k`. The observed
  request did ask for artifacts at `100k`, but the server artifact lookup
  missed and the response fell back to binary chunks. That made bootstrap
  about `2.35x` slower than the 50k direct artifact path despite fewer response
  bytes.
- Keep the current `50k` artifact page shape. Only revisit larger pages if a
  dedicated slice proves the server can select direct artifacts and beats the
  compact artifact baseline end to end.

## 2026-05-19 - Realtime Requires-Pull Guard

Commit: this slice

Work package: [`WP-04 Realtime Runtime`](work-packages/WP-04-realtime-runtime.md)

Change:

- Browser worker realtime now treats `requiresPull=true` or
  `droppedCount > 0` as authoritative recovery metadata. If a websocket sync
  event contains inline changes but is marked recovery-only, the worker runs
  HTTP pull and does not apply the inline changes.
- Added a worker-level regression test covering the mixed payload shape:
  `changes` present, `requiresPull=true`, and `droppedCount=1`.

Correctness gates:

```bash
bun test rust/bindings/browser/src/worker-realtime.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
bun run --cwd rust/bindings/browser tsgo
```

Benchmark gate:

```bash
bun run --cwd rust/bindings/browser benchmark:browser:e2e -- --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --output=.context/benchmarks/wp04-realtime-requires-pull.json
```

Browser release E2E, 10k bootstrap + 1k incremental + 3 realtime rounds:

| Metric | Current |
| --- | ---: |
| `rust_bootstrap_ms` | `34.46ms` |
| `rust_incremental_pull_ms` | `18.91ms` |
| `rust_realtime_live_ms` | `70.19ms` |
| `rust_realtime_live_p95_ms` | `71.7ms` |
| `rust_realtime_http_request_count` | `0` |
| `rust_realtime_binary_events` | `15` |
| `rust_realtime_binary_bytes` | `537675` |

Decision:

- Retained. This is a recovery-semantics fix; the normal websocket binary fast
  path stayed active in the benchmark with zero HTTP realtime fallbacks.
- No directly comparable prior local WP-04 benchmark was logged, so this run is
  the baseline for the next realtime runtime slices.

## 2026-05-19 - Realtime Recovery Cursor ACK

Commit: this slice

Work package: [`WP-04 Realtime Runtime`](work-packages/WP-04-realtime-runtime.md)

Change:

- Browser worker realtime now ACKs the websocket cursor that triggered a
  successful recovery pull, even when the message was cursor-only and the pull
  result does not report a larger subscription cursor.
- Added worker-level assertions for cursor-only and resync-required recovery
  ACKs.

Correctness gates:

```bash
bun test rust/bindings/browser/src/worker-realtime.test.ts
bun run --cwd rust/bindings/browser tsgo
```

Benchmark gate:

```bash
bun run --cwd rust/bindings/browser benchmark:browser:e2e -- --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --output=.context/benchmarks/wp04-realtime-recovery-ack.json
```

Browser release E2E, 10k bootstrap + 1k incremental + 3 realtime rounds:

| Metric | Previous WP-04 guard | Current |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `34.46ms` | `34.12ms` |
| `rust_incremental_pull_ms` | `18.91ms` | `18.37ms` |
| `rust_realtime_live_ms` | `70.19ms` | `71.99ms` |
| `rust_realtime_live_p95_ms` | `71.7ms` | `73.25ms` |
| `rust_realtime_http_request_count` | `0` | `0` |
| `rust_realtime_binary_events` | `15` | `15` |
| `rust_realtime_binary_bytes` | `537675` | `537675` |

Decision:

- Retained. This is a recovery-only ACK correctness fix; the normal binary
  websocket fast path still used zero HTTP realtime fallbacks and identical
  binary event count/bytes. The small live-time movement is benchmark noise.

## 2026-05-19 - WP-04 Verified Realtime Subscription Packs

Change:

- Replaced websocket binary deltas' synthetic `__syncular_realtime__`
  subscription with real per-subscription sync-pack responses carrying commit
  integrity metadata.
- Browser Rust realtime apply now verifies/persists the same subscription root
  shape used by HTTP pull and rejects missing/mismatched roots for real
  subscriptions.
- Server Hono realtime state now records active subscription metadata from pull
  responses and advances in-memory verified roots while consecutive binary
  websocket packs are emitted.

Correctness gates:

```bash
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd packages/server-hono tsgo
bun run --cwd rust/bindings/browser tsgo
bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts
bun test rust/bindings/browser/src/worker-realtime.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-integrity-packs.json
```

Browser dev E2E, 10k bootstrap + 1k incremental + 3 realtime rounds:

| Metric | Previous WP-04 guard | Current |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `34.12ms` | `84.29ms` |
| `rust_incremental_pull_ms` | `18.37ms` | `76.52ms` |
| `rust_realtime_live_ms` | `71.99ms` | `107.12ms` |
| `rust_realtime_live_p95_ms` | `73.25ms` | `110.48ms` |
| `rust_realtime_http_request_count` | `0` | `0` |
| `rust_realtime_binary_events` | `15` | `15` |
| `rust_realtime_binary_bytes` | `537675` | `540300` |

Decision:

- Retained as a correctness/security slice: websocket deltas now use the same
  verified per-subscription root contract as pull, and the binary fast path
  still has zero HTTP realtime fallbacks.
- The benchmark was run with dev WASM, so bootstrap/incremental numbers are not
  directly comparable with older release-lane guards. The realtime lane still
  shows added overhead; the next WP-04 slice should recover that overhead without
  weakening integrity verification.

## 2026-05-19 - WP-04 Remove JSON Websocket Delta Path

Change:

- Removed the browser worker/public Rust inline JSON websocket apply path
  (`applyRealtimeChanges`, wasm `applyRealtimeChangesJson`, Rust
  `apply_realtime_changes`) and the synthetic `__syncular_realtime__`
  subscription branch.
- Removed server-side bounded JSON websocket deltas. Realtime now sends binary
  sync-pack frames when the connection negotiated `binary-sync-pack-v1`; other
  cases receive an explicit pull-required wakeup.

Correctness gates:

```bash
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd packages/server-hono tsgo
bun run --cwd rust/bindings/browser tsgo
bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts
bun test rust/bindings/browser/src/worker-realtime.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-no-json-deltas.json
```

Browser dev E2E, 10k bootstrap + 1k incremental + 3 realtime rounds:

| Metric | Previous WP-04 guard | Current |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `84.29ms` | `81.31ms` |
| `rust_incremental_pull_ms` | `76.52ms` | `75.92ms` |
| `rust_realtime_live_ms` | `107.12ms` | `99.19ms` |
| `rust_realtime_live_p95_ms` | `110.48ms` | `108.07ms` |
| `rust_realtime_http_request_count` | `0` | `0` |
| `rust_realtime_binary_events` | `15` | `15` |
| `rust_realtime_binary_bytes` | `540300` | `540300` |
| `browser_served_syncular_worker_js_bytes` | `n/a` | `46999` |
| `browser_served_rust_wasm_bytes` | `n/a` | `7467818` |

Decision:

- Retained. The change removes obsolete protocol surface and keeps the binary
  websocket fast path at zero HTTP realtime fallbacks.
- The realtime p50 improved from `107.12ms` to `99.19ms` (`-7.4%`) and p95 from
  `110.48ms` to `108.07ms` (`-2.2%`) in the local dev-WASM guard. Treat the
  improvement as useful but still subject to the usual browser benchmark noise.

## 2026-05-19 - WP-04 Slim Realtime Apply Result

Change:

- Realtime sync-pack apply no longer clones/serializes applied commit payloads
  into `WebSyncResult.subscriptions[].commits`.
- Empty browser subscription `snapshotRows` and `commits` are omitted from the
  serialized Rust result; the TS wrapper already defaults them to empty arrays.

Correctness gates:

```bash
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd rust/bindings/browser tsgo
bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts
bun test rust/bindings/browser/src/worker-realtime.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-slim-result.json
```

Browser dev E2E, 10k bootstrap + 1k incremental + 3 realtime rounds:

| Metric | Previous WP-04 guard | Current |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `81.31ms` | `83.45ms` |
| `rust_incremental_pull_ms` | `75.92ms` | `73.75ms` |
| `rust_realtime_live_ms` | `99.19ms` | `88.67ms` |
| `rust_realtime_live_p95_ms` | `108.07ms` | `97.53ms` |
| `rust_realtime_http_request_count` | `0` | `0` |
| `rust_realtime_binary_events` | `15` | `15` |
| `rust_realtime_binary_bytes` | `540300` | `540300` |
| `browser_served_rust_wasm_bytes` | `7467818` | `7465575` |

Decision:

- Retained. This is simpler and removes duplicate row payload serialization from
  the websocket apply result.
- Realtime p50 improved from `99.19ms` to `88.67ms` (`-10.6%`) and p95 from
  `108.07ms` to `97.53ms` (`-9.8%`) with the binary fast path unchanged.

## 2026-05-19 - WP-04 Realtime Apply Timing Metrics

Change:

- `realtime.binary_applied` diagnostics now include Rust-side apply timing
  breakdowns from the sync result.
- Browser E2E scoreboard now reports realtime apply total, pull-apply,
  commit-apply, and notify totals/p50/p95 values.

Correctness gates:

```bash
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd rust/bindings/browser tsgo
bun test rust/bindings/browser/src/worker-realtime.test.ts
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-apply-timings.json
```

Browser dev E2E, 10k bootstrap + 1k incremental + 3 realtime rounds:

| Metric | Previous WP-04 guard | Current |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `88.67ms` | `85.32ms` |
| `rust_realtime_live_p95_ms` | `97.53ms` | `86.52ms` |
| `rust_realtime_http_request_count` | `0` | `0` |
| `rust_realtime_binary_events` | `15` | `15` |
| `rust_realtime_binary_bytes` | `540300` | `540300` |
| `rust_realtime_apply_total_p50_ms` | `n/a` | `11ms` |
| `rust_realtime_pull_apply_p50_ms` | `n/a` | `9ms` |
| `rust_realtime_notify_p50_ms` | `n/a` | `0ms` |
| `browser_served_syncular_worker_js_bytes` | `46999` | `47446` |

Decision:

- Retained as measurement infrastructure. The new numbers show the remaining
  client-side realtime cost is in pull/apply, with notification effectively
  negligible in this lane.

## 2026-05-19 - WP-04 Cached App-Row Upsert Statements

Change:

- Browser SQLite `write_app_rows` now reuses the existing prepared-statement
  cache for multi-row app upserts instead of preparing/finalizing a statement
  per batch.

Correctness gates:

```bash
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd rust/bindings/browser tsgo
bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-cached-app-upsert.json
```

Browser dev E2E, 10k bootstrap + 1k incremental + 3 realtime rounds:

| Metric | Previous WP-04 guard | Current |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `85.32ms` | `84.31ms` |
| `rust_realtime_live_p95_ms` | `86.52ms` | `85.16ms` |
| `rust_realtime_http_request_count` | `0` | `0` |
| `rust_realtime_binary_events` | `15` | `15` |
| `rust_realtime_apply_total_ms` | `165ms` | `160ms` |
| `rust_realtime_pull_apply_total_ms` | `138ms` | `134ms` |
| `rust_realtime_pull_apply_p50_ms` | `9ms` | `9ms` |
| `browser_served_rust_wasm_bytes` | `7465575` | `7464753` |

Decision:

- Retained. The gain is small but measurable, and the implementation removes
  one-off statement lifecycle handling in favor of the existing cache.

## 2026-05-19 - WP-04 Canonical Realtime Row Pass-Through

Change:

- Browser realtime batched upserts now pass emitted upsert row payloads through
  as canonical server rows instead of rewriting primary-key and server-version
  fields on every change.
- This removes per-change generated table metadata lookup from the
  no-changed-rows realtime fast path.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd rust/bindings/browser tsgo
bun test rust/bindings/browser/src/worker-realtime.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-canonical-row-pass-through.json
```

Browser dev E2E, 10k bootstrap + 1k incremental + 3 realtime rounds:

| Metric | Previous WP-04 guard | Current |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `84.31ms` | `82.27ms` |
| `rust_realtime_live_p95_ms` | `85.16ms` | `83.61ms` |
| `rust_realtime_http_request_count` | `0` | `0` |
| `rust_realtime_binary_events` | `15` | `15` |
| `rust_realtime_apply_total_ms` | `160ms` | `155ms` |
| `rust_realtime_pull_apply_total_ms` | `134ms` | `131ms` |
| `rust_realtime_apply_total_p50_ms` | `11ms` | `10ms` |
| `browser_served_rust_wasm_bytes` | `7464753` | `7463118` |

Decision:

- Retained. This is a measurable small win and also simplifies the realtime hot
  path by relying on the server's canonical emitted row contract.

## 2026-05-19 - WP-04 Rejected Binary Row-Group Sidecar Apply

Change tested:

- Prototype retained binary sync-pack row-group payloads as sidecar metadata on
  decoded commits and applied clean single-table upsert commits through the
  existing binary snapshot payload writer after integrity verification.

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-direct-binary-row-groups.json
```

Browser dev E2E, 10k bootstrap + 1k incremental + 3 realtime rounds:

| Metric | Previous WP-04 guard | Candidate |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `82.27ms` | `83.79ms` |
| `rust_realtime_live_p95_ms` | `83.61ms` | `85.81ms` |
| `rust_realtime_apply_total_ms` | `155ms` | `162ms` |
| `rust_realtime_pull_apply_total_ms` | `131ms` | `137ms` |
| `browser_served_rust_wasm_bytes` | `7463118` | `7470682` |

Decision:

- Rejected and reverted. Applying retained binary payloads after already
  decoding them into row maps for commit integrity adds size and does not help
  the realtime lane. The direct binary path only makes sense if the protocol can
  avoid JSON/map materialization on the hot path.

## 2026-05-19 - WP-04 Rejected Binary Row Map Preallocation

Change tested:

- Replaced iterator `collect()` map construction in binary snapshot row decoding
  with explicit `serde_json::Map::with_capacity` insertion.

Benchmark gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-binary-row-map-prealloc.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-binary-row-map-prealloc-rerun.json
```

Confirmed rerun versus previous guard:

| Metric | Previous WP-04 guard | Candidate rerun |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `82.27ms` | `84.64ms` |
| `rust_realtime_live_p95_ms` | `83.61ms` | `87.96ms` |
| `rust_incremental_sync_pack_decode_ms` | `9ms` | `10ms` |
| `rust_realtime_apply_total_ms` | `155ms` | `157ms` |
| `browser_served_rust_wasm_bytes` | `7463118` | `7416004` |

Decision:

- Rejected and reverted. The size reduction is real, but the runtime lane did
  not improve and the code is more verbose.

## 2026-05-19 - WP-04 Realtime Overhead Metric

Change:

- Browser E2E realtime scoring now records `rust_realtime_overhead_*` metrics:
  per-iteration live query propagation latency minus TS push duration.
- This separates Rust/browser websocket/apply/live-query overhead from server
  push noise when reviewing future realtime changes.

Correctness gate:

```bash
bun run --cwd rust/bindings/browser tsgo
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-overhead-metric.json
```

Current guard:

| Metric | Value |
| --- | ---: |
| `rust_realtime_live_ms` | `82.05ms` |
| `rust_realtime_live_p95_ms` | `83.99ms` |
| `rust_realtime_overhead_p50_ms` | `22.63ms` |
| `rust_realtime_overhead_p95_ms` | `23.99ms` |
| `rust_realtime_http_request_count` | `0` |
| `rust_realtime_binary_events` | `15` |
| `browser_served_rust_wasm_bytes` | `7463118` |

Decision:

- Retained as measurement infrastructure. Future realtime changes should compare
  both end-to-end live latency and the derived Rust/browser overhead lane.

## 2026-05-19 - WP-04 Rejected Realtime Table Clone Elision

Change tested:

- Avoided cloning the table name for every batchable realtime upsert row in the
  browser web client batching path. The candidate only cloned the table when a
  new table batch started.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime web::client --lib
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd rust/bindings/browser tsgo
bun test rust/bindings/browser/src/worker-realtime.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts
```

Benchmark gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-table-clone-elision.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-table-clone-elision-rerun.json
```

Confirmed rerun versus previous guard:

| Metric | Previous WP-04 guard | Candidate rerun |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `82.05ms` | `100.03ms` |
| `rust_realtime_live_p95_ms` | `83.99ms` | `101.44ms` |
| `rust_realtime_overhead_p50_ms` | `22.63ms` | `23.91ms` |
| `rust_realtime_overhead_p95_ms` | `23.99ms` | `25.83ms` |
| `rust_realtime_apply_total_ms` | `160ms` | `165ms` |
| `rust_realtime_pull_apply_total_ms` | `133ms` | `137ms` |
| `browser_served_rust_wasm_bytes` | `7463118` | `7462690` |

Decision:

- Rejected and reverted. The candidate slightly reduced WASM bytes but regressed
  the runtime lane on two runs, including the explicit Rust/browser overhead
  metric.

## 2026-05-19 - WP-04 Realtime Decode/Transform Metrics

Change:

- Added `syncPackDecodeMs` to browser Rust sync results for realtime
  `binary-sync-pack-v1` frames.
- Browser realtime diagnostics and the E2E scoreboard now report
  `rust_realtime_sync_pack_decode_*` and
  `rust_realtime_pull_transform_*` metrics alongside apply/notify timings.
- Made the React browser binding test setup idempotent around Happy DOM global
  registration while updating timing fixtures.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime web::client --lib
bun run --cwd rust/bindings/browser tsgo
bun run --cwd rust/bindings/browser build:wasm:dev
bun test rust/bindings/browser/src/worker-realtime.test.ts
bun test rust/bindings/browser/src/client.test.ts
bun test rust/bindings/browser/src/react.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-decode-transform-metrics.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-decode-transform-metrics-rerun.json
```

Confirmed rerun versus previous guard:

| Metric | Previous WP-04 guard | Current |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `82.05ms` | `95.34ms` |
| `rust_realtime_overhead_p50_ms` | `22.63ms` | `24.08ms` |
| `rust_realtime_apply_total_ms` | `160ms` | `158ms` |
| `rust_realtime_pull_apply_total_ms` | `133ms` | `129ms` |
| `rust_realtime_sync_pack_decode_total_ms` | n/a | `23ms` |
| `rust_realtime_sync_pack_decode_p50_ms` | n/a | `2ms` |
| `rust_realtime_pull_transform_total_ms` | n/a | `0ms` |
| `browser_served_rust_wasm_bytes` | `7463118` | `7463464` |

Decision:

- Retained as measurement infrastructure. The new split shows the remaining
  realtime frame cost is mostly SQLite row apply plus about `23ms` of binary
  sync-pack decoding across 15 frames; transform/integrity rounds to `0ms` in
  this scenario. Future realtime performance work should compare against
  `.context/benchmarks/wp04-realtime-decode-transform-metrics-rerun.json`.

## 2026-05-19 - WP-04 Realtime Integrity/State Metrics

Change:

- Split browser Rust realtime apply timings further into
  `integrityVerifyMs`, `commitApplyMs`, and `subscriptionStateMs`.
- Browser diagnostics and the E2E scoreboard now report
  `rust_realtime_integrity_verify_*` and
  `rust_realtime_subscription_state_*` metrics for binary websocket frames.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-protocol integrity --lib
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime web::client --lib
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd rust/bindings/browser tsgo
bun test rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/client.test.ts rust/bindings/browser/src/react.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-integrity-state-split.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-integrity-state-split-rerun2.json
```

Confirmed measurement versus previous accepted decode/transform guard:

| Metric | Decode/transform guard | First split | Latest split rerun |
| --- | ---: | ---: | ---: |
| `rust_realtime_live_ms` | `95.34ms` | `93.93ms` | `121.39ms` |
| `rust_realtime_overhead_p50_ms` | `24.08ms` | `24.68ms` | `31.01ms` |
| `rust_realtime_apply_total_ms` | `158ms` | `164ms` | `237ms` |
| `rust_realtime_pull_apply_total_ms` | `129ms` | `135ms` | `201ms` |
| `rust_realtime_sync_pack_decode_total_ms` | `23ms` | `23ms` | `29ms` |
| `rust_realtime_integrity_verify_total_ms` | n/a | `104ms` | `159ms` |
| `rust_realtime_commit_apply_total_ms` | `0ms` | `23ms` | `37ms` |
| `rust_realtime_subscription_state_total_ms` | n/a | `8ms` | `5ms` |
| `browser_served_rust_wasm_bytes` | `7463464` | `7463799` | `7463799` |

Decision:

- Retained as measurement infrastructure, not as a speed improvement. The first
  split run was effectively neutral against the previous guard, while the
  repeat was noisier. Both runs identify the same target: canonical commit/root
  integrity verification dominates realtime Rust apply cost; subscription state
  persistence is small. Future realtime optimization should start by rerunning
  `.context/benchmarks/wp04-realtime-integrity-state-split-rerun2.json` and
  compare lower-level timing buckets as well as end-to-end live latency.

## 2026-05-19 - WP-04 Rejected Sorted-Map Integrity Canonicalization

Change:

- Tried replacing canonical JSON object key sorting with a branch that used the
  current `serde_json::Map` iteration order when available.

Correctness gates passed before rejection:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-protocol integrity --lib
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime web::client --lib
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd rust/bindings/browser tsgo
bun test rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/client.test.ts rust/bindings/browser/src/react.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-sorted-map-integrity.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-sorted-map-integrity-rerun.json
```

Confirmed rerun versus the first integrity/state split:

| Metric | Integrity/state split | Sorted-map candidate |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `93.93ms` | `126.06ms` |
| `rust_realtime_overhead_p50_ms` | `24.68ms` | `35.45ms` |
| `rust_realtime_apply_total_ms` | `164ms` | `229ms` |
| `rust_realtime_pull_apply_total_ms` | `135ms` | `187ms` |
| `rust_realtime_integrity_verify_total_ms` | `104ms` | `148ms` |
| `rust_realtime_commit_apply_total_ms` | `23ms` | `34ms` |
| `browser_served_rust_wasm_bytes` | `7463799` | `7443592` |

Decision:

- Rejected and reverted. The candidate reduced WASM bytes by about `20KB`, but
  regressed every runtime bucket that matters. The next integrity improvement
  should be a protocol/digest shape change that avoids repeated canonical JSON
  work, not another local map-iteration micro-probe.

## 2026-05-19 - WP-04 Realtime Canonical JSON String Writer

Change:

- Replaced per-string `serde_json::to_string` allocation in Rust canonical JSON
  integrity payload writing with an in-place JSON string writer.
- Reused the same writer for canonical object keys and wire commit metadata
  strings.
- Added protocol tests that compare the custom string escaping against
  `serde_json::to_string` for quotes, backslashes, control characters, and
  unicode.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime web::client --lib
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd rust/bindings/browser tsgo
bun test rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/client.test.ts rust/bindings/browser/src/react.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-json-string-writer.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-json-string-writer-rerun.json
```

Confirmed rerun versus the previous accepted integrity/state split:

| Metric | Previous guard | Current rerun | Delta |
| --- | ---: | ---: | ---: |
| `rust_realtime_live_ms` | `121.39ms` | `92.55ms` | `-28.84ms` |
| `rust_realtime_live_p95_ms` | `158.51ms` | `92.98ms` | `-65.53ms` |
| `rust_realtime_overhead_p50_ms` | `31.01ms` | `22.19ms` | `-8.82ms` |
| `rust_realtime_apply_total_ms` | `237ms` | `128ms` | `-109ms` |
| `rust_realtime_pull_apply_total_ms` | `201ms` | `103ms` | `-98ms` |
| `rust_realtime_integrity_verify_total_ms` | `159ms` | `76ms` | `-83ms` |
| `rust_realtime_integrity_verify_p50_ms` | `10ms` | `5ms` | `-5ms` |
| `rust_realtime_commit_apply_total_ms` | `37ms` | `22ms` | `-15ms` |
| `rust_realtime_sync_pack_decode_total_ms` | `29ms` | `21ms` | `-8ms` |
| `browser_served_rust_wasm_bytes` | `7463799` | `7465224` | `+1425` |

Decision:

- Retained. This is a simple implementation change with a clear benchmark win:
  integrity verification dropped by about `52%` on the rerun, and total
  realtime Rust apply dropped by about `46%`. The small WASM size increase is
  acceptable for this runtime gain. Future WP-04 candidates should compare
  against `.context/benchmarks/wp04-realtime-json-string-writer-rerun.json`.

## 2026-05-19 - WP-04 Rejected Streaming Integrity Hash

Change:

- Tried writing canonical integrity payloads directly into a SHA-256 sink
  instead of first building the canonical payload `String` and hashing it.

Correctness gates passed before rejection:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract
bun run --cwd rust/bindings/browser build:wasm:dev
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-streaming-integrity-hash.json
```

Result versus the retained string-writer guard:

| Metric | String-writer guard | Streaming-hash candidate |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `92.55ms` | `93.63ms` |
| `rust_realtime_overhead_p50_ms` | `22.19ms` | `24.15ms` |
| `rust_realtime_apply_total_ms` | `128ms` | `154ms` |
| `rust_realtime_pull_apply_total_ms` | `103ms` | `130ms` |
| `rust_realtime_integrity_verify_total_ms` | `76ms` | `98ms` |
| `rust_realtime_integrity_verify_p50_ms` | `5ms` | `7ms` |
| `browser_served_rust_wasm_bytes` | `7465224` | `7466004` |

Decision:

- Rejected and reverted. Avoid the generic streaming sink abstraction for this
  path unless a future design can prove a win; the current version made the hot
  bucket slower and increased WASM size.

## 2026-05-19 - WP-04 Realtime Sorted Object Fast Path

Change:

- `append_canonical_object` now checks whether object keys are already sorted.
  If they are, it writes the object through direct map iteration; if not, it
  falls back to the canonical key sort path.
- This preserves canonical correctness while avoiding the key-vector allocation
  and second map lookup for the current BTree-backed `serde_json::Map` build.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract
bun run --cwd rust/bindings/browser build:wasm:dev
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-sorted-object-fast-path.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-sorted-object-fast-path-rerun2.json
```

Confirmed rerun versus the retained string-writer guard:

| Metric | String-writer guard | Sorted-object rerun | Delta |
| --- | ---: | ---: | ---: |
| `rust_realtime_live_ms` | `92.55ms` | `91.02ms` | `-1.53ms` |
| `rust_realtime_overhead_p50_ms` | `22.19ms` | `22.21ms` | `+0.02ms` |
| `rust_realtime_overhead_p95_ms` | `24.18ms` | `23.22ms` | `-0.96ms` |
| `rust_realtime_apply_total_ms` | `128ms` | `126ms` | `-2ms` |
| `rust_realtime_pull_apply_total_ms` | `103ms` | `98ms` | `-5ms` |
| `rust_realtime_integrity_verify_total_ms` | `76ms` | `68ms` | `-8ms` |
| `rust_realtime_integrity_verify_p50_ms` | `5ms` | `5ms` | `0ms` |
| `browser_served_rust_wasm_bytes` | `7465224` | `7467598` | `+2374` |

Decision:

- Retained. This is a small guarded fast path with a consistent integrity-bucket
  win across the confirmation runs. End-to-end live latency is mostly flat due
  to browser/server noise, so future candidates should continue comparing the
  lower-level integrity/apply buckets against
  `.context/benchmarks/wp04-realtime-sorted-object-fast-path-rerun2.json`.

## 2026-05-19 - WP-04 Realtime Direct Number Writes

Change:

- Canonical number values, wire commit sequences, and row versions now write
  directly into the existing `String` buffer with `write!` instead of allocating
  temporary `to_string()` values.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract
bun run --cwd rust/bindings/browser build:wasm:dev
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-direct-number-write.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-direct-number-write-rerun.json
```

Confirmed rerun versus the retained sorted-object guard:

| Metric | Sorted-object guard | Direct-number rerun | Delta |
| --- | ---: | ---: | ---: |
| `rust_realtime_live_ms` | `91.02ms` | `91.03ms` | `+0.01ms` |
| `rust_realtime_live_p95_ms` | `112.80ms` | `92.72ms` | `-20.08ms` |
| `rust_realtime_overhead_p50_ms` | `22.21ms` | `22.04ms` | `-0.17ms` |
| `rust_realtime_apply_total_ms` | `126ms` | `122ms` | `-4ms` |
| `rust_realtime_pull_apply_total_ms` | `98ms` | `94ms` | `-4ms` |
| `rust_realtime_integrity_verify_total_ms` | `68ms` | `69ms` | `+1ms` |
| `rust_realtime_commit_apply_total_ms` | `25ms` | `20ms` | `-5ms` |
| `browser_served_rust_wasm_bytes` | `7467598` | `7468173` | `+575` |

Decision:

- Retained. The integrity bucket is flat, but total apply and commit apply both
  improve with minimal code and a tiny size increase. Future candidates should
  compare against
  `.context/benchmarks/wp04-realtime-direct-number-write-rerun.json`.

## 2026-05-19 - External App-Style Rust Benchmark Unblocked

Change:

- Binary snapshot integer columns now accept integer strings from database
  drivers, and binary snapshot string columns now accept `Date` values by
  encoding them as ISO strings.
- This fixes the external Postgres-backed branch server path that failed Rust
  binary bootstrap with `binary snapshot server_version expected a safe integer
  or bigint`, then `binary snapshot updated_at expected string`.

Correctness gates:

```bash
bun test packages/core/src/__tests__/snapshot-chunks.test.ts packages/core/src/__tests__/sync-packs.test.ts
bun test packages/server-hono/src/__tests__/pull-chunk-storage.test.ts
bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/pull-chunk-storage.test.ts
```

External app-style gate:

```bash
bun run --cwd rust/bindings/browser build:wasm:dev
SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis \
  docker compose -f stacks/syncular/docker-compose.yml up --build -d

export SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1
export SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist
export SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis

bun run bench:run -- --stack syncular --scenario bootstrap
bun run bench:run -- --stack syncular-rust --scenario bootstrap
bun run bench:run -- --stack syncular --scenario local-query
bun run bench:run -- --stack syncular-rust --scenario local-query
bun run bench:run -- --stack syncular-rust --scenario online-propagation
bun run bench:run -- --stack syncular-rust --scenario reconnect-storm
```

Valid external results:

| Metric | TS | Rust |
| --- | ---: | ---: |
| Bootstrap 100k | `780.11ms` | `1221.43ms` |
| Bootstrap 500k | `3855.10ms` | `6099.68ms` |
| 500k pull request | `1214.76ms` | `1031ms` |
| 500k snapshot fetch | `78.14ms` | `152ms` |
| 500k local apply | `2114.80ms` | `1692ms` |
| 500k peak memory | `478.70MB` | `694.38MB` |
| Local list p50 | `0.24ms` | `0.56ms` |
| Local search p50 | `0.09ms` | `0.87ms` |
| Aggregate read-model p50 | n/a | `0.08ms` |
| Aggregate raw SQL p50 | `6.12ms` | `59.73ms` |
| Rust online mirror p50 | n/a | `27.81ms` |
| Rust online mirror p95 | n/a | `39.00ms` |
| Rust reconnect 25 | n/a | `93.74ms` |
| Rust reconnect 100 | n/a | `222.97ms` |
| Rust reconnect 250 | n/a | `2118.61ms` |

Notes:

- TS online-propagation and reconnect-storm failed with the existing snapshot
  chunk integrity mismatch, so those scenarios only have Rust-valid results in
  this run.
- Rust total bootstrap is still slower at large row counts, but the binary path
  now has valid external evidence again. The remaining 500k Rust total is
  dominated by `derived_schema_ms_500000=3213.03ms` plus
  `local_apply_ms_500000=1692ms`.

## 2026-05-19 - WP-04 One-Pass Canonical Object Write

Change:

- Canonical object writing now writes optimistically in map iteration order and
  only truncates/sorts when it actually sees out-of-order keys.
- This keeps the canonical fallback for unsorted maps, but avoids the previous
  pre-scan plus second pass for the normal sorted `serde_json::Map` path.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract
bun run --cwd rust/bindings/browser build:wasm:dev
bun run --cwd rust/bindings/browser tsgo
bun test rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/client.test.ts rust/bindings/browser/src/react.test.ts
bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts
```

Benchmark gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-one-pass-canonical-object.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-one-pass-canonical-object-rerun.json
```

Compared against
`.context/benchmarks/wp04-realtime-direct-number-write-rerun.json`:

| Metric | Previous | Current | Rerun |
| --- | ---: | ---: | ---: |
| `rust_realtime_live_ms` | `91.03ms` | `92.06ms` | `88.60ms` |
| `rust_realtime_live_p95_ms` | `92.72ms` | `102.45ms` | `90.47ms` |
| `rust_realtime_overhead_p50_ms` | `22.04ms` | `21.24ms` | `21.86ms` |
| `rust_realtime_apply_total_ms` | `122ms` | `121ms` | `125ms` |
| `rust_realtime_pull_apply_total_ms` | `94ms` | `93ms` | `95ms` |
| `rust_realtime_integrity_verify_total_ms` | `69ms` | `65ms` | `66ms` |
| `rust_realtime_subscription_state_total_ms` | `5ms` | `3ms` | `6ms` |
| `browser_served_rust_wasm_bytes` | `7468173` | `7468747` | `7468747` |

Decision:

- Retained as a modest integrity-hot-path improvement. End-to-end apply is
  effectively flat/noisy, but the targeted integrity bucket improves in both
  runs without weakening the verified root contract. Future candidates should
  compare against
  `.context/benchmarks/wp04-realtime-one-pass-canonical-object-rerun.json`.

## 2026-05-19 - Rejected WP-04 Commit Digest Capacity Hint

Probe:

- Tried reserving a heuristic `String` capacity for canonical wire commit
  digest payloads before writing the payload.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract
bun run --cwd rust/bindings/browser build:wasm:dev
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 --wasm-profile=dev --json \
  --output=.context/benchmarks/wp04-realtime-commit-digest-capacity-hint.json
```

Compared against
`.context/benchmarks/wp04-realtime-one-pass-canonical-object-rerun.json`:

| Metric | Previous | Capacity hint |
| --- | ---: | ---: |
| `rust_realtime_live_ms` | `88.60ms` | `89.93ms` |
| `rust_realtime_apply_total_ms` | `125ms` | `125ms` |
| `rust_realtime_pull_apply_total_ms` | `95ms` | `93ms` |
| `rust_realtime_integrity_verify_total_ms` | `66ms` | `65ms` |
| `browser_served_rust_wasm_bytes` | `7468747` | `7469547` |

Decision:

- Rejected and reverted. The `1ms` integrity movement did not justify a magic
  capacity heuristic, the end-to-end metric regressed, total apply stayed flat,
  and WASM grew by `800` bytes.

## 2026-05-19 - WP-12 External Scoped Artifact Gate And Owned Bytes

Change:

- External scoped artifact benchmarking now uses
  `SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=60000`. The external Rust
  harness pulls `20k` snapshot pages, while the server artifact lookup bundles
  up to the current `50k` target as whole pull pages, producing a `60k` page
  key. Precomputing `20k` artifacts made lookup miss and silently use row
  chunks.
- Browser SQLite artifact apply now consumes the fetched artifact byte vector
  instead of borrowing it and cloning into the retained SQLite deserialize
  buffer. This removes a duplicate artifact-body allocation without changing
  the transaction boundary.

Rejected probe:

- Tried detaching each deserialized SQLite artifact immediately after
  `INSERT ... SELECT`. Rebuilt WASM failed the artifact Hono test with
  `database __syncular_snapshot_artifact_0 is locked`, so the code was reverted.
  Artifacts still detach after the apply transaction commits.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
  cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features web-owned-sqlite \
  --target wasm32-unknown-unknown
bun run --cwd rust/bindings/browser build:wasm:dev
bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts \
  --test-name-pattern "SQLite snapshot artifacts|corrupted SQLite snapshot artifact|subscription is revoked"
bun run --cwd rust/bindings/browser build:wasm
bun run --cwd rust/bindings/browser tsgo
```

External app-style scoped artifact gate:

```bash
SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis \
SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=1 \
SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=60000 \
  docker compose -f stacks/syncular/docker-compose.yml up --build -d

export SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1
export SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist
export SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=1
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=60000

bun run bench:run -- --stack syncular-rust --scenario bootstrap
bun run bench:run -- --stack syncular --scenario bootstrap
bun run bench:run -- --stack syncular --scenario local-query
bun run bench:run -- --stack syncular-rust --scenario local-query
```

Local browser artifact gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=100000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-owned-artifact-bytes-100k.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-owned-artifact-bytes-500k.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-owned-artifact-bytes-500k-rerun.json
```

External results:

| Metric | Normal row chunks | Scoped artifacts | Owned bytes |
| --- | ---: | ---: | ---: |
| Rust 500k bootstrap | `6099.68ms` | `4866.87ms` | `4844.13ms` |
| Rust 500k pull request | `1031ms` | `23ms` | `22ms` |
| Rust 500k local apply | `1692ms` | `1394ms` | `1379ms` |
| Rust 500k response bytes | `3287104` | `3938823` | `3938884` |
| Rust 500k peak memory | `694.38MB` | `751.45MB` | `750.48MB` |
| Rust 500k snapshot chunks | `9` | `0` | `0` |
| TS 500k bootstrap, same server mode | n/a | `3882.82ms` | n/a |

Local browser artifact A/B:

| Metric | Borrowed bytes | Owned bytes rerun |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `279.54ms` | `280.87ms` |
| `rust_pull_apply_ms` | `262ms` | `263ms` |
| `rust_snapshot_row_apply_ms` | `198ms` | `196ms` |
| `rust_cached_bootstrap_ms` | `249.11ms` | `252.37ms` |
| `browser_js_heap_used_after_bytes` | `8641164` | `6692124` |
| `browser_served_rust_wasm_bytes` | `3443298` | `3443219` |

Decision:

- Retain owned artifact bytes as a small allocation/memory cleanup, not a
  throughput win.
- Scoped artifacts are now proven externally and materially faster than the
  external Rust row-chunk path, but they are not fully accepted as "done"
  because peak memory and transferred bytes are still higher. The next WP-12
  work should reduce artifact memory/bytes without violating scoped manifests.

## 2026-05-19 - Rejected WP-12 SQLite Artifact Page Size 16k

Probe:

- Tried setting the Bun SQLite snapshot artifact encoder page size to `16384`
  before creating the artifact table.

Correctness gates:

```bash
bun test packages/server/src/snapshot-artifacts.test.ts
bun test packages/server/src/pull-snapshot-artifacts.test.ts
bun run --cwd packages/server tsgo
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-sqlite-artifact-page-size-16k-500k.json
```

Compared against
`.context/benchmarks/wp12-owned-artifact-bytes-500k-rerun.json`:

| Metric | Owned bytes | 16k page size |
| --- | ---: | ---: |
| `rust_bootstrap_ms` | `280.87ms` | `279.21ms` |
| `rust_pull_apply_ms` | `263ms` | `263ms` |
| `rust_snapshot_row_apply_ms` | `196ms` | `193ms` |
| `rust_response_bytes` | `4738745` | `5455815` |
| `browser_js_heap_used_after_bytes` | `6692124` | `11229316` |

Decision:

- Rejected and reverted. The tiny apply movement does not matter because bytes
  regressed by about `15%`, and heap was worse in the local gate.

## 2026-05-19 - WP-12 SQLite Artifact Gzip Level 9

Change:

- Bun SQLite snapshot artifacts now default to gzip level `9` instead of `6`.
  Artifact generation is a background/precompute path, not the Worker pull hot
  path, so the retained criterion is lower transfer bytes without losing direct
  SQLite import.

Correctness gates:

```bash
bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts
bun run --cwd packages/server tsgo
```

Local browser artifact gates:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-sqlite-artifact-gzip9-500k.json

bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-sqlite-artifact-gzip9-500k-rerun.json
```

External app-style gate:

```bash
bun run --cwd rust/bindings/browser build:wasm:dev
SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis \
SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=1 \
SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=60000 \
  docker compose -f stacks/syncular/docker-compose.yml up --build -d

export SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1
export SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist
export SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=1
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=60000
bun run bench:run -- --stack syncular-rust --scenario bootstrap
```

Compared against owned bytes / gzip level 6:

| Metric | Gzip 6 | Gzip 9 |
| --- | ---: | ---: |
| Local 500k `rust_bootstrap_ms` | `280.87ms` | `278.95ms` |
| Local 500k `rust_pull_apply_ms` | `263ms` | `260ms` |
| Local 500k `rust_response_bytes` | `4738745` | `4214831` |
| External 500k bootstrap | `4844.13ms` | `4830.08ms` |
| External 500k local apply | `1379ms` | `1392ms` |
| External 500k response bytes | `3938884` | `3527331` |
| External 500k peak memory | `750.48MB` | `758.2MB` |

Retained result files:

- `.context/benchmarks/wp12-sqlite-artifact-gzip9-500k-rerun.json`
- `.results/2026-05-19T20-46-54-374Z/syncular-rust/bootstrap.json`

External row-chunk comparison remains important: row chunks were slower
(`6099.68ms`) and had slower local apply (`1692ms`), but still used fewer
response bytes (`3287104`) and lower peak memory (`694.38MB`).

Decision:

- Retained as a byte-reduction slice. It does not solve peak memory, and memory
  remains the next WP-12 target, but it cuts external artifact bytes by about
  `10%` while keeping direct artifact import and `snapshotChunkCount=0`.

## 2026-05-19 - WP-12 Stream Browser Artifact Fetch/Apply

Change:

- The browser pull path no longer downloads and decompresses every SQLite
  snapshot artifact body for a snapshot before applying any of them. It now
  validates artifact refs first, then fetches and applies each artifact body
  inside the existing apply transaction.
- Rollback semantics stay intact: any later fetch/hash/apply error still
  returns through `rollback_apply_batch`, while the happy path retains fewer
  decompressed SQLite images at once.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
  cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown
bun run --cwd rust/bindings/browser build:wasm
bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts \
  --test-name-pattern "SQLite snapshot artifacts|corrupted SQLite snapshot artifact|subscription is revoked"
```

Local browser artifact gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-stream-artifact-apply-500k.json
```

External app-style scoped artifact gate:

```bash
bun run --cwd rust/bindings/browser build:wasm:dev
export SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1
export SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist
export SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACTS=1
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=60000
cd /Users/bkniffler/GitHub/sync/offline-sync-bench
bun run bench:run -- --stack syncular-rust --scenario bootstrap
```

Compared against the retained gzip9 artifact run:

| Metric | Gzip9 batch bodies | Stream artifact apply |
| --- | ---: | ---: |
| Local 500k `rust_bootstrap_ms` | `278.95ms` | `277.4ms` |
| Local 500k `rust_pull_apply_ms` | `260ms` | `258ms` |
| Local 500k `rust_snapshot_row_apply_ms` | `197ms` | `197ms` |
| Local 500k JS heap after | `16853576` | `16451448` |
| External 500k bootstrap | `4830.08ms` | `4845.39ms` |
| External 500k local apply | `1392ms` | `1392ms` |
| External 500k response bytes | `3527331` | `3527317` |
| External 500k peak memory | `758.2MB` | `746.92MB` |

Retained result files:

- `.context/benchmarks/wp12-stream-artifact-apply-500k.json`
- `.results/2026-05-19T20-53-48-877Z/syncular-rust/bootstrap.json`

Decision:

- Retained as a memory-retention cleanup. The external peak-memory movement is
  meaningful enough for the tiny complexity reduction, but it is not a full
  solution: scoped artifacts remain above the row-chunk memory baseline
  (`746.92MB` versus `694.38MB`).

## 2026-05-19 - Rejected WP-12 Nullable Column Elision

Probe:

- Tried omitting nullable SQLite artifact columns when every row in the artifact
  page had `null` for that column.
- The client already builds `INSERT ... SELECT` from artifact table columns, so
  the shape was semantically plausible, but the current browser store's
  attached-table column introspection did not support missing artifact columns.
  A supporting attached-schema PRAGMA fix was therefore tested as well.

Correctness gates:

```bash
bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts
bun run --cwd packages/server tsgo
cargo fmt --manifest-path rust/Cargo.toml --all
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
  cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown
bun run --cwd rust/bindings/browser build:wasm
bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts \
  --test-name-pattern "SQLite snapshot artifacts|corrupted SQLite snapshot artifact|subscription is revoked"
```

Benchmarks:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-elide-null-artifact-columns-500k.json

cd /Users/bkniffler/GitHub/sync/offline-sync-bench
bun run bench:run -- --stack syncular-rust --scenario bootstrap
```

Compared against the retained stream-apply baseline:

| Metric | Stream baseline | Nullable column elision |
| --- | ---: | ---: |
| Local 500k `rust_bootstrap_ms` | `277.4ms` | `289.26ms` |
| Local 500k `rust_pull_apply_ms` | `258ms` | `270ms` |
| Local 500k `rust_response_bytes` | `4214831` | `4407824` |
| External 500k bootstrap | `4845.39ms` | `5641.22ms` |
| External 500k local apply | `1392ms` | `1567ms` |
| External 500k response bytes | `3527317` | `3527361` |
| External 500k peak memory | `746.92MB` | `745.73MB` |

Decision:

- Rejected and reverted. The external memory improvement was only `1.19MB`,
  while local and external apply/bootstrapping regressed and local compressed
  bytes worsened.

## 2026-05-19 - Rejected WP-12 Attached PRAGMA Schema Fix In Hot Path

Probe:

- Tested changing browser SQLite artifact column discovery from
  `{schema}.pragma_table_info(table)` to the two-argument
  `pragma_table_info(table, schema)` form. This was required by the nullable
  column elision probe because the existing query resolves to the main table
  shape for attached artifact DBs.

Benchmark:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-attached-pragma-schema-fix-500k.json

cd /Users/bkniffler/GitHub/sync/offline-sync-bench
bun run bench:run -- --stack syncular-rust --scenario bootstrap
```

Compared against the retained stream-apply baseline:

| Metric | Stream baseline | Attached PRAGMA schema fix |
| --- | ---: | ---: |
| Local 500k `rust_bootstrap_ms` | `277.4ms` | `354.1ms` |
| Local 500k `rust_pull_apply_ms` | `258ms` | `330ms` |
| Local 500k `rust_response_bytes` | `4214831` | `4214831` |
| External 500k bootstrap | `4845.39ms` | `6118.45ms` |
| External 500k local apply | `1392ms` | `1705ms` |
| External 500k response bytes | `3527317` | `3527353` |
| External 500k peak memory | `746.92MB` | `755.36MB` |

Decision:

- Rejected and reverted. It is a correctness support path for future variable
  artifact schemas, but it regresses the current hot path and nullable column
  elision was also rejected.

## 2026-05-19 - Rejected WP-12 100k SQLite Artifact Bundle Cap

Probe:

- Raised the server binary snapshot bundle cap from `50k` to `100k` rows, while
  keeping the browser client's logical snapshot page at `50k`.
- This is different from the older rejected 100k client-page probe: the client
  still requested `limitSnapshotRows=50000`, while artifact precompute used
  `100000` rows so server lookup selected larger two-page artifact bundles.

Correctness gates:

```bash
bun test packages/server/src/pull-snapshot-artifacts.test.ts packages/server/src/snapshot-artifacts.test.ts
bun run --cwd packages/server tsgo
```

Benchmarks:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=100000 \
  --rust-snapshot-rows-per-page=50000 \
  --output=.context/benchmarks/wp12-artifact-bundle-100k-500k.json

cd /Users/bkniffler/GitHub/sync/offline-sync-bench
export SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=100000
bun run bench:run -- --stack syncular-rust --scenario bootstrap
```

Compared against the retained 50k stream-apply baseline:

| Metric | 50k bundle baseline | 100k bundle cap |
| --- | ---: | ---: |
| Local 500k `rust_bootstrap_ms` | `277.4ms` | `296.93ms` |
| Local 500k `rust_pull_apply_ms` | `258ms` | `277ms` |
| Local 500k `rust_response_bytes` | `4214831` | `4208349` |
| Local 500k request count | `11` | `6` |
| External 500k bootstrap | `4845.39ms` | `5670.76ms` |
| External 500k local apply | `1392ms` | `1620ms` |
| External 500k response bytes | `3527317` | `3517139` |
| External 500k request count | `10` | `6` |
| External 500k peak memory | `746.92MB` | `776.06MB` |

Decision:

- Rejected and reverted. Larger artifacts reduced request count and bytes
  slightly, but made both apply time and peak memory worse. Keep the `50k`
  bundle cap until a different transaction/import shape can release artifact
  buffers earlier.

## 2026-05-19 - Rejected WP-12 SQLite-Owned Deserialize Buffer

Probe:

- Copied each decompressed SQLite artifact body into memory allocated with
  `sqlite3_malloc64`, then called `sqlite3_deserialize` with
  `SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_READONLY`.
- This allowed SQLite to own the deserialized buffer and removed the explicit
  Rust `Vec<u8>` retention in `AttachedSnapshotArtifact`, but it introduced a
  transient copy and still could not release the attached DB before transaction
  commit.

Correctness gates:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
  cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown
bun run --cwd rust/bindings/browser build:wasm
bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts \
  --test-name-pattern "SQLite snapshot artifacts|corrupted SQLite snapshot artifact|subscription is revoked"
```

Benchmarks:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=500000 --query-iterations=0 --wasm-profile=release \
  --sync-snapshot-artifacts --sync-snapshot-artifact-row-limit=50000 \
  --output=.context/benchmarks/wp12-sqlite-owned-deserialize-buffer-500k.json

cd /Users/bkniffler/GitHub/sync/offline-sync-bench
bun run bench:run -- --stack syncular-rust --scenario bootstrap
```

Compared against the retained stream-apply baseline:

| Metric | Stream baseline | SQLite-owned buffer |
| --- | ---: | ---: |
| Local 500k `rust_bootstrap_ms` | `277.4ms` | `304.59ms` |
| Local 500k `rust_pull_apply_ms` | `258ms` | `287ms` |
| Local 500k `rust_response_bytes` | `4214831` | `4214831` |
| Local 500k JS heap after | `16451448` | `16226040` |
| External 500k bootstrap | `4845.39ms` | `5682.5ms` |
| External 500k local apply | `1392ms` | `1617ms` |
| External 500k response bytes | `3527317` | `3527346` |
| External 500k peak memory | `746.92MB` | `746.81MB` |

Decision:

- Rejected and reverted. Peak memory barely moved, while both local and
  external bootstrap/apply regressed. The retained-buffer problem is not solved
  by transferring ownership of the same backing bytes to SQLite; it needs a
  transaction/import shape that can actually detach or release artifact DBs
  earlier.
