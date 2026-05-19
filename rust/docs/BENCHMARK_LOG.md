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
