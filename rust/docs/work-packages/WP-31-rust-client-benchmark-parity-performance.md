# WP-31 Rust Client Benchmark Parity And Performance Triage

Status: `[x]` accepted, depends on WP-04, WP-06, WP-17, WP-24

## Goal

Make the external `offline-sync-bench` Rust-client results trustworthy enough to
guide product work, then fix or reject the Rust-client paths that are actually
slow.

This WP starts from the 2026-05-22 `syncular-rust` benchmark run:
`2026-05-22T10-42-13-509Z`.

## Why

The current Rust client is not generally slow. It is strong on large bootstrap
and simple local queries, but the benchmark currently has three unsupported
Rust rows and a few suspicious slow rows:

- `offline-replay`, `large-offline-queue`, and `blob-flow` are marked
  unsupported in the benchmark adapter even though the Rust runtime has durable
  outbox and blob APIs.
- `deep-relationship-query` has a slow dashboard aggregate because it scans and
  groups `100k` task rows instead of using a declared read model.
- `reconnect-storm` uses direct HTTP `syncOnce()` fanout, not the Rust worker
  realtime reconnect path, and the `100`/`250` client results plateau around
  `2s` with very low server CPU.
- `online-propagation` likely overstates reader visibility because the benchmark
  records `mirrorVisibleMs` after a post-visibility writer `syncOnce()`.
- `permission-change` converges correctly, but the benchmark does not yet split
  revoke, pull, local clear, and visibility timing.

Before optimizing, we need to separate product gaps, benchmark-adapter gaps, and
real runtime/server bottlenecks.

## Scope

- Add Rust-client benchmark parity for:
  - offline replay via the real Rust durable outbox;
  - large offline queue replay via the same outbox path at larger queue sizes;
  - blob flow via the real Rust blob APIs, app-row metadata sync, authenticated
    re-download, and queued upload retry.
- Extend the external benchmark Rust schema/codegen coverage where needed:
  - generated or stable app mutation helpers for benchmark tables;
  - `task_blob_entries` or equivalent blob metadata app table;
  - blob-ref metadata columns declared in the app schema when the scenario needs
    row-backed blob authorization.
- Fix benchmark measurement issues before product optimization:
  - record reader visibility before post-visibility writer cleanup in
    `online-propagation`;
  - record whether realtime delivery applied a binary sync-pack or used HTTP
    pull recovery;
  - capture per-client `syncOnce` and visibility timing for reconnect storm;
  - add permission-change timing buckets for revoke, pull request, local apply,
    scope clear, and count verification;
  - capture `EXPLAIN QUERY PLAN` for local and deep relationship queries.
- Optimize only proven slow paths:
  - add an explicit generated dashboard/project read model if the dashboard
    aggregate is confirmed to be the slow path;
  - add a Rust worker realtime reconnect-storm lane before changing product
    reconnect behavior;
  - optimize permission revocation only after the timing split identifies the
    expensive phase;
  - split bootstrap derived-schema timing into index build and read-model rebuild
    before changing the bulk import strategy.

## Non-Scope

- No custom benchmark-owned outbox for Syncular Rust.
- No marking unsupported rows as supported through emulation.
- No hidden local cache or inferred read model. Read models must remain explicit
  app/codegen intent.
- No legacy JavaScript client/protocol compatibility branch.
- No Rust relay/server rewrite. Relay/server Rust evaluation remains WP-28.
- No product optimization retained solely because it helps one benchmark shape.

## Sequence

1. Measurement correction and instrumentation.
2. Unsupported scenario parity: offline replay, large queue, blob flow.
3. Dashboard read-model evaluation and, if measured positive, implementation.
4. Reconnect-storm decomposition: direct HTTP herd versus worker realtime.
5. Permission-change timing split and targeted optimization.
6. Full external comparison rerun and retained/rejected decision notes.

## Acceptance Criteria

- The three current Rust unsupported rows either complete natively or have a
  precise remaining product blocker recorded in this WP.
- Offline replay and large queue use the Rust runtime outbox and durable storage
  semantics appropriate to the environment under test.
- Blob flow uses real Rust blob APIs and server blob routes, not a benchmark
  helper that bypasses upload/download authorization.
- `online-propagation` reports reader visibility independently from writer
  cleanup and records binary realtime apply versus pull-required recovery.
- `reconnect-storm` reports per-client timing distributions and includes a Rust
  worker realtime reconnect lane, or records why the environment cannot exercise
  it.
- `deep-relationship-query` records raw dashboard query plan evidence and either
  retains an explicit generated read model with before/after numbers or rejects
  the read-model change with evidence.
- `permission-change` reports timing buckets detailed enough to identify whether
  server revoke, pull request, local clear, or verification dominates.
- `rust/docs/BENCHMARK_LOG.md`, this WP, and `rust/docs/ROADMAP.md` are updated
  with before/current/delta/decision evidence for retained slices.

## Required Gates

- `bun --cwd rust/bindings/javascript build:wasm`
- `bun --cwd packages/client build`
- Relevant browser/client tests for any Rust runtime, realtime, outbox, or blob
  behavior touched.
- Relevant server/Hono tests for any sync, realtime, scope revocation, or blob
  server behavior touched.
- External benchmark targeted gates from
  `/Users/bkniffler/GitHub/sync/offline-sync-bench`:
  - `bun run bench:run -- --stack syncular-rust --scenario offline-replay`
  - `bun run bench:run -- --stack syncular-rust --scenario large-offline-queue`
  - `bun run bench:run -- --stack syncular-rust --scenario blob-flow`
  - `bun run bench:run -- --stack syncular-rust --scenario online-propagation`
  - `bun run bench:run -- --stack syncular-rust --scenario reconnect-storm`
  - `bun run bench:run -- --stack syncular-rust --scenario deep-relationship-query`
  - `bun run bench:run -- --stack syncular-rust --scenario permission-change`
