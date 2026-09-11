# RFC: SQLite blob performance and reliability experiments

- Status: implementation in progress
- Date: 2026-09-10
- Review baseline: `99a036a19911068008d8f32136c69e1fcaabd874`
- Scope: SQLite-backed client attachments, TS/Rust APIs and transports, native boundaries, and repository benchmarks

## 1. Decision and scope

Keep client attachment bodies in SQLite. Measure the current path, then evaluate
individual changes to copying, hashing, cache access, encoding, and storage I/O.
Retain production changes only when an experiment demonstrates a performance
improvement or a reproducible reliability improvement. An inconclusive experiment
does not justify adding production complexity.

Extend the existing `bench/` suite and Rust benchmark driver. This RFC builds on
[RFC-ENGINE-PERFORMANCE.md](./RFC-ENGINE-PERFORMANCE.md), particularly its blob
workloads and native phase attribution. Existing results remain historical
evidence; new experiments get their own baselines and records.

Separate OPFS body files, a native filesystem body store, and a storage-backend
migration are outside this work. Browser SQLite continues to use OPFS through
the existing worker and SAH pool. SQLite schema changes are conditional
experiments, considered after the simpler changes. Execution started on
2026-09-10 under the task goal. Publishing remains outside the authorized scope.

[SPEC §5.9](./SPEC.md) remains authoritative for content addresses, verification,
authorization, reference retention, and upload-before-push. Preserve B1's
SQLite storage decision, existing byte-array APIs, SSP2, and the
[SYQL](./SYQL.md) read model. Observable API/lifecycle changes require a spec
update, both cores, and shared conformance coverage before implementation.
Do not weaken durability, skip verification, or silently switch capabilities
to improve a timing.

## 2. Evidence to reproduce

### Inspected implementation

The checkout manifests use `0.0.0`; the external benchmark uses published
0.17.0. The installed npm client and Rust registry crate were compared with tag
`v0.17.0` (`252c5f8d69db0974510fe993c040aa1768c48a9f`). TS `client.ts`, TS
`blob.ts`, and Rust `client.rs` are byte-identical across those package sources,
the tag, and this review baseline. This establishes source behavior, not a
performance measurement of the checkout.

| Observation | Evidence and consequence |
| --- | --- |
| JS hashes `bytes.slice().buffer` | [`blob.ts`](../packages/web-client/src/blob.ts) adds an explicit full-body copy before WebCrypto; staging subsequently inserts the caller's original array |
| Both cores read a fresh download back after inserting it | [`client.ts`](../packages/web-client/src/client.ts), [`client.rs`](../rust/crates/client/src/client.rs): download, verify, insert, reconcile, trim, and select the body again |
| Rust's core result contains hexadecimal bytes | `fetch_blob` returns a JSON value; its cache reader allocates a `Vec<u8>` and a hex string. This occurs before the shared command/FFI boundary |
| Node normalizes BLOBs with another `Uint8Array` allocation | [`node-database.ts`](../packages/web-client/src/node-database.ts); buffer ownership must be verified before removing it |
| Refcount reconciliation scans blob-reference columns and resets/rebuilds cached counts | Both cores; a large attachment table can add work independent of body size |
| Rust stages a body and its upload record in separate statements | TS wraps these writes in one transaction; Rust's `upload_blob` method has no enclosing transaction |
| A missing upload body loses its queue entry | TS clears and skips; Rust also deletes the upload record after an absent body. B4 instead requires durable pending bodies |

Reproduce the reliability consequences with fault injection before fixing them.
In particular, exercise caller mutation during asynchronous hashing, SQL failure
between staging writes, and a missing body during upload flush. A passing normal
upload does not establish crash safety. Scan both cores and host adapters for
the same patterns before changing one instance.

### Existing measurements

