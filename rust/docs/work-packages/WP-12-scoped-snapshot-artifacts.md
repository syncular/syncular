# WP-12 Scoped Snapshot Artifacts

Status: `[~]` started

## Goal

Make very large first sync faster by serving verified, content-addressed,
scope-correct snapshot artifacts instead of replaying every row through the
client apply loop.

## Scope

- Artifact manifest shape for table/subscription/scope/schema/as-of snapshots.
- Object-storage backed artifact bodies and SQL metadata.
- Precompute/background generation strategy that is CF-worker compatible.
- Browser/native client apply path for scoped artifacts.
- Revocation, resume, verification, CRDT/blob/encryption metadata, and
  live-query event semantics.

## Non-Scope

- Whole-partition SQLite database downloads as the default bootstrap strategy.
- Generating SQLite database files inside the normal Worker/D1 pull hot path.
- Hidden app caches or indexes that change query semantics.

## Acceptance Criteria

- Artifact eligibility is keyed by the exact scoped manifest:
  partition, subscription/table, effective scopes, schema/cache version, as-of
  commit seq, encoding, compression, feature set, and row-range coverage.
- A client never receives an artifact containing rows outside its authorized
  scopes.
- Artifact apply preserves verified manifests, cursor advancement rules,
  revocation clearing, row/field events, blobs, encrypted fields, and CRDT
  field metadata.
- Missing/stale/failed artifacts recover through normal pull without app-side
  special handling.
- External app-style 500k bootstrap improves materially against the accepted
  Rust baseline without increasing peak memory.

## Required Gates

- External app-style bootstrap/local-query benchmark before and after.
- Browser 100k and 500k release E2E guardrails.
- Server chunk/artifact metadata tests.
- Browser corrupted/interrupted artifact recovery tests.
- Scoped auth/revocation tests proving artifacts do not leak rows across
  actors or scope mixes.

## Accept / Reject Rule

- Retain only if the artifact path improves large scoped bootstrap wall time or
  peak memory enough to justify its protocol/storage complexity.
- Revert artifact shortcuts that assume whole partitions, skip verification, or
  require app code to manage artifact recovery.
- Do not keep a compatibility branch beside row chunks unless a benchmark and
  product decision proves both paths are currently necessary.

## Current Evidence

WP-03 exhausted browser client apply micro-probes. The accepted path already
applies binary-table payloads directly from borrowed row views with cached
multirow statements. JSON import, direct `sqlite3_carray_bind`, and
Rust-backed virtual tables were all rejected.

The server already has a good scoped row-chunk foundation:

- chunk keys include partition, scope digest, schema/cache version, encoding,
  compression, and gzip level.
- chunk metadata includes table, as-of commit seq, row cursor, row limit, next
  cursor, and final-page state.
- chunk bodies can live in external object storage while SQL keeps metadata and
  digests.

Latest accepted external benchmark context from WP-03:

- TS 500k bootstrap: `3415.92ms`.
- Rust 500k bootstrap: `2382.23ms`.
- TS 500k local apply: `1901.25ms`.
- Rust 500k local apply: `422ms`.

That means the remaining large-bootstrap work is no longer mainly "Rust row
apply is slow". The next structural win needs to reduce server snapshot
query/encoding, client bind/step count, or transient memory by changing the
artifact shape.

Retained first slice:

- Added a shared scoped snapshot artifact manifest contract in `@syncular/core`
  and `syncular-protocol`.
- The digest payload includes partition, subscription, table, schema version,
  as-of commit seq, scope digest, row cursor/range data, page flags,
  compression, body hash/length, and normalized feature set.
- Rust validation rejects digest/scope/hash mismatches before any runtime apply
  path can trust an artifact.
- Correctness gates passed:
  `bun test packages/core/src/__tests__/snapshot-chunks.test.ts`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`, and
  `bun run --cwd packages/core tsgo`.

Retained second slice:

- Added a dedicated `sync_snapshot_artifacts` metadata table to SQLite and
  Postgres server dialect schema creation.
- Added server helpers for scoped artifact cache keys, manifest creation,
  page-key lookup, insert/upsert, read-by-id, and expiry cleanup.
- Artifact metadata is separate from row chunks and keyed by partition,
  scope-key, subscription id, table, as-of commit, row cursor/limit, artifact
  kind, schema version, and compression.
- Correctness gates passed:
  `bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/snapshot-chunks.test.ts`,
  `bun run --cwd packages/server tsgo`,
  `bun run --cwd packages/server-dialect-sqlite tsgo`, and
  `bun run --cwd packages/server-dialect-postgres tsgo`.

Retained third slice:

- Added an explicit `SnapshotArtifactStorage` interface for artifact body
  reads.
- Added authenticated `GET /snapshot-artifacts/:artifactId` route in
  `@syncular/server-hono`.
- The route requires caller-provided scope values, recomputes effective scopes
  through normal handler auth, verifies the scoped artifact key, honors ETag
  caching, and serves artifact body bytes with artifact metadata headers.
- Correctness gates passed:
  `bun test packages/server-hono/src/__tests__/pull-chunk-storage.test.ts packages/server/src/snapshot-artifacts.test.ts`,
  `bun run --cwd packages/server-hono tsgo`, and
  `bun run --cwd packages/server tsgo`.

Retained fourth slice:

- Extended the shared pull protocol so `SyncSnapshot` can carry scoped artifact
  refs.
- Added artifact ref schemas in `@syncular/core` and Rust protocol structs.
- Bumped `binary-sync-pack-v1` wire version to `14` because the positional
  snapshot record now includes optional artifact refs.
- Regenerated the cross-language binary sync-pack fixture.
- Correctness gates passed:
  `bun test packages/core/src/__tests__/sync-packs.test.ts packages/core/src/__tests__/protocol-fixtures.test.ts packages/core/src/__tests__/snapshot-chunks.test.ts`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures --features native,crdt-yjs,demo-todo-native-fixture`,
  and `bun run --cwd packages/core tsgo`.

Retained fifth slice:

- Added an explicit `snapshotArtifacts` pull request capability for scoped
  artifact body kinds, compression, and feature-set requirements.
- Wired Hono pull requests through to the server pull engine.
- Server pull now looks up an exact scoped artifact key during bootstrap before
  querying snapshot rows and advertises the artifact ref when partition,
  subscription id, effective scopes, schema version, as-of commit, table,
  cursor, row limit, artifact kind, compression, and feature set all match.
