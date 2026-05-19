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