- Full `bun run bench:all` before final acceptance if the targeted lanes change
  public comparisons.

## External Benchmark Self-Verification

Run the external benchmark from
`/Users/bkniffler/GitHub/sync/offline-sync-bench` against the current workspace
build, not the published package:

```sh
cd /Users/bkniffler/conductor/workspaces/syncular/indianapolis
bun --cwd rust/bindings/javascript build:wasm
bun --cwd packages/client build
```

```sh
cd /Users/bkniffler/GitHub/sync/offline-sync-bench
cargo run --manifest-path /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/Cargo.toml \
  -p syncular-codegen -- \
  --manifest-dir /Users/bkniffler/GitHub/sync/offline-sync-bench/stacks/syncular/syncular-app \
  --rust-output-dir /Users/bkniffler/GitHub/sync/offline-sync-bench/stacks/syncular/syncular-app/generated/rust \
  --check

SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis \
  docker compose -f stacks/syncular/docker-compose.yml up --build -d
```

Use these environment variables for every `syncular-rust` benchmark command:

```sh
export SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis
export SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/packages/client/dist
export SYNCULAR_RUST_CLIENT_PACKAGE_JSON=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/packages/client/package.json
```

Optional batch-size evaluation:

```sh
export SYNCULAR_RUST_OUTBOX_PUSH_BATCH_LIMIT=100
export SYNCULAR_RUST_LARGE_OFFLINE_QUEUE_SIZES=1000
bun run bench:run -- --stack syncular-rust --scenario large-offline-queue
```

Targeted verification:

```sh
bun run bench:run -- --stack syncular-rust --scenario online-propagation
bun run bench:run -- --stack syncular-rust --scenario reconnect-storm
bun run bench:run -- --stack syncular-rust --scenario deep-relationship-query
bun run bench:run -- --stack syncular-rust --scenario permission-change
```

Parity verification as scenarios are implemented:

```sh
bun run bench:run -- --stack syncular-rust --scenario offline-replay
bun run bench:run -- --stack syncular-rust --scenario large-offline-queue
bun run bench:run -- --stack syncular-rust --scenario blob-flow
```

Stronger browser-worker OPFS durability verification:

```sh
SYNCULAR_RUST_BROWSER_DURABLE_REOPEN=1 \
  bun run bench:run -- --stack syncular-rust --scenario offline-replay
```

Full comparison before accepting the WP:

```sh
bun run bench:all
```

Record the run ID, summary path, and before/current/delta decision in
`rust/docs/BENCHMARK_LOG.md` and in this WP. The summary is written under
`.results/<run-id>/SUMMARY.md` in the external benchmark repository, with
`.results/LATEST.*` pointing at the latest run.

## Accept / Reject Rule

- Retain benchmark-adapter changes only if they use real product behavior and
  make support status more accurate.
- Retain performance changes only if the target metric improves, or if a
  correctness fix needs a documented follow-up for the regression.
- Reject read-model changes that are not explicit generated app intent.
- Reject reconnect/realtime changes that make HTTP recovery look like the fast
  path or hide binary realtime apply failures.
- Reject any scenario implementation that depends on old JS client protocol
  behavior or an untracked compatibility branch.

## Current Evidence

- External run: `2026-05-22T10-42-13-509Z`.
- Rust bootstrap was strong: `100k=229.92ms`, `500k=1148.61ms`. At `500k`,
  derived schema cost was `650.28ms`, sync total `483ms`, pull apply `375ms`,
  and local apply `218ms`.
- Rust local query was strong: list p50 `0.17ms`, search p50 `0.24ms`,
  aggregate read model p50 `0.01ms`, raw aggregate p50 `9.32ms`.
- Rust deep relationship dashboard was slow: dashboard p50 `87.67ms`, p95
  `120.09ms`; detail join p50 was only `0.54ms`.
- Rust online propagation was acceptable but not leading: write ack `8.7ms`,
  mirror visible p50 `23.65ms`, p95 `31.34ms`. The benchmark currently records
  visibility after a writer `syncOnce()` cleanup call.
- Rust reconnect storm had a suspicious step function: `25` clients `99.74ms`,
  `100` clients `2026.72ms`, `250` clients `2052.06ms`. Sync service CPU stayed
  below `0.5%`, so this needs client/harness/realtime decomposition before
  product optimization.
- Rust permission change converged correctly but slower than the best rows:
  `40.17ms`, `4` requests, `9687` transferred bytes.
- Rust unsupported rows are adapter decisions, not proven runtime absence:
  offline replay and large queue cite missing benchmark-schema Rust mutation
  helpers; blob flow cites missing benchmark-schema Rust mutation coverage.
- The Rust runtime exposes durable outbox mutation APIs and blob
  store/retrieve/upload-queue APIs. The external benchmark Rust adapter currently
  hard-codes only `organizations`, `projects`, and `tasks`, and uses
  `storage: 'memory'` with `clearOnInit: true`.

## Slice 1 Measurement Correction Evidence

Retained local external benchmark adapter changes on 2026-05-22:

- Switched the adapter to the current Rust-first client exports:
  `openSyncularRustClient` and `createSyncularWorkerClient`.
- `online-propagation` now measures reader visibility before the post-visibility
  writer cleanup `syncOnce()`.
- Worker realtime diagnostics now count binary sync-pack apply, pull-required
  recovery, binary apply failure, and pull-required reasons.