- A scope mismatch or missing/stale artifact stays on the current row-chunk
  pull path; this is recovery behavior, not an old-protocol compatibility
  branch.
- Rust protocol request structs can carry the artifact capability. Native Diesel
  clients now advertise the current SQLite artifact kind once their apply path
  is available; stores without artifact support do not request artifacts.
- Correctness gates passed:
  `bun test packages/core/src/__tests__/snapshot-chunks.test.ts packages/server/src/pull-snapshot-artifacts.test.ts packages/server/src/snapshot-artifacts.test.ts`,
  `bun run --cwd packages/core tsgo`,
  `bun run --cwd packages/server tsgo`,
  `bun run --cwd packages/server-hono tsgo`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`,
  and `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures --features native,crdt-yjs,demo-todo-native-fixture`.

Retained sixth slice:

- Added the write-side artifact body storage contract:
  `SnapshotArtifactStorage.storeArtifact(...)`.
- Added `storeScopedSnapshotArtifact(...)`, which hashes immutable artifact
  bytes, writes them through the storage adapter, and inserts the matching
  scoped metadata row.
- Added native and browser-runtime fail-closed guards so artifact snapshots are
  rejected before clearing local rows until each runtime has explicit apply
  support.
- Re-exported artifact protocol structs/constants through the runtime protocol
  module.
- Correctness gates passed:
  `bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts`,
  `bun run --cwd packages/server tsgo`,
  `bun run --cwd packages/server-hono tsgo`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract http_sync_rejects_snapshot_artifacts_before_mutating_store --features native,crdt-yjs,demo-todo-native-fixture`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures --features native,crdt-yjs,demo-todo-native-fixture`,
  and `bun run build:wasm:dev` from `rust/bindings/browser`.

Retained seventh slice:

- Added canonical Rust protocol validation for scoped artifact refs, not only
  manifests.
- Added native and browser transport methods for downloading artifact bodies
  from `/snapshot-artifacts/:artifactId` with the scoped snapshot header.
- Both transports validate the artifact ref, byte length, and SHA-256 before
  returning bytes to future apply code.
- Correctness gates passed:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures --features native,crdt-yjs,demo-todo-native-fixture`,
  and `bun run build:wasm:dev` from `rust/bindings/browser`.

Retained eighth slice:

- Added an explicit store capability for SQLite snapshot artifact decoding.
- Native Diesel stores can deserialize a verified SQLite artifact into an
  in-memory readonly SQLite connection, project rows through the generated app
  schema adapter, run the same snapshot-row transform path, and apply rows
  through the existing batched upsert logic.
- Native Diesel pull requests now advertise `snapshotArtifacts` for
  `sqlite-snapshot-v1` with `none` compression. Non-Diesel stores and browser
  owned SQLite still fail closed before mutation.
- Testkit can now queue and assert snapshot artifact byte fetches.
- Correctness gates passed:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract http_sync_diesel_applies_snapshot_artifact_rows --features native,crdt-yjs,demo-todo-native-fixture`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract http_sync_rejects_snapshot_artifacts_before_mutating_store --features native,crdt-yjs,demo-todo-native-fixture`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract --features native,crdt-yjs,demo-todo-native-fixture`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_fixtures --features native,crdt-yjs,demo-todo-native-fixture`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`, and
  `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`.
- Compile gates passed:
  `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`
  and `bun run build:wasm:dev` from `rust/bindings/browser`.
- Targeted server perf gate passed:
  `PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"`.
  No stored baseline was available for that gate. External app-style bootstrap
  was not run because server/background artifact body production is not wired
  yet, so the benchmark would not exercise artifact apply.

Important limitation: this first native apply path still materializes artifact
rows as JSON values before applying them. It proves the verified protocol and
recovery shape, but it is not yet the final performance path.

Retained ninth slice:

- Added `precomputeScopedSnapshotArtifact(...)` to the server package. It is an
  explicit background/precompute API that calls a registered table snapshot,
  encodes one scoped page through a pluggable SQLite artifact encoder, stores
  the body, and inserts the verified scoped artifact metadata row.
- Added a Bun-only SQLite artifact encoder at
  `@syncular/server/snapshot-artifacts/sqlite-bun`. This keeps SQLite file
  generation out of the generic server pull path and out of Cloudflare Worker
  runtime code.
- Added a test that precomputes a scoped artifact from generated
  `snapshotBinaryColumns`, stores the body, and deserializes the resulting
  SQLite database to prove the rows are present.
- Correctness gates passed:
  `bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts`,
  `bun run --cwd packages/server tsgo`,
  `bun run --cwd packages/server-hono tsgo`, and
  `bun run --cwd packages/core tsgo`.
- Targeted server perf gate passed after the change:
  `PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"`.
  Compared with the prior same-session targeted run, metrics stayed in noise:
  scoped incremental fanout remained `3.4ms`, dense build moved `39.3ms` to
  `39.9ms`, binary encode moved `43.6ms` to `43.1ms`, and generated binary
  encode moved `44.3ms` to `45.1ms`.

Retained tenth slice:

- Made artifact capability requests schema-bound with
  `snapshotArtifacts.schemaVersion`. This removes the route-level
  schema-version fallback for artifact lookup and keeps the artifact cache key
  explicit in the protocol request.
- Browser owned SQLite now advertises SQLite snapshot artifacts only when the
  store capability is present.
- Browser pull applies verified SQLite artifact bodies by deserializing the body
  into a temporary read-only in-memory SQLite database via `sqlite3_deserialize`,
  projecting rows from the artifact table, running the snapshot row transform,
  and applying through the existing snapshot-row path.
- Added a Hono/WASM browser test that precomputes a scoped Bun SQLite artifact,
  serves it through `/snapshot-artifacts/:artifactId`, verifies that no snapshot
  chunks are fetched, and confirms the artifact rows land in Rust-owned SQLite.
- Correctness gates passed:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`,
  `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract http_sync_diesel_applies_snapshot_artifact_rows --features native,crdt-yjs,demo-todo-native-fixture`,
  `bun test packages/core/src/__tests__/snapshot-chunks.test.ts packages/server/src/pull-snapshot-artifacts.test.ts packages/server/src/snapshot-artifacts.test.ts`,
  `bun run --cwd packages/core tsgo`,
  `bun run --cwd packages/server tsgo`,
  `bun run --cwd packages/server-hono tsgo`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun run build:wasm:dev` from `rust/bindings/browser`, and
  `bun test src/__tests__/sync-hono.wasm.test.ts` from `rust/bindings/browser`.
