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
- Rust protocol request structs can carry the artifact capability, but runtime
  clients still leave it unset until artifact body download/apply is implemented.
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
  rejected before clearing local rows until download/apply support lands.
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

## Next Action

Build the artifact body path:

- how background/precompute jobs create scoped SQLite artifact bodies and insert
  matching metadata rows;
- how browser/native clients download, verify, and apply artifact bodies;
- how revocation and interrupted artifact apply recover without app-side
  special handling.

The first runtime implementation should be a gated prototype for one generated
app schema and one scoped subscription, with benchmark evidence against the
current row-chunk baseline.
