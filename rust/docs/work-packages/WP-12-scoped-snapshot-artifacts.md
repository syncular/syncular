# WP-12 Scoped Snapshot Artifacts

Status: `[ ]` planned

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

## Next Action

Design the scoped artifact manifest and storage lifecycle before writing code.
The first implementation should be a gated prototype for one generated app
schema and one scoped subscription, with benchmark evidence against the current
row-chunk baseline.
