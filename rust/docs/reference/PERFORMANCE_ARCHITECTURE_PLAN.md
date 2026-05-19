# Rust Client Performance Architecture Plan

Reference note: this file preserves performance architecture detail. Current
benchmark gates live in [`../QUALITY_GATES.md`](../QUALITY_GATES.md), retained
measurements live in [`../BENCHMARK_LOG.md`](../BENCHMARK_LOG.md), and active
work packages live in [`../work-packages/`](../work-packages/).

## Goal

Make the Rust client win on its own architecture instead of matching the TypeScript client implementation detail for detail. The current Rust WASM path is now functional and benchmarked. Release WASM is the relevant browser baseline; dev WASM is useful for local correctness but overstates apply/decompress costs by a large margin.

- Snapshot chunk decode is no longer the dominant browser Rust cost on the
  binary path: the latest 500k-row local runs report near-zero
  `snapshotChunkDecodeMs`.
- SQLite WASM apply is still the dominant 500k-row browser Rust client-side
  cost in release WASM, but is now around 490ms in the current browser E2E
  harness on battery-saver runs.
- Aggregate queries scan/group 100k rows and are around 10x slower than TS/native SQLite.

## Current Baseline

Latest measured Rust results:

- Browser Rust-owned SQLite bootstrap 500k: ~1.10s in the local Hono/release
  WASM harness with binary snapshot chunks and binary sync-pack responses.
- Browser Rust-owned SQLite bootstrap 500k in dev WASM: ~2.57s after the same
  binary apply improvements.
- Bootstrap 500k peak memory: ~680-700MB.
- Local list/search p50: <1ms.
- Local aggregate p50: ~59ms.

The biggest already-landed wins were:

- WebCrypto SHA-256 for snapshot chunk verification.
- Page-by-page snapshot apply to avoid retaining all decoded rows.
- Batched transactions and reusable multi-row upsert statements.
- Borrowed binary snapshot payload streaming into SQLite binds, avoiding full
  `serde_json::Value`/row-map materialization on the browser fast path.
- Benchmark pull options that disable snapshot row and changed-row collection when not needed.
- Transport/apply timing metrics so each bucket is visible.

## Measurement Gate

Every performance-oriented change must be measured before it stays in the
branch:

- Run the relevant benchmark before and after the change, using the same
  harness, row counts, feature flags, WASM profile, and machine conditions as
  much as possible.
- Record the exact command, before/after numbers, and affected timing buckets
  in this plan.
- Every retained or rejected benchmark note must include the previous accepted
  baseline, the candidate/result number, and the delta in ms/percent. Raw
  absolute benchmark numbers without a baseline comparison are not actionable.
- Branch-server validation must use the external app-style benchmark in
  `/Users/bkniffler/GitHub/sync/offline-sync-bench` for batches that are
  expected to affect real bootstrap/local-query/online/reconnect behavior.
  Performance conclusions must use release WASM; dev WASM is useful for quick
  correctness but overstates Rust apply/query costs too much. Rebuild the
  current branch server image and release Rust WASM first:

  ```bash
  cd /Users/bkniffler/GitHub/sync/offline-sync-bench

  bun run --cwd /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser build:wasm

  SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis \
    docker compose -f stacks/syncular/docker-compose.yml up --build -d
  ```

  Then run TS first and Rust second:

  ```bash
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

  Results are written to `.results/<runId>/<stack>/<scenario>.json`.
  Recent TS `online-propagation` and `reconnect-storm` runs can fail or hang
  with snapshot chunk integrity mismatches; use per-command timeouts and keep
  Rust-only results for those scenarios when the TS pair is invalid.
  `build:wasm:dev` can still be used for faster edit/test cycles, but it must
  not be used to decide whether the Rust architecture is slower or faster.
- Browser E2E scoreboard supports local baseline comparison:
  `--baseline=<path>` prints previous/current/delta for target metrics, and
  `--update-baseline` writes the current report as the new accepted baseline.
  It also supports `--fail-on-regression`, which exits non-zero when a
  Rust/package metric regresses beyond both the absolute and percentage noise
  thresholds. The gate intentionally ignores TS control metrics because they
  can drift with the machine; TS values remain printed for context.
  Latest gate validation:
  `bun ../../../tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --baseline=../../../.context/benchmarks/browser-e2e-incremental-realtime-baseline.json --fail-on-regression`
  passed. Key deltas: `rust_incremental_pull_ms` `12.58 -> 12.09`,
  `rust_incremental_pull_apply_ms` `3 -> 2`,
  `rust_realtime_live_p95_ms` `68.34 -> 71.83` stayed under the absolute gate,
  realtime HTTP fallback stayed `0`, and served package bytes were unchanged.
  Follow-up normal-power validation after the websocket flow-control slice:
  the 100k guardrail failed both with flow-control enabled and with the new
  path disabled via `SYNC_WS_MAX_IN_FLIGHT=0`, so the bootstrap/apply drift is
  not attributed to battery mode or to flow-control. Disabled 100k control:
  `rust_bootstrap_ms` `138.04 -> 145.93`; first enabled run was similar at
  `138.04 -> 146.67`. Realtime same-session control also showed no benefit to
  disabling the new path: disabled `rust_realtime_live_ms` `66.76 -> 79.63`,
  enabled `66.76 -> 73.38`; both kept realtime HTTP fallback at `0`. Do not
  update the accepted baseline from these runs.
  The target metric list covers bootstrap/apply, read p50s, incremental
  pull/apply/decode, websocket realtime delivery/fallback counters, heap, and
  served package size so a candidate cannot improve one lane while silently
  breaking another.
  Current local accepted baselines:
  - 500k bootstrap-only:
    `.context/benchmarks/browser-e2e-500k-baseline.json`
    created with
    `SYNCULAR_BROWSER_PERF_ROWS=500000 bun ../../../tests/runtime/scripts/browser-e2e-scoreboard.ts --query-iterations=0 --baseline=../../../.context/benchmarks/browser-e2e-500k-baseline.json --update-baseline`.
    Baseline highlights: `rust_bootstrap_ms=593.35`,
    `rust_pull_apply_ms=322`, `rust_snapshot_chunk_apply_ms=275`,
    `rust_cached_bootstrap_ms=317.31`,
    `browser_served_rust_wasm_bytes=3326638`.
  - 100k full/read guardrail:
    `.context/benchmarks/browser-e2e-100k-baseline.json`
    created with
    `bun ../../../tests/runtime/scripts/browser-e2e-scoreboard.ts --baseline=../../../.context/benchmarks/browser-e2e-100k-baseline.json --update-baseline`.
    Baseline highlights: `rust_bootstrap_ms=138.04`,
    `rust_pull_apply_ms=73`, `rust_snapshot_chunk_apply_ms=62`,
    `rust_cached_bootstrap_ms=68.43`, `rust_local_list_p50_ms=0.27`,
    `rust_local_search_p50_ms=1.39`, `rust_aggregate_p50_ms=22.06`.
  - 10k + 1k incremental/realtime guardrail:
    `.context/benchmarks/browser-e2e-incremental-realtime-baseline.json`
    created with
    `bun ../../../tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --baseline=../../../.context/benchmarks/browser-e2e-incremental-realtime-baseline.json --update-baseline`.
    Baseline highlights: `rust_bootstrap_ms=31.84`,
    `rust_incremental_pull_ms=12.58`,
    `rust_incremental_pull_apply_ms=3`,
    `rust_incremental_sync_pack_decode_ms=2`,
    `rust_realtime_live_ms=66.76`,
    `rust_realtime_http_request_count=0`,
    `rust_realtime_binary_events=15`,
    `browser_served_rust_wasm_bytes=3326638`.
  - Baseline comparison smoke run, 100k full/read guardrail:
    `bun ../../../tests/runtime/scripts/browser-e2e-scoreboard.ts --baseline=../../../.context/benchmarks/browser-e2e-100k-baseline.json`
    printed the expected delta table. Key deltas versus the accepted baseline:
    `rust_bootstrap_ms` `138.04 -> 137.71` (`-0.33ms`, neutral),
    `rust_pull_apply_ms` `73 -> 73`, `rust_snapshot_chunk_apply_ms`
    `62 -> 61`, `browser_served_rust_wasm_bytes` unchanged.
  - Baseline comparison smoke run, incremental/realtime guardrail:
    `bun ../../../tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --baseline=../../../.context/benchmarks/browser-e2e-incremental-realtime-baseline.json`
    printed incremental/realtime deltas. Key deltas versus the accepted
    baseline: `rust_incremental_pull_ms` `12.58 -> 12.70`
    (`+0.12ms`, neutral), `rust_incremental_pull_apply_ms` `3 -> 2`,
    `rust_realtime_live_ms` `66.76 -> 66.94` (`+0.18ms`, neutral),
    `rust_realtime_http_request_count` stayed `0`, and served package bytes
    were unchanged.
- Commit improvements separately with the benchmark evidence in the commit
  message.
- Revert or discard changes that do not improve the target metric unless they
  are required for correctness, in which case the regression must be explicit
  and justified.
- Negative experiments stay documented only as measurements and rationale, not
  as retained runtime code.
- Retained generator fix: `syncular-codegen` now introspects app-defined
  SQLite indexes, carries them through the stable schema JSON, and replays them
  in the generated TypeScript browser schema installer. This does not create
  hidden indexes; apps must still choose indexes in migrations.
- Rejected default/example app-index migration: adding scope/read indexes to
  the todo example improved the 100k aggregate query from `22.88ms -> 7.88ms`,
  but regressed Rust bootstrap `148.13ms -> 228.13ms`, pull apply
  `79ms -> 154ms`, and snapshot chunk apply `66ms -> 142ms`. The write/apply
  regression is too large for a default schema change, so the migration was
  removed and only the generator capability was kept.
- Retained SQLite read statement binding cleanup: cached read statements now
  skip `sqlite3_clear_bindings` when every SQL parameter is rebound, while
  preserving the previous clear-to-null behavior for under-bound statements.
  100k comparison against `.context/benchmarks/browser-e2e-100k-before-next.json`:
  Rust bootstrap `148.13ms -> 144.80ms`, pull apply `79ms -> 77ms`,
  snapshot chunk bind `38ms -> 35ms`, local list p50 `0.27ms -> 0.25ms`,
  local search p50 `1.69ms -> 1.50ms`, aggregate p50 `22.88ms -> 23.71ms`,
  and Rust WASM size `3,326,638 -> 3,326,667` bytes.
- Retained protocol cleanup: binary-table snapshot clients no longer receive
  small bootstrap snapshots as inline JSON rows on resync/cursor-repair paths.
  JSON clients can still use inline rows, but binary clients now consistently
  get binary chunks. 100k comparison against the immediately previous
  skip-clear run was effectively neutral for first bootstrap:
  Rust bootstrap `144.80ms -> 146.94ms`, pull apply `77ms -> 79ms`,
  snapshot chunk apply `64ms -> 66ms`, served bytes unchanged. The change is
  kept for protocol cleanliness rather than first-bootstrap speed.
- Retained measurement cleanup: server bootstrap timing now splits JSON
  row-frame encoding from binary-table snapshot encoding. The follow-up 100k
  run reported `rust_server_bootstrap_row_frame_encode_ms=0` and
  `rust_server_bootstrap_snapshot_binary_encode_ms=14`, confirming the binary
  path is not doing JSON row-frame encoding during first bootstrap.
- External branch-server evidence from
  `/Users/bkniffler/GitHub/sync/offline-sync-bench` after rebuilding the branch
  server image and Rust WASM, on battery power at 22%:
  - Valid fresh pairs:
    `Bootstrap 100k` TS `774ms`, Rust `1535ms` (`1.98x` slower);
    `Bootstrap 500k` TS `3919ms`, Rust `7934ms` (`2.02x` slower);
    `500k pull request` TS `1172ms`, Rust `1462ms` (`1.25x` slower);
    `500k snapshot fetch` TS `187ms`, Rust `210ms` (`1.12x` slower);
    `500k chunk decode` TS `341ms`, Rust `1ms`;
    `500k local apply` TS `2004ms`, Rust `6249ms` (`3.12x` slower);
    `500k peak memory` TS `482MB`, Rust `727MB` (`1.51x` higher);
    `Local list p50` TS `0.10ms`, Rust `0.57ms`;
    `Local search p50` TS `0.07ms`, Rust `0.89ms`;
    `Aggregate read-model p50` TS `5.47ms`, Rust `0.06ms`;
    `Aggregate raw SQL p50` TS `5.47ms`, Rust `57.08ms`.
  - TS `online-propagation` and `reconnect-storm` failed again with snapshot
    chunk integrity mismatch, so only Rust-only values were valid there:
    online p50 `35.18ms`, online p95 `97.10ms`, reconnect 25 `117.59ms`,
    reconnect 100 `2019.44ms`, reconnect 250 `2079.18ms`.
  - Read: branch-server Rust still shows the same structural profile as the
    earlier feedback: binary decode is gone, while local SQLite apply and raw
    query execution dominate. The much higher apply time compared with the
    local release scoreboard means every retained batch now needs both the
    local scoreboard and the branch-server harness where feasible.
- External branch-server release-WASM sanity check after rebuilding the same
  branch server and using the release artifact in
  `rust/bindings/browser/dist`:
  - Rust 500k bootstrap `3240.29ms`, pull request `1333ms`, snapshot fetch
    `178ms`, pull apply `1902ms`, local apply `1724ms`, chunk decode `0ms`,
    peak memory `791.2MB`.
  - Against the same branch-server TS bootstrap run (`4067.46ms`), Rust release
    WASM is faster on 500k bootstrap (`0.80x`) while still using more peak
    memory (`791.2MB` versus TS `475.2MB`).
  - Rust release local-query: list p50 `0.13ms`, search p50 `0.19ms`,
    read-model aggregate p50 `0.01ms`, raw SQL aggregate p50 `7.68ms`,
    peak memory `459.59MB`.
  - Against the same branch-server TS local-query run, release Rust is faster
    on list (`0.13ms` vs `0.25ms`), slower on search (`0.19ms` vs `0.11ms`),
    close on raw aggregate (`7.68ms` vs `6.18ms`), and much faster with the
    explicit read model (`0.01ms`).
  - Read: the earlier ~8s Rust bootstrap and ~6.4s local apply numbers were
    dev-WASM artifacts. They remain useful for relative A/B checks only when
    both before and after use dev WASM, but they are not an architecture
    verdict.
- Retained API cleanup: Rust web `sync()` now defaults to hydrating snapshot
  rows into local SQLite without returning them in `snapshotRows`. This is the
  clean default for a SQLite-owned runtime and prevents accidental giant result
  payloads in apps. Apps can still opt in with `includeSnapshotRows: true` for
  explicit debug/test flows.
  - Correctness:
    `bun --cwd rust/bindings/browser test src/__tests__/sync-hono.wasm.test.ts`
    passed, including the new Hono/WASM default-behavior test.
  - External branch-server bootstrap, after rebuilding dev WASM and the Docker
    server image:
    TS 500k bootstrap `4067.46ms`, Rust 500k bootstrap `8044.57ms`,
    Rust pull request `1325ms`, Rust snapshot fetch `252ms`, Rust local apply
    `6453ms`, Rust chunk decode `0ms`, Rust peak memory `728.06MB`.
  - External branch-server local-query:
    TS list p50 `0.25ms`, TS search p50 `0.11ms`, TS aggregate p50 `6.18ms`;
    Rust list p50 `0.67ms`, Rust search p50 `0.97ms`, Rust aggregate
    read-model p50 `0.08ms`, Rust aggregate raw SQL p50 `60.15ms`.
  - Read: this is intentionally not counted as a perf win. The external Rust
    adapter already passed `includeSnapshotRows: false` and
    `collectChangedRows: false`, so the branch-server result stays in the same
    band. The retained value is API safety/cleanliness and the new regression
    test.
- Retained browser SQLite result materialization cleanup: `execute_prepared_sql`
  now reads SQLite column names once per statement execution and converts row
  text using SQLite byte lengths directly, instead of rebuilding column metadata
  and doing name lookups for every returned row.
  - External branch-server Rust local-query before:
    list p50 `0.67ms`, search p50 `0.97ms`, read-model aggregate p50
    `0.08ms`, raw SQL aggregate p50 `60.15ms`.
  - External branch-server Rust local-query after:
    list p50 `0.58ms` (`-0.09ms`, `-13.4%`), search p50 `0.81ms`
    (`-0.16ms`, `-16.5%`), read-model aggregate p50 `0.06ms`,
    raw SQL aggregate p50 `57.25ms` (`-2.90ms`, `-4.8%`).
  - Local release-WASM 100k scoreboard guardrail, two runs against
    `.context/benchmarks/browser-e2e-100k-baseline.json`:
    run 1 list p50 `0.27ms`, search p50 `1.47ms`, aggregate p50 `21.78ms`;
    run 2 list p50 `0.25ms`, search p50 `1.39ms`, aggregate p50 `22.81ms`.
    Bootstrap/apply stayed neutral: `rust_pull_apply_ms` `73ms` in both runs;
    snapshot chunk apply `59ms` / `62ms` versus baseline `62ms`.
  - Package impact: release WASM grew `3,326,638 -> 3,327,561` bytes
    (`+923` bytes, `+0.03%`), still under the configured size budget.
  - Read: this is deliberately not a hidden query cache. It removes repeated
    per-row metadata work in the generic result converter while preserving the
    same JSON result shape.
- Rejected snapshot batch-size increase:
  - Candidate: raise `SNAPSHOT_UPSERT_BATCH_ROWS` from `2048` to `4096`.
    100k same-session comparison against
    `.context/benchmarks/browser-e2e-100k-before-next.json` improved first
    bootstrap `148.13 -> 141.81` and bind `38 -> 33`, but regressed cached
    pull apply `68 -> 72`, cached snapshot apply `58 -> 62`, and heap delta
    was much higher. Not retained.
  - Candidate: lower the raised cap to `3072`. 100k improved
    `rust_bootstrap_ms` `148.13 -> 143.34`, `rust_pull_apply_ms` `79 -> 76`,
    and `rust_snapshot_chunk_apply_ms` `66 -> 64`, but 500k did not hold.
    500k candidate against accepted baseline: `rust_bootstrap_ms`
    `593.35 -> 611.93`, `rust_pull_apply_ms` `322 -> 334`,
    `rust_snapshot_chunk_apply_ms` `275 -> 286`.
    Same-session 500k control after reverting to `2048` was better than the
    candidate: `rust_bootstrap_ms` `607.68`, `rust_pull_apply_ms` `330`,
    `rust_snapshot_chunk_apply_ms` `284`. Reverted to `2048`.

### Next-Up Performance Priorities

Prepared statement caching is acceptable SQLite hygiene, but it must not
become the main strategy for making the Rust client competitive. Hidden query
result caches are not a Syncular performance plan; they add invalidation
complexity and hide structural overhead that the TypeScript client does not
need to hide.

Next work should prioritize structural fixes:

1. Add sub-bucket timing for Rust browser apply and local query execution so
   every change can be judged against the actual hot stage, not just total
   bootstrap time.
2. Make snapshot apply generated and table-specific: binary chunk ->
   schema-ordered typed values -> positional SQLite binds, without generic
   object maps or `serde_json::Value` on the hot path.
3. Keep prepared statement reuse where it is simple and measurable, but reject
   cache bookkeeping that does not improve the benchmark.
4. Avoid JSON/object result materialization across the JS/WASM boundary for
   generated hot reads. Return lean row arrays or generated typed shapes where
   the API allows it.
5. Treat read models as explicit generated derived state, not hidden query
   caches. The benchmark must keep reporting raw SQL beside read-model paths.
6. Reduce peak memory by ensuring compressed bytes, decompressed chunk bytes,
   decoded row views, and SQLite bind buffers are not retained beyond the
   current apply page.

### Drastic Performance Experiments

These are the next structural attempts now that release WASM shows the Rust
client can beat TS on 500k bootstrap, but local apply, memory, and some raw
query lanes still need work. Each attempt must run the local release scoreboard
and the external `/Users/bkniffler/GitHub/sync/offline-sync-bench` TS/Rust
comparison before it is retained. If the change does not improve the target
bucket without a worse total result, remove it and keep only the measurement
note here.

1. **Defer derived SQLite work during snapshot bootstrap.** Create base app
   tables before bootstrap, bulk-apply the snapshot, then create app indexes,
   triggers, and read models after the snapshot has landed. This tests whether
   per-row index/trigger maintenance is still hiding in local apply. The
   measured bootstrap wall time must include the post-bootstrap index/read-model
   build, otherwise the result is not fair.
2. **Generated bulk-import phases.** Use generated schema phases for app
   tables: base DDL, snapshot import, derived DDL/read-model rebuild, steady
   triggers. This is the proper implementation path if experiment 1 wins; no
   generic "drop all indexes" fallback should be added.
3. **SQLite changeset/delta apply.** Investigate SQLite session/changeset-style
   binary deltas for incremental sync once bootstrap is structurally cleaner.
   Target metrics are incremental pull/apply and realtime catch-up, not first
   bootstrap.
4. **Server-generated SQLite snapshot artifacts.** For very large first sync,
   evaluate serving a prebuilt tenant/scope SQLite artifact or attachable
   database page set instead of replaying rows. This is a protocol/server
   architecture change and only worth keeping if it cuts 500k+ bootstrap wall
   time and peak memory materially.
5. **Generated typed read result paths.** Keep Kysely/SQL semantics, but avoid
   generic JSON result materialization for generated hot reads where the host
   can accept typed arrays/columnar rows. This must not become a hidden query
   result cache.
6. **Streaming memory ceiling pass.** Add explicit peak-memory probes around
   fetch, decompression, chunk apply, and query result materialization, then
   remove retained buffers. Accept only changes that lower 500k peak memory or
   keep memory flat while improving wall time.

Experiment 1 result: retain the generated-schema phase API and keep pursuing
derived-schema deferral for app bootstrap.

- External `/Users/bkniffler/GitHub/sync/offline-sync-bench` probe split the
  Rust adapter into base table creation before snapshot apply and derived
  indexes/triggers/read-model rebuild after snapshot apply. Bootstrap wall time
  includes the post-bootstrap derived build.
- Previous accepted release-WASM branch-server Rust bootstrap:
  100k `648.54ms`, 500k `3240.29ms`, 500k local apply `1724ms`, 500k peak
  memory `791.2MB`.
- Candidate release-WASM branch-server Rust bootstrap:
  100k `557.93ms` (`-90.61ms`, `-14.0%`), 500k `2714.76ms`
  (`-525.53ms`, `-16.2%`), 500k local apply `382ms` (`-1342ms`, `-77.8%`),
  post-bootstrap derived-schema rebuild `883.28ms`, 500k peak memory
  `732.33MB` (`-58.87MB`, `-7.4%`).
- Same-run TS branch-server bootstrap for context: 100k `818.12ms`, 500k
  `3669.48ms`, 500k local apply `1960.4ms`, 500k peak memory `493.55MB`.
  Candidate Rust 500k bootstrap is `0.74x` TS wall time but still `1.48x` TS
  peak memory.
- Local-query rerun after one outlier: previous Rust release local-query
  `bootstrap=746.09ms`, `list=0.13ms`, `search=0.19ms`,
  `read_model_aggregate=0.01ms`, `raw_aggregate=7.68ms`,
  `peak_memory=459.59MB`; candidate rerun `bootstrap=902.04ms`,
  `list=0.15ms`, `search=0.21ms`, `read_model_aggregate=0.02ms`,
  `raw_aggregate=9.67ms`, `peak_memory=458.95MB`. Read latency is close enough
  for the large bootstrap win; planner analysis remains a separate measured
  maintenance step.
- Normal local release scoreboard after the codegen API change:
  Rust 100k bootstrap `148.18ms` vs accepted `138.04ms`, pull apply `79ms`
  vs `73ms`, snapshot chunk apply `66ms` vs `62ms`; TS bootstrap also drifted
  `722.67ms -> 805.47ms`. This is treated as no perf conclusion for the
  codegen-only API change; the runtime/default installer path is unchanged.
  The 500k local release guardrail similarly stayed in the same noisy band:
  Rust bootstrap `643.44ms` vs accepted `593.35ms`, pull apply `354ms` vs
  `322ms`, snapshot chunk apply `302ms` vs `275ms`; TS bootstrap drifted
  `3408.88ms -> 3652.18ms`. Served Rust WASM stayed at `3,327,561` bytes.
- External online/reconnect lanes after the same branch-server rebuild:
  TS `online-propagation` and `reconnect-storm` both failed with snapshot chunk
  integrity mismatches, so no valid TS/Rust pair exists for this batch. Rust-only
  online propagation completed with mirror visible p50 `16.53ms`, p95
  `28.72ms`, write ack `6.26ms`. Rust-only reconnect completed with 25 clients
  `96.10ms`, 100 clients `2025.87ms`, and 250 clients `2031.52ms`.
- Retained implementation slice: generated TypeScript now exports
  `ensureSyncularAppBaseSchema` and `ensureSyncularAppDerivedSchema`, while
  `ensureSyncularAppSchema` remains the full installer by composing both. The
  default generated client still installs the full schema up front; apps can
  opt into base -> snapshot sync -> derived for large initial bootstrap.
- Rejected default `ANALYZE` inside the derived-schema phase. External Rust
  branch-server candidate with `ANALYZE` improved local-query p50s versus the
  no-ANALYZE deferred probe (`list 0.15ms -> 0.09ms`, `search 0.21ms ->
  0.15ms`, `raw aggregate 9.67ms -> 7.60ms`), but regressed 500k bootstrap
  `2714.76ms -> 2987.44ms` (`+272.68ms`, `+10.0%`) and derived build
  `883.28ms -> 1102.95ms`. Keep planner analysis as a possible explicit app
  maintenance step, not the default first-bootstrap path.
- Retained generated app API ergonomics for the deferred schema flow:
  generated TypeScript now accepts `schemaInstallMode: 'full' | 'base' |
  'none'` on `createSyncularAppDatabase`, defaults to `'full'`, and exports
  `finalizeSyncularAppDatabaseSchema(database)` for the post-bootstrap derived
  phase. The intended large-bootstrap app flow is:
  create with `schemaInstallMode: 'base'`, run initial `syncOnce()` or the app
  bootstrap loop, then call `finalizeSyncularAppDatabaseSchema`.
  - Correctness: `cargo test --manifest-path rust/Cargo.toml -p
    syncular-codegen` and `bun run --cwd rust/bindings/browser tsgo` passed.
  - Normal local 100k release scoreboard after the API addition stayed neutral:
    Rust bootstrap `138.04ms -> 138.34ms` (`+0.31ms`, `+0.22%`), pull apply
    `73ms -> 74ms`, snapshot chunk apply `62ms -> 62ms`; TS bootstrap
    `722.67ms -> 746.10ms`.
  - External branch-server rerun with the same deferred-schema adapter stayed in
    the accepted band: Rust 500k bootstrap `2714.76ms -> 2865.02ms`
    (`+150.26ms`, `+5.5%`), local apply `382ms -> 408ms`, derived build
    `883.28ms -> 944.63ms`, peak memory `732.33MB -> 734.70MB`. Same-run TS
    500k bootstrap was `3857.29ms`, so Rust remained `0.74x` TS wall time.
    Rust local-query p50s were `list=0.12ms`, `search=0.18ms`,
    `read_model_aggregate=0.01ms`, `raw_aggregate=7.90ms`.
- Rejected external branch-server page-size increase from `20_000` to `50_000`
  rows/page. This matched the local browser scoreboard setting but made the
  external app harness much worse: Rust 500k bootstrap `2865.02ms ->
  4717.23ms` (`+1852.21ms`, `+64.6%`), pull request `1350ms -> 2444ms`,
  pull apply `565ms -> 1135ms`, local apply `408ms -> 822ms`, derived build
  `944.63ms -> 1132.07ms`, and peak memory `734.70MB -> 763.63MB`.
  Request count, chunk count, and response bytes were effectively unchanged, so
  the regression is not explained by fewer network round trips. Keep the
  external Rust benchmark at `20_000` rows/page until a dedicated server
  snapshot artifact/streaming design replaces row-page pulls.
- Added external server timing capture to the Rust bench harness. Latest valid
  500k branch-server run (`.results/2026-05-18T13-05-46-822Z`) reports Rust
  bootstrap `2675.14ms`, pull request `1218ms`, pull apply `568ms`, local apply
  `394ms`, derived schema `884.34ms`, snapshot fetch `174ms`, server snapshot
  query `497ms`, server binary encode `573ms`, chunk cache lookup `10ms`, gzip
  `64ms`, hash `2ms`, persist `50ms`, and peak memory `736.91MB`. This shifts
  the next big target away from client row apply and toward server snapshot
  query/encoding and reusable snapshot artifacts.
- Rejected generated trusted-writer methods for binary snapshot encoding. The
  candidate skipped per-cell writer validation/nullability checks and generated
  calls to `writeTrustedString`, `writeTrustedInteger`, `writeTrustedJson`, and
  `writeTrustedNull`. Correctness checks passed, but the local 100k release
  scoreboard regressed Rust bootstrap `138.04ms -> 144.05ms` (`+6.01ms`,
  `+4.35%`), pull apply `73ms -> 76ms`, snapshot chunk apply `62ms -> 65ms`,
  and did not improve server binary encode. Keep the public writer API small
  until profiling shows validation checks are a real bottleneck.
- Rejected generated streaming binary snapshot appenders. The candidate added a
  patchable binary table writer plus generated `append*BinarySnapshotRows`
  functions so the server could append pages directly instead of retaining
  `binaryRows` until bundle flush. Correctness checks passed
  (`cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`,
  `bun test packages/core/src/__tests__/snapshot-chunks.test.ts
  tests/unit/server-pull.test.ts`, `bun run --cwd rust/bindings/browser tsgo`),
  but the 100k local release scoreboard regressed Rust bootstrap
  `138.04ms -> 142.78ms` (`+4.74ms`, `+3.43%`) and 500k stayed inside noise
  without improving the external branch-server path, because that app does not
  currently provide generated binary metadata/appender hooks. Revert the API;
  revisit only as part of a full server-generated snapshot artifact design.
- Retained binary snapshot chunk cache-key fix. Cache lookup now uses the same
  planned binary bundle row limit that chunk persistence uses, rounded to whole
  snapshot pages. This fixes large page sizes such as `limitSnapshotRows >
  DEFAULT_MAX_BINARY_SNAPSHOT_BUNDLE_ROWS`, where the second bootstrap could
  miss the cache and re-run snapshot query/encode. Unit coverage proves a
  `60_000` row page size hits cache on the second pull without calling the
  snapshot function. Local benchmark impact is neutral for first bootstrap:
  100k Rust bootstrap `138.04ms -> 146.05ms` while TS drifted
  `722.67ms -> 791.52ms`; 500k Rust bootstrap `593.35ms -> 651.77ms` while TS
  drifted `3408.88ms -> 3759.75ms`. The retained target is cached/artifact
  correctness: 500k cached server snapshot query and binary encode are both
  `0ms`, with cached pull request `2ms`.
  - External branch-server bootstrap validation after rebuilding the branch
    server image and release Rust WASM: TS 500k `3857.29ms -> 4051.71ms`
    (`+194.42ms`, `+5.0%`), Rust 500k `2675.14ms -> 2926.37ms`
    (`+251.23ms`, `+9.4%`), Rust pull request `1218ms -> 1390ms`, server
    snapshot query `497ms -> 573ms`, server binary encode `573ms -> 648ms`,
    local apply `394ms -> 404ms`, derived schema `884.34ms -> 960.44ms`, and
    peak memory `736.91MB -> 738.17MB`. This validates that the fix should not
    be claimed as first-bootstrap speed; it stays because it makes cached
    snapshot artifacts addressable by the same row-limit key that produced
    them.
- Rejected TextEncoder-only binary string writes. Removing the ASCII direct
  write path from `writeString32` made the 100k local release scoreboard worse:
  Rust bootstrap `138.04ms -> 150.68ms` (`+12.64ms`, `+9.15%`), pull request
  `63ms -> 74ms`, and server binary encode rose to `24ms` versus the preceding
  cache-key run's `16ms`. Keep the direct ASCII writer; per-string
  `TextEncoder` allocation is not a win for the current snapshot payload.
- Retained generic binary snapshot column inference cleanup. The server generic
  binary encoder now counts column presence during the first row scan instead
  of doing a second `rows × columns` pass with `Object.hasOwn` only to mark
  missing fields nullable. This targets custom snapshot handlers that do not
  provide generated binary columns/encoders, which is exactly the current
  external branch-server app path. Correctness:
  `bun test packages/core/src/__tests__/snapshot-chunks.test.ts
  tests/unit/server-pull.test.ts` and
  `bun run --cwd rust/bindings/browser tsgo` passed. Local generated-encoder
  100k guardrail stayed neutral: Rust bootstrap `138.04ms -> 137.27ms`,
  pull request `63ms -> 62ms`, and server binary encode `17ms`. External
  branch-server 500k improved materially versus the immediately previous
  cache-key run: Rust bootstrap `2926.37ms -> 2547.95ms` (`-378.42ms`,
  `-12.9%`), pull request `1390ms -> 1112ms`, server binary encode
  `648ms -> 472ms`, server snapshot query `573ms -> 504ms`, local apply
  `404ms -> 399ms`, derived schema `960.44ms -> 862.79ms`, and peak memory
  `738.17MB -> 737.09MB`. Same-run TS 500k was `3740.24ms`, so Rust was
  `0.68x` TS wall time for this run.
- Retained no-allocation generic inference property iteration. Replacing
  `Object.entries(row)` with an own-property loop avoids allocating an entries
  array for every row in the same generic binary inference path. Correctness
  checks stayed green (`bun test packages/core/src/__tests__/snapshot-chunks.test.ts
  tests/unit/server-pull.test.ts`, `bun run --cwd rust/bindings/browser tsgo`).
  Local generated-encoder 100k guardrail stayed neutral: Rust bootstrap
  `138.04ms -> 138.83ms`, pull request `63ms -> 63ms`, server binary encode
  `15ms`. External branch-server 500k improved again versus the previous
  retained inference cleanup: Rust bootstrap `2547.95ms -> 2463.69ms`
  (`-84.26ms`, `-3.3%`), pull request `1112ms -> 1014ms`, server binary encode
  `472ms -> 367ms`, server snapshot query stayed `504ms`, local apply
  `399ms -> 391ms`, derived schema `862.79ms -> 872.04ms`, and peak memory
  `737.09MB -> 737.50MB`. Same-run TS 500k was `3865.52ms`, so Rust was
  `0.64x` TS wall time for this run.
- Retained precomputed generic binary value writers. `encodeBinarySnapshotTable`
  now builds per-column value writers once per chunk instead of switching on
  column type and constructing label strings for every cell. This only targets
  the generic encoder; generated table writers remain the preferred hot path.
  Correctness checks stayed green (`bun test
  packages/core/src/__tests__/snapshot-chunks.test.ts tests/unit/server-pull.test.ts`,
  `bun run --cwd rust/bindings/browser tsgo`). Local generated-encoder 100k
  guardrail was noisy and not used as the target conclusion: Rust bootstrap
  `138.04ms -> 148.36ms` while TS also drifted `722.67ms -> 777.09ms`; server
  binary encode stayed `15ms`. External branch-server 500k improved modestly
  versus the previous retained property-loop run: first candidate
  `2463.69ms -> 2418.98ms`, server binary encode `367ms -> 356ms`; confirm
  Rust-only run was `2441.75ms` total with server binary encode `350ms`, local
  apply `396ms`, derived schema `858.63ms`, and peak memory `736.38MB`. Keep
  this because the code is local to the generic encoder and the measured server
  encode bucket moved in the right direction twice.
- Rejected manual preallocated row validation array in `encodeBinarySnapshotRows`.
  Replacing `rows.map(toSnapshotRecordRow)` with a hand-written indexed loop
  passed correctness checks but made the external branch-server Rust 500k path
  worse: `2418.98ms -> 2708.20ms`, pull request `1002ms -> 1143ms`, server
  binary encode `356ms -> 401ms`, local apply `391ms -> 402ms`, and derived
  schema `866.17ms -> 984.63ms`. Keep the simpler `map` implementation.
- Retained generated server snapshot metadata module. `syncular-codegen` now
  supports `typescriptServerOutputPath` and writes a server-only TypeScript
  artifact with row interfaces, binary snapshot columns, and generated
  snapshot row encoders. Server apps can import this contract without importing
  the browser/client runtime, which is the clean path toward generated server
  binary encoding instead of generic inference. Correctness:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`,
  `bun run --cwd rust/bindings/browser tsgo`, and
  `bun test packages/core/src/__tests__/snapshot-chunks.test.ts
  tests/unit/server-pull.test.ts` passed. Local 100k release scoreboard versus
  `.context/benchmarks/browser-e2e-100k-baseline.json` was perf-neutral/noisy:
  TS bootstrap `722.67ms -> 800.25ms`, Rust bootstrap `138.04ms -> 146.36ms`,
  Rust request count `3 -> 3`, response bytes `765,764 -> 765,764`, server
  binary encode `15ms`, and served Rust WASM bytes stayed at `3,327,561`.
  This is kept as architecture/API groundwork, not as a direct performance win.