- `reconnect-storm` now records per-client first `syncOnce()` p50/p95/p99,
  per-client visibility p50/p95/p99, and extra sync-loop counts.
- `deep-relationship-query` now records `EXPLAIN QUERY PLAN` for the dashboard
  and detail queries.
- `permission-change` now records revoke request time, sync attempts, reported
  pull/request/apply timing, count query time, and final verification time.

Verification:

- `bun --cwd rust/bindings/javascript build:wasm`: passed.
- `bun --cwd packages/client build`: passed.
- External stack rebuilt with `SYNCULAR_BRANCH_ROOT` pointing at this workspace:
  passed.
- `bun run typecheck` in `offline-sync-bench` is still blocked by pre-existing
  stack app type errors against published Syncular package declarations; a
  filtered run reported no `syncular-rust` adapter errors.

Targeted external results:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `online-propagation` | `2026-05-22T11-50-14-875Z` | reader visibility p50 `20.06ms`, p95 `30.19ms`; writer cleanup avg `8.29ms`; `15/15` reader realtime events used pull-required recovery, reason `payload-too-large`, with `0` binary applies |
| `deep-relationship-query` | `2026-05-22T11-48-02-172Z` | dashboard p50 `69.67ms`, p95 `72.74ms`; detail join p50 `0.48ms`; query plan searches `tasks` by project index but uses temp B-trees for group/order |
| `permission-change` | `2026-05-22T11-48-21-282Z` | convergence `54.24ms`; revoke request `11.02ms`; two sync attempts; first sync clears visible rows to `0`, second restores retained project to `500` |
| `reconnect-storm` | `2026-05-22T11-48-35-255Z` | `25` clients p95 visibility `94.64ms`; `100` clients p95 visibility `223.59ms`; `250` clients p95 visibility `2067.20ms`; all scales had `0` extra sync loops, so convergence is dominated by the first HTTP pull request |

Interpretation:

- The original online p95 overstated reader visibility when it included writer
  cleanup. The remaining online cost is now mostly realtime payload fallback plus
  HTTP pull.
- Realtime binary sync-pack delivery is not active for this benchmark shape.
  Slice 6 corrects the initial `payload-too-large` interpretation: the benchmark
  is receiving cursor-only server wakeups because no per-connection binary delta
  is being produced, not because an encoded delta exceeded the websocket cap.
- Dashboard slowness is confirmed as a query-shape/read-model gap, not a general
  SQLite/Rust query problem.
- Permission revocation correctness works, but the current multi-project pull
  sequence temporarily clears all task rows before reloading the retained scope.
- The old `100`-client reconnect storm `~2s` result was not reproduced after
  instrumentation; `250` clients still show a real first-pull latency cliff.

## Slice 2 Rust Outbox Parity Evidence

Retained local external benchmark adapter changes on 2026-05-22:

- `offline-replay` now queues writes through the real Rust WASM
  `applyMutation` path while the Syncular service is stopped, then replays those
  native outbox commits after the service restarts.
- `large-offline-queue` now uses the same Rust outbox path for the default
  `100` / `500` / `1000` queue sizes.
- Both scenarios record queued/final outbox status counts, sync attempts,
  pushed commits per attempt, conflict count, success rate, and transport bytes.
- The external support matrix now treats Rust outbox replay as supported by the
  Rust client, with an explicit harness caveat.

Verification:

- `bun run typecheck` in `offline-sync-bench` is still blocked by pre-existing
  stack app type errors against published Syncular package declarations; a
  filtered run reported no `syncular-rust` adapter or `src/stacks` errors.
- Rust IndexedDB/OPFS storage probe in the Bun benchmark process:
  `indexedDb` fails because `indexedDB` is unavailable, and `opfsSahPool` fails
  because it requires a dedicated worker.

Targeted external results:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `offline-replay` | `2026-05-22T12-08-40-268Z` | `10` queued writes; `50.17ms` reconnect convergence; `1` sync attempt; `10/10` outbox commits acked; `0` conflicts; `1.0` success rate |
| `large-offline-queue` | `2026-05-22T12-00-07-729Z` | `100` writes `260.91ms` / `5` sync attempts; `500` writes `1165.86ms` / `25` attempts; `1000` writes `2169ms` / `50` attempts; every scale ended with all commits acked, `0` conflicts, `1.0` success rate |

Interpretation:

- The earlier unsupported status was a benchmark-adapter gap, not a missing Rust
  runtime capability. The Rust client can queue and replay native app mutations
  through its outbox.
- Large queue convergence is currently dominated by the Rust web client
  `DEFAULT_OUTBOX_PUSH_BATCH_LIMIT` of `20` commits per sync attempt. The
  `1000`-write result needs exactly `50` attempts and `100` HTTP requests.
- This slice verifies active-session offline replay in the current Bun harness.
  It does not prove process-restart durability because the harness cannot use
  browser IndexedDB or OPFS. A browser-worker durable replay lane remains
  required before the durability part of the acceptance criteria is fully met.

## Slice 3 Rust Blob Flow Parity Evidence

Retained local external benchmark adapter changes on 2026-05-22:

- `blob-flow` now uses the native Rust WASM `storeBlob`, `retrieveBlob`,
  `clearBlobCache`, `blobCacheStats`, `blobUploadQueueStats`, and
  `processBlobUploadQueue` APIs.
- The Rust benchmark schema now declares and locally creates
  `task_blob_entries` so blob metadata sync uses the same app-table path as the
  JavaScript Syncular benchmark.