- Targeted server perf gate passed after the change:
  `PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"`.
  Compared with the previous WP-12 precompute run, metrics stayed in local
  noise: scoped fanout moved `3.4ms` to `3.7ms`, dense build moved `39.9ms` to
  `39.4ms`, binary encode moved `43.1ms` to `43.6ms`, and generated binary
  encode moved `45.1ms` to `43.4ms`.

Retained eleventh slice:

- Browser owned SQLite now requests scoped SQLite artifacts only when the
  current pull mode can apply them directly: no returned snapshot rows, no
  changed-row collection, no field encryption transform, and no encrypted CRDT
  runtime transform. If a server sends an artifact outside that mode, the
  browser client fails clearly instead of materializing rows as JSON.
- The browser artifact apply path now deserializes the SQLite artifact into an
  attached in-memory schema on the same SQLite connection and imports rows with
  `INSERT INTO main.table SELECT ... FROM artifact.table`. Attached artifact
  buffers stay alive until the surrounding apply transaction commits or rolls
  back, then the schemas are detached.
- Added a browser E2E scoreboard switch,
  `--sync-snapshot-artifacts`, so artifact bootstrap can be measured against
  the existing row-chunk lane.
- Ratcheted the full browser WASM size budget from `3.25 MiB` raw / `1.35 MiB`
  gzip to `3.30 MiB` raw / `1.36 MiB` gzip. A clean `HEAD` worktree was already
  over the old budget by `29.1 KiB` raw / `2.0 KiB` gzip; this slice adds about
  `2.9 KiB` raw / `0.6 KiB` gzip for direct artifact import.
- Correctness gates passed:
  `CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown`,
  `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`,
  `bun run --cwd rust/bindings/browser build:wasm`,
  `bun run --cwd rust/bindings/browser tsgo`, and
  `bun test src/__tests__/sync-hono.wasm.test.ts` from
  `rust/bindings/browser`.
- Targeted server perf gate stayed in noise on rerun:
  `PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"`.
- Browser release E2E, 100k rows, query iterations disabled:
  row chunks `rust_bootstrap_ms=144.76`, `rust_pull_apply_ms=78`,
  `rust_snapshot_chunk_apply_ms=67`, `rust_response_bytes=766877`;
  direct SQLite artifacts with SQLite-native import
  `rust_bootstrap_ms=108.73`, `rust_pull_apply_ms=69`,
  `rust_snapshot_row_apply_ms=20`, `rust_snapshot_chunk_apply_ms=34`,
  `rust_response_bytes=3169482`. Cached bootstrap moved `76.45ms` to
  `60.59ms`.

Retained twelfth slice:

- Switched the current scoped SQLite artifact path from uncompressed artifact
  bodies to gzip bodies. Rust native and browser clients now advertise gzip
  artifact compression, server pull only selects gzip artifacts, and runtime
  transports validate the compressed body hash/length before returning decoded
  SQLite bytes to storage.
- The Bun scoped SQLite artifact encoder now gzips the serialized SQLite file
  at level 1. Server artifact helper defaults also now use gzip so new
  artifact keys are not silently created for the uncompressed path.
- Runtime artifact apply rejects non-gzip artifact refs on the current path.
- Correctness gates passed:
  `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`,
  `CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract http_sync_diesel_applies_snapshot_artifact_rows --features native,crdt-yjs,demo-todo-native-fixture`,
  `bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts`,
  `bun run --cwd packages/server tsgo`,
  `bun run --cwd rust/bindings/browser build:wasm`,
  `bun run --cwd rust/bindings/browser tsgo`, and
  `bun test src/__tests__/sync-hono.wasm.test.ts` from
  `rust/bindings/browser`.
- Targeted server perf gate stayed in noise on rerun:
  `PERF_SYNC_PACK_CHANGES=50000 PERF_SYNC_PACK_ROUNDS=5 PERF_SYNC_PACK_WARMUP=2 PERF_SERVER_SCOPE_COMMITS=5000 PERF_SERVER_SCOPE_ROUNDS=3 PERF_SERVER_DENSE_COMMITS=5000 PERF_SERVER_DENSE_ROUNDS=3 bun test --max-concurrency=1 tests/perf/rust-client.perf.test.ts --test-name-pattern "binary sync-pack|scoped incremental|dense incremental"`.
- Browser release E2E, 100k rows, query iterations disabled:
  uncompressed direct SQLite artifacts `rust_bootstrap_ms=108.73`,
  `rust_pull_apply_ms=69`, `rust_response_bytes=3169482`,
  `rust_cached_bootstrap_ms=60.59`, `browser_js_heap_used_delta_bytes=2616444`;
  gzip direct SQLite artifacts `rust_bootstrap_ms=107.82`,
  `rust_pull_apply_ms=68`, `rust_response_bytes=1033377`,
  `rust_cached_bootstrap_ms=61.77`, `browser_js_heap_used_delta_bytes=2754568`.
- Decision: retained. Wall time stayed flat, cached bootstrap stayed within
  local noise, and artifact response bytes dropped by about `67%`.

Retained thirteenth slice:

- Added browser/Hono recovery coverage for direct SQLite artifacts. A corrupted
  `/snapshot-artifacts/:artifactId` response now proves the Rust browser client
  rejects the pull before clearing or applying rows, then succeeds on the next
  pull without app-side recovery logic.
- Correctness gates passed:
  `bun test src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "corrupted SQLite snapshot artifact"`
  and `bun test src/__tests__/sync-hono.wasm.test.ts` from
  `rust/bindings/browser`.

Retained fourteenth slice:

- Added `precomputeScopedSnapshotArtifacts(...)` so server/background jobs can
  precompute every scoped SQLite artifact page by following each page's
  `nextCursor`.
- Updated the browser Hono fixture and browser E2E benchmark server to
  precompute all artifact pages instead of only the first page.
- Added a server test proving multi-page artifact metadata can be read back by
  page key for later cursors.
- Correctness gates passed:
  `bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts`,
  `bun run --cwd packages/server tsgo`,
  `bun run --cwd rust/bindings/browser tsgo`, and
  `bun test src/__tests__/sync-hono.wasm.test.ts` from
  `rust/bindings/browser`.
