# RFC: Engine performance and repository-owned regression benchmarks

- Status: implementation in progress
- Date: 2026-09-07
- Review baseline: `f7b94e22764e8aec3d2528ec2858a37be65ca958` (0.16.1)
- Scope: Syncular server, TS and Rust clients, command/FFI boundary, and `bench/`

## 1. Problem and scope

The external offline-sync benchmark identifies several seconds of offline
replay, additional Rust delivery cost, and a JavaScript reconnect gap. Syncular
needs repository-owned workloads that reproduce those costs, identify their
causes, and prevent regressions after an optimization ships.

This RFC covers improvements to Syncular itself. Application index tuning,
query rewrites, changes to competing adapters, and changes to the external
campaign are excluded. The local query investigation found mismatched indexes
in the benchmark fixture; those timings do not establish an engine defect.
Local reads remain a regression workload with fixed SQL and schema.

Implement the benchmarks by extending `bench/` and the existing Rust benchmark
driver. The suite must run from a Syncular checkout without the external
benchmark repository, its generated schema, or its Docker stacks. Keep
`load/` responsible for protocol-level stability and scale verification.

## 2. Evidence and limits

The motivating evidence is the
[270-attempt report](../../sync/offline-sync-bench/results/reports/interim-2026-09-07-0270/DETAILS.md)
and its [archived artifacts](../../sync/offline-sync-bench/results/reports/interim-2026-09-07-0270/README.md).
These provenance links resolve in the maintainer's sibling checkout at
`/Users/bkniffler/GitHub/sync/offline-sync-bench`; they are not runtime dependencies.
The archive identifies campaign `campaign-2026-09-07T07-13-19-779Z`, through
2026-09-07 15:32:42.485 UTC, and source hash
`f6d23b446229ead3546f0e49c869e5150500c559446dfe349cb0e17e2cd8198b`.

The campaign runs native clients on one Apple M4 host with local loopback
networking. The snapshot contains two or three independent trials per case.
Values below are medians of successful trial values. They do not establish
production tail latency or confidence intervals. Syncular completed all 31
JavaScript and 34 Rust attempts in the snapshot.

| Workload | Syncular JS | Syncular Rust | Measurement boundary |
| --- | --- | --- | --- |
| 1,000 queued writes: reader visible | 4,673 ms | 3,881 ms | Network restoration to independent reader observation |
| 1,000 queued writes: writer drained | 5,047 ms | 3,934 ms | Network restoration to empty writer queue; extracted from raw trials |
| One update to 25 connected readers | 35.71 ms | 80.75 ms | Includes adapter and observation overhead |
| Reconnect 25 readers after 100 updates | 667.08 ms | 241.49 ms | Includes query polling and controller receipt |
| Blob download / download recovery | 42.77 / 24.72 ms | 105.92 / 99.27 ms | Includes Rust hexadecimal JSON transfer |

The [server handler](../packages/server/src/handler.ts) processes push commits
sequentially. The [push path](../packages/server/src/push.ts) opens a transaction
per commit, persists its result, commits, and awaits realtime notification.
These are confirmed execution patterns; their shares of elapsed time remain
unmeasured. In the benchmark's server configuration, pushed commits notify the
local hub. Do not attribute every push to a LISTEN/NOTIFY round trip.

The Rust external adapter performs separate command calls to read and mutate
each queued row. Downloaded bytes cross that bridge as hexadecimal JSON. These
paths add work, but the snapshot does not establish how much belongs to the
core, Syncular's shared command router, or the external controller. The
reconnect gap also lacks a confirmed cause.

### 2.1 Existing work to retain

[RFC-RELIABILITY-DX.md](./RFC-RELIABILITY-DX.md) records bounded FIFO outbox
encoding and status counts without body decoding, shipped in 0.16.1. Requests
already support 500 operations across whole commits. Extend those paths.

That RFC's in-process SQLite workload measured approximately 158 ms for 1,000
mixed-size commits and 9.7 seconds for 10,000. Complete optimistic replay remains
an identified cost at 10,000 commits. Its workload and backend differ from the
external Postgres campaign. Reproduce the same workload across lanes before
assigning the difference to storage or networking.

## 3. Contracts to preserve

[SPEC.md](./SPEC.md) remains authoritative for commit identity (§2.3),
authorization (§3), push limits (§6.1), ordering and atomicity (§6.4), conflict
resolution (§6.5), optimistic state and retry (§§7.1–7.2), local observation
(§7.5), blob lifecycle (§5.9), and realtime catch-up (§8).
[SYQL.md](./SYQL.md) remains authoritative for query semantics and lowering.

Retain individual commit IDs, FIFO order, per-commit rejection, durable results,
and independent client convergence. A rejected commit must not prevent later
independent commits from being attempted. A successful acknowledgement must
describe durable state. Pending edits retain their required optimistic visibility,
before-images, conflict handling, and rollback behavior.

The initial implementation targets internal work under the existing contracts.
A change to observable semantics requires a specification update, both cores,
and a shared conformance scenario before implementation. New wire formats,
increased push limits, a second local read store, and silent fallback paths are
outside this RFC. Changes to native byte transfer require an explicit command
or FFI compatibility design even when SSP2 remains unchanged.

## 4. Extend the existing benchmark suite

### 4.1 Ownership and entry points

| Existing component | Extension |
| --- | --- |
| [bench/src/index.ts](../bench/src/index.ts) | Select workloads and lanes, record raw samples, evaluate declared budgets, and render results |
| [bench/src/fixture.ts](../bench/src/fixture.ts) | Deterministic queue, reader, and blob fixtures with validated final state |
| [bench/src/loopback.ts](../bench/src/loopback.ts) | Full-client replay and apply measurements with memory and file-backed SQLite |
| [bench/src/pg-lane.ts](../bench/src/pg-lane.ts) | The same replay workloads against Postgres with query and transaction counters |
| [rust/crates/bench](../rust/crates/bench/Cargo.toml) | Native core measurements and separate shared-command/stdio measurements using shipping transport code |
| [load/](../load/README.md) | Retain protocol-level stress coverage; its virtual clients cannot measure local database apply cost |

Keep `bun run bench` and `bun run bench:ci` as the entry points. Add workload,
lane, and artifact-output selection to the existing runner as implementation
requires. Preserve existing invocations and document any new flags when they
ship. Add workload modules only where reusable setup or scenario complexity
requires them; do not create a second benchmark framework.

### 4.2 Measurement lanes

Use three explicitly named lanes:

1. Engine: TS client and real server exchange SSP2 through the existing
   in-process seam. Measure direct Rust operations inside the existing native
   driver with an appropriate in-process transport. Report transport differences.
2. Socket: full TS or Rust clients use shipping HTTP/WebSocket transport against
   one repository-owned server process. Exercise SQLite and opt-in Postgres.
   Use identical fixtures and commit boundaries for both clients.
3. Native boundary: run the same Rust work directly and through the shared
   command router, then include stdio or FFI delivery separately. Report each
   boundary so controller overhead does not become a core latency claim.

Rust engine replay now uses a private benchmark transport (§9.39). The public
Rust `Transport` trait is synchronous; a Bun worker owns each Rust client and
waits in a synchronous callback while the main thread runs the async server.
The shipping FFI retains its owned transport. Record private bridge overhead
and shared process resources separately from shipping socket and FFI results.
Other Rust engine workloads remain unsupported.

The existing PG lane uses Postgres storage with an in-process client/server
seam. It does not substitute for the socket lane. Reuse the repository's Hono
server wiring for the socket lane and production transport code for the native
driver. Avoid copied transport implementations.

The default suite remains self-contained with SQLite. Postgres uses the existing
`SYNCULAR_PG_URL` configuration and a dedicated test database with run-owned
partitions. An explicit request for Postgres or Rust must fail clearly when its
prerequisites are unavailable. Optional lanes in the default report must state
that they were not run. Build Rust in release mode and record the build inputs.
Cleanup must affect only the run's files, processes, and database state.

### 4.3 Workload catalog

| Workload | Full profile | Validation and metrics |
| --- | --- | --- |
| Offline replay | 2,000 seeded rows; 100, 500, 1,000, and 10,000 commits; independent-row and repeated-row variants | Queue construction, server durability, writer drain, reader visibility, encoded bodies, SQL calls, replayed rows |
| Commit boundaries | One operation per commit and mixed operation counts; 499/2/1 boundary fixture | Exact request order, commit identity, independent rejection, final state |
| Restart recovery | Persisted queue, terminated writer, fresh process and existing store | Offline reopen, preserved queue, post-restoration drain, independent reader state |
| Connected fanout | One update; 1, 5, and 25 full readers with 2,000 rows each | Per-reader and all-reader completion, apply and observation work |
| Reconnect burst | 100 missed updates; 1, 5, and 25 full readers | Catch-up bytes, decode, apply, cursor persistence, complete convergence |
| Blob lifecycle | 64 KiB, 2 MiB, and 16 MiB objects; include two distinct 2 MiB objects | Upload, fresh download, interrupted download recovery, cache hit, serialized bytes, cache validation |
| Permission purge | 2k/10k/100k rows in a revoked project; one row in a retained grant | Explicit sync completion, precise purge, reason code, persistent reopen, retained row values |
| Local read overhead | Fixed SQL/schema; primary-key and bounded-result reads at 1k/10k/100k rows | Database execution, public query/snapshot overhead, materialization, native boundary cost |

Keep initial data size independent of queued commit count. Repeated edits must
have a declared conflict policy; use absent base versions for a pure throughput
case and separate fixtures for checked-version conflicts. Do not turn queued
edits into one large application commit to improve the result.

Control disconnection with explicit gates and readiness events. The engine
replay case begins when a fully constructed offline queue becomes transport-
eligible. A socket case timestamps restoration of the connection gate. Exclude
outage waiting from replay CPU and latency metrics. Preserve interrupted and
lost-response cases as correctness checks alongside the timed workload.

Use the same SQL, parameters, schema, and indexes before and after engine changes.
The local-read lane measures Syncular's guard, snapshot, materialization, and
bridge overhead. Index construction and application query tuning are outside
its optimization scope.

### 4.4 Artifacts and comparison rules

Write versioned JSON artifacts containing revision and dirty state, workload
parameters and seed, runtime and SQLite/Postgres versions, Rust build profile,
host details, storage and transport mode, raw samples, failures, validation
digests, counters, and resource boundaries. Keep generated raw runs in a
gitignored `bench/results/` directory; document the path and artifact schema.
Redact database credentials from recorded configuration.

Keep `bench/RESULTS.md` as the curated measurement record. CI and diagnostic
selections must not overwrite it. Record public API elapsed time separately
from engine phase durations. Correlate cross-process events by request ID;
do not subtract unsynchronized process clocks or sum overlapping spans into
an invented end-to-end duration.

Run at least five independent fresh trials for local investigations and ten
for a curated baseline or optimization result. Alternate or randomize baseline
and candidate order. Separate operation percentiles within one trial from
percentiles across independent trials. Retain failed attempts without a speed
estimate. Record instrumentation overhead and keep it equivalent between versions.

## 5. Replay optimization

### 5.1 Attribute the drain

Use the existing server event seam and scoped executor instrumentation. Record
request preparation, outbox encoding, transaction acquisition, partition-lock
wait, SQL calls, durable commit, notification, response encoding, client apply,
and optimistic replay. Count commits, operations, decoded bodies, replayed rows,
SQL calls, bytes, and notifications. Keep identifiers in structured details and
exclude row payloads from operational traces.

Inspect the complete path in both cores. Distinguish encoding work already
bounded in 0.16.1 from remaining overlay replay, rollback-image reads, blob
reconciliation, and observer work. Compare identical workloads through SQLite
and Postgres before changing a shared storage interface.

### 5.2 Reduce measured work in the existing paths

First reduce redundant storage work within a commit transaction. Inspect repeated
row, scope, version, commit-log, and idempotency operations. Preserve authorization
and validation order, partition serialization, and the single push path. A change
to a shared storage contract requires SQLite, Postgres, and D1 contract coverage.

Then optimize notification or optimistic replay work if it contributes materially.
Coalesce scheduling only where receivers still observe complete ordered commits
and correct local revisions. Do not fire and forget notifications or omit required
optimistic state restoration. Selective replay requires a demonstrated affected-row
model that preserves later pending overlays, before-images, conflicts, and rollback
behavior in both cores.

Batching multiple commit transactions is a later design decision. Proceed only
if transaction boundaries dominate after the preceding reductions. Amend this RFC
and SPEC.md with savepoint, lock lifetime, rejection, durability, notification,
and interrupted-response behavior before implementing that change.

#### 5.2.1 Local successful acknowledgement transactions

The §9.31 persistent-client profile attributes 68.7% and 82.3% of TS drain time
to SQLite COMMIT calls for the two 10,000-commit patterns. Group consecutive
applied/cached acknowledgements under one local SQLite transaction in both
cores. Each rejected result ends the successful run and retains its own
transaction, because rejection restores optimistic state and exposes conflict
recovery. Other frames also end a run. A response with 500 successful results
therefore requires one acknowledgement transaction.

The local write lock lasts only for journal writes, outbox deletion, retention,
and revision persistence. TS uses one existing apply batch; Rust uses one
existing observation savepoint whose outermost release commits. Do not add
per-result savepoints or await I/O while holding the transaction. Stage enough
in-memory state to restore removed IDs in FIFO position on failure. Retain
individual outcome entries and publish one revisioned batch after durability.
A failed transaction restores the whole run; a later frame failure preserves
previously committed runs. Server transactions, notifications, and delivered row
COMMIT application remain independent.

SPEC §7.2.1 defines the shared run boundaries and observation granularity.
Conformance must exercise successful runs around a rejected result and cached
retries across restart. Per-core tests must fail a later journal insertion,
revision insertion, and transaction release, then verify complete rollback,
original retry IDs, and one publication after recovery. Compare frozen baseline
and candidate clients through the same repository socket replay harness; report
transaction counts, writer drain, and independent reader visibility.

### 5.3 Acceptance

Extend deterministic coverage for FIFO boundaries, oversized first commits,
same-row dependencies, whole-commit rejection, lost replies, restart, authorization
changes, and failures before and after durable commit. Assert request contents,
durable outcomes, and independent reader state. Shared conformance executes
against both cores.

The optimization report must identify which counted work decreased and include
both queue drain and reader visibility. An encoder-only improvement does not
complete the replay workstream if end-to-end recovery remains unexplained.

## 6. Native command and blob optimization

Extend the repository's Rust driver to measure direct read, mutate, sync, and
blob operations, then the same operations through
[syncular-command](../rust/crates/command/src/lib.rs). Time measurement loops
inside Rust to avoid one controller call per iteration. Preserve a separate
end-to-end command result so a cheaper controller does not count as a product fix.

For blobs, measure download, cache insertion, cache-hit read, hexadecimal
encoding, JSON serialization, delivery, parsing, and decoding. Verify content
hashes and cache behavior after timing. Measure allocations or copied bytes where
available, and label process RSS as a broader measurement.

Optimize repeated allocation, encoding, or copies in the shipping command, FFI,
or client code when the profiles establish the cost. If byte transport dominates,
inventory existing native byte facilities before designing a compatible extension.
Document ownership, lifetime, cancellation, and affected bindings for any native
buffer API. A private benchmark binary shortcut cannot establish a shipping gain.

The external stdio result does not establish equal cost across Swift, Kotlin,
Flutter, React Native, and Tauri. Validate affected real boundaries and record
untested ones. Preserve content-address validation, refcounts, upload pins,
revocation, and download recovery. Keep benchmark-only timing fields outside
the public command contract and SSP2 frames.

## 7. Reconnect and fanout optimization

Keep connected fanout and reconnect bursts separate. Their JS/Rust gaps have
opposite directions in the external snapshot and need independent explanations.
Use full clients with local SQLite stores in the socket lane; `load/` virtual
clients cannot establish client apply performance.

Record per-reader completion and the time until every reader converges. Separate
server catch-up, transfer, decode, SQLite apply, local observation, and controller
receipt. Observe completion through existing readiness and change surfaces where
possible, and account for observation overhead explicitly.

Optimize the dominant path through existing scheduling and transaction boundaries.
Check repeated query execution, event dispatch, database statement preparation,
and unnecessary per-frame work before adding new batching or concurrency controls.
Preserve atomic local snapshots, ordered cursors, required notifications, and
bounded memory. A receive batch must not starve local work.

Validate cancellation, disconnect during apply, restart after interruption,
scope revocation, persisted cursors, and eventual convergence. Keep connected
single-write latency and permission purge as regression workloads.

## 8. Budgets and correctness gates

The new suite first establishes a repository-owned baseline. External campaign
numbers motivate workload selection but cannot directly define thresholds for
different fixtures, transports, or machines. Freeze each baseline's configuration
and acceptance criteria before collecting candidate measurements.

For replay, investigate a reduction of at least 50% in the 1,000-commit socket
lane's drain and reader-visibility medians. Treat this as an engineering objective
pending the new baseline. Native and reconnect targets follow attribution of the
removable cost. Local-read comparisons retain identical SQL and indexes.

Investigate a median regression above 10% in bootstrap, reopen, single-write
propagation, connected fanout, or permission purge on the controlled performance
runner. Keep memory and storage growth visible. An accepted tradeoff needs an
explicit measured rationale. Preserve failures and record any revised objective
as a new experiment rather than adjusting it within a run.

Add reduced replay and observation workloads to `bench:ci` with structural
budgets first: correct request order, bounded encoded prefixes, expected work
counts, released resources, and complete convergence. Calibrate wall-clock budgets
on a pinned performance runner before enabling them there. Keep real-Postgres
measurements in an explicit integration/performance job with its prerequisites.

Correctness tests use deterministic barriers, flush helpers, and injected
failures. Timing and host-speed thresholds belong in benchmark drivers; new
unit tests must not sleep. Add tests beside changed code. Run `bun run check`
for production changes and Rust tests plus Clippy with warnings denied for Rust
changes. Include affected binding checks and explicitly enabled TS/Rust
conformance. Record environments that remain untested.

Document the new workloads and commands in the repository and update
`apps/docs/src/content/benchmarks.md` when they ship. User-facing client or
tooling changes update their relevant docs pages and the changelog manifest.
This RFC changes no shipped behavior or published performance claim.

## 9. Implementation sequence and completion record

| Step | Deliverable | Dependency | Status |
| --- | --- | --- | --- |
| 1 | Repository-owned workload definitions, artifact format, engine/socket/native lane selection | Existing bench and Rust driver | TS engine/socket and native socket replay/fanout/reconnect, Rust in-process engine replay, TS/Rust persisted process restart and mixed-commit socket workloads, isolated Postgres, TS/Rust blob lifecycle and permission purge with persistent reopen, and native byte phases implemented; combined SQLite comparisons complete in §§9.49–9.50; final Postgres validation remains |
| 2 | Repeated baseline with phase timings and work counts for replay, native boundary, and reconnect | Step 1 | TS/Rust replay, PostgreSQL SQL and WAL I/O, direct/command/FFI/Swift reads, and byte-encoder investigations recorded below; §9.45 adds native CPU phases; §9.47 completes selected-workload database metadata; §9.48 adds TS stack attribution and paired profiler overhead; §§9.49–9.50 complete local SQLite acceptance |
| 3 | Localized replay optimization with both-core validation | Step 2 attribution | Bun/Node WAL with FULL durability, incremental Rust append, Postgres commit-log round-trip reductions, and atomic successful acknowledgement batching implemented; §§9.49–9.50 validate combined TS and native improvements; final Postgres checks and controlled-runner calibration remain |
| 4 | Shipping native command/blob optimization justified by measured cost | Step 2 attribution | Allocation-free per-byte hexadecimal conversion, owned blob envelopes, query row ownership transfer, and typed diagnostic comparison implemented; direct, shared-command, and C ABI reads and blob lifecycles measured; Swift SDK reads measured; other language runtimes and binding blob delivery remain explicitly unmeasured under §6 |
| 5 | Reconnect/fanout optimization justified by measured cost | Step 2 attribution | WAL reduces TS apply cost; native clean replica apply and readiness-driven socket I/O measured; §9.43 repairs native frame/block transaction parity; §9.44 reduces pending overlay work; §§9.49–9.50 complete local SQLite acceptance |
| 6 | Structural CI budgets, calibrated performance job, regression reruns, and docs | Steps 3–5 | Reduced replay/reconnect/read/restart/mixed-commit/blob/purge CI workloads, explicit Postgres matrix, and docs added; local SQLite regression catalog complete; hosted job verification, final Postgres checks, and calibration pending |

For each completed step, record the revision, artifact location, workload,
correctness checks, repeated results, and unresolved limitations here. Keep an
unconfirmed cause open until a controlled experiment establishes it. If attribution
finds no material Syncular cost to remove in a workstream, record that evidence
and close the investigation without manufacturing an implementation change.

### 9.1 Persistent client SQLite, 2026-09-08

The baseline uses commit `f7b94e22764e8aec3d2528ec2858a37be65ca958` plus the
new benchmark harness. A separate detached checkout preserves that source.
The candidate changes the Bun and Node database factories to WAL journaling
and explicitly retains `synchronous=FULL`. Rust's shipping identity-aware file
factory already selects WAL. This change leaves application indexes, SQL,
commit boundaries, and observer transaction counts unchanged.

Ten adjacent baseline/candidate pairs alternate AB and BA order. Each attempt
creates fresh clients with persistent SQLite and 2,000 seeded rows. Both
versions use identical instrumentation and the same socket server fixture.
The Postgres cases use an isolated local `postgres:18-alpine` container and a
unique schema per attempt. Cleanup verification found zero run schemas after
the trials. These measurements describe the local development host; the
performance runner has not been calibrated. Postgres and one reconnect trial
contain large host-time outliers, retained in the raw record.

| Workload | Baseline median | Candidate median | Reduction |
| --- | --- | --- | --- |
| SQLite server, 1,000 commits: writer drain | 1,192.253 ms | 400.857 ms | 66.4% |
| SQLite server, 1,000 commits: reader visibility | 858.899 ms | 386.318 ms | 55.0% |
| Postgres server, 1,000 commits: writer drain | 3,383.313 ms | 2,752.867 ms | 18.6% |
| Postgres server, 1,000 commits: reader visibility | 2,924.442 ms | 2,544.913 ms | 13.0% |
| Reconnect 25 readers after 100 writes, SQLite server | 646.096 ms | 167.307 ms | 74.1% |
| One write to 25 connected readers, SQLite server | 19.413 ms | 8.438 ms | 56.5% |

The artifact manifest is `bench/results/wal-paired/manifest.json`; it records
the 80 attempt paths, their SHA-256 hashes, order, outcomes, and metrics.
Each attempt contains its source diff and fingerprint. Artifacts remain local
and gitignored. Diagnostic runs did not overwrite `bench/RESULTS.md`.

The shared Bun/Node adapter contract verifies WAL, FULL durability, a reader
holding its original snapshot while a writer commits, rollback, and reopen.
Both runtime checks pass. The reconnect harness initially attempted concurrent
sync drives; the runner now coalesces them. Its retained failed attempts also
exposed callbacks from a disconnected socket reaching a closed database. The
client now checks the connection generation before accepting text or binary
callbacks; a deterministic test verifies replacement and closure.

Postgres replay remains open. The baseline records 13,000 transaction SQL
calls for 1,000 one-operation commits, plus 3,022 pool-level queries. Per-delta
acknowledgements trigger repeated client-record reads and writes. Those counts
identify the next experiments; they do not justify changing transaction
boundaries or dropping durable cursor updates.

### 9.2 Native byte encoder investigation

`bench/results/native-bytes-baseline.json` and
`bench/results/native-bytes-candidate.json` retain ten fresh-process attempts
per size. The shared shipping encoder previously allocated a formatted string
for every byte. It now appends the two lowercase hexadecimal digits directly.
The all-byte and 2 MiB tests verify exact output and round trips.

The initial 2 MiB encoding medians were approximately 58.5 ms before and
2.05 ms after. These initial runs overlapped other local work and did not
alternate versions. Treat them as attribution evidence. A paired rerun,
actual blob lifecycle measurements, platform-boundary validation, and a
curated result remain required.

### 9.3 Verification to date

`bun run check` passed with 1,708 main-lane tests, seven declared skips, and
13 isolated multi-tab tests; both actual Node runtime contracts passed.
`bun run bench:ci` passed the existing bootstrap, propagation, bundle, and
window budgets plus the new 501-commit FIFO replay and five-reader reconnect
checks. `cargo test --workspace`, workspace Clippy with warnings denied, and
the five native-transport socket-round tests passed. Explicit Rust-client ×
TS-server conformance passed all 104 scenarios. The final benchmark resource
cleanup edits also passed the focused benchmark tests and TypeScript checks.

The remaining completion audit includes affected platform bindings, persisted
writer process termination/reopen, mixed-operation commit boundaries, fixed
read-overhead workloads, native full-client replay/observation, blob lifecycle
and delivery, server replay optimization, and performance-runner calibration.
The RFC remains in progress until those requirements have evidence.


### 9.4 Native replica apply and socket I/O, 2026-09-08

The native full-client replay lane exposed two reader costs. The client rebuilt
all visible rows after each delta even with an empty outbox. The transport also
held a shared socket mutex across a five-millisecond blocking read, followed by
a fairness sleep. One 1,000-commit attribution attempt recorded 2,452 ms inside
acknowledgement sends out of 2,817 ms of inclusive delta apply time.

The client now mirrors changed base rows into clean visible tables when the
outbox is empty. Both writes remain inside the existing observation transaction.
Pending overlays retain complete replay. A differential test compares row state,
FTS state, local revisions, and emitted change batches against forced complete
replay across 32 updates and deletes with unique indexes. Another test verifies
rollback after a later invalid change. The optimized differential case performs
zero complete overlay rebuilds; its reference performs 32.

The native transport now gives one I/O thread ownership of the WebSocket.
A readiness poller replaces timed socket reads. Outgoing commands wake the
poller and wait for their write to flush. A receive iteration handles at most
64 frames before servicing sends. A failed send closes the connection, and
shutdown wakes and joins the I/O thread. This retains SSP2 framing and per-delta
acknowledgements. Seven native socket tests pass, including chunked rounds,
interleaved deltas, a 4 MiB outgoing message with ping traffic, mid-round close,
and idle shutdown. These tests use completion events instead of sleeps.

Ten adjacent AB/BA pairs per workload use fresh persistent clients, 2,000 seed
rows, the same repository-owned SQLite socket server, and direct native calls.
The baseline binary includes the benchmark extensions before the replica apply
and transport changes. Both binaries already contain the byte encoder change.
All 60 attempts completed and validated final rows and commit counts. Replay
also checked FIFO commit identities and two 500-operation request prefixes.