- The scenario uploads a `512KiB` blob immediately, syncs metadata to a second
  Rust client, clears local cache, re-downloads through the authenticated blob
  route, then forces one queued-upload PUT failure and verifies native queue
  recovery.

Targeted external result:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `blob-flow` | `2026-05-22T12-07-31-563Z` | `512KiB` upload `26.04ms`; metadata visible `25.58ms`; re-download after clear `16.61ms`; `11` requests; `1,315,932` transferred bytes; transfer overhead `5212` bytes; cache overhead `0`; retry queue drains from `1` pending to `0` with `1` uploaded and `0` failed |
| `blob-flow` support-label refresh | `2026-05-22T12-55-26-622Z` | latest public-results row carries `native` support metadata; `512KiB` upload `32.69ms`; metadata visible `29.58ms`; re-download after clear `14.00ms`; retry recovery `1033.88ms` |

Interpretation:

- The previous Rust blob-flow unsupported status was also a benchmark-adapter
  gap. The Rust client can run the product blob upload/download/cache/retry path
  against the real benchmark server routes.
- Retry recovery is currently governed by Rust blob queue retry backoff. The
  induced failed PUT left the row pending, then recovery took `1043ms` over `11`
  queue-processing attempts before the upload became due and drained.
- SQLite storage-byte overhead remains `n/a` for this Rust lane because the Bun
  harness still uses Rust memory storage.

## Slice 4 Rust Outbox Push Batch Evaluation

Retained product/runtime change on 2026-05-22:

- Added `config.push.outboxBatchLimit` for the Rust web/WASM client.
- The default remains `20` commits per push request.
- Runtime validation rejects values outside `1..=1000`.
- Error recovery now requeues the configured sending batch size instead of
  always recovering only `20` sending commits.
- Added a focused Hono/WASM worker test proving a configured
  `outboxBatchLimit: 25` pushes `25` commits in one `syncPush()`.

Verification:

- `bun --cwd rust/bindings/javascript build:wasm`: passed.
- `bun --cwd packages/client build`: passed.
- `bun --cwd packages/client test src/__tests__/sync-hono.wasm.test.ts -t "honors configured Rust outbox push batch limits"`: passed.
- `bun run typecheck` in `offline-sync-bench` is still blocked by pre-existing
  stack app type errors; a filtered run reported no `syncular-rust` adapter or
  `src/stacks` errors.

Targeted external results for `1000` queued writes:

| Batch limit | Run ID | Convergence | Sync attempts | Requests | Decision |
| ---: | --- | ---: | ---: | ---: | --- |
| `20` default | `2026-05-22T12-00-07-729Z` | `2169ms` | `50` | `100` | Baseline |
| `50` | `2026-05-22T12-16-25-773Z` | `1895.08ms` | `20` | `40` | Better than default, worse than `100` |
| `100` | `2026-05-22T12-15-00-294Z` | `1573.21ms` | `10` | `20` | Best measured point |
| `150` | `2026-05-22T12-16-53-468Z` | `1743.7ms` | `7` | `14` | Larger pushes are slower |
| `250` | `2026-05-22T12-15-57-788Z` | `1756.52ms` | `4` | `8` | Larger pushes are slower |

Interpretation:

- Making the batch size configurable is worth retaining because it improves
  large offline replay without changing the default product behavior.
- Bigger is not monotonically better. At `150+`, per-push cost rises enough to
  offset fewer HTTP requests.
- For this benchmark shape, `100` commits per push is the best measured point:
  `27.5%` faster convergence than the default and `80%` fewer HTTP requests.

## Slice 5 Generated Dashboard Read Model Evaluation

Retained external schema/adapter change on 2026-05-22:

- Added a second explicit generated `countBy` read model to the external
  Syncular benchmark app:
  `taskCountsByProjectCompletion -> syncular_rust_task_counts_by_project_completion`.
- The model is declared in `syncular.codegen.json` with dimensions
  `project_id` and `completed`, then emitted into `syncular.schema.json`
  `localReadModels` and `localDerivedSchema`.
- `deep-relationship-query` now keeps the former raw dashboard SQL as
  `dashboard_raw_sql_query_*`, while the primary `dashboard_query_*` uses keyed
  joins against the generated read model.

Verification:

- `cargo run --manifest-path /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/Cargo.toml -p syncular-codegen -- --manifest-dir /Users/bkniffler/GitHub/sync/offline-sync-bench/stacks/syncular/syncular-app --rust-output-dir /Users/bkniffler/GitHub/sync/offline-sync-bench/stacks/syncular/syncular-app/generated/rust --check`:
  passed.
- `bun run typecheck` in `offline-sync-bench` is still blocked by pre-existing
  stack app type errors; a filtered run reported no `syncular-rust` adapter or
  schema/codegen errors.

Targeted external result:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `deep-relationship-query` | `2026-05-22T12-24-55-017Z` | dashboard read model p50 `0.03ms`, p95 `0.07ms`; raw dashboard SQL in the same run p50 `62.36ms`, p95 `63.03ms`; detail join p50 `0.34ms`, p95 `0.77ms` |

Query-plan evidence:

- Read-model dashboard: searches `organizations`, `projects`, and
  `syncular_rust_task_counts_by_project_completion` by primary key for both
  open and completed counts; only the final order uses a temp B-tree.
- Raw dashboard: searches `tasks` by `idx_tasks_project_owner_completed_updated_at`
  and still uses temp B-trees for group/order over the 100k-task materialized
  cache.

Decision:

- Retain the generated read-model change. It is explicit app/codegen intent,
  not a hidden benchmark cache.
- Treat the original deep dashboard slowness as a query-shape/read-model gap,
  not a Rust local SQLite/runtime problem.
