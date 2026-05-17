# Rust Client Performance Architecture Plan

## Goal

Make the Rust client win on its own architecture instead of matching the TypeScript client implementation detail for detail. The current Rust WASM path is now functional and benchmarked. Release WASM is the relevant browser baseline; dev WASM is useful for local correctness but overstates apply/decompress costs by a large margin.

- Snapshot chunk decode is no longer the dominant browser Rust cost on the
  binary path: the latest 500k-row local runs report near-zero
  `snapshotChunkDecodeMs`.
- SQLite WASM apply is still the dominant 500k-row browser Rust client-side
  cost in release WASM, but is now around 416ms in the local Hono harness.
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
| Memory/package | peak browser memory during 500k bootstrap, WASM raw/gzip, loaded JS bytes | WASM size gated; peak memory and total loaded bytes need automated capture. |
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

That `benchmark:browser:e2e` lane is still missing and should be built before
the next round of serious hot-path work. It should emit at least:

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
- peak memory and loaded asset bytes

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
- Next target: the remaining SQLite apply cost is mostly structural. The
  generic prepared statement path still binds every cell through runtime table
  metadata. The likely next wins are generated table binders where the app
  schema is known, temporary index/foreign-key policy for trusted bootstrap
  phases, or read-model paths that avoid replaying large snapshots into generic
  query tables when a product only needs derived local views.

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
- Generate `snapshotBinaryColumns` and table-specific `binary-table-v1`
  encoders for the benchmark schema.
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
- Next target: define schema-generated binary row payload/delta encoders inside
  the pack, then wire websocket delivery to carry the same pack format.

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