| Workload | Baseline median | Candidate median | Reduction |
| --- | --- | --- | --- |
| 1,000 commits: reader visibility | 6,335.821 ms | 187.795 ms | 97.0% |
| 1,000 commits: writer drain | 263.732 ms | 253.456 ms | 3.9% |
| 1,000 commits: queue construction | 2,135.932 ms | 2,188.818 ms | -2.5% |
| Reconnect 25 readers after 100 writes | 55.539 ms | 23.571 ms | 57.6% |
| One write to 25 connected readers | 44.847 ms | 6.172 ms | 86.2% |

The manifest at `bench/results/native-io-paired/manifest.json` records every
attempt path and hash, order, binary hashes, and the source artifacts for both
builds. Candidate acknowledgement send time has a median of 10.045 ms across
the 1,000-commit attempts. The candidate adds that counter; both versions share
the same controller, fixtures, and other instrumentation. Host-time outliers
remain in the raw attempts, including a 1,197 ms candidate replay and a 469 ms
baseline fanout. These are local development-host measurements. The pinned
performance runner remains uncalibrated.

Native socket diagnostics now support direct core and shared-command timing,
replay, connected fanout, reconnect, and persisted writer termination/reopen.
The initial restart check preserved 100 offline commit identities across SIGKILL
and verified optimistic rows before restoration and reader rows after replay.
Queue construction and server replay remain open: the reader improvement does
not explain or remove their remaining work. Native engine transport, complete
blob lifecycle and binding measurements, mixed commit boundaries, TS process
restart, and fixed read-overhead workloads also remain required.

### 9.5 Current native validation

The current source passes `bun run check` (1,712 main tests, seven declared
skips, 13 isolated multi-tab tests, and both actual Node runtime contracts),
workspace Rust tests, and Clippy with warnings denied. Explicit Rust-client ×
TS-server conformance passes all 104 scenarios. Swift, Kotlin, Flutter, React
Native, and Tauri binding gates pass. Tauri includes the real native-core to
TypeScript bridge test and both transport feature configurations. The docs
build produces 58 pages. The native benchmark unit test verifies that direct
and shared-command mutation loops preserve ten independent commit identities,
local revisions, and matching optimistic rows without network calls.

Five fresh 1,000-commit trials through the shared command router all converge.
Ten restart attempts (five each at 100 and 1,000 commits) preserve the queue and
optimistic rows across SIGKILL, retain the original FIFO commit identities,
and converge the independent reader. Their raw artifacts are
`bench/results/native-command-replay-verified.json` and
`bench/results/native-restart-verified.json`. These runs include the later
private allocation cleanup that groups the transport send queue and wake
handle; the paired experiment in §9.4 precedes that initialization-only change.

`bench:ci` initially breached two timing budgets: propagation p95 reached
28.0 ms, and warm image bootstrap reached 299,521 rows/sec against its 300,000
floor. Structural checks passed. A subsequent unchanged baseline run passed,
and the unchanged candidate rerun passed every budget (0.4 ms propagation p95,
2,685,489 rows/sec warm image bootstrap). The failed run remains evidence;
its cause is unconfirmed. Calibration must address this variability before
those development-host timings support regression claims.

Gate logs and a source snapshot are retained under
`bench/results/verification-2026-09-08-native-io/`. Binding host gates do not
establish device-level iOS/Android transport behavior or real TLS socket
performance. Native blob delivery through each platform boundary remains open,
as do the remaining workstreams listed in §§9.3–9.4. No application indexes or
external benchmark files changed.


### 9.6 Native queue construction

The TypeScript core already applies only the newly appended commit. The Rust
core previously copied every base table into the visible tables and replayed
every pending commit after each append. A clean overlay already contains the
ordered application of the previous queue; applying the new commit extends
that same ordered application. The Rust append path now uses the existing
operation interpreter for the new commit. Base updates under pending writes and queue removals still trigger complete
replay. Complete replay also borrows queued
operations instead of cloning the entire queue.

A differential test applies 100 commits with one to four operations each to
the incremental path and to a forced complete-replay reference. It compares
visible rows, unique-constraint interactions, FTS rows and MATCH results,
revisions, and change batches after each commit. Both produce identical state.
The append path performs zero complete rebuilds; the reference performs 100.

Failure injection found that the prior outbox insert discarded its SQL error,
and a failed revision write rolled back SQLite while leaving the appended
commit in memory. The append now propagates persistence errors and restores
its in-memory queue when the observation transaction fails. Rust and TS tests
inject failures at both boundaries and verify the empty queue, absent optimistic
row, unchanged revision, and absence of change events before a successful retry.
The TS test also verifies rollback of protected before-images.

Ten adjacent AB/BA pairs per pattern use 2,000 seeded rows, 1,000 independent
commits, file-backed clients, the same SQLite socket server, and identical
native instrumentation. The baseline includes the prior native I/O and replica
apply improvements. All 40 attempts pass commit identity, request prefix,
queue-drain, and independent-reader validation.

| Pattern and metric | Baseline median | Candidate median | Reduction |
| --- | --- | --- | --- |
| Independent rows: queue construction | 2,403.161 ms | 117.188 ms | 95.1% |
| Repeated edits: queue construction | 2,346.313 ms | 101.169 ms | 95.7% |
| Independent rows: writer drain | 281.770 ms | 279.107 ms | 0.9% |
| Independent rows: reader visibility | 201.078 ms | 199.723 ms | 0.7% |
| Repeated edits: writer drain | 258.197 ms | 264.524 ms | -2.5% |
| Repeated edits: reader visibility | 192.195 ms | 196.070 ms | -2.0% |

The paired manifest is `bench/results/native-append-paired/manifest.json`.
It retains binary/source fingerprints, every attempt, and failures. Five fresh
trials per size and pattern also cover 100, 500, 1,000, and 10,000 commits in
`bench/results/native-append-full-independent.json` and
`bench/results/native-append-full-repeated.json`. All 40 full-profile attempts
pass. Independent-row writer drain at 10,000 commits remains approximately six
seconds. These local results establish the append improvement; they do not
complete the server replay investigation or calibrate performance CI.


The append change passes the current main gate (1,713 main tests, seven
skips, 13 isolated multi-tab tests, and both actual Node runtime contracts),
workspace Rust tests and Clippy, all 104 explicitly enabled cross-core
conformance scenarios, all five binding gates, and the docs build. The existing
conformance catalog includes 499/2/1 and 500/2/1 FIFO boundaries with lost replies,
plus oversized-first-commit rejection. Benchmark CI passes on this run.

Five restart trials each at 1,000 and 10,000 commits also pass. The artifact
`bench/results/native-append-restart.json` validates the offline queue and
optimistic rows after SIGKILL, then original commit identities, bounded request
prefixes, and independent reader convergence after restoration. Gate logs and
source snapshots are retained in `bench/results/verification-2026-09-08-append/`.
Source snapshots use JSON fields and patch text so the compiler and test runner
do not discover archived source files as additional project code.

### 9.7 Postgres replay statement reduction

The Postgres push path previously attempted `INSERT ... ON CONFLICT DO NOTHING`
before every partition lock. It now locks an existing partition with one
`SELECT ... FOR UPDATE`. A missing partition still goes through initialization
and a second lock query. Each push retains its transaction, rejection savepoint,
durable result, and awaited notification.

An embedded Postgres test checks initialization, rollback, dense sequence
allocation, and the number of lock statements. Two real-Postgres tests hold
concurrent writers at the missing-row boundary, then verify serialization when
the first writer commits or rolls back. The explicit Postgres suite also
exercised an older duplicate-push fixture that lacked the version 2 log epoch.
That fixture now registers the partition and sends its epoch, allowing the
duplicate test to reach the push path. All five integration tests pass.

Ten adjacent AB/BA pairs per experiment use TS socket clients, persistent local
SQLite, 2,000 seed rows, and 1,000 independent one-operation commits against an
isolated Postgres 18 container. The baseline includes the preceding client
optimizations. Each attempt uses fresh stores and validates FIFO identities and
independent reader state. All 40 attempts completed; host-time outliers remain.

| Experiment | Baseline drain median | Candidate drain median | Baseline reader median | Candidate reader median |
| --- | --- | --- | --- | --- |
| Atomic/coalesced cursor updates plus partition locking | 3,152.382 ms | 3,844.607 ms | 2,901.558 ms | 3,284.121 ms |
| Partition locking alone | 3,013.607 ms | 3,049.813 ms | 2,783.706 ms | 2,786.741 ms |

The combined experiment reduced transaction queries from 13,000 to 12,002 and
pool queries from 3,022 to approximately 2,020, but its end-to-end median became
slower. Its cause remains unproven. The atomic/coalesced cursor implementation
is excluded from the implementation because the measurements do not justify
its required custom-storage API change. Its source patch, decision, raw samples,
and hashes remain in `bench/results/server-cursor-paired/`.

The retained partition-lock change reduces transaction queries from 13,000 to
12,002 in this workload, with 3,022 pool queries unchanged. The two additional
queries initialize the benchmark's first partition lock. Drain time increased
1.2% and reader time increased 0.1% in this sample; these measurements establish
the statement reduction without establishing an end-to-end speedup. The
manifest is `bench/results/server-lock-paired/manifest.json`. Postgres replay
remains open, including per-commit log/scope SQL and durable commit cost.

The retained implementation passes `bun run check` (1,714 main tests, 13 isolated
multi-tab tests, and the Bun/Node runtime contracts), both 104-scenario client
conformance pairings, and benchmark CI. The docs build produces 58 pages. Five
Rust socket replay trials against Postgres also validate 1,000 original commit
identities and independent reader convergence; their artifact is
`bench/results/server-lock-native-pg.json`. These native trials establish
correctness on the retained server path and have no paired native baseline.
Gate logs, source snapshots, Postgres version/image identity, and cleanup evidence
are recorded in `bench/results/verification-2026-09-08-server-lock/`. The temporary
Postgres 18.6 server had no remaining run-owned benchmark schemas before removal.

### 9.8 Fixed-schema TS read workload

`--workload read --lane engine` now selects warm local reads at 1k, 10k, and
100k rows. Each attempt bootstraps a full TS client through the server, validates
the fixture against independently generated rows, and measures the database
adapter, `query`, and `querySnapshot` with identical SQL and parameters.
Primary-key queries return one row; bounded queries return 100 rows in the full
profile. Snapshots use empty coverage requirements. Three warmup cycles precede
rotating surface order. Validation and SQL counter passes run outside latency
samples. Revision values use decimal strings in JSON artifacts.

The explicit projection contains no reserved columns, so the public query's
column check returns the original rows. This workload measures SQLite execution
and materialization, the query guard, and snapshot revision/transaction overhead.
It does not measure copying a `SELECT *` result that contains internal columns.
Artifacts include the SQL, sampled IDs, schema, plans, and raw samples. A reduced
file-backed read case is wired into benchmark CI with statement and transaction
budgets. The full diagnostic sweeps completed 30 fresh attempts: five trials
at each row count, with memory and file storage, and 100 operations per surface
per trial. Every result, final revision, and empty outbox validated.

The following values are medians of the five per-trial medians, in microseconds.
They describe warm reads with the declared projection and empty snapshot coverage.

| Storage and rows | Primary key: database / query / snapshot | 100 rows: database / query / snapshot |
| --- | --- | --- |
| Memory, 1k | 0.750 / 1.083 / 2.166 | 17.229 / 17.833 / 19.375 |
| Memory, 10k | 0.771 / 1.125 / 2.292 | 17.333 / 17.771 / 19.208 |
| Memory, 100k | 0.834 / 1.270 / 2.625 | 18.229 / 19.187 / 20.688 |
| File, 1k | 2.000 / 2.646 / 4.666 | 17.771 / 18.521 / 20.500 |
| File, 10k | 2.084 / 2.791 / 4.792 | 17.979 / 18.520 / 20.500 |
| File, 100k | 2.604 / 3.792 / 6.292 | 19.521 / 20.312 / 22.791 |

Raw samples and source fingerprints are retained in
`bench/results/read-ts-memory.json` and `bench/results/read-ts-file.json`.
These results establish a fixed-query baseline; no query API optimization was
implemented from them. An initial run exposed a bigint artifact serialization
error. Decimal-string revisions and a serialization test resolve that error;
the initial failed invocation logs remain in the verification archive.
Rust and native-binding read coverage remain required.

### 9.9 Scope-entry maintenance investigation

The 100k read fixture exposed substantial untimed setup cost. A live sample of
the benchmark process placed 1,300 of 1,309 main-thread samples in SQLite
execution. The server's per-row scope deletion uses `(partition, tbl, row_id)`
against an existing primary key ordered `(partition, tbl, var, value, row_id)`.
`EXPLAIN QUERY PLAN` limits that search to the partition/table prefix, leaving
the row ID as a filter over that range. The same broad deletion appears in
SQLite and Postgres row replacement and deletion paths.