- Browser release E2E, 100k rows, query iterations disabled:
  previous gzip artifact lane `rust_bootstrap_ms=107.82`,
  `rust_pull_request_ms=36`, `rust_pull_apply_ms=68`,
  `rust_snapshot_chunk_apply_ms=35`, `rust_response_bytes=1033377`,
  `rust_cached_bootstrap_ms=61.77`; multi-page artifacts
  `rust_bootstrap_ms=68.6`, `rust_pull_request_ms=7`,
  `rust_pull_apply_ms=58`, `rust_snapshot_chunk_apply_ms=0`,
  `rust_response_bytes=1300566`, `rust_cached_bootstrap_ms=48.36`.
- Decision: retained. Full artifact coverage removes the remaining 50k-row
  chunk fetch/apply from the 100k artifact lane and improves first bootstrap by
  about `36%` despite a larger artifact response than the one-page mixed path.
- Browser release E2E, 500k rows, query iterations disabled:
  row chunks `rust_bootstrap_ms=618.95`, `rust_pull_apply_ms=345`,
  `rust_snapshot_chunk_apply_ms=299`, `rust_response_bytes=3783097`,
  `rust_cached_bootstrap_ms=337.61`; multi-page artifacts
  `rust_bootstrap_ms=268.44`, `rust_pull_apply_ms=252`,
  `rust_snapshot_row_apply_ms=191`, `rust_snapshot_chunk_apply_ms=0`,
  `rust_response_bytes=6500487`, `rust_cached_bootstrap_ms=248.64`.

Retained fifteenth slice:

- Reduced scoped SQLite artifact body size while keeping the direct import path.
  Server handlers now expose primary-key metadata to artifact encoders, and the
  Bun SQLite artifact encoder creates primary-key `WITHOUT ROWID` artifact
  tables when the generated snapshot columns include that primary key.
- Raised the default artifact gzip level from `1` to `6`. This is background
  precompute work, not pull hot-path work.
- Correctness gates passed:
  `bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts`,
  `bun run --cwd packages/server tsgo`,
  `bun run --cwd rust/bindings/browser tsgo`, and
  `bun test src/__tests__/sync-hono.wasm.test.ts` from
  `rust/bindings/browser`.
- Browser release E2E, 100k rows, query iterations disabled:
  previous multi-page artifacts `rust_bootstrap_ms=68.6`,
  `rust_pull_apply_ms=58`, `rust_response_bytes=1300566`,
  `rust_cached_bootstrap_ms=48.36`; compact artifacts
  `rust_bootstrap_ms=66.47`, `rust_pull_apply_ms=56`,
  `rust_response_bytes=976972`, `rust_cached_bootstrap_ms=45.39`.
- Browser release E2E, 500k rows, query iterations disabled:
  previous multi-page artifacts `rust_bootstrap_ms=268.44`,
  `rust_pull_apply_ms=252`, `rust_response_bytes=6500487`,
  `rust_cached_bootstrap_ms=248.64`; compact artifacts
  `rust_bootstrap_ms=260.82`, `rust_pull_apply_ms=245`,
  `rust_response_bytes=4738745`, `rust_cached_bootstrap_ms=235.69`.
- Decision: retained. Payload dropped by about `25%` at 100k and `27%` at 500k
  while wall time improved slightly.

Retained sixteenth slice:

- Added browser/Hono revocation coverage for direct SQLite artifact bootstrap.
  The test first hydrates rows through a scoped artifact, then requests a
  revoked scope and verifies the runtime clears the local rows.
- Correctness gates passed:
  `bun test src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "artifact rows when a subscription is revoked"`
  and `bun test src/__tests__/sync-hono.wasm.test.ts` from
  `rust/bindings/browser`.

Retained seventeenth slice:

- Exposed `snapshotArtifactStorage` through the high-level Hono
  `createSyncServer(...)` facade. App-style servers can now use the normal
  server factory and still serve scoped SQLite artifacts.
- Hardened the Bun SQLite artifact encoder for Postgres-backed snapshots by
  converting numeric strings, bigint integers, float strings, and `Date`
  timestamp values into typed SQLite artifact values.
- Correctness gates passed:
  `bun test packages/server/src/snapshot-artifacts.test.ts packages/server-hono/src/__tests__/pull-chunk-storage.test.ts`,
  `bun run --cwd packages/server tsgo`, and
  `bun run --cwd packages/server-hono tsgo`.
- Browser release E2E, 500k rows with scoped snapshot artifacts:
  previous compact artifact baseline `rust_bootstrap_ms=260.82`,
  `rust_pull_apply_ms=245`, `rust_snapshot_row_apply_ms=189`,
  `rust_response_bytes=4738745`, `rust_cached_bootstrap_ms=235.69`; current
  `rust_bootstrap_ms=259`, `rust_pull_apply_ms=243`,
  `rust_snapshot_row_apply_ms=189`, `rust_response_bytes=4738745`,
  `rust_cached_bootstrap_ms=232.48`.
- External app-style Docker benchmarking is still blocked locally because
  Docker commands hung before returning daemon status. The Syncular-side server
  facade needed by that harness is now in place.

Rejected native direct-import probe:

- Tried a Diesel native direct-import prototype that wrote verified SQLite
  artifact bytes to a temp file, attached that file inside the active sync
  transaction, imported rows with `INSERT INTO ... SELECT ...`, and generated
  row-level event metadata from the attached artifact table.
- Rejected before retention because `DETACH` fails with `database ... is locked`
  inside the active Diesel transaction. Deferring detach until after commit
  would leak random attached schemas through the connection and make rollback
  behavior fragile.
- Native therefore stays on verified artifact row projection for now. Revisit
  direct native import only if Diesel exposes a clean raw SQLite
  schema-deserialize hook for the active connection, or if the native client
  gains an explicit no-row-deltas pull mode where row-level event metadata is
  not part of the contract.

Retained eighteenth slice:

- Added benchmark guardrails for scoped artifact page-size experiments. The
  browser E2E scoreboard now passes an explicit artifact row-limit into the
  benchmark server, aligns the Rust pull page size with that limit, and records
  the actual Rust pull request's `limitSnapshotRows`, `maxSnapshotPages`, and
  artifact capability bit.
- Added browser transport timing for server artifact-cache lookup so reports can
  show whether artifact lookup happened separately from snapshot chunk cache
  lookup.
- Correctness gates passed: `bun run --cwd rust/bindings/browser tsgo` and
  `cargo fmt --manifest-path rust/Cargo.toml --all`.