- Retained generated snapshot binary server API cleanup. `createServerHandlerCollection`
  and `createSyncRoutes` now accept the generated
  `syncularGeneratedServerSnapshotBinary` contract once and attach matching
  per-table columns/encoders at the handler collection boundary. This removes
  repetitive per-handler wiring and makes generated server encoders the
  obvious path for app servers. Correctness: `bun test
  tests/unit/server-pull.test.ts`, `bun --cwd packages/server tsgo`,
  `bun --cwd packages/server-hono tsgo`, and
  `bun run --cwd rust/bindings/browser tsgo` passed. Local 100k release
  scoreboard versus `.context/benchmarks/browser-e2e-100k-baseline.json` stayed
  neutral: TS bootstrap `722.67ms -> 723.90ms`, Rust bootstrap
  `138.04ms -> 139.32ms`, Rust request count `3 -> 3`, response bytes
  `765,764 -> 765,764`, server binary encode `15ms`, and served Rust WASM
  bytes stayed at `3,327,561`.
- Retained generated browser/server boundary cleanup. The browser TypeScript
  generated client no longer exports server binary snapshot columns or row
  encoders; those live only in the server generated module. This removes
  server-only code from the browser-facing generated API and prevents apps from
  wiring the wrong artifact by habit. Correctness:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`,
  `bun run --cwd rust/bindings/browser tsgo`, and
  `bun test packages/core/src/__tests__/snapshot-chunks.test.ts
  tests/unit/server-pull.test.ts` passed. Local 100k release scoreboard versus
  `.context/benchmarks/browser-e2e-100k-baseline.json` stayed neutral: TS
  bootstrap `722.67ms -> 712.96ms`, Rust bootstrap `138.04ms -> 137.57ms`,
  Rust request count `3 -> 3`, response bytes `765,764 -> 765,764`, and served
  asset bytes stayed unchanged in the benchmark harness. The generated browser
  source itself dropped roughly 100 lines, but no served-size win is claimed
  because the previous exports were already tree-shaken.
- Retained read-side live-event drain removal. Browser worker readonly SQL now
  uses a single request and does not drain live-query events, and the Kysely
  dialect no longer drains live events after every read. Writes, sync, conflict
  commands, CRDT commands, and realtime delivery still drain or post live events
  explicitly. Correctness: `bun --cwd rust/bindings/browser test
  src/worker-client.test.ts src/database.test.ts` and
  `bun run --cwd rust/bindings/browser tsgo` passed. Local 100k release
  scoreboard versus `.context/benchmarks/browser-e2e-100k-baseline.json`
  improved the intended read lane while bootstrap stayed neutral: first run
  Rust list p50 `0.27ms -> 0.20ms`, search p50 `1.39ms -> 1.32ms`,
  bootstrap `138.04ms -> 136.81ms`; confirm run list p50 stayed `0.20ms`,
  search p50 `1.34ms`, bootstrap `141.10ms`. Incremental/realtime guardrail
  stayed stable: realtime p50 `66.76ms -> 66.72ms`, p95
  `68.34ms -> 68.37ms`, HTTP fallback `0 -> 0`, binary events `15 -> 15`.
  External `/Users/bkniffler/GitHub/sync/offline-sync-bench` local-query after
  emitting the updated browser `dist`: TS list/search/aggregate p50
  `0.08ms` / `0.07ms` / `5.22ms`; Rust bootstrap `582.22ms`, list p50
  `0.10ms`, search p50 `0.14ms`, read-model aggregate p50 `0.01ms`, raw SQL
  aggregate p50 `7.40ms`, peak memory `472.27MB`. Against the prior accepted
  release external Rust local-query sample, list improved `0.13ms -> 0.10ms`,
  search `0.19ms -> 0.14ms`, and raw aggregate `7.68ms -> 7.40ms`.
- Rejected conditional live-event drain for write/sync paths when no live
  listeners are registered. Correctness tests passed, but the benchmark did
  not improve versus the accepted read-drain removal above. Two local 100k
  release scoreboard candidate runs measured Rust bootstrap `145.57ms` /
  `146.36ms`, list p50 `0.23ms` / `0.22ms`, search p50 `1.49ms` /
  `1.44ms`, and aggregate p50 `23.44ms` / `23.05ms`; the accepted read-drain
  runs immediately before it were better on the target lanes at bootstrap
  `136.81ms` / `141.10ms`, list p50 `0.20ms` / `0.20ms`, search p50
  `1.32ms` / `1.34ms`, and aggregate p50 `21.84ms` / `22.10ms`. Reverted and
  kept the simpler rule: reads do not drain live events, write/sync paths still
  drain explicitly.
- Rejected second partial-tail snapshot statement cache probe. The candidate
  reused cached multi-row snapshot statements for every batch size, including
  page tail batches, and removed the uncached partial-batch helpers. Local 100k
  release was neutral versus the accepted baseline: Rust bootstrap
  `138.04ms -> 139.26ms`, pull apply `73ms -> 72ms`, snapshot chunk apply
  `62ms -> 61ms`, bind `33ms -> 31ms`, step `24ms -> 26ms`, and WASM size
  `3,326,638 -> 3,326,902` bytes. Same-session 500k showed better client apply
  buckets but worse wall time due unrelated server drift: candidate/control
  bootstrap `688.38ms / 650.81ms`, pull apply `334ms / 359ms`, snapshot apply
  `288ms / 307ms`, cached pull apply `324ms / 347ms`, cached snapshot apply
  `273ms / 296ms`. External branch-server validation did not support keeping
  it against the last retained external bootstrap evidence: Rust 500k
  `2441.75ms -> 2665.04ms`, local apply `396ms -> 405ms`, derived schema
  `858.63ms -> 947.31ms`, server binary encode `350ms -> 394ms`, and peak
  memory `736.38MB -> 737.38MB`. Reverted; this remains below the bar for
  another prepared-statement cache path.

### Required Benchmark Scoreboard

The current gate is policy, not enough coverage by itself. The Rust rewrite
needs a maintained TS-vs-Rust scoreboard that runs the same app schema,
server, dataset, and browser profile for both clients. Every performance
change must identify which scoreboard rows it is expected to move.

Required first-class metrics:

| Area | Required metrics | Current state |
| --- | --- | --- |
| Bootstrap | 100k and 500k wall time | Partly measured ad hoc; not yet a stable Rust-vs-TS gate. |
| Bootstrap buckets | pull request, snapshot fetch, chunk decompress/hash/decode, local apply | Rust exposes buckets; TS comparison is not yet canonical in one report. |
| Payload shape | JSON chunk count, binary chunk count, request count, response bytes | Rust browser harness records this; needs scoreboard output and gating. |
| Local reads | list p50/p95, search p50/p95, aggregate/read-model p50/p95 | Feature benchmark exists for Rust; needs direct TS baseline and identical query definitions. |
| Mutations | local insert/update batch latency, outbox rows, sync push batch latency | Rust native/browser covered partly; needs TS comparison and browser buckets. |
| Realtime | WS propagation p50/p95/p99, ordered wakeup-to-apply latency, HTTP fallback count, binary bytes | Browser E2E scoreboard now has a same-server Rust websocket lane; still needs larger p50/p95/p99 runs and TS-aligned realtime comparison. |
| Reconnect | reconnect 25/100/250 clients, catchup rows, missed wakeups | TS perf has reconnect lanes; Rust stress exists, but scenarios are not aligned. |
| Memory/package | peak browser memory during 500k bootstrap, WASM raw/gzip, loaded JS bytes | WASM size is gated; browser page resource, served asset, and JS heap snapshots now flow through the E2E scoreboard. Peak/worker memory still needs deeper capture. |
| Correctness during perf | final row counts, query result equality, event overflow/recovery count | Some checks exist; scoreboard must make them mandatory for every run. |

Minimum commands after a perf change:

```bash
bun --cwd tests/perf stable-ci
PERF_RUST_ONLY=true PERF_STABLE_RUNS=5 bun --cwd tests/perf stable-ci
PERF_RUST_BROWSER_BENCHMARK=true PERF_RUST_BROWSER_OPERATIONS=50 PERF_RUST_BROWSER_ROUNDS=3 bun run test:perf:rust
bun --cwd rust/bindings/browser run benchmark:browser --wasm-profile=release --feature-workloads --output=.context/benchmarks/browser-feature-workloads.json
```

Large/bootstrap changes additionally require a dedicated browser scoreboard run
that emits TS and Rust rows side by side:

```bash
SYNCULAR_BROWSER_PERF_REQUIRE_RELEASE=true \
SYNCULAR_BROWSER_PERF_ROWS=500000 \
bun --cwd rust/bindings/browser run benchmark:browser:e2e
```

The first `benchmark:browser:e2e` lane now exists. It seeds a same-origin sync
server, runs release-WASM Chromium, bootstraps TS and Rust clients against the
same app table, and emits side-by-side bootstrap, payload, local list/search,
and aggregate metrics. The Rust side also emits pull request, snapshot fetch,
decompress/hash/decode, local apply, request count, payload bytes, and
JSON-vs-binary chunk counts. The harness now records page ResourceTiming
asset/sync bytes, explicit served asset byte sizes for Rust/WASM/wa-sqlite
files, Chromium JS heap snapshots before/after the run, and opt-in server
bootstrap timing buckets from the Hono route. It still needs TS bucket parity,
reconnect, and deeper worker/WASM memory capture.

The E2E scoreboard is also wired into `tests/perf/rust-client.perf.test.ts`
behind `PERF_RUST_BROWSER_E2E_SCOREBOARD=true`, so it can participate in the
same baseline/regression reporting as the Rust perf lane. Its metrics are
optional until stable 100k/500k baselines are established.

The browser E2E scoreboard now also boots a second Rust client against the
same server subscription after the first Rust bootstrap. These
`rust_cached_*` metrics measure whether the server-side snapshot chunk cache is
actually avoiding work for later clients, not just avoiding gzip/hash on the
first generated chunk.

The browser E2E scoreboard also supports `--scope-fanout-users=N`. In that
mode it seeds `rows * N` server rows while keeping `rows` visible to the
benchmark actor. This is the required lane for scope/index work because the
default single-user dataset cannot prove whether scoped server snapshot queries
avoid scanning unrelated tenant data.

The browser E2E scoreboard also supports `--incremental-rows=N`. In that mode
it bootstraps TS and Rust clients, pushes `N` new task rows through the real TS
outbox/server path, resets Rust transport stats, and measures Rust catching up
from the server. The same lane is exposed through
`PERF_RUST_BROWSER_E2E_INCREMENTAL_ROWS` in `tests/perf/rust-client.perf.test.ts`.
This is the required guardrail for sync-pack/delta protocol work because
synthetic codec benches alone do not prove the actual pull/apply path moved.

The same `--incremental-rows=N` lane now also measures steady-state Rust
websocket propagation after the HTTP incremental catch-up. It subscribes a Rust
live query, starts realtime, pushes another `N` rows through the TS
outbox/server path, waits for the live query count to update, and records
`rust_realtime_live_ms`, HTTP fallback request/byte counts, binary realtime
event count, and binary realtime bytes. This is the required guardrail before
any further websocket tuning.

The realtime lane also supports `--realtime-iterations=N` and emits
`rust_realtime_live_p95_ms`, min/max, total TS push time, commit count, binary
event count, and HTTP fallback counters across the repeated pushes.

Measured scoped-server lane:

- No-index scoped baseline, 50k visible rows / 500k seeded rows /
  `--scope-fanout-users=10`: Rust bootstrap `149.87ms`, pull request `88ms`,
  server snapshot query `62ms`, local apply `59ms`.
- Benchmark server scope index on `(user_id, id)`, same lane: Rust bootstrap
  `119.33ms`, pull request `58ms`, server snapshot query `30ms`, local apply
  `59ms`.
- Single-user guardrails stayed neutral after rerun: 100k Rust bootstrap
  `191.02ms -> 190.61ms`; 500k Rust bootstrap `879.14ms -> 869.34ms`.
- Rejected experiment: setting browser SQLite `page_size = 32768` and
  `cache_size = -65536` before schema creation did not help the release-WASM
  in-memory path. The 100k guardrail moved Rust bootstrap
  `190.61ms -> 194.12ms` and local apply `103ms -> 107ms`, so the runtime
  pragma change was discarded.
- Retained change: browser snapshot chunks now use the native
  `DecompressionStream` gzip path when available, with the existing Rust
  `GzDecoder` path as fallback. At 100k, decompression moved `13ms -> 7ms`
  and snapshot fetch `15ms -> 9ms`. At 500k, Rust bootstrap moved
  `869.34ms -> 836.25ms`, snapshot fetch `61ms -> 37ms`, decompression
  `57ms -> 34ms`, and cached bootstrap `492.42ms -> 459.25ms`.
- Retained change: generated browser SQLite schema installers can opt tables
  into `sqliteWithoutRowid`, which emits `CREATE TABLE ... WITHOUT ROWID` for
  app tables whose primary key is a text id. The todo example opts in. In the
  browser E2E lane this moved 100k local apply `101ms -> 94ms`, 100k
  bootstrap `190.32ms -> 183.59ms`, 500k local apply `449ms -> 437ms`, and
  500k bootstrap `836.25ms -> 828.21ms`.
- Rejected experiment: keeping fetched compressed snapshot chunks as JS
  `ArrayBuffer`s through browser-native hash/decompress avoided one Rust copy
  but added WASM code and did not improve the target. The 100k guardrail moved
  Rust bootstrap `183.59ms -> 186.80ms`, local apply `94ms -> 97ms`, and hash
  `1ms -> 2ms`; the transport change was discarded.
- Rejected experiment: lowering server snapshot chunk gzip level from `1` to
  `0` reduced little CPU and made the wire shape much worse. At 100k, response
  bytes moved `765,774 -> 7,079,548`, Rust bootstrap `183.59ms -> 194.50ms`,
  and cached bootstrap `91.39ms -> 108.44ms`; the gzip-level change was
  discarded.

Validated perf-lane smoke:

```bash
PERF_RUST_NATIVE_ROUNDS=1 \
PERF_RUST_NATIVE_WARMUP=1 \
PERF_RUST_BROWSER_E2E_SCOREBOARD=true \
PERF_RUST_BROWSER_E2E_ROWS=100 \
PERF_RUST_BROWSER_E2E_QUERY_ITERATIONS=3 \
bun run test:perf:rust
```

This emitted `rust_browser_e2e_*` metrics through the normal perf regression
table. The latest 100-row smoke reported TS bootstrap `34.4ms`, Rust bootstrap
`13.8ms`, Rust pull request `7.0ms`, Rust snapshot fetch `2.0ms`, Rust local
apply `4.0ms`, Rust response `1.2KiB`, local list p50 TS/Rust
`1.2ms` / `0.4ms`, local search p50 TS/Rust `1.0ms` / `0.4ms`, and aggregate
p50 TS/Rust `1.0ms` / `0.2ms`. It also emitted served asset total
`7332.2KiB`, Rust WASM `3112.7KiB`, wa-sqlite async WASM `1421.4KiB`, loaded
page transfer `1178.4KiB`, sync transfer `39.0KiB`, and JS heap delta
`613.1KiB`.

Validated smoke:

```bash
bun --cwd rust/bindings/browser benchmark:browser:e2e --rows=100 --query-iterations=3 --wasm-profile=release --json
bun --cwd rust/bindings/browser benchmark:browser:e2e --rows=1000 --query-iterations=5 --wasm-profile=release --output=../../../.context/benchmarks/browser-e2e-scoreboard-1k.json
```

The 1k smoke reported:

- TS bootstrap `48.16ms`, Rust bootstrap `19.77ms`.
- Rust pull request `11ms`, snapshot fetch `2ms`, local apply `7ms`.
- Rust binary chunks `1`, JSON chunks `0`, row count `1000`.
- local list p50: TS `1.38ms`, Rust `0.42ms`.
- local search p50: TS `1.18ms`, Rust `0.48ms`.
- aggregate p50: TS `1.35ms`, Rust `0.76ms`.

Architecture iteration: cleared binary snapshot row-delta fast path.

- Rejected experiment: increasing browser snapshot apply batches from 256 to
  512 rows did not move the 10k target. Rust bootstrap went
  `35.19ms -> 36.73ms`, and Rust local apply stayed `14ms -> 14ms`, so the
  runtime change was discarded.
- Baseline without row-delta collection, 100k rows:
  Rust bootstrap `203.28ms`, pull request `123ms`, snapshot fetch `12ms`,
  local apply `77ms`, JS heap delta `2.18MiB`.
- Baseline with `--rust-collect-changed-rows=true`, 100k rows:
  Rust bootstrap `622.19ms`, pull request `126ms`, snapshot fetch `13ms`,
  local apply `234ms`, JS heap delta `129.61MiB`.
- After reusing the binary chunk changed-row helper for cleared snapshots when
  snapshot rows are not included:
  Rust bootstrap `523.34ms`, pull request `128ms`, snapshot fetch `14ms`,
  local apply `132ms`, JS heap delta `129.69MiB`.
- A borrowed-payload extractor variant measured similarly (`528.82ms`
  bootstrap, `127ms` apply) but added more WASM bytes, so the smaller decoded
  chunk helper version was retained.
- A value-projection fast path was smaller again but too weak for the target:
  Rust bootstrap `596.79ms`, local apply `198ms`, served Rust WASM
  `3191.0KiB`. It was discarded because the decoded chunk helper keeps most of
  the package-size saving while preserving the apply-path win.
- Same-code no-row-delta control, 100k rows:
  Rust bootstrap `213.51ms`, pull request `131ms`, snapshot fetch `14ms`,
  local apply `79ms`, JS heap delta `5.61MiB`. This is within the expected
  run-to-run variance for the untargeted path; the retained improvement is the
  `collectChangedRows` path apps need for live row/field events.

Architecture iteration: cap snapshot changed-row event volume.

- Rejected experiment: caching the repeated partial snapshot apply statement
  for the final 168-row batch did not move the target. The 100k no-row-delta
  control measured Rust bootstrap `206.31ms`, local apply `78ms`; after the
  change it measured `211ms`, local apply `79ms`, so the runtime change was
  discarded.
- Problem: with `--rust-collect-changed-rows=true`, large bootstrap snapshots
  were preserving one changed-row entry per row. At 100k rows that meant
  `100000` changed rows, Rust bootstrap `523.34ms`, local apply `132ms`, and
  JS heap delta `129.69MiB` even after the binary snapshot row-delta fast path.
- Retained change: browser pull options now default
  `maxSnapshotChangedRows` / `max_snapshot_changed_rows` to `5000` for
  snapshot-origin row events. Normal commit/local/realtime changed rows are not
  capped. Sync results and worker row-change events expose
  `changedRowsTruncated` so hosts can treat the event as "row stream
  incomplete; refresh affected live views by table/query".
- After the cap, the same 100k row-delta run measured TS bootstrap
  `746.27ms`, Rust bootstrap `219.98ms`, Rust pull request `122ms`, snapshot
  fetch `12ms`, local apply `83ms`, `5000` changed rows,
  `changedRowsTruncated=1`, binary chunks `4`, JSON chunks `0`, and JS heap
  delta `5.99MiB`.
- Same-code no-row-delta control, 100k rows:
  Rust bootstrap `210.45ms`, pull request `126ms`, snapshot fetch `14ms`,
  local apply `82ms`, `0` changed rows, `changedRowsTruncated=0`, and JS heap
  delta `4.95MiB`.

It should ultimately emit at least:

- `ts_bootstrap_100k_ms`, `rust_bootstrap_100k_ms`
- `ts_bootstrap_500k_ms`, `rust_bootstrap_500k_ms`
- `rust_pull_request_ms`, `rust_snapshot_fetch_ms`,
  `rust_snapshot_chunk_decode_ms`, `rust_pull_apply_ms`
- matching TS bucket names where available
- `ts_local_list_p50_ms`, `rust_local_list_p50_ms`
- `ts_local_search_p50_ms`, `rust_local_search_p50_ms`
- `ts_aggregate_p50_ms`, `rust_aggregate_p50_ms`,
  `rust_aggregate_read_model_p50_ms`
- `ts_ws_p50_ms`, `rust_ws_p50_ms`, `ts_ws_p95_ms`, `rust_ws_p95_ms`
- `ts_reconnect_25_ms`, `rust_reconnect_25_ms`,
  `ts_reconnect_100_ms`, `rust_reconnect_100_ms`,
  `ts_reconnect_250_ms`, `rust_reconnect_250_ms`
- page/served asset bytes, JS heap before/after/delta, and eventually worker
  WASM heap/peak memory

## Architecture Direction

This section covers client-owned changes. The server/protocol changes below
become the higher-leverage path if Syncular is allowed to stop optimizing for
the current TypeScript client wire shape.

### 1. Binary Snapshot Chunks

Replace `json-row-frame-v1` for Rust-capable clients with a binary table-specific snapshot format.

Target path:

```text
gzip/binary chunk -> table decoder -> direct typed values -> SQLite bind / read model update
```

This removes:

- serde JSON object parsing for every row.
- `serde_json::Value` allocation.
- map lookup by column name on apply.
- repeated JSON string allocation in the transport path.

Required work:

- Add protocol negotiation for snapshot encoding.
- Add server-side binary chunk encoder.
- Add Rust decoder for generated schemas.
- Keep JSON off the hot path; use it only for explicit debug/test flows.

### 2. Schema-Generated Apply

Generate Rust table-specific code from app schema:

```rust
apply_tasks_snapshot_row(row: TaskRow, stmt: *mut sqlite3_stmt)
```

This avoids generic JSON/value logic in the hot path while keeping the generic path for plugins, encrypted fields, and unknown schemas.

Required work:

- Generate typed row structs or row decoder functions per table.
- Generate direct SQLite bind order per table.
- Integrate with CRDT/encryption fallback paths.

### 3. Local Read Models

Use Rust/client-owned materialized read models for common local reads instead of forcing every query through SQLite scans.

First target:

- `tasks` aggregate by `(project_id, owner_id, completed)`.

This turns the benchmark aggregate from a 100k-row scan into a tiny grouped lookup. More generally, read models can support:

- dashboard counters
- sorted list heads
- prefix/search indexes
- per-subscription summaries

Required work:

- Add read model lifecycle hooks around snapshot apply and local/remote changes.
- Keep read models transactionally updated with base tables.
- Surface generated query helpers or documented read-model tables.

### 4. Worker-First Runtime

Run Rust sync/apply/query read models in a worker by default.

Required work:

- Treat worker client as the default browser runtime.
- Batch and debounce change events.
- Avoid returning row payloads unless a query explicitly asks for them.
- Keep all bootstrap/apply work off the UI thread.

### 5. Benchmark Policy

If Rust uses materialized read models, benchmark notes must say so. This is not equivalent to TS raw local SQL; it is a different client architecture. The benchmark should report both:

- raw SQL/local SQLite query numbers where relevant
- generated/read-model query numbers for Rust-native paths

## Server And Protocol Architecture Direction

If the Rust client becomes the primary client and the JS client can be dropped
or treated as compatibility-only, the protocol should stop making JSON the hot
path. The target is for the server to emit data in the same shape the Rust
runtime can apply without per-row translation. The Cloudflare-compatible server
architecture should also avoid large in-memory responses: Workers should
coordinate, sequence, and stream; D1/Durable Objects/R2-style services should
own durable state, realtime session fanout, and large artifacts.

### 1. Binary-First Sync Protocol

Make Rust-capable clients negotiate binary protocol capabilities instead of
only binary snapshot chunks:

- `binary-table-v1` snapshot chunks.
- binary commit/delta frames.
- stable table ids instead of table strings.
- stable column ids instead of field names.
- changed-column bitsets instead of changed-field string arrays.
- compact typed scalar values instead of `serde_json::Value`.

JSON should remain useful for debugging, admin tools, tests, and older
clients, but it should not be the canonical hot-path representation.

### 2. Server-Generated Binary Snapshot Chunks

The server should encode snapshot chunks directly from schema metadata into the
final Rust wire format:

```text
SQL rows -> generated table encoder -> compressed binary chunk -> Rust decoder -> SQLite bind
```

This removes JSON row-frame creation on the server and JSON row-frame parsing
on the client. It also makes the snapshot cache more valuable because cached
chunks are already in the exact format Rust applies.

Required work:

- Generate server encoders from the same app schema contract.
- Encode rows in fixed schema column order.
- Include schema/table/column version metadata in chunk headers.
- Remove `json-row-frame-v1` from the Rust-first hot path once binary table
  chunks are fully generated.

### 3. WebSocket Carries Real Deltas

Realtime should stop being only a wakeup source for Rust-native clients. The
steady-state path should be a long-lived binary stream that can carry compact
delta packs directly:

- commit seq / server seq.
- table id.
- row id.
- operation.
- changed-column bitmap.
- encoded changed values.
- CRDT field metadata or update refs.
- conflict/rejection metadata when a local commit is rejected.

HTTP still makes sense for initial bootstrap, large snapshot chunks, blobs, and
recovery. Once bootstrapped, websocket delivery should be able to apply most
ordinary remote changes without an extra HTTP pull.

### 4. Protocol-Level Sync Packs

Define a compact "sync pack" as the unit the Rust runtime applies
transactionally. A pack can arrive over HTTP or websocket and should contain:

- cursor advances.
- acked local commits.
- remote commits/deltas.
- revocations.
- snapshot chunk refs.
- conflict records.
- row/field change summaries.
- retry/auth/server capability metadata.

The Rust worker should be able to apply one pack in one SQLite transaction and
then derive native/browser UI events locally from the applied row/field
metadata.

### 5. Server-Side Snapshot Cache In Final Wire Format

Snapshot chunks should be cached as already-compressed binary artifacts keyed
by:

- schema version.
- table id / subscription id / scope.
- as-of commit seq.
- encoding version.
- compression algorithm.
- relevant feature flags such as encryption/blob/CRDT support.

The server should avoid regenerating JSON rows or re-encoding rows per client
when many clients need the same bootstrap view.

### 6. Generated Server Encoders From The Same Schema

The schema contract should generate all hot-path protocol code:

- Rust client decoders and SQLite binders.
- server binary snapshot encoders.
- server binary delta encoders.
- table id and column id maps.
- schema compatibility checks.
- protocol feature/capability manifests.

This prevents drift between server output and Rust client apply code and
removes dynamic per-row reflection from both sides.

### 7. Compact Change Metadata

Row/field-level events are valuable for host apps, but protocol responses
should not carry verbose changed-row JSON by default. The server should send
compact metadata, and the Rust runtime should expand it into the stable
`NativeEvent`/browser event shape after apply.

Target shape on the wire:

- table id.
- row id.
- op.
- changed-column bitmap.
- optional CRDT field bitmap or refs.
- commit/server seq.

### 8. Gzip-Only Compression Policy

Compression should stay gzip-only for this protocol generation because it is
the only supported compression path across the current server, browser, and
native clients.

- snapshot chunks use `gzip`.
- websocket delta packs should avoid compression for small messages unless
  measurements show gzip is worth the latency and implementation cost.
- keep `compression` in cache keys and manifests for correctness, but do not
  add unsupported compression algorithms.

### 9. WebSocket-First Sync Sessions

Rust clients should connect through an explicit session protocol instead of a
collection of unrelated HTTP calls plus realtime wakeups:

```text
hello -> capability/schema negotiation -> auth -> subscriptions -> snapshot refs -> delta packs -> client acks/resume
```

The session should support:

- resumable server sequence tokens.
- subscription changes without reconnecting.
- explicit auth refresh.
- per-pack client acks.
- server-driven backpressure.
- fallback to HTTP/R2-style chunk fetches for large snapshot/blob payloads.

This makes the websocket the normal steady-state sync transport. HTTP remains
for bootstrap artifact fetches, diagnostics, and recovery.

### 10. Server-Side Sequencer And Fanout Layer

For Cloudflare-compatible deployment, introduce a stateful sync sequencer/fanout
layer rather than making stateless Workers own realtime ordering. A practical
shape is:

- Durable Object or equivalent shard per workspace/tenant/sync partition.
- D1 or equivalent durable SQL store for commit/subscription metadata.
- R2 or equivalent object store for large snapshot chunks and blobs.
- stateless Worker routes for auth, artifact fetch, and public HTTP fallback.

The sequencer owns:

- websocket session registry.
- ordered server sequence assignment.
- fanout to connected clients.
- resume token validation.
- per-client backpressure and overflow decisions.
- short-lived in-memory hot subscription state.

### 11. Append-Only Binary Commit Log

Store server commits in a layout optimized for range scans and binary encoding,
not as JSON blobs that must be reparsed for every Rust client.

Suggested durable shape:

- commit id.
- server seq.
- actor/client id.
- table id.
- row id.
- operation.
- changed-column bitmap.
- typed binary value payload.
- CRDT update/checkpoint refs.
- blob refs.
- auth/scope metadata needed for subscription filtering.

The JSON commit shape can still exist for debug/export tooling, but the hot
path should be append-only binary commit records plus compact indexes.

### 12. Subscription Indexes And Fanout Membership

The server needs indexes that answer "which subscriptions/clients should see
this row?" without recomputing scope matching from scratch for every pull or
fanout.

Required indexes:

- subscription id -> table ids and scope predicates.
- scope key -> active subscription/session ids.
- table/row/scope key -> latest visible server seq.
- client/session -> subscribed tables/scopes and last acked server seq.

This is critical for large multi-tenant apps where binary encoding alone will
not fix fanout cost.

### 13. Resumable Snapshot Manifests

Initial sync should return a snapshot manifest, not a giant logical response.
The manifest should include:

- schema version and protocol version.
- as-of server seq.
- table ids and subscription ids.
- chunk ids/URLs.
- encoding and compression.
- byte sizes and row counts.
- hashes/digests.
- dependency ordering.
- resume cursor for partially applied bootstrap.

The client should fetch/apply chunks incrementally, verify each chunk, and
resume after interruption without restarting bootstrap.

### 14. Content-Addressed Snapshot And Blob Storage

Large immutable artifacts should be content-addressed and stored outside the
hot Worker/D1 path:

- binary snapshot chunks.
- blob bodies.
- CRDT checkpoints.
- large encrypted payload bundles.

The database should store metadata, digests, ownership, scopes, and references.
The object store should serve large bodies. This prevents Workers from holding
large payloads in memory and makes snapshot cache hits cheap.

### 15. Binary Conflict And Rejection Records

Conflict/rejection handling should be first-class in the binary protocol.
Rejection records should carry:

- rejected client commit id.
- failed op index.
- table id and row id.
- rejection code.
- base server version.
- current server version.
- changed-column bitmap for server values.
- compact typed server values needed for resolution.

The Rust client can then persist conflicts and drive deterministic resolution
without parsing JSON sidecars.

### 16. CRDT-Specific Delta Lanes

CRDT/Yjs fields should not be encoded as ordinary text columns. Give them a
separate lane with:

- field identity by table id, row id, field id.
- update refs and checkpoint refs.
- state vector metadata.
- compaction watermark.
- encrypted key id/scope metadata when needed.
- no-blanking/materialization guard metadata.

The normal row delta can reference CRDT field changes, while CRDT payloads flow
through update/checkpoint-specific packs.

### 17. Schema Manifest Handshake

Connection startup should fail early if the server and Rust client disagree on
the generated schema contract. The handshake should negotiate:

- schema version.
- table id map.
- column id map.
- feature flags.
- protocol versions.
- snapshot/delta encodings.
- gzip compression setting.
- encryption, blob, and CRDT capabilities.
- minimum supported client/runtime version.

If the schema contract mismatches, the server should force migration,
bootstrap, or reject the session before sending data.

### 18. Explicit Backpressure And Flow Control

The server protocol should mirror the client event-stream guarantees:

- bounded in-flight packs.
- client ack per pack or ack range.
- resume token after every durable boundary.
- overflow event with resync-required semantics.
- server-side slow-client policy.
- max bootstrap concurrency.
- retry-after hints.

The server must never buffer unbounded websocket data for a slow or suspended
client. Overflow should close or resync the session deliberately.

## Phased Implementation

### Phase 1: Read Model Prototype

- Status: in progress.
- Added a maintained task aggregate read model for the Rust benchmark schema in `offline-sync-bench`.
- Switched the Rust aggregate benchmark to query the read model table.
- Added raw SQLite aggregate timings beside the read-model timings so benchmark output shows both the baseline scan cost and the Rust-native read-model path.
- Kept raw list/search queries unchanged.
- Verified the trigger-based read model logic in SQLite and through the Rust WASM `executeUnsafeSql` binding.
- Full client-server benchmark verification is currently blocked by local Docker/OrbStack being unavailable.

### Phase 2: Binary Snapshot Design

- Status: mostly implemented for the generic server/Rust transport path.
- Added a small SRF1 decoder allocation reduction in the current JSON row-frame path while the binary format is being designed.
- Added non-breaking snapshot encoding negotiation:
  - pull requests can advertise `snapshotEncodings`
  - chunk refs can represent `json-row-frame-v1` or `binary-table-v1`
  - the server emits JSON row-frame chunks by default and binary chunks when
    requested by Rust-capable clients
  - generated HTTP OpenAPI/transport types now expose the widened encoding contract
- Documented the proposed `binary-table-v1` wire format in `rust/docs/reference/BINARY_SNAPSHOT_CHUNK_FORMAT.md`.
- Added tested core helpers for encoding/decoding `binary-table-v1` payloads. These lock down the table/column/value byte layout for the server encoder and Rust decoder work.
- Added protocol negotiation fields.
- Added server-side generic binary table inference/encoding for snapshot rows.
- Added Rust native and browser transport decoding for `binary-table-v1`.
- Rust clients now request only `binary-table-v1` snapshot chunks. We removed
  the `json-row-frame-v1` fallback advertisement from the Rust runtime/browser
  clients so protocol failures are explicit instead of silently taking the old
  path.
- Fixed the Hono combined sync route so browser worker pulls pass
  `snapshotEncodings` through to the core server pull path instead of silently
  falling back to JSON chunks.
- Added browser transport counters for JSON chunk count, binary chunk count,
  and decoded chunk row count.
- Added an explicit `snapshotBinaryColumns` server handler contract. Generated
  handlers can now provide stable table/column/type metadata so binary snapshot
  chunks skip per-chunk column/type inference and encode in generated column
  order.
- Remaining work: generate `snapshotBinaryColumns` from app schema/migrations
  and move from generic object-row encoding to generated table-specific
  encoders where needed.

### Phase 3: Generated Apply

- Status: started.
- Added a native bootstrap apply fast path: after a snapshot first page clears a
  scoped table, ordinary tables skip per-row previous-row reads before snapshot
  upsert. Encrypted CRDT update-log tables keep the old lookup path because
  their clear operation can preserve local rows.
- Measured 2k-row Rust release sync before/after:
  - `rust_http_pull_catchup_2000`: 1610.6ms -> 18.6ms.
  - `rust_http_client_to_client_catchup_2000`: 3279.5ms -> 44.5ms.
  - saved raw reports in `.context/rust-perf-before.json` and
    `.context/rust-perf-after.json`.
- Re-ran after the latest native apply/codegen pass:
  - `rust_e2e_pull_catchup_2000`: 13.9ms.
  - `rust_http_pull_catchup_2000`: 18.4ms.
  - `rust_http_client_to_client_catchup_2000`: 44.0ms.
  - `rust_ws_client_to_client_catchup_2000`: 50.9ms.
  - saved raw report in `.context/rust-perf-after-batch.json`.
- Added a native Diesel snapshot batch apply path for ordinary tables. Cleared
  snapshots now use multi-row SQLite upserts instead of one generated Diesel
  upsert per row. Encrypted update-log CRDT tables still use the preserving
  row path.
- Native transport/storage now carries `binary-table-v1` chunks as ordered
  binary rows instead of immediately converting them into `serde_json::Value`
  maps. Diesel applies those ordered rows through the same batch-shaped snapshot
  path for ordinary tables.
- Direct Rust perf binary, 2k rows, 1 measured round after native binary batch
  apply:
  - `rust_e2e_pull_catchup_2000`: 7.7ms.
  - `rust_http_pull_catchup_2000`: 12.3ms.
  - `rust_http_client_to_client_catchup_2000`: 30.2ms.
  - `rust_ws_client_to_client_catchup_2000`: 39.3ms.
- Added a transaction-level `upsert_rows` hook so cleared snapshots call into a
  batch-shaped native apply API. The default implementation remains safe
  per-row upsert for stores without an override; the Diesel SQLite store now
  overrides it for ordinary table snapshots.
- Added a browser binary snapshot fast path for chunked bootstrap when the
  client does not need returned snapshot rows or row-diff metadata. Binary
  chunks now bind directly into SQLite for ordinary/server-merge tables instead
  of first converting every row into a JSON object map. Encrypted update-log
  CRDT tables still use the preserving fallback.
- Local browser measurement after the fix:
  - 2k rows, 500-row pages: 4 binary chunks, 0 JSON chunks, 2k rows decoded,
    `snapshotChunkDecodeMs=3ms`, `pullApplyMs=13ms`, wall `40.3ms`.
  - 10k rows, 1k-row pages: 10 binary chunks, 0 JSON chunks, 10k rows decoded,
    `snapshotChunkDecodeMs=7ms`, `pullApplyMs=36ms`, wall `94.5ms`.
- Follow-up browser performance pass after the branch-server feedback:
  - Added hard perf-script assertions that the browser benchmark uses
    `binary-table-v1` only and applies the expected row count.
  - Fixed multi-round bootstrap continuation: later snapshot pages now keep
    the binary chunk apply path when the client does not request returned rows
    or row-level diff metadata. Before this, only the first bootstrap round
    used the fast path; continuation rounds converted binary chunks back into
    JSON row maps and generic upserts.
  - Reused prepared multi-row SQLite statements for full binary batches.
  - Added a cleared-snapshot internal write path that uses batch writes for
    binary chunks after the subscribed scope has just been cleared.
  - Switched binary string/blob cell binding to SQLite static lifetime for the
    immediate step path, avoiding an extra bind-time copy where the decoded
    binary row storage remains alive.
  - Local browser/Hono dev-WASM measurements with generated binary columns and
    binary sync-pack responses:
    - 10k rows, 1k-row pages: 10 binary chunks, 0 JSON chunks,
      `snapshotChunkDecodeMs=23ms`, `pullApplyMs=110ms`, wall `170.4ms`.
    - 100k rows, 5k-row pages, 2 pull rounds: 20 binary chunks, 0 JSON chunks,
      `snapshotChunkDecodeMs=158ms`, `pullApplyMs=550ms`, wall `890.1ms`.
    - 500k rows, 5k-row pages, 10 pull rounds: 100 binary chunks, 0 JSON
      chunks, `snapshotChunkDecodeMs=745ms`, `pullApplyMs=2522ms`, wall
      `4018.6ms`.
  - The 500k local result is now below the 5s bootstrap target in this harness.
    It should still be re-run in the canonical benchmark job before treating it
    as the release baseline.
- Added a borrowed browser payload path for `binary-table-v1`: the web
  transport now preserves raw decoded snapshot bytes, and the Rust-owned SQLite
  store streams borrowed cells directly into reusable prepared statements for
  ordinary table snapshots. The JSON/value materialization fallback remains for
  encryption transforms, changed-row collection, and stores that do not
  implement a binary fast path.
- Local browser/Hono dev-WASM measurement after borrowed payload streaming:
  - 500k rows, 5k-row pages, 10 pull rounds: 100 binary chunks, 0 JSON chunks,
    `snapshotChunkDecodeMs=3ms`, `pullApplyMs=2383ms`, wall `3901.2ms`.
  - This confirms the branch-server feedback: decode/materialization is now
    mostly gone from the browser binary path, and the remaining bottleneck is
    SQLite apply/execution.
- Measured SQLite multi-row batch size on the same harness:
  - 1024-row batches: `pullApplyMs=2532ms`, wall `4019.8ms`.
  - 512-row batches: `pullApplyMs=2414ms`, wall `3925.6ms`.
  - 128-row batches: `pullApplyMs=2339ms`, wall `3849.6ms`.
  - 64-row batches: `pullApplyMs=2351ms`, wall `3849.5ms`.
  - Kept 128 rows as the measured best local setting; larger SQL statements
    are slower in SQLite WASM despite fewer prepare/step calls.
- Final validation run with 128-row batches and rebuilt dev WASM:
  - 500k rows, 5k-row pages, 10 pull rounds: 100 binary chunks, 0 JSON chunks,
    `snapshotChunkDecodeMs=1ms`, `pullApplyMs=2316ms`, wall `3803.8ms`.
- Carried cleared-bootstrap state across continuation pull rounds when scopes
  match, so browser/native apply can keep using the cleared-snapshot path after
  the first page. A follow-up 500k browser run stayed in the same band:
  `snapshotChunkDecodeMs=1ms`, `pullApplyMs=2344ms`, wall `3855.7ms`.
- Added a web SQLite pragma baseline on open: `foreign_keys`, `busy_timeout`,
  `temp_store=MEMORY`, memory-store `journal_mode=MEMORY`/`synchronous=OFF`,
  and persistent-store `synchronous=NORMAL` with best-effort WAL.
  The 500k browser run stayed in the same band: wall `3824.7ms`,
  `pullApplyMs=2335ms`.
- Raised the Hono route's default `maxPullMaxSnapshotPages` clamp from 10 to
  50, matching the core pull cap. This lets Rust clients that explicitly ask
  for larger bootstrap pulls avoid route-level fragmentation:
  - 500k rows, 5k-row pages: pull rounds `10 -> 2`, request count `102`,
    wall `3762.1ms`.
- Bundled binary snapshot pages into stored chunks with a 25k-row default cap
  instead of one binary chunk per page. Measured caps:
  - 10k rows per chunk: 50 binary chunks, wall `3736.0ms`,
    `pullApplyMs=2279ms`.
  - 25k rows per chunk: 20 binary chunks, wall `3704.0ms`,
    `pullApplyMs=2204ms`.
  - 50k rows per chunk: 10 binary chunks, wall `3734.8ms`,
    `pullApplyMs=2168ms`.
  - Kept 25k as the best local balance; larger chunks reduce fetch count but
    increase server pull time enough to lose overall.
  - Final validation with the checked-in 25k cap: 2 pull rounds, 20 binary
    chunks, 22 total requests, `snapshotChunkDecodeMs=1ms`,
    `pullApplyMs=2173ms`, wall `3691.9ms`.
- Switched the cleared binary snapshot path from `INSERT OR REPLACE` to plain
  `INSERT`. Cleared snapshots should not conflict with existing ordinary rows,
  and plain insert is both the correct invariant and cheaper:
  - 500k rows, 5k-row pages, 20 binary chunks: `pullApplyMs=2142ms`,
    wall `3618.5ms`.
- Removed the optional inline compressed snapshot chunk body experiment.
  Binary sync-packs now carry refs only; chunk bytes are always fetched through
  the authenticated chunk route.
- Made snapshot gzip level explicit and measured level 1 for the binary
  bootstrap path:
  - 500k rows, 5k-row pages: response bytes `~3.52MB -> ~3.55MB`,
    `pullRequestMs=1405ms`, `pullApplyMs=2141ms`, wall `3567.2ms`.
  - This was the best local run at that point in the Hono/dev-WASM harness.
  - Final validation stayed in the same band: `pullRequestMs=1410ms`,
    `pullApplyMs=2142ms`, wall `3573.1ms`.
- Tested a SQL-literal `INSERT ... VALUES` fast path for cleared browser
  binary snapshot payloads to avoid per-cell SQLite bind calls. It regressed
  500k bootstrap to wall `5082.3ms` and `pullApplyMs=3696ms`, so the experiment
  was reverted. SQLite WASM parse/execute cost for very large literal SQL is
  worse than the reusable prepared-statement binder here.
- Revalidated the prepared binary payload path after reverting that experiment:
  500k rows, 5k-row pages, 20 binary chunks, 2 requests,
  `snapshotChunkDecodeMs=0ms`, `pullApplyMs=2141ms`, wall `3571.3ms`.
- Replaced the TypeScript core `binary-table-v1` encoder's per-scalar
  `Uint8Array` chunks and final concat with a streaming binary writer. This
  preserves the wire format but removes a large amount of server-side
  allocation during chunk generation:
  - 500k rows, 5k-row pages: `pullRequestMs=652ms`, `pullApplyMs=2121ms`,
    wall `2796.4ms`.
  - Isolated 20k-row server metadata benchmark improved to generated columns
    wall `18.9ms`, `rowFrameEncodeMs=8ms`.
- Removed redundant `sqlite3_clear_bindings` calls for reusable prepared
  multi-row statements because every placeholder is rebound before each step.
  Local 500k browser validation stayed in the same band:
  `pullRequestMs=661ms`, `pullApplyMs=2131ms`, wall `2814.1ms`.
- Returning a `subarray` from the streaming binary writer instead of copying a
  trimmed `slice` was correct but performance-neutral in the full browser
  harness: `pullRequestMs=658ms`, `pullApplyMs=2140ms`, wall `2819.7ms`.
- Tested a single-row reusable prepared insert shape for browser SQLite apply.
  It regressed 500k bootstrap to wall `3729.6ms` and `pullApplyMs=3051ms`, so
  the 128-row prepared batch remained the measured best shape at that point.
- Tested gzip level `0` while preserving the gzip wire contract. It improved
  local 500k browser wall time to `2621.3ms` by cutting client inflate to
  `53ms`, but response bytes grew from `3.55MB` to `57.4MB`. This is useful
  evidence for a future configurable/local-network compression policy, not a
  sane Cloudflare/default setting.
- Added that compression policy as an explicit server option:
  `snapshotChunkGzipLevel` on `pull()` and Hono `sync` config. The protocol
  remains gzip-only, the default remains level `1`, and the internal snapshot
  cache key includes the level so cached level-1 chunks are not reused for
  level-0 pulls. Unit coverage proves distinct cache entries and valid decode.
- `SQLITE_PREPARE_PERSISTENT` for reusable browser snapshot statements and
  memory-store `locking_mode=EXCLUSIVE` were both neutral in the local harness:
  latest level-1 500k validation reported `pullRequestMs=660ms`,
  `pullApplyMs=2122ms`, wall `2804.7ms`.
- Added a lean `BinarySnapshotRowCursor::read_next_row_values` path for the
  browser SQLite binder and cached the row null-bitmap width in the cursor.
  This removes unused callback arguments from the per-cell hot loop. The 500k
  browser run improved slightly within noise: `pullRequestMs=655ms`,
  `pullApplyMs=2105ms`, wall `2783.1ms`.
- Cached prepared statements for Rust-owned browser live queries. Subscribing
  now prepares and validates the read-only statement once, invalidations rerun
  the same statement with reset/clear-bindings, and unsubscribe/drop finalize it
  explicitly. This targets repeated live-query refresh latency rather than
  bootstrap. Validation: browser Hono live-query refresh smoke passed; the 500k
  bootstrap benchmark stayed in the same band at `pullRequestMs=654ms`,
  `pullApplyMs=2112ms`, wall `2787.8ms`.
- Added a bounded 64-entry LRU prepared-statement cache for normal read-only
  browser `executeSql` calls, which is the Kysely query path. Cached statements
  are reset and bindings are cleared before each run, evicted/finalized by LRU,
  and cleared after unchecked SQL because that path can include DDL. Focused
  browser coverage repeats the same parameterized SQL with different values to
  prove cached bindings remain correct. Final current-tree 500k bootstrap
  validation stayed flat: `pullRequestMs=658ms`, `pullApplyMs=2113ms`,
  `snapshotChunkDecodeMs=1ms`, wall `2793.9ms`.
- Removed per-cell diagnostic `format!` allocation from binary snapshot scalar
  reads. Column-specific messages are still produced for actual validation
  failures, but the success path now uses static labels. This moved the 500k
  browser run to `pullRequestMs=655ms`, `pullApplyMs=1927ms`, wall
  `2603.8ms`.
- Rechecked browser SQLite snapshot batch size after the cursor improvement:
  - 256-row batches: `pullApplyMs=1908ms`, wall `2594.4ms`.
  - 512-row batches: `pullApplyMs=1935ms`, wall `2626.7ms`.
  - The checked-in default is now 256 rows for this path.
- Added a binary snapshot visitor path so Rust-owned browser SQLite can decode
  borrowed payload cells directly into SQLite binds instead of constructing a
  `BorrowedBinarySnapshotCell` enum and matching it again. The 500k browser run
  improved to `pullRequestMs=664ms`, `pullApplyMs=1889ms`, wall `2574.3ms`.
- Built and benchmarked the release browser WASM artifact. This changes the
  practical baseline substantially: 500k rows, 5k-row pages, 20 binary chunks,
  0 JSON chunks, release WASM size `3.06 MiB` raw / `1.25 MiB` gzip,
  `pullRequestMs=676ms`, `snapshotFetchMs=86ms`, `pullApplyMs=416ms`, wall
  `1101.2ms`. Future performance comparisons must record whether the artifact
  is dev or release; dev-WASM apply numbers are not representative of shipped
  package behavior.
- Hardened browser benchmark tooling around that distinction:
  `browser-wasm-vs-js-benchmark.ts` now starts the runtime asset server with an
  explicit `--wasm-profile` and defaults benchmarks to release WASM; the JSON
  report includes `runtime.wasmProfile`; the perf test asserts release profile.
  The ad-hoc 500k snapshot script also records the profile and can require
  release via `SYNCULAR_BROWSER_PERF_REQUIRE_RELEASE=true`.
- Validated the release-profile benchmark harness with a tiny Chromium run
  (`operations=5`, `rounds=1`, `warmup=1`), confirming the report carries
  `runtime.wasmProfile: "release"`. This also surfaced two browser-store
  hardening fixes: persistent sqlite-wasm-rs pragmas such as
  `synchronous=NORMAL` must be best-effort for IndexedDB/OPFS, and internal
  mutable write transactions clear cached readonly statements before `BEGIN`.
- Cached reusable binary snapshot write statements for Rust-owned browser
  SQLite. Full binary snapshot batches now reuse the prepared 256-row
  insert/upsert statement across chunks with bounded LRU eviction, while unsafe
  schema writes clear the cache. Release-WASM 500k validation improved from the
  prior release baseline; latest final validation reported
  `pullRequestMs=660ms`, `snapshotFetchMs=84ms`, `pullApplyMs=381ms`, wall
  `1059.8ms`, with 20 binary chunks and 0 JSON chunks.
- Negative experiments after the visitor path:
  - Rechecked browser SQLite snapshot batch size in release WASM after adding
    the snapshot statement cache. 512-row batches regressed to
    `pullApplyMs=392ms`, wall `1051.9ms`; 128-row batches regressed to
    `pullApplyMs=403ms`, wall `1067.9ms`. Keep the checked-in 256-row default.
  - Aligning the server binary chunk cap to 25,600 rows reduced chunk count to
    18 but regressed to wall `2637.7ms`, `pullApplyMs=1926ms` in dev WASM.
  - Aligning the cap downward to 24,576 rows kept 20 chunks but regressed to
    wall `2640.3ms`, `pullApplyMs=1937ms` in dev WASM.
  - Skipping per-cell SQLite bind result checks regressed to wall `2670.7ms`,
    `pullApplyMs=1949ms` in dev WASM.
  - Memory SQLite `journal_mode=OFF` regressed to wall `2625.7ms`,
    `pullApplyMs=1918ms`; keep `journal_mode=MEMORY` for in-memory stores.
- Made Rust-owned browser client config tolerate missing, `null`, or
  `undefined` pull options by defaulting them in Rust. This matches the
  TypeScript API shape and fixed the Hono worker smoke when callers omit
  pull tuning.
- Current limitation: Diesel's typed multi-row `insert_into(...).values(chunk)
  .on_conflict(...)` shape is not supported for SQLite in the generated
  adapter path. The safe generated fallback remains per-row upsert inside the
  existing transaction.
- Added cached Rust bootstrap metrics to the browser E2E scoreboard. Baseline
  on battery-saver 100k release-WASM run:
  - first Rust bootstrap `283.36ms`, pull request `164ms`, apply `116ms`.
  - cached Rust bootstrap `205.80ms`, pull request `99ms`, apply `105ms`.
  - cached server row encode/gzip/hash dropped to `0ms`, but cached snapshot
    query was still `93ms`. This proves the cache stores compressed wire
    chunks, but cache hits still query rows to rediscover continuation
    metadata. Next retained runtime optimization must target query skipping,
    not another encode/gzip tweak.
- Added snapshot chunk continuation metadata (`next_row_cursor`,
  `is_last_page`) and a binary cache-hit shortcut that can return cached chunk
  refs without rereading app rows. The browser E2E harness now loops TS and
  Rust bootstrap pulls until completion, supports `query-iterations=0` for
  bootstrap-only large runs, and configures the test Hono route for 100
  snapshot pages so 500k runs are explicit.
  - 100k release-WASM, battery saver, before/after:
    `rust_cached_bootstrap_ms` `205.80 -> 114.75`,
    `rust_cached_pull_request_ms` `99 -> 5`,
    `rust_cached_server_bootstrap_snapshot_query_ms` `93 -> 0`.
    First Rust bootstrap stayed in the same band (`283.36 -> 301.47`) and
    apply stayed flat (`116 -> 118`), which is the expected target isolation.
  - 500k release-WASM bootstrap-only, battery saver, continuation cache before
    allowing continuation-round hits vs after:
    `rust_cached_bootstrap_ms` `854.35 -> 552.25`,
    `rust_cached_pull_request_ms` `328 -> 14`,
    `rust_cached_server_bootstrap_snapshot_query_ms` `237 -> 0`,
    `rust_cached_server_bootstrap_row_frame_encode_ms` `73 -> 0`.
    Apply stayed flat (`518 -> 529`) and the cached response size stayed
    unchanged (`3,782,404` bytes). This confirms the change removes server CPU
    on cached binary bootstraps without changing client apply behavior.
- Next target: the remaining SQLite apply cost is mostly structural. The
  generic prepared statement path still binds every cell through runtime table
  metadata. The likely next wins are generated table binders where the app
  schema is known, temporary index/foreign-key policy for trusted bootstrap
  phases, or read-model paths that avoid replaying large snapshots into generic
  query tables when a product only needs derived local views.
- Added a Rust-owned browser SQLite binary apply shortcut that binds trusted
  binary snapshot string/JSON cells as raw text bytes instead of validating
  UTF-8 for every cell before immediately rebinding the same bytes into SQLite.
  The normal decoded-row/materialization paths still validate UTF-8.
  Release-WASM battery-saver validation, before vs after:
  - 100k full scoreboard:
    `rust_bootstrap_ms` `301.47 -> 282.35`,
    `rust_cached_bootstrap_ms` `114.75 -> 110.16`,
    `rust_pull_apply_ms` `118 -> 114`,
    `rust_cached_pull_apply_ms` `108 -> 104`.
  - 500k bootstrap-only:
    `rust_bootstrap_ms` `1401.60 -> 1371.38`,
    `rust_cached_bootstrap_ms` `552.25 -> 519.69`,
    `rust_pull_apply_ms` `543 -> 519`,
    `rust_cached_pull_apply_ms` `529 -> 498`.
  - Kept because the target 500k cached apply path improved by `31ms`
    (`5.9%`) and cached bootstrap improved by `32.56ms` (`5.9%`) without
    changing wire bytes or server behavior.
- Next target after the raw-byte shortcut: remaining apply cost is SQLite bind
  and execute work across generic runtime metadata. Only keep additional
  experiments that show a measured 500k `rust_cached_pull_apply_ms` win against
  the latest committed release-WASM baseline.
- Added a JS-value query result path for Rust-owned browser SQLite
  (`executeSqlValue`/`executeUnsafeSqlValue`) and switched the TypeScript
  wrapper to prefer it with a JSON fallback. This avoids JSON stringifying
  query parameters and JSON stringifying/parsing result rows across the
  JS/WASM boundary for Kysely reads.
  - 100k full scoreboard, release-WASM, battery saver, repeated twice:
    `rust_local_search_p50_ms` `4.86 -> 2.72` and `4.86 -> 2.70`,
    `rust_local_search_p95_ms` `21.92 -> 17.90` and `21.92 -> 18.03`,
    `rust_aggregate_p95_ms` `38.66 -> 32.98` and `38.66 -> 33.14`.
  - List-query p50 was neutral/noisy (`0.385 -> 0.410`, then
    `0.385 -> 0.380`), with list p95 improved in both runs
    (`0.88 -> 0.68`).
  - 500k bootstrap-only guardrail, repeated twice, showed no first-bootstrap
    apply regression (`519 -> 520`, then `519 -> 517`) and a small cached
    bootstrap/apply noise band (`rust_cached_pull_apply_ms` `498 -> 506` and
    `498 -> 505`).
  - WASM size increased by `13,036` bytes raw (`3.06MiB -> 3.07MiB`) and
    remains inside the enforced size budget.
- Rejected inline snapshot chunk hash skipping. It reliably removed the hash
  bucket (`rust_cached_snapshot_chunk_hash_ms` `28 -> 0`) and reduced
  `rust_cached_snapshot_fetch_ms`, but end-to-end 500k cached bootstrap was
  not consistently better (`526 -> 508`, `526 -> 629`, `526 -> 531`) and the
  change weakened chunk integrity checks. Reverted.
- Raised the Rust-owned browser SQLite snapshot write batch target from `256`
  to `2048` rows, with an adaptive cap based on column count so wider generated
  tables stay under SQLite bind-parameter limits.
  - 500k bootstrap-only, release-WASM, battery saver:
    `rust_bootstrap_ms` `1374.08 -> 1338.48`,
    `rust_cached_bootstrap_ms` `526.11 -> 509.82`,
    `rust_pull_apply_ms` `517 -> 490`,
    `rust_cached_pull_apply_ms` `505 -> 490`.
  - 100k full scoreboard guardrail:
    bootstrap and local query metrics stayed flat/noisy
    (`rust_pull_apply_ms` `111 -> 111`,
    `rust_local_search_p50_ms` `2.70 -> 2.63`).
  - WASM size changed by only `69` bytes raw and stayed inside the budget.
- Rejected nullable all-null column pruning for generated binary snapshots. It
  reduced some nullable bind work in theory, but in practice forced the server
  off generated table encoders and regressed 500k first bootstrap:
  `rust_bootstrap_ms` `1338.48 -> 1433.91`,
  `rust_pull_apply_ms` `490 -> 514`,
  `rust_server_bootstrap_row_frame_encode_ms` `247 -> 291`, and response bytes
  increased slightly. Reverted.
- Rejected cached-statement null-bind state tracking. It avoided repeated
  `sqlite3_bind_null` calls for stable-null parameters, but the per-parameter
  bookkeeping cost more than the skipped SQLite calls in the 500k browser path:
  `rust_cached_bootstrap_ms` `509.82 -> 533.89`,
  `rust_pull_apply_ms` `490 -> 503`,
  `rust_cached_pull_apply_ms` `490 -> 514`. Reverted.
- Retained lazy server codec hydration for default snapshots. Snapshot pages now
  resolve table codecs once per page, and `applyCodecsFromDbRow` only copies a
  row when a codec-backed column actually has a non-null value to transform.
  This keeps generated binary snapshot encoders on the hot path while removing
  avoidable per-row `Object.keys`/sort/cache lookup and row spread work.
  - 500k bootstrap-only, release-WASM, battery saver:
    `rust_bootstrap_ms` `1338.48 -> 1096.17`,
    `rust_pull_request_ms` `840 -> 594`,
    `rust_server_bootstrap_snapshot_query_ms` `469 -> 231`,
    `rust_pull_apply_ms` stayed flat/noisy (`490 -> 493`).
  - 100k full scoreboard guardrail:
    `rust_bootstrap_ms` `281.38 -> 232.85`,
    `rust_pull_request_ms` `166 -> 118`,
    `rust_pull_apply_ms` stayed `111 -> 111`; local read p50s were in the
    expected noise band.
- Retained a binary snapshot writer fast path for non-negative safe JS integer
  values. The writer now emits those int64 values with two little-endian
  `Uint32` writes instead of converting every positive integer through
  `BigInt`; negative numbers and caller-provided `bigint` values keep the
  checked BigInt path.
  - 500k bootstrap-only, release-WASM, battery saver:
    `rust_bootstrap_ms` `1096.17 -> 1054.49`,
    `rust_pull_request_ms` `594 -> 557`,
    `rust_server_bootstrap_row_frame_encode_ms` `240 -> 208`,
    `rust_response_bytes` unchanged.
  - 100k full scoreboard guardrail:
    `rust_bootstrap_ms` `232.85 -> 220.10`,
    `rust_server_bootstrap_row_frame_encode_ms` `39 -> 32`,
    `rust_pull_apply_ms` stayed flat/noisy (`111 -> 108`), and local read
    p50s stayed neutral.
- Retained Rust-first large bootstrap page defaults. Rust native/web clients now
  request `25_000` snapshot rows and `20` snapshot pages by default, and the
  Hono/core server cap allows that shape so one binary bootstrap pull can carry
  a 500k-row subscription while still using 25k-row binary chunks. The TS
  scoreboard lane keeps its previous `5_000`/`100` settings.
  - 500k bootstrap-only, release-WASM, battery saver:
    `rust_bootstrap_ms` `1054.49 -> 984.02`,
    `rust_pull_rounds` `2 -> 1`,
    `rust_pull_request_ms` `557 -> 478`,
    `rust_server_bootstrap_row_frame_encode_ms` `208 -> 135`.
    Apply was slightly noisier (`488 -> 501`) but total bootstrap still
    improved by `70ms`.
  - 100k full scoreboard guardrail:
    `rust_bootstrap_ms` `220.10 -> 217.00`,
    `rust_pull_request_ms` `108 -> 106`,
    `rust_pull_apply_ms` `108 -> 107`; local read p50s stayed neutral.
- Rejected removing the duplicate `writeString32` length check in the binary
  snapshot writer. It was theoretically cheaper per string cell, but the 500k
  browser run regressed overall:
  `rust_bootstrap_ms` `984.02 -> 1026.36`,
  `rust_server_bootstrap_row_frame_encode_ms` `135 -> 140`,
  `rust_pull_apply_ms` `501 -> 521`. Reverted.
- Rejected raising the Rust-owned browser SQLite snapshot batch target from
  `2048` to `4096` rows. With the current 8-column schema this reduced the
  number of SQLite steps, but the larger prepared statement was slower:
  `rust_bootstrap_ms` `984.02 -> 1003.40`,
  `rust_pull_apply_ms` `501 -> 515`,
  `rust_cached_pull_apply_ms` `493 -> 521`. Reverted; keep `2048`.
- Rejected client-side all-null column projection for cleared binary snapshot
  inserts. It safely omitted all-null nullable/no-default columns from the
  SQLite insert statement, but required a full payload pre-scan and extra
  projected cursor path. The pre-scan cost dominated:
  `rust_bootstrap_ms` `984.02 -> 1115.91`,
  `rust_pull_apply_ms` `501 -> 629`,
  `rust_cached_pull_apply_ms` `493 -> 615`. Reverted.
- Rejected manual little-endian byte reads in the Rust binary snapshot cursor.
  Replacing slice `try_into()` with explicit byte arrays looked cheaper, but
  release-WASM got slower:
  `rust_bootstrap_ms` `984.02 -> 1015.20`,
  `rust_pull_apply_ms` `501 -> 530`,
  `rust_cached_pull_apply_ms` `493 -> 509`. Reverted.
- Rejected adding a benchmark-only `tasks(user_id, id)` server scope index.
  The first run improved `rust_server_bootstrap_snapshot_query_ms`
  `229 -> 214` but total Rust bootstrap regressed `984.02 -> 992.75`; repeat
  was worse (`rust_bootstrap_ms` `1034.53`) and query improvement shrank
  (`229 -> 223`). Reverted. Scope indexes still need a separate real
  multi-tenant workload before being promoted into generated migrations.
- Rejected changing the benchmark server `tasks` table to `WITHOUT ROWID`.
  The 100k release-WASM guardrail regressed against both the retained baseline
  and a same-session reverted control. Same-session numbers:
  `rust_bootstrap_ms` `176.55 -> 198.00`,
  `rust_pull_request_ms` `84 -> 104`,
  `rust_server_bootstrap_snapshot_query_ms` `43 -> 61`, and cached bootstrap
  `93.94 -> 97.68`. The experiment was reverted without running 500k because
  the target server-query bucket got worse.
- Retained an ASCII fast path for server binary snapshot string writes. The
  binary writer now emits ASCII `string` cells directly into its output buffer
  and falls back to `TextEncoder` for Unicode, with coverage proving the
  fallback round-trips non-ASCII content.
  - Same-session 500k bootstrap-only, release-WASM, battery saver, compared
    against a temporary no-ASCII baseline on the same tree:
    `rust_bootstrap_ms` `1034.62 -> 928.49`,
    `rust_pull_request_ms` `492 -> 412`,
    `rust_server_bootstrap_row_frame_encode_ms` `139 -> 69`,
    `rust_pull_apply_ms` `537 -> 511`,
    `rust_cached_bootstrap_ms` `535.23 -> 508.54`.
  - 100k full scoreboard guardrail stayed acceptable:
    `rust_bootstrap_ms` `217.00 -> 212.56`,
    `rust_pull_request_ms` `106 -> 94`,
    `rust_server_bootstrap_row_frame_encode_ms` `34 -> 19`.
    Local read metrics were noisy and not affected by this server-side path.
- Retained larger Rust-first snapshot page defaults after measuring `50_000`
  rows x `10` pages against the previous `25_000` x `20` shape. This keeps the
  same 500k single-pull bootstrap envelope but halves the number of binary
  chunks, server snapshot pages, and client chunk apply passes.
  - 500k bootstrap-only, release-WASM, battery saver:
    `rust_bootstrap_ms` `928.49 -> 899.87`,
    `rust_pull_request_ms` `412 -> 406`,
    `rust_pull_apply_ms` `511 -> 489`,
    `rust_snapshot_chunk_binary_count` `20 -> 10`,
    `rust_response_bytes` `3,782,229 -> 3,777,162`.
  - 100k full scoreboard guardrail:
    `rust_bootstrap_ms` `212.56 -> 198.23`,
    `rust_pull_request_ms` `94 -> 89`,
    `rust_pull_apply_ms` `115 -> 107`,
    `rust_snapshot_chunk_binary_count` `4 -> 2`.
- Rejected pushing Rust snapshot pages further to `100_000` rows x `5` pages.
  It halved chunk count again, but the measured win was too small and uneven:
  500k `rust_bootstrap_ms` only moved `899.87 -> 893.85`, while
  `rust_server_bootstrap_row_frame_encode_ms` regressed `68 -> 73`; the 100k
  guardrail regressed `198.23 -> 199.61`. Keep `50_000` x `10` as the better
  default until a streaming/manifests design changes the memory tradeoff.
- Retained compressed-body snapshot chunk hashes. Chunk `sha256` now identifies
  the transported gzip body rather than the uncompressed table payload, so the
  client validates roughly `3.8MB` instead of `36MB` on the 500k benchmark
  while preserving wire integrity.
  - 500k bootstrap-only, release-WASM, battery saver:
    `rust_bootstrap_ms` `899.87 -> 879.14`,
    `rust_pull_request_ms` `406 -> 390`,
    `rust_snapshot_fetch_ms` `83 -> 62`,
    `rust_snapshot_chunk_hash_ms` `26 -> 2`,
    `rust_server_bootstrap_chunk_hash_ms` `19 -> 1`.
  - 100k full scoreboard guardrail:
    `rust_bootstrap_ms` `198.23 -> 191.02`,
    `rust_pull_request_ms` `89 -> 85`,
    `rust_snapshot_fetch_ms` `19 -> 15`,
    `rust_cached_bootstrap_ms` `106.23 -> 101.41`.
- Added Rust browser apply sub-bucket metrics so future changes can target the
  actual hot stage instead of total `pull_apply_ms`. New sync timing fields:
  `scopeClearMs`, `snapshotRowApplyMs`, `snapshotChunkApplyMs`,
  `snapshotChunkMaterializeMs`, `snapshotChunkResetMs`,
  `snapshotChunkBindMs`, `snapshotChunkStepMs`, `commitApplyMs`, and
  `subscriptionStateMs`. These are measurement-only and do not add hidden
  result caching.
  - Validation command:
    `bun ../../../tests/runtime/scripts/browser-e2e-scoreboard.ts`
  - 100k full scoreboard, release-WASM:
    `ts_bootstrap_ms` `793.21`, `rust_bootstrap_ms` `148.54`,
    `rust_pull_apply_ms` `77`, `rust_snapshot_chunk_apply_ms` `65`,
    `rust_snapshot_chunk_materialize_ms` `0`,
    `rust_local_list_p50_ms` `0.29`,
    `rust_local_search_p50_ms` `1.62`,
    `rust_aggregate_p50_ms` `23.53`.
  - Validation command:
    `SYNCULAR_BROWSER_PERF_ROWS=500000 bun ../../../tests/runtime/scripts/browser-e2e-scoreboard.ts --query-iterations=0`
  - 500k bootstrap-only, release-WASM:
    `ts_bootstrap_ms` `3707.71`, `rust_bootstrap_ms` `663.09`,
    `rust_pull_request_ms` `320`, `rust_snapshot_fetch_ms` `50`,
    `rust_pull_apply_ms` `339`, `rust_snapshot_chunk_apply_ms` `289`,
    `rust_snapshot_chunk_materialize_ms` `0`,
    `rust_cached_bootstrap_ms` `340.36`,
    `rust_cached_pull_apply_ms` `335`,
    `rust_cached_snapshot_chunk_apply_ms` `285`.
  - Read: the current Rust hot apply path is not JSON/materialization-bound in
    this harness; it is dominated by direct binary chunk writes into SQLite.
    The next structural optimization should target the generated SQLite binder
    and write transaction path, not query/result caching.
  - Rejected follow-up: hoisting the cached full-batch statement lookup out of
    each binary snapshot batch loop. Same 500k command after the change showed
    `rust_snapshot_chunk_apply_ms` effectively flat (`289 -> 288`) and cached
    apply neutral/slightly worse (`335 -> 336`), so the runtime change was
    reverted.
  - Extended measurement with SQLite reset/bind/step sub-buckets:
    - 100k full scoreboard, release-WASM:
      `ts_bootstrap_ms` `736.65`, `rust_bootstrap_ms` `143.08`,
      `rust_pull_apply_ms` `75`, `rust_snapshot_chunk_apply_ms` `63`,
      `rust_snapshot_chunk_bind_ms` `30`,
      `rust_snapshot_chunk_step_ms` `28`,
      `rust_local_list_p50_ms` `0.28`,
      `rust_local_search_p50_ms` `1.45`,
      `rust_aggregate_p50_ms` `22.21`.
    - 500k bootstrap-only, release-WASM:
      `ts_bootstrap_ms` `3497.71`, `rust_bootstrap_ms` `602.32`,
      `rust_pull_request_ms` `272`, `rust_snapshot_fetch_ms` `45`,
      `rust_pull_apply_ms` `325`, `rust_snapshot_chunk_apply_ms` `279`,
      `rust_snapshot_chunk_bind_ms` `146`,
      `rust_snapshot_chunk_step_ms` `125`,
      `rust_cached_bootstrap_ms` `320.92`,
      `rust_cached_pull_apply_ms` `316`,
      `rust_cached_snapshot_chunk_apply_ms` `274`.
    - Read: remaining 500k apply cost is split almost evenly between binding
      binary cells into SQLite parameters and executing SQLite insert/upsert
      steps. Reset time is effectively zero. Next structural work should reduce
      per-cell binding overhead or change the snapshot import strategy; prepared
      statement/result caching is not the meaningful lever here.
  - Rejected follow-up: raising the SQLite snapshot write batch cap from
    `2048` to `4096` rows. Same 500k command did not improve the target and
    landed in the same slower band: first bootstrap `653.35`,
    `rust_snapshot_chunk_apply_ms` `309`, cached apply `304`. After reverting,
    two 2048-row control runs measured first bootstrap `658.5`/`664.88` and
    snapshot chunk apply `313`/`312`, showing the later run band was noisier
    than the earlier `602.32`/`279` result. The runtime change still stays
    reverted because it has no demonstrated win.
  - Rejected follow-up: using `sqlite3_bind_text64/blob64` directly in the hot
    borrowed binary snapshot binder. It was not a consistent win in an A/B
    sequence: experiment runs measured snapshot apply `292`/`297` and cached
    apply `281`/`293`; the immediate reverted control measured snapshot apply
    `295` and cached apply `287`. Because the signal is noise-level and the
    100k guardrail was slightly worse (`snapshot_chunk_apply_ms` `66` vs the
    earlier `63`), the runtime change stays reverted.
  - Rejected follow-up: fetching all snapshot chunks in a subscription page
    concurrently through a new transport batch method. It required adding the
    `futures` dependency and grew the served Rust WASM artifact by roughly
    `5.8KB`, while the 500k bootstrap-only run only moved
    `rust_snapshot_fetch_ms` into the same mid-40ms noise band
    (`46ms`) and did not reduce the dominant apply bucket. The dependency and
    runtime change were reverted.
  - Kept: added a trusted raw binary payload cursor for generated snapshot
    import. The fast path skips redundant per-cell nullable/schema checks while
    keeping byte-bound checks, type decoding, boolean/float validation, and
    SQLite constraint enforcement. This is small, structural, and has no extra
    package dependency.
    - Previous accepted 500k baseline, same bootstrap-only command:
      `rust_bootstrap_ms=648.06`, `rust_pull_apply_ms=350`,
      `rust_snapshot_chunk_apply_ms=295`,
      `rust_snapshot_chunk_bind_ms=149`,
      `rust_snapshot_chunk_step_ms=133`,
      `rust_cached_bootstrap_ms=341.62`,
      `rust_cached_pull_apply_ms=336`,
      `rust_cached_snapshot_chunk_apply_ms=287`.
    - 500k bootstrap-only, release-WASM, two accepted runs:
      `rust_bootstrap_ms` `607.1` / `606.82`,
      `rust_pull_apply_ms` `323` / `327`,
      `rust_snapshot_chunk_apply_ms` `275` / `279`,
      `rust_snapshot_chunk_bind_ms` `145` / `140`,
      `rust_snapshot_chunk_step_ms` `121` / `128`,
      `rust_cached_bootstrap_ms` `318.56` / `317.98`,
      `rust_cached_snapshot_chunk_apply_ms` `271` / `271`.
    - Delta versus previous accepted 500k baseline, using the mean of the two
      accepted runs:
      `rust_bootstrap_ms` `648.06 -> 606.96` (`-41.10ms`, `-6.3%`),
      `rust_pull_apply_ms` `350 -> 325` (`-25ms`, `-7.1%`),
      `rust_snapshot_chunk_apply_ms` `295 -> 277` (`-18ms`, `-6.1%`),
      `rust_snapshot_chunk_bind_ms` `149 -> 142.5` (`-6.5ms`, `-4.4%`),
      `rust_snapshot_chunk_step_ms` `133 -> 124.5` (`-8.5ms`, `-6.4%`),
      `rust_cached_bootstrap_ms` `341.62 -> 318.27`
      (`-23.35ms`, `-6.8%`),
      `rust_cached_snapshot_chunk_apply_ms` `287 -> 271`
      (`-16ms`, `-5.6%`).
    - 100k full scoreboard guardrail:
      `ts_bootstrap_ms` `781.71`, `rust_bootstrap_ms` `145.62`,
      `rust_pull_apply_ms` `77`,
      `rust_snapshot_chunk_apply_ms` `66`,
      `rust_cached_bootstrap_ms` `70.85`,
      `rust_local_list_p50_ms` `0.24`,
      `rust_local_search_p50_ms` `1.46`,
      `rust_aggregate_p50_ms` `23.02`.
    - 100k guardrail delta versus previous reported run:
      `rust_bootstrap_ms` `146.44 -> 145.62` (`-0.82ms`, neutral),
      `rust_cached_bootstrap_ms` `72.68 -> 70.85` (`-1.83ms`),
      `rust_local_list_p50_ms` `0.25 -> 0.24`,
      `rust_local_search_p50_ms` `1.52 -> 1.46`,
      `rust_aggregate_p50_ms` `22.99 -> 23.02` (neutral).
  - Rejected follow-up: deferring SQLite bind error handling until after a
    snapshot batch. It slightly reduced the served WASM artifact
    (`3,326,638 -> 3,326,118` bytes, `-520` bytes), but regressed the accepted
    500k bootstrap-only baseline:
    `rust_bootstrap_ms` `593.35 -> 601.26` (`+7.91ms`, `+1.3%`),
    `rust_pull_apply_ms` `322 -> 326` (`+4ms`, `+1.2%`),
    `rust_snapshot_chunk_apply_ms` `275 -> 281` (`+6ms`, `+2.2%`),
    `rust_snapshot_chunk_bind_ms` `132 -> 159` (`+27ms`, `+20.5%`),
    `rust_cached_bootstrap_ms` `317.31 -> 334.73`
    (`+17.42ms`, `+5.5%`),
    `rust_cached_pull_apply_ms` `313 -> 330` (`+17ms`, `+5.4%`),
    and `rust_cached_snapshot_chunk_apply_ms` `271 -> 283`
    (`+12ms`, `+4.4%`). The runtime change was reverted.
    Post-revert control on the same accepted 500k baseline was back in the
    retained band: `rust_bootstrap_ms` `593.35 -> 598.25` (`+4.90ms`,
    `+0.8%`), `rust_pull_apply_ms` `322 -> 326` (`+4ms`, `+1.2%`),
    `rust_snapshot_chunk_apply_ms` `275 -> 276` (`+1ms`, `+0.4%`),
    `rust_cached_snapshot_chunk_apply_ms` `271 -> 275` (`+4ms`, `+1.5%`),
    and `browser_served_rust_wasm_bytes` unchanged.
    100k full/read guardrail after the revert also stayed in range:
    `rust_bootstrap_ms` `138.04 -> 142.09` (`+4.05ms`, `+2.9%`),
    `rust_pull_apply_ms` `73 -> 77` (`+4ms`, `+5.5%`),
    `rust_snapshot_chunk_apply_ms` `62 -> 64` (`+2ms`, `+3.2%`),
    `rust_local_list_p50_ms` `0.27 -> 0.25` (`-0.02ms`),
    `rust_local_search_p50_ms` `1.39 -> 1.43` (`+0.04ms`),
    and `rust_aggregate_p50_ms` `22.06 -> 23.06` (`+1ms`).
  - Rejected follow-up: preserving generated binary sync-pack row groups in the
    browser decoder and applying whole commit groups through the binary SQLite
    batch path. The target incremental lane improved, but the broad bootstrap
    guardrail regressed, so the runtime change was reverted.
    - Incremental/realtime candidate, accepted 10k + 1k baseline:
      `rust_incremental_pull_ms` `12.58 -> 10.38` / `10.81`
      (`-17.5%` / `-14.1%`),
      `rust_incremental_sync_pack_decode_ms` `2 -> 0`,
      `rust_incremental_pull_apply_ms` stayed `3`,
      `rust_realtime_http_request_count` stayed `0`, and served Rust WASM
      bytes moved `3,326,638 -> 3,323,052` (`-3,586` bytes).
    - Rejection reason, accepted 500k bootstrap-only baseline, two candidate
      runs:
      `rust_bootstrap_ms` `593.35 -> 625.51` / `623.71`
      (`+5.4%` / `+5.1%`),
      `rust_pull_apply_ms` `322 -> 334` / `343`
      (`+3.7%` / `+6.5%`),
      `rust_snapshot_chunk_apply_ms` `275 -> 285` / `289`
      (`+3.6%` / `+5.1%`),
      `rust_cached_pull_apply_ms` `313 -> 338` / `330`
      (`+8.0%` / `+5.4%`), and
      `rust_cached_snapshot_chunk_apply_ms` `271 -> 290` / `284`
      (`+7.0%` / `+4.8%`).
    - Post-revert control on the incremental/realtime lane restored the served
      WASM bytes to `3,326,638` and the sync-pack decode/apply buckets to the
      accepted shape (`rust_incremental_sync_pack_decode_ms` `2`,
      `rust_incremental_pull_apply_ms` `3`). The remaining latency drift in
      that control matched TS push/realtime drift and was not retained as a
      runtime change.

### Phase 4: Worker Default

- Status: mostly implemented for browser benchmark/runtime paths.
- Public browser database creation already uses the Syncular v2 worker client.
- The browser local-mutation benchmark now treats the OPFS worker runtime as
  the default Rust browser metric. The old direct IndexedDB Rust-owned helper is
  skipped by default and can be included explicitly with
  `--include-direct-rust` for isolated diagnostics.
- Validated both benchmark shapes with release WASM: default output only emits
  the worker Rust metric, while `--include-direct-rust` restores the direct
  IndexedDB diagnostic metric.
- Remaining work: remove or quarantine other direct-browser helpers once no
  tests need them for low-level storage diagnostics.

### Phase 5: Server Binary Snapshot Encoder

- Status: started.
- Added generic server-side `binary-table-v1` chunk emission when the client
  advertises `binary-table-v1`.
- Added handler-provided `snapshotBinaryColumns` so generated server handlers
  can bypass generic column inference in binary chunk encoding.
- Added coverage that pull bootstrap returns binary snapshot chunk refs and
  decodable binary payloads.
- Added coverage that handler-provided binary snapshot columns are emitted in
  stable order and type shape.
- Added browser/Hono coverage that worker sync receives binary chunks and
  applies them through the fast path.
- Wired the generated TypeScript server output to emit
  `syncularGeneratedServerSnapshotBinary`, and the Hono browser harness now
  passes that contract once through `createSyncRoutes({ snapshotBinary })`.
- Local Hono/browser measurement with generated snapshot columns still confirms
  binary-only chunks, but this run was slower than the previous local sample:
  - 2k rows, 500-row pages: 4 binary chunks, 0 JSON chunks, wall
    `100.8-106.3ms`.
  - 10k rows, 1k-row pages: 10 binary chunks, 0 JSON chunks, wall
    `242.8-253.9ms`.
  - Treat this as correctness/coverage for generated metadata, not a proven
    speedup. The next server-side benchmark should isolate encode time from
    browser SQLite apply/runtime noise.
- Isolated server binary snapshot metadata benchmark, 20k rows, 1k-row pages,
  20 chunks:
  - inferred columns: wall `113.8-115.5ms`, `rowFrameEncodeMs=72ms`.
  - generated columns: wall `77.6-79.6ms`, `rowFrameEncodeMs=53-54ms`.
  - generated metadata removed about `18-19ms` of encode work and
    `34-38ms` wall time in this local run.
- Added generated table-specific `binary-table-v1` encoders. Server handlers
  can now receive `snapshotBinaryEncoder` from the collection-level generated
  server contract; generated TypeScript emits the encoders only from the
  server generated artifact. The generic object-row encoder remains available
  for non-generated server handlers.
- Isolated binary encode benchmark using the generated tasks rows:
  - 100k rows: generic median `43.25ms`, generated median `33.46ms`,
    same `7,077,900` byte payload.
  - 500k rows: generic median `218.18ms`, generated median `163.23ms`,
    same `36,277,900` byte payload.
  - This removes roughly 22-25% of local table encoding time by avoiding the
    generic per-cell `row[column.name]` loop and type switch.
- Browser E2E 100k release-WASM before/after on the same harness:
  - before: Rust bootstrap `207.99ms`, pull request `124ms`, apply `81ms`.
  - after first run: Rust bootstrap `200.75ms`, pull request `117ms`,
    apply `81ms`.
  - after second run was globally noisy (`TS 747ms -> 1015ms`, Rust
    `200.75ms -> 278.13ms`) and is not used as a reject signal. The isolated
    encoder benchmark is the reliable signal for this server-side slice.
- Added first-class server bootstrap timing metrics to the Rust browser
  transport and E2E scoreboard. The browser client opts into the existing
  Hono `x-syncular-bench-pull-timings` header only for benchmark pull options,
  then records:
  - `rust_server_bootstrap_snapshot_query_ms`
  - `rust_server_bootstrap_row_frame_encode_ms`
  - `rust_server_bootstrap_chunk_cache_lookup_ms`
  - `rust_server_bootstrap_chunk_gzip_ms`
  - `rust_server_bootstrap_chunk_hash_ms`
  - `rust_server_bootstrap_chunk_persist_ms`
- Battery-saver-mode smoke, 1k rows, release WASM: server query `2ms`, row
  frame encode `2ms`, cache/gzip/hash/persist all `0ms`, proving the buckets
  are wired. Do not use that run for latency regression claims.
- Cache binary chunks in final compressed wire format.
- Measure server encode time, chunk size, client decode time, SQLite apply
  time, and peak memory against `json-row-frame-v1`.

### Phase 6: Binary Sync Packs

- Status: started.
- Added `json-v1` / `binary-sync-pack-v1` negotiation on pull and combined sync
  requests.
- Rust runtime/browser clients now request only `binary-sync-pack-v1` sync
  packs. This is retained as protocol cleanup, not a performance target.
- Added a versioned `binary-sync-pack-v1` combined-response envelope in
  `@syncular/core` with coverage for push acks, conflicts, pull subscriptions,
  commits, snapshot chunk refs, cursors, and schema-version metadata.
- Hono combined sync now emits `application/vnd.syncular.sync-pack.v1` when a
  client advertises the binary pack.
- Browser HTTP transport and Rust native/web transports decode binary
  sync-pack responses.
- Current scope: binary pack removes the outer response JSON envelope. Row
  payloads inside incremental commits are still JSON values until binary delta
  encoders land.
- Added binary sync-pack wire version 3 for compact incremental change
  metadata. Incremental changes now encode `op` as a byte and stored scopes as
  typed string pairs instead of a JSON object. The current v5 decoder rejects
  older sync-pack versions instead of carrying old wire branches.
- Validated v3 through core round-trip tests, server pull tests, Rust
  native/web checks, and browser Hono WASM sync/live-query tests.
- Local Rust perf slice after v3 passed with `PERF_RUST_NATIVE_ROUNDS=3` /
  `PERF_RUST_NATIVE_WARMUP=3`. Median samples from this run:
  - native insert batch 100: `5.8ms`
  - native update batch 100: `9.2ms`
  - native list 400 JSON rows: `0.6ms`
  - HTTP pull catchup 100: `2.2ms`
  - WebSocket client-to-client catchup 100: `8.8ms`
  - browser WASM size: `3120.9KiB` raw / `1282.1KiB` gzip, still inside the
    configured package budget but above the older regression baseline.
- Gap: the perf lane still does not isolate incremental row decode/apply
  against the old JSON-string row payload. Add a targeted incremental pull
  microbenchmark before using generic sync-pack numbers as evidence for the
  final table-specific delta design.
- Ad-hoc TS encode/decode microbench on the current tree shows the v4 generic
  JSON-value row codec is not a server-side performance win:
  - 10k incremental rows: JSON response stringify/parse `3.2ms` / `7.1ms`;
    binary v4 encode/decode `68.2ms` / `20.4ms`; binary size `92.6%` of JSON.
  - 50k incremental rows: JSON response stringify/parse `15.8ms` / `38.2ms`;
    binary v4 encode/decode `360.0ms` / `100.1ms`; binary size `91.9%` of JSON.
  - Conclusion: the v4 generic row codec was removed. The actual performance
    path must be generated table-specific encoders/decoders, not a generic
    per-value TS byte codec.
- Re-ran the same 50k-row sync-pack microbench after reverting to v3:
  - JSON response stringify/parse: `15.4ms` / `37.0ms`.
  - binary v3 encode/decode: `94.3ms` / `43.8ms`.
  - binary v3 size: `82.4%` of JSON.
  - Conclusion: v3 is useful mainly for response size and envelope structure,
    not encode/decode CPU. The next CPU win must come from generated
    table-specific binary deltas.
- Retained a streaming `binary-sync-pack-v1` writer for the TypeScript core
  encoder. The old writer allocated one `Uint8Array` per scalar and copied all
  chunks at finish; the new writer grows one buffer, writes numeric fields
  directly, and uses an ASCII string fast path with UTF-8 fallback.
  - Valid 50k incremental-change microbench:
    `binaryEncodeMs` `135.31 -> 39.36`, `binaryDecodeMs` `77.87 -> 63.67`,
    with identical binary bytes (`11,580,698`).
  - Same-session 100k release-WASM bootstrap A/B was neutral:
    before `rust_bootstrap_ms` `185.04`, after `184.00-184.44`; cached
    bootstrap stayed in the same small noise band (`96.50` before,
    `97.40-98.35` after).
  - 500k release-WASM bootstrap guardrail stayed acceptable against the
    retained baseline: first bootstrap `828.21 -> 842.65`, cached bootstrap
    `459.20 -> 438.19`, response bytes unchanged (`3,777,162`).
- Added a maintained perf lane for the sync-pack codec in
  `tests/perf/rust-client.perf.test.ts`. It emits JSON encode/decode, binary
  encode/decode, and response-size metrics for a generated incremental-change
  response. Defaults are 50k changes, with `PERF_SYNC_PACK_CHANGES`,
  `PERF_SYNC_PACK_ROUNDS`, and `PERF_SYNC_PACK_WARMUP` overrides for local
  iteration.
- Added `binary-sync-pack-v1` wire version 4 for grouped generated binary row
  payloads in incremental commits. Commit/change metadata still preserves row
  order and scopes, but upsert row bodies can now be grouped by table and
  encoded with generated `binary-table-v1` row encoders. The Rust decoder
  understands v4 and expands grouped binary rows back into ordinary
  `SyncChange.row_json` values before apply. Hono passes generated table
  snapshot encoders as change-row encoders when available.
  - 50k generated incremental-change perf lane:
    JSON encode/decode `15.9ms` / `39.9ms`;
    v4 binary inline JSON encode/decode `29.7ms` / `51.4ms`;
    v4 generated row-group encode/decode `26.1ms` / `50.2ms`.
  - Response size moved from JSON `13910.9KiB` to binary inline JSON
    `11138.4KiB` to generated row groups `6764.6KiB`.
  - Browser 100k release-WASM bootstrap guardrail stayed neutral:
    `rust_bootstrap_ms` `185.04 -> 182.82`,
    `rust_pull_request_ms` stayed `87`,
    `rust_pull_apply_ms` `94 -> 93`, and response bytes stayed `765,774`.
- Added a real incremental browser E2E lane to the scoreboard and perf gate.
  It pushes new rows through the TS client/outbox/server path, then measures
  Rust pull/apply catch-up with fresh transport stats.
  - Smoke, 100 bootstrap rows + 10 incremental rows:
    `ts_incremental_push_ms` `15.43`, `rust_incremental_pull_ms` `7.06`,
    `rust_incremental_pull_request_ms` `5`, `rust_incremental_pull_apply_ms`
    `2`, response bytes `2,373`, final Rust rows `110`.
  - Baseline, 1k bootstrap rows + 200 incremental rows:
    `ts_incremental_push_ms` `24.75`, `rust_incremental_pull_ms` `17.62`,
    `rust_incremental_pull_request_ms` `9`, `rust_incremental_pull_apply_ms`
    `7`, response bytes `42,953`, final Rust rows `1,200`.
  - Guardrail, 100k bootstrap rows + 200 incremental rows:
    `rust_bootstrap_ms` `181.28`, `rust_pull_request_ms` `88`,
    `rust_pull_apply_ms` `90`, cached bootstrap `97.16`,
    `ts_incremental_push_ms` `21.64`, `rust_incremental_pull_ms` `14.79`,
    `rust_incremental_pull_request_ms` `6`, `rust_incremental_pull_apply_ms`
    `7`, response bytes `42,953`, final Rust rows `100,200`.
  - Perf smoke with
    `PERF_RUST_BROWSER_E2E_INCREMENTAL_ROWS=10` reported
    `rust_browser_e2e_rust_incremental_pull_ms` `7.7`,
    request `5.0`, apply `2.0`, response `2.3KiB`.
- Retained browser incremental apply cleanup: when `collectChangedRows=false`,
  the web client no longer reads the previous row for each snapshot/include-row
  or commit change only to discard it. The previous-row read stays enabled for
  row/field-delta collection.
  - 1k bootstrap rows + 200 incremental rows:
    `rust_incremental_pull_ms` `17.62 -> 15.80`,
    `rust_incremental_pull_apply_ms` `7 -> 5`, response bytes unchanged
    (`42,953`).
  - 100k bootstrap rows + 200 incremental rows:
    `rust_incremental_pull_ms` `14.79 -> 13.99`,
    `rust_incremental_pull_apply_ms` `7 -> 5`, bootstrap/apply guardrails
    stayed neutral (`rust_bootstrap_ms` `181.28 -> 180.15`,
    `rust_pull_apply_ms` `90 -> 90`), response bytes unchanged (`42,953`).
- Retained follow-up cleanup: when `collectChangedRows=false`, incremental
  commit changes are moved into the web store instead of cloned before apply.
  The changed-row path still clones because it needs the row payload after
  applying.
  - 1k bootstrap rows + 200 incremental rows:
    `rust_incremental_pull_ms` `15.80 -> 14.95`,
    `rust_incremental_pull_apply_ms` stayed `5`.
  - 100k bootstrap rows + 200 incremental rows:
    `rust_incremental_pull_ms` `13.99 -> 12.62`,
    `rust_incremental_pull_apply_ms` `5 -> 4`, response bytes unchanged
    (`42,953`).
- Retained browser incremental change batching: when `collectChangedRows=false`,
  ordinary app-table `upsert` changes without Yjs envelopes are grouped by
  table and sent through the existing `upsert_rows` multi-row SQLite path.
  Deletes, encrypted CRDT system rows, Yjs-envelope changes, and unknown tables
  still use the existing per-change fallback.
  - 100k bootstrap rows + 5k incremental rows:
    `rust_incremental_pull_ms` `105.97 -> 54.02`,
    `rust_incremental_pull_apply_ms` `70 -> 18`, request stayed `35`,
    response bytes unchanged (`1,091,633`).
  - 1k bootstrap rows + 200 incremental rows:
    `rust_incremental_pull_ms` `14.95 -> 11.86`,
    `rust_incremental_pull_apply_ms` `5 -> 2`, response bytes unchanged
    (`42,953`).
  - 100k bootstrap rows + 200 incremental rows:
    local apply improved `4 -> 2`; total moved `12.62 -> 15.17` due request
    noise (`8 -> 13`), while bootstrap/apply guardrails stayed neutral.
- Added browser transport instrumentation for binary sync-pack decode time. This
  keeps request latency honest by separating server/fetch time from client-side
  binary-pack decode cost.
  - 100k bootstrap rows + 5k incremental rows:
    `rust_incremental_pull_ms` `53.32`, request `34`,
    apply `18`, sync-pack decode `11`, response bytes `1,091,633`.
  - Conclusion: after incremental apply batching, the next meaningful browser
    target is the incremental sync-pack row decode/materialization path, not
    another tiny SQLite apply cleanup.
- Retained binary sync-pack decode cleanup: generated v4 row-group payloads now
  move decoded row maps into their matching `SyncChange` instead of cloning
  each row map after decode.
  - 100k bootstrap rows + 5k incremental rows:
    `rust_incremental_pull_ms` `53.32 -> 50.86`,
    request `34 -> 32`, sync-pack decode `11 -> 9`, apply stayed `18`,
    response bytes unchanged (`1,091,633`).
  - Complexity check: this is a net simplification of ownership in the decoder,
    so the modest gain is acceptable.
- Retained browser SQLite row materialization guard: app rows now skip Yjs/CRDT
  materialization when the table has CRDT metadata but the incoming row has no
  Yjs envelope, no non-empty server-merge state, and no encrypted update-log
  field requiring preservation.
  - 100k bootstrap rows + 5k incremental rows:
    `rust_incremental_pull_ms` `50.86 -> 48.40`,
    `rust_incremental_pull_apply_ms` `18 -> 14`,
    request noise `32 -> 33`, sync-pack decode stayed `9`,
    response bytes unchanged (`1,091,633`).
  - Complexity check: the branch documents the real semantic boundary between
    ordinary rows and CRDT rows, so this is a foundation cleanup rather than a
    benchmark-only special case.
- Rejected conditional row key/version replacement in incremental apply. It
  avoided replacing primary-key and server-version map entries when the row
  already contained matching values, but it added branches without improving
  the measured hot path:
  - 100k bootstrap rows + 5k incremental rows:
    `rust_incremental_pull_ms` `48.40 -> 48.14`,
    `rust_incremental_pull_apply_ms` stayed `14`,
    sync-pack decode noise `9 -> 10`.
  - Decision: reverted; not enough signal for the extra conditional logic.
- Superseded first websocket delta slice: the browser worker briefly supported
  applying JSON websocket `changes` payloads directly through Rust-owned SQLite
  instead of treating every realtime frame as a pull wakeup.
  - Guard: inline apply only runs for non-empty changes with a finite cursor
    and an empty local outbox; otherwise it falls back to HTTP pull.
  - Measurement/validation at the time: the worker unit test asserted `syncPulls === 0`
    for an inline frame, and the real Hono/WASM websocket test counts combined
    HTTP pull requests and proves the live-query update arrives with `0`
    additional HTTP pulls after the realtime push.
  - Smoke perf after the change still passes the Rust perf gate on the small
    browser E2E lane: 100 bootstrap rows + 10 incremental rows measured
    `rust_incremental_pull_ms` `7.2`, request `6`, apply `0`, sync-pack decode
    `1`. This lane is not the target win; the target win is removing the extra
    realtime HTTP round trip for inline websocket payloads.
  - Later WP-04 decision: removed. The current Rust-first realtime path is
    binary sync-pack delivery or explicit pull-required wakeup; JSON websocket
    row deltas are not part of the retained protocol.
- Retained binary websocket delta-pack slice: browser realtime now advertises
  `syncPackEncoding=binary-sync-pack-v1`, Hono encodes the same generated
  binary sync-pack format used by HTTP pull, and the worker routes `SSP1`
  binary frames directly into Rust-owned SQLite.
  - Guard: only negotiated clients receive binary frames; non-negotiated
    clients receive explicit pull-required wakeups, and oversized binary packs
    also fall back to pull wakeups. Mixed-scope commits use per-connection
    scoped binary packs.
  - Measurement/validation: server manager coverage proves binary frames go
    only to negotiated clients, worker coverage proves `0` HTTP pulls for a
    binary frame, and the real Hono/WASM websocket test proves a negotiated
    browser client gets the live-query update with `0` additional HTTP pulls.
  - Smoke perf after the change still passes. On the small browser E2E lane,
    100 bootstrap rows + 10 incremental rows measured
    `rust_incremental_pull_ms` `6.2`, request `5`, apply `1`, sync-pack decode
    `0`. WASM size moved from the prior local dev measurement of roughly
    `3226.9 KiB` raw / `1324.4 KiB` gzip to `3233.4 KiB` raw /
    `1326.0 KiB` gzip.
  - Complexity check: this is retained because it uses the existing
    sync-pack encoder/decoder and removes protocol divergence between HTTP and
    realtime. It is not yet a measured latency win beyond avoiding the HTTP
    pull; future work needs a dedicated realtime latency/bytes lane.
- Retained browser realtime measurement lane: the browser E2E scoreboard now
  enables the benchmark Hono websocket route, opens a Rust live query, pushes a
  TS outbox commit, and measures binary websocket delivery to Rust-owned SQLite
  with explicit HTTP fallback counters.
  - Local dev-WASM smoke:
    `SYNCULAR_BROWSER_WASM_PROFILE=dev bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=100 --incremental-rows=10 --query-iterations=1 --wasm-profile=dev --json --output=.context/benchmarks/browser-e2e-realtime-lane-100-10.json`
  - Result: `rust_realtime_live_ms` `16.50`,
    `rust_realtime_http_request_count` `0`,
    `rust_realtime_http_request_bytes` `0`,
    `rust_realtime_http_response_bytes` `0`,
    `rust_realtime_binary_events` `1`,
    `rust_realtime_binary_bytes` `2267`,
    `rust_realtime_rows` `120`.
  - Normal perf-harness smoke with the same 100 + 10 lane also passes and now
    keeps `count` metrics instead of dropping them:
    `rust_browser_e2e_realtime_iterations` `2.0`,
    `rust_browser_e2e_rust_realtime_live_ms` `10.0`,
    `rust_browser_e2e_rust_realtime_live_p95_ms` `13.6`,
    `rust_browser_e2e_rust_realtime_http_request_count` `0.0`,
    `rust_browser_e2e_rust_realtime_http_request_kib` `0.0`,
    `rust_browser_e2e_rust_realtime_http_response_kib` `0.0`,
    `rust_browser_e2e_rust_realtime_binary_events` `2.0`,
    and `rust_browser_e2e_rust_realtime_binary_kib` `4.5`.
  - Larger release-WASM single-iteration lane:
    `SYNCULAR_BROWSER_WASM_PROFILE=release bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --query-iterations=0 --wasm-profile=release --json --output=.context/benchmarks/browser-e2e-realtime-lane-10k-1k-release.json`
  - Result: `rust_realtime_live_ms` `91.55`,
    `ts_realtime_push_ms` `74.03`,
    `rust_realtime_http_request_count` `0`,
    `rust_realtime_binary_events` `5`,
    `rust_realtime_binary_bytes` `207005`. The measured websocket/apply/live
    remainder is roughly `17.5ms` after subtracting the TS push portion.
  - Larger release-WASM repeated lane:
    `SYNCULAR_BROWSER_WASM_PROFILE=release bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --wasm-profile=release --json --output=.context/benchmarks/browser-e2e-realtime-lane-10k-1k-x3-release.json`
  - Result: `rust_realtime_live_ms` `93.86`,
    `rust_realtime_live_p95_ms` `99.82`,
    `ts_realtime_push_ms` `75.44`,
    `ts_realtime_push_p95_ms` `78.31`,
    `ts_realtime_push_total_ms` `229.18`,
    `rust_realtime_http_request_count` `0`,
    `rust_realtime_binary_events` `15`,
    `rust_realtime_binary_bytes` `639015`.
  - Complexity check: this is benchmark instrumentation and reuses the same
    Hono websocket route/runtime path as the product tests; it is retained as
    a measurement gate, not as a runtime optimization.
- Retained mixed-scope websocket filtering: Hono no longer falls back to
  cursor-only wakeups just because one pushed commit touches multiple scopes.
  The websocket manager now accepts per-connection binary sync-packs, and the
  Hono route filters emitted changes by each connection's effective subscription
  scopes before encoding a binary sync-pack.
  - Correctness guard: the browser/Hono WASM realtime test now pushes one
    mixed-scope commit and proves two connected clients receive only their own
    scoped rows while `httpPullCount()` does not increase.
  - Single-scope perf guard after the change, same 10k + 1k x3 release lane:
    `rust_realtime_live_ms` `87.04`,
    `rust_realtime_live_p95_ms` `88.82`,
    `ts_realtime_push_ms` `70.84`,
    `rust_realtime_http_request_count` `0`,
    `rust_realtime_binary_events` `15`,
    `rust_realtime_binary_bytes` `639015`. This is neutral/slightly faster
    than the pre-change measurement (`93.86` p50 / `99.82` p95), within local
    run noise.
  - Normal perf-harness smoke after the change also passes with
    `rust_browser_e2e_rust_realtime_live_ms` `12.4`,
    `rust_browser_e2e_rust_realtime_live_p95_ms` `14.9`,
    `rust_browser_e2e_rust_realtime_http_request_count` `0.0`,
    and `rust_browser_e2e_rust_realtime_binary_events` `2.0`.
  - Complexity check: this is not a micro-optimization. It removes a real
    correctness/perf fallback for multi-tenant or multi-scope commits while
    preserving bounded payload fallback and the shared-pack fast path for
    single-scope commits.
- Retained first ack/resume reliability slice for websocket delta delivery.
  The browser worker now sends `{type:"ack", cursor}` after successful binary
  realtime apply or pull recovery, Hono records monotonic cursor acks without
  replacing effective scopes, and reconnecting websocket sessions receive a
  cursor-only catch-up wakeup when their recorded server cursor lags the latest
  partition commit.
  - Correctness guard: worker unit coverage asserts binary applies and recovery
    pulls send cursor acks; server route coverage asserts cursor acks update
    only the cursor and preserve effective scopes; server route coverage also
    asserts a reconnecting stale cursor receives a catch-up wakeup.
  - Integration guard: the browser/Hono WASM realtime suite still passes,
    including direct binary websocket delta apply, mixed-scope filtering, and
    auth-param reconnect.
  - Normal perf-harness smoke after the change reports
    `rust_browser_e2e_rust_realtime_live_ms` `11.6`,
    `rust_browser_e2e_rust_realtime_live_p95_ms` `14.1`,
    `rust_browser_e2e_rust_realtime_http_request_count` `0.0`,
    and `rust_browser_e2e_rust_realtime_binary_events` `2.0`.
  - Single-scope perf guard after the change, same 10k + 1k x3 release lane:
    `rust_realtime_live_ms` `87.64`,
    `rust_realtime_live_p95_ms` `93.17`,
    `ts_realtime_push_ms` `70.77`,
    `rust_realtime_http_request_count` `0`,
    `rust_realtime_binary_events` `15`,
    `rust_realtime_binary_bytes` `639015`. This is effectively neutral versus
    the prior mixed-scope filtering measurement (`87.04` p50 / `88.82` p95)
    and keeps the no-HTTP-fallback guarantee.
  - Complexity check: the extra ack frame is a reliability contract, not a hot
    path optimization. It reuses the existing client cursor table and avoids a
    full websocket envelope rewrite while making reconnect recovery explicit.
- Retained binary sync-pack wire version 6 with a per-pack table dictionary
  for incremental commit changes and generated row groups. The current
  Rust-first protocol now writes table names once per sync-pack and encodes
  `u16` table indexes in change metadata and row-group metadata. The v5 branch
  was removed instead of kept as a compatibility fallback.
  - Correctness guard:
    `bun test packages/core/src/__tests__/sync-packs.test.ts`,
    `bun --cwd packages/core tsgo`,
    `bun --cwd rust/bindings/browser tsgo`,
    `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime decodes_v6_table_dictionary_changes`,
    and `bun run --cwd rust/bindings/browser test:wasm:hono` all passed.
  - Test-harness cleanup required for the Hono websocket test: root `bun test`
    preloads HappyDOM for React tests, so the realtime Bun server now converts
    non-websocket Hono HTTP responses back to the native Bun `Response` class
    captured by the preload. This is test isolation only; websocket upgrade
    handling is unchanged.
  - Targeted 50k sync-pack codec lane, current v6 versus the immediate pre-v6
    measurement:
    generic binary encode `24.1ms -> 22.3ms` (`-1.8ms`, `-7.5%`),
    generic binary decode `42.9ms -> 32.5ms` (`-10.4ms`, `-24.2%`),
    generated binary encode `21.8ms -> 18.3ms` (`-3.5ms`, `-16.1%`),
    generated binary decode `37.6ms -> 34.9ms` (`-2.7ms`, `-7.2%`).
    Generic binary response size moved `11138.4KiB -> 10894.3KiB`
    (`-244.1KiB`, `-2.2%`); generated binary response size moved
    `6764.6KiB -> 6520.5KiB` (`-244.1KiB`, `-3.6%`). JSON encode/decode
    also drifted (`11.7ms/32.9ms -> 10.8ms/27.0ms`), so CPU gains are treated
    as directional and the byte reduction is the strongest signal.
  - Release browser E2E guardrail, 10k bootstrap + 1k incremental x3 realtime,
    against `.context/benchmarks/browser-e2e-incremental-realtime-baseline.json`:
    `rust_incremental_response_bytes` `215733 -> 210763`
    (`-4970 bytes`, `-2.3%`), `rust_realtime_binary_bytes`
    `639015 -> 624105` (`-14910 bytes`, `-2.33%`),
    `rust_incremental_pull_apply_ms` stayed `3`,
    `rust_incremental_sync_pack_decode_ms` stayed `2`,
    realtime HTTP fallback stayed `0`, `rust_realtime_binary_events` stayed
    `15`, and release WASM size moved `3326638 -> 3326710` bytes (`+72`).
    Realtime latency drifted within the local noise band:
    `rust_realtime_live_ms` `66.76 -> 69.19`,
    `rust_realtime_live_p95_ms` `68.34 -> 72.42`.
  - External `/Users/bkniffler/GitHub/sync/offline-sync-bench` validation was
    attempted for this batch, but Docker Compose did not return for either
    `up --build -d` or `ps`; both compose processes were stopped after hanging.
    Do not treat this as external branch-server evidence for or against v6.
- Retained binary sync-pack wire version 7 with a per-pack scope dictionary.
  Incremental change metadata now stores a `u32` scope index instead of
  rewriting the same scope map on every changed row. Single-key scope maps use
  a nested lookup instead of concatenated dictionary keys because the first
  canonical-key candidate saved bytes but regressed encode CPU too much.
  - Rejected v7 first pass: sorted/canonical scope keys reduced response bytes
    but made the 50k codec lane too expensive:
    generic binary encode `22.3ms -> 30.6ms`,
    generated binary encode `18.3ms -> 28.8ms`. That version was simplified
    before retention.
  - Correctness guard:
    `bun test packages/core/src/__tests__/sync-packs.test.ts`,
    `bun --cwd packages/core tsgo`,
    `bun --cwd rust/bindings/browser tsgo`,
    `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime decodes_v7_table_and_scope_dictionary_changes`,
    and `bun run --cwd rust/bindings/browser test:wasm:hono` all passed.
  - Follow-up cleanup: the encoder now computes each change's table/scope
    dictionary indexes once and reuses them for row-group metadata and change
    metadata. This removed duplicate per-change `Object.entries`/map lookups.
  - Targeted 50k sync-pack codec lane, v7 final versus retained v6:
    generic binary encode `22.3ms -> 20.6ms` (`-1.7ms`, `-7.6%`),
    generic binary decode `32.5ms -> 25.1ms` (`-7.4ms`, `-22.8%`),
    generated binary encode `18.3ms -> 19.6ms` (`+1.3ms`, `+7.1%`),
    generated binary decode `34.9ms -> 24.7ms` (`-10.2ms`, `-29.2%`).
    Generic binary response size moved `10894.3KiB -> 9478.3KiB`
    (`-1416.0KiB`, `-13.0%`); generated binary response size moved
    `6520.5KiB -> 5104.5KiB` (`-1416.0KiB`, `-21.7%`).
  - Release browser E2E guardrail, 10k bootstrap + 1k incremental x3 realtime:
    against the checked baseline, `rust_incremental_response_bytes`
    `215733 -> 181948` (`-33785 bytes`, `-15.66%`),
    `rust_realtime_binary_bytes` `639015 -> 537660`
    (`-101355 bytes`, `-15.86%`), `rust_incremental_sync_pack_decode_ms`
    `2 -> 1`, and realtime HTTP fallback stayed `0`. Against the immediately
    retained v6 run, incremental bytes moved `210763 -> 181948` and realtime
    bytes moved `624105 -> 537660`, while realtime p50 was effectively flat
    (`69.19ms -> 70.13ms`) and p95 improved (`72.42ms -> 70.61ms`).
    Release WASM size moved from the v6 run `3326710 -> 3328081` bytes
    (`+1371`, `+0.04%`), still inside the size budget.
  - Broader 100k release guardrail after retention was neutral:
    `rust_bootstrap_ms` `138.04 -> 136.37`,
    `rust_pull_apply_ms` `73 -> 72`,
    `rust_snapshot_chunk_apply_ms` stayed `62`,
    `rust_cached_bootstrap_ms` `68.43 -> 68.84`,
    `rust_local_list_p50_ms` `0.27 -> 0.21`,
    `rust_local_search_p50_ms` `1.39 -> 1.52`,
    `rust_aggregate_p50_ms` `22.06 -> 21.99`, and served Rust WASM bytes
    matched the v7 release build at `3328081`.
  - Rejected commit actor dictionary candidate. It moved commit actor ids into
    a per-subscription dictionary, but the maintained 50k sync-pack lane showed
    no byte improvement and worse CPU:
    v7 final generic encode/decode `20.6ms/25.1ms`,
    v7 final generated encode/decode `19.6ms/24.7ms`, sizes
    `9478.3KiB/5104.5KiB`;
    v8 candidate generic encode/decode `20.6ms/27.2ms`,
    generated encode/decode `20.9ms/26.5ms`, sizes unchanged at
    `9478.3KiB/5104.5KiB`. Reverted; it adds another protocol dictionary
    without a measurable win.

### Phase 7: Delta WebSocket Runtime

- Status: mostly complete for browser steady-state deltas; remaining work is
  durable sequenced sessions and server-side replay windows.
- Done: websocket negotiation advertises binary sync-pack support for the
  browser worker.
- Done: bounded binary delta packs stream over websocket for negotiated clients.
- Done: browser E2E scoreboard has a Rust realtime latency/bytes lane with
  HTTP fallback counters.
- Done: mixed-scope commits use per-connection binary websocket packs filtered
  by each connected client's effective scopes.
- Done: browser websocket clients ack successfully applied realtime cursors;
  Hono records monotonic realtime acks and sends reconnect catch-up wakeups
  when the recorded cursor lags.
- Done: realtime apply results no longer echo applied commits back over the
  wasm boundary. The worker only needs changed-row metadata plus subscription
  cursors, so commit rows remain an input to local apply and integrity
  verification, not a duplicated JSON output.
- Keep HTTP pull as recovery for overflow, reconnect, missed seq, auth refresh,
  large snapshots, and blob transfer.
- Next: design the heavier websocket-first session protocol with server
  sequence ids, explicit replay windows, and bounded in-flight backpressure.

### Phase 8: Compression And Cache Policy

- Status: complete for current gzip/cache policy decisions.
- Keep snapshot chunks gzip-only.
- Benchmark binary snapshot chunk size and gzip CPU cost on native and
  browser/WASM.
- Done: keep compression policy gzip-only; no unsupported compression
  algorithms added.
- Done: snapshot chunk scope cache keys now use a stable v2 semantic key that
  includes partition, effective scope digest, configured schema/cache version,
  chunk encoding, compression, gzip level, and feature flags. The indexed page
  key still carries table, as-of commit, row cursor, row limit, encoding, and
  compression.
  - Correctness guard: unit coverage proves scope and feature ordering are
    stable while schema version, encoding, and gzip level produce distinct
    keys. Hono snapshot chunk download authorization recognizes the v2 key
    without weakening scope checks.
  - Snapshot chunk tests pass for DB metadata storage, external chunk storage,
    scope-bound download authorization, and bundled multi-page chunks.
  - Perf smoke after the change still shows the cached bootstrap path hitting:
    `rust_browser_e2e_rust_bootstrap_ms` `13.9`,
    `rust_browser_e2e_rust_cached_bootstrap_ms` `3.8`,
    `rust_browser_e2e_rust_cached_snapshot_chunk_binary_count` `1.0`, and
    realtime remains no-HTTP-fallback with `rust_browser_e2e_rust_realtime_live_ms`
    `12.6` / p95 `15.4`.
- Done: added a dedicated snapshot chunk perf lane for raw size, gzip size,
  gzip CPU, gunzip CPU, and decode CPU across JSON row-frame and binary table
  chunks.
  - 50k row default measurement:
    `snapshot_chunk_json_raw_50000_kib` `7975.3`,
    `snapshot_chunk_binary_raw_50000_kib` `3210.8`,
    `snapshot_chunk_json_gzip_level_1_50000_kib` `526.4`,
    `snapshot_chunk_binary_gzip_level_1_50000_kib` `367.0`,
    `snapshot_chunk_json_gzip_level_6_50000_kib` `435.6`,
    `snapshot_chunk_binary_gzip_level_6_50000_kib` `341.8`.
  - CPU measurement at 50k rows:
    `snapshot_chunk_json_encode_50000` `15.5ms`,
    `snapshot_chunk_binary_encode_50000` `12.8ms`,
    `snapshot_chunk_json_gzip_level_1_50000` `11.3ms`,
    `snapshot_chunk_binary_gzip_level_1_50000` `6.4ms`,
    `snapshot_chunk_json_gzip_level_6_50000` `18.2ms`,
    `snapshot_chunk_binary_gzip_level_6_50000` `24.8ms`,
    `snapshot_chunk_json_gunzip_50000` `4.1ms`,
    `snapshot_chunk_binary_gunzip_50000` `2.2ms`,
    `snapshot_chunk_json_decode_50000` `28.1ms`,
    `snapshot_chunk_binary_decode_50000` `26.4ms`.
  - Complexity check: keep gzip level 1 as the default. For binary chunks,
    level 6 saves only about 25 KiB per 50k rows over level 1 while adding
    roughly 18ms server CPU in this local run.
  - Browser/WASM snapshot lane, 10k rows, release build:
    `rust_bootstrap_ms` `41.34`,
    `rust_pull_request_ms` `19`,
    `rust_snapshot_fetch_ms` `2`,
    `rust_pull_apply_ms` `20`,
    `rust_snapshot_chunk_decompress_ms` `1`,
    `rust_snapshot_chunk_hash_ms` `0`,
    `rust_snapshot_chunk_decode_ms` `1`,
    `rust_server_bootstrap_chunk_gzip_ms` `2`,
    `rust_server_bootstrap_row_frame_encode_ms` `5`,
    `rust_snapshot_chunk_binary_count` `1`,
    `rust_snapshot_chunk_json_count` `0`,
    `rust_response_bytes` `76572`.
- Decision: do not add another compression algorithm and do not raise the
  default gzip level. The measured win is too small relative to the CPU cost.
- Next: move to Phase 9 websocket-first session/sequencer work, then revisit
  cache persistence only if the session protocol needs resumable snapshot
  manifests.

### Phase 9: Sync Session And Sequencer Design

- Status: started.
- Define the websocket-first session state machine:
  hello, capability negotiation, schema manifest, auth, subscriptions,
  snapshots, delta packs, ack/resume, overflow, and close.
- Done: added an explicit websocket `hello` frame on session open. It carries
  protocol version, server session id, accepted binary sync-pack capability,
  last acked cursor, latest server cursor, effective scope count, and whether
  catch-up sync is required. The browser worker records this as a structured
  realtime diagnostic without triggering an extra pull.
  - Correctness guard: Hono route coverage asserts the hello frame; browser
    worker coverage asserts hello diagnostics do not trigger an HTTP pull.
  - Perf guard after the change:
    `rust_browser_e2e_rust_realtime_live_ms` `12.1`,
    `rust_browser_e2e_rust_realtime_live_p95_ms` `14.6`,
    `rust_browser_e2e_rust_realtime_http_request_count` `0.0`,
    `rust_browser_e2e_rust_realtime_binary_events` `2.0`,
    `rust_browser_e2e_browser_page_sync_encoded_kib` `100.4`,
    `rust_browser_e2e_browser_served_syncular_worker_js_kib` `43.3`.
  - Complexity check: the hello frame is retained because it establishes the
    session/capability contract needed for replay windows and explicit
    overflow handling. The observed cost is a small fixed frame plus roughly
    1.2 KiB worker JS growth.
- Done: cursor-only websocket sync notifications now carry explicit recovery
  semantics. Payload overflow, reconnect catch-up, and generic wakeups mark the
  sync frame with `requiresPull` and a reason instead of relying on an opaque
  cursor-only message. The browser worker includes those fields in realtime
  diagnostics before using the existing HTTP pull recovery path.
  - Correctness guard: manager coverage asserts oversized websocket payloads
    become `payload-too-large` recovery frames; Hono coverage asserts reconnect
    catch-up frames are explicit; browser worker coverage asserts recovery
    diagnostics are emitted before pulling.
  - Perf guard after the change:
    `rust_browser_e2e_rust_realtime_live_ms` `10.6`,
    `rust_browser_e2e_rust_realtime_live_p95_ms` `13.3`,
    `rust_browser_e2e_rust_realtime_http_request_count` `0.0`,
    `rust_browser_e2e_rust_realtime_binary_events` `2.0`,
    `rust_browser_e2e_browser_page_sync_encoded_kib` `101.0`,
    `rust_browser_e2e_browser_served_syncular_worker_js_kib` `43.6`.
- Pick the Cloudflare-compatible sequencer/fanout shard key
  `(tenant/workspace/partition)`.
- Done: added `createSyncRealtimeShardKey()` with stable
  `sync-realtime-v1:<tenant>:<workspace>:<partition>` semantics. Until auth
  exposes tenant/workspace separately, partition is used as the default
  tenant/workspace dimension. Hono commit broadcaster events now include this
  shard key alongside `partitionId`, and websocket hello frames expose the same
  shard key to clients.
  - Correctness guard: unit coverage locks default, explicit, and escaped
    shard-key forms; broadcaster bridge coverage still fans out cross-instance
    commits.
  - Perf guard after the change:
    `rust_browser_e2e_rust_realtime_live_ms` `12.0`,
    `rust_browser_e2e_rust_realtime_live_p95_ms` `14.1`,
    `rust_browser_e2e_rust_realtime_http_request_count` `0.0`,
    `rust_browser_e2e_rust_realtime_binary_events` `2.0`,
    `rust_browser_e2e_browser_page_sync_encoded_kib` `101.1`,
    `rust_browser_e2e_browser_served_syncular_worker_js_kib` `43.7`.
- Define which state lives in the sequencer, D1-like SQL storage, and R2-like
  object storage.
- Decision:
  - Sequencer / Durable Object owns hot websocket session state for one shard:
    connected sessions, negotiated capabilities, per-session subscriptions,
    last acked cursor, bounded replay-window metadata, in-flight pack limits,
    reconnect backoff hints, slow-client overflow decisions, and wakeup fanout.
    It may cache small recent binary packs, but it is not the source of truth
    for committed app data.
  - D1-like SQL storage owns durable truth: app tables, `sync_commits`,
    `sync_changes`, client cursors/effective scopes, CRDT update indexes,
    conflict records, blob metadata, snapshot-chunk metadata, schema manifests,
    and the durable subscription/scope routing indexes. HTTP pull/recovery must
    work from this state even if every websocket session is lost.
  - R2-like object storage owns large immutable artifacts: binary snapshot
    chunks, blob payloads, encrypted CRDT checkpoints, large replay artifacts,
    and historical debug/export bundles. SQL stores only metadata, digests,
    byte lengths, encoding/compression, expiration, and object keys.
  - Stateless Worker routes authenticate, validate, execute push/pull against
    SQL/object storage, and publish compact shard wakeups. They do not own
    long-lived client state.
  - Client recovery rule: any sequencer overflow, missed replay window, auth
    restart, schema mismatch, or object digest failure degrades to HTTP pull
    from durable SQL/object state.
- Deterministic websocket tests for reconnect, resume, auth refresh, slow
  client overflow, and subscription changes are now covered by focused manager
  and Hono route tests.
- Done: added realtime auth refresh coverage. A refreshed bearer token that
  resolves to the same actor can open the websocket session and receive the
  normal hello/capability frame, while an expired token is rejected before
  websocket upgrade.
- Done: added a Hono realtime integration guard for subscription changes. A
  connected websocket starts with no scope membership, receives scope wakeups
  after a pull subscription records effective scopes, then stops receiving that
  scope after a pull clears subscriptions. This keeps realtime fanout tied to
  the authoritative pull/subscription state instead of stale connection state.
- Done: added a bounded in-memory websocket replay window for recent scoped
  notifications. On reconnect, a client whose cursor is still inside the
  window receives recent binary sync-pack deltas directly over websocket; if
  the requested cursor range fell out of the window, the route keeps the
  explicit `reconnect-catchup` HTTP-pull recovery frame. The default window is
  64 notifications and can be disabled with `replayWindowSize: 0`.
  - Correctness guard: manager coverage proves binary replay inside the window
    and refusal after window eviction; Hono route coverage proves a reconnecting
    binary client receives a replayed sync pack instead of a
    `reconnect-catchup` frame.
  - Perf guard on the maintained realtime fanout lane, before versus after:
    indexed fanout stayed flat at `0.5ms`; scan lane was effectively flat at
    `32.6ms -> 32.5ms`.

### Phase 10: Binary Commit Log And Subscription Indexes

- Status: started.
- Add append-only binary commit records optimized for range scan and direct
  delta encoding.
- Add subscription/scope membership indexes for pull and realtime fanout.
- Keep debug/export JSON projection out of the hot path.
- Measure server CPU for range scan, filtering, and fanout before and after
  indexes.
- Done: added a server-scoped incremental pull perf lane. It seeds a SQLite
  sync log with many table commits distributed across users, then repeatedly
  pulls one user's scoped subscription until the cursor catches up. This is the
  measurement gate for deciding whether durable scope/subscription indexes are
  worth their write-time complexity.
  - Initial small guard run:
    `server_scoped_incremental_pull_fanout_1000_10` `6.9ms`,
    `server_scoped_incremental_pull_requests_1000_10` `10`,
    `server_scoped_incremental_pull_changes_1000_10` `100`.
- Done: added durable `sync_scope_commits` routing indexes and switched
  incremental pull to use them directly.
  Push, external row notifications, and proxy oplog writes now populate the
  index; prune/compaction clean it with the rest of the commit log.
  - Measured before/after, same battery-saver environment:
    `server_scoped_incremental_pull_fanout_20000_100` `587.4ms -> 8.1ms`,
    requests `200 -> 2`, changes `200`.
  - Small guard moved from `server_scoped_incremental_pull_fanout_1000_10`
    `6.9ms -> 1.8ms`, requests `10 -> 2`.
  - Follow-up: cross-instance realtime scope lookup now reads
    `sync_scope_commits` directly.
  - Cleanup: removed the remaining SQLite incremental-pull table-window
    compatibility branch and the Hono cross-instance `sync_changes.scopes`
    rebuild path. Current-schema tests seed and consume the scope routing index
    explicitly.
  - Measurement gate for the cleanup, same dense lane command before/after:
    `server_dense_incremental_pull_build_5000_500` `21.0ms -> 21.4ms`,
    binary encode `26.5ms -> 26.0ms`, generated encode `25.8ms -> 26.1ms`.
    A first post-change run drifted slower (`24.2ms` build), but a repeat
    returned to baseline; the removed branches are not taken on the indexed
    dense path.
  - Sparse scope-index guard after the cleanup:
    `server_scoped_incremental_pull_fanout_5000_20` `2.7ms`, requests `2`,
    changes `250`.
- Rejected raw JSON reuse for SQLite incremental rows: keeping the original
  row JSON string attached to parsed row objects made a synthetic codec
  micro-lane faster (`sync_pack_binary_encode_50000` `20.6ms` vs raw JSON
  `13.0ms`), but the real dense server pull lane regressed. WeakMap attachment
  moved dense build/encode from the accepted `21.4ms`/`26.0ms` to
  `23.6ms`/`29.1ms`; a symbol-property variant was worse at
  `28.5ms`/`30.2ms`. The added per-row bookkeeping is not worth retaining.
- Retained sequential incremental commit grouping: the non-dedupe pull path now
  groups already-ordered incremental rows directly instead of building a
  `Map` by commit sequence and then materializing a second array.
  - Immediate dense lane before/after:
    `server_dense_incremental_pull_build_5000_500` `23.4ms -> 22.2ms`,
    binary encode `27.1ms -> 25.6ms`, generated encode `28.2ms -> 27.0ms`.
  - Repeat held the shape:
    `server_dense_incremental_pull_build_5000_500` `21.5ms`, binary encode
    `26.0ms`, generated encode `26.4ms`.
  - Sparse scope-index guard stayed better than the prior cleanup note:
    `server_scoped_incremental_pull_fanout_5000_20` `2.7ms -> 2.3ms`.
- Rejected streaming incremental-row grouping: building the non-dedupe commits
  while iterating dialect rows avoided the intermediate row array, but the
  extra branch/map setup in the shared loop regressed the dense lane. Two runs
  moved from the retained sequential baseline (`21.5ms` build, `26.0ms`
  binary encode) to `23.0ms`/`31.5ms` and `22.6ms`/`30.6ms`, so the refactor
  was reverted.
- Retained Rust-first pull page default/cap of 1000 commits: Rust native/web
  clients, server pull sanitization, Hono route defaults, and dialect
  incremental iterators now use 1000 instead of the old 50/100/500 defaults.
  This does not change the protocol; it changes the current default toward the
  measured Rust-first hot path.
  - Request-sizing measurement on the dense lane:
    `server_dense_incremental_pull_build_5000_50` `74.9ms`,
    binary encode `81.7ms`, requests `100`.
  - 500-commit intermediate retained lane for the same 5k commits:
    build `21.5-23.4ms`, binary encode `26.0-27.1ms`, requests `10`.
  - 1000-commit candidate lane:
    first run build `20.8ms`, binary encode `23.6ms`, requests `5`; repeat
    build `23.4ms`, binary encode `27.2ms`, requests `5`. The latency gain is
    noisy, but request count is consistently halved with total response bytes
    unchanged (`1417.5KiB -> 1417.0KiB`).
  - Sparse scope-index guard with 1000:
    `server_scoped_incremental_pull_fanout_5000_20` `2.2ms`, requests `2`,
    changes `250`.
  - Browser release E2E 10k + 1k incremental x1, before/after 500 default:
    `rust_bootstrap_ms` `33.31 -> 33.06`, `rust_request_count` stayed `2`,
    `rust_incremental_pull_ms` `12.30 -> 12.67`, incremental rounds stayed
    `1`, realtime HTTP fallback stayed `0`. This scenario only emits 5
    incremental commits, so it is a no-regression guard rather than the target
    win. Reports:
    `.context/benchmarks/browser-e2e-limit-commits-before.json` and
    `.context/benchmarks/browser-e2e-limit-commits-after.json`.
  - Browser release E2E after 1000 cap/default:
    `rust_bootstrap_ms` `32.64`, `rust_request_count` stayed `2`,
    `rust_incremental_pull_ms` `12.69`, incremental rounds stayed `1`,
    realtime HTTP fallback stayed `0`, served Rust WASM bytes moved only
    `3328084 -> 3328084` versus the 500 run. Report:
    `.context/benchmarks/browser-e2e-limit-commits-1000.json`.
  - External offline-sync-bench after rebuilding the branch server and Rust
    WASM dev artifact:
    TS/Rust bootstrap completed with 500k `3845.52ms` vs `6043.95ms`
    (`1.57x` slower Rust, improved versus the recent user-provided Rust
    `7934ms` run); Rust 500k local apply was `1718ms`, peak memory `676MB`.
    Local query: TS/Rust list p50 `0.10ms` vs `0.48ms`, search p50 `0.08ms`
    vs `0.71ms`, aggregate read model `5.31ms` vs `0.06ms`, Rust raw SQL
    aggregate `57.15ms`. Rust-only online propagation p50/p95 was
    `24.22ms`/`35.14ms`; Rust reconnect storm was 25 clients `142.16ms`,
    100 clients `235.42ms`, 250 clients `2103.82ms`. TS online-propagation
    failed with the known snapshot chunk integrity mismatch and then hung, so
    no valid TS online/reconnect pair was produced.
- Done: added a dense incremental pull measurement lane that separates server
  response build from response build plus binary sync-pack encoding. This is
  the current measurement gate before adding a durable binary commit log.
  - Baseline dense lane on battery-saver environment:
    `server_dense_incremental_pull_build_5000_500` `36.5ms`,
    `server_dense_incremental_pull_build_binary_encode_5000_500` `41.6ms`,
    `server_dense_incremental_pull_build_generated_binary_encode_5000_500`
    `47.9ms`.
  - Finding: the existing generated row-group encoder is not a free win for
    incremental commit packs in this shape. It was slower and larger than the
    generic binary pack (`1579.7KiB` vs `1349.1KiB`) because the row-group
    framing/schema overhead is better suited to large snapshot-style row
    blocks than small commit pages.
- Done: raised the default internal incremental-pull batch size from `100`
  commits to the request-sized limit capped at `500`. This reduces SQL round
  trips without changing protocol or storage shape.
  - Dense lane after the change:
    `server_dense_incremental_pull_build_5000_500` `36.5ms -> 33.9ms`,
    `server_dense_incremental_pull_build_binary_encode_5000_500`
    `41.6ms -> 37.8ms`,
    `server_dense_incremental_pull_build_generated_binary_encode_5000_500`
    `47.9ms -> 43.4ms`.
  - Sparse scope-index lane stayed stable:
    `server_scoped_incremental_pull_fanout_20000_100` `8.1ms`, requests `2`,
    changes `200`.
- Done: made generated binary row groups conditional on enough same-table rows
  in a single commit. This keeps row-group encoding for large commit packs but
  avoids the schema/framing overhead for common one-row commits and realtime
  updates.
  - Dense lane after the row-group threshold:
    `server_dense_incremental_pull_build_generated_binary_encode_5000_500`
    `43.4ms -> 36.1ms`,
    generated response bytes `1579.7KiB -> 1349.1KiB`.
  - Large synthetic one-commit row pack still keeps the generated win:
    `sync_pack_binary_generated_response_50000_kib` `6764.6KiB` vs generic
    binary `11138.4KiB`; generated decode `46.6ms` vs generic binary decode
    `57.9ms`.
- Done: added an indexed realtime change-scope selector and switched
  mixed-scope websocket binary-pack filtering to use it. The connection
  registry already indexed scope keys to target connections; this removes the
  remaining per-connection full change scan when a commit touches many scopes.
  - Measurement gate:
    `realtime_fanout_filter_scan_5000_1000_500` `43.4ms`,
    `realtime_fanout_filter_indexed_5000_1000_500` `0.7ms`.
  - Correctness guard: the selector preserves source change order and dedupes
    changes that match multiple subscribed scopes. Existing Hono realtime
    connection/scope-change tests still pass.

### Phase 11: Resumable Manifests And Artifact Storage

- Status: started.
- Replace bootstrap mega-responses with snapshot manifests.
- Store binary snapshot chunks, large blobs, and CRDT checkpoints as
  content-addressed artifacts.
- Per-chunk digest verification/revalidation is now covered. Remaining:
  partial-bootstrap resume after an interrupted chunk sequence.
- Measure Worker memory, artifact cache hit cost, and interrupted bootstrap
  recovery.
- Done: removed inline snapshot chunk bodies from binary sync-packs. Pull
  responses now carry compact snapshot chunk refs only, and chunk bodies are
  fetched through the existing `/snapshot-chunks/:chunkId` path.
  - Correctness guard: Hono chunk-storage coverage proves binary sync-pack
    responses can omit chunk bodies, preserve `binary-table-v1` refs, and serve
    the chunk bytes through the authenticated chunk route. Browser/Hono WASM
    sync coverage still passes with the separate-chunk Rust request path.
  - Final release-WASM 100k scoreboard, battery-saver environment:
    `ts_bootstrap_ms` `711.61`, `rust_bootstrap_ms` `139.26`,
    `rust_pull_request_ms` `64`, `rust_snapshot_fetch_ms` `10`,
    `rust_pull_apply_ms` `73`, `rust_request_count` `3`,
    `rust_response_bytes` `765,766`, `rust_snapshot_chunk_binary_count` `2`,
    `rust_snapshot_chunk_json_count` `0`, cached Rust bootstrap `68.77`.
    Report: `.context/benchmarks/browser-e2e-snapshot-separate-100k.json`.
  - Complexity check: this is retained as the first manifest/artifact split.
    It deliberately trades a small number of chunk fetches for resumability,
    cacheable artifacts, and avoiding a single large logical sync response.
    The current 100k guardrail remains well inside the existing Rust-vs-TS
    target band.
- Done: fixed browser Rust schema-version validation to compare server
  `requiredSchemaVersion` and local outbox commit versions against the
  generated app schema version, not the runtime system schema version. This
  matters now that runtime schema and app schema can differ. The browser WASM
  Hono sync suite covers both future server-required versions and future local
  outbox versions.
- Done: changed snapshot chunk reads so routes using external/blob chunk
  storage load only metadata from SQL first, then stream/read the chunk body
  from the blob adapter. The `body` column is selected only for the
  database-backed storage path. This is a memory/Worker-safety improvement for
  the artifact path, not a latency target; the existing chunk storage and Hono
  chunk-route tests cover the behavior.
- Done: added chunk artifact revalidation coverage for binary sync-pack
  snapshot refs. The chunk route now has explicit tests for ETag,
  `X-Sync-Chunk-*` metadata, and `If-None-Match` returning 304 for an
  authorized chunk request. This is a small resume/cache correctness guard, not
  a latency change.
- Done: added browser Rust corrupted-chunk coverage. A snapshot chunk request
  that returns HTTP 200 with bytes that do not match the advertised digest now
  fails before decompression/apply and leaves existing local rows intact.
- Done: added browser Rust interrupted-chunk retry coverage. If a snapshot
  chunk fetch fails, no rows are applied and a later pull can restart the
  snapshot fetch and apply successfully. This proves restart recovery; cached
  partial-bootstrap resume remains open.
- Done: added snapshot checkpoint resume semantics. `binary-sync-pack-v1` wire
  version 9 now carries per-snapshot `bootstrapStateAfter`; the server emits
  the checkpoint for generated and cached snapshot chunks, and the browser Rust
  client persists it after successfully applying each snapshot chunk. Browser
  Hono coverage proves an interrupted second chunk resumes from the first
  applied checkpoint instead of restarting from the beginning. This is a
  correctness/resumability change, not a latency target.
- Done: added explicit chunked snapshot manifests. Chunked pull snapshots now
  carry a v1 manifest with table, `asOfCommitSeq`, scope digest, row cursor
  bounds, page flags, ordered chunk refs, and a SHA-256 manifest digest.
  `binary-sync-pack-v1` moved to wire version 11, and Rust native/browser
  clients validate the manifest before fetching/applying snapshot chunks.
  Inline row snapshots intentionally do not carry a manifest.
  - Correctness guard: shared TypeScript/Rust protocol fixtures include the
    v11 manifest, Rust protocol contract tests reject missing/tampered
    manifests, the Rust testkit chunk helper emits valid manifests, and the
    browser/Hono WASM sync suite passes after rebuilding the release WASM
    artifact.
  - Release-WASM 10k guardrail compared with
    `.context/benchmarks/browser-e2e-limit-commits-1000.json`:
    `rust_bootstrap_ms` `32.64 -> 34.33`,
    `rust_pull_request_ms` `13 -> 15`,
    `rust_snapshot_fetch_ms` stayed `3`,
    `rust_pull_apply_ms` stayed `17`,
    `rust_snapshot_chunk_apply_ms` `13 -> 14`,
    `rust_response_bytes` `76567 -> 77071`,
    `rust_cached_bootstrap_ms` `12.39 -> 13.38`,
    realtime stayed websocket-only with
    `rust_realtime_http_request_count` `0 -> 0`,
    and served Rust WASM bytes moved `3328084 -> 3353028`.
    Report:
    `.context/benchmarks/browser-e2e-snapshot-manifest-v11-10k.json`.
- Done: added canonical subscription-stream commit root verification and
  persisted Rust verified roots. This is a correctness/security change, but it
  is not free on dense incremental pulls because each delivered commit now
  carries `partitionId`, `previousChainRoot`, `commitDigest`, and
  `commitChainRoot`, and the server hashes each commit fragment.
  - Targeted local perf slice, two repeat runs after the change:
    `server_scoped_incremental_pull_fanout_5000_20` `3.2ms` / `3.4ms`
    (previous retained guard was about `2.2-2.7ms`).
    `server_dense_incremental_pull_build_5000_500` `41.6ms` / `43.7ms`
    (previous retained dense build was about `33.9-36.5ms`).
    `server_dense_incremental_pull_build_binary_encode_5000_500`
    `45.2ms` / `43.0ms` (previous retained binary encode was about
    `37.8-41.6ms`).
    `server_dense_incremental_pull_build_generated_binary_encode_5000_500`
    `46.9ms` / `44.5ms` (previous retained generated encode was about
    `36.1-43.4ms`).
  - Dense 5k response bytes moved to `2535.6KiB`; this is expected because
    one-row commit pages now include three 64-character hex roots/digests per
    commit. The next optimization should keep the verification semantics but
    reduce wire and hash overhead, likely by moving roots/digests to compact
    binary fields in the sync-pack path and/or replacing canonical JSON hashing
    with a framed canonical hash payload shared by TypeScript and Rust.

### Phase 12: Conflict, CRDT, And Flow-Control Protocols

- Status: in progress.
- Add binary conflict/rejection records.
  - Done: binary sync-pack v8 now uses variant-tagged push commit statuses and
    operation result statuses. Applied operation results no longer carry empty
    conflict/error optional fields, while conflict and error records are decoded
    through explicit variant layouts on both TypeScript and Rust. This is a
    protocol cleanliness/compactness change, not the hot row-apply target.
    Focused validation:
    `bun test packages/core/src/__tests__/sync-packs.test.ts`,
    `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime binary_sync_pack`,
    `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts`,
    and `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
    Sample rejected push response: binary `139` bytes versus JSON `333` bytes;
    the equivalent old string-status/optional-field layout would have been
    about `172` bytes. The maintained 50k incremental row-pack lane remains in
    the same band because it does not exercise push rejection records:
    generic encode/decode `20.9ms/25.8ms`, generated encode/decode
    `18.1ms/26.3ms`, sizes `9478.3KiB/5104.5KiB`.