A SQL-only probe used 100k scope entries and 20 adjacent AB/BA pairs. Reading
the old row's scope JSON through its primary key and including those `(var,
value)` pairs lets SQLite use the full existing scope primary key. Each delete
removed one entry, restored before the next sample; no index changed. Median
delete time was 3.749 ms for the broad predicate and 0.011 ms for the exact-key
predicate. The raw probe and its source are in
`bench/results/scope-delete-sql-probe.json`.

The implementation and full-client experiment below evaluate this candidate.
The SQL-only probe measures one storage statement and excludes client work.


### 9.10 SQLite and D1 scope maintenance

SQLite and D1 now read the old row's scope map before replacing or deleting
that row. The scope deletion specifies the complete existing scope primary key.
SQLite keeps both operations in the current transaction; D1 keeps them in the
current atomic batch. This changes no index, schema, or storage interface.

Cross-backend tests inspect physical scope entries after multiple scope changes,
repeated writes in one transaction, deletion and reinsertion, empty scope maps,
and missing-row deletion. The same row ID in another partition or table and a
sibling row retain their entries. Rollback and rejected-push finalization restore
the original row and entries. The SQLite query-plan assertion verifies that the
delete uses every existing scope-primary-key column. D1 coverage uses the local
atomic-batch test double; a deployed D1 performance run remains unmeasured.

Ten adjacent AB/BA pairs per backend use the same TS socket workload with file
storage, 2,000 seeded rows, and 1,000 independent commits. All 40 attempts validate
original commit identities, bounded FIFO requests, and independent reader state.
The baseline includes the preceding client and partition-lock improvements.

| Backend and metric | Baseline median | Candidate median |
| --- | --- | --- |
| SQLite writer drain | 501.599 ms | 476.015 ms |
| SQLite reader visibility | 501.488 ms | 374.279 ms |
| SQLite cumulative upsert duration | 87.973 ms | 17.202 ms |
| Postgres writer drain | 2,744.021 ms | 2,894.966 ms |
| Postgres reader visibility | 2,511.511 ms | 2,658.892 ms |

SQLite reader visibility improves 25.4%, drain improves 5.1%, and cumulative
upsert duration falls 80.4%. Storage method durations overlap other phases.
They must not be added to end-to-end measurements. The paired manifest is
`bench/results/scope-paired/manifest.json`.

The Postgres prototype increased drain by 5.5% and reader visibility by 5.9%.
A follow-up SQL probe against Postgres 18.6 found that the original row-ID
predicate already uses its existing index at 2k and 100k scope entries. At
100k entries its median was 0.242 ms, compared with 0.249 ms for the prototype.
The prototype is excluded. Postgres retains its previous scope deletion and the
partition-lock statement reduction in §9.7. The probe, excluded source patch,
and decision remain in `bench/results/pg-scope-sql-probe.json` and
`bench/results/scope-paired/`. The retained SQLite helper emits the same SQL as
the measured candidate; cleanup removed its unused Postgres branch and renamed
the helper.


The retained implementation passes `bun run check` (1,720 main tests, nine
skips, 13 isolated multi-tab tests, and both actual Node runtime contracts),
the five real-Postgres integration tests, and all 104 explicitly enabled
Rust-client conformance scenarios. Benchmark CI passes, including its new
file-backed read case. Five Rust socket replay attempts against SQLite and
five against Postgres validate final state on the retained server paths.
These functional native runs have no paired baseline. Their artifacts are
`bench/results/scope-retained-native.json` and
`bench/results/scope-retained-native-pg.json`.

### 9.11 Explicit Postgres CI job

The `postgres-performance` job in `.github/workflows/ci.yml` runs separate TS
and Rust socket clients against job-owned Postgres services. It pins the
Postgres 18.6 multi-platform image digest, Bun 1.4.0, and Rust 1.96.0 on
`ubuntu-24.04`. Each job runs five fresh 1,000-commit replay attempts with
2,000 seed rows and file storage, and uploads artifacts even after failure.
The TS job also runs the real-Postgres storage/fanout contracts. Invalid state
and unavailable prerequisites fail the job; there are no timing thresholds.

Both matrix commands pass locally against the pinned Postgres image. The TS
artifact is `bench/results/scope-retained-ts-pg.json`; the Rust artifact is
listed above. Actionlint 1.7.12 passes with its external shell/Python checks
disabled. It caught an initial service-port expression placed at job scope;
the corrected expression is at step scope. The GitHub-hosted job has not run.
OS-label and runtime pins do not establish a calibrated hardware baseline.
Runner calibration, Rust/binding read coverage, blob lifecycle measurements,
TS persisted-process restart, and the remaining catalog and phase counters
remain open. Verification logs and source snapshots for §§9.8–9.11 are retained
in `bench/results/verification-2026-09-08-scope/`.


### 9.12 TS persisted-process restart

`--workload restart --core ts --lane socket --storage file` now uses the same
process runner as Rust. Each client owns a process. The TS process adapter
calls the shipping client, SQLite adapter, and HTTP/WebSocket transports through
the existing benchmark fixture. Timing fields and command dispatch remain
private benchmark code. Queue construction measures individual mutations inside
the writer process and preserves one commit per mutation.

The runner confirms SIGKILL termination, a different reopened process ID, the
same client identity and database, the full offline queue, and exact optimistic
rows before syncing. The server commit sequence must remain unchanged during
construction and reopen. After replay, both cores must acknowledge the original
commit IDs in FIFO order, encode the expected 500-operation request prefixes,
empty the outbox, and converge with the independent reader. The TS adapter
collects every HTTP push result because `syncUntilIdle` returns only the final
round's summary. It validates every round's outcomes against the workload's
expected applied and rejected commit identities.

All 40 TS attempts pass: five fresh trials at 100, 500, 1,000, and 10,000 commits,
for independent-row and repeated-row edits. Each trial starts from 2,000 rows.
The following values are medians across the five fresh trials, in milliseconds.
Reopen includes process launch and client setup; drain and reader visibility
include controller receipt. These are diagnostic measurements without a paired
baseline or an optimization claim.

| Pattern and queue | Reopen | Queue construction inside TS | Writer drain | Reader visibility |
| --- | --- | --- | --- | --- |
| Independent, 1k | 28.016 | 193.040 | 397.455 | 307.081 |
| Independent, 10k | 28.486 | 2,283.356 | 4,614.077 | 4,526.226 |
| Repeated, 1k | 28.971 | 198.136 | 375.079 | 297.185 |
| Repeated, 10k | 29.216 | 2,157.215 | 4,346.135 | 4,244.408 |

The raw artifacts are `bench/results/ts-restart-full-independent.json` and
`bench/results/ts-restart-full-repeated.json`. Five Rust restart attempts at
1,000 commits also pass through the shared runner, including its added signal,
process identity, and exact applied-outcome checks. Their artifact is
`bench/results/process-runner-rust-restart.json`. Later artifact cleanup retains
the original Rust duration field names alongside the common operation fields;
this does not change the measured operations.

Deterministic integration tests cover both TS write patterns at the 500/1
request boundary. The reduced benchmark CI catalog now includes a 501-commit
TS restart with file storage. Native engine transport, Rust/binding local reads,
blob lifecycle and delivery, mixed-operation benchmark profiles, remaining phase
counters, and calibrated performance-runner coverage remain required.


The shared runner and TS adapter pass `bun run check` (1,723 main tests, nine
skips, 13 isolated tests, and both Node runtime contracts). Benchmark CI passes
with the new restart case, and the docs build produces 58 pages. No benchmark
client or server process remains after the runs. Verification logs, including
the initial last-round-summary validation failure, and source snapshots are
retained in `bench/results/verification-2026-09-08-ts-restart/`.


Five additional Rust restart attempts through `--boundary command` pass with the
same exact commit acknowledgement checks. The artifact is
`bench/results/process-runner-rust-command-restart.json`; it also retains the
original Rust timing keys alongside the common operation timing keys.


### 9.13 Mixed-operation commit boundaries

`--workload commit-boundaries --lane socket` uses the shared process runner for
TS and Rust with first-commit sizes 499 and 500. Each fixture queues three
commits containing 499/2/1 or 500/2/1 operations. The first request must contain
only the first commit; the second must contain the two remaining commits in
order. The 499 case leaves room for one operation, but taking the final commit
ahead of the two-operation middle commit would violate FIFO order.

`--reject-middle` enables a benchmark server commit validator. The validator
rejects the middle commit after both writes are staged, with code
`bench.middle_rejected` and operation index 1. Both middle writes must restore
their previous state. The final commit updates a different row and must apply.
The server sequence advances by two, and the writer retains the rejected
commit's durable outcome with a non-retryable validator error. The accepted
variant advances by three. Both variants preserve exact request and applied
acknowledgement identities, an empty final outbox, and full independent-reader
convergence. Offline optimistic validation includes all three commits before
server validation.

The CLI supports TS direct operations and Rust direct/shared-command operations
against SQLite and Postgres. The server hook is enabled only for the declared
rejection workload; schema and indexes match ordinary replay. The TS process
adapter records rejected and retryable HTTP results across rounds so a final
empty round cannot hide a failure. Its aggregate outcome validator requires the
exact expected rejected IDs; unrequested rejections still fail an attempt.

Interpret this workload's timings as three commits containing 502 or 503
operations. The full offline replay catalog continues to measure independent
one-operation commits at 100 through 10,000 commits. Shared conformance already
covers lost replies and oversized-first-commit rejection; those cases retain
their existing deterministic scenarios.


All 120 fresh attempts pass: five trials at each first-commit size, with accepted
and rejected middle commits, through TS direct and Rust direct/shared-command
operations, against SQLite and Postgres 18.6. Each trial starts from 2,000 rows
and uses file storage. Raw artifacts are indexed by
`bench/results/mixed-profiles-manifest.json`. The manifest reuses the first
completed Rust direct SQLite rejection profile; the later changes to log labels
and TS aggregate conflict counting do not change that Rust measurement path.

The implementation passes `bun run check` (1,728 main tests, nine skips,
13 isolated tests, and both Node runtime contracts), benchmark CI including the
new rejected 499/2/1 case, and the 58-page docs build. Actionlint validates the
new Postgres rejection step for both CI cores, with external shell/Python checks
disabled. Local profiles cover that step's workload; the hosted job remains
unrun. The temporary Postgres service had zero run-owned schemas before removal.
Logs, source hashes, and the profile script are retained in
`bench/results/verification-2026-09-08-mixed/` as text and JSON artifacts.


### 9.14 Blob lifecycle and cache reference repair

`--workload blobs` runs the TS client through the engine and socket lanes. A
separate attachment table carries blob references; ordinary task workloads retain
their schema. The full profile has 2,000 seed tasks, 64 KiB, 2 MiB, and 16 MiB
bodies, with two distinct objects in the 2 MiB case. Each attempt owns a writer,
reader, recovery client, and memory server blob store. The engine lane invokes
the shipping Hono route in process; the socket lane uses its HTTP endpoint.

Staging, upload plus reference commit, fresh download, cache-hit read, interrupted
body consumption, and recovery have separate timers. The injected interruption
passes a response prefix to the client, cancels the body, and fails the stream.
The failed attempt must leave no cache entry; recovery must issue a fresh
authorized request and return the complete body. Validation compares bytes,
content addresses, reference rows, upload pins, and final cache reference counts.
Cache hits must make no network request. CPU includes validation, and method
counts and durations overlap measured phases.

The first lifecycle tests found that both cores inserted downloaded bodies with
refcount zero and trimmed the cache before deriving their existing references.
A shared regression reproduces a 128-byte referenced body failing under a
64-byte cap with `blob cache write failed`. Both cores now refresh reference
counts before trimming. Rust previously derived counts from base rows; an
additional unsent optimistic-reference case exposed the same failure there.
Rust now updates a dirty overlay before counting references in visible rows.
This preserves the existing §5.9.7 cache contract and §7.1 optimistic visibility.

All 105 Rust-client conformance scenarios pass, including the new regression,
cache LRU, pending-upload pins, and scope revocation. The main gate passes 1,733
tests with nine skips, plus 13 isolated tests and both Node runtime contracts.
Workspace Rust tests, Clippy, Swift, Kotlin, Flutter, React Native, and Tauri gates
pass. The React Native gate uses its bridge double; mobile device behavior remains
untested. The docs build produces 58 pages and benchmark CI passes with the new
64 KiB socket lifecycle case. Three initial main-gate failures were stale public
conformance counts; the docs now report 105.

All 30 full-profile TS attempts pass with file storage: five fresh trials at
each size in each lane. The table reports medians across five fresh trials in
milliseconds; positions in the two-body case remain separate.

| Lane and object | Stage | Upload and reference commit | Download | Cache hit | Recovery |
| --- | --- | --- | --- | --- | --- |
| Engine, 64 KiB | 0.481 | 1.966 | 0.561 | 0.030 | 0.441 |
| Engine, 2 MiB first | 5.329 | 4.373 | 6.921 | 0.344 | 5.938 |
| Engine, 2 MiB second | 18.701 | 5.389 | 22.110 | 0.680 | 23.149 |
| Engine, 16 MiB | 80.019 | 36.431 | 109.345 | 8.012 | 112.796 |
| Socket, 64 KiB | 0.523 | 5.652 | 0.987 | 0.030 | 0.555 |
| Socket, 2 MiB first | 5.644 | 9.551 | 8.646 | 0.435 | 7.049 |
| Socket, 2 MiB second | 16.747 | 8.417 | 23.666 | 0.706 | 23.717 |
| Socket, 16 MiB | 78.152 | 43.527 | 118.414 | 8.170 | 112.154 |

Raw samples and source fingerprints are in `bench/results/blobs-ts-engine-file.json`
and `bench/results/blobs-ts-socket-file.json`; the aggregation is
`bench/results/blobs-ts-lifecycle-summary.json`. These are diagnostic baselines
with the correctness repair. Section 9.15 attributes much of the slower second
2 MiB object to automatic checkpoint work. Reference refresh scans live blob
columns and updates cache metadata; the new phase measurements separate that
transaction from body insertion and transport.

Section 9.16 adds Rust socket lifecycle measurements. FFI/binding delivery and native engine
and local-read coverage, additional phase instrumentation, pinned-runner
calibration, and the remaining regression catalog are also open.


Five additional socket trials against Postgres 18.6 pass with two distinct 2 MiB
objects per trial. Their artifact is `bench/results/blobs-ts-postgres-file.json`.
The server blob store remains memory-backed; this checks Postgres reference
storage and authorization with the full client lifecycle. The temporary service
had zero run-owned schemas before removal. All 35 lifecycle attempts and their
50 distinct per-attempt bodies validated. Source snapshots, gate logs, SDK paths,
and the failing pre-fix reproductions are retained under
`bench/results/verification-2026-09-08-blobs/`.

### 9.15 Blob phase attribution and automatic checkpoints

Each TS blob sample now records method calls, failures, and inclusive durations
inside staging, upload and reference commit, download, cache hit, interruption,
and recovery. SQL entries record whitespace-normalized statement text without
bound values. Snapshot and delta bookkeeping sit outside each phase timer.
Transactions include their nested SQL; SQL entries are subsets of method totals.
Aggregate measurements retain mutation and reference convergence between phases.
The existing phase timing fields remain available to artifact consumers.

The second-object investigation used five fresh trials per configuration, with
file configurations alternating order. A private diagnostic wrapper recorded SQL
and changed `wal_autocheckpoint` only in the checkpoint-disabled comparison. Both
file configurations retained WAL and `synchronous = FULL`. The table reports
medians in milliseconds for two distinct 2 MiB objects on the same clients.

| Configuration and object | Stage | Download | Cache hit | Recovery |
| --- | --- | --- | --- | --- |
| Default file, first | 7.195 | 9.216 | 0.517 | 6.835 |
| Default file, second | 19.767 | 24.637 | 0.889 | 27.869 |
| Automatic checkpoints disabled, first | 6.726 | 6.814 | 0.496 | 6.488 |
| Automatic checkpoints disabled, second | 6.274 | 6.852 | 0.524 | 6.551 |
| Memory, first | 2.461 | 2.712 | 0.356 | 2.035 |
| Memory, second | 1.480 | 2.144 | 0.359 | 2.208 |

The SQL-only reproduction observed a 1,000-page automatic checkpoint threshold
and 4,096-byte pages. The second insertion grew the WAL from 2,142,432 to
4,272,472 bytes. It took 17.677 ms with the default threshold and 4.489 ms with
automatic checkpoints disabled. Subsequent metadata updates appended one
4,120-byte WAL frame apiece in the disabled-checkpoint probe. The fixture's
refcount changes between zero and one and its LRU timestamp update therefore
avoid rewriting the entire 2 MiB body. The earlier whole-body metadata-rewrite
hypothesis does not explain this fixture.

These interventions attribute much of the second-object spike to automatic
checkpoint work and the following WAL restart. Disabling checkpoints defers work
past the measured operations and permits WAL growth; final close and checkpoint
cost are outside these timings. Production checkpoint and durability settings
remain unchanged. Any checkpoint optimization needs a bounded policy measured
across long-lived clients, readers holding transactions, and final close, with
crash and recovery verification. Section 9.16 extends lifecycle coverage to Rust; choosing a shared blob storage
or checkpoint change still requires complete resource and binding measurements.

`bench/results/blob-attribution-manifest.json` retains all 15 attempts, alternating
order, source of the diagnostic wrapper, and artifact hashes.
`bench/results/blob-sql-checkpoint-probe.json` retains the isolated SQL script,
configuration, timings, WAL sizes, and final checkpoint frame counts. These are
diagnostic artifacts, separate from the normal production-configuration profiles.


All 30 production-configuration phase profiles pass: five fresh trials at each
of the three body sizes in both TS lanes, with file storage. In the socket lane,
the second 2 MiB download takes 23.945 ms median. Its body-insertion and other
`exec` calls take 17.801 ms, the reconciliation transaction takes 4.954 ms, and
the download transport takes 1.067 ms. These are separately aggregated medians
with overlapping SQL and transaction measurements; they are not an additive
breakdown. The corresponding first download takes 8.150 ms. Raw profiles are
`bench/results/blobs-ts-engine-phases.json` and
`bench/results/blobs-ts-socket-phases.json`; per-phase medians and artifact hashes
are in `bench/results/blobs-ts-phase-summary.json`.

The main gate passes 1,734 tests with nine skips, 13 isolated tests, and both
Node runtime contracts. The SQL attribution regression checks shared elapsed
time, bound-value omission, and failure counts; lifecycle tests check that phase
counts separate interrupted fetches, successful retries, and cache hits.
Benchmark CI passes all structural cases and budgets. The docs build produces
58 pages. This step changes benchmark instrumentation and documentation; it
retains the production core and checkpoint settings validated in §9.14.
Verification logs and the current source snapshot are retained in
`bench/results/verification-2026-09-08-blob-phases/`.

### 9.16 Native blob lifecycle and stdio delivery

`--workload blobs --core rust --lane socket` now runs the same body sizes,
distinct-body fixture, attachment references, and cache checks through the
shipping native HTTP transport. `--boundary direct` times the core call;
`--boundary command` times the shared command router. Each attempt owns a server,
writer, reader, and recovery process. The native schema includes the attachment
table while retaining the ordinary task fixture.

The driver records staging, upload and reference commit, fresh download, cache
hit, interruption, and recovery. Native fetch time includes the core's existing
hexadecimal result construction. Direct staging excludes byte-envelope decoding;
command staging includes it. The parent records complete stdio delivery time,
request serialization, response parsing, serialized request and response bytes,
and input/output hex conversion. Exact-byte validation follows the decoding
timer. The driver has no FFI or mobile runtime in this path. CPU and RSS describe
the parent process; native process resources remain to measure. Transport byte
counters count successful binary bodies and omit partial failed reads and URL
response metadata; the fault report separately records the response prefix.

The interrupted native attempt first passes ordinary row-derived authorization.
The fixture returns a one-use signed URL served by a private HTTP listener. That
listener sends a prefix with the complete body's Content-Length and closes the
connection. The core must report `transport.failed` and leave no cache entry.
Recovery must call the authorized blob endpoint again and return the exact body.
The fixture verifies that every signed URL was consumed once. TS continues to
interrupt inline body consumption; successful transfers in both lanes use inline
HTTP bodies. Successful presigned-storage profiles remain open.

The initial Bun-only fault response rewrote Content-Length to match its prefix,
which exercised content-address rejection instead of incomplete HTTP delivery.
A raw HTTP listener now preserves the declared length. Both direct and shared
command tests verify the transport failure, clean cache, retry, and final
refcounts. A Rust unit test verifies identical cached byte results through both
boundaries, zero network calls for staging/cache hits, and timed failed downloads.
The Rust CI job builds the benchmark executable and runs the lifecycle contracts
with an explicit `SYNCULAR_NATIVE_BENCH` path.

All 30 final SQLite profiles pass: five fresh trials for each size and boundary,
with 2,000 seed rows and file storage. The table reports medians in milliseconds;
operation and delivery medians are calculated independently. These profiles
establish current behavior and do not compare an optimization against a baseline.

| Boundary and object | Native download | Stdio download delivery | Native cache hit | Stdio cache-hit delivery |
| --- | --- | --- | --- | --- |
| Direct, 64 KiB | 1.088 | 1.235 | 0.061 | 0.205 |
| Direct, 2 MiB first | 15.132 | 24.413 | 2.693 | 10.414 |
| Direct, 2 MiB second | 24.873 | 33.720 | 2.515 | 9.708 |
| Direct, 16 MiB | 148.317 | 502.222 | 20.692 | 326.535 |
| Command, 64 KiB | 1.125 | 1.250 | 0.113 | 0.227 |
| Command, 2 MiB first | 16.024 | 24.701 | 2.792 | 11.724 |
| Command, 2 MiB second | 23.878 | 32.179 | 2.661 | 9.052 |
| Command, 16 MiB | 161.824 | 470.174 | 21.769 | 327.802 |

The 16 MiB download response occupies 33,554,966 stdio bytes. Parent JSON parsing
takes 1.763 ms median in the direct profile and hex decoding takes 2.235 ms.
Those phases explain little of the gap between native operation and stdio
receipt. The controller currently rescans accumulated stdout while waiting for a
newline; §9.17 measures that contribution. Native serialization and pipe costs
still need separate measurement. Treat this as driver/boundary overhead. FFI and binding measurements
are required before attributing the same cost to an application integration.

Raw final profiles are `bench/results/blobs-rust-direct-phases.json` and
`bench/results/blobs-rust-command-phases.json`; medians and hashes are in
`bench/results/blobs-rust-phase-summary.json`. Earlier probe artifacts retain
fixture failures and the initial direct timer that also included result wrapping.
The final direct timer stops before benchmark result wrapping.

Ten additional Postgres 18.6 profiles pass: five direct and five shared-command
trials, each with two distinct 2 MiB bodies. Their artifacts are
`bench/results/blobs-rust-direct-postgres.json` and
`bench/results/blobs-rust-command-postgres.json`. The final native profiles cover
40 attempts and 60 distinct per-attempt bodies. The temporary Postgres service
had zero run-owned schemas before removal. These cases retain the memory server
blob store and exercise Postgres reference storage and authorization.

The main gate passes 1,734 tests with 11 skips and 13 isolated tests, plus both
Node runtime contracts. Two skips are the explicitly enabled native benchmark
contracts; running them against the freshly rebuilt executable passes all five
blob test cases. Workspace Rust tests and Clippy pass, benchmark CI passes all
budgets and structural cases, and the docs build produces 58 pages. Actionlint
validates the native CI step with external shell/Python checks disabled; the
hosted job remains unrun. Production source hashes match the preceding verified
snapshot, so this step retains the existing core and binding validation.
Source snapshots, artifact hashes, probe failures, and gate logs are retained in
`bench/results/verification-2026-09-08-native-blobs/`.

### 9.17 Linear stdio framing in the benchmark controller

The controller previously appended every stdout chunk to one string and searched
that accumulated string again for a newline. A deterministic 1 MiB response split
into 1 KiB chunks searched ranges totaling 538,443,797 characters for a
1,048,597-character message. The reader now searches only each new decoded chunk,
retains fragments, and joins them once when the complete message arrives.
`responseFramingMs` records UTF-8 decoding, newline search, and fragment assembly;
`responseScanChars` records the searched character ranges. These are controller
measurements inside delivery time. They do not measure engine work.

Tests cover split UTF-8 code points, escaped newlines, multiple messages per
chunk, incomplete responses, malformed UTF-8, and invalid JSON result shapes. A
structural bound requires large-response searches to cover each decoded character
at most once. The failing pre-change regression is retained with the verification
logs. Strict UTF-8 decoding also rejects an incomplete final code point.

Ten alternating pairs use an identical native executable and the direct blob
boundary. All 40 full lifecycle attempts pass across 2 MiB (two bodies) and
16 MiB cases. The table reports medians in milliseconds, with each body position
kept separate.

| Object | Framing before | Framing after | Stdio download before | Stdio download after | Native download before | Native download after |
| --- | --- | --- | --- | --- | --- | --- |
| 2 MiB first | 7.093 | 0.580 | 25.528 | 20.256 | 15.959 | 16.455 |
| 2 MiB second | 6.217 | 0.627 | 33.055 | 28.207 | 24.417 | 25.030 |
| 16 MiB | 294.144 | 6.249 | 464.858 | 176.907 | 149.585 | 150.396 |

The 16 MiB case's median search range drops from 8,640,470,279 characters to
33,554,966 characters. Its native operation time remains within one percent
between variants. This attributes most of the earlier stdio delivery gap to the
controller. The change improves benchmark measurement overhead; it establishes
no shipping Syncular gain. Both variants include the same timing and search-range
instrumentation. Raw profiles, source variants, order, executable hash, and
medians are in `bench/results/framing-paired/`.

### 9.18 Shipping Rust byte-envelope decoding

The Rust decoder previously validated a two-byte UTF-8 slice and called the
integer radix parser for every output byte. The decoder now converts ASCII
nibbles directly and classifies invalid pairs on the error path. The output
allocation remains one vector sized from the envelope. The shared command router,
FFI, and client byte parameters use this decoder.

The change preserves empty input, uppercase hex, the prior radix parser's
accepted `+digit` pairs, odd-length errors, invalid-digit errors, and the
`non-ASCII hex` error for pairs that split UTF-8. A differential test checks every
two-character ASCII input against the prior radix parser and checks representative
Unicode and boundary cases. Existing all-byte and 2 MiB round trips remain in
place. This changes execution cost without changing the command or wire contract.

Ten alternating pairs compare frozen pre-change and candidate executables with
the same fragment-based controller. Each size has ten fresh codec attempts and
ten full shared-command lifecycle attempts per variant. Codec attempts contain
three warmups followed by ten measured operations; the table takes the median
within each attempt, then across attempts. Staging medians use one measurement
per distinct body in each fresh lifecycle attempt.

| Object | Decode before | Decode after | Command staging before | Command staging after | Stdio staging before | Stdio staging after |
| --- | --- | --- | --- | --- | --- | --- |
| 2 MiB first | 5.572 | 1.827 | 14.588 | 11.027 | 17.575 | 14.007 |
| 2 MiB second | 5.572 | 1.827 | 22.670 | 19.716 | 25.375 | 21.687 |
| 16 MiB | 44.375 | 14.711 | 148.227 | 120.814 | 171.302 | 143.666 |

All durations are milliseconds. The decode column repeats the size-level codec
result for the two 2 MiB body positions. All 40 codec attempts and 40 lifecycle
attempts pass, including exact bytes, references, upload pins, interrupted HTTP
recovery, and cache hits. The lifecycle attempts cover 60 distinct per-attempt
bodies. These measurements establish a shipping decoder and shared-command
staging improvement; complete FFI/binding delivery still needs measurement.

The pre-change five-trial codec profile is
`bench/results/hex-decode-baseline.json`. The paired experiment, frozen executable
hashes, source variants, raw samples, and aggregation are retained in
`bench/results/hex-decode-paired/`. The baseline executable hash matches the
pre-change CLI artifact. The controller optimization is present in both decoder
variants, so its improvement is excluded from the decoder comparison.

The main gate passes 1,743 tests with 11 skips, 13 isolated tests, and both
Node runtime contracts. The explicit native blob lane passes all five cases.
All 105 Rust-client conformance scenarios, workspace Rust tests, and Clippy pass.
Swift, Kotlin, Flutter, React Native, and Tauri gates pass; the React Native gate
uses its bridge double and does not exercise a mobile device. Benchmark CI passes
all budgets and structural cases, and the docs build produces 58 pages.
Verification logs, source snapshots, and paired artifact hashes are retained in
`bench/results/verification-2026-09-08-framing-hex/`. Native process resource
measurement, actual FFI/binding delivery, and the remaining RFC workloads and
runner calibration remain open.

### 9.19 C ABI blob lifecycle and host delivery

The native benchmark now accepts `--boundary ffi` for blobs. A Rust caller invokes
the exported shipping C ABI for client creation, commands, and shutdown. Each
blob phase records request JSON/C-string construction, the complete C call,
copying the returned string into host-owned bytes, freeing the library string,
and parsing the owned copy. Byte counts include the NUL terminator. The caller
frees each response before parsing and closes its handle on exit. Commands use
the FFI-owned native transport; no benchmark transport replaces it.

The C call includes input parsing, core execution, event collection, and result
serialization. Its duration replaces `nativeOperationMs` in FFI samples. Stdio
delivery to the parent remains separately measured. A server request trace tagged
by client identity verifies cache hits and interrupted-download recovery without
claiming native transport durations. Trace reads run outside delivery timers.
The signed-URL fault endpoint rejects forwarded host headers and consumes its
token once. Every retry must authorize again and return the complete body.

Five fresh SQLite trials at each size pass all lifecycle checks. The 2 MiB case
contains two distinct objects, giving 15 attempts and 20 validated bodies.
Medians below are milliseconds across the five trials. Host delivery sums the
exclusive C ABI phases within each sample before taking the median; individual
phase medians do not add to that median.

| Object | C download call | Host copy | Free | Host JSON parse | C ABI host delivery | Stdio delivery |
| --- | --- | --- | --- | --- | --- | --- |
| 64 KiB | 1.136 | 0.004 | 0.002 | 0.013 | 1.154 | 1.899 |
| 2 MiB first | 18.342 | 0.347 | 0.068 | 0.396 | 19.215 | 22.180 |
| 2 MiB second | 26.578 | 0.154 | 0.062 | 0.365 | 27.173 | 29.649 |
| 16 MiB | 170.595 | 2.559 | 0.590 | 3.520 | 177.080 | 202.251 |

The 16 MiB fetch returns 33,554,581 C-string bytes including its terminator.
Its median cache-hit C call takes 33.735 ms. These measurements establish the
current C ABI baseline through a Rust host. They do not measure Swift, Kotlin,
Flutter, React Native, or Tauri runtime delivery, and they do not form a paired
optimization comparison with earlier direct or command profiles.

Five additional Postgres 18.6 trials validate ten 2 MiB bodies. The first and
second objects have median C download calls of 18.589 and 30.621 ms. The owned
database has no benchmark schemas after cleanup, and its container is removed.
The Postgres CI matrix now includes this five-trial C ABI lifecycle in its Rust
job. Actionlint passes; the hosted job remains unrun.

Raw profiles and median calculations are `bench/results/blobs-ffi-file.json`,
`bench/results/blobs-ffi-summary.json`, and `bench/results/blobs-ffi-postgres.json`.
The Rust unit contract exercises exact bytes, repeated result ownership, measured
command errors, and invalid boundary selection. All six blob tests pass against
the rebuilt native executable. The main gate passes 1,743 tests with 12 skips,
13 isolated tests, and both Node runtime contracts. Workspace Rust tests and
Clippy pass. Production and binding source hashes match the preceding verified
snapshot; this change adds benchmark coverage under the existing C ABI contract.

Benchmark CI passes all budgets and structural cases, and the docs build produces
58 pages. Verification logs, source snapshots, artifact hashes, and the median
calculation are retained in `bench/results/verification-2026-09-08-ffi/`.
Native process resource measurement, language-binding delivery, Rust/binding
fixed-schema reads, native engine transport, Postgres replay latency work, and
runner calibration remain open.

### 9.20 Client process CPU and peak memory

Process-backed replay, restart, mixed-commit, fanout, reconnect, and blob attempts
now retain OS resource counters after client exit. `clientResources` records the
role, PID, client identity, user/system/total CPU milliseconds, and peak RSS bytes.
Restart includes both the killed and reopened writer. Each record covers the
process lifetime, including setup, validation, stdio, and shutdown. It excludes
the server and controller. Peak RSS is a lifetime high-water mark; summing reader
peaks does not establish simultaneous memory usage.

The driver reads Bun's child resource counters after normal shutdown or confirmed
SIGKILL. This Bun build returns CPU microseconds as big integers despite the
installed numeric type declarations. Normalization accepts both representations,
checks safe integer ranges and CPU totals, and produces JSON-safe numbers. Missing
or inconsistent counters fail the attempt. Idempotent shutdown lets the workload
collect exit counters while retaining its existing cleanup path.

A child-process contract compares the collected CPU and peak RSS against the
child's own counters and checks the byte/KiB conversion. Unit cases cover missing,
negative, fractional, string, unsafe, and inconsistent counters. Restart tests
verify separate process identities and resources for the killed and reopened
writer. The direct, command, and C ABI blob contracts each require all three
client resource records.

Five fresh trials per case validate 65 Rust attempts and resource records for
420 client processes. Blob cases cover all three boundaries at 64 KiB, two
distinct 2 MiB bodies, and 16 MiB. Replay and restart use 1,000 independent
commits; fanout and reconnect each use 25 readers. The table contains per-role
medians across five trials. CPU is milliseconds; peak RSS is MiB.

| Workload and process | CPU | Peak RSS |
| --- | --- | --- |
| 1,000-commit replay writer | 199.737 | 18.313 |
| 1,000-commit replay reader | 120.727 | 12.453 |
| Restart writer before SIGKILL | 88.741 | 16.172 |
| Restart reopened writer | 118.823 | 14.813 |
| 16 MiB direct blob writer | 182.968 | 155.000 |
| 16 MiB direct blob reader | 217.391 | 122.859 |
| 16 MiB C ABI blob writer | 221.581 | 251.391 |
| 16 MiB C ABI blob reader | 264.929 | 187.234 |

These are process measurements through the benchmark caller. The C ABI caller
also copies and parses JSON results; the native process retains stdio buffers
and allocates command envelopes. The peak figures do not isolate shipping core
allocations or predict a language binding's memory use. No resource probes run
inside operation timers. The profiles use the same native executable as §9.19;
this step changes the controller and introduces no runtime optimization claim.

Raw profiles are `bench/results/resources-{blobs-direct,blobs-command,blobs-ffi,
replay,restart,fanout,reconnect}.json`. Per-role medians and source hashes are in
`bench/results/process-resources-summary.json`. Per-phase native CPU/allocation
attribution, server process resources, language-binding delivery, and the other
open RFC workstreams remain required.

The main gate passes 1,745 tests with 12 skips, 13 isolated tests, and both Node
runtime contracts. All six native blob tests pass. Benchmark CI passes every
budget and structural case; the docs build produces 58 pages. The 24 native,
production, and binding source hashes recorded in the preceding verification
snapshot are unchanged, and all seven profiles use its release executable.
Source snapshots, gate logs, artifact hashes, and aggregation are retained in
`bench/results/verification-2026-09-08-resources/`.

### 9.21 Owned native JSON envelopes

The FFI cloned every parsed command's parameters before dispatch. The shared blob
command then wrapped its owned result with `json!`, and the FFI wrapped that
owned reply with `json!` again. In the installed serde_json implementation,
`json!` serializes an expression through a reference, rebuilding its JSON value.
Each wrapper copied the complete hexadecimal payload.

The FFI now borrows input parameters for the duration of dispatch. The blob
command and FFI insert owned results into their envelope maps. The wire, JSON
shape, C-string ownership, and event forwarding remain unchanged. The change
adds no command or buffer API. A scan also found JSON construction in query-row
and diagnostics paths; those conversions need separate workload measurements.

A test-only allocator counts this thread's allocations and reallocations at or
above the hex payload size. For a 2 MiB body, the pre-change FFI dispatch makes
one 4 MiB allocation while staging and three while fetching a cached body. The
candidate makes zero and one, respectively: the core still creates the required
hex result. The test checks three cache hits and exact decoded bytes. It excludes
C input parsing and output string serialization. Its failing pre-change result
is retained with the verification logs. The allocator compiles only into tests.

Ten alternating pairs run the same controller against frozen baseline and
candidate executables. Both variants use the same resource collector. All 80
full command/C ABI lifecycle attempts pass, validating 120 per-attempt bodies
across 2 MiB (two distinct bodies) and 16 MiB sizes. The table reports the 16 MiB
medians across ten trials per variant.

| Measurement | Before | After |
| --- | --- | --- |
| Shared-command download, ms | 161.265 | 147.473 |
| Shared-command stdio download, ms | 186.290 | 173.858 |
| C ABI download call, ms | 166.526 | 166.745 |
| C ABI stdio download, ms | 200.123 | 200.027 |
| C ABI cache-hit call, ms | 34.557 | 32.910 |
| C ABI writer lifetime peak RSS, MiB | 251.406 | 219.367 |
| C ABI reader lifetime peak RSS, MiB | 187.234 | 187.250 |

C ABI download latency remains within 0.2 percent between variants. The unchanged
shared-command staging path also varies from 134.558 to 127.036 ms, so the latency
samples include storage and run variance. The writer's peak reduction is about
32 MiB, matching the removed input-envelope copy at this size. The reader's
lifetime peak is unchanged; allocation lifetimes in the caller still need
attribution. These figures do not isolate core allocations or language-binding
memory.

Raw attempts, frozen executable hashes, source variants, controller source,
execution order, and medians are retained in `bench/results/owned-json-paired/`.
The baseline executable hash matches the §9.20 resource profile. The source change
is limited to the shared blob reply wrapper and FFI parameter/result handling.

The main gate passes 1,745 tests with 12 skips, 13 isolated tests, and both Node
runtime contracts. All 105 Rust-client conformance scenarios and six native blob
contracts pass. Workspace Rust tests and Clippy pass; the FFI's combined native
transport, encryption, and CRDT feature test run passes all 19 cases. Swift,
Kotlin, Flutter, React Native, and Tauri gates pass. React Native uses its bridge
double; device performance remains unmeasured. Benchmark CI passes all budgets
and structural cases, and the docs build produces 58 pages. Source snapshots,
allocation regressions, gate logs, and paired artifact hashes are retained in
`bench/results/verification-2026-09-08-owned-json/`.

### 9.22 Rust fixed-schema local reads

The read workload now accepts Rust socket setup with direct or shared-command
measurement. It uses the same generated rows, SQL, bind IDs, projection, and
query limits as the TS workload. Bootstrap and full-dataset checks surround the
measurement loop. The private driver configures 50,000 snapshot rows and 50 pages
for the untimed bootstrap so every declared dataset can converge.

The Rust client's `bench-internals` feature exposes its owned connection to the
private driver. Default client builds omit the hook; the default FFI feature
graph contains no `bench-internals` activation. This keeps raw SQLite, query,
and snapshot measurements on one connection and warmed dataset. The raw fixture
converter handles null, safe integers, finite reals, and UTF-8 text, and rejects
other cell types. It prepares the fixed SQL and materializes dynamic row maps.

Each process receives the expected rows and bind parameters once. Rust performs
three warmup cycles, rotates the three read surfaces, and records operation
nanoseconds. Direct timings stop before typed results are converted for
validation; command timings include the shipping router's result construction.
Every result must match the generated rows in order. Snapshots must preserve the
revision and complete coverage, and final checks require the unchanged full
replica and empty outbox. Aggregate process elapsed includes IPC and validation.

An untimed SQLite trace pass records statements for each surface. Raw and public
query calls issue one statement. Snapshots issue four: savepoint, revision read,
application query, and release. The driver removes the callback before timed
work or query-plan collection. Resource counters cover the client process from
launch through exit. The existing `benchQuery` command remains available to
external callers; `benchRead` owns the repository's validated multi-surface loop.

Five fresh trials per storage/boundary/data-size combination pass 60 attempts
and 36,000 timed reads. Sizes are 1k, 10k, and 100k; storage is memory or file;
boundaries are direct or shared command. Each trial measures 100 operations per
query/surface after warmup. The profiles use bundled SQLite 3.46.0. The following 100k-row file results take the median
within each trial, then the median across five trials. Durations are microseconds.

| Query and boundary | Raw SQLite | Public query or command | Snapshot or command |
| --- | --- | --- | --- |
| Primary key, direct | 3.38 | 3.60 | 5.17 |
| Primary key, command | 3.29 | 4.06 | 5.71 |
| 100 rows, direct | 35.58 | 36.50 | 38.15 |
| 100 rows, command | 35.96 | 64.85 | 66.71 |

The public client's read overhead is small in this fixture. Command overhead
increases with returned row count. The router still serializes owned query rows
into another JSON value; this is the next allocation target to test. These
profiles establish a boundary baseline, without a paired optimization claim.
C ABI and language-binding reads remain open.

Raw profiles are `bench/results/native-read-{memory,file}-{direct,command}.json`,
with per-trial aggregation in `bench/results/native-read-summary.json`. The
native contracts compare their SQL, bind IDs, and fixture digest with the TS
lane, for both boundaries and storage modes. A raw-converter unit test checks
supported cells, unsupported values, and rejected writes. The Rust CI job now
runs the native read and blob contracts together.

The main gate passes 1,745 tests with 16 skips, 13 isolated tests, and both Node
runtime contracts. Explicit native read/blob contracts pass all 12 cases, and
Rust-client conformance passes all 105 scenarios. Workspace Rust tests, Clippy,
and the default-feature client check pass. Swift, Kotlin, Flutter, React Native,
and Tauri gates pass; React Native uses its bridge double. Benchmark CI passes
all budgets and structural cases, and the docs build produces 58 pages.
Actionlint validates the CI step; hosted execution remains unrun. Source
snapshots, profile aggregation, artifact hashes, and gate logs are retained in
`bench/results/verification-2026-09-08-native-read/`.

### 9.23 Native query row ownership

The shared command router cloned query bind arrays and serialized owned row maps
into another JSON value. Both `query` and `querySnapshot` now borrow the bind
array and move returned row maps into their response. Snapshots retain the shared
metadata serializer after taking ownership of the rows. The command envelope,
typed cells, revision, coverage, and parameter errors remain unchanged.

A structural FFI test measures allocations of at least 2 MiB while executing a
query with a 2 MiB UTF-8 bind value. Each command previously made four such Rust
allocations and now makes two. The remaining allocations convert the SQLite bind
and materialize its output. The test compares complete results against the core,
including binary and large-integer cells, null, a real, and snapshot metadata.
It also checks empty results with incomplete window coverage and missing, null,
empty, and invalid bind arrays. This count excludes SQLite's own allocator and
the exported C ABI's JSON parsing and serialization.

Ten alternating baseline/candidate pairs use frozen release executables and the
same controller. Each variant runs memory and file storage at 1k, 10k, and 100k
rows, with 100 measured reads per query and surface after three warmups. All 120
fresh attempts and 72,000 timed reads pass exact row, digest, revision, coverage,
and statement-count checks. Raw SQLite remains the control on the same connection.
SQL, schema, indexes, bind IDs, and instrumentation are identical between variants.

The following 100k-row file results take the median within each attempt, then
the median across ten attempts. Durations are microseconds.

| Query and surface | Baseline | Candidate |
| --- | --- | --- |
| Primary key, raw SQLite | 3.355 | 3.375 |
| Primary key, query command | 4.021 | 3.709 |
| Primary key, snapshot command | 5.740 | 5.459 |
| 100 rows, raw SQLite | 36.177 | 36.229 |
| 100 rows, query command | 64.989 | 37.385 |
| 100 rows, snapshot command | 67.104 | 39.271 |

The 100-row query command takes 42.5 percent less time; the snapshot command
takes 41.5 percent less time. Raw SQLite differs by 0.15 percent. These timings
include shipping command dispatch and response construction. C ABI delivery and
language-runtime costs remain outside this paired measurement.

The main gate passes 1,745 tests with 16 skips, 13 isolated tests, and both Node
runtime contracts. Workspace Rust tests and Clippy pass, including the new
allocation regression. The combined native transport, encryption, and CRDT FFI
run passes 20 tests. All 105 Rust-client conformance scenarios and 12 native
read/blob contracts pass. Swift, Kotlin, Flutter, React Native, and Tauri gates
pass; React Native uses its bridge double. Benchmark CI passes all budgets and
structural cases, and the docs build produces 58 pages.

Raw trials, executable hashes, both command sources, controller source, run
order, and aggregation are retained in `bench/results/query-moves-paired/`.
Source snapshots and verification logs are retained in
`bench/results/verification-2026-09-08-query-moves/`.

### 9.24 Postgres replay attribution

The existing Postgres executor instrumentation now records whitespace-normalized
SQL shapes with bound values omitted. Shape records share the enclosing method's
count, duration, and failures. The owned benchmark hub also measures its awaited
`notifyCommit` method. Installing the wrapper on that hub includes both the HTTP
request context and contexts created internally for socket pushes. This changes
benchmark instrumentation only.

Deterministic engine and socket tests push through a realtime-connected writer,
verify one notification per applied commit, and check that a metrics reset clears
that measurement. The existing 501-commit replay test checks the HTTP push path.
A no-I/O executor probe runs ten alternating pairs of 100,000 calls after warmup.
Adding SQL shapes to the existing method timer increases median time per call
from 0.150 to 0.398 microseconds. This synthetic probe excludes actual server
scheduling and database I/O; its difference must not be subtracted from profiles.

Five initial fresh trials per core use 2,000 seed rows, 1,000 independent commits,
file-backed clients, and the isolated Postgres 18.6 server. All ten attempts pass.
TS drain ranges from 3.48 to 8.57 seconds and Rust from 3.03 to 3.59 seconds; these
sequential groups have substantial temporal variation and do not establish a
core speed ratio. Raw profiles remain in `pg-attribution-ts.json` and
`pg-attribution-rust.json` under `bench/results/`.

A second investigation enables Postgres `track_wal_io_timing` and alternates five
TS/Rust pairs. `fsync`, `synchronous_commit`, and `full_page_writes` remain on.
All ten attempts pass exact commit identity, FIFO, durable sequence, and independent
reader checks. Every attempt records 1,000 notifications, 1,000 commit completions,
1,003 client-record writes, and 12,002 transaction SQL statements. Per-shape counts
and durations reproduce their executor totals. The following values are medians
across five attempts per core, in milliseconds. Method totals include overlapping
work and must not be summed.

| Measurement | TS client | Rust client |
| --- | --- | --- |
| Writer drain | 3,298.474 | 2,975.249 |
| Independent reader visibility | 3,060.967 | 2,818.732 |
| Transaction acquisition | 114.018 | 127.548 |
| Partition lock plus candidate savepoint | 325.628 | 356.331 |
| Row writes and scope maintenance | 466.921 | 419.641 |
| Commit/change log and change scopes | 478.176 | 450.376 |
| Commit completion | 739.430 | 672.080 |
| Client-record persistence | 903.156 | 837.361 |
| Awaited local hub notifications | 28.983 | 26.029 |

The measured lock query includes its round trip and database wait. Commit
completion includes the driver's durable transaction completion. Notifications
return after delivering to the local sessions; later client apply and cursor
persistence remain outside that timer. The reader's cursor writes overlap the
writer's transactions. The benchmark installs no cross-instance LISTEN/NOTIFY
transport.

Postgres client-backend WAL snapshots surround each entire fresh attempt,
including schema creation, seed/bootstrap, replay, validation, and schema cleanup.
Their deltas record 2,043–2,048 fsyncs and 1,199–1,654 ms of fsync time per attempt.
These database counters show material flush work under retained durability but
do not attribute an individual flush to a replay phase. Raw snapshots, settings,
run order, outputs, and artifact hashes are in `bench/results/pg-attribution-wal/`;
aggregation is in `bench/results/pg-attribution-summary.json`.

Local notification scheduling does not dominate this replay fixture. The next
server experiment targets repeated commit/change-log SQL within the existing
transaction: this path issues four statements for each one-row, one-scope commit.
It must preserve dense sequence allocation, row/change ordering, rejection
savepoints, independent commit durability, and the awaited notification. Changes
to cursor persistence or transaction grouping remain separate design decisions.

Source snapshots, aggregation code, overhead samples, and verification logs are
retained in `bench/results/verification-2026-09-08-pg-attribution/`. Cleanup confirms
zero run-owned schemas before removing the dedicated Postgres container.

The main gate passes 1,747 tests with 16 skips, 13 isolated tests, and both Node
runtime contracts. All 12 explicit native read/blob contracts pass. Benchmark CI
passes all budgets and structural cases; the docs build produces 58 pages.

### 9.25 Postgres sequence allocation and commit metadata

`PostgresTransaction.appendCommit` now allocates the next sequence and inserts
commit metadata in one statement. A data-modifying common table expression
returns the allocated sequence to the insert. The existing partition upsert
retains its row lock and rollback behavior. Change rows, change scopes, result
persistence, and notification remain in their existing order; every commit still
has its own transaction.

A structural PGlite test previously observed two statements for an empty-change
append and now observes one. It checks rollback on a new and existing partition,
exact metadata including Unicode and quoted strings, a commit-row constraint
failure, and the next allocation after that failure. The failure leaves the
sequence available. The full storage contracts and real-Postgres concurrent
first-writer, duplicate-delivery, and fanout tests pass.

The baseline checkout at `/tmp/syncular-rfc-commit-log-baseline` includes the
preceding engine changes and the §9.24 SQL/notification instrumentation. Before
measurement, its production and harness source differs from the candidate only
in `postgres-storage.ts`; the new test also differs. Dependency resolution is
checked against the selected checkout. Both variants use one frozen Rust release
executable. No source changes or heavy checks run during measurement.

Ten alternating baseline/candidate pairs per core run 1,000 independent commits
with 2,000 seed rows and file-backed clients against an isolated Postgres 18.6
server. All 40 fresh attempts pass FIFO identity, durable sequence, and independent
reader validation. The database retains `fsync`, `synchronous_commit`, and
`full_page_writes`. The following values are medians across ten attempts per
variant and core, in milliseconds.

| Client and measurement | Baseline | Candidate |
| --- | --- | --- |
| TS writer drain | 3,245.576 | 3,257.825 |
| TS independent reader visibility | 3,004.861 | 3,020.859 |
| TS server commit-log method | 456.759 | 383.621 |
| Rust writer drain | 3,095.685 | 2,987.365 |
| Rust independent reader visibility | 2,938.760 | 2,826.011 |
| Rust server commit-log method | 444.211 | 371.294 |

Transaction SQL calls fall from 12,002 to 11,002 while commit and notification
counts remain 1,000. Commit-log time falls about 16 percent with either client.
Rust drain falls 3.5 percent and reader visibility 3.8 percent. TS drain increases
0.4 percent and reader visibility 0.5 percent, establishing no TS end-to-end gain
in this sample. Method durations overlap and must not be summed. The retained
change removes a round trip without changing a storage interface or transaction
boundary. Postgres replay remains open beyond this reduction.

Raw attempts, logs, source hashes and diffs for both variants, the frozen native
executable hash, and exact run order are in `bench/results/commit-log-paired/`.
Aggregation is in `bench/results/commit-log-summary.json`. Four additional real
Postgres contracts run the 499/2/1 and 500/2/1 fixtures through TS and Rust with a
rejected middle commit. Every run preserves whole-commit rejection, original
identities, and the later independent commit, ending at durable sequence 2.
These runs establish correctness and carry no performance comparison.

Source snapshots and verification logs are retained in
`bench/results/verification-2026-09-08-commit-log/`. Cleanup confirms zero benchmark
schemas before removing the dedicated database container and its integration
fixture data.

The main gate passes 1,748 tests with 16 skips, 13 isolated tests, and both Node
runtime contracts. All 105 Rust-client conformance scenarios pass. Benchmark CI
passes all budgets and structural cases, and the docs build produces 58 pages.

### 9.26 Postgres change rows and scope entries

Each Postgres change insert now returns its scope object to one statement that
also inserts the inverted scope entries. `jsonb_each_text` expands that object;
`ON CONFLICT DO NOTHING` retains one entry for a scope shared by multiple changes
in the commit. A change with no scopes still enters the log. The per-change loop,
change indices, payload binding, commit transaction, and rejection behavior remain
intact.

The first real-driver check found that Bun SQL encoded the serialized scope
parameter as a JSONB string. PGlite stored an object, so its initial structural
test passed while real Postgres rejected `jsonb_each_text` on the scalar. The
statement now binds serialized scopes as text and parses them into JSONB in
Postgres. New rows store an object consistently across these drivers. The existing
reader handles historical string-form scopes; the real-driver test converts its
rows to that representation and verifies the same filtered window. Its transaction
now rolls back in `finally`, including when an append fails.

The initial failed real-driver run and stopped paired experiment are retained.
The latter has one completed baseline and one failed candidate in
`bench/results/change-scopes-paired/`; neither contributes to the corrected
comparison. Cleanup confirmed no remaining benchmark schemas or active sessions
before the new experiment.

The PGlite structural test covers three ordered changes with empty, multiple,
and repeated scopes, Unicode and quoted values, an empty scope value, and binary
payload bytes. The append uses four statements, reduced from nine. It checks
rollback, exact deduplicated scope entries, filtered change order, a scope-entry
constraint failure, and preservation of the commit sequence. The real Postgres
contract also covers empty scopes, multiple scopes, upsert/delete changes, and
both new and historical scope representations.

A fresh baseline checkout includes §9.25 and the existing measurement hooks.
Ten alternating pairs per client core run 1,000 independent one-operation commits,
2,000 seed rows, and file-backed clients against Postgres 18.6. Both variants use
one frozen Rust executable. All 40 attempts pass FIFO identity, durable sequence,
and independent reader validation. Transaction SQL calls fall from 11,002 to
10,002, with 1,000 commit completions and notifications in both variants. The
following values are medians across ten fresh attempts per variant and core,
in milliseconds.

| Client and measurement | Baseline | Candidate |
| --- | --- | --- |
| TS writer drain | 3,306.485 | 3,240.635 |
| TS independent reader visibility | 3,068.554 | 3,017.850 |
| TS server commit-log method | 391.108 | 318.149 |
| Rust writer drain | 2,997.760 | 2,885.062 |
| Rust independent reader visibility | 2,845.151 | 2,724.959 |
| Rust server commit-log method | 371.122 | 294.554 |

Commit-log time falls 18.7 percent with TS and 20.6 percent with Rust. Writer drain
falls 2.0 percent and 3.8 percent respectively; reader visibility falls 1.7 percent
and 4.2 percent. All outliers remain, including an 8.29-second TS candidate trial.
Method durations overlap. These measurements describe this local host and must
not be combined arithmetically with earlier experiments into a cumulative latency
claim.

The corrected raw record is `bench/results/change-scopes-typed-paired/`, including
run order, source snapshots and hashes, and the frozen native executable hash.
Aggregation is in `bench/results/change-scopes-summary.json`. Four additional
Postgres contracts run rejected 499/2/1 and 500/2/1 commit fixtures through both
cores, retaining original identities and the later independent commit at durable
sequence 2. Durability settings remain enabled. Cleanup confirms zero benchmark
schemas before removal of the owned database container.

The main gate passes 1,749 tests with 16 skips, 13 isolated tests, and both Node
runtime contracts. All 105 Rust-client conformance scenarios and five explicit
Postgres integration tests pass. Benchmark CI passes all budgets and structural
cases, and the docs build produces 58 pages. Source snapshots and verification logs are
retained in `bench/results/verification-2026-09-08-change-scopes/`.

### 9.27 C ABI fixed-schema reads

The read workload now accepts `--core rust --lane socket --boundary ffi`.
Its private driver runs query and snapshot commands through the exported C
function, copies each returned string, frees it once, then parses the owned
copy. Per-read latency records the exported call. Separate phase arrays retain
request serialization, response copying, freeing, host JSON parsing, and byte
counts including NUL terminators. Counter collection and validation remain
outside latency samples.

A `bench-internals` feature on the FFI crate exposes a Rust-only borrow of the
handle's client. The driver uses it between sequential commands to measure raw
SQLite on the same connection. Default FFI builds omit the hook. The C ABI
exports and shared command surface remain unchanged; a unit test verifies that
the exported command rejects `benchRead` while the private driver accepts it.

The untimed trace confirms five diagnostic statements after every FFI read:
local revision, page count, page size, outbox bytes, and outcome count/bytes.
The task fixture has no blob table. Query commands therefore execute six SQL
statements and snapshots execute nine, including their savepoint and release.
Direct and shared-command query/snapshot counts remain one and four. The
benchmark enforces these limits and checks that each exported-call sample
matches its corresponding FFI phase record.

Six release profiles cover direct, shared-command, and C ABI boundaries with
memory and file storage, three dataset sizes, and five fresh trials per size.
All 90 attempts validate, totaling 54,000 timed reads. The six artifacts share
one source fingerprint and executable hash. SQL, parameters, query plans,
schema, and final row digests match across boundaries. The profiles were
collected sequentially; they establish boundary costs on this host rather than
an alternating before/after optimization comparison.

For 100,000 rows in file storage, the following values are medians of the
within-trial medians across five trials, in microseconds. C ABI query and
snapshot columns include input parsing, dispatch, diagnostic refresh, and
response serialization inside the exported call.

| Query and boundary | Raw SQLite | Query | Snapshot |
| --- | --- | --- | --- |
| Primary key, direct | 3.458 | 3.625 | 5.167 |
| Primary key, command | 3.375 | 3.667 | 5.417 |
| Primary key, C ABI | 3.917 | 17.250 | 19.563 |
| 100 rows, direct | 36.917 | 37.958 | 39.458 |
| 100 rows, command | 36.625 | 37.417 | 39.208 |
| 100 rows, C ABI | 36.563 | 80.146 | 82.688 |

The 100-row C ABI query reply contains 12,519 bytes including its NUL terminator.
Host request serialization takes 0.833 microseconds, response copying 0.375,
freeing 0.250, and JSON parsing 33.375. These are separate phase medians and
must not be summed into a measured end-to-end median. Primary-key host parsing
takes 0.500 microseconds for a 147-byte reply. The extra diagnostic work is
confirmed; its share of exported-call latency remains unmeasured. Removing
redundant diagnostic refreshes requires preserving diagnostic events, storage
observations, security preflight, and realtime behavior.

Raw profiles are `bench/results/ffi-read-{memory,file}-{direct,command,ffi}.json`.
`bench/results/ffi-read-summary.json` and the archived `summarize.py` validate
sample counts, identical fixtures, statement budgets, and FFI phase correspondence
before aggregation. Language runtime read measurements, native engine transport,
remaining replay phase attribution and regression workloads, and runner
calibration remain open.

The main gate passes 1,749 tests with 18 optional skips, 13 isolated tests, and
both Node runtime contracts. All 17 explicitly enabled native read/blob and
option contracts pass, as do 105 Rust-client conformance scenarios. Rust
workspace tests, Clippy, the 20 FFI feature tests, and Swift, Kotlin, Flutter,
React Native, and Tauri binding gates pass. Default-feature checks confirm the
benchmark hook is absent from the shipping FFI feature graph. Benchmark CI
passes all budgets and the docs build produces 58 pages. Verification logs,
source snapshots, and artifact hashes are retained in
`bench/results/verification-2026-09-08-ffi-read/`. Binding gates establish
compatibility; the profile's host parser runs in Rust and does not measure a
platform language runtime.

### 9.28 Native diagnostic snapshot comparison

FFI and Tauri diagnostic observers now retain a typed snapshot for evidence
comparison. They align the previous snapshot's capture time with the new one
before equality comparison, then construct event JSON only when another field
changes. This removes the JSON tree previously created and discarded after
every unchanged observation. Changed events serialize once and retain the
current capture time.

The observer still requests fresh diagnostic evidence. Its five SQL statements
in the task-only FFI fixture remain intact, as do lease observation, realtime
draining, and security preflight. A revision-only or command-name shortcut would
miss changes outside row revision, including failed sync rounds. Tauri retains
its existing consumer-registration gate. The implementation changes no command
format, diagnostic field, or event eligibility rule from SPEC §7.6.

A deterministic FFI test advances the pinned clock, reads unchanged data,
mutates a row, then records a failed sync without a revision increment. It
compares each emitted event with the complete current snapshot, checks capture
times, and verifies that preflight suppresses diagnostics. The unchanged-query
probe counts 68 Rust allocations before the change and 28 after it; a budget of
32 guards against reintroducing the discarded JSON tree. Tauri has the same
clock, mutation, failed-round, and preflight event checks. Both old comparison
sites were replaced.

Ten alternating baseline/candidate pairs cover memory and file storage at
1,000, 10,000, and 100,000 rows. All 120 fresh attempts validate, totaling 72,000
timed reads. Both variants use frozen release executables, fixed SQL and
parameters, identical schema and query plans, and the same SQLite controls.
Final row digests match. Each query and snapshot retains six and nine statements
respectively. The following values are medians of within-trial medians across
ten attempts per variant at 100,000 rows, in microseconds.

| Storage and C ABI operation | Baseline | Candidate | Reduction |
| --- | --- | --- | --- |
| Memory, primary-key query | 12.927 | 9.667 | 25.2% |
| Memory, primary-key snapshot | 14.979 | 11.605 | 22.5% |
| Memory, 100-row query | 74.198 | 71.396 | 3.8% |
| Memory, 100-row snapshot | 76.219 | 73.469 | 3.6% |
| File, primary-key query | 16.657 | 13.729 | 17.6% |
| File, primary-key snapshot | 18.896 | 15.854 | 16.1% |
| File, 100-row query | 78.396 | 76.031 | 3.0% |
| File, 100-row snapshot | 80.511 | 78.125 | 3.0% |

File-backed raw SQLite controls move from 3.708 to 3.646 microseconds for point
reads and 35.635 to 36.458 for 100-row reads. Host parsing of the 100-row query
reply measures 32.958 and 33.063 microseconds. The change removes diagnostic
comparison work; host parsing and the diagnostic SQL queries remain. The Rust
caller measures the exported C ABI. These results do not establish a Tauri
webview latency improvement.

The raw record is `bench/results/diagnostic-compare-paired/`, including run order,
source text and hashes, and executable hashes. Aggregation is in
`bench/results/diagnostic-compare-summary.json`. The archived summarizer validates
all attempt hashes, sample counts, fixtures, SQL budgets, and matching C-call
phase samples before calculating medians. Native engine transport, language
runtime profiles, remaining replay attribution and regression workloads, and
runner calibration remain open.

Verification passes the main gate (1,749 tests, 18 optional skips), 13 isolated
tests, both Node runtime contracts, all 105 Rust-client conformance scenarios,
and 17 explicitly enabled native read/blob and option contracts. Rust workspace
tests, Clippy, the 21 FFI feature tests, and all five binding gates pass. Benchmark
CI passes all budgets; the docs build produces 58 pages. The source snapshot,
paired executable copies, artifact hashes, and verification logs are retained in
`bench/results/verification-2026-09-08-diagnostic-compare/`.

### 9.29 Prepared diagnostic storage aggregates

Rust diagnostic storage now uses the connection's existing prepared-statement
cache for outbox, outcome, and blob aggregates. The compiled SQL is reused;
each invocation executes against current storage. Page-count and page-size
pragmas remain uncached. SQL text, result fields, pressure thresholds, and
unreadable-storage behavior remain unchanged. The cache's existing bounded
capacity also remains unchanged.

A storage test warms the aggregates, adds outbox/outcome/blob entries, checks
pressure, changes and removes entries inside a transaction, then rolls back.
Every observation reflects that transaction's current state. Renaming an
outcome column makes storage unreadable with absent estimates; restoring the
column recovers the values. Disabling the statement cache produces the same
complete storage snapshot. The test includes historical NULL operation bodies
and a schema without blobs. It passes before and after the optimization.

Ten alternating pairs per dataset size and storage mode compare frozen release
executables. All 120 fresh C ABI attempts pass, totaling 72,000 timed reads.
Fixtures, schema, SQL, query plans, and final row digests match. Query and snapshot
commands retain six and nine SQL statements. The baseline includes §9.28.
Values below are medians of within-trial medians across ten attempts per variant
at 100,000 rows, in microseconds.

| Storage and C ABI operation | Baseline | Candidate | Reduction |
| --- | --- | --- | --- |
| Memory, primary-key query | 9.750 | 6.917 | 29.1% |
| Memory, primary-key snapshot | 11.761 | 8.771 | 25.4% |
| Memory, 100-row query | 71.677 | 68.500 | 4.4% |
| Memory, 100-row snapshot | 73.813 | 70.396 | 4.6% |
| File, primary-key query | 13.531 | 10.562 | 21.9% |
| File, primary-key snapshot | 15.646 | 12.552 | 19.8% |
| File, 100-row query | 75.333 | 71.979 | 4.5% |
| File, 100-row snapshot | 77.479 | 74.229 | 4.2% |

File-backed raw controls measure 3.625 versus 3.541 microseconds for point reads
and 35.771 versus 35.781 for 100-row reads. Host parsing for a 100-row query
measures 32.917 versus 32.677 microseconds. The measured improvement belongs to
the exported call; result values remain fresh. The empty outbox/outcome fixture
does not establish aggregate-scan cost with large retained queues or histories.
Application indexes and queries remain fixed.

The raw record is `bench/results/diagnostic-sql-paired/`, with alternating run
order, source snapshots, executable hashes, and individual attempts. The
summarizer validates all hashes, matching fixtures, sample counts, SQL budgets,
and C-call phase samples before writing `bench/results/diagnostic-sql-summary.json`.
Native engine transport, language runtime profiles, remaining replay attribution
and regression workloads, and runner calibration remain open.

Rust workspace tests include 60 client tests, and the 21 FFI feature tests pass.
Clippy, all 105 Rust-client conformance scenarios, 17 native read/blob and option
contracts, and all five binding gates pass. The first main gate hit a five-second
React demo setup timeout. The unchanged rerun passes 1,749 main tests with 18
optional skips, 13 isolated tests, and both Node runtime contracts. The timeout's
cause remains unconfirmed; both logs are retained. Benchmark CI passes all budgets,
and the docs build produces 58 pages. Source snapshots, paired executables,
attempt hashes, and logs are retained in
`bench/results/verification-2026-09-08-diagnostic-sql/`.

### 9.30 Full socket replay profiles and TS process isolation

TS socket replay now uses the existing process driver and replay harness shared
with Rust and the TS restart workload. Each writer and reader owns a process.
The runner checks offline optimistic rows, original commit identities,
acknowledgements across all rounds, FIFO request prefixes, final rows on both
clients, and the server commit sequence. It separates operation construction and
drain from controller delivery and records each client's lifetime CPU and peak
RSS. Engine replay retains the in-process seam. Earlier TS socket artifacts
shared the controller process and have a different resource boundary.

Process replay also reads the actual client SQLite version, journal mode, and
synchronous setting before construction. File clients must report WAL and FULL;
memory clients must report the memory journal and FULL. Two CLI contracts cover
501 independent or repeated commits, exact 500/1 prefixes, separate writer/reader
process identities, and the recorded settings. Existing restart and mixed-commit
contracts continue through the same harness.

Four final profiles cover both cores, independent or repeated-row writes,
100/500/1,000/10,000 commits, 2,000 seed rows, file clients, and five fresh trials
per size. All 80 attempts validate 232,000 individual commits. Repeated writes
cycle over 32 rows with absent base versions. The four artifacts share one
source fingerprint; final row digests match across cores and trials for each
size/pattern. TS uses SQLite 3.54.0 and Rust uses 3.46.0. The SQLite server is an
in-memory database in its own process. These profiles do not measure persistent
server storage. They describe the complete client stacks, including their
different SQLite versions and instrumentation.

The following medians are across five independent trials, in milliseconds.
Construction measures only the sum of mutation calls inside the client process;
drain and reader visibility include controller receipt.

| Client and pattern | Commits | Construction | Writer drain | Reader visibility |
| --- | --- | --- | --- | --- |
| TS, independent | 1,000 | 245.890 | 515.249 | 397.032 |
| TS, independent | 10,000 | 2,990.869 | 6,744.463 | 6,634.311 |
| TS, repeated | 1,000 | 246.156 | 541.031 | 430.413 |
| TS, repeated | 10,000 | 2,830.675 | 7,391.750 | 7,271.272 |
| Rust, independent | 1,000 | 98.189 | 221.575 | 177.313 |
| Rust, independent | 10,000 | 1,930.660 | 4,226.593 | 4,089.881 |
| Rust, repeated | 1,000 | 110.645 | 244.326 | 190.684 |
| Rust, repeated | 10,000 | 1,184.680 | 3,554.668 | 3,516.078 |

The host was shared and trial ranges are retained. The 10,000-commit independent
TS drain ranges from 5.063 to 12.058 seconds; Rust ranges from 4.140 to 8.466
seconds. These are investigation profiles, with no before/after optimization
claim or calibrated latency threshold.

At 10,000 independent commits, writer lifetime CPU medians are 5,546 ms for TS
and 4,792 ms for Rust. Writer peak RSS medians are 156.875 and 88.547 MiB.
These resources include bootstrap, construction, validation, stdio, and shutdown;
they cannot be attributed entirely to drain. Reader and server resources remain
separate.

Both TS patterns record 2,008 transaction calls, 6,067 queries, and 6,507 execs
at 1,000 commits. At 10,000, they record 20,098 transaction calls, 240,643 queries,
and 164,079 execs. Transaction method calls include nesting and are not a count
of durable SQLite commits. Inclusive durations must not be summed.

The [TS response handler](../packages/web-client/src/client.ts) calls
`#replayOutbox` in its response-finalization block. Twenty successful 500-commit
pushes leave 9,500, 9,000, and successively fewer pending commits, ending at zero.
For this fixture, that implies 95,000 pending-commit applications across the
drain, compared with 500 at 1,000 commits. This count is derived from the source
and validated request prefixes; it is not a newly instrumented runtime counter.
Direct attribution of that work and a conformance-preserving affected-row model
remain the next replay investigation. Transaction merging still requires the
specification work in §5.2.