- Browser release E2E, 500k rows with scoped snapshot artifacts:
  previous compact artifact baseline `rust_bootstrap_ms=260.82`,
  `rust_pull_apply_ms=245`, `rust_snapshot_row_apply_ms=189`,
  `rust_response_bytes=4738745`, `rust_cached_bootstrap_ms=235.69`; 50k
  observed guard run `rust_bootstrap_ms=262.13`, `rust_pull_apply_ms=246`,
  `rust_snapshot_row_apply_ms=191`, `rust_response_bytes=4738745`,
  `rust_cached_bootstrap_ms=233.96`.
- Decision: retained. The guard adds little complexity and prevents mistaking an
  intended benchmark option for the actual pull request shape.

Rejected 100k artifact page-size probe:

- Ran the same 500k browser artifact lane with
  `--sync-snapshot-artifact-row-limit=100000`. The observed Rust pull request
  did advertise artifacts and `limitSnapshotRows=100000`.
- Result: rejected. Server artifact lookup missed and the response fell back to
  `10` binary chunks. The run produced `rust_bootstrap_ms=615.11`,
  `rust_pull_request_ms=267`, `rust_snapshot_chunk_apply_ms=301`,
  `rust_snapshot_chunk_binary_count=10`, `rust_response_bytes=3783097`, and
  `rust_cached_bootstrap_ms=358.34`.
- Keep the current `50k` page size. Larger pages are not a valid optimization
  until a dedicated slice proves direct artifact selection still happens and
  beats the compact 50k baseline.

External normal row-chunk benchmark restored:

- The Docker app-style stack is responsive again, and the normal Rust binary
  row-chunk bootstrap now runs against the Postgres-backed branch server after
  binary snapshot encoding started accepting database-driver integer strings
  and `Date` timestamp values.
- Latest normal external pair:
  TS 500k bootstrap `3855.10ms`, Rust 500k bootstrap `6099.68ms`;
  TS 500k local apply `2114.80ms`, Rust 500k local apply `1692ms`;
  Rust derived schema work is still `3213.03ms`.
- This is not scoped artifact evidence. It is the row-chunk/app-style baseline
  to compare against before proving artifact precompute in the external stack.

External scoped artifact gate:

- Scoped artifacts now select correctly in the external app-style stack when
  precompute uses `SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=60000`.
  The external Rust harness requests `20k` rows per pull page, and the server
  artifact lookup groups those into a `60k` bundle key for the current `50k`
  binary bundle target. Precomputing `20k` artifact pages made lookup miss and
  fall back to row chunks.
- External Rust 500k bootstrap improved from row chunks `6099.68ms` to scoped
  artifacts `4866.87ms`, then `4844.13ms` after moving artifact body bytes
  into the browser SQLite store instead of cloning them.
- External Rust 500k pull request dropped `1031ms -> 22ms`, local apply
  improved `1692ms -> 1379ms`, and `snapshotChunkCount` is now `0`.
- Remaining blockers: response bytes increased `3287104 -> 3938884`, and peak
  memory increased `694.38MB -> 750.48MB`.

Retained nineteenth slice:

- Browser SQLite artifact apply now consumes the fetched artifact byte vector
  instead of borrowing it and cloning into the retained
  `sqlite3_deserialize` backing buffer.
- This is retained as a small allocation/memory cleanup, not as a throughput
  win. External 500k memory moved `751.45MB -> 750.48MB`; local 500k browser
  A/B showed similar wall time and lower heap for the owned-byte run.

Rejected browser immediate-detach probe:

- Tried detaching each in-memory SQLite artifact schema immediately after the
  `INSERT ... SELECT` import.
- Rejected because rebuilt WASM failed the artifact Hono test with
  `database __syncular_snapshot_artifact_0 is locked`. Browser direct artifact
  import therefore still needs a transaction shape that keeps attached artifact
  buffers alive until commit, or a larger apply-loop architecture change.

Rejected artifact body-shape probe:

- Tried changing the Bun SQLite artifact encoder page size to `16k`.
- Rejected because the 500k local artifact gate increased response bytes
  `4738745 -> 5455815` and heap usage worsened, while wall time stayed flat.

Retained twentieth slice:

- Raised the Bun SQLite artifact encoder default gzip level from `6` to `9`.
  Artifact generation is a background/precompute path, not the Worker pull hot
  path, so this is judged primarily on transferred bytes while preserving
  direct SQLite import.
- Local 500k artifact bytes improved `4738745 -> 4214831`, with wall time flat
  (`280.87ms -> 278.95ms`). External app-style scoped artifact bytes improved
  `3938884 -> 3527331`, with bootstrap roughly flat/slightly better
  (`4844.13ms -> 4830.08ms`).
- This does not solve memory. External peak memory moved
  `750.48MB -> 758.2MB`, so the next accepted slice must target artifact
  memory/retention or transaction shape, not only compressed body size.

Retained twenty-first slice:

- Browser pull no longer batches all decompressed SQLite artifact bodies before
  apply. It validates artifact refs first, then fetches and applies each body
  inside the existing apply transaction.
- This keeps rollback safety for corrupt/failing later artifact fetches while
  avoiding retention of every decompressed SQLite image for the snapshot.
- External app-style scoped artifact peak memory improved
  `758.2MB -> 746.92MB`; local 500k JS heap after moved
  `16853576 -> 16451448`. Wall time stayed flat/noisy, and local apply stayed
  `1392ms`.

Rejected nullable-column elision probe:

- Tried omitting artifact columns when a nullable generated column was null for
  every row in the artifact page.
- Rejected because external peak memory only moved `746.92MB -> 745.73MB`,
  while external bootstrap regressed `4845.39ms -> 5641.22ms`, external local
  apply regressed `1392ms -> 1567ms`, and local compressed response bytes
  worsened `4214831 -> 4407824`.

Rejected attached-schema PRAGMA probe:

- Tested the two-argument `pragma_table_info(table, schema)` form needed for
  variable artifact column sets.
- Rejected because it regressed the current fixed-column hot path:
  external bootstrap `4845.39ms -> 6118.45ms`, external local apply
  `1392ms -> 1705ms`, and peak memory `746.92MB -> 755.36MB`.

Rejected 100k artifact bundle-cap probe:

- Raised the server bundle cap to `100k` rows while keeping browser logical
  snapshot pages at `50k`, so larger precomputed artifacts selected correctly.
- Rejected because request count and bytes improved only slightly, while
  external bootstrap regressed `4845.39ms -> 5670.76ms`, local apply regressed
  `1392ms -> 1620ms`, and peak memory worsened `746.92MB -> 776.06MB`.
- Keep the current `50k` bundle cap until the import path can release attached
  SQLite artifact buffers before the end of the apply transaction.

Rejected SQLite-owned deserialize-buffer probe:

