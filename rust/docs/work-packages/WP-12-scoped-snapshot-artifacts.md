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

## Next Action

Turn the artifact prototype into the full bootstrap path:

- Wire the external app-style benchmark stack to precompute scoped artifacts.
- Continue body-shape work only if it preserves direct SQLite import and beats
  the compact artifact baseline above.
- Decide whether native direct import needs a new store-level artifact apply
  trait before replacing the current native row-materialization path.
- Add revocation recovery coverage for the direct import path.