The final artifacts are `bench/results/large-replay-recorded-{ts,rust}-{independent,repeated}.json`.
`bench/results/large-replay-summary.json` validates attempt counts, settings,
request prefixes, commit and notification counts, resources, and matching digests
before aggregation. The initial 80 successful attempts in `large-replay-*` without
`recorded` are retained separately; they preceded the SQLite metadata check and
are excluded from this table. Native engine transport, language runtime profiles,
remaining phase attribution and regression workloads, and runner calibration
remain open.

Verification passes 10 process/CLI contracts, the main gate (1,751 tests with
18 optional skips), 13 isolated tests, and both Node runtime contracts. Additional
TS and Rust memory-mode CLI checks pass with the recorded memory journal and FULL
setting. Benchmark CI passes all budgets and the docs build produces 58 pages.
All 16 previously gated Rust/binding source files match the §9.29 archive hashes;
this change edits the benchmark harness and documentation. Source snapshots,
profile hashes, and verification logs are retained in
`bench/results/verification-2026-09-08-large-replay/`.

### 9.31 TS replay SQL and transaction-control attribution

The TS process driver now instruments the owned Bun SQLite `run` method used
by transaction control. It records actual `BEGIN`, `COMMIT`, savepoint, release,
and rollback calls separately from adapter transaction calls. Adapter queries
also record normalized SQL shapes and rows returned. Bound values and row contents
are omitted. Successful synchronous and asynchronous queries retain result
identity; failed queries contribute no returned rows. Prepared statement `run`
arguments remain excluded from SQL labels.