The [external 500 MB report at e55012a](https://github.com/bkniffler/offline-sync-bench/blob/e55012a1bc94d95832a384b58c23b65062ac19c4/results/large-files/README.md)
and [raw results](https://github.com/bkniffler/offline-sync-bench/blob/e55012a1bc94d95832a384b58c23b65062ac19c4/results/large-files/RESULTS.json)
record these single local trials, in milliseconds:

| Client | Stage | Upload clock | Fresh download |
| --- | ---: | ---: | ---: |
| Syncular JS 0.17.0 | 1,353.29 | 2,169.53 | 2,306.69 |
| Syncular Rust 0.17.0 | 1,840.87 | 1,412.84 | 3,041.53 |
| PowerSync | 147.94 | 1,027.77 | 604.40 |

Fresh processes had empty product body caches and verified all 500,000,000
bytes. OS/server caches stayed warm; source-file reading and final harness
SHA-256 validation were outside the operation clocks. The JS
[meter](https://github.com/bkniffler/offline-sync-bench/blob/e55012a1bc94d95832a384b58c23b65062ac19c4/src/http-meter.ts)
materializes upload requests again to preserve Content-Length. Syncular's upload
clock includes metadata acceptance; PowerSync waits for that after its clock.
Rust's timed API constructs hex internally, but this trial returns only a digest
receipt over stdio; decoding and final validation follow the clock. No corrected
run exists from this evaluation. These numbers cannot isolate SQLite's cost or
establish a product-speed ratio.

The repository's engine performance RFC §9.45 measured a different, 2 MiB native
workload: cache insertion/refcounts/retention took 13.197 ms, verification
3.629 ms, and cache read/materialization 2.628 ms, including 1.707 ms of hex
encoding. These are nested diagnostic phases, not additive totals. Reproduce
them at the new baseline before assigning optimization priority or extrapolating
to 500 MB.

## 3. Establish the repository benchmark first

Reuse the existing components:

| Component | Required extension |
| --- | --- |
| [`bench/src/blob-lane.ts`](../bench/src/blob-lane.ts), adjacent tests | Small/large lifecycle profiles, repeated cache reads, restart, durable staging, and fault cases |
| [`performance.ts`](../bench/src/performance.ts), [`fixture.ts`](../bench/src/fixture.ts) | Workload-specific size limits, object counts, source/consumer modes, artifact metadata, and bounded fixture generation |
| [`ts-process.ts`](../bench/src/ts-process.ts), [`process-driver.ts`](../bench/src/process-driver.ts) | Isolated TS blob clients, local fixture input, and digest receipts without full-body controller traffic |
| [`socket-server.ts`](../bench/src/socket-server.ts) | Equivalent direct and presigned routes, resource isolation, transport counters, and controlled failures |
| [`rust/crates/bench`](../rust/crates/bench/src/lib.rs) | In-process materialization/validation, direct and compatibility boundaries, later binary/stream boundaries |
| [`instrumentation.ts`](../bench/src/instrumentation.ts), Rust private phase recorder | Copy/materialization counts, SQL and transport phases, allocations, and measurement overhead |

At the review baseline, the CLI caps sizes at 16 MiB. TS blob clients share the controller process
even in the socket lane. The native blob lane sends complete hex bodies through
its controller, unlike the external large-file trial. The default server body
store is in memory. Increasing `--sizes` alone would produce a different workload
and misleading memory attribution.

Add a 500,000,000-byte profile only after fixing those boundaries. Generate a
deterministic high-entropy fixture incrementally into a benchmark-owned file;
retain its expected length/hash. Each client process reads or streams that source
locally. Return timing, length, digest, and state receipts to the controller.
The source file is a benchmark fixture, not a new client body store.

For the existing array API, read the source outside the staging-only timer and
also report source-read-plus-stage. Stop download timing when the public API
has produced its complete result, before independent harness verification.
Keep Rust's existing internal hex conversion inside that legacy API timer.
Do not serialize that result across stdio for the large direct-client profile.
Small direct/command/FFI delivery profiles continue measuring real bridge costs;
an unsupported large legacy bridge gets a recorded limit/failure, not a fabricated
binary measurement.

Retain the self-contained memory-server lane for attribution. Add an explicit
repository-owned local S3/MinIO profile using Syncular's existing server store
and presigned grant handling for large socket comparisons. Its pinned service
configuration, setup, cleanup, and prerequisites belong in `bench/`; it must not
depend on the external benchmark checkout. An explicitly selected unavailable
service fails clearly. Keep server/backend behavior frozen while comparing
client changes and record server memory separately. Direct handlers currently
materialize whole bodies; that limitation must remain visible.

Collect independent spans for source read, durable stage, blob transfer/acceptance,
metadata commit acceptance, independent-reader visibility, fresh download, cache
hit, and offline reopen. Keep `uploadAndCommit` as an end-to-end span. Count
traffic from known body lengths or bounded stream observers without rebuffering,
cloning responses, or changing request framing. Validate the meter against server
receipts and compare instrumentation on/off. Keep nested phase durations nested;
never sum overlapping spans.

Existing commands remain valid. Section 9.3 records the implemented file/MinIO
profile; other proposed options remain future work. `--storage file` continues to mean
a persistent SQLite database. Preserve `bun run bench:ci`, diagnostic artifacts
under `bench/results/`, and the rule that diagnostic runs leave curated
[`bench/RESULTS.md`](../bench/RESULTS.md) unchanged.

## 4. Experiments in execution order

Run each candidate against the last accepted baseline, changing one cause at a
time. Reliability repairs precede performance comparisons on affected paths.
If the old implementation violates correctness, retain its failure evidence and
establish a corrected baseline before publishing performance gains.

| ID | Candidate | Hypothesis and required proof |
| --- | --- | --- |
| R1 | Atomic Rust staging and explicit storage errors | Body and upload pin must commit together. Fail the second statement and transaction completion; compare reopen state with TS. Propagate failures without dropping durable work |
| R2 | Preserve uploads and commit dependencies on failure | Missing/corrupt bodies must fail loudly while retaining the pending commit. Audit B4's commit pin versus the current blob-keyed queue cleared after byte upload; reproduce restart/rejection/revocation cases before deciding whether new pin bookkeeping is necessary |
| P1 | Remove redundant JS/adapter copies | Reduce allocated bytes and hash/cache-read time. Preserve a consistent snapshot across hash and persistence; use one owned copy where required. Test mutation, nonzero-offset views, reused buffers, and results surviving later queries/database close |
| P2 | Return verified downloaded bytes without a SQL body readback | Remove one full cache materialization in both cores. Preserve cached metadata, duplicate insertion behavior, refcounts, cap enforcement, error outcomes, and authorization checks; metadata-only verification may replace the body SELECT |
| P3 | Add typed Rust byte results beneath the compatibility serializer | Keep the existing JSON result shape while giving direct native callers owned bytes. Measure typed core, legacy JSON, and real command/FFI delivery separately; add a binary host surface only with explicit ownership and compatibility contracts |
| P4 | Reduce measured metadata/refcount work | Attribute scans, writes, statement preparation, and LRU updates separately. First localize redundant work or batch equivalent writes; add incremental reference bookkeeping only if those reductions are insufficient and a profile supports it |
| P5 | Incremental hashing and SQLite BLOB I/O | Bound memory for large sources and consumers. Prove adapter capability, transaction behavior, slow-network responsiveness, and crash safety before changing the default body path (§5) |
| P6 | SQLite chunk rows, conditional alternative to P5 | Evaluate only if incremental BLOB bindings or writer contention prevent a usable P5. Measure SQL/fsync overhead and recovery complexity; select one production layout from evidence |
| P7 | Targeted SQLite configuration/maintenance | Only after profiling: evaluate cache/page settings or checkpoint scheduling with fixed durability. Include small reads/writes, WAL growth, disk use, and migration cost; no generic PRAGMA tuning bundle |

P1 must not replace `bytes.slice()` with a borrowed array while hashing and
insertion can observe different contents. WebCrypto itself may copy input, so
claim only the removed allocation actually measured. The Node normalization
copy is independent of the Bun lane used in the external trial; measure Node
separately. Do not remove copies that establish required result ownership.

P2 must preserve the earlier fix that refreshes references before trimming a
new body. Cover duplicate content with different caller metadata, simultaneous
fetches, a body larger than the cap, and a SQL error after download. Returning
already-held bytes cannot conceal a failed durable stage or change the public
cache contract without a spec decision.

P3 keeps the shared command router as the compatibility owner. No benchmark-only
replacement for shipping hashing, SQLite access, or transport may count as a
product improvement. Release consumers must have access to the measured API.
Any binary FFI additions specify buffer lifetime/free, cancellation, handle
validity, and error identity; preserve existing byte-array convenience methods.

P4 preserves exact reference and pending-work protection under optimistic
overlays, window eviction, rejection, revocation, local purge, and rebootstrap.
Metadata/body separation into two tables within the same database is a candidate
only when measured access patterns or P5 handle lifetime requires it. Both remain
in the same SQL transaction domain.

## 5. Conditional SQLite streaming design

Start with a capability experiment across the actual Bun, Node, sqlite-wasm,
and Rust adapters. [`ClientDatabase`](../packages/web-client/src/database.ts)
currently exposes synchronous statements/transactions, without incremental BLOB
I/O. Check the supported runtime versions and bindings before designing a new
interface. Do not assume a C API is available through every JS wrapper, add an
unrequested runtime dependency, or silently materialize an unsupported stream.

SQLite provides [`sqlite3_blob_open/read/write`](https://www.sqlite.org/c3ref/blob_open.html)
and `zeroblob(size)` for fixed-size bodies. BLOB handles require a rowid table
and cannot resize the value. Updating any column of their row expires the handle,
including LRU/refcount updates. Close handles before such updates or use measured
metadata/body separation. A successful write is insufficient: handle
[close](https://www.sqlite.org/c3ref/blob_close.html) and SQL commit errors also
require handling.

For P5, propose a hidden staging record with an internal identity, expected
length, received length, and incomplete/verified state. Write bounded batches
inside short SQL transactions, close write handles before committing, and
release the database writer between batches. Hash chunks as they arrive.
Allocation of `zeroblob(500000000)` has disk and latency cost even when client
memory stays bounded; include that operation and its journal traffic in staging.
Never hold a write transaction open while awaiting network data.

After full length/hash verification, one SQL transaction publishes the canonical
blob ID and required pins. Incomplete rows never enter the readable blob mapping
or syncable application rows; fetch and upload flush cannot consume them.
After a crash, remove or explicitly restart
incomplete stages; never treat them as acknowledged uploads. Completed stages
survive offline restart. Concurrent equal content selects one verified body and
preserves every referencing commit's pin. Revocation/cancellation must prevent
an in-flight stage from publishing after authorization was removed.

Close/reopen read handles between bounded batches when necessary to avoid holding
a read transaction across a stalled consumer and preventing WAL checkpoints.
Keep a logical reader pin while the body remains authorized and immutable;
revocation cancels it. Test that LRU or another reader cannot invalidate the
wrong generation. Avoid holding the shared worker or Rust host command loop for
an entire slow transfer; define how it services local reads, cancellation, and
security preflight between batches.

P6 stores bounded body chunks under `(stage/body identity, chunk index)` with
SQL length/completeness metadata. It supports unknown-length sources through
ordinary bounded INSERTs, but adds row/index and commit costs. Test 64 KiB,
256 KiB, and 1 MiB chunks with bounded transaction batches, including zero-length
and non-aligned final chunks. Do not commit every chunk by default or repeatedly
concatenate BLOBs. P5 may reject unknown-length input explicitly; it must not
buffer the whole source to hide that limit.

If a new SQLite layout wins, update SPEC B1 and define a format-gated, resumable
SQLite-to-SQLite migration. Preserve old bodies and unsynced pins until a verified
replacement commits. Measure migration peak memory, disk/WAL use, interruption,
and downgrade refusal. A chunk layout that needs an expensive whole-body SELECT
to migrate existing 500 MB attachments has not met the memory objective. Remove
unused experimental layouts after selection; retain historical evidence in this
RFC and benchmark artifacts.

Streaming APIs are additive: source-based staging and a verified reader/stream
alongside existing byte-array calls. Incremental SHA-256, SQLite reads/writes,
transport, and host delivery must all use bounded buffers with backpressure.
An initial budget is 256 KiB chunks, four in flight per transfer, and two active
transfers; measure SQLite/runtime memory separately from those library buffers.
The array APIs still allocate a full result, which is a distinct measured mode.

Native HTTP can read SQLite chunks into a known-length request. Browser upload
streams have [transport restrictions](https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests),
including Content-Length and HTTP/1.x constraints. Verify the actual browser,
CORS, proxy, and presigned-store combination. A SQLite body cannot be handed to
fetch as an OPFS-backed File. If a browser cannot stream the chosen transport,
report that boundary and preserve the explicit array API; do not claim bounded
end-to-end memory or add a hidden file spool. Download streams verify completely
before publishing the body. Remote resumable transfers and blob encryption are
outside this RFC.

## 6. Workloads and observations

| Profile | Fixture and required checks |
| --- | --- |
| Small attachments | 1 KiB, 16 KiB, 64 KiB, 256 KiB; individual bodies and 1,000 distinct bodies to expose per-object/metadata cost |
| Images/documents | 1 MiB, 2 MiB, 8 MiB, 16 MiB; two distinct objects, duplicate staging, repeated cache reads, above-cap live references |
| Large attachment | One 500,000,000-byte high-entropy file linked to a task; new reader process and empty body cache; full length/hash receipts |
| Reference scale | Fixed body size with 1, 1,000, and 100,000 referencing rows; multiple columns, shared content, optimistic overwrite, and zero-ref retention |
| Concurrent application work | Slow upload/download while executing local queries, mutations, sync, and permission purge; record operation latency, writer occupancy, and worker/host responsiveness |
| Offline durability | Restart after stage, after upload but before commit acceptance, and after download; original pending commit identities survive, cache hits perform zero network requests |
| Storage pressure | Referenced/pinned bodies above cap, disk/quota exhaustion, deletion and reopen; existing unsynced bodies survive and failures remain explicit |

Keep array-to-materialized-array results separate from source-to-verified-reader
results. For readers, report verified cache publication, first consumer byte,
and full stream consumption; a handle return is not a completed download/read.
Verify full bytes independently outside operation timers, preferably within the
client process so the controller receives only receipts. Record whether
verification is included in each resource interval.

Measure wall time, CPU, allocations/copied bytes, body SELECTs, refcount scans,
SQL/transaction counts, reader/writer hold time, and actual network bytes.
Capture peak RSS per process, JS heap/external arrays, WASM heap, and Rust
allocations where available. Use OS high-water marks and an external sampler
around phase markers; same-event-loop sampling can miss a blocking allocation.
Record pre-phase and whole-process memory, including fixture and validation
overhead; do not describe a lifetime RSS peak as an isolated operation delta.

Record logical/allocated SQLite file size, WAL/journal peak size, bytes written,
checkpoint cost, and retained free pages after deletion. A smaller live body
count does not establish reclaimed disk. Record database versions, page/cache
settings, journal mode, and synchronous setting. Native file baselines retain
WAL/FULL; browser runs retain their actual supported OPFS configuration. Never
compare reduced durability with the baseline as a production optimization.

Run Bun, supported Node versions, Rust direct/command/FFI, and real browser OPFS
workers. Browser coverage includes Chromium, Firefox, Safari, and an iOS or
constrained mobile device, with leader/follower and reload cases. Native API
changes additionally exercise affected Swift/Kotlin/Flutter/React Native/Tauri
bridges. Extend existing test/benchmark entry points; report unsupported or
unavailable lanes explicitly. A Bun SQLite measurement cannot establish browser
or native binding behavior.

## 7. Keep/discard rules and regression gates

Before each experiment, record its hypothesis, target metric, expected mechanism,
affected workloads, acceptable regressions, frozen baseline/candidate build hashes,
and sample plan. Use the same harness for both. Freeze dependencies, server,
fixture, transport, durability, and source/consumer API. Include an A/A comparison
to establish measurement noise before selecting an optimization.

Run at least ten independent fresh baseline/candidate pairs in alternating or
randomized order. Repeat an apparent win in a second independent collection.
Record raw samples and failures, medians/ranges, paired effects, and a 95%
interval for the primary effect. Operation samples within one process do not
count as independent trials. Separate warm product-cache hits from fresh product
caches with warm OS/server caches; cold-cache experiments need their own method.

For performance-only work, use these initial decision thresholds: at least 5%
improvement in the declared elapsed/CPU metric or 10% reduction in peak memory,
with the interval excluding no improvement and an absolute benefit exceeding
the A/A noise. These are experiment-selection criteria, not promised product
gains. Declare a different justified threshold before collecting data, never
after inspecting a candidate. An inconclusive result stays unshipped; extend
the predeclared sample plan or discard the candidate.

A reliability change qualifies through a demonstrated baseline failure, a
documented cause, and deterministic candidate tests proving recovery and retained
work. Report its performance cost separately. Investigate regressions above 10%
in small-blob operations, ordinary query/mutation latency, sync, restart, purge,
memory, or disk amplification. Do not accept a performance win that introduces
correctness failures. A reliability fix with a material regression needs an
explicit recorded tradeoff decision before retention.

Use [shared blob conformance](../packages/conformance/src/catalog/blobs.ts) and
adjacent `bun:test`/Rust tests. Inject failure at hash completion, body insertion,
pin insertion, batch write, handle close, transaction commit, upload acknowledgement,
and publication. Cover partial bodies, mismatched hashes, mutable input, SQL
errors, cancellation, duplicate concurrent operations, lost responses, revocation
during fetch, and interrupted migrations. Use deterministic gates and explicit
flush/readiness helpers; no wall-clock sleeps in tests. Real process kill/reopen
checks complement scoped storage/transport doubles.

Accepted production changes pass `bun run check`, Rust tests and Clippy where
affected, both-core conformance, and relevant binding gates. Rust core changes
activate all binding CI gates. Add structural budgets to `bench:ci` for eliminated
body reads/copies, bounded buffers, preserved pins, and complete recovery. Keep
500 MB and performance statistics in an explicit controlled-runner profile;
ordinary shared CI should not enforce uncalibrated timing thresholds.

## 8. Execution and evidence record

1. Extend and validate the harness, including 500 MB size limits, isolated client
   processes, digest receipts, S3 profile, resource measurements, and A/A runs.
2. Reproduce R1/R2 and input-ownership failures; retain proven reliability repairs
   and establish the corrected baseline.
3. Evaluate P1, P2, P3, and P4 independently. Stop adding changes when the measured
   bottleneck moves; do not implement every candidate by obligation.
4. Reassess remaining memory/latency cost. Run P5's capability and bounded-I/O
   experiments if justified; compare P6 only when P5's limits warrant it. Evaluate
   P7 only against a measured SQLite bottleneck.
5. Compare the final retained set with the corrected starting baseline, including
   small attachments, 500 MB, ordinary client work, and restart/revocation tests.
   Document APIs and behavior in the client README and docs site; add changelog
   entries for retained feature-level work. Remove losing production prototypes.

Append each experiment's evidence here during execution. Keep its raw artifacts
under the established benchmark output convention and curate retained results in
`bench/RESULTS.md` after validation. Source/build hashes and artifact locations
must make each decision reproducible.

| Experiment | Baseline/candidate | Evidence | Decision |
| --- | --- | --- | --- |
| Harness and A/A | Review baseline plus private driver changes | §9.1–9.5: 120 calibration attempts passed; both primary diagnostic-overhead intervals include zero; observed A/A noise sets explicit absolute floors; finer phase attribution remains | Initial calibration complete |
| R1 | One Rust transaction for body and upload pin | §9.6–9.7: baseline failure reproduced; candidate passes both cores and native file reopen; two independent 40-run cost collections | Retain for atomicity with the explicit performance uncertainty in §9.7; no speedup or neutrality claim |
| R2 | Validate queued bytes and preserve commit-dependent bodies | §9.8: 42 shared R2 cases, 7 native reopen cases, and 80 paired benchmark attempts pass | Retained for reliability; measured 500 MB upload cost is +11.7% TS and +67.8% Rust |
| P1 | Hash exact views and stage one owned JS snapshot | §9.9: baseline ownership failure, 82 cross-core blob cases, and two independent 40-run collections | Retained for input ownership; performance improvement remains inconclusive |
| P2 | Return downloaded bytes after metadata-only cache verification | §9.10: 88 cross-core blob cases and 80 paired benchmark attempts pass; both 500 MB primary intervals include zero | Discarded; no production change retained |
| P3 | Add typed Rust byte results beneath the compatibility serializer | §9.11: 80 file-profile and 30 lifecycle attempts pass; the independent 500 MB cache-hit confirmation clears both retention gates | Retained for Rust cache-hit latency, CPU, and peak RSS; JSON command and C ABI remain compatible |
| P4 | Pending | Metadata/refcount hypothesis above | Pending |
| P5–P7 | Conditional | Reassess after simpler candidates | Pending |

## 9. Implementation evidence

### 9.1 Isolated file input and digest receipts, 2026-09-10

The existing TS and Rust benchmark processes now accept the private
`benchBlobFile` command in direct mode. Upload staging reads its fixture in the
client process, then times the shipping `uploadBlob`/`upload_blob` method.
Source-file reading has a separate timer. Downloads time the shipping public
API through complete result materialization, then independently compute a full
SHA-256 receipt. The controller receives metadata and counters, with no body.
Rust retains its internal hex result inside the operation clock and decodes
128 KiB hex pieces during untimed digest verification.

The TS process can open the existing blob fixture, subscribe to attachments,
mutate those rows, and execute bound validation queries. The new contract in
`bench/src/blob-lane.test.ts` runs identically against TS and the real Rust
process. It stages 1,048,579 bytes, queues a reference, kills the writer with
SIGKILL, removes the source fixture, and reopens the same SQLite database.
It verifies the surviving body/upload pin/original commit, an offline cache hit,
subsequent server acceptance, and a fresh reader in another process with an
empty body cache. Complete digests agree, cache hits issue no download, and
the fresh-download response crosses stdio in less than 16 KiB.

Both process contracts pass (46 assertions). The Rust benchmark crate's 11 unit
tests and Clippy with warnings denied pass. `bun run check` passes 1,723 main
tests with 42 explicit skips, 13 isolated tests, typecheck, lint/format, knip,
and both Node runtime contracts. These are correctness checks against debug
Rust, not performance results. No production client code changed.
The CLI still uses its existing blob lane and 16 MiB size limit;
fixture generation, large-profile integration, S3 setup, resource attribution,
and A/A measurements remain before the performance baseline.

### 9.2 Bounded deterministic file fixtures, 2026-09-10

`bench/src/fixture.ts` now generates files up to 500,000,000 bytes with
64 KiB input/output chunks. AES-256-CTR encrypts zero bytes using a zero IV
and the SHA-256 of `syncular-blob-fixture-v1:<seed>` as its key. The receipt
records algorithm `aes-256-ctr-zero-v1`, seed, length, and a digest computed
during generation. The generator handles partial writes, refuses existing
paths, and removes its own incomplete file after a write failure. This bounds
individual generation buffers; it does not claim a process RSS ceiling.

The TS and Rust process contracts use this fixture and independently hash the
source file before comparing upload, reopen, fresh download, and cache-hit
receipts. Five fixed vectors, independently generated with OpenSSL and hashed
with Python hashlib, cover one byte and either side of the 64 KiB boundary.
Tests check exact file lengths, digests, incompressibility, invalid size/seed
rejection, and preservation of existing files. The fixture and both process
contracts pass 95 assertions.

A separate 500,000,000-byte seed-zero generation completed and matched
`shasum -a 256` over the full file:
`5fd68f1bf4781c884bdd3839ecdba18710fc5cba3d0348583f0126b7fe91fb8b`.
The local validation receipt is
`bench/results/blob-fixture-500mb-2026-09-10.json`. Fixture generation and
validation establish input correctness; no client performance was measured.
Large-profile CLI integration, S3 setup, resource attribution, and A/A runs
remain pending.

`bun run check` passes 1,724 main tests (42 explicit skips), 13 isolated
tests, typecheck, lint/format, knip, and both Node runtime contracts.
Production client code remains unchanged.

### 9.3 Repository-owned file/MinIO profile, 2026-09-10

The diagnostic CLI now accepts `--workload blobs --blob-profile file` for
isolated TS and Rust direct clients with persistent SQLite. `--blob-store minio`
selects a fresh Docker container and anonymous data volume using
`minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`.
This is a multi-architecture manifest for MinIO RELEASE.2025-09-07T16-13-09Z.
The image must already exist locally. Setup creates its own credentials, bucket,
and ephemeral loopback port; cleanup removes only its container and volume.
The existing memory-store lifecycle and native bridge profiles remain available.

The file profile uses the shipping S3 store, upload grants, and authorized
presigned downloads. The writer stages a file, removes the source, and commits
an attachment sharing the first seeded task's ID and project. A fresh reader
syncs that reference, verifies an empty body cache, downloads the complete body,
and validates its digest. The same reader measures a cache hit. Another process
reopens its SQLite file and validates an offline hit after the sync server stops.
The runner checks the original commit outcome, upload-pin drain, WAL/FULL
configuration, stored object length through HEAD, and bounded receipt IPC.

Rust's private transport recorder now times `blob_put_url` and counts bytes
from its input slice. It adds no body copy and leaves request framing unchanged.
The server trace verifies a presigned upload instead of a sync-server body PUT;
S3 profile contracts require no `blobStore.get` call on the sync server.

The first MinIO attempt failed during bucket creation with HTTP 503,
`XMinioServerNotInitialized`, after a successful health response. The fixture
now treats successful bucket creation as readiness and retries only that
initialization response within its setup deadline. The failed CLI artifact is
retained as `bench/results/blob-file-minio-smoke-2026-09-10.json`.
These retries occur before client operation timers. No production retry policy
changed.

Both cores completed one 500,000,000-byte smoke attempt against the same pinned
service and seed-zero fixture, with one seeded task and SQLite server storage
on macOS arm64. Every digest matched §9.2. These uncalibrated
samples establish executable coverage; they support no optimization decision
or product comparison.

| Core | Source read (ms) | Durable stage (ms) | Upload + metadata acceptance (ms) | Fresh download (ms) | Cache hit (ms) | Reopened hit (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| TS/Bun | 46.35 | 1,352.16 | 2,149.24 | 2,114.16 | 248.16 | 306.55 |
| Rust/release | 58.61 | 1,752.81 | 1,332.08 | 3,141.09 | 633.84 | 898.60 |

Artifacts retain revision `54530a16ab01a2d7988ad6ead9af2c878b42826a` plus the
private harness diff, file hashes, runtime/binary metadata, and raw measurements:

- `bench/results/blob-file-minio-ts-500mb-smoke-2026-09-10.json`
- `bench/results/blob-file-minio-rust-500mb-smoke-2026-09-10.json`

Fresh-download receipts crossed stdio in 2,006 bytes for TS and 704 bytes for
Rust. TS writer/reader/reopened-reader process peaks were 2,820,014,080 /
3,439,673,344 / 1,553,350,656 bytes. Rust peaks were 1,510,768,640 /
2,512,781,312 / 2,008,367,104 bytes. These OS resource counters include each
process's complete lifetime and harness validation; the reader includes both
fresh download and cache hit. They do not isolate allocation sites or prove
that a specific copy causes the peak.

SQLite/WAL/SHM snapshots report logical and filesystem allocated sizes at stage,
upload, and download boundaries. Server RSS and Docker storage/network/memory
metrics are final snapshots. Peak disk usage and peak server/container memory
remain unmeasured. Upload plus metadata acceptance currently shares one public
sync timer, with nested transport method intervals. Complete phase attribution,
meter on/off calibration, A/A noise measurements, and repeated paired trials
remain before selecting production optimizations.

All 19 blob contracts pass with real MinIO and the release Rust executable
(1,705 assertions), covering existing engine/socket/direct/command/FFI paths
alongside the file profiles. The private Rust crate's 11 tests and Clippy pass.
`bun run check` passes 1,726 main tests (45 explicit skips), 13 isolated tests,
typecheck, lint/format, knip, and both Node runtime contracts.
No production client implementation changed.

### 9.4 Calibration protocol, declared before collection

The file profile adds `--blob-diagnostics on|off` (default on). Off mode removes
TS client database/SQL/blob method proxies and Rust per-blob transport timing,
byte counts, and request records. Both modes retain the shipping client APIs,
full digest checks, public operation timers, sync-protocol bookkeeping, and
fixed server instrumentation. This measures the overhead of those client
diagnostics; it does not claim an entirely uninstrumented application build.
Tests require identical full-file receipts in both modes and empty diagnostic
collections in off mode.

Freeze the validated checkout and release executable before collection.
Use SQLite server storage, one seeded task, persistent WAL/FULL clients, the
pinned MinIO service, and seed-zero files at 65,536 and 500,000,000 bytes.
Run ten blocks for each core and size. Each block has three fresh attempts:
A1 and A2 disable diagnostics; B enables them. Rotate these six orders:
`A1 A2 B`, `A2 B A1`, `B A1 A2`, `B A2 A1`, `A2 A1 B`, `A1 B A2`.
Ten blocks balance A1/A2 order five times each. Reverse core and size traversal
on alternate blocks. Run serially, with no concurrent builds or test suites.
This is 120 attempts across four core/size groups.

Compare A2/A1 for A/A variation. Compare B with the geometric mean of A1 and
A2 from the same block for diagnostic overhead, resampling whole blocks.
`pairedEffects` reports the geometric-mean ratio change and a 95% percentile
bootstrap interval from 10,000 resamples with seed 20260910, plus medians and
ranges. Positive changes mean increased cost. The empirical 95th percentile
of absolute A1/A2 differences is the initial absolute noise floor for the
corresponding metric; ten pairs make this a conservative observed maximum.
Retain every raw attempt and failure. A failed block makes that group incomplete;
do not replace failures or silently remove them from the declared collection.

Primary observations are fresh-download time at 500 MB for each core. Report
staging, upload-plus-metadata acceptance, cache hit, reopened hit, process CPU,
and peak RSS as diagnostic observations. The 64 KiB profile checks overhead
that fixed recording costs can obscure in the large profile. This calibration
does not retain a production optimization. Subsequent candidate experiments
still require their declared thresholds and an independent repeat of a win.

### 9.5 Calibration results, 2026-09-10

All 120 predeclared attempts completed between 21:15:14 and 21:32:02 UTC.
The collection used commit `6d6de24a2ae2e150ec80bf8dcb28bfa89c321cec`, source
fingerprint `8aa4ae6f9edbcf72054f4120aaf09d269abb30b78a571252669f2d9d894f5ee4`,
and release binary SHA-256
`d128b1f9de065eb01726db1dad10c25262bcb6b0187bed03621d43cc2ec8ffcc`.
Every artifact had the same source fingerprint and clean source status.
The analysis verified each raw artifact's SHA-256, runtime controls, release
binary, fixture digest, object-store length, and all four phase receipts.
All 120 MinIO container identities were distinct; cleanup left no containers
from this collection. No separate build or test suite ran concurrently with
collection; the CLI verified its already-built release executable before each
Rust attempt.

The two primary measurements are fresh-download time at 500 MB. The off baseline
below is the median of the ten block-level geometric means of A1 and A2.
The percentage effect compares diagnostics on with that baseline, as declared.

| Core | Off baseline (ms) | Diagnostics-on change | 95% paired bootstrap interval | A/A absolute noise floor (ms) |
| --- | ---: | ---: | --- | ---: |
| TS/Bun | 2,051.86 | −3.17% | −9.69% to +3.88% | 375.36 |
| Rust/release | 3,270.62 | −4.05% | −8.01% to +0.16% | 888.97 |

Both primary intervals include zero. This collection cannot distinguish client
diagnostic overhead from variation in fresh-download time. The observed absolute
noise floors correspond to about 18.3% and 27.2% of those baselines. A 5% point
estimate alone cannot qualify a latency optimization under §7 on this profile.

Other A/A floors, in milliseconds, are:

| Core / size | Stage | Upload + metadata acceptance | Fresh download | Cache hit |
| --- | ---: | ---: | ---: | ---: |
| TS / 64 KiB | 0.496 | 13.313 | 3.267 | 0.166 |
| Rust / 64 KiB | 0.461 | 53.357 | 10.705 | 0.097 |
| TS / 500 MB | 798.39 | 574.81 | 375.36 | 160.21 |
| Rust / 500 MB | 875.69 | 747.06 | 888.97 | 247.77 |

Some secondary unchanged-control intervals excluded zero. For example, the
64 KiB Rust upload-plus-commit A2/A1 effect was −26.60% (−45.10% to −5.16%)
despite identical code and diagnostic settings. This is evidence against using
one interval or point estimate as sufficient proof on this host. The collection
does not establish the source of that variation. Keep the absolute-noise
criterion and independent replication requirement. Do not select a favorable
secondary metric after observing a candidate.

For 500 MB reader process CPU, the A/A absolute floors were 230.34 ms (TS) and
946.45 ms (Rust). Reader peak-RSS floors were 493,715,456 and 503,234,560 bytes.
These retain the whole-process scope from §9.3, including verification and cache
hits. They cannot attribute a saving to one phase. Finer process/phase CPU or
allocation measurements need a separately declared calibration before becoming
a candidate's primary metric.

Use diagnostics off for candidate operation timings and a separate diagnostics-on
pass for attribution. No production optimization is retained by this experiment.
Proceed with deterministic R1/R2 failure reproductions; qualify reliability fixes
through those tests and report measured performance costs with these limitations.

The local evidence directory is `bench/results/blob-calibration-v1/`:

- `collect.py` and `collection.json`: executable schedule, frozen revision/binary,
  all 120 commands, statuses, and artifact hashes.
- Individual `*-block-*-*.json` files: standard benchmark artifacts and receipts.
- `analyze.mjs` and `summary.json`: provenance checks and all paired summaries;
  the summary records the analysis script hash and the statistical method.
- `commands.log`: complete CLI output, including build verification and failures
  (none in this collection).

The diagnostic controls and statistical helper passed 25 targeted tests
(1,857 assertions), including real MinIO, both cores, and known binomial
bootstrap quantiles. `bun run check` passed 1,729 main tests (48 explicit skips),
13 isolated tests, typecheck, lint/format, knip, and both Node runtime contracts.
The private Rust crate's 11 unit tests and Clippy passed. The checkout remained
frozen throughout measurement and analysis.


### 9.6 R1 protocol and baseline reproduction, 2026-09-10

Hypothesis: Rust stages the body and upload pin in separate autocommit
transactions. A pin-statement or commit failure therefore leaves the first
body write durable. TS already groups both statements in one transaction.
The candidate will group only these Rust staging statements and propagate
begin/write/commit failures through the existing error surface.

Before the production edit, nine shared conformance scenarios inject real
SQLite body, pin, and deferred-constraint commit failures against absent,
cached, and pinned bytes. TS passes all nine. Rust passes the three body
failures and fails all six pin/commit cases: a new body survives without its
pin, or a duplicate body's last-used timestamp changes despite rejection.
The harness installs faults through its owned connection; no production
command accepts fault setup. Native file-reopen coverage separately checks
durable state and retries. It fails against baseline with an orphan body
persisted after the pin error. The candidate passes all nine native cases and
all 38 blob conformance cases across both cores, including 18 injected-failure
cases. The production edit adds one transaction around the two Rust statements;
TS already satisfies the contract. Failed commits roll back trigger writes,
and retries preserve deduplication and the pending pin above the cache cap.

Baseline and candidate failure logs are retained alongside the binaries. The
candidate release SHA-256 is
`8ee273ba1b73cb14387adce54818fbf70ed5b0b11a981cb7cc0a506e22d8660f`.

The baseline release binary is preserved at
`bench/results/blob-r1-v1/baseline-syncular-bench`, SHA-256
`d128b1f9de065eb01726db1dad10c25262bcb6b0187bed03621d43cc2ec8ffcc`.
The R1 comparison will use the existing isolated file/MinIO harness with
instrumentation off, WAL/FULL, one linked task, seed-0 fixtures of 65,536 and
500,000,000 bytes, and full digest verification. Collect ten paired trials per
size, alternating baseline/candidate order and size traversal each block.
Use the same harness for both binaries, with no concurrent builds/tests.
Primary cost metric: native staging elapsed time. Secondary checks:
upload-and-commit, fresh download, cache hit, writer lifetime CPU/RSS, and
durable SQLite state. Use §9.5 A/A floors and the declared paired 95% interval;
investigate costs above 10% before retention. Reliability is the qualifying
outcome; this comparison does not establish a performance gain. If claiming
a performance gain later, repeat independently under §6's retention rules.
Raw commands, artifacts, binary hashes, source diff, and analysis will remain
under `bench/results/blob-r1-v1/`.


The first R1 collection completed 40/40 attempts with full validation between
2026-09-10 21:52:32 and 22:00:50 UTC. No observation is excluded. Its 500 MB
staging ratio estimate is +5.77%, with a 95% interval [-11.25%, +28.75%].
The 64 KiB upload-and-commit, download, and writer lifetime CPU estimates are
+15.77%, +10.26%, and +12.61%; their intervals include zero and their paired
absolute p95 differences (30.70 ms, 2.43 ms, 7.04 ms) are below the corresponding
A/A floors (53.36 ms, 10.70 ms, 9.84 ms). Reader peak RSS at 500 MB shifts
+8.57% [3.93%, 13.55%], while its paired absolute p95 difference (454,017,024
bytes) is below the A/A floor (503,234,560 bytes). R1 changes only writer
staging; these observations do not establish a reader-path mechanism.

The 500 MB stage/upload/CPU pairs include variation above calibration. The
staging pairs in blocks 3 and 5 favor baseline by 1.96 s and 1.53 s, while
other pairs favor candidate. The interval cannot exclude a material staging
cost. Before deciding retention, collect an independent repeat at
`bench/results/blob-r1-v1-repeat/`: the same two binary hashes, diagnostics
off, fixtures, WAL/FULL, MinIO image, ten paired trials per size, and
alternating order. Preserve every observation and report the repeat separately;
do not pool it with the first collection or change the primary metric.
This repeat investigates the unresolved cost; it does not qualify a speedup.


### 9.7 R1 retention and unresolved performance cost, 2026-09-11

Retain R1 for reliability. The baseline body/pin split violates §5.9.7:
injected pin and commit failures persist a new unpinned body or change existing
body metadata despite rejecting the call. The candidate's single transaction
preserves the complete pre-call state, survives a database close/reopen, and
allows a successful deduplicated retry. TS already implements this transaction;
the shared catalog now enforces it in both cores.

**Accepted tradeoff:** atomic staging is a required storage guarantee, and the
failure reproduction establishes that the previous implementation lacks it.
The elapsed-time cost remains uncertain. Retention accepts that uncertainty,
including the material secondary regressions observed in the repeat below.
R1 is not a speedup, is not established as performance-neutral, and does not
satisfy the performance retention gate. Further phase attribution remains open;
subsequent performance candidates must meet their own gate.

Both collections completed 40/40 attempts with no exclusions, distinct MinIO
containers, identical binary hashes, seed-0 fixtures, WAL/FULL clients, and full
hash/commit/cache/restart validation. The repeat ran from 2026-09-10 22:02:51 to
22:13:46 UTC. Both collections used Apple M4, Darwin 27.0.0, Bun 1.4.0, and
native SQLite 3.46.0. A host snapshot during the repeat reports 24 GiB total
memory and 37% system-wide free memory; it cannot attribute an earlier or
individual operation's memory pressure.

The primary metric is native staging time. Medians are in milliseconds; effects
are geometric means of paired candidate/baseline ratios with the predeclared
95% bootstrap interval. A ratio estimate is not the ratio of the two medians.

| Collection | Bytes | Baseline median | Candidate median | Paired change | 95% interval |
| --- | ---: | ---: | ---: | ---: | --- |
| First | 65,536 | 0.376 | 0.361 | -12.35% | [-27.72%, +2.65%] |
| Repeat | 65,536 | 0.433 | 0.351 | -17.17% | [-36.66%, +11.08%] |
| First | 500,000,000 | 2,301.43 | 2,159.61 | +5.77% | [-11.25%, +28.75%] |
| Repeat | 500,000,000 | 2,375.03 | 2,831.31 | +6.57% | [-14.61%, +32.77%] |

The small-file secondary cost signals from §9.6 do not recur in the repeat:
upload-and-commit changes -14.70% [-31.78%, +6.87%], download changes -32.50%
[-63.96%, +14.72%], and writer lifetime CPU changes -0.05% [-8.07%, +9.59%].
Every interval includes zero. At 500 MB, the secondary results remain unresolved:

| Metric | First collection: change [95% interval] | Repeat: change [95% interval] |
| --- | --- | --- |
| Upload-and-commit elapsed | +1.34% [-12.74%, +21.00%] | +36.31% [+2.28%, +90.58%] |
| Fresh download elapsed | -3.61% [-9.44%, +2.24%] | +29.80% [+4.97%, +69.70%] |
| Writer lifetime CPU | +3.23% [-5.36%, +14.73%] | +1.83% [-6.46%, +11.88%] |
| Reader lifetime peak RSS | +8.57% [+3.93%, +13.55%] | -3.77% [-9.83%, +2.09%] |

The repeat's positive upload/download intervals require investigation; the
first collection does not establish the same effect. The largest repeat
slowdowns occur in blocks 4, 7, and 9. For example, block 4 candidate takes
9,396 ms for upload-and-commit versus 2,465 ms for baseline, and MinIO's final
block-read counter is 410 MB versus 225 kB. Block 7 candidate takes 14,310 ms
for download versus 4,538 ms for baseline, while reader lifetime CPU is
14,689 ms versus 10,348 ms. These observations cover different measurement
boundaries and cannot identify the cause. The production edit touches writer
staging only; no measured phase attribution yet connects it to those later
slowdowns. Do not discard these trials or explain all of the difference as
MinIO, memory pressure, or measurement noise without additional evidence.

Raw artifacts, scripts, source patches, binary hashes, and separate summaries:
`bench/results/blob-r1-v1/` and `bench/results/blob-r1-v1-repeat/`. Each analyzer
verifies all artifact hashes, controls, fixtures, phase digests, SQLite
configuration, original commit outcomes, and container isolation before
computing effects. The original records remain unchanged; no pooled estimate
replaces either collection. Both collections removed all their containers and
temporary client databases.

Validation: `bun run check` passes 1,859 main tests (47 explicit skips), 13
isolated tests, typecheck, lint/format, knip, and Node client/server runtime
contracts. Rust workspace tests, Clippy with warnings denied, and seven native
transport round tests pass. All 38 blob conformance cases pass across TS and
Rust; the 18 new failure cases also pass after the final driver-recreation
check. Swift, React Native, and Tauri gates pass. Kotlin and Flutter verify
generated-schema freshness but skip runtime tests because this host lacks a
working JDK and Dart SDK. Browser OPFS, device builds, and those skipped binding
runtimes were not measured by R1.

### 9.8 R2 failure reproduction and candidate, 2026-09-11

The initial R2 matrix injects seven faults with the remote object absent and
already present: missing local body, wrong body type, incorrect length,
incorrect SHA-256, invalid upload metadata, SQL body-read failure, and SQL
upload-pin deletion failure. Before the production edit, TS passes the four
read/deletion cases and fails the other ten; Rust fails all fourteen. The
baseline log is `bench/results/blob-r2-v1/baseline.log`. Missing bodies can drain
the original pending commit. An already-present upload grant also bypasses
validation of corrupt cached bytes in both cores.

The candidate validates queued body type, length, and SHA-256 before requesting
an upload grant. Missing or corrupt data returns client-local
`sync.local_corrupt`. Rust collects pending-row errors and propagates body-read
and pin-deletion failures, preserving the affected pin and original commit.
Both cores now derive a durable `(commit_id, blob_id)` dependency table from the
outbox. Outbox and cache triggers maintain it in the same transaction as commit
insertion, removal, operation replacement, and a body arriving after the
commit. Startup recreates the schema-specific triggers and backfills existing
pending work. Upload-queue removal therefore records successful byte delivery
without releasing the body needed by an unacknowledged commit.

The extra full-body hash has an expected CPU and allocation cost, particularly
TS's current hashing copy. R2 is a correctness candidate pending validation and
cost measurement, not a retained optimization. Preserve the R1 release binary
as the native baseline (SHA-256
`8ee273ba1b73cb14387adce54818fbf70ed5b0b11a981cb7cc0a506e22d8660f`)
and use frozen TS source for the paired comparison before editing later copy
optimizations. Declare the measurement protocol before collecting candidate
costs; report the hash/copy cost explicitly instead of folding it into P1.

R2's initial candidate passes all 28 corruption/storage scenarios and the
existing 38 blob scenarios. Seven native file-reopen cases preserve upload
pins and original commit IDs, then upload repaired bytes while keeping the
metadata commit pending. Metadata validation runs over the complete pending
list before either core starts transfers; body validation runs in upload order.

The subsequent prefix audit exposes an additional B4 failure in both cores.
One commit references two staged bodies. The first uploads successfully and
its upload-queue entry is deleted; the second is corrupt and fails the round.
Staging a third body above a one-byte cache cap then evicts the first body,
even though the original commit still depends on it. Its cached refcount is
zero and its upload pin has been removed. The shared
`blobs/upload-prefix-body-failure` scenario now fails with an actual missing
body after trim. The metadata-failure prefix case passes: no transfer starts,
so both upload pins still protect their bodies. The fixture pins client time
to the server clock so upload-grant expiry does not obscure the intended path.

This reproduction justifies explicit commit-dependent body protection.
Refreshing only visible-row refcounts would leave the case where a later
optimistic edit hides an earlier pending commit's reference unresolved. The
implemented dependency table preserves that earlier reference. Five additional
shared scenarios cover lost acknowledgements, restart backfill, shadowed
optimistic references, references to a server-resident body absent from the
local cache, shared references across rejection, and revocation of a doomed
commit. Terminal acknowledgement, rejection, and revocation remove the commit
dependency. A sibling pending commit or live row continues to protect the same
body.

The latest focused run passes all 80 blob cases across TS and Rust: 40 catalog
scenarios per core, including 42 R2 cases across the two cores. The Rust
conformance recreation path initially skipped bookkeeping migrations and failed
restart backfill; it now invokes the same bookkeeping setup as a file reopen.
The seven native file-reopen cases still pass. The full repository gate remains
to run after measurement.

The cost collection uses the R1 result as its baseline. Rust uses the retained
R1 release executable with SHA-256
`8ee273ba1b73cb14387adce54818fbf70ed5b0b11a981cb7cc0a506e22d8660f`;
TS uses an installed source snapshot at commit `32dc1f5a`. The candidate Rust
release executable has SHA-256
`14c82aa993cf2f4ad256553c7141e27f4f740f7a79cd660df0d7ac86c0e69aa5`;
the collection manifest records the final candidate source diff and every
tracked source hash.

Collect ten paired blocks for each core at 65,536 and 500,000,000 bytes. Each
block runs baseline and candidate once, alternates their order, and reverses
size and core traversal on alternating blocks. Run serially with diagnostics
off, SQLite server storage, persistent WAL/FULL client databases, one linked
attachment, the pinned MinIO service, seed-zero fixtures, and full independent
hash verification. Preserve every attempt and stop on failure. This produces
80 attempts.

The primary metric is upload-plus-metadata-acceptance time, because R2 adds the
validation hash immediately before transport. Report stage and fresh-download
time as unchanged controls; report writer CPU, peak RSS, and durable SQLite
sizes as secondary observations. Compare paired candidate/baseline geometric
mean ratios with a 95% percentile bootstrap interval over the ten blocks using
10,000 resamples and seed 20260910. Report the paired absolute p95 difference
beside the §9.5 A/A floor. Investigate an upload-time cost above 10%. The fault
matrix qualifies the reliability repair; this collection measures its accepted
cost and cannot qualify a speedup without an independent repeat.

The collection completed all 80 attempts between 2026-09-10 22:47:24 and
22:58:14 UTC with no failures or exclusions. Every attempt used a distinct
MinIO container and verified the fixture, stored object, downloaded body, cache
hit, reopened cache hit, and accepted metadata commit. The candidate source
diff SHA-256 is
`e186da1cc0c56c47c39d96011138fe7958918a587a2cbb5b4bd5d57b684de528`.
All runs used Apple M4, Darwin 27.0.0, Bun 1.4.0, TS SQLite 3.54.0, and Rust
SQLite 3.46.0.

The primary 500 MB results are:

| Core | Baseline median | Candidate median | Paired change | 95% interval | Paired absolute p95 | §9.5 A/A floor |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| TS/Bun | 1,582.48 ms | 1,850.79 ms | +11.67% | [+2.47%, +19.49%] | 424.97 ms | 574.81 ms |
| Rust/release | 1,359.30 ms | 2,227.94 ms | +67.79% | [+57.90%, +79.69%] | 2,193.38 ms | 747.06 ms |

The TS absolute p95 remains below the earlier A/A floor, while its paired
interval excludes zero. The Rust effect exceeds both the 10% investigation
threshold and the A/A floor. Rust writer CPU increases 32.31% [26.71%, 39.40%]
with an 844.85 ms median absolute paired difference. Its writer peak RSS changes
+0.007% [-0.005%, +0.015%]. TS writer CPU increases 9.64% [6.24%, 12.67%];
writer peak RSS changes +10.72% [-0.11%, +22.08%], with a 499,761,152-byte
median absolute paired difference. Process RSS covers the complete writer
lifetime and does not isolate the verification hash.

The unchanged staging controls include zero in both 500 MB intervals: -3.60%
[-8.56%, +0.31%] for TS and +5.24% [-2.64%, +15.48%] for Rust. Fresh download
changes -0.42% [-12.98%, +13.09%] for TS and -8.76% [-15.13%, -2.51%] for
Rust. R2 does not change the reader path, so the Rust download result is an
unattributed control movement rather than a claimed improvement.

At 64 KiB, upload plus commit changes -7.89% [-23.22%, +12.33%] for TS and
+14.55% [+1.54%, +28.89%] for Rust. The absolute p95 differences are 8.92 ms
and 4.33 ms, below the §9.5 A/A floors of 13.31 ms and 53.36 ms.

Retain R2 for reliability. The baseline can delete or evict bytes still needed
by a durable commit, silently discard missing queued bodies, skip corrupt bytes
when the server reports the object present, and ignore Rust storage failures.
The deterministic failure matrix and restart cases prove those defects. The
full-body verification cost is accepted and is not a performance improvement.
P1 and P5 may reduce copying or hash/I/O cost under their own measurement gates;
they must preserve R2's failure behavior and commit-pin lifetime.

The frozen analyzer initially assumed SQLite 3.46.0 for both cores and stopped
before computing results. `analyze-v1.mjs` preserves that script byte-for-byte.
The corrected analyzer accepts the versions recorded consistently by all
attempts, verifies the original frozen script hash, and records its own hash in
`summary.json`. Raw attempts, commands, manifests, executables, source patch,
and both analyzers are under `bench/results/blob-r2-v1/`.

`bun run check` passes 1,907 main tests (46 explicit skips), 13 isolated
multi-tab tests, typecheck, lint/format, knip, and both Node runtime contracts.
The Rust workspace passes 142 unit/integration tests plus doc tests, formatting,
and Clippy with warnings denied. Tauri, React Native, and Swift binding gates
pass. Kotlin and Flutter verify generated-schema freshness but skip runtime
tests because this host lacks a working JDK and Dart SDK. R2 is retained.

### 9.9 P1 exact-view hashing and owned staging snapshot, 2026-09-11

The baseline hashes `bytes.slice().buffer`, then awaits WebCrypto before it
inserts the caller's original view into SQLite. A caller can mutate that view
after `uploadBlob` returns its promise and before the insert resumes. The stored
body can then differ from the content address. The shared reproduction uses a
nonzero-offset view, starts staging, overwrites the view immediately, and
requires the returned reference to match the call-time bytes. Rust passes
because its synchronous core and command conversion consume the input before
returning. TS fails before the candidate.

The candidate copies the exact TS input view synchronously at the public method
boundary and uses that owned array for hashing, persistence, length, and the
returned reference. `computeBlobId` passes an exact ArrayBuffer-backed view to
WebCrypto without cloning its body; SharedArrayBuffer-backed input retains a
copy because WebCrypto does not accept shared memory. R2 verification and
download validation operate on client-owned arrays and avoid their previous
full-body clone.

Compare commit `a03ffe32` with the candidate in ten paired blocks at 65,536 and
500,000,000 bytes using the R2 TS file/MinIO controls. Alternate arm order and
size traversal, disable diagnostics, preserve every attempt, and verify the
same fixture, stored object, accepted commit, download, cache hit, reopen, and
SHA-256 receipts. The primary metric is 500 MB upload plus commit time. Stage
time, fresh download, writer CPU, and writer peak RSS are secondary. Use the
same paired estimator, bootstrap seed, §9.5 A/A floors, and two-gate retention
rule. A retained performance result requires a second independent collection.

The baseline TS client fails the shared reproduction: immediate caller mutation
changes the returned SHA-256 from the call-time bytes to the overwritten bytes.
Mutation after hashing can also change the later SQLite insert independently.
The candidate and Rust return the reference for the exact call-time view. All
82 focused blob cases pass across both cores.

Both independent collections completed 40/40 attempts with no failures or
exclusions. The first ran from 2026-09-10 23:07:56 to 23:11:38 UTC; the repeat
ran from 23:12:02 to 23:15:40 UTC. Both used commit `a03ffe32`, candidate diff
SHA-256
`fa1244c7fe93312c9549529e27dc15d18fde30b22f8193a009ebc8dadd3ac2bb`,
Apple M4, Darwin 27.0.0, Bun 1.4.0, SQLite 3.54.0, WAL/FULL, and distinct pinned
MinIO containers. All 80 attempts validated the complete lifecycle receipts.

| Collection | Baseline median | Candidate median | Paired change | 95% interval | Absolute p95 |
| --- | ---: | ---: | ---: | --- | ---: |
| First | 1,989.36 ms | 1,796.93 ms | -8.50% | [-15.59%, +0.03%] | 525.36 ms |
| Repeat | 1,916.67 ms | 1,821.09 ms | -12.20% | [-17.28%, -6.22%] | 494.24 ms |

Neither collection qualifies an upload-latency improvement. The first interval
includes no improvement, and both absolute p95 benefits remain below the §9.5
574.81 ms A/A floor. Writer CPU changes -4.97% [-6.75%, -2.89%] in the first
collection and -2.75% [-3.86%, -1.73%] in the repeat. The first writer peak RSS
result is -15.04% [-18.70%, -12.32%], but the repeat is -8.20% [-16.12%,
+0.93%]. The memory interval does not exclude no improvement in the repeat.

Staging is an unchanged control because P1 moves the required ownership copy
from hashing to the public method boundary. Its 500 MB effects are -1.34%
[-11.62%, +8.40%] and +4.45% [-0.72%, +10.46%]. Fresh download moves -6.63%
[-12.42%, -1.95%] and -8.18% [-13.08%, -3.53%], but both absolute p95 changes
exceed the 375.36 ms download A/A floor and P1 changes validation on that path.
The inconsistent cache-hit movement prevents attributing the full reader result
to the removed validation copy.

Retain P1 for reliability. The baseline violates call-time byte ownership and
can associate persisted bytes with the wrong content address. The candidate
uses one owned staging snapshot and removes the otherwise redundant hash copy
for client-owned arrays. The two collections show no material regression, but
they do not qualify a performance claim. Raw evidence is under
`bench/results/blob-p1-v1/` and `bench/results/blob-p1-v1-repeat/`.

`bun run check` passes 1,909 main tests (46 explicit skips), 13 isolated
multi-tab tests, typecheck, lint/format, knip, and both Node SQLite runtime
contracts.

### 9.10 P2 downloaded-byte reuse protocol, 2026-09-11

The fresh-download path currently verifies the transport-owned body, inserts
it into SQLite, then selects the body back from SQLite before returning. The
last query materializes the complete body a second time. P2 will take one owned
snapshot of the downloaded body and retain it through verification, cache
insertion, refcount reconciliation, and cap enforcement. A metadata-only query
must prove that the durable cache row still exists and return its stored length
and media type before the method returns the owned body. The Rust transport
already returns an owned byte vector. The Rust compatibility command will
continue to encode the same JSON byte shape; P3 owns changes below that
serializer.

Before measurement, add shared cases for simultaneous fresh fetches, a
referenced body larger than the configured cap, and an injected cache-insert
failure after download. Direct cache tests must preserve the stored metadata
when duplicate content arrives with different caller metadata. Returned bytes
must remain valid after later database queries and client close. Existing
authorization, hash-mismatch, presigned-download recovery, refcount, eviction,
and restart cases remain required.

Compare commit `a5ba2300` with one P2 production diff in ten paired blocks for
each core at 65,536 and 500,000,000 bytes. Each block runs baseline and
candidate once, alternates arm order, and reverses core and size traversal on
alternate blocks. Use diagnostics off, SQLite server storage, persistent
WAL/FULL client databases, a distinct pinned MinIO container per attempt, and
the existing complete lifecycle receipts. Preserve every attempt and stop on
failure. The primary metric is 500 MB fresh-download operation time. Report
reader CPU and peak RSS as secondary observations. Stage, upload plus commit,
cache hit, reopened hit, filesystem allocation, and server metrics are
unchanged controls. Use the §9.5 paired estimator, bootstrap seed, A/A floors,
and two-gate retention rule. Repeat the complete collection independently when
the first collection qualifies.

The collection completed all 80 attempts between 2026-09-10 23:27:59 and
23:38:31 UTC with no failures or exclusions. Every attempt used a distinct
MinIO container and verified the fixture, stored object, accepted commit,
download, cache hit, reopened cache hit, and SHA-256 receipts. The baseline was
commit `a5ba2300`; its Rust source matches the R2 candidate executable exactly.
The candidate diff SHA-256 was
`4f36f863260de3ec2824adddf9873bc55c91d040a38435dbd4fdcb49d3ade90d`.
The baseline and candidate Rust executable SHA-256 values were
`14c82aa993cf2f4ad256553c7141e27f4f740f7a79cd660df0d7ac86c0e69aa5` and
`18ff8ea2b18240ec04d9df338d76b826c6a61fb1cf7997f0efed60bdac349244`.

| Core | Baseline median | Candidate median | Paired change | 95% interval | Absolute p95 | §9.5 A/A floor |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| TS/Bun | 1,848.59 ms | 1,883.64 ms | +2.49% | [-6.98%, +9.49%] | 792.88 ms | 375.36 ms |
| Rust/release | 2,872.17 ms | 2,709.14 ms | -0.49% | [-7.36%, +10.42%] | 1,537.08 ms | 888.97 ms |

Both primary intervals include zero. The absolute paired variation exceeds the
earlier A/A floors, but neither core establishes an improvement direction. TS
reader CPU changes +1.51% [-5.25%, +7.23%], and Rust reader CPU changes -1.13%
[-4.97%, +3.01%]. TS reader peak RSS changes +7.25% [-0.45%, +16.11%]; Rust
changes +0.79% [-2.90%, +6.13%]. The complete TS process still owns one
500 MB result snapshot, and the Rust compatibility command still performs its
hex serialization. Removing the SQL body readback does not reduce either
measured process peak.

All 500 MB unchanged-control intervals include zero. TS staging changes +0.06%,
upload plus commit -4.06%, cache hit -1.44%, and reopened hit +4.55%. Rust
staging changes -0.64%, upload plus commit -2.26%, cache hit +1.95%, and
reopened hit +0.85%. The 64 KiB fresh-download intervals also include zero for
both cores.

Discard P2 and do not run a repeat. The candidate preserves behavior but does
not prove a fresh-download improvement. The production paths continue to read
the cached body from SQLite before returning. Retain the three shared scenarios
for duplicate metadata, simultaneous fresh fetches, and cache-insert failure,
plus the TS result-ownership test. The baseline and candidate both pass all 88
focused blob cases across the two cores. Raw evidence is under
`bench/results/blob-p2-v1/`.

`bun run check` passes 1,916 main tests (46 explicit skips), 13 isolated
multi-tab tests, typecheck, lint/format, knip, and both Node SQLite runtime
contracts. The Rust client passes 66 unit tests and 6 integration tests;
`cargo fmt --check` and clippy with warnings denied also pass.

### 9.11 P3 typed Rust result protocol, 2026-09-11

P3 will add a public Rust blob result whose byte field is an owned `Vec<u8>`
and a `fetch_blob_bytes` method that returns it. The existing `fetch_blob`
method will remain source compatible and return the same JSON value. The
shared `fetchBlob` command and C ABI will keep their current JSON envelope,
lowercase hexadecimal byte encoding, error codes, and ownership rules. The
typed method will use the same authorization, download, hash validation,
SQLite insertion, refcount reconciliation, cap enforcement, and cache-hit
path as the compatibility method.

The Rust file-profile direct lane will time `fetch_blob_bytes` and validate
the owned bytes after its operation clock. Add an explicit legacy surface to
the same private command so the candidate can time `fetch_blob` without
sending the body through stdio. The lifecycle profile will continue to time
the shared command router and real C ABI, including their existing delivery
fields. Tests must prove that typed and JSON results agree for cache misses,
cache hits, metadata, and errors, and that the typed bytes survive later
queries and client destruction.

Compare commit `cb7cce17` with one P3 production diff in ten paired blocks for
each 65,536-byte and 500,000,000-byte file-profile case. Run baseline legacy,
candidate typed, and candidate legacy in rotating order with a distinct pinned
MinIO container for every attempt. The primary metric is the 500 MB candidate
typed result against the baseline public result. Candidate legacy is the
compatibility control. Use diagnostics off and retain the §9.5 estimator,
bootstrap seed, noise floors, receipts, durability settings, and stop rules.
The typed result qualifies only when its primary interval excludes zero in the
improvement direction, exceeds the Rust 500 MB A/A floor, and the candidate
legacy control establishes no material regression. Repeat the complete
collection independently when those gates pass.

Measure direct typed, shared command, and C ABI delivery at the lifecycle
profile's 16 MiB limit in a separate ten-block collection. Record operation
time, delivery time, CPU, peak RSS, and the C ABI request serialization,
exported call, response copy, free, and parse fields. These results describe
the cost that remains for compatibility consumers. Add no binary C ABI in P3;
the evidence must first show that its avoided encoding and delivery cost pays
for a sixth allocation API with explicit buffer lifetime, free, cancellation,
handle-validity, and error contracts.

The first collection completed all 60 attempts with no failures or exclusions.
Every arm used a distinct MinIO container and passed the file digest, stored
object, accepted commit, fresh download, cache hit, offline reopen, WAL/FULL,
and bounded-IPC controls. The baseline and candidate executable SHA-256 values
were `14c82aa993cf2f4ad256553c7141e27f4f740f7a79cd660df0d7ac86c0e69aa5`
and `c3c5c62f97eff5ff408c34acc5980f77aa82c0496f0cabc29bf2adf82d6f3c5a`.
The candidate diff SHA-256 was
`e45a923ef7bc5b525d1d05080414c2f9ea588ebe9fe2764e2ec8df0365b5368c`.

The 500 MB fresh-download primary does not qualify. The baseline median is
2,908.54 ms and the typed median is 2,521.98 ms; the paired change is -13.62%
with a 95% interval of [-25.81%, +3.52%]. The interval includes zero. Candidate
legacy changes -5.13% [-17.05%, +3.17%] against baseline, so the compatibility
control also includes zero.

The predeclared cache-hit secondary shows a larger result. Candidate typed is
224.08 ms versus 624.95 ms for candidate legacy, a paired change of -58.86%
[-64.26%, -48.74%]. Its median absolute saving is 389.21 ms, above the 247.77
ms Rust cache-hit A/A floor. The reopened hit changes -60.78%
[-62.24%, -58.44%]. Reader lifetime CPU changes -44.48%
[-47.79%, -39.03%], and reader peak RSS changes -39.80%
[-39.81%, -39.78%], about 1.00 GB at the median. These process totals include
the fresh download, cache hit, validation, and setup.

Treat the cache-hit result as exploratory because the fresh-download metric
was the declared retention primary. Before deciding P3, run an independent
confirmation under `bench/results/blob-p3-v1-repeat/` with the same candidate
binary, fixture, diagnostics-off setting, pinned MinIO image, WAL/FULL clients,
and full receipts. Run ten paired 500 MB blocks of candidate typed and candidate
legacy, alternating arm order. The primary metric is cache-hit operation time.
Retain P3 only if the repeat interval excludes zero in the improvement
direction and its median absolute saving exceeds the 247.77 ms A/A floor.
Report reopened-hit time and reader lifetime CPU/RSS as secondary metrics and
fresh-download time as an unchanged control. Do not pool the two collections.

The independent confirmation completed all 20 attempts with no failures or
exclusions. Typed cache hits are 223.84 ms versus 601.08 ms legacy, a paired
change of -60.29% [-62.89%, -55.29%]. The 375.13 ms median absolute saving
exceeds the 247.77 ms A/A floor. Reopened hits change -60.32%
[-62.01%, -58.12%]. Reader lifetime CPU changes -45.56%
[-47.40%, -43.36%], and peak RSS changes -39.81%, about 1.00 GB at the median.
The repeat fresh download changes -11.06% [-14.38%, -6.41%], but its 396.93 ms
median absolute saving remains below the 888.97 ms fresh-download A/A floor.
Do not claim a fresh-download latency improvement from P3.

P3 qualifies for retention on its independently confirmed cache-hit result.
The first and confirmation collections use separate containers and observations;
their cache-hit intervals both exclude zero and both median absolute savings
exceed the recorded floor. Raw evidence is under `bench/results/blob-p3-v1/`
and `bench/results/blob-p3-v1-repeat/`. Complete the declared 16 MiB lifecycle
boundary collection before the final retention commit.

The 16 MiB lifecycle collection completed all 30 attempts across direct,
command, and C ABI boundaries with no failures. The direct typed, command JSON,
and C ABI median operation times are 100.98, 113.52, and 125.72 ms for a fresh
download. Their cache-hit operation times are 7.41, 19.91, and 32.12 ms. Command
cache-hit operation time is 167.48% [156.73%, 177.86%] above direct typed, a
12.47 ms median difference attributable to the retained hexadecimal result.

The process driver encodes the typed result after its direct operation clock,
so end-to-end cache-hit delivery is 41.42 ms direct and 39.62 ms command. The
C ABI median is 59.20 ms. Its 16 MiB cache-hit response contains 33,554,581
bytes; the exported call takes 32.12 ms, host copy 1.26 ms, library free 0.53
ms, and host JSON parse 3.18 ms at the median. The C ABI reader peak RSS is
162,578,432 bytes versus 128,729,088 bytes for the command process.

Retain the typed Rust result and its benchmark surface. The independently
confirmed 500 MB cache-hit improvement applies to in-process Rust consumers
that keep the owned byte result. A host that converts the result to the JSON
driver shape still pays the encoding and delivery cost. Keep the existing C ABI
unchanged in P3. A binary C ABI requires a separate candidate with binding-level
ownership, cancellation, invalid-handle, error, and compatibility tests. Raw
lifecycle evidence is under `bench/results/blob-p3-lifecycle-v1/`.

`bun run check` passes 1,916 main tests (46 explicit skips), 13 isolated
multi-tab tests, typecheck, lint/format, knip, and both Node SQLite runtime
contracts. The Rust workspace tests, formatting, and clippy with warnings
denied pass. React Native, Swift, and Tauri binding gates pass. Kotlin and
Flutter verify their generated schemas but skip runtime tests because this host
lacks a working JDK and Dart SDK.
