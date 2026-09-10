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

Today the CLI caps sizes at 16 MiB. TS blob clients share the controller process
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

Existing commands remain valid; large sizes and new options below are future
extensions, documented only when implemented. `--storage file` continues to mean
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
| Harness and A/A | Review baseline plus private driver changes | §9.1–9.2: isolated file-input/digest-receipt contracts pass in TS and Rust; bounded 500 MB fixture independently verified; large CLI/S3 profile and A/A runs remain | In progress |
| R1/R2 | Pending | Inspected paths only; failure reproductions required | Pending |
| P1–P4 | Pending | Allocation/access hypotheses above | Pending |
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