Two instrumentation tests cover row counts, result identity, and failure handling;
a third checks control SQL versus private prepared-statement arguments. The
501-commit CLI contracts verify one pending row materialized after the first
500 acknowledgements, matching BEGIN/COMMIT counts, bounded commits, and no
rollback. The driver uses the same Bun database class as the shipping factory.
Production client and server code remain unchanged.

Four profiles run TS socket replay with 2,000 seed rows, 1,000 or 10,000 commits,
independent or repeated writes, memory or file clients, and five fresh trials
per case. All 40 attempts validate 220,000 individual commits with matching final
digests. Both client configurations report SQLite 3.54.0 and synchronous FULL;
file clients use WAL and memory clients use the memory journal. The SQLite
server remains in memory. These are storage-attribution profiles, not a proposed
replacement of persistent clients with memory storage.

Runtime counts confirm 500 full-outbox rows returned at 1,000 commits and
95,000 at 10,000. The full read executes three or 21 times respectively; reads
after the queue empties return zero rows. Bounded encoder reads have a separate
SQL shape. Every materialized pending body passes through the existing decoder
before local replay. The new counts confirm the source-derived estimate in §9.30.

At 1,000 commits, the writer executes 2,007 COMMIT calls and one nested savepoint.
At 10,000, it executes 20,079 COMMIT calls and 19 nested savepoints. The earlier
adapter transaction counts included those nested scopes. Both patterns have the
same control counts, and all runs have zero rollback calls.

The following values are medians across five fresh trials at 10,000 commits,
in milliseconds. COMMIT durations are sums of synchronous calls within each
trial. Their share is the median of each trial's COMMIT time divided by writer
drain, rather than a ratio of independently computed medians.

| Storage and pattern | Writer drain | Reader visibility | COMMIT call time | COMMIT share | Full-outbox SQL reads |
| --- | --- | --- | --- | --- | --- |
| Memory, independent | 1,598.606 | 1,570.629 | 17.484 | 1.1% | 14.004 |
| Memory, repeated | 1,670.239 | 1,645.339 | 18.236 | 1.1% | 14.704 |
| File, independent | 6,030.740 | 5,918.121 | 4,118.698 | 68.7% | 15.092 |
| File, repeated | 10,507.717 | 10,405.657 | 8,648.819 | 82.3% | 15.117 |

The file-backed repeated drain ranges from 4.888 to 11.334 seconds on the shared
host. All samples remain in the artifact. COMMIT timing includes the native call,
storage waits, and scheduling; it does not isolate an operating-system fsync.
Full-outbox query timing excludes operation JSON decoding and subsequent local
application. Query and transaction timings overlap the drain and must not be
added to it. The table does not quantify total pending-replay CPU.

A synthetic check alternates ten pairs of 100,000 no-I/O queries after 1,000
warmups. Method-only wrapping takes 105.6 ns per call and SQL-shape/row counting
takes 275.2 ns. This measures that wrapper on a fixed short query; it does not
establish overhead for every engine statement or justify subtracting a constant
from profile results. The additional SQLite control wrapper also runs inside
end-to-end timers.

The COMMIT path dominates this persistent-client profile. The next transaction
design should start with client acknowledgement handling, preserving individual
commit outcomes, ordering, durable event delivery, and crash recovery. Any change
to revisioned observation or transaction semantics requires SPEC.md, both cores,
and conformance work before implementation, as required by §§3 and 5.2. The
remaining pending-replay CPU still needs direct attribution.

Raw profiles are `bench/results/replay-attribution-{memory,file}-{independent,repeated}.json`.
The synthetic record is `bench/results/replay-attribution-overhead.json`.
`bench/results/replay-attribution-summary.json` verifies counts, settings, FIFO
prefixes, resource identities, and final digests before aggregation. Source
snapshots, the synthetic script, raw artifact hashes, and verification logs are
retained in `bench/results/verification-2026-09-08-replay-attribution/`.

Verification passes 20 instrumentation/process contracts, the main gate (1,754
tests with 18 optional skips), 13 isolated tests, and both Node runtime contracts.
Benchmark CI passes all budgets and the docs build produces 58 pages. All 31
production/package/binding source files match the prior verified archive; this
step changes benchmark instrumentation, tests, and documentation.

### 9.32 Acknowledgement failure atomicity before transaction batching

The transaction-boundary review found two violations of §§7.2.1 and 7.5.
Rust removed a commit from its in-memory outbox before the observation
transaction finished. A failed revision write retained the durable outbox row
while losing its in-memory ID. Rust also returned a successful round after an
outcome journal write failed. TypeScript appended conflicts and rejections to
public collections and called `onConflict` before local durability; rolling
back SQLite left those collection entries and callback effects in place.

Both cores now abort response processing with the host-local
`client.outcome_persistence_failed` error when acknowledgement persistence
fails. Rust restores the removed outbox entry at its original position,
collection lengths, and overlay-dirty state after a failed observation commit.
Reports include applied or rejected IDs only after that transaction commits.
TypeScript restores collection lengths in the transaction rollback path and
calls `onConflict` after the transaction completes. A callback exception leaves
the durable outcome intact. The error code and publication boundary are
specified in §7.2.1; SSP2 and server commit boundaries remain unchanged.

Each core's regression test injects journal-write, revision-write, and deferred
foreign-key commit failures for applied, cached, rejected, and conflicted
results. The tests verify pending FIFO IDs, optimistic rows, absent outcomes,
collection state, and retry completion. TypeScript also checks that the
conflict callback can read a committed outcome outside a SQLite transaction;
an injected callback exception leaves that outcome durable. TypeScript's
existing response-finally optimistic replay has its own row revision, which
the test distinguishes from an acknowledgement outcome/status publication.
The shared `observation/mixed-ack-retry-and-durable-conflict` scenario verifies
mixed acknowledgement loss, original IDs across restart, independent cached
writes, conflict publication, and durable conflict recovery across both cores.
Local SQLite failure injection remains in the per-core tests.
The new restart vector also exposed a conformance-driver omission: the TS
driver did not attach its change collector to a recreated core. The driver now
reattaches that collector so post-restart event assertions inspect real events.

This prerequisite does not reduce transaction counts or establish a latency
gain. Grouping acknowledgements still requires the explicit transaction and
observation design in §5.2. Native engine transport, language runtime profiles,
remaining phase attribution and regression workloads, and runner calibration
remain open.

Verification: the full repository gate passes 1,757 tests with 18 explicit
skips, the 13 isolated multi-tab tests, and both Node SQLite runtime contracts.
The Rust workspace, 21 FFI feature tests, Clippy, all 106 Rust conformance
scenarios, 17 native benchmark contracts, and all five binding gates pass.
The benchmark CI budgets pass and the docs site builds 58 pages. The first
root run exposed the missing TS conformance collector and three stale scenario
counts; the corrected full run passes. Failure reproductions, gate logs, source
hashes, and the source patch are archived under
`bench/results/verification-2026-09-08-ack-durability/`.

### 9.33 Atomic successful acknowledgement batching

Both cores implement §5.2.1 and SPEC §7.2.1. Consecutive applied/cached results
share one local transaction and one revisioned outcome/status batch. Rejections
retain separate transactions. Every other frame ends the run. Unknown,
unsent, locally purged, and duplicate IDs cannot produce a second drain. Each
commit keeps its own durable journal entry and the existing retention policy.
Server commit transactions, notifications, and row delivery remain unchanged.

Rust records each removed outbox entry and its position until local commit.
A failed journal, revision, retention, or transaction commit restores those
entries in reverse removal order, preserving FIFO positions without copying the
whole queue. Failure also restores collection lengths, report lengths, and the
overlay-dirty flag. TypeScript uses the existing apply batch for the entire run.
Its outbox count is read at each run boundary because an observer can append a
new local write after the previous run commits. Reusing a response-wide count
would omit that write from a later batch's status.

The shared mixed-retry conformance vector now queues two independent commits,
one conflicting commit, and two later independent commits. After a lost reply
and restart, both cores publish exactly three outcome batches with outbox
counts 3, 2, and 0. Rejection remains its own revision between the two successful
runs. Local tests inject a failure on the second journal insert, revision
insertion, and deferred-constraint transaction commit. They verify rollback of
the entire run, original IDs on retry, duplicate handling, and persistence of a
completed run when a later response ERROR arrives. The TS observer test inserts
an unknown frame between successful runs and appends a local write from the
first change callback; the next batch retains the correct outbox count.

The repository's 501-commit process contract now caps actual TS SQLite commit
calls at 520. The prior per-result path exceeds that budget. Normal 1,000-commit
socket replay uses 1,009 actual COMMIT calls instead of 2,007; 10,000 commits use
10,099 instead of 20,079. The count includes delivered row commits and response
bookkeeping. Full pending-outbox reads still return 500 rows across a 1,000-
commit drain and 95,000 across a 10,000-commit drain. Batching acknowledgements
does not remove that replay work.

The comparison freezes the §9.32 clients as baseline and the new clients as
candidate. The same repository process replay harness drives both executables
against fresh SQLite servers and two client processes per attempt. TS runs Bun
bundles with identical instrumentation. Rust's final comparison uses locked
release builds and verifies the expected two-versus-one outcome batch behavior
before timing. An initial shared Cargo target directory returned the baseline
executable for both source directories; the candidate was rebuilt in an
isolated target directory before release measurement. Debug Rust trials remain
separate diagnostic records.

Ten alternating pairs per core, queue size, and write pattern produce 160 final
attempts and 880,000 validated individual commits. Client SQLite retains WAL and
`synchronous=FULL`; the server uses in-memory SQLite. Both versions use 2,000
seeded rows and unchanged application SQL and indexes. TS uses SQLite 3.54.0;
Rust uses 3.46.0. Comparisons are within each core. Writer drain measures the
client operation and excludes controller delivery; reader visibility includes
controller receipt of its applied-cursor acknowledgement. Queue construction
is outside both timings.

| Core, commits, pattern | Writer drain, baseline → candidate (ms) | Reader visibility, baseline → candidate (ms) |
| --- | --- | --- |
| TS, 1,000, independent | 343.095 → 203.635 | 272.696 → 205.952 |
| TS, 1,000, repeated | 405.398 → 211.189 | 308.708 → 213.988 |
| TS, 10,000, independent | 5,104.599 → 5,415.764 | 5,039.072 → 5,426.593 |
| TS, 10,000, repeated | 6,439.535 → 3,711.141 | 6,386.918 → 3,698.529 |
| RUST, 1,000, independent | 206.431 → 117.911 | 162.586 → 115.905 |
| RUST, 1,000, repeated | 174.000 → 95.458 | 139.889 → 103.199 |
| RUST, 10,000, independent | 4,026.793 → 3,303.309 | 3,900.462 → 3,238.798 |
| RUST, 10,000, repeated | 2,211.996 → 1,236.487 | 2,181.687 → 1,282.238 |

These are medians across ten fresh trials per variant. All request prefixes,
original acknowledgement IDs, individual commit counts, and writer/reader
digests validate. At 1,000 commits, writer drain medians fall by 40.6–47.9% in
TS and 42.9–45.1% in Rust. Reader visibility falls by 24.5–30.7% in TS and
26.2–28.7% in Rust. These reductions describe this acknowledgement change on
the local host and must not be added to earlier optimizations' percentages.

The 10,000 independent-write TS result establishes no aggregate median latency
gain. Eight of ten adjacent pairs improve, but the candidate's aggregate drain
median is 6.1% higher and its reader median is 7.7% higher. Baseline drain spans
4.540–12.727 seconds; candidate drain spans 2.784–7.424 seconds. Aggregate COMMIT
call time medians decrease from 2,872.807 to 2,549.367 ms despite this elapsed-time
variation. Queue construction also varies although its implementation is unchanged.
Keep this case open for a controlled-runner comparison. The structural count
reduction holds in every attempt; no slow trial is excluded.

At 10,000 commits, median writer lifetime peak RSS changes from 146.30 to
153.55 MiB for TS independent writes and 143.17 to 149.72 MiB for TS repeated
writes. Rust changes from 87.69 to 85.51 MiB and 81.88 to 79.30 MiB respectively.
These process high-water marks include construction, validation, stdio, and
shutdown. They do not isolate the acknowledgement run or establish its allocation
cost. The raw artifacts retain per-client CPU and memory observations.

The full repository gate passes 1,759 tests with 18 explicit skips, 13 isolated
multi-tab tests, and both Node SQLite runtime contracts. Rust workspace tests,
Clippy, 21 FFI feature tests, all 106 Rust conformance scenarios, 17 native
benchmark contracts, all five binding gates, and benchmark CI budgets pass.
Native engine transport, language runtime profiles, remaining replay attribution
and regression workloads, and controlled-runner calibration remain open.

The raw final record combines TS pairs 0–4 from `ack-batching-paired/` with TS
pairs 5–9 and all Rust release pairs from `ack-batching-release/`. The validated
aggregate is `bench/results/ack-batching-release-summary.json`. All 160 selected
attempts, the separate debug/pilot attempts, executable hashes, release build
inputs, scripts, source patch, and gate logs are archived under
`bench/results/verification-2026-09-08-ack-batching/`. The checkout's release
cache was rebuilt from current sources after comparison and passes the same
one-batch behavior check. The docs site builds 58 pages and its 30 tests pass.

### 9.34 Atomic server cursor acknowledgements, 2026-09-08

The realtime session previously read a complete client record, then wrote that
record back with an advanced cursor. A frozen-baseline reproduction pauses the
ACK after its read, replaces the subscription registration, and releases the
ACK. The baseline restores the old subscription list. The candidate retains
the replacement. This establishes a race in the existing read-modify-write path.

`ServerStorage.advanceClientCursor` replaces that path in SQLite, Postgres,
and D1 with one atomic UPDATE. The statement advances the cursor and activity
timestamp with independent maxima, preserves registration fields, and requires
the session's actor and current partition log epoch. It cannot insert a missing
client record. Epoch rotation deletes client records in its existing transaction;
an old session cannot update a registration created after that rotation. HTTP
registration retains its existing cursor rules. The existing best-effort ACK
persistence error policy remains unchanged.

Custom storage adapters must implement the required method. The internal
forwarding adapters, storage documentation, and changelog now include it.
No client core or wire-frame format changes in this step. The shared storage
contract covers reversed cursors and timestamps, partition isolation, actor and
epoch mismatches, missing records, rotation, and registration after rotation.
A deterministic realtime barrier covers subscription replacement while an ACK
is pending. The Bun/Node runtime contract verifies persisted cursor state after
reopen. The socket replay test requires 501 cursor updates, at most ten client
record reads, and at most five full-record writes for 501 individual commits.

Ten alternating server pairs per client core produce 40 Postgres 18.6 replay
attempts. Both variants use the same frozen TS client and release Rust client
from §9.33, 2,000 seed rows, 1,000 independent commits, and file-backed client
SQLite with WAL and FULL durability. The server uses an isolated schema in an
owned local Postgres container with default durability. Every attempt preserves
original IDs, FIFO prefixes, individual outcomes, and the writer/reader digest.

Every replay reduces Postgres query calls from 13,024 to 12,024. Client record
reads fall from 1,006 to six. Full-record writes fall from 1,003 to three,
with 1,000 atomic cursor updates replacing ACK writes. These work counts include
the server metric snapshot and the same sync-request bookkeeping in both variants.

| Client | Writer drain, baseline → candidate (ms) | Reader visibility, baseline → candidate (ms) |
| --- | --- | --- |
| TS | 2,816.093 → 2,707.097 | 2,679.856 → 2,581.849 |
| Rust release | 2,498.129 → 3,100.926 | 2,379.095 → 2,975.094 |

The local replay comparison establishes no consistent end-to-end speedup.
Five of ten TS pairs and three of ten Rust pairs improve writer drain. Rust's
candidate median is 24.1% slower, and its range spans 2.378–11.423 seconds.
Unchanged server transaction-commit work also increases from a 726.808 ms
aggregate-time median to 1,134.393 ms in the Rust-client trials, while appendCommit
medians remain 273.592 and 276.243 ms. This evidence does not distinguish host
variation from a change in write scheduling. Keep the regression open for a
controlled comparison; retain every slow trial.

A separate diagnostic runs 100 sequential ACKs through the frozen realtime
session and waits for storage completion after each ACK. Ten alternating pairs
reduce ACK SQL from 200 to 100 statements. Median total time changes from
170.490 to 104.234 ms, with nine pairs improving. Both variants still perform
100 durable writes. This isolates the ACK path and does not establish replay
latency. The metric snapshot adds one SELECT after timing. Completion wrappers
cause duplicate storage-method instrumentation in this diagnostic; its summary
uses SQL counts and total elapsed time. Nested method durations are not summed.

The repository gate passes 1,766 tests with 18 explicit skips, 13 isolated
multi-tab tests, and both Node runtime contracts. All 106 explicitly enabled
Rust conformance scenarios and benchmark CI budgets pass. The docs site builds
58 pages. Production Rust and binding sources are unchanged from §9.33, whose
native gates remain the latest verification for those sources.

The source snapshot, frozen servers and clients, all 60 attempts, summaries,
race reproduction, and gate logs are archived under
`bench/results/verification-2026-09-08-cursor-update/`. Replay records live in
`cursor-update-paired/`; isolated ACK records live in `cursor-update-ack-only/`.
Both summaries retain their measurement boundaries. The owned Postgres instance
had zero benchmark schemas after cleanup and was removed. Further ACK write
reduction requires lifecycle and durability attribution. Native engine transport,
language runtime profiles, the remaining regression catalog, and controlled-runner
calibration remain open.

### 9.35 ACK overlap attribution, 2026-09-08

The §9.34 replay regression leaves ACK scheduling as an unconfirmed cause.
The benchmark instrumentation now records pending async calls, peak pending
calls, and starts that overlap an earlier call. Counts belong to a collection
epoch. A completion from before a measurement reset cannot decrement the new
epoch's pending count. Deterministic tests cover overlapping success and
failure, preserved results, and reset while a call remains pending.

Ten further alternating pairs per core compare the atomic cursor update with
its preceding read-modify-write method. The frozen server bundles differ only
in the realtime cursor persistence method. Both include identical overlap
instrumentation. They reuse the frozen clients from §9.33 and the §9.34
Postgres fixture: 2,000 rows, 1,000 independent commits, persistent client SQLite
with WAL and FULL durability, and default Postgres 18.6 durability. All 40
attempts validate IDs, outcomes, request prefixes, and writer/reader digests.

| Client | Writer drain, baseline → candidate (ms) | Reader visibility, baseline → candidate (ms) |
| --- | --- | --- |
| TS | 3,786.863 → 3,485.241 | 3,649.971 → 3,336.441 |
| Rust release | 3,005.502 → 3,302.274 | 2,888.966 → 3,188.970 |

Six TS pairs and four Rust pairs improve writer drain. The Rust candidate
median remains 9.9% slower, so the preceding regression stays open. The TS
candidate range is 2.542–17.402 seconds; the Rust candidate range is
2.227–6.110 seconds. No trial is excluded. These observations do not establish
a consistent replay gain or a cause for the variation. Query counts remain
13,024 versus 12,024 in every pair.

| Atomic ACK updates per trial | TS | Rust release |
| --- | --- | --- |
| Calls | 1,000 | 1,000 |
| Overlapping starts, median | 28.5 | 1 |
| Overlapping starts, range | 7–132 | 0–40 |
| Peak pending calls, range | 2–5 | 1–2 |
| Pending calls at the final snapshot | 0 | 0 |

These counters measure the storage method's promise lifetime, including driver
queueing. They do not isolate database execution. The Rust trials show little
concurrent ACK work; TS overlap varies. A coalescing scheduler would change the
schedule being observed, so these counts are not a prediction of saved writes.
The current evidence does not justify adding one for this replay fixture.
Retain immediate atomic cursor updates and the existing disconnect and failure
behavior. The instrumentation remains available for workloads that demonstrate
sustained overlap.

A separate instrumentation probe alternates ten pairs of 100,000 sequential
calls to an async stub after 10,000 warmup calls. Both variants collect method
and SQL-shape timing. Median cost is 205.964 ns per call before pending counters
and 207.202 ns after. This probe includes no SQLite or transport work; do not
subtract its cost from a replay measurement. The replay comparison uses the
same instrumentation in both variants.

The repository gate passes 1,768 tests with 18 explicit skips, 13 isolated
multi-tab tests, and both Node runtime contracts. Benchmark CI budgets pass,
and the docs site builds 58 pages. Production server, client, Rust, and binding
sources are unchanged from §9.34. Its 106 Rust conformance results and the
preceding native verification remain applicable to those sources.

The raw replay record is `bench/results/ack-overlap-paired/`; the summary is
`ack-overlap-summary.json`. The instrumentation probe retains all 20 samples
in `ack-overlap-instrumentation-overhead.json`. Frozen bundles, their one-method
diff, scripts, source hashes, raw artifacts, and verification logs are archived
under `bench/results/verification-2026-09-08-ack-overlap/`. The owned Postgres
container was removed after confirming zero remaining benchmark schemas. Native
engine transport, language runtime profiles, remaining regression workloads,
and controlled-runner calibration remain open.

### 9.36 Permission-purge regression workload, 2026-09-08

`--workload purge --lane socket --storage file` runs the same permission-purge
fixture through full TS and Rust clients. `--sizes` selects 2,000, 10,000, or
100,000 rows in the project to revoke. One additional row belongs to a separate
authorized project. The private server fixture removes the first grant through
its scope resolver; the client receives the ordinary revoked subscription and
applies the shipping purge path. Application SQL and indexes remain unchanged.

The runner checks the revoked subscription and `sync.scope_revoked` reason,
the retained subscription's active state, an empty outbox, the exact retained
row values, and an unchanged server commit sequence. It closes the client and
opens a new process with the same identity and SQLite file. Purged rows must
remain absent before and after another sync. Grouped counts keep validation
responses bounded at 100,000 rows; the retained-row comparison transfers one row.

Grant removal completes before timing. The operation timer covers the explicit
sync round, including server authorization and local purge. Automatic discovery
of a permission change is outside this workload. Controller elapsed includes
command delivery and receipt. Reopen includes process startup, runtime/module
loading, and client setup.
Validation runs outside purge and reopen timers. Per-client OS resource records
cover each complete process lifetime, including bootstrap and validation.

Five fresh trials per size and boundary produce 45 SQLite-server attempts and
15 Postgres-server attempts. TS uses its direct surface; Rust uses direct and
shared-command surfaces. The Postgres profile uses 2,000 revoked rows and
Postgres 18.6 with default durability. Clients report file SQLite with WAL and
`synchronous=FULL`: SQLite 3.54.0 for TS and 3.46.0 for Rust. Rust uses a locked
release build. All artifacts have the same source fingerprint and all Rust runs
use the same executable hash.

| Server / client boundary | 2,000 rows (ms) | 10,000 rows (ms) | 100,000 rows (ms) |
| --- | --- | --- | --- |
| SQLite / TS direct | 2.407 | 5.843 | 84.431 |
| SQLite / Rust direct | 1.938 | 9.412 | 57.609 |
| SQLite / Rust command | 1.497 | 8.647 | 47.314 |
| Postgres / TS direct | 5.621 | Not run | Not run |
| Postgres / Rust direct | 4.185 | Not run | Not run |
| Postgres / Rust command | 5.499 | Not run | Not run |