- Copied decompressed artifact bodies into `sqlite3_malloc64` memory and used
  `SQLITE_DESERIALIZE_FREEONCLOSE` so SQLite owned the buffers instead of
  retaining Rust `Vec<u8>` values.
- Rejected because external peak memory only moved `746.92MB -> 746.81MB`,
  while external bootstrap regressed `4845.39ms -> 5682.5ms` and local apply
  regressed `1392ms -> 1617ms`.
- Ownership transfer is not enough; the next real memory work needs an import
  shape that can release or detach artifact DBs before full apply commit.

Rejected staged temp-table artifact import:

- Staged artifact rows outside the apply transaction by copying attached
  artifact DB rows into temp tables, detaching immediately, then applying from
  temp tables inside the transaction.
- Rejected because the local JS heap win did not carry to external peak memory:
  external peak memory worsened `746.92MB -> 752.83MB`, local apply regressed
  `1392ms -> 1655ms`, and 500k bootstrap regressed
  `4845.39ms -> 7461.99ms`.
- This confirms a generic SQLite-to-SQLite staging copy is too expensive. The
  remaining viable memory path needs either true early detach without staging
  copies, or a different bootstrap state model.

Rejected separate-SQLite row streaming importer:

- Tried opening each downloaded artifact body as a separate temporary SQLite
  handle and streaming rows into the main database with prepared multirow
  inserts, closing the artifact handle immediately after its rows were copied.
- Correctness passed for wasm check/build and targeted browser artifact tests.
- Rejected because the current direct attached-schema import is much faster:
  local 100k artifact bootstrap regressed to `164.55ms`, and local 500k
  artifact bootstrap regressed to `738.07ms` with `665ms` spent in artifact row
  apply. The retained compact artifact guard is roughly `66ms` at 100k and
  `260-280ms` at 500k.
- The probe reduced local heap pressure, but it effectively rebuilt the
  row-copy path. Do not retry row streaming unless it has a generated typed
  import path that avoids generic row materialization and bind work.

Rejected segmented artifact apply transaction:

- Tried keeping the fast attached-schema `INSERT ... SELECT` import while
  committing after each non-final artifact page, persisting
  `bootstrapStateAfter`, detaching the artifact schema, and beginning the next
  apply segment.
- Correctness passed for wasm check/build and targeted browser artifact tests.
- Rejected because the repeated commit/detach/rebegin shape still regressed
  local artifact throughput: 100k artifact bootstrap `147.69ms`, 500k artifact
  bootstrap `605.27ms`, and 500k artifact row apply `531ms`.
- This reduced heap versus the retained direct import, but not enough to justify
  more than doubling the 500k artifact wall time. The next memory design must
  avoid both row-copy staging and repeated apply transaction boundaries.

Retained twenty-second slice:

- Browser direct SQLite artifact pulls now cap `maxSnapshotPages` to `2` while
  leaving row-chunk pulls on the configured page count. This bounds attached
  artifact schemas/buffers retained by a single apply transaction without
  copying rows into staging tables or committing after every artifact page.
- The browser E2E scoreboard now accepts `--rust-max-snapshot-pages` so page
  cap probes can be measured directly.
- Same-session local 500k browser artifact control with the old effective cap
  of `10`: `rust_bootstrap_ms=623.48`, `rust_pull_apply_ms=606`,
  `rust_snapshot_row_apply_ms=541`, `rust_pull_rounds=1`,
  `rust_request_count=11`, and JS heap delta `10.40MB`.
- Local cap `1` probe: `rust_bootstrap_ms=619.6`,
  `rust_snapshot_row_apply_ms=519`, `rust_pull_rounds=10`,
  `rust_request_count=20`, and JS heap delta `6.51MB`. This was not retained
  because it penalized the 100k lane by forcing two pull rounds.
- Retained cap `2`: local 500k `rust_bootstrap_ms=595.93`,
  `rust_pull_apply_ms=569`, `rust_snapshot_row_apply_ms=512`,
  `rust_pull_rounds=5`, `rust_request_count=15`, and JS heap delta `2.60MB`.
  Local 100k stays at one pull round with `rust_bootstrap_ms=147.84`.
- External app-style scoped artifact gate now uses
  `SYNCULAR_BENCH_SCOPED_SQLITE_ARTIFACT_ROW_LIMIT=40000` to match the external
  Rust harness's `20k` row page and the new `2` page cap. With matching
  precompute, artifacts selected correctly:
  `snapshot_chunk_count_500000=0`, `bootstrap_500000_ms=1334.25`,
  `local_apply_ms_500000=198`, `response_bytes_500000=3537673`, and
  `peak_memory_mb_500000=707.92`.
- A mismatched external run with the old `60000` precompute key fell back to
  row chunks: `snapshot_chunk_count_500000=13`,
  `bootstrap_500000_ms=2686.04`, `local_apply_ms_500000=402`, and
  `peak_memory_mb_500000=723.59`.
- Decision: retained. This is the first artifact resource-shape change that
  improves large local browser memory and external app-style peak memory
  without weakening artifact verification or copying rows.

Rejected SQLite memory-release probe:

- Tried calling `sqlite3_db_release_memory` after each direct attached-schema
  artifact import. This was intentionally a low-complexity probe: no protocol
  change, no transaction-shape change, and no hidden cache.
- Local 500k release artifact benchmark moved `rust_bootstrap_ms`
  `616.53 -> 610.28` and JS heap delta `6.92MB -> 6.22MB`, but this was not
  enough evidence to retain.
- External app-style scoped artifact gate rejected the probe: 500k bootstrap
  regressed `1334.25ms -> 1418.34ms`, local apply regressed `198ms -> 212ms`,
  and peak memory improved only `707.92MB -> 704.72MB`.
- Decision: rejected. The memory win is too small for the wall-time regression.
  Keep looking for an artifact state design that releases attached databases
  earlier without row-copy staging or repeated commit boundaries.

Generated derived-schema contract follow-up:

- The external app-style scoped artifact gate now shows that artifact
  sync/apply is no longer the dominant cost in that harness. A rejected
  memory-release probe reported 500k bootstrap `1418.34ms`, with
  `sync_total_ms_500000=448`, `pull_apply_ms_500000=340`,
  `local_apply_ms_500000=212`, and `derived_schema_ms_500000=954.17`.