- Do not add a generic inferred aggregate cache to the Rust runtime. Future
  dashboard aggregates should be declared through generated read models or a
  broader explicit read-model contract.

## Slice 6 Realtime Wakeup Reason And WS Cap Instrumentation

Retained product/benchmark instrumentation on 2026-05-22:

- Added server Hono `websocket.maxSyncPackBytes` as an explicit outbound
  websocket binary sync-pack cap. The default remains `64KiB`.
- Added `payloadBytes` to cursor-only realtime sync metadata and Rust worker
  diagnostics when a binary payload existed but was too large for direct WS
  delivery.
- Changed Hono fallback reason selection so a missing per-connection binary
  delta is reported as `server-wakeup`, while actual oversized payloads remain
  `payload-too-large`.
- Added external benchmark env plumbing:
  `SYNCULAR_BENCH_WS_SYNC_PACK_MAX_BYTES`.
- Extended the external Rust adapter diagnostics with realtime wakeup payload
  byte p50/p95/max.

Verification:

- `bun test src/__tests__/ws-connection-manager.test.ts` from
  `packages/server-hono`: passed.
- `bun test src/worker-realtime.test.ts` from `packages/client`: passed.
- `bun --cwd packages/server-hono build`: passed.
- `bun --cwd packages/client build`: passed.
- Full `bun --cwd packages/server-hono test ...` was accidentally invoked via
  the package script and still shows unrelated pre-existing console
  gateway/auth/audit failures; the focused realtime server test passed.
- External filtered typecheck still reports the existing published-package stack
  app declaration errors; no new `syncular-rust` adapter/schema/codegen errors.

Targeted external result:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `online-propagation` | `2026-05-22T12-36-38-122Z` | reader visibility p50 `18.45ms`, p95 `24.53ms`; `15/15` realtime events used HTTP pull recovery; reason is now `server-wakeup`, payload bytes `null`, binary applies `0` |

Interpretation:

- The prior `payload-too-large` label was misleading for this benchmark. Raising
  the websocket sync-pack cap is not the fix because no binary payload is being
  produced for the Rust reader in this path.
- The remaining online gap is a realtime subscription/delta availability issue:
  the server can wake the client by scope, but the per-connection binary
  sync-pack builder returns no payload for the benchmark reader, forcing HTTP
  pull recovery.
- Next product slice should make active/recent pull subscription state available
  to realtime delta construction across the Rust worker benchmark path, then
  rerun `online-propagation` and only tune `maxSyncPackBytes` if payload bytes
  prove the cap is the remaining blocker.

## Slice 7 Realtime Binary Pack Safe Version Fix

Retained product/benchmark fix on 2026-05-22:

- Debug-enabled benchmark telemetry showed the server was attempting to build a
  per-connection websocket binary sync-pack, but failed with
  `sync.realtime.binary_pack_encode_failed: int64 value must be a safe integer`.
- Root cause: Postgres `bigint` version columns can reach the handler as
  strings. Normal HTTP pull rows pass through dialect coercion, but realtime
  binary-pack construction used freshly emitted handler changes before that
  coercion path.
- `createServerHandler` now normalizes version columns to safe JS integers for
  emitted changes and conflict rows, while still failing closed for unsafe
  values.
- Added a focused server regression test using a SQLite `text` version column to
  mimic driver string versions in emitted changes and conflict payloads.
- The external benchmark `external-write` helper now normalizes row-level
  notification versions before calling `notifyExternalRowChanges`.

Verification:

- `bun test src/push-operation-codes.test.ts` from `packages/server`: passed.
- `bun --cwd packages/server build`: passed.
- `bun test src/__tests__/ws-connection-manager.test.ts` from
  `packages/server-hono`: passed before this fix and remains the focused WS
  gate for Slice 6.
- `bun test src/worker-realtime.test.ts` from `packages/client`: passed before
  this fix and remains the focused Rust worker realtime gate for Slice 6.
- `bun run typecheck` in `offline-sync-bench`: passed after filtering out no
  output; the external app compiles against the local workspace source in the
  benchmark container.
- Rebuilt the Syncular benchmark service with
  `SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis`
  and `SYNCULAR_BENCH_DEBUG_REALTIME=1`.

Targeted external result:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `online-propagation` | `2026-05-22T12-49-11-883Z` | reader visibility p50 `8.94ms`, p95 `16.25ms`; `15/15` reader realtime events applied binary sync-packs; pull-required `0`; binary apply failed `0`; request count `30` |

Before/after:

| Run | Reader p50 | Reader p95 | Binary applies | Pull-required | Requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before safe-version fix, after reason instrumentation `2026-05-22T12-36-38-122Z` | `18.45ms` | `24.53ms` | `0` | `15` | `45` |
| After safe-version fix `2026-05-22T12-49-11-883Z` | `8.94ms` | `16.25ms` | `15` | `0` | `30` |

Decision:

- Retain the server-side version normalization. It fixes the measured Rust
  worker realtime path and also protects JS clients using Postgres `bigint`
  version columns from the same binary-pack failure.
- The active online-propagation blocker was not missing subscriptions and not
  the websocket byte cap; it was unsafe version typing in the direct realtime
  binary pack path.
- Keep the Slice 6 diagnostics because they made this root cause observable and
  will still distinguish future cap failures from cursor-only wakeups.

## Slice 8 Blob Upload Retry Backoff Split

Retained product fix on 2026-05-22:

- Split blob upload retry timing from sync outbox retry timing.
- Sync/outbox retries keep the existing conservative `1000ms` exponential base.
- Blob upload retries now use a blob-specific `100ms` exponential base, capped
  at `5000ms`.