These are medians of client operation time across five independent trials.
The profiles ran sequentially on the local host; they establish an initial
regression record and do not attribute differences between boundaries to router
cost. They are not a before/after optimization result or a calibrated CI latency
budget. All 60 attempts validate, covering 1,710,000 revoked rows and 60 retained
rows. The summary preserves every sample, controller and reopen timings, SQLite
versions, resource boundaries, and raw artifact hashes.

The 100,000-row SQLite profile records median reader lifetime peak RSS of
100.78 MiB for TS, 21.16 MiB for Rust direct, and 21.08 MiB for Rust command.
These high-water marks include bootstrap, runtime overhead, validation, and
shutdown. They do not isolate purge allocations.

Benchmark CI now runs the 2,000-row TS purge case. The explicit Postgres matrix
adds five purge/reopen trials for each client core. Five focused purge contracts
cover CLI constraints, the private control endpoint's fixture restriction, and
TS/Rust direct/command persistence. Together with the existing process contracts,
all 15 explicitly enabled tests pass. The root gate passes 1,771 tests with 20
explicit skips, 13 isolated multi-tab tests, and both Node runtime contracts.
Benchmark CI, workflow lint, and the 58-page docs build pass. Production server,
client, Rust, and binding sources remain unchanged from §9.35.

The six raw artifacts are `bench/results/purge-{ts,rust-direct,rust-command}-{sqlite,postgres}.json`;
`purge-summary.json` verifies and aggregates them. Sources, the native executable,
artifacts, scripts, and verification logs are archived under
`bench/results/verification-2026-09-08-purge/`. The owned Postgres instance had
zero remaining benchmark schemas; its container and anonymous volume were removed.
Hosted CI has not run. Native engine transport, language runtime profiles,
remaining attribution and regression coverage, and controlled-runner calibration
remain open, including the cursor-update replay regression in §§9.34–9.35.


### 9.37 Swift SDK read boundary

The read runner now accepts `--binding swift` with Rust, FFI, socket, and macOS.
It compiles the shipping Swift SDK as a separate optimized module and links a
private executable that implements the existing benchmark process protocol.
The executable calls `SyncularClient.query` and `querySnapshot`; it forwards
setup and validation through the shipping command API. Production SDK and Rust
sources remain unchanged in this step. No raw SQLite access or timing command
was added to the public API.

The runner builds `syncular-ffi` in release mode with locked Cargo dependencies
and `native-transport`. Swift uses `-O` and Swift 5 language mode. The artifacts
record the Swift compiler, exact compilation commands, executable hash, source
hashes including bindings, and both library paths and hashes. The process lists
its actual dyld images, and the controller verifies them against the build.
Cargo's native library loads from `rust/target/release/deps`; the first two smoke
attempts rejected an expected path that omitted `deps`. Those failed attempts
remain archived. The final profiles use the verified loaded path.

Swift 6.3.3 and Rust 1.96.0 ran on the local Apple M4 host. Both storage profiles
use SQLite 3.46.0 with FULL durability, WAL for files and the memory journal for
in-memory replicas. Five fresh trials for each 1k/10k/100k fixture in each storage
mode produce 30 successful attempts and 12,000 timed reads. Each trial has three
warmup cycles followed by 100 iterations of each query/snapshot surface, with
alternating surface order. Both profiles use identical source, executable, and
library hashes. SQL, schema, application indexes, and generated rows match the
existing TS and Rust read fixtures.

| Storage / rows | Point query (µs) | Point snapshot (µs) | 100-row query (µs) | 100-row snapshot (µs) |
| --- | --- | --- | --- | --- |
| File / 1,000 | 23.583 | 30.083 | 505.458 | 509.354 |
| File / 10,000 | 23.625 | 29.771 | 501.500 | 509.875 |
| File / 100,000 | 25.771 | 32.125 | 508.396 | 514.209 |
| Memory / 1,000 | 19.542 | 25.625 | 506.812 | 513.813 |
| Memory / 10,000 | 19.959 | 26.062 | 502.979 | 510.374 |
| Memory / 100,000 | 21.750 | 28.459 | 504.458 | 515.021 |

Each value is the median of five trial medians. These are initial Swift SDK
measurements. They do not establish a before/after gain or isolate the Swift
wrapper by subtracting a separate Rust FFI profile. The samples include
Foundation request encoding, serial command dispatch, C ABI execution and
diagnostics, response decoding, and SDK result materialization. Snapshot timing
also includes extracting its row array. Exact-row comparison, revision and
coverage checks, and autorelease-pool drain follow the timer. The SDK's event
poll loop remains active, with a dedicated serial delivery queue and no
application callback. UI rendering is outside the profile.

Bootstrap, query plans, configuration/schema reads, whole-fixture validation,
controller IPC, and report construction are outside individual read samples.
Process elapsed includes these costs. Per-process CPU and peak RSS cover the
complete client lifetime. At 100k rows, median peak RSS is 328.45 MiB for file
storage and 342.84 MiB for memory storage. Those peaks include transferring and
validating the whole fixture and cannot describe the bounded read's allocation
cost. The artifact summary retains operation samples, trial medians, their
ranges, fixture digests, and resource boundaries.

Focused contracts verify memory/file durability, exact agreement with the TS
fixture, both Swift read surfaces, preserved revisions, and rejection of a
mismatched loaded-library hash. The combined TS/Rust direct/command/FFI/Swift
read and CLI contracts pass all 14 tests. The root gate passes 1,772 tests with
22 explicit skips, 13 isolated multi-tab tests, and both Node runtime contracts.
Benchmark CI passes every budget, and the docs build produces 58 pages. Swift
is an explicit local profile and does
not silently replace a missing macOS runtime in default CI.

Run `bun run bench --workload read --core rust --boundary ffi --binding swift
--lane socket --storage file --iterations 100 --trials 5` from the repository
root. Raw profiles and their checked summary are
`bench/results/swift-read-{file,memory,summary}.json`; sources, binaries, build
inputs, failed smoke attempts, and verification logs are archived under
`bench/results/verification-2026-09-08-swift-read/`.

Swift blob delivery and the other language runtime profiles remain open.
The native engine transport, remaining attribution and regression coverage,
hosted CI verification, and controlled-runner calibration also remain open.
The cursor-update replay regression in §§9.34–9.35 remains unexplained.

### 9.38 PostgreSQL durability attribution and reusable I/O diagnostics

The cursor-update regression now has PostgreSQL-side execution and WAL evidence.
A dedicated PostgreSQL 18.6 instance runs the frozen server variants from §9.35
and the frozen release Rust client from §9.33. The server variants differ only
in cursor persistence. Each attempt has 2,000 seed rows, 1,000 independent
commits, and file-backed client SQLite with WAL and FULL durability.

The first series contains 40 measured attempts and four warmup attempts. Review
found that its order expression always selected baseline first with synchronous
commit enabled and candidate first with it disabled. Those records remain in
`ack-io-paired-v2/`; they do not establish a counterbalanced comparison. An earlier
configuration-query preflight failed before running a workload because the Bun
SQL driver did not encode an array bind as a PostgreSQL array. Its log and inputs
also remain archived.

The replacement series declares and checks its schedule before running. For
each durability setting, five pairs run baseline first and five run candidate
first. The setting order also alternates. Timestamps verify the recorded order.
The series retains all 40 measured attempts and four warmup attempts in
`ack-io-paired-v3/`. Every attempt validates FIFO prefixes, original IDs, individual
outcomes, the empty writer outbox, and the independent reader digest.

The normal profile keeps `synchronous_commit=on`, `fsync=on`, and full-page writes.
The diagnostic profile changes only `synchronous_commit` to `off` in the owned
database. It investigates commit waits and is excluded from performance
acceptance because it changes the server's durability boundary. Syncular source,
client durability, and application indexes remain unchanged.

| Server commit setting | Writer drain, baseline → candidate (ms) | Reader visibility, baseline → candidate (ms) | Pairs improving drain |
| --- | --- | --- | --- |
| On | 3,294.414 → 2,508.900 | 3,194.438 → 2,391.636 | 8 / 10 |
| Off, diagnostic only | 1,590.799 → 1,569.839 | 1,497.599 → 1,475.499 | 7 / 10 |

Values are medians across independent attempts. Both variants still execute
1,000 writer commit transactions and 1,000 reader cursor writes. Replay query
counts remain exactly 13,024 versus 12,024. The normal profile's median whole-
attempt WAL fsync counts in PostgreSQL client-backend processes are 2,046.5 and
2,047. Their corresponding fsync times are 1,451.448 and 1,210.896 ms. WAL write
time is 16.842 and 13.051 ms. The diagnostic profile records 1–2 client-backend
fsync calls per attempt; PostgreSQL background WAL writing remains separate.

