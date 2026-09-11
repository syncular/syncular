# RFC: Simplify the SQLite blob path

- Status: implemented and validated in the repository; published-client
  confirmation pending
- Date: 2026-09-11
- Baseline: `v0.18.0` (`3238fd4fb723315fd8b8cd17f1a39b687a0bc2d3`)
- Scope: SQLite-backed blob storage in the TS and Rust clients

## 1. Decision

Keep blob bodies in SQLite. Replace the 0.18 trigger and reconciliation logic
with direct state transitions and remove derived refcounts. Preserve
atomic staging, exact input ownership, pre-upload integrity validation, durable
commit dependencies, and owned Rust byte results.

Syncular will support one local blob schema and one implementation path. The
client will reject an older local blob schema. This work will not add migration,
backfill, compatibility, or fallback code.

Retain each production change only when it removes code without a measured
regression, demonstrates a repeatable performance improvement, or fixes a
reproduced reliability failure. Run both cores through the same conformance and
benchmark workloads before retaining a change.

## 2. Problem

Version 0.18 fixed real durability and ownership defects, but its upload path
added four SQLite triggers, startup backfill, an upload table, cached
refcounts, repeated reconciliation, and a second full-body SHA-256 pass. The
release added 691 production lines and removed 72 across the two client cores
and the blob specification.

The completed experiment RFC measured the cost of the durable upload repair at
500 MB:

| Core | Before repair | After repair | Change |
| --- | ---: | ---: | ---: |
| TS | 1,582.48 ms | 1,850.79 ms | +11.67% |
| Rust | 1,359.30 ms | 2,227.94 ms | +67.79% |

The external 0.17 to 0.18 comparison later measured 10.3% slower JS uploads and
13.9% slower Rust uploads across three alternating pairs. It attributed about
209 ms of JS work and 890 ms of Rust work to queued-body hashing. Refcount and
dependency reconciliation added about 350 to 390 ms per transfer.

Other 0.18 changes have separate evidence and remain:

- One Rust staging transaction prevents a body from surviving a failed pin or
  commit write.
- One owned JS snapshot prevents caller mutation from changing staged bytes.
- Owned Rust results reduce 500 MB cache-hit time by about 60% and reader peak
  memory by about 1 GB.
- Targeted reference counting reduces fresh-download time by about 60% when a
  schema contains 100,000 unrelated blob references.

The transfer benchmark does not justify removing those changes. It does justify
replacing the bookkeeping that connects staged bodies to pending commits. The
upload table remains useful because changing a column on the body row rewrites
the large SQLite record.

### 2.1 Rejected two-table experiment

The first implementation stored `needs_upload` on `_syncular_blobs` and
deleted `_syncular_blob_uploads`. Three alternating 500 MB TS screening pairs
measured a median upload regression of 134.9 ms. Clearing `needs_upload` also
made upload completion update the 500 MB SQLite row. The experiment was removed.

The retained candidate keeps upload state in a small table. The experiment
demonstrates that the 0.18 upload table serves a performance purpose; the
triggers, backfill, stored refcount, and reconciliation remain the targets for
removal.

## 3. Required behavior

[SPEC §5.9](./SPEC.md) remains authoritative. The implementation must preserve
these properties:

- `uploadBlob` snapshots the supplied bytes before yielding and stages the body
  atomically.
- A pending upload and every pending commit that references a body prevent its
  eviction.
- The client validates stored type, length, and SHA-256 before requesting an
  upload grant or accepting an already-present result.
- A missing or corrupt body fails with `sync.local_corrupt`. The referencing
  commit and its dependency remain durable.
- Upload succeeds before the client pushes a referencing commit.
- Acknowledgement, rejection, and revocation release only the completed
  commit's dependencies.
- A live row keeps its cached body through cache trimming and revocation purge.
- TS and Rust expose the same wire and lifecycle behavior.

## 4. Local schema

Use three blob tables:

```sql
CREATE TABLE _syncular_blobs(
  blob_id TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  media_type TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE _syncular_blob_uploads(
  blob_id TEXT PRIMARY KEY,
  media_type TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE _syncular_blob_commit_refs(
  commit_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  PRIMARY KEY(commit_id, blob_id)
);
```

Remove `_syncular_blobs.refcount`, all `_syncular_blob_commit_*` triggers,
startup dependency backfill, and refcount reconciliation writes.

The exact `_syncular_blobs` column layout identifies this schema. A client
opening an older layout fails with `sync.schema_mismatch`. Applications that
adopt the new version create a fresh local database and resync.

## 5. State transitions

### 5.1 Stage

Hash one owned byte snapshot. In one transaction, insert the body if it is
absent and insert its small upload row. A repeated stage preserves the existing
immutable body row. Cache trimming excludes bodies named by
`_syncular_blob_uploads`.

### 5.2 Create or replace a commit

Extract canonical `blob_ref` values from the commit operations in client code.
Write the outbox row and its `(commit_id, blob_id)` dependencies in the same
transaction. Do not recover dependencies by parsing outbox JSON in triggers or
at startup.

### 5.3 Upload

Read `_syncular_blob_uploads` and referenced commit dependencies whose upload
row is absent. Validate the complete pending set before transferring bytes.
Upload each body, then delete its upload row. Deletion errors must propagate
and must not delete commit dependencies.

### 5.4 Complete a commit

Delete the outbox row and its dependency rows in the same transaction. A sibling
commit dependency continues to pin the body. Rejecting or revoking a commit uses
the same transition.

### 5.5 Retain and evict

Do not store derived reference counts. Build one schema-specific SQL expression
that selects valid `blobId` values from visible `blob_ref` columns.

Cache trimming orders bodies by creation timestamp and then `blobId`. It may
delete a body only when all conditions hold:

- no upload row exists
- no pending commit dependency exists
- no visible row contains its `blobId`

Revocation purge applies the same predicate to every unreferenced body. Ordinary
row apply does not rewrite blob metadata.

## 6. Implementation sequence

1. Freeze the 0.18 source snapshot used by the repository file profile.
2. Add shared conformance cases for explicit dependency insertion, replacement,
   acknowledgement, rejection, revocation, restart, and cache trimming.
3. Update SPEC §5.9.7 and the local schema identity.
4. Implement the three-table state machine in TS. Delete the triggers,
   backfill, stored refcount, and reconciliation path in the same change.
5. Implement the same state machine in Rust. Keep the owned byte API and remove
   the same obsolete machinery.
6. Run focused conformance, both Rust workspaces, binding gates, and
   `bun run check`.
7. Run paired repository benchmarks. If the candidate passes, run the external
   Syncular file benchmark as an independent confirmation.
8. Record the result in this RFC and `bench/RESULTS.md`. Revert any candidate
   that misses its retention gate.

## 7. Benchmark protocol

Use the existing file profile with local services, persistent WAL/FULL client
databases, the pinned MinIO image, fresh writer and reader processes, and full
500,000,000-byte SHA-256 receipts. Fixture generation and final validation stay
outside operation clocks.

Collect ten paired blocks for TS and Rust. Alternate candidate and baseline
order. Compare the candidate against 0.18 for these phases:

- stage
- upload plus metadata acceptance
- fresh download
- cache hit
- offline reopen
- writer and reader CPU
- writer and reader peak RSS

Repeat the complete collection independently. Run the corruption, restart,
failure, cache-cap, rejection, and revocation catalog before performance
measurements. Compare the published version with 0.17 and 0.18 in the external
benchmark after release.

## 8. Retention gates

The complete candidate must satisfy every gate:

- All blob conformance cases pass in TS and Rust.
- No trigger, startup backfill, stored refcount, compatibility
  branch, or fallback remains.
- Blob production code contains fewer statements and fewer lines than 0.18.
- Both independent 500 MB upload intervals exclude zero in the improvement
  direction for each core.