- Rationale: blob uploads are content-addressed/idempotent and already capped by
  `MAX_BLOB_UPLOAD_RETRIES`; the prior shared `1000ms` sync backoff dominated
  retry recovery after a transient direct PUT failure.

Verification:

- `cargo fmt` from `rust`: passed.
- `bun --cwd rust/bindings/javascript build:wasm`: passed; full WASM remains
  within size budget at `2.32MiB` raw / `1.03MiB` gzip.
- `bun --cwd packages/client test src/__tests__/blob-hono.wasm.test.ts`:
  package script ran the client unit set plus the focused Hono WASM blob file;
  `121` tests passed.
- `bun --cwd packages/client build`: passed.

Targeted external result:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `blob-flow` | `2026-05-22T13-01-24-673Z` | `512KiB` upload `24.45ms`; metadata visible `31.76ms`; re-download after clear `15.69ms`; retry recovery `116.36ms` over `2` attempts; support `native` |

Before/after:

| Run | Retry recovery | Attempts | Upload | Metadata visible |
| --- | ---: | ---: | ---: | ---: |
| Before split `2026-05-22T12-55-26-622Z` | `1033.88ms` | `11` | `32.69ms` | `29.58ms` |
| After split `2026-05-22T13-01-24-673Z` | `116.36ms` | `2` | `24.45ms` | `31.76ms` |

Decision:

- Retain the split. It materially improves blob retry recovery without changing
  sync commit retry behavior.
- Do not push the blob retry base below `100ms` yet. JS Syncular still recovers
  faster in this benchmark (`14.28ms`), but a near-zero automatic retry loop
  would be a broader product behavior change that needs separate evidence.

## Slice 9 Permission Scope-Difference Clear

Retained product fix on 2026-05-22:

- Added a Rust web-store `clear_table_for_scopes_except` path.
- On active subscription scope changes, the Rust web client now clears only the
  revoked portion of the previous scope set when the subscription keeps the
  same table.
- The old behavior applied the retained-scope snapshot, then cleared the full
  previous scope set. In a multi-project revoke this temporarily deleted the
  retained project rows and required a second sync to restore them.

Verification:

- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features web-client memory_store_clears_scope_difference_without_removing_retained_rows --lib`:
  passed.
- `cargo fmt` from `rust`: passed.
- `bun --cwd rust/bindings/javascript build:wasm`: passed; full WASM remains
  within size budget at `2.33MiB` raw / `1.03MiB` gzip.
- `bun --cwd packages/client build`: passed.

Targeted external result:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `permission-change` | `2026-05-22T13-10-37-130Z` | convergence `38.95ms`; revoke request `9.98ms`; `1` sync attempt; retained project stayed visible at `500` rows; revoked project visible rows `0`; requests `2`; transferred bytes `4842` |

Before/after:

| Run | Convergence | Sync attempts | Intermediate visible rows | Requests | Bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before scope-difference clear `2026-05-22T11-48-21-282Z` | `54.24ms` | `2` | `0` then `500` | `4` | `9687` |
| After scope-difference clear `2026-05-22T13-10-37-130Z` | `38.95ms` | `1` | `500` | `2` | `4842` |

Decision:

- Retain the fix. It is both a correctness improvement and a benchmark
  improvement: retained scope data is no longer deleted during a permission
  shrink, convergence improves by `28.2%`, and request/byte counts are roughly
  halved.
- This keeps the Rust client aligned with the scoped-access product contract:
  revoked rows are cleared, retained rows remain queryable, and a later sync is
  not required to repair local state.

## Slice 10 Reconnect Storm Realtime Recovery Evaluation

Retained product and benchmark changes on 2026-05-22:

- Worker realtime now runs a catch-up pull after websocket reconnect so changes
  committed while disconnected are recovered.
- Realtime reconnect and cursor-only HTTP recovery pulls can be jittered.
- Realtime wakeups queued during an active pull are skipped when the active pull
  already advanced past the wakeup cursor.
- The external Rust benchmark now has a `worker-realtime` reconnect mode in
  addition to the direct HTTP `syncOnce()` lane.

Targeted external result:

| Mode | Run ID | Scale | Key result |
| --- | --- | ---: | --- |
| HTTP direct | `2026-05-22T13-17-27-970Z` | `110` | convergence `257.72ms`, first `syncOnce` p95 `238.78ms` |
| HTTP direct | `2026-05-22T13-17-27-970Z` | `125` | convergence `2030.60ms`, first `syncOnce` p95 `2012.99ms` |
| Worker realtime | `2026-05-22T13-26-23-521Z` | `125` | convergence `216.12ms`, visible p95 `214.28ms`, requests `250` |
| Worker realtime | `2026-05-22T13-38-54-572Z` | `250` | convergence `2035.74ms`, visible p95 `2034.99ms`, requests `484` |

Decision:

- Retain reconnect catch-up as a correctness fix.
- Retain the worker-realtime benchmark lane because it measures the product
  reconnect path that apps should use.
- Do not mark the `250`-client cliff fixed. The remaining blocker is
  cursor-only external-write wakeups causing herd HTTP recovery in the
  Bun/Docker worker harness. Next work should focus on binary payloads for
  external notifications or server/relay-side fanout recovery.

## Slice 11 Adaptive Outbox Batch Default

Retained product/runtime and benchmark metadata changes on 2026-05-22:

- Default Rust web-client outbox pushes keep the fixed `20`-commit batch for
  due queues of `100` commits or less.
- When the due pending outbox exceeds `100`, the client switches to a stateful
  adaptive drain that sends up to `100` commits per push until the large queue
  is drained.
- Explicit `config.push.outboxBatchLimit` remains a fixed override and disables
  the adaptive default.
- The web store exposes a due-pending outbox count so the adaptive decision does
  not deserialize operation JSON just to probe queue size.
- The benchmark adapter now reports `outboxPushBatchMode`,
  `outboxPushBatchLimit`, `adaptiveOutboxBatchLimit`, and
  `adaptiveOutboxBatchThreshold`.

Verification:

- `bun --cwd rust/bindings/javascript build:wasm`: passed.
- `bun --cwd packages/client test src/__tests__/sync-hono.wasm.test.ts -t "outbox push batch"`:
  passed.
- `bun --cwd packages/client build`: passed.
- `bun run typecheck` in `offline-sync-bench`: still blocked by the existing
  stack-app package export mismatch against published `@syncular/server`
  packages; the reported errors are limited to
  `stacks/syncular/syncular-app/src/index.ts`.

Same-session fixed-20 control:
`/Users/bkniffler/GitHub/sync/offline-sync-bench/.results/2026-05-22T21-13-24-530Z/syncular-rust/large-offline-queue.json`

Accepted adaptive run:
`/Users/bkniffler/GitHub/sync/offline-sync-bench/.results/2026-05-22T21-15-52-240Z/syncular-rust/large-offline-queue.json`

| Queue | Fixed `20` convergence | Adaptive convergence | Fixed requests / attempts | Adaptive requests / attempts | Decision |
| ---: | ---: | ---: | ---: | ---: | --- |
| `100` | `272.17ms` | `270.55ms` | `10` / `5` | `10` / `5` | Preserves small-queue behavior |
| `500` | `1307.71ms` | `779.54ms` | `50` / `25` | `10` / `5` | Faster with `80%` fewer requests |
| `1000` | `2486.82ms` | `1887.19ms` | `100` / `50` | `20` / `10` | Faster with `80%` fewer requests |

Decision:

- Retain the adaptive default. It removes most of the large-queue request loop
  without taking the measured `100`-write case off the old `20`-commit path.
- Keep explicit fixed batch overrides. A known benchmark-heavy client can still
  choose `outboxBatchLimit: 100`; that remains useful when the app knows its
  workload is a large replay lane.

## Slice 12 IndexedDB-Compatible Durable Reopen Probe

Retained benchmark-adapter change on 2026-05-22:

- Added opt-in `SYNCULAR_RUST_DURABLE_REOPEN=1` for Rust outbox replay
  scenarios.
- Durable reopen mode uses the Rust `indexedDb` storage backend under Bun with
  `fake-indexeddb`, queues offline writes while the Syncular service is down,
  closes the Rust client, reopens the same SQLite file with `clearOnInit=false`,
  verifies the outbox and local title changes survived, and only then restarts
  the service for replay.
- Result metadata now records `storage`, `durableReopen`, `reopenedOutbox`, and
  `reopenedMatchedTitleCount`.
- This is not the final browser-worker OPFS/process-restart lane. It is a
  lower-cost IndexedDB-compatible reopen probe that closes the biggest
  benchmark evidence gap without adding a browser runner dependency.

Verification:

- `SYNCULAR_RUST_DURABLE_REOPEN=1 bun run bench:run -- --stack syncular-rust --scenario offline-replay`:
  passed.
- `SYNCULAR_RUST_DURABLE_REOPEN=1 SYNCULAR_RUST_LARGE_OFFLINE_QUEUE_SIZES=100 bun run bench:run -- --stack syncular-rust --scenario large-offline-queue`:
  passed.
- `bun run typecheck` in `offline-sync-bench`: still blocked by the existing
  stack-app package export mismatch against published `@syncular/server`
  packages; the reported errors are limited to
  `stacks/syncular/syncular-app/src/index.ts`.

Targeted external results:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `offline-replay` durable reopen | `2026-05-22T21-38-53-388Z` | reopened outbox `10` unresolved / `10` pending; reopened matching titles `10`; replay convergence `64.01ms`; final outbox `10` acked, `0` unresolved; success rate `1.0` |
| `large-offline-queue` durable reopen | `2026-05-22T21-39-19-680Z` | queue `100`; reopened outbox `100` unresolved / `100` pending; reopened matching titles `100`; replay convergence `266.92ms`; final outbox `100` acked, `0` unresolved; success rate `1.0` |

Decision:

- Retain the opt-in lane. It proves the Rust WASM IndexedDB-compatible storage
  path can retain queued outbox commits and locally applied rows across
  close/reopen before replay.
- Keep the default benchmark lane memory-backed so existing comparisons remain
  stable.
- Full browser-worker OPFS/process restart remains a stronger future evidence
  item, but this slice is enough to stop describing Rust outbox replay as
  active-session-only when `SYNCULAR_RUST_DURABLE_REOPEN=1` is used.

## Slice 13 Online Binary-Pack Regression Watch

Watch-only benchmark run on 2026-05-22:

- Ran the current `online-propagation` scenario after the outbox batching and
  durable-reopen benchmark slices.
- No runtime change was made from this run.

Verification:

- `bun run bench:run -- --stack syncular-rust --scenario online-propagation`:
  passed.

Targeted external result:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `online-propagation` | `2026-05-22T21-42-33-235Z` | reader visibility p50 `9.84ms`, p95 `21.73ms`; binary sync-pack applies `15/15`; pull-required recoveries `0`; binary apply p95 `2ms`; request count `30` |

Decision:

- No action. The binary realtime path is still active for this benchmark shape,
  and the run does not report payload-size pressure or fallback recovery.
- Keep direct websocket payload caps unchanged unless future runs report
  non-null payload bytes with `payload-too-large` or binary apply failures.

## Slice 14 Blob RetryNow Recovery

Retained product/runtime and benchmark-adapter changes on 2026-05-22:

- Added `processBlobUploadQueue({ retryNow: true })` to the Rust browser client,
  worker bridge, database blob helper, and WASM binding.
- `retryNow` bypasses `next_attempt_at` only for the explicit processing call;
  automatic blob retry scheduling still uses the `100ms` base backoff and keeps
  the retry storm guard.
- The external `blob-flow` retry lane now drains the induced failed upload with
  `retryNow=true` and records `retry_recovery_retry_now: 1`.

Verification:

- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --lib`:
  passed.