- Add CRDT-specific update/checkpoint lanes.
  - Done: encrypted CRDT update/checkpoint system handlers now expose stable
    binary table metadata and encoders. The shared system tables no longer rely
    on generic row inference for binary snapshot chunks or websocket/incremental
    row groups when enough CRDT rows are in a pack. Focused coverage:
    `bun test packages/server/src/encrypted-crdt.test.ts`,
    `bun test packages/server-hono/src/__tests__/pull-chunk-storage.test.ts`,
    and the Rust WASM encrypted update-log CRDT sync smoke. A 50-row encrypted
    CRDT update sample encoded as `9718` binary bytes versus `15435` JSON row
    frame bytes (`-37.0%`).
- Add session-level backpressure: max in-flight packs, ack ranges, resume
  tokens, overflow/resync-required frames, and slow-client eviction policy.
  - Done: Hono websocket sessions now have a bounded
    `maxInFlightSyncsPerConnection` setting. When a connection exceeds the
    unacked outbound notification limit, the server sends cursor-only
    `reason: "resync-required"` frames with `requiresPull: true` and
    `droppedCount` until the client ACKs a caught-up cursor. The browser worker
    records those fields in realtime diagnostics before running HTTP recovery.
  - Done: corrected websocket flow-control accounting to track outstanding
    cursor ids instead of a plain in-flight counter. Partial ACKs now release
    the acknowledged cursors, so a catching-up client is not forced into
    `resync-required` until it really has reached the configured outstanding
    notification limit again. Focused coverage:
    `bun test packages/server-hono/src/__tests__/ws-connection-manager.test.ts`.
  - Done: added binary sync-pack backpressure coverage. Binary websocket
    deltas now have the same tested in-flight limit semantics as cursor-only
    wakeups: once `resync-required` is emitted, the client must ACK the
    recovery cursor before binary deltas resume.
  - Done: added a Hono route-level guard for the same contract. A configured
    realtime route now proves active binary websocket clients receive binary
    packs up to the in-flight limit, then a `resync-required` frame, then
    binary packs again after ACKing the recovery cursor.
- Prove convergence and conflict behavior across HTTP recovery and websocket
  delta delivery.
  - Done: browser/Hono realtime coverage now proves both sides of the recovery
    contract. Small binary websocket deltas update live queries without an HTTP
    pull, mixed-scope binary deltas are filtered per subscribed client, and
    oversized websocket payloads intentionally fall back to cursor-only wakeups
    followed by an HTTP pull that refreshes the live query. Focused coverage:
    `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.

## Success Targets

- Bootstrap 500k: under 5s.
- Bootstrap 500k peak memory: under 500MB.
- Aggregate p50: under 5ms with read model path.
- WS propagation p50: near TS Syncular, under 15ms.
- Rust binary snapshot decode should remove JSON row-frame parse as a visible
  benchmark bucket.
- Steady-state Rust websocket propagation should not require an HTTP pull for
  ordinary remote row updates.
- Server fanout should avoid per-client JSON encode on hot paths.
- Snapshot bootstrap should be resumable at chunk granularity.
- Slow websocket clients should produce bounded memory use and explicit
  resync-required recovery.