- WP-06 now exports generated TypeScript helpers for local indexes and
  read-model setup/rebuild phases so external adapters can consume the app
  schema contract directly instead of rebuilding derived SQL fixtures by hand.
  The default generated installer stayed in band on the 100k release artifact
  gate (`147.84ms -> 146.94ms`). A generated `liveSetup` mode was rejected
  because 500k bootstrap regressed versus the default installer.
- `syncular.schema.json` now includes a flattened `localDerivedSchema` section
  for non-TS adapters that need the same local index/read-model install phases
  without reconstructing them from table and read-model metadata.
- Browser E2E scoreboard now reports `rust_schema_install_ms` and
  `rust_cached_schema_install_ms`, keeping sync bootstrap timing separate from
  generated schema installation. The 100k release artifact gate stayed in band:
  `rust_bootstrap_ms=149.75`, `rust_schema_install_ms=5.42`, and
  `rust_cached_schema_install_ms=2.55`.
- The external app-style benchmark has now consumed the generated
  `localDerivedSchema` contract directly. The current bulk-load-then-rebuild
  shape reported 500k bootstrap `1396.01ms`, local apply `208ms`, response
  bytes `3537713`, and peak memory `695.97MB`. A temporary before-bootstrap
  derived-schema install was rejected because it regressed 500k bootstrap to
  `1827.83ms`, local apply to `1525ms`, and peak memory to `761.14MB`.

Retained derived-schema storage-shape follow-up:

- Generated `countBy` read-model tables now use `WITHOUT ROWID` because their
  dimension columns already form the primary key and are validated non-null.
- This keeps the generated query/read-model contract unchanged while using the
  canonical SQLite storage shape for composite-key aggregate tables.
- External app-style scoped artifacts improved on the 500k lane:
  bootstrap `1430.17ms -> 1382.56ms`, derived schema
  `976.02ms -> 930.41ms`, and local apply `207ms -> 202ms`, with
  `snapshotChunkCount=0`.

Retained generated schema timing follow-up:

- Generated TypeScript app clients now expose
  `ensureSyncularAppSchemaWithTimings(...)` and
  `ensureSyncularAppDerivedSchemaWithTimings(...)` beside the existing
  installer. The default consumer API stays unchanged.
- Browser E2E now reports schema phases:
  `rust_schema_base_ms`, `rust_schema_derived_ms`,
  `rust_schema_indexes_ms`, `rust_schema_read_model_probe_ms`,
  `rust_schema_read_model_setup_ms`,
  `rust_schema_read_model_rebuild_ms`, and
  `rust_schema_record_version_ms`, plus cached equivalents.
- 100k release artifact gate stayed in band:
  previous schema-install run `rust_bootstrap_ms=149.75`,
  `rust_schema_install_ms=5.42`, `rust_cached_schema_install_ms=2.55`;
  current `rust_bootstrap_ms=144.00`, `rust_schema_install_ms=5.34`,
  `rust_cached_schema_install_ms=1.91`.
- A local `.context` probe against the external app schema showed the 500k
  derived-schema cost is index dominated: indexes `1070.57ms`,
  read-model setup `0.67ms`, and read-model rebuild `38.88ms`.
  Rebuilding read models before indexes was rejected (`1110.12ms -> 1377.38ms`
  derived total). A dimension-index-first order was roughly flat in the probe
  (`1110.12ms -> 1055.27ms`) and needs generated index-column metadata plus
  external proof before it is worth retaining.

Retained artifact protocol hardening follow-up:

- Snapshot pages that carry scoped SQLite artifact refs are now exclusive:
  they cannot also carry inline rows, snapshot chunks, or chunk manifests.
- TypeScript protocol validation rejects mixed artifact/row/chunk shapes at
  the `SyncSnapshotSchema` boundary.
- Rust protocol validation rejects the same mixed shape through
  `validate_pull_snapshot_manifests(...)` before runtime apply/fetch paths can
  clear or mutate local rows.
- Correctness gates passed:
  `bun test packages/core/src/__tests__/snapshot-chunks.test.ts`,
  `bun test packages/core/src/__tests__/sync-packs.test.ts packages/core/src/__tests__/protocol-fixtures.test.ts`,
  `bun run --cwd packages/core tsgo`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract http_sync_diesel_applies_snapshot_artifact_rows --features native,crdt-yjs,demo-todo-native-fixture`, and
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract http_sync_rejects_snapshot_artifacts_before_mutating_store --features native,crdt-yjs,demo-todo-native-fixture`.

Retained generated index metadata follow-up:

- The Rust code generator now introspects SQLite index columns through
  `PRAGMA index_xinfo(...)`.
- `syncular.schema.json`, `localDerivedSchema.indexes`, and generated
  TypeScript `syncularGeneratedLocalIndexes` now expose structured index
  columns with `name` and `descending` metadata alongside the executable SQL.
- This does not change install behavior. It gives future derived-schema
  experiments reliable generated input for index-shape/order decisions instead
  of parsing SQL strings.