- `bun --cwd rust/bindings/javascript build:wasm`: passed; WASM size remains
  below budget at raw `2.33 MiB` / gzip `1.03 MiB`.
- `bun test src/__tests__/blob-hono.wasm.test.ts` in `packages/client`:
  passed.
- `bun run build` in `packages/client`: passed.
- `bun run typecheck` in `offline-sync-bench`: still blocked by the existing
  stack-app package export mismatch against published `@syncular/server`
  packages; no new `src/adapters/syncular-rust.ts` errors were reported before
  those stack-app errors.

Targeted external result:

| Mode | Run ID | Retry recovery | Queue attempts | Notes |
| --- | --- | ---: | ---: | --- |
| Default delayed retry baseline | `2026-05-22T21-45-25-153Z` | `115.64ms` | `2` | first retry call observed pending delayed row |
| Explicit `retryNow` | `2026-05-22T21-52-54-730Z` | `13.15ms` | `1` | same induced failed PUT, bypasses only manual retry delay |

Decision:

- Retain. This removes the remaining benchmark-visible blob retry wait for
  callers that know connectivity has returned, while preserving conservative
  automatic backoff for unattended retry loops.
- Do not lower the default blob retry base below `100ms` from this evidence.

## Slice 15 Browser Worker OPFS Process-Restart Durability

Retained external benchmark-adapter change on 2026-05-22:

- Added opt-in `SYNCULAR_RUST_BROWSER_DURABLE_REOPEN=1` for the Rust
  `offline-replay` scenario.
- The lane bundles the current workspace `packages/client/src/worker-client.ts`
  and `worker-entry.ts`, serves the current Rust WASM artifact, drives a real
  headless Chrome worker client, and uses `storage: 'opfsSahPool'`.
- The benchmark restarts the browser process between bootstrap, offline
  queueing, and replay while reusing the same Chrome profile and SQLite file.
- The Syncular benchmark server CORS allowlist now accepts localhost benchmark
  origins plus the benchmark auth/timing headers required by the browser Rust
  transport.
- Browser CDP network/log capture is retained in the harness so future browser
  failures record actionable CORS/network diagnostics in the result notes.

Verification:

- `bun --cwd rust/bindings/javascript build:wasm`: passed; WASM size remains
  below budget at raw `2.33 MiB` / gzip `1.03 MiB`.
- `SYNCULAR_RUST_BROWSER_DURABLE_REOPEN=1 bun run bench:run -- --stack syncular-rust --scenario offline-replay`:
  passed.
- `bunx biome check --write src/adapters/syncular-rust.ts stacks/syncular/syncular-app/src/index.ts`
  in `offline-sync-bench`: passed.
- `bunx tsc --noEmit --pretty false` in `offline-sync-bench`: still blocked by
  the existing stack-app package export mismatch against published
  `@syncular/server` packages; no new Rust adapter type errors were reported
  before those stack-app errors.

Targeted external result:

| Scenario | Run ID | Key result |
| --- | --- | --- |
| `offline-replay` browser OPFS process restart | `2026-05-22T22-15-40-625Z` | storage `opfsSahPool`, storage fallback `null`; browser process restart `1`; reopened outbox `10` unresolved / `10` pending; reopened matching titles `10`; replay convergence `110.2ms`; final outbox `10` acked, `0` unresolved; success rate `1.0`; requests `2`; bytes `7879`; bootstrap `50.5ms`; queue `33ms` |

Decision:

- Retain. This closes the remaining Rust-client durability evidence gap with a
  real browser worker and OPFS storage, not the lower-cost Bun
  IndexedDB-compatible reopen probe.
- Keep the default comparison lane memory-backed so existing historical
  benchmark rows remain comparable. Use
  `SYNCULAR_RUST_BROWSER_DURABLE_REOPEN=1` when validating browser/process
  restart durability.

## Closeout

The unsupported benchmark rows are now covered by native Rust client behavior,
including an opt-in browser-worker OPFS/process-restart durability lane. No
additional WP-31 client-side parity slice is currently identified.

A 2026-05-23 follow-up fixed the benchmark-discovered Hono websocket origin
policy issue: configured websocket `allowedOrigins` still rejects explicit
disallowed browser origins, but originless non-browser websocket clients are
allowed through to the upgrade/auth path. The rebuilt `offline-sync-bench`
`syncular-rust` online-propagation run
`2026-05-23T04-37-19-197Z` completed with `15/15` binary realtime sync-packs,
`0` pull-required recoveries, p50 reader visibility `9.09ms`, and p95
`14.06ms`.

The `250`-client reconnect cliff is no longer a WP-31 client tuning item. It is
handed off to
[`WP-32 Realtime Recovery Fanout And External Notification Payloads`](WP-32-realtime-recovery-fanout-external-notifications.md),
because fixing it requires server/realtime fanout design rather than more
client-side retry backoff changes.
