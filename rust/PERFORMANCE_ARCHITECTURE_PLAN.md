# Rust Client Performance Architecture Plan

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
- Commit improvements separately with the benchmark evidence in the commit
  message.
- Revert or discard changes that do not improve the target metric unless they
  are required for correctness, in which case the regression must be explicit
  and justified.
- Negative experiments stay documented only as measurements and rationale, not
  as retained runtime code.

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
| Realtime | WS propagation p50/p95/p99, ordered wakeup-to-apply latency | Stress and smoke tests exist; not yet a TS-vs-Rust scoreboard lane. |
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
realtime, reconnect, and deeper worker/WASM memory capture.

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
- Keep JSON format as compatibility fallback.

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
- Keep `json-row-frame-v1` as a compatibility fallback only.

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
the only supported compression path across the current server, browser, native,
and compatibility clients.

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
- Documented the proposed `binary-table-v1` wire format in `rust/BINARY_SNAPSHOT_CHUNK_FORMAT.md`.
- Added tested core helpers for encoding/decoding `binary-table-v1` payloads. These lock down the table/column/value byte layout for the server encoder and Rust decoder work.
- Added protocol negotiation fields.
- Added server-side generic binary table inference/encoding for snapshot rows.
- Added Rust native and browser transport decoding for `binary-table-v1`.
- Rust clients now advertise `binary-table-v1` first and keep
  `json-row-frame-v1` as fallback.
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
- Extended `binary-sync-pack-v1` with optional inline compressed snapshot
  chunk bodies. JSON/debug responses still expose chunk refs only, while Rust
  binary-pack clients can decode chunks without one GET per chunk:
  - 500k rows, 5k-row pages, 20 binary chunks: request count `22 -> 2`,
    `snapshotChunkFetchMs=0ms`, wall `3652.6ms`.
  - Freshly-generated chunks now carry their body out of server `pull()`
    directly when a binary sync pack is requested; Hono only rereads chunk
    bodies for cache hits.
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
- Wired the generated TypeScript example output to emit
  `syncularGeneratedSnapshotBinaryColumns`, and the Hono browser harness now
  passes those columns into `createServerHandler`.
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
  can now provide `snapshotBinaryEncoder`; generated TypeScript emits
  `syncularGeneratedSnapshotBinaryEncoders`, and the browser Hono benchmark
  harness uses the generated tasks encoder. The generic object-row encoder
  remains the fallback.
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
- Added a versioned `binary-sync-pack-v1` combined-response envelope in
  `@syncular/core` with coverage for push acks, conflicts, pull subscriptions,
  commits, snapshot chunk refs, cursors, and schema-version metadata.
- Hono combined sync now emits `application/vnd.syncular.sync-pack.v1` when a
  client advertises the binary pack.
- Browser HTTP transport and Rust native/web transports decode binary
  sync-pack responses and keep JSON as fallback.
- Current scope: binary pack removes the outer response JSON envelope. Row
  payloads inside incremental commits are still JSON values until binary delta
  encoders land.
- Added binary sync-pack wire version 3 for compact incremental change
  metadata. Incremental changes now encode `op` as a byte and stored scopes as
  typed string pairs instead of a JSON object, while the Rust decoder remains
  backward-compatible with v1/v2 packs.
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
- Next target: wire websocket delivery to carry the same pack format instead
  of using realtime only as a pull wakeup.

### Phase 7: Delta WebSocket Runtime

- Status: planned.
- Extend websocket negotiation to advertise binary delta support.
- Stream compact delta packs over websocket instead of treating realtime as
  only a sync wakeup.
- Keep HTTP pull as recovery for overflow, reconnect, missed seq, auth refresh,
  large snapshots, and blob transfer.
- Measure steady-state propagation without an extra HTTP round trip.

### Phase 8: Compression And Cache Policy

- Status: planned.
- Keep snapshot chunks gzip-only.
- Benchmark binary snapshot chunk size and gzip CPU cost on native and
  browser/WASM.
- Do not add unsupported compression algorithms.
- Add cache keys that include schema version, subscription/scope, as-of commit,
  encoding, compression, and feature flags.

### Phase 9: Sync Session And Sequencer Design

- Status: planned.
- Define the websocket-first session state machine:
  hello, capability negotiation, schema manifest, auth, subscriptions,
  snapshots, delta packs, ack/resume, overflow, and close.
- Pick the Cloudflare-compatible sequencer/fanout shard key
  `(tenant/workspace/partition)`.
- Define which state lives in the sequencer, D1-like SQL storage, and R2-like
  object storage.
- Add deterministic tests for reconnect, resume, auth refresh, slow client
  overflow, and subscription changes.

### Phase 10: Binary Commit Log And Subscription Indexes

- Status: planned.
- Add append-only binary commit records optimized for range scan and direct
  delta encoding.
- Add subscription/scope membership indexes for pull and realtime fanout.
- Keep debug/export JSON projection out of the hot path.
- Measure server CPU for range scan, filtering, and fanout before and after
  indexes.

### Phase 11: Resumable Manifests And Artifact Storage

- Status: planned.
- Replace bootstrap mega-responses with snapshot manifests.
- Store binary snapshot chunks, large blobs, and CRDT checkpoints as
  content-addressed artifacts.
- Add per-chunk digest verification and partial-bootstrap resume.
- Measure Worker memory, artifact cache hit cost, and interrupted bootstrap
  recovery.

### Phase 12: Conflict, CRDT, And Flow-Control Protocols

- Status: planned.
- Add binary conflict/rejection records.
- Add CRDT-specific update/checkpoint lanes.
- Add session-level backpressure: max in-flight packs, ack ranges, resume
  tokens, overflow/resync-required frames, and slow-client eviction policy.
- Prove convergence and conflict behavior across HTTP recovery and websocket
  delta delivery.

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