- Fresh download, cache hit, and reopen show no repeatable regression.
- The external benchmark must confirm the direction before the release result
  becomes the published comparison.

Reliability does not justify a new performance regression because 0.18 already
provides the required behavior.

## 9. Results

Two independent collections completed 80 of 80 attempts. Every attempt used a
fresh writer, a fresh reader database, a distinct MinIO container, and the same
500,000,000-byte fixture. The harness verified the staged bytes, stored object,
downloaded result, cache hit, reopened cache hit, and final SHA-256 receipt.
Diagnostics were disabled. The candidate source patch SHA-256 was
`98dca289cd4ab3c9f3d0cd4ba2ccd12a9db013fe4b892aa0194ecdcbe3a4cabb`.
The local benchmark run preserved compact observations, the frozen candidate
patch, and the generated summary. `bench/RESULTS.md` records the curated result.

Upload plus metadata acceptance was the primary metric. Negative changes mean
the candidate took less time:

| Collection | Core | 0.18 median | Candidate median | Paired change | 95% interval |
| --- | --- | ---: | ---: | ---: | ---: |
| First | TS | 1,905.12 ms | 1,454.29 ms | -21.07% | [-31.11%, -9.12%] |
| Confirmation | TS | 1,994.98 ms | 1,524.89 ms | -24.93% | [-32.73%, -17.18%] |
| First | Rust | 2,147.38 ms | 1,993.12 ms | -8.99% | [-13.66%, -4.70%] |
| Confirmation | Rust | 2,212.32 ms | 2,027.48 ms | -6.80% | [-10.00%, -3.44%] |

The cache-hit change repeated with narrower intervals:

| Collection | Core | 0.18 median | Candidate median | Paired change | 95% interval |
| --- | --- | ---: | ---: | ---: | ---: |
| First | TS | 265.51 ms | 99.07 ms | -61.60% | [-63.84%, -58.03%] |
| Confirmation | TS | 267.08 ms | 97.63 ms | -61.86% | [-65.85%, -56.72%] |
| First | Rust | 240.01 ms | 81.32 ms | -66.07% | [-66.49%, -65.57%] |
| Confirmation | Rust | 240.57 ms | 79.45 ms | -67.03% | [-67.85%, -66.15%] |

Reopened cache hits improved by 60.72% and 61.54% for TS and by 56.30% and
58.37% for Rust. Rust fresh downloads improved by 4.41% and 15.06%; both
intervals excluded zero. TS fresh-download point estimates improved by 3.79%
and 18.59%, but both intervals included zero, so the measurements establish no
TS fresh-download claim. No unchanged phase showed a repeatable material
regression. Every candidate download left a zero-byte WAL before the cache-hit
measurement.

The retained production diff removes 162 net lines across the TS and Rust
client cores. It deletes four triggers, startup backfill, stored refcounts,
cache-hit metadata writes, and reconciliation. The small upload table remains
because the rejected two-table experiment rewrote the 500 MB body row when it
cleared upload state. The retained candidate satisfies the repository gates.
The external published-client comparison remains pending because this checkout
has not been released.

Both TS and Rust pass all 147 shared conformance scenarios. The Rust workspace
passes 145 unit, integration, and vector tests with all features, plus Clippy
with warnings denied. The repository gate passes 1,919 main tests and 13
isolated multi-tab tests, type checking, formatting, lint, dependency analysis,
and Node runtime verification. The complete Tauri binding gate also passes.

## 10. Conditional SHA experiment

The RustCrypto `sha2` assembly feature remains a separate future candidate. An
isolated Apple M4 measurement reduced a 500 MB hash from about 877 ms to 194 ms.
Evaluate it only when the published Rust result still needs improvement. Retain
it only when the full Rust upload benchmark improves, all supported target
builds pass, and the dependency adds no separate runtime path in Syncular.

Do not skip pre-upload SHA-256 validation. The validation catches local body
corruption before the client accepts a server-present grant.