- Correctness gates passed:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`,
  `bun run --cwd rust/examples/todo-app tsgo`, and
  `bun run --cwd rust/bindings/browser tsgo`.

Retained local-index normalization follow-up:

- The generator now omits redundant generated local indexes when a longer
  non-unique, non-partial, non-expression index on the same table covers the
  shorter index's leading column sequence.
- Unique and partial indexes are preserved. This is an app-declared index
  normalization, not hidden caching or a runtime fallback.
- The stable schema contract and generated TypeScript local-index metadata now
  carry structured `unique` and `partial` booleans, so future generator/binding
  work does not need to infer index semantics from SQL text.
- The external benchmark app's shorter
  `(project_id, owner_id, completed)` index is covered by
  `(project_id, owner_id, completed, updated_at desc)` and is no longer created
  by the generated install contract.
- Local external-schema probe improved 500k derived setup
  `1110.12ms -> 794.66ms`, with index creation
  `1070.57ms -> 757.80ms`.
- External app-style scoped artifact 500k bootstrap improved
  `1382.56ms -> 1142.29ms`; derived schema improved
  `930.41ms -> 672.43ms`; peak memory improved
  `696.50MB -> 667.59MB`; `snapshotChunkCount` stayed `0`.
- External Rust local-query stayed healthy after the omitted prefix index:
  list p50 `0.16ms`, search p50 `0.22ms`, read-model aggregate p50 `0.02ms`,
  raw aggregate p50 `7.64ms`.
- Browser 100k release artifact guard stayed in band:
  bootstrap `144.00ms -> 143.14ms`, schema install `5.34ms -> 5.20ms`.

Rejected artifact page-cap follow-up:

- Raising browser direct artifact pulls from cap `2` to cap `3` lets the
  external 20k-page harness use 60k artifact bundles and reduces external sync
  calls from `13` to `9`.
- It was still rejected: external 500k bootstrap improved only
  `1142.29ms -> 1095.22ms` while peak memory regressed
  `667.59MB -> 675.95MB`; local browser 500k heap delta regressed from the
  accepted `2.60MB` cap-2 context to `11.89MB`.
- Keep the cap at `2` unless a later bootstrap state design can release
  artifact DBs earlier without copying rows or increasing peak memory.

Retained artifact recovery coverage follow-up:

- Browser/Hono WASM coverage now proves a transient HTTP 500 while downloading
  a scoped SQLite snapshot artifact leaves local rows untouched and recovers on
  the next pull.
- The browser byte transport now reports byte-fetch failures with the concrete
  resource label (`snapshot artifact`, `snapshot chunk`, or `blob download`)
  instead of reusing the snapshot chunk label for every byte request.
- Correctness gate passed:
  `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "SQLite snapshot artifact|corrupted SQLite snapshot artifact|interrupted SQLite snapshot artifact|artifact rows when a subscription is revoked"`.

Retained artifact best-fit lookup follow-up:

- Server pull now looks up the largest scoped snapshot artifact whose row limit
  fits the current pull capacity instead of requiring an exact row-limit key.
  This keeps one current artifact path while avoiding accidental row-chunk
  fallback when a smaller verified artifact page exists.
- Pull continuation now advances by the selected artifact manifest's row limit,
  not the requested capacity, so smaller artifacts can fill the remaining
  bootstrap pages in the same pull.
- Correctness gates passed:
  `bun test packages/server/src/snapshot-artifacts.test.ts packages/server/src/pull-snapshot-artifacts.test.ts`
  and `bun run --cwd packages/server tsgo`.
- Local 100k matched artifact guard stayed in band:
  previous accepted `rust_bootstrap_ms=143.14`, current `144.56`;
  `rust_snapshot_chunk_binary_count=0` stayed unchanged.
- Local 100k mismatch guard with `25k` precomputed artifacts and `50k` Rust
  page requests now reports `rust_bootstrap_ms=142.75`, `rust_pull_rounds=2`,
  and `rust_snapshot_chunk_binary_count=0`. This proves the server no longer
  silently drops to row chunks for smaller eligible artifacts.
- External app-style matched 40k artifact guard stayed in band:
  500k bootstrap `1142.29ms -> 1154.34ms`, derived schema
  `672.43ms -> 673.26ms`, local apply `222ms -> 209ms`, peak memory
  `667.59MB -> 662.03MB`, and `snapshotChunkCount=0`.
- External app-style 20k artifact robustness guard also kept
  `snapshotChunkCount=0` and reported 500k bootstrap `1024.78ms`, but response
  bytes (`3,554,785`) and peak memory (`671.81MB`) are worse than the accepted
  40k baseline, so this is not a page-size win.

Retained browser artifact timing counters follow-up:

- Browser Rust transport stats now report artifact count, compressed artifact
  bytes, artifact fetch, artifact hash, and artifact decompression. Browser
  sync timings now report direct SQLite artifact apply separately from the
  broad snapshot row apply total.
- This is measurement infrastructure for the next artifact state changes, not
  a runtime caching path.
- Correctness gates passed:
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun run --cwd tests/runtime tsgo`,
  `CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`, and
  `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "SQLite snapshot artifact|corrupted SQLite snapshot artifact|interrupted SQLite snapshot artifact|artifact rows when a subscription is revoked"`.
- Local 100k release artifact guard stayed in band:
  `rust_bootstrap_ms=136.33`, `rust_snapshot_artifact_count=2`,
  `rust_snapshot_artifact_bytes=872794`,
  `rust_snapshot_artifact_fetch_ms=4`,
  `rust_snapshot_artifact_decompress_ms=6`,
  `rust_snapshot_artifact_hash_ms=2`, and
  `rust_snapshot_artifact_apply_ms=111`.
- External app-style 40k artifact guard stayed healthy:
  500k bootstrap `1154.34ms -> 1002.06ms`, local apply `209ms -> 198ms`,
  response bytes `3,537,717 -> 3,537,647`, peak memory
  `662.03MB -> 668.20MB`, and `snapshotChunkCount=0`.

## Next Action

Continue artifact resource-state work, but keep it benchmark-gated.

- The accepted scoped artifact baseline is now external Rust 500k bootstrap
  `1142.29ms`, derived schema `672.43ms`, local apply `222ms`, response bytes
  `3537756`, peak memory `667.59MB`, and `snapshotChunkCount=0`, with external
  artifact precompute row limit `40000`. Smaller artifact pages are now valid
  only when the best-fit lookup keeps `snapshotChunkCount=0`; use this as a
  robustness guard, not a reason to lower the accepted page size without a
  benchmark win.
- The nullable-column, attached-PRAGMA, larger-bundle, SQLite-owned-buffer, and
  temp-table staging probes were all rejected. Separate-SQLite row streaming and
  segmented artifact apply were also rejected. Raising browser artifact pull
  cap `2 -> 3` was rejected for the same reason: modest wall-time improvement
  with higher peak memory. These either regressed wall time or failed to improve
  external peak memory enough to justify their complexity.
- Do not keep spending time on artifact memory micro-probes unless they change
  the bootstrap state model. The generated `localDerivedSchema` path is proven,
  and the before-bootstrap install strategy is rejected; keep bulk load followed
  by explicit index/read-model setup and rebuild.
- Keep schema-install timing visible in local browser runs when comparing
  against external app-style benchmarks, because external reports derived
  schema as part of app bootstrap while local sync bootstrap intentionally does
  not.
- Derived-schema setup is now a first-class performance input for app-style
  bootstrap comparisons. Keep optimizing only generated, app-declared local
  indexes/read models; do not introduce hidden runtime caches.
- The remaining derived-schema bottleneck is still app-declared index creation,
  but the obvious redundant-prefix case is handled. Avoid additional
  index-order/read-model rebuild changes unless the external app-style gate
  proves a clear win.
- The next useful artifact-memory step is still a larger bootstrap state design
  if the generated derived-schema work leaves memory as the bottleneck:
  release/detach artifact databases before full commit without copying rows
  into staging tables, or make artifact phase/checkpoint semantics explicit
  enough that partial artifact progress is safe and observable.
- Keep native Diesel on verified artifact row projection until the raw SQLite
  attach/deserialization constraint has a clean solution.