The collector reads cumulative I/O after the benchmark's database sessions exit.
Its interval includes schema creation, bootstrap, validation, and cleanup.
PostgreSQL defines `pg_stat_io.fsync_time` as time waiting for fsync operations;
the WAL row requires `track_wal_io_timing`. These durations overlap the existing
storage and transaction measurements and cannot be added to reconstruct replay
latency. See the [PostgreSQL 18 statistics documentation](https://www.postgresql.org/docs/18/monitoring-stats.html).

`pg_stat_statements` records median cursor-related execution time of 41.850 ms
before the atomic update and 29.449 ms after it with normal durability. The
corresponding statement WAL totals are 218,958.5 and 164,903 bytes. These counts
include registration/setup queries and have a different boundary from the
replay-only storage counters. The extension's execution duration also has a
different boundary from the host executor's awaited call. See
[pg_stat_statements](https://www.postgresql.org/docs/18/pgstatstatements.html).

The current comparison does not reproduce a consistent atomic-update penalty.
Paired changes in drain and whole-attempt fsync time correlate at 0.989 with
normal durability. This is an association within this local series; it does not
prove the cause of every prior slow trial. The retained 15.101-second baseline
attempt also has higher server CPU and statement execution durations across
unchanged code paths. Fsync timing alone does not account for that entire outlier.
The older §§9.34–9.35 runs have no PostgreSQL I/O trace, so their individual causes
remain unproven. Keep controlled-runner verification open and retain the atomic
cursor update's race fix. Further replay work should investigate durable-write
count under §5.2's specification and recovery requirements.

The repository runner now exposes `--pg-io` for explicit Postgres workloads.
It requires an isolated PostgreSQL 18 instance with `track_wal_io_timing=on`,
records settings and before/after WAL and checkpoint views, and waits for other
client connections to exit before taking snapshots. It changes no database
settings, resets no counters, and requires no `pg_stat_statements` extension.
It collects no SQL text. An unsupported configuration, failed observation, or
counter reset marks the attempt failed while retaining its result and error.
The ordinary Postgres profile keeps its existing behavior.

Five fresh trials per core verify the final collector through the repository
CLI, with normal server durability and the same 1,000-commit fixture. All ten
attempts pass. Median operation drain is 2,544.509 ms for TS and 2,445.994 ms for
Rust; reader visibility is 2,421.555 and 2,337.579 ms. Both have a median 2,046
whole-attempt PostgreSQL client-backend WAL fsync calls. These initial diagnostic
profiles do not establish a before/after optimization gain.

The focused suite passes seven tests, including explicit CLI selection, counter-
reset rejection, missing views, durable PostgreSQL writes, and collection after
owned server sessions close. The root gate passes 1,774 tests with 23 explicit skips, 13
isolated multi-tab tests, and both Node runtime contracts. Benchmark CI passes
every budget, and the docs build produces 58 pages. Production server, client, Rust, and binding sources remain unchanged
from §9.37; this step changes benchmark instrumentation and documentation.

Run `bun run bench --workload replay --lane socket --backend postgres --storage
file --sizes 1000 --trials 5 --pg-io` with `SYNCULAR_PG_URL` pointing at the
isolated instance. Final collector profiles are `bench/results/pg-io-{ts,rust}.json`.
`pg-io-summary.json` verifies them; `ack-io-balanced-summary.json` retains every
counterbalanced result and `ack-io-summary.json` retains the first series.
The source snapshot, scripts, frozen clients and servers, failed preflight,
all attempts, and verification logs are archived under
`bench/results/verification-2026-09-08-ack-io/`.

The owned PostgreSQL instance had zero remaining benchmark schemas and no other
client connections at cleanup. Its container and anonymous volume were removed.
Hosted CI and controlled-host calibration remain unverified.

### 9.39 Rust in-process engine replay, 2026-09-08

Rust replay now accepts `--lane engine` with direct or shared-command operation
timing. The existing Rust benchmark command implementation lives in a library
used by both the stdio binary and a private benchmark cdylib. The binary retains
shipping HTTP/WebSocket transport. Each engine client runs on a Bun worker in
the server/controller process, with a thread-affine Rust handle and a synchronous
host callback. The main thread runs the real async server while the worker waits
on a shared response buffer. Shipping FFI APIs and client/server production
sources remain unchanged from §9.38.

`bench/src/engine-driver.ts` uses the existing sync and segment handlers. Realtime
rounds pass through the actual hub session, including channel tags, streamed
response assembly, registration refresh, and acknowledgement handling. The
shared SSP2 scanner checks response completion. Deltas and control events enter
a bounded queue, and the Rust client waits on event readiness before applying
them. Both the response buffer and inbound queue have a 32 MiB cap. The native
side rejects malformed lengths, event kinds, UTF-8, and host errors. A close
wakes an active readiness wait, allows the native command to return, then frees
the client, callback, and library on the owning worker.

The private transport rejects replacement and signed URL fetching. Other Rust
engine workloads remain unsupported. `runProcessReplay` supplies the same
fixture, construction/sync loops, exact commit IDs, FIFO prefixes, independent
reader validation, and SQLite durability checks to both Rust lanes. No socket
or stdio carries engine client/server requests. The private C ABI exists only
in the unpublished benchmark crate.

Direct native operation timers include callback scheduling, SSP2 copies, and
server work. Outer command JSON and worker delivery remain outside them.
Artifacts record host calls, transferred bytes, callback elapsed time, the
private library hash, shared process ID, and distinct Rust thread IDs. Callback
time overlaps operation time. `serverMetrics` CPU and RSS cover the shared
process, including both clients and controller; `clientResources` is empty.
These measurements do not describe the shipping FFI boundary.

Ninety fresh attempts pass on macOS with Bun 1.4.0 and SQLite. The persistent
profiles run five trials per 100/500/1,000/10,000-commit queue, both edit patterns,
and both direct/command modes, with 2,000 seeded rows. Ten additional direct
memory trials cover the two patterns at 1,000 commits. Persistent clients use
WAL and `synchronous=FULL`; memory clients also retain FULL. Every attempt
validates original commit IDs, individual applied outcomes, a drained writer,
server sequence, and exact rows on writer and reader. All six profiles have the
same source fingerprint and private library hash.

| Persistent queue | Direct drain median | Direct reader median | Command drain median | Command reader median |
| --- | --- | --- | --- | --- |
| 1,000 independent commits | 90.328 ms | 144.620 ms | 107.937 ms | 201.258 ms |
| 1,000 repeated edits | 77.163 ms | 149.531 ms | 65.424 ms | 136.860 ms |
| 10,000 independent commits | 3,079.598 ms | 3,037.759 ms | 3,424.319 ms | 3,583.680 ms |
| 10,000 repeated edits | 958.171 ms | 1,769.058 ms | 824.782 ms | 1,353.975 ms |

These are initial engine baselines. Mode profiles ran sequentially on the shared
local host, without paired mode order, so their differences do not isolate
command-router overhead or establish an optimization gain. Reader visibility and
writer drain have independent completion points. The direct memory drain
medians are 88.747 ms for independent commits and 64.072 ms for repeated edits;
reader medians are 94.131 and 80.059 ms. No socket/engine speedup is inferred
from these separate runs.

Six focused engine contracts cover CLI selection, both timed boundaries,
same-process identities, 501-commit replay with 500/1 request prefixes,
persistent reopen, transport replacement, propagated storage failures, and
cancellation after confirmed host readiness. The native socket/read/blob suite
and engine contracts together pass 44 tests with two explicit Swift skips.
Eight Rust benchmark tests pass, including private ABI ownership and malformed
host responses; Clippy passes with warnings denied. The full root gate passes
1,775 tests with 28 explicit skips, 13 isolated tests, and both Node runtime
contracts. The first root run retained an obsolete expectation that Rust engine
replay was unavailable; that assertion now checks unsupported engine fanout.
The repeated gate passes. Benchmark CI passes every budget, the docs build
produces 58 pages, and the curated `bench/RESULTS.md` remains unchanged.

The hosted Rust job now includes the private Linux library contract step. Its
hosted execution and PostgreSQL engine replay remain unverified locally.
Remaining RFC attribution/regression coverage and controlled-runner calibration
stay open. Run `bun run bench --workload replay --core rust --lane engine
--storage file --sizes 100,500,1000,10000 --trials 5`; select `--boundary command`
for the shared router and `--pattern repeated` for repeated edits.

`bench/results/rust-engine-summary.json` verifies every final profile and
records all sizes. The earlier five-trial probe is retained separately in
`rust-engine-first.json`. Sources, the final private library and stdio binary,
all profiles, failed development checks, and final verification logs are
archived under `bench/results/verification-2026-09-08-rust-engine/`.

### 9.40 Independent fanout/reconnect validation and completion audit, 2026-09-08

Both observation runners previously derived expected rows from the writer's
optimistic query result, then compared each reader with that result. Identical
incorrect writer and reader rows could satisfy that comparison. The native
runner also discarded construction IDs, while the TS runner checked selected
fields from the final sync summary. These paths did not prove that the declared
fixture or every original durable outcome survived.

The shared observation fixture now derives bootstrap rows from the declared
seed and final rows from the declared edits. Both runners check every client's
bootstrap, the writer's optimistic rows, and final writer/reader rows against
that fixture. They require distinct construction IDs, every original ID in
newest-first durable journal order, one applied operation at index zero per
commit, empty outboxes, and the exact final server sequence. Artifacts expose
`validation: independent-fixture-and-original-outcomes` and
`validatedCommitIds`.

TS `syncUntilIdle` returns its last round's summary. A final empty round can
therefore report no applied IDs after an earlier successful push. Validation
uses the durable outcome journal, preserving that public behavior. The native
runner additionally retains its aggregate applied-ID check. SQL and journal
validation remain outside observation latency. The additional bootstrap queries
warm client pages before timing, so these profiles have a different preparation
boundary from older writer-relative records.

Ten focused contracts pass. The rejection cases feed the validator identical
incorrect writer and reader rows, missing/duplicated rows, changed retained
rows, wrong journal order, missing/duplicated IDs, rejected outcomes, and wrong
operation indices. Full TS engine/socket and Rust direct/command cases validate
the same independent digest, including fixtures where reconnect inserts rows
beyond the initial dataset and fanout retains untouched rows.

One hundred fresh attempts pass with 2,000 seed rows and file clients. TS engine,
TS socket, and Rust direct socket profiles run five trials each at 1/5/25 readers
for connected fanout and reconnect after 100 writes. Rust command profiles run
five trials at 25 readers for both workloads. All eight artifacts have the same
source fingerprint, and each workload's final digest matches across cores,
lanes, boundaries, reader counts, and trials.

| Profile, 25 readers | Fanout median | Reconnect median |
| --- | --- | --- |
| TS engine | 5.834 ms | 174.910 ms |
| TS socket | 7.541 ms | 162.840 ms |
| Rust socket, direct | 6.635 ms | 22.224 ms |
| Rust socket, command | 6.420 ms | 22.849 ms |

These are fresh validation profiles without paired before/after ordering. TS
observation readers still share one process; Rust observation readers each own
a process. The reconnect difference includes distinct concurrency models and
cannot be assigned solely to core implementation. Normalize socket observation
client isolation before using these workloads for a cross-core attribution
claim. The existing TS engine lane retains its intentionally shared process.

The full root gate passes 1,781 tests with 32 explicit skips, 13 isolated tests,
and both Node runtime contracts. Benchmark CI passes every budget, and the
curated `bench/RESULTS.md` remains unchanged. The docs build produces 58 pages. Native
observation contracts are included in the existing hosted native workload step;
that hosted execution remains unverified. Production package, Rust, and binding
sources match the §9.39 archive. The production sources covered by §9.34's 106
Rust conformance scenarios also remain unchanged; the later Rust engine work
changed only the private benchmark crate.

The raw records are `bench/results/observation-oracle-*.json`.
`observation-oracle-summary.json` verifies all 100 attempts and cross-profile
digests. Source snapshots, profiles, rejected development checks, and final gate
logs are archived under
`bench/results/verification-2026-09-08-observation-oracle/`.

The completion audit distinguishes implemented workloads from missing proof:

| Requirement | Current evidence | Remaining proof or work |
| --- | --- | --- |
| §4.1 repository ownership and entry points | Existing `bench` runner, source fingerprints, private Rust driver, isolated server fixtures | Implemented; no external campaign runtime dependency |
| §4.2 engine/socket/native boundaries | TS engine, both socket cores, Rust engine replay, direct/command/stdio/FFI measurements | Socket observation isolation normalized in §9.41; preserve the remaining declared boundary differences |
| §4.3 workload catalog | Replay, boundaries/rejection, process restart, fanout, reconnect, blobs, permission purge, fixed-schema reads | §§9.49–9.50 complete the SQLite regression comparisons; final Postgres checks and controlled-runner calibration remain |
| §4.4 artifact completeness | Raw attempts, source/build identity, validation digests, phase/resource boundaries | §9.47 records and validates every client, reopened process and server database across all selected workloads; 34 CLI cases cover SQLite, Postgres and Swift |
| §5 replay attribution | SQL/transaction counters, 95,000 pending rows at 10k commits, Postgres WAL I/O, local acknowledgement transaction counts | §9.45 measures native pending-replay CPU, decode, upsert and observation phases; §9.46 reduces scope-lookup CPU; §9.48 adds TS stack attribution and paired profiler overhead; §§9.49–9.50 complete local SQLite acceptance |
| §§5.2–5.3 replay changes and semantics | Incremental Rust append, fewer server SQL calls, batched local acknowledgements, failure recovery, both-core tests and 110-scenario conformance | Final regression comparison must use a frozen combined candidate; older host-time outliers retain their stated limits |
| §6 native command/blob work | Shipping encoding/allocation changes, direct/command/C ABI profiles, shared ownership/error tests, binding gates | §9.45 separates native download, validation, cache insertion/read and hex encoding; retain explicit unmeasured language-runtime limits |
| §7 reconnect/fanout work | WAL, clean Rust apply, readiness-driven native I/O, independent fixture checks | Isolation normalized in §9.41; §9.43 repairs transaction parity and records 105 transaction completions per reconnect reader in both cores. §9.44 reduces native pending overlay work; §9.45 measures native decode, apply, observation and cursor phases. Final combined acceptance remains |
| §8 structural CI and correctness | Reduced workloads and local gates pass; Postgres job and native contracts exist | Hosted job execution, controlled-runner calibration, and the final controlled regression comparison remain unverified |
| §8 docs and release scope | Repository instructions, docs site, changelog, and implementation record updated | No commit, push, release, or publication has occurred |

### 9.41 Isolated socket observation clients and SQLite metadata, 2026-09-08

TS socket fanout/reconnect now uses the same process runner as Rust. The former
native observation module becomes `bench/src/process-observation.ts`; every
writer and reader owns a distinct process, and the server retains its separate
process. TS engine observation retains its shared process. The CLI routes socket
workloads to the process runner and records the execution model explicitly.

The TS process driver adds the private disconnect and durable-journal commands
needed by that runner. Explicit sync waits for any existing automatic catch-up;
an explicit-sync guard prevents the sync-needed callback from starting a second
drive. Disconnect removes the callback, waits for the current drive, then closes
the realtime connection before the offline writer proceeds. These coordination
changes remain inside the benchmark driver. Production clients, server code,
wire behavior, and shipping bindings are unchanged from §9.40.

Both observation runners now record `clientSqlite` for every client: identity,
process ID, SQLite version, journal mode, and synchronous setting. Persistent
clients must report WAL/FULL, and memory clients must report memory/FULL.
Socket artifacts also record per-client lifetime CPU and peak RSS. Metadata
queries run before bootstrap/timing, and the independent fixture, original
outcome journal, final sequence, and empty-outbox checks remain in place.

Twenty-five focused contracts pass, including existing replay/restart cases,
TS engine/socket observation, both native command boundaries, and four actual
TS CLI cases covering fanout/reconnect with file/memory storage. They verify
that socket client PIDs differ from each other and the controller, that resource
and SQLite metadata identify the same processes, and that weakened or malformed
SQLite settings fail. The full root gate passes 1,786 tests with 32 explicit
skips, 13 isolated tests, and both Node runtime contracts. Benchmark CI passes
every budget without changing `bench/RESULTS.md`.

A paired experiment compares the prior shared-process TS socket runner from
§9.40 with the isolated runner. Both retain the independent fixture checks and
use the unchanged real server and production clients. Ten AB/BA pairs per
workload use 25 readers, 2,000 seed rows, file storage, and SQLite server storage.
Workload order alternates; four warmup attempts remain separate from the 40
measured attempts. Every attempt passes. The first runner launch failed module
resolution before the workload began; its log is retained separately.

| TS socket workload, 25 readers | Shared-client median | Isolated-client median | Pairs with lower isolated time |
| --- | --- | --- | --- |
| One-write fanout | 9.130 ms | 12.029 ms | 1/10 |
| Reconnect after 100 writes | 166.944 ms | 138.383 ms | 10/10 |

This comparison measures a harness execution change, including process-driver
coordination, preflight metadata, and controller delivery. It does not establish
a shipping optimization. The retained 936.781 ms shared reconnect outlier and
both fanout outliers remain in the raw data. Isolation reduces this sample's
reconnect median by 17.1%, while fanout rises by 31.8%. The changed concurrency
model explains part of the former comparison's setup difference; it does not
explain the whole TS/Rust reconnect gap.

Sixty additional fresh socket attempts cover both cores, 1/5/25 readers,
fanout/reconnect, and five trials per case. All use direct operations, 2,000 seed
rows, and file clients. Both cores pass identical fixture digests and report
WAL/FULL. TS reports SQLite 3.54.0; Rust reports 3.46.0. All four profiles share
one source fingerprint. They are sequential fresh profiles, without paired
cross-core order, and do not isolate any individual engine cost.

| Direct socket profile | Fanout median, 25 readers | Reconnect median, 25 readers |
| --- | --- | --- |
| TS, isolated clients | 11.970 ms | 170.172 ms |
| Rust, isolated clients | 6.837 ms | 28.575 ms |

In the paired isolated reconnect runs, each of the 250 TS reader observations
records exactly 105 SQLite COMMIT calls. The median sum of those calls is
54.930 ms per reader; median controller-observed completion for these nested
reader samples is 127.465 ms. These are 25 reader observations within each of
ten independent trials. COMMIT duration includes storage waits and scheduling,
not only CPU, and overlaps client transactions and elapsed time. Do not add
reader durations or derive a causal percentage from independently aggregated
medians. The native observation trace has no matching durable-COMMIT counter.
Measure that native count and separate response apply, observation, and
controller costs before choosing another transaction change. Any change to
observable batching still requires the specification and both-core conformance
work in §§3, 5.2, and 7.

The paired manifest and all results are in
`bench/results/observation-isolation-paired-v2/`. The failed preflight remains in
`observation-isolation-paired/`. `observation-isolated-summary.json` validates
the 60 final CLI attempts, and `observation-isolation-commit-diagnostic.json`
retains every per-reader transaction sample. Sources, frozen comparison inputs,
all profiles, and gate logs are archived under
`bench/results/verification-2026-09-08-observation-isolation/`.


### 9.42 Native SQL diagnostics and reconnect transaction parity, 2026-09-08

Rust socket fanout/reconnect accepts `--native-sql` at the direct and command
boundaries. The private benchmark crate enables rusqlite trace and transaction
hooks. Each reader records fixed SQL verb counts, pre-commit hook calls, and
rollback hook calls from the reset before reconnect through its acknowledgement
snapshot. Setup and final SQL validation fall outside that interval. SQLite
invokes commit hooks for implicit writes and outermost savepoint releases as
well as explicit commits. A hook runs before commit and cannot prove durability.
The collector records no SQL durations or bound values. SQLite expands parameters
internally for tracing, so instrumented elapsed times include that overhead.

The collector defaults off. Reset clears its interval; disable and destroy remove
its hooks. Enabling it prevents replacement of the current client and use of the
read diagnostic's separate trace callback. The FFI and private engine boundaries
reject this diagnostic. Engine handles can coexist on one thread, while the
stdio driver owns one client per process/thread; this restriction preserves the
thread-local counter's ownership.

Socket observations now retain `reconnectSync.elapsedNs` and its stats. The timer
covers the explicit sync operation after connection setup. The existing
acknowledgement timer begins after explicit sync. Both intervals are nested
within parent elapsed time; neither isolates SQL apply from decoding or transport.
No production client, server, binding, or wire behavior changes in this step.

Forty fresh attempts cover TS direct, Rust direct with counters off/on, and Rust
command with counters on. Each configuration runs five trials at 1 and 25 readers,
with 2,000 seed rows, 100 offline writes, and file SQLite. Configuration order
reverses on alternating trials. All attempts validate the independent fixture,
original commit IDs, empty outboxes, and final sequence, and share one source
fingerprint. Every client reports WAL/FULL. TS uses SQLite 3.54.0 and Rust uses
3.46.0.

All 130 nested TS reader samples record 105 literal COMMIT calls. All 260 nested
instrumented Rust reader samples record five SAVEPOINT statements, five RELEASE
statements, five commit-hook calls, and zero rollback hooks. Rust executes 206
INSERT and 118 SELECT statements in each of those reader intervals. Nested
readers share an independent trial; these counts do not create 390 independent
latency samples.

| Configuration | Readers | All-reader median | Nested explicit-sync median |
| --- | --- | --- | --- |
| TS direct | 1 | 17.433 ms | 15.605 ms |
| TS direct | 25 | 234.062 ms | 208.966 ms |
| Rust direct, counters off | 1 | 4.054 ms | 2.690 ms |
| Rust direct, counters off | 25 | 54.863 ms | 38.210 ms |
| Rust direct, counters on | 1 | 7.333 ms | 5.159 ms |
| Rust direct, counters on | 25 | 29.161 ms | 21.181 ms |
| Rust command, counters on | 1 | 9.462 ms | 6.174 ms |
| Rust command, counters on | 25 | 33.299 ms | 26.178 ms |

These profiles establish counts and reproduce the gap. They do not isolate a
causal time saving. The 25-reader TS ordinary attempts span 191.011–428.084 ms;
Rust ordinary attempts span 22.465–63.264 ms. A Rust command diagnostic attempt
reaches 513.046 ms. The counters-on Rust median being lower than counters-off
also shows that these host timings cannot estimate trace overhead reliably.
Every outlier remains in the artifact.

Source inspection identifies a semantic difference behind the transaction counts.
TS applies each COMMIT through its own `applyCommitFrame` observation transaction.
Rust opens `syncular_section` before `apply_section_body`, applies all COMMIT
frames inside that savepoint, and publishes one revision when the section ends.
The native realtime delta path also wraps the section in `syncular_delta`.
These section boundaries already exist at the review baseline
`f7b94e22764e8aec3d2528ec2858a37be65ca958`; this diagnostic did not introduce them.
SPEC §1.4 rule 4 requires one local transaction per COMMIT, and rule 5 retains
previously committed frames after a later abort. SPEC §7.5 attaches one revision
to each observer-visible transaction.

A separate probe uses the real conformance driver pairings, bootstraps a window,
pushes two independent server commits, and pulls both in one round. Both cores
report two applied commits. TS publishes two task change batches at revisions
9 and 10; Rust publishes one at revision 6. The exact two-batch assertion passes
for TS and fails for Rust. This probe covers successful pull observation; it
does not yet prove the corresponding failure/restart behavior or realtime path.
The existing 106-scenario Rust catalog passes because it lacks this multi-frame
revision assertion.

Repair the native per-frame transaction and observation boundaries against
§1.4, add the probe to the shared catalog, and cover a later failed frame,
persisted cursor, restart, and realtime delta before accepting reconnect results.
Any subsequent transaction coalescing requires an explicit specification change
and matching behavior in both cores. Treat the current native advantage as a
comparison with different transaction semantics until this repair is verified.

The private Rust crate passes ten tests and Clippy with warnings denied. Forty-six
focused benchmark contracts pass with two explicit Swift skips; coverage includes
native direct/command counter intervals, CLI option rejection, default-off
behavior, reset/destroy, nested savepoints, rollback, bound-value omission, read
trace isolation, and the existing engine transport contracts. The root gate
passes 1,787 tests with 33 explicit skips, 13 isolated tests, both Node contracts,
and the existing 106 Rust conformance scenarios. Benchmark CI passes all budgets,
`bench/RESULTS.md` remains unchanged, and the docs build produces 58 pages. These
gates do not include the separate failing parity probe as a catalog scenario yet.

Raw profiles are `bench/results/native-sql-reconnect-*.json`; the summary retains
all reader counters and source hashes. `native-sql-parity-probe.json` records the
new conformance failure. Source snapshots, probe source, raw results, native
executables, and verification logs are archived under
`bench/results/verification-2026-09-08-native-sql/`. The goal remains in progress:
transaction parity, remaining internal phase attribution, final combined
regression comparison, metadata audit, and hosted calibration are unresolved.


### 9.43 Native frame/block transaction parity and replay cost, 2026-09-08

The native client now finishes each COMMIT frame and rows-segment block in its
own observation transaction. Pull and realtime delivery share `apply_commit_frame`;
base rows, visible rows, and the frame revision commit together. A failed frame
rolls back its writes and restores the overlay dirty flag. Earlier committed
frames and revisions survive. SQLite image segments retain one transaction per
image. Fresh-bootstrap clearing shares the first block or image transaction.

Subscription sections no longer wrap those transactions in an outer savepoint.
`apply_sub_end` persists the cursor, resume state, and completed window coverage
in a separate trailer transaction. Failed persistence restores the previous
in-memory subscription. Decoded in-band errors retain the applied prefix and
leave the cursor unchanged. The realtime path requests catch-up after a failed
frame and does not acknowledge its unapplied trailer. Subscription persistence
now returns its SQLite error; reset and revocation restore their rows, pending
outbox, report entries, and in-memory state when their transaction fails.

SPEC §1.4 now explicitly prohibits an outer subscription transaction from
deferring frame/block commits and ties each observer-visible frame/block to its
own revision. This clarifies the existing rule. The TS implementation already
uses those boundaries. Four shared scenarios cover two remote COMMIT frames,
two frames combined into one actual realtime delta, two inline bootstrap blocks,
and a malformed row late in the second frame. The last scenario checks the
committed prefix, unchanged cursor, recreation, and successful repull. The
catalog now contains 110 scenarios.

Native file tests inject row decoding, revision persistence, deferred-constraint
commit, cursor persistence, and decoded in-band/trailer failures. They verify
base and visible rows, row revisions, acknowledgement behavior, closed SQLite
transactions, file reopen, and retry. Additional tests cover first-block clearing,
a later block rollback, and reset/revocation persistence failures. Realtime
failure also publishes the separate sync-needed status revision; the tests
identify row revisions separately from that status event.

The frozen previous native binary from §9.42 and the corrected release binary
run through the same current repository socket runner. Five alternating pairs
per case use 2,000 seed rows, SQLite server storage, and WAL/FULL file clients.
Ten warmup attempts are retained separately from the 50 measured attempts.
Every attempt validates its fixture, original outcomes, and final sequence.
The baseline still has the transaction discrepancy documented in §9.42; this
comparison measures the repair's cost.

| Native workload | Previous median | Corrected median |
| --- | --- | --- |
| Reconnect, 1 reader | 3.481 ms | 10.488 ms |
| Reconnect, 25 readers | 22.963 ms | 142.062 ms |
| Connected fanout, 25 readers | 6.150 ms | 6.784 ms |
| 1,000 independent writes, drain | 109.903 ms | 996.563 ms |
| 1,000 repeated writes, drain | 87.539 ms | 953.815 ms |

The fanout median rises 10.3%, and four of five pairs are slower. One-frame
delivery now persists the frame and subscription trailer separately. Replay
and reconnect regress in all five pairs. These costs require investigation
under §8. Preserve per-frame durability during subsequent optimization; the
previous section transaction violates the contract.

Twenty additional fresh CLI attempts cover TS ordinary reconnect and native
reconnect with SQL counters at 1 and 25 readers, five trials per case. Both
cores validate the same digest and report 105 transaction completions per
reader: literal COMMIT calls in TS and pre-commit hooks in Rust. Their 25-reader
medians are 145.432 ms and 150.294 ms respectively. These separate profiles have
different instrumentation and do not establish equal core CPU cost, but the
previous multi-fold native advantage does not appear in this sample.

Twelve further count-only attempts use the repository replay runner with its
writer counter reset changed to enable `sqlCounts`. The archived diagnostic
copy rebases imports and enables this private flag; workload and validation
remain unchanged. Three trials per variant and write pattern produce identical
counts within each variant:

| Native writer interval, 1,000 writes | Previous | Corrected |
| --- | --- | --- |
| Pre-commit hooks | 7 | 1,007 |
| INSERT statements | 2,511 | 254,007 |
| DELETE statements | 1,002 | 1,501 |
| SAVEPOINT / RELEASE statements | 9 / 9 | 1,508 / 1,508 |

All 12 attempts have zero rollback hooks and validate all 1,000 original commits.
Tracing expands SQL internally, so these diagnostic timings are excluded from
the comparison above. The writer receives acknowledgements in 500-operation
prefixes. Its first prefix leaves 500 pending commits. Each subsequent incoming
frame currently rebuilds the dirty visible overlay, copying the base table and
replaying pending operations before publishing that frame's revision. The
one-table fixture's DELETE counts, including 1,000 outbox deletes, are consistent
with 501 full overlay clears versus two previously. The INSERT counts establish
substantial repeated work beyond the required extra durable transactions.
Direct CPU attribution remains open. The next optimization should reduce this
repeated overlay work while preserving independent frame rollback and revisions.

The full Rust workspace tests and Clippy pass. The root gate passes 1,795 tests
with 33 explicit skips, 13 isolated tests, both Node contracts, and all 110 Rust
conformance scenarios. Fifty-one focused benchmark contracts pass with two
explicit Swift performance-test skips; they cover reads, replay/restart, blobs,
purge, observation, and the private engine transport. Benchmark CI passes all
budgets without changing `bench/RESULTS.md`; the docs build produces 58 pages.
Swift's binding gate passes 11 tests. Tauri and React Native gates pass. Kotlin
and Flutter verify generated-source freshness, then skip their runtime checks
because a suitable JDK/Gradle and Dart SDK are unavailable in the current shell.
Device builds and hosted CI remain unverified.

Raw comparisons and their source/binary identities are in
`bench/results/frame-parity-paired/`. The fresh profiles are
`frame-parity-final-{ts,rust}-reconnect.json`; writer counts are retained in
`frame-parity-replay-counts-*.json`. Source snapshots, binaries, all attempts,
failed development checks, and successful gate logs are archived under
`bench/results/verification-2026-09-08-frame-parity/`. Replay optimization,
remaining phase attribution, final combined regression acceptance, metadata
audit, and hosted calibration remain open.


### 9.44 Incremental native pending-row reconciliation, 2026-09-08

The Rust client now reconciles a clean optimistic overlay by changed primary
key when every table touched by an incoming frame has no secondary unique
constraint. It applies the frame to base and visible rows, then replays only
pending operations for those keys, in their original FIFO order. The frame's
existing observation transaction contains that work. Other pending rows keep
their visible values. This extends the existing clean-replica apply path;
SSP2, public APIs, revision boundaries, and application indexes remain unchanged.

Secondary unique constraints create dependencies between primary keys. A
remote update to row B can free a value needed by a pending write to row A,
or occupy that value and make the pending write fail. Frames touching those
tables retain complete FIFO replay. Dirty overlays and queue removals also
retain their existing rebuild. The new algorithm still scans the pending
queue for matching keys and replays every matching operation; it does not
coalesce repeated writes or remove their identities.

Three native tests cover the change. A differential test compares 160 frames
with forced full replay, including multi-operation pending commits, deletes,
scope changes, multiple tables, unique constraints, FTS contents and search,
base and visible versions, and observation batches. A separate unique-value
test proves that a remote change to row B reconsiders row A's pending write
in both directions. Injected visible-write, revision-persistence, and deferred
commit failures prove frame rollback, preserved queue identity, and retry.

The final comparison uses the frozen §9.43 binary as its baseline. Both binaries
preserve per-frame transactions. Five alternating pairs per case use the same
repository socket runner, 2,000 seed rows, SQLite server storage, and WAL/FULL
file clients. Ten warmup attempts are retained separately from the 50 measured
attempts. Each attempt validates original outcomes and the independent fixture.

| Native workload | Baseline median | Candidate median | Change |
| --- | --- | --- | --- |
| 1,000 independent writes, writer drain | 902.483 ms | 163.730 ms | −81.9% |
| 1,000 repeated writes over 32 rows, writer drain | 888.396 ms | 151.743 ms | −82.9% |
| Reconnect, 1 reader | 10.364 ms | 10.518 ms | +1.5% |
| Reconnect, 25 readers | 154.862 ms | 156.596 ms | +1.1% |
| Connected fanout, 25 readers | 6.537 ms | 6.387 ms | −2.3% |

The candidate drains faster in all five pairs for each replay pattern. Reader
visibility medians fall from 881.567 to 145.611 ms for independent writes and
875.306 to 136.117 ms for repeated writes. These results measure this change
against §9.43; they are not a combined RFC gain or an external campaign result.

Writer process-lifetime CPU medians fall from 871.003 to 168.441 ms and from
834.136 to 139.337 ms respectively. That boundary also includes bootstrap,
queue construction, and validation. It does not directly attribute pending
replay CPU. Writer peak RSS medians remain between 18.1 and 18.4 MB across
these replay variants; the workload reports no storage-size comparison.

Twelve separate count-only attempts use the repository replay runner with its
existing writer reset configured to enable native SQL counts. Three trials per
variant and pattern produce identical counts within each variant:

| Native writer interval, 1,000 writes | Baseline | Independent candidate | Repeated candidate |
| --- | --- | --- | --- |
| Pre-commit hooks | 1,007 | 1,007 | 1,007 |
| INSERT statements | 254,007 | 4,507 | 12,299 |
| DELETE statements | 1,501 | 1,002 | 1,002 |
| SAVEPOINT / RELEASE statements | 1,508 / 1,508 | 1,009 / 1,009 | 1,009 / 1,009 |

All count-only attempts validate all 1,000 outcomes and have zero rollback
hooks. The remaining two overlay clears occur during queue reconciliation.
Commit hooks retain the same count; the reduction removes overlay SQL inside
those transactions. Hooks run before commit, so successful durability is
established by the transaction and recovery tests. SQL tracing expands
parameters internally; diagnostic timings are excluded from latency claims.

The root gate passes 1,795 tests with 33 explicit skips, 13 isolated tests,
both Node runtime contracts, and all 110 Rust conformance scenarios. Full Rust
workspace tests and Clippy pass; the client has 68 tests with workspace features.
Fifty-one focused benchmark contracts pass with two explicit Swift performance
skips. Benchmark CI passes all budgets and preserves `bench/RESULTS.md`; the
docs build produces 58 pages. Swift passes 11 binding tests, and Tauri and
React Native gates pass. Kotlin and Flutter verify generated-source freshness
but skip runtime checks because their required SDKs are unavailable. Device
builds and hosted CI remain unverified.

Final paired artifacts are under `bench/results/pending-overlay-final-paired/`.
Final SQL counts use `pending-overlay-final-replay-counts-*.json`. The archive
`bench/results/verification-2026-09-08-pending-overlay/` retains source identities,
final binaries, attempts, and gate logs. Preliminary runs preceded the added
unique-value regression test; they are retained as development evidence and
excluded from the final comparison. Remaining work includes direct phase
attribution, metadata coverage, the frozen combined regression comparison,
and controlled-runner calibration. Secondary-unique-table and single-row
pending replay costs require their own measurements before further changes.


### 9.45 Private native phase attribution, 2026-09-08

The private Rust `bench-internals` feature now contains an opt-in per-client
recorder. Normal builds compile out its state, guards, and CPU-clock dependency.
`--native-phases` enables it for Rust socket replay, restart, commit-boundaries,
fanout, reconnect and blob workloads with direct or command calls. Linux and
macOS use their calling-thread CPU clock; an unavailable clock fails the
explicit request. The shipping command/FFI contract and SSP2 remain unchanged.
The FFI benchmark boundary rejects this option.

Each fixed phase name reports call count, inclusive elapsed nanoseconds,
calling-thread CPU nanoseconds, and attempted pending-operation count. Failed
calls count. A reset advances the recorder generation; an old open span cannot
enter the new interval. Each client owns its state, so engine worker or client
replacement cannot mix clients' phase counters. Values, row IDs, URLs and SQL
never enter the phase snapshot. The repository README defines each boundary.

Replay and observation capture writer and reader intervals after setup and
before validation. Blob measurements enable a fresh interval around each
operation and capture separate download, cache-hit, interrupted and recovery
snapshots. Staging retains its existing operation timer but has no internal
phase entries. Extra stats RPCs sit outside operation and delivery timers.
SQL diagnostics now also support socket replay, restart and commit-boundaries,
so these workloads no longer require a diagnostic copy of their runner.

The overhead experiment freezes the §9.44 binary and compares it with the
current private binary with phases disabled and enabled. Seven cases have five
fresh trials per variant, with counterbalanced case/variant order. Twenty-one
warmup attempts are retained separately from 105 measured attempts. Both current
variants use the same binary. Every replay validates original outcome identities,
FIFO boundaries and final rows; observation uses its independent fixture;
blobs validate two distinct content addresses, pins, cache state and recovery.

| Workload | Frozen baseline | Phases disabled | Phases enabled |
| --- | --- | --- | --- |
| Independent replay, 1,000 commits | 183.081 ms | 172.862 ms | 197.195 ms |
| Repeated replay, 1,000 commits | 220.527 ms | 212.462 ms | 189.704 ms |
| Independent replay, 10,000 commits | 4,327.445 ms | 5,065.372 ms | 4,456.661 ms |
| Repeated replay, 10,000 commits | 3,617.691 ms | 3,735.381 ms | 4,314.175 ms |
| Reconnect, 25 readers | 183.872 ms | 168.851 ms | 187.330 ms |
| Connected fanout, 25 readers | 7.219 ms | 8.742 ms | 7.342 ms |
| Fresh 2 MiB download | 26.996 ms | 25.881 ms | 25.931 ms |

Replay values are writer drain, observation values are all-reader completion,
and each blob trial contributes its mean fresh-download time across two objects.
These are medians across five independent trials. Enabled timing includes the
clock/counter cost, including nested guards. Its apparent improvement in some
cases indicates timing variability; this table does not establish a precise
overhead percentage or a shipping speed improvement.

The two disabled-versus-baseline medians above 10% triggered a separate ten-pair
AB/BA comparison with unchanged fixtures and binaries. Fanout medians were
7.229 ms baseline and 6.868 ms disabled, with five of ten candidate pairs faster.
Independent 10,000-commit replay measured 4,668.743 ms baseline and 4,530.413 ms
disabled, with six of ten candidate pairs faster. Neither median regression
reproduced. All 40 measured attempts and four warmups remain in the record.
One disabled attempt took 16,560 ms. A concurrent host snapshot recorded load
average 10.45 and 20,788 MiB of used swap with other CPU-active processes.
That snapshot documents contention but does not establish the outlier's exact
cause. These local runs cannot calibrate a controlled-runner wall-clock budget.

Native attribution uses the enabled profiles. The following CPU values are
inclusive medians across five trials; overlapping rows must not be summed.
Pending-operation counts are identical across the five trials per replay case.

| Writer phase | Independent 1k | Repeated 1k | Independent 10k | Repeated 10k |
| --- | --- | --- | --- | --- |
| Request preparation | 0.374 ms | 0.376 ms | 3.607 ms | 3.544 ms |
| SSP2 response decode | 0.327 ms | 0.511 ms | 3.601 ms | 3.620 ms |
| Row decode | 0.316 ms | 0.299 ms | 2.934 ms | 3.132 ms |
| Observation preparation | 15.362 ms | 4.498 ms | 1,051.210 ms | 49.756 ms |
| Observation persistence/publication | 36.741 ms | 37.781 ms | 545.200 ms | 406.259 ms |
| Pending iteration/application | 4.098 ms | 14.399 ms | 723.998 ms | 2,676.374 ms |
| Pending operations attempted | 500 | 8,292 | 95,000 | 1,576,334 |

The pending phase includes changed-key filtering, value conversion, SQLite
writes and nested instrumentation. Upsert-helper CPU at 10,000 repeated commits
is 1,347.218 ms and overlaps pending replay. The observer preparation method
reads current scopes through `record_row_scopes`; its primary-key predicate
casts the column to text. Its query plan and repeated preparation are the next
specific investigation for independent-row scaling. A primary-key lookup change
must preserve row-ID matching and invalidation semantics. The repeated-row case
still performs every matching FIFO operation and requires its own optimization
proof before coalescing work.

For 25-reader reconnect, each trial contributes its median reader. Observation
persistence/publication measures 126.134 ms elapsed and 29.385 ms calling-thread
CPU; the encompassing frame-apply phase measures 128.838 ms and 31.969 ms.
The elapsed-versus-CPU difference includes waiting and scheduling and does not
by itself identify filesystem latency. SSP2 decode is 0.071 ms elapsed and
0.053 ms CPU per median reader in this fixture.

For a fresh 2 MiB blob, per-trial means across the two objects produce these
median phase values:

| Phase | Elapsed | Calling-thread CPU |
| --- | --- | --- |
| Download | 2.919 ms | 0.674 ms |
| Content-address verification | 3.629 ms | 3.629 ms |
| Cache insertion/refcounts/retention | 13.197 ms | 12.333 ms |
| Cache read/materialization | 2.628 ms | 2.604 ms |
| Hex encoding within materialization | 1.707 ms | 1.702 ms |

Cache reads include the initial miss and final materialization; encoding is
nested inside materialization. Cache insertion includes refcount reconciliation
and retention work. Cache-hit snapshots have no download phase. Interrupted
body snapshots have a failed download phase and no cache insertion, and recovery
records a fresh successful download. These measurements attribute the direct
native path; they do not establish identical binding delivery costs.

The root gate passes 1,797 tests with 34 explicit skips, 13 isolated tests, both
Node runtime contracts, and all 110 Rust conformance scenarios. Seventy-four
focused benchmark contracts pass with two explicit Swift performance skips.
The full Rust workspace tests and Clippy pass, including 69 client tests and
11 private benchmark tests. The recorder test covers opt-in state, isolation,
nested intervals and reset generations; the driver checks failed-call capture
and FFI rejection. CLI tests validate a 501-commit pending prefix, phase metadata,
SQL counts, and both observation/blob command boundaries. Benchmark CI passes
all budgets; the docs build produces 58 pages. Swift passes 11 tests, Tauri and
React Native gates pass, and Kotlin/Flutter verify generated-source freshness
while skipping runtime checks for unavailable SDKs. Device builds and hosted
CI remain unverified.

Raw results are in `bench/results/native-phases-paired/` and
`bench/results/native-phases-disabled-followup/`; `native-phases-summary.json`
contains phase medians with explicit millisecond fields. Source/binary identities,
all attempts, the host snapshot, and verification logs are retained in
`bench/results/verification-2026-09-08-native-phases/`. Remaining work includes
TS phase attribution, runtime/database metadata coverage, the frozen combined
regression comparison, and controlled-runner calibration. The measured 10k
scope lookup and pending replay costs now have specific follow-up evidence.


### 9.46 Native row-ID predicates and cached lookups, 2026-09-08

The §9.45 scope profile identified a native primary-key predicate that casts the
stored column to text. SQLite scans the table for that expression. Scope lookups
also prepared the same statement repeatedly. The TS scope path already compares
the key directly.

The Rust client now adds an indexed equality alongside the existing text check
for string, JSON, integer and boolean primary keys. Native application columns
have no declared SQLite affinity. Integer and boolean predicates therefore cast
the bound row-ID string to INTEGER and apply unary `+` to remove expression
affinity while preserving the integer value. Without that unary operator,
SQLite still scans the typeless key. The residual text check excludes alternate
numeric spellings such as `01`, `+1` and `1e0`. Floating-point keys retain the
original predicate: distinct REAL values can produce the same text, so adding
numeric equality would change which rows match.

A search for equivalent predicates found five call sites. The shared lowering
now covers scope reads, CRDT row reads, base deletes, mirrored visible deletes
and pending deletes. Those statements use the existing prepared-statement cache.
The change adds no schema, index or wire behavior and leaves SYQL lowering
unchanged.

The native test compares the old and new matches on both base and visible tables,
checks scope batches and actual deletes, and verifies the query plans. Cases
include integer limits, leading zeros, alternate numeric spellings, JSON keys,
Unicode and embedded NUL strings. It preserves the floating-point collision
between `1.0` and `1.0000000000000002`. The first development attempts exposed
integer bind-type mismatch and then expression affinity; their rejected test
logs are retained with the successful unary-operator test.


The final experiment compares the frozen §9.45 release binary with the new
release binary through the same current socket runner. Both use the SQLite
server, 2,000 seed rows, file-backed WAL/FULL clients, and unchanged application
schema and indexes. Each case has five fresh pairs with build order alternating
within that workload. Six ordinary cases measure four replay patterns and
25-reader fanout/reconnect. Two separate 10k cases enable identical native
phase instrumentation in both binaries. Sixteen warmups remain separate from
80 measured attempts. Every attempt verifies original outcomes and final state.

| Replay workload | Writer drain, before → after | Reader visible, before → after | Queue construction, before → after |
| --- | --- | --- | --- |
| Independent, 1,000 commits | 175.090 → 148.792 ms | 155.309 → 139.523 ms | 88.026 → 77.111 ms |
| Repeated, 1,000 commits | 162.623 → 164.861 ms | 152.920 → 154.419 ms | 79.810 → 83.997 ms |
| Independent, 10,000 commits | 4,210.401 → 2,298.259 ms | 4,099.769 → 2,283.453 ms | 1,803.932 → 879.051 ms |
| Repeated, 10,000 commits | 3,602.632 → 3,640.155 ms | 3,587.242 → 3,624.522 ms | 869.989 → 754.581 ms |

Values are medians across five trials. Independent drain improves in all five
pairs at both sizes. The 10k drain median falls 45.4%. Repeated-row drain changes
by +1.4% at 1k and +1.0% at 10k; the predicate change leaves its principal pending
replay work intact. The 25-reader reconnect median moves from 198.334 to
188.257 ms, and connected fanout moves from 6.524 to 6.705 ms. None of these
ordinary comparison medians crosses the 10% regression investigation threshold.

The phase-enabled 10k profiles confirm which work changed. Independent scope
preparation uses 1,047.160 ms calling-thread CPU before and 27.214 ms after, with
10,000 calls in both versions. Independent pending replay uses 718.207 and
715.466 ms CPU and attempts 95,000 operations in both versions. Repeated-row
pending replay uses 2,658.078 and 2,606.002 ms CPU and attempts 1,576,334 operations
in both versions. These inclusive phases overlap and must not be summed.
The new predicate removes the scope lookup scan; the repeated-row replay cost
remains measured and separate.

For independent 10k replay, median writer lifetime CPU falls from 5,079.908 to
2,039.606 ms. Its median process peak RSS changes from 82.64 to 86.81 MiB.
These process measurements include construction, bootstrap and validation, and
peak RSS is a lifetime high-water mark rather than a measured allocation delta.
The ordinary candidate drain spans 2,087.476 to 3,806.044 ms. Host snapshots
record swapping and variable load, so these local profiles do not calibrate a
controlled-runner budget or replace the final combined comparison.

An earlier 80-attempt experiment rotated cases in a way that kept build order
fixed within each workload. Its 16 warmups and all measurements remain as
exploratory evidence in `row-id-paired`; the table above uses only the corrected
`row-id-final-paired` experiment. The final manifest verifies alternating build
order for every workload and unchanged source and binary hashes across runs.

The root gate passes 1,797 tests with 34 explicit skips, 13 isolated tests, and
both Node runtime contracts. Explicit TS/Rust conformance passes all 110 native
scenarios. Full Rust workspace tests and Clippy pass, including 70 client tests
and 11 private benchmark tests. Seventy-four focused benchmark contracts pass
with two explicit Swift performance skips. Swift passes 11 tests, Tauri and
React Native gates pass, and Kotlin/Flutter verify generated-source freshness
while skipping runtime checks for missing SDKs. Benchmark CI passes all budgets,
the docs build produces 58 pages, and `bench/RESULTS.md` remains unchanged.
Device builds and hosted CI remain unverified.

`bench/results/row-id-summary.json` retains drain, reader-visible, construction,
phase and process-resource medians. Sources, frozen binaries, every raw attempt,
host snapshots and verification logs are archived in
`bench/results/verification-2026-09-08-row-id/`. TS phase attribution, metadata
coverage, the frozen combined regression comparison and controlled-runner
calibration remain open.


### 9.47 Database metadata across selected workloads, 2026-09-08

The metadata audit found missing client durability settings in blob workloads,
replay readers and reopened clients. TS reads recorded only the SQLite version,
and ordinary server reports omitted database versions. The existing observation
validator is now shared as `sqliteConfiguration`, with one common metadata query.

Replay, restart, fanout, reconnect, blob, purge and read artifacts include
`clientSqlite` entries with role, client identity, process ID, SQLite version,
journal mode and synchronous setting. Native engine replay also records worker
thread IDs. Restart retains the terminated writer alongside its replacement;
purge retains the old and reopened reader. These entries use actual database
queries and associate with the corresponding process-resource records.
File clients must report WAL/FULL, and memory clients must report memory/FULL.
Metadata queries precede operation timers; reopened-client checks follow the
reopen timer. Reads check settings before and after measurement. Existing `sqlite`
fields keep their formats, including the native read driver's version-row array
and Swift's object. The initial native read checks incorrectly assumed a common
legacy shape; the rejected logs remain in the archive.

`serverMetrics.database` records the SQLite version and memory/FULL settings or
Postgres version and allowlisted durability settings. The Postgres fixture reads
`version`, `versionNumber`, `synchronousCommit`, `fsync`, `fullPageWrites` and
`walSyncMethod` through its pool before executor instrumentation starts. Metric
resets retain that metadata without another configuration query. Database URLs
and credentials do not enter the metadata. The TS read fixture now reuses the
existing performance-server setup so it exposes the same server record.

Tests extend the existing workload contracts. They verify client/resource
identity correspondence, both persistent and memory blob clients, old/reopened
identities, strict SQLite settings and the exclusion of metadata queries from
measured SQL work. Native reads preserve their SQL, plans, result rows and
statement counts. Swift reads validate the actual SDK, loaded-library hashes
and their SQLite metadata. Postgres checks verify the allowlist and retain the
same database record across metric resets in engine and socket lanes.

Thirty-four one-attempt CLI cases exercise artifact serialization and fixture
validation. Thirty use SQLite: TS and Rust engine/socket replay, fixed reads,
blobs, reconnect, restart, purge, mixed commit boundaries, native FFI blobs and
Swift reads, with memory and file storage where supported. Four use PostgreSQL
for TS and Rust replay in engine and socket lanes. Every artifact contains the
expected clients and server metadata. The captured versions are Bun SQLite
3.54.0, native/Swift SQLite 3.46.0 and PostgreSQL 18.6. Postgres reports
`synchronous_commit=on`, `fsync=on`, `full_page_writes=on` and
`wal_sync_method=fdatasync`. The two dedicated PostgreSQL containers used for
tests and CLI validation were removed with their anonymous volumes after use;
external campaign containers remained untouched.

The root gate passes 1,800 tests with 39 explicit skips, 13 isolated tests and
both Node runtime contracts. The explicitly enabled native/Swift benchmark gate
passes 95 tests with three Postgres skips; the separate PostgreSQL gate passes
all four tests. Benchmark CI passes all budgets, the docs build produces 58 pages,
and `bench/RESULTS.md` is unchanged. Production package, Rust and binding sources
match the §9.46 verification hashes. Its full Rust and 110-scenario conformance
evidence therefore remains applicable; this change touches benchmark and docs
sources only.

`bench/results/metadata-cli/` and `metadata-pg-cli/` retain the 34 artifacts and
validation records. Every artifact's source fingerprint matches the final
benchmark and production files. The archive
`bench/results/verification-2026-09-08-metadata/` retains source snapshots,
artifacts, rejected development checks, final logs and container cleanup evidence.
These are metadata and correctness checks; their single attempts do not establish
performance medians or instrumentation overhead. The final combined comparison
must use the same completed metadata collection on both sides. TS phase
attribution, combined regression acceptance and controlled-runner calibration
remain open.

### 9.48 TS sampling attribution, 2026-09-08

The private TS process driver accepts `stats` sampling start/stop commands.
`--ts-profile` enables them for TS socket replay, restart, commit boundaries,
fanout and reconnect. Each client records Bun's original timestamped stacks,
function and bytecode summaries in a validated gzip/base64 envelope. The driver
starts sampling after setup and stops after convergence. Delivery timers exclude
start/stop RPCs and profile formatting. Scoped SQL and process CPU snapshots
precede formatting; process-lifetime resources include it. Shipping packages
remain unchanged from §9.47.

Tests cover malformed envelopes, invalid lifecycle commands, repeated captures,
shutdown during capture, workload restrictions and actual replay/reconnect
captures with independent client processes. Bun 1.4 returns a structured
`stackTraces` object despite its installed string-array declaration. Runtime
validation checks that observed representation before recording a profile.

The overhead experiment compares the preceding frozen TS driver, the current
driver with sampling disabled, and the current driver with sampling enabled.
Every variant imports the same workspace production sources and uses the same
socket harness, SQLite server and WAL/FULL client stores. Each workload has five
fresh trials per variant and a separate warmup. The predeclared variant order
changes between trials; all 108 attempts preserve expected outcomes and matching
final-state digests. The initial frozen driver accidentally resolved a cached
published package from its temporary directory. Metadata validation rejected its
rollback-journal store before a timed comparison. The rejected warmup remains
archived, and explicit workspace imports correct the frozen driver.

| Workload | Frozen driver | Current, disabled | Current, enabled |
| --- | --- | --- | --- |
| Independent replay, 1k | 238.55 ms | 233.38 ms | 246.90 ms |
| Repeated replay, 1k | 243.24 ms | 231.32 ms | 238.74 ms |
| Independent replay, 10k | 3,114.76 ms | 3,168.97 ms | 4,401.09 ms |
| Repeated replay, 10k | 3,297.36 ms | 3,037.11 ms | 3,020.54 ms |
| Reconnect, 25 readers | 186.57 ms | 185.71 ms | 183.32 ms |
| Fanout, 25 readers | 11.95 ms | 13.28 ms | 15.01 ms |

Values are writer-drain or all-reader medians. Independent 10k sampling adds
38.9% to the disabled median. Enabled timings therefore serve attribution;
performance acceptance uses disabled runs. Host variability includes a 10.61s
frozen-driver independent replay attempt. These data do not establish a
controlled-runner budget.

The initial disabled fanout median increased 11.14%, crossing the declared
investigation threshold. A separate ten-pair AB/BA follow-up measured 17.37 ms
for the frozen driver and 18.52 ms for the disabled driver (+6.6%). The disabled
driver was slower in five pairs. Its range was 14.36–77.10 ms, versus
14.04–28.73 ms for the frozen driver. All 22 attempts, including warmups, passed
fixture checks. This follow-up falls below the threshold and makes no claim of
zero overhead; controlled-runner validation remains necessary.

At 10k independent commits, the writer's enabled profiles have medians of 2,176
samples, 966 stacks containing incoming commit application, 592 containing
pending replay, and 274 containing acknowledgement handling. SQLite COMMIT
appears in 898 stacks. These categories overlap. The same profiles record
10,099 writer COMMIT calls and 95,000 pending rows read for replay. Independent
reader profiles record 20,000 COMMIT calls. Sampling-disabled SQL wall timers
measure writer COMMIT at 1,412.39 ms and reader COMMIT at 2,093.73 ms. The reader
and writer run concurrently, so their times must not be added to derive latency.

Repeated 10k writer profiles contain 426 pending-replay stacks out of 1,467
samples and the same 95,000 pending rows read. Their disabled COMMIT wall times
are 1,032.40 ms for the writer and 1,531.05 ms for the reader. At 1k commits,
incoming application and SQLite commits dominate observed stacks; each writer
reads 500 pending rows. These measurements identify durable application and
pending replay as remaining work. They do not justify changing the independent
frame durability contract established in §9.43.

Reconnect profiles sum the 25 readers within each trial before taking medians:
1,780 samples, 1,614 incoming-application stacks, 1,274 SQLite COMMIT stacks and
2,625 COMMIT calls. Summed reader CPU and SQL time measure concurrent work,
not reconnect latency. Connected fanout produces a median of four writer samples
and 71 samples across all readers, insufficient for detailed phase attribution.
Protocol codec samples distinguish benchmark-driver decoding from shipping
codec callers. Sparse codec samples do not prove zero codec cost. Sampling
counts cannot be converted to CPU duration using the nominal interval.

The root gate passes 1,805 tests with 39 explicit skips, 13 isolated tests and
both Node adapter contracts. The focused benchmark gate passes 100 tests with
three opt-in Postgres skips, including enabled Rust and Swift coverage.
Benchmark CI passes its existing budgets, and the docs build produces 58 pages.
Production, Rust and binding sources match §9.47, preserving the earlier full
Rust, binding and 110-scenario conformance evidence.

Raw stacks, paired attempts, the rejected warmup, frozen driver, source hashes,
classification script and verification logs are retained in
`bench/results/verification-2026-09-08-ts-profile/`. The final combined regression
comparison and controlled-runner calibration remain open. Hosted CI and the
previously unavailable SDK runtime checks remain unverified.

### 9.49 Combined acceptance: TS, 2026-09-08

The combined TS comparison freezes the original RFC revision's production
packages and the current production packages. Both use the current repository
harness and the same installed dependencies. Absolute workspace imports prevent
Bun from resolving a cached published package from the temporary source trees.
The original client retains DELETE journaling and FULL durability; the candidate
uses WAL and FULL. Fixture validation checks each configuration explicitly.
Sampling remains disabled. Source fingerprints cover both frozen trees.

Ten fresh paired trials alternate baseline/candidate order within each workload.
Workload order rotates between trials. Warmups remain separate. The final run
records 321 attempts: 290 measured attempts and 31 warmups. Every candidate
passes its original fixture and outcome checks. Successful paired runs agree
on final-state digests, and paired reads use identical SQL and complete SQLite
schema records, including indexes.

| Workload | Baseline median | Candidate median | Candidate change |
| --- | --- | --- | --- |
| Independent 1k: writer drain | 949.21 ms | 210.63 ms | -77.8% |
| Independent 1k: reader visible | 795.67 ms | 212.76 ms | -73.3% |
| Repeated 1k: writer drain | 1,062.06 ms | 230.03 ms | -78.3% |
| Repeated 1k: reader visible | 889.70 ms | 228.95 ms | -74.3% |
| Independent 10k: writer drain | 13,293.97 ms | 3,289.60 ms | -75.3% |
| Independent 10k: reader visible | 12,971.55 ms | 3,293.04 ms | -74.6% |
| Repeated 10k: writer drain | 14,535.47 ms | 2,609.42 ms | -82.0% |
| Repeated 10k: reader visible | 14,363.35 ms | 2,603.73 ms | -81.9% |
| Restart 1k: writer drain | 977.42 ms | 226.15 ms | -76.9% |
| Restart 1k: reopen | 32.99 ms | 33.29 ms | +0.9% |
| Mixed commits with rejection: reader visible | 68.12 ms | 30.54 ms | -55.2% |
| Single write to one reader | 6.74 ms | 5.30 ms | -21.3% |
| Single write to 25 readers | 21.14 ms | 15.40 ms | -27.2% |
| Reconnect 25 readers | 458.72 ms | 159.43 ms | -65.2% |
| Bootstrap 2k rows | 19.89 ms | 17.40 ms | -12.5% |
| Purge 10k rows | 6.60 ms | 4.71 ms | -28.7% |
| Reopen after purge | 32.27 ms | 32.15 ms | -0.4% |

Both 1k variants exceed the §8 engineering objective of a 50% reduction in writer
drain and reader visibility. No paired bootstrap, reopen, single-write, fanout
or purge median crosses the 10% regression investigation threshold. The bounded
100-row read medians stay within 0.6% across database, public query and snapshot
surfaces. These local results do not calibrate a controlled-runner timing gate.
Host load varies, and the retained independent 10k baseline warmup reaches
63.15 seconds. Each attempt records load before and after execution.

The original version cannot supply successful baselines for two fixture groups.
Its 100k server seeding exceeds the readiness deadline before bootstrap timing
begins. The preceding full-matrix attempt remains in `combined-ts-acceptance`.
The revised experiment retains paired bootstrap at 2k rows and paired purge/read
at 10k, then validates the candidate at 100k in ten fresh trials. The candidate's
100k bootstrap median is 309.93 ms and its purge median is 66.22 ms. These values
have no successful 100k baseline comparison. The original blob lifecycle fails
the cache-refcount invariant already repaired in §9.14. Each blob size retains
one failed baseline warmup without a speed estimate; candidate trials validate
two distinct 2 MiB or 16 MiB objects, interruption recovery, reference counts
and cache hits.

The comparison records resource costs separately from operation latency:

| Independent replay resource | 1k baseline → candidate | 10k baseline → candidate |
| --- | --- | --- |
| Writer lifetime CPU | 1,172.35 → 418.16 ms | 12,022.18 → 4,017.74 ms |
| Writer process peak RSS | 81.87 → 84.17 MiB | 144.98 → 163.16 MiB |
| Reader process peak RSS | 72.06 → 73.27 MiB | 97.13 → 108.68 MiB |
| Writer + reader files before close | 0.94 → 4.96 MiB | 5.44 → 9.13 MiB |

Process CPU and peak RSS cover bootstrap, construction and validation as well
as replay. File totals include database, WAL and shared-memory files before
close/checkpoint; they do not measure retained logical data after close. The
candidate accepts the observed peak-memory and live-file increases for the
measured latency and CPU reductions. The record does not attribute the entire
RSS increase to one component or establish a leak. No application indexes or
SQL queries changed.

`bench/results/combined-ts-final/manifest.json` declares the experiment and
records every raw artifact hash, failure and timing range.
`resources-summary.json` verifies paired read SQL/schema equality and retains
per-client resource and file-size medians. Raw JSON attempts are gzip-compressed
without changing their contents. Sources, runners, preflight failures and the
aborted larger-baseline attempt are retained in
`bench/results/verification-2026-09-08-combined-ts/`.

The native comparison remains in progress. Postgres checks await an available
test server after the Docker daemon stopped; the installed local package has
client tools but no server executable. Controlled-runner calibration and hosted
job execution remain unverified. Production sources match the preceding gates;
this acceptance work changes only experiment artifacts and the RFC record.

### 9.50 Combined acceptance: Rust, 2026-09-08

The native comparison uses the frozen §9.43 binary that preserves independent
frame/block durability and the current frozen binary. Both use the same current
server and harness sources, file-backed WAL/FULL SQLite, direct native commands
and disabled profilers. Server package sources match across these native
snapshots. This comparison measures the combined native changes after §9.43;
earlier sections retain the evidence for preceding server and native-boundary
improvements. The earlier nonconforming transaction batching cannot provide an
acceptance baseline.

All 330 attempts pass their original fixture and outcome checks: 30 separate
warmups and ten fresh paired trials for each of 15 workloads. Build order
alternates within every workload, and workload order rotates between trials.
Final-state digests match. Paired read SQL and complete SQLite schema records,
including indexes, match exactly.

| Workload | Baseline median | Candidate median | Candidate change |
| --- | --- | --- | --- |
| Independent 1k: writer drain | 935.90 ms | 140.80 ms | -85.0% |
| Independent 1k: reader visible | 915.04 ms | 126.64 ms | -86.2% |
| Repeated 1k: writer drain | 963.37 ms | 153.84 ms | -84.0% |
| Repeated 1k: reader visible | 955.15 ms | 141.25 ms | -85.2% |
| Independent 10k: writer drain | 89,316.81 ms | 2,669.94 ms | -97.0% |
| Independent 10k: reader visible | 89,198.18 ms | 2,658.12 ms | -97.0% |
| Repeated 10k: writer drain | 57,672.33 ms | 3,855.32 ms | -93.3% |
| Repeated 10k: reader visible | 57,656.75 ms | 3,771.76 ms | -93.5% |
| Restart 1k: writer drain | 979.52 ms | 158.59 ms | -83.8% |
| Restart 1k: reopen | 6.56 ms | 6.63 ms | +1.1% |
| Mixed commits with rejection: reader visible | 28.69 ms | 22.44 ms | -21.8% |
| Single write to one reader | 4.52 ms | 4.46 ms | -1.3% |
| Single write to 25 readers | 6.60 ms | 6.50 ms | -1.5% |
| Reconnect 25 readers | 252.65 ms | 193.57 ms | -23.4% |
| Bootstrap 2k rows | 15.92 ms | 16.08 ms | +1.0% |
| Bootstrap 100k rows | 464.04 ms | 463.58 ms | -0.1% |
| Purge 100k rows | 45.42 ms | 45.52 ms | +0.2% |
| Reopen after purge | 2.81 ms | 2.82 ms | +0.3% |

Both 1k variants exceed the §8 engineering objective of a 50% reduction in writer
drain and reader visibility. No required bootstrap, reopen, single-write, fanout
or purge median crosses the 10% regression investigation threshold. Public and
raw read medians change by at most 1.4%. Blob phase medians range from -10.2% to
+4.1% across two distinct 2 MiB or 16 MiB objects, with content, cache references
and interruption recovery validated in every trial. These blob measurements
provide regression coverage; prior sections attribute the native byte changes.

The independent 10k writer's lifetime CPU falls from 78,361.85 to 2,147.74 ms.
Its process peak RSS increases from 82.02 to 86.87 MiB; reader peak RSS increases
from 27.57 to 28.42 MiB. Writer and reader files total 13.96 and 13.94 MiB before
close, including WAL and shared-memory files. At 1k, writer peak RSS moves from
17.45 to 17.38 MiB and file totals move from 9.10 to 8.99 MiB. The candidate
accepts the measured 10k peak-memory increase alongside the reduction in work
and latency. These process-lifetime counters include setup and validation.

Independent 10k drain spans 86.53–103.78 seconds for the baseline and 2.17–5.82
seconds for the candidate. The host is an Apple M4 with 10 CPU cores and 24 GiB
RAM, running macOS 27.0. A host inventory captured during the native comparison
records 15,070 MiB of swap in use. Per-attempt load snapshots and timing ranges
remain in the artifacts. These local comparisons establish the stated fixture
results; controlled-runner calibration remains separate.

`bench/results/combined-rust-acceptance/manifest.json` declares the comparison
and records artifact, source and binary hashes. `resources-summary.json`
verifies paired read SQL/schema equality and retains resource medians. The
frozen binaries, source provenance, preflight records, host inventory and all
attempts are archived in
`bench/results/verification-2026-09-08-combined-rust/`.

The SQLite acceptance comparisons for both cores are complete. Final Postgres
replay/reconnect checks still await a test server. Hosted CI execution and
controlled-runner calibration remain unverified. The implementation and its
previous correctness gates remain unchanged; no additional engine optimization
is required by these local acceptance results.

### 9.51 Upstream integration and regression checks, 2026-09-08

The performance branch now starts at upstream `e4ae85f3`. The integration retains
resumable D1 schema migrations, pull-horizon rechecks, partition-prefixed declared
server indexes, retired-table blob-reference cleanup, and notification sequence
tracking. The existing public `updateClientCursor` contract remains available.
Realtime uses `advanceClientCursor` to retain the RFC's actor and epoch fencing.
Both cursor contracts have SQLite, PGlite, and D1-double coverage.

The three-way integration resolved 13 overlapping files in an isolated checkout.
One scope-replacement test needed the existing `prepareD1` helper because the new
D1 schema setup can require multiple migration invocations. The original failure
is retained. The corrected root gate passes 1,834 tests with 40 explicit skips,
then all 13 isolated multi-tab tests and both Node SQLite adapter contracts.
Typecheck, lint, and knip pass. Explicit native conformance passes all 112 catalog
scenarios. Rust production sources are unchanged by this integration; the earlier
workspace, Clippy, and binding evidence remains applicable to those sources.
The docs build produces 58 pages, and `bench:ci` passes all budgets.

A bounded regression experiment compares the accepted candidate with the
integrated candidate using the identical frozen acceptance harness, WAL/FULL
SQLite, and the same Rust binary. All 72 attempts validate: a separate warmup
and five fresh alternating pairs for 1,000-commit replay, 25-reader fanout, and
25-reader reconnect in both cores. Paired final-state digests agree. Application
fixture SQL and schema are unchanged; the fixture declares no application indexes.

| Core and workload | Accepted median | Integrated median | Change |
| --- | --- | --- | --- |
| TS replay: writer drain | 226.27 ms | 234.36 ms | +3.6% |
| TS replay: reader visible | 231.06 ms | 236.40 ms | +2.3% |
| TS fanout: 25 readers | 13.26 ms | 11.71 ms | -11.7% |
| TS reconnect: 25 readers | 150.97 ms | 146.87 ms | -2.7% |
| Rust fanout: 25 readers | 6.67 ms | 6.85 ms | +2.7% |
| Rust reconnect: 25 readers | 168.04 ms | 161.63 ms | -3.8% |

The initial native replay comparison measured +10.3% writer drain and +12.7%
reader visibility while the root gate was running. A declared ten-pair follow-up
started after the gate completed. All 22 attempts validate. Writer drain moves
from 140.71 to 137.47 ms (-2.3%); reader visibility moves from 127.58 to 124.71 ms
(-2.2%). The increase did not reproduce. These local results do not establish a
controlled hardware baseline or attribute the initial difference to one cause.
Both experiments, source hashes, runners, and failed and successful gate logs
are retained in `bench/results/verification-2026-09-08-upstream/`.

The verified files were transferred into the primary checkout on
`bkniffler/engine-performance`, with an original-file backup and byte-for-byte
comparison to the isolated checkout. No commit or push was made. The Postgres
CI matrix now includes five 25-reader reconnect trials alongside its replay and
correctness workloads. Hosted execution still requires publishing the branch and
opening a pull request. Final real-Postgres checks and controlled-runner
calibration remain open; the local Docker daemon is unavailable and the current
GitHub runner inventory has no self-hosted runner. Timing thresholds remain
disabled for the new diagnostic workloads pending calibration.

### 9.52 Release validation, 2026-09-08

The maintainer authorized merging and a minor release. The release candidate is
0.17.0 in pull request #58. The source metadata gate, dependency audits, root
gate, package/site builds, and all 26 strict worker/native performance checks
pass locally. Managed child versions remain `0.0.0` until the release workflow
materializes its disposable checkout.

Hosted Rust 1.98 Clippy rejected the byte decoder's constant-size
`chunks_exact(2)` loop (`clippy::chunks_exact_to_as_chunks`). The decoder now
uses `as_chunks::<2>().0` after the existing even-length guard. The Rust 1.98
workspace Clippy gate and all ten value-conversion tests pass, including every
ASCII pair, malformed input, and canonical byte round trips. Earlier timing
artifacts retain their original source hashes.

The first hosted TS Postgres job passes five replay trials, five 25-reader
reconnect trials, mixed-commit rejection, permission purge with reopen, and
real storage/fanout contracts. Its artifacts are attached to Actions run
34256128245. Remaining hosted results are pending; hardware calibration remains
separate from this release.

The next hosted native gate reached the CLI contracts, then timed out while
compiling the release driver inside Bun's default five-second test watchdog.
CI had prepared only debug artifacts, while the public benchmark entry point
correctly requests a release build. CI now prepares both profiles before the
contracts run. The native SQL CLI test uses the same 30-second watchdog as the
other native CLI tests. No benchmark latency budget changes.
All 41 local native blob, read, observation, and engine contracts pass after
prebuilding release artifacts; two Swift SDK contracts remain explicitly skipped
in that command. Materialized 0.17.0 package archives also pass clean external
Node and Bun SQLite consumer verification.
