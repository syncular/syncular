# Syncular benchmarks

Use Bun 1.4.0 or newer for repository benchmarks. The subprocess resource
counters are validated against that runtime; older Linux builds report different
peak-memory units.

Run the suite from the repository root after `bun install`. The default
`bun run bench` command regenerates the curated `bench/RESULTS.md` record.
`bun run bench:ci` runs the existing reduced checks without changing that file.

## Diagnostic workloads

Select a workload to write a separate JSON artifact. Diagnostic runs leave
`bench/RESULTS.md` unchanged. Each attempt creates fresh storage and clients,
validates their final state, and retains any failure in the artifact.

```sh
bun run bench --workload replay --lane engine --storage file --sizes 100,500,1000,10000
bun run bench --workload replay --lane socket --storage file --sizes 1000 --pattern repeated
bun run bench --workload fanout --lane socket --storage file --sizes 1,5,25
bun run bench --workload reconnect --lane socket --storage file --sizes 1,5,25
bun run bench --workload replay --core rust --lane socket --storage file --sizes 1000
bun run bench --workload replay --core rust --lane engine --storage file --sizes 1000
bun run bench --workload replay --core rust --boundary command --lane socket --sizes 1000
bun run bench --workload restart --core ts --lane socket --storage file --sizes 100,500,1000,10000
bun run bench --workload restart --core rust --lane socket --storage file --sizes 100,1000
bun run bench --workload native-bytes --lane native --sizes 65536,2097152,16777216
bun run bench --workload read --lane engine --storage file --sizes 1000,10000,100000 --iterations 100
bun run bench --workload read --core rust --lane socket --boundary command --storage file --iterations 100
bun run bench --workload read --core rust --lane socket --boundary ffi --storage file --iterations 100
bun run bench --workload commit-boundaries --core ts --lane socket --storage file
bun run bench --workload commit-boundaries --core rust --lane socket --storage file --reject-middle
bun run bench --workload blobs --lane socket --storage file --sizes 65536,2097152,16777216
bun run bench --workload blobs --core rust --lane socket --boundary command --storage file
bun run bench --workload blobs --core rust --lane socket --boundary ffi --storage file
```

| Option | Meaning |
| --- | --- |
| `--trials` | Independent fresh attempts per size, default 5 |
| `--core ts\|rust` | Full-client implementation, default `ts`; Rust supports engine replay and the socket workloads |
| `--boundary direct\|command\|ffi` | Native timed operations call the core, shared command router, or exported C ABI; default `direct`. The FFI boundary supports blobs and local reads. |
| `--rows` | Initial task rows, default 2,000; independent of queue length. The read workload uses `--sizes` for its row counts. |
| `--storage memory\|file` | Client SQLite persistence, default `memory` |
| `--backend sqlite\|postgres` | Server storage, default `sqlite` |
| `--pattern independent\|repeated` | Replay edits distinct rows or cycles over 32 rows; base versions are absent |
| `--reject-middle` | Reject the middle commit in `commit-boundaries` through the server commit validator; other workloads reject this flag |
| `--native-sql` | Opt-in Rust socket replay/restart/commit-boundaries/fanout/reconnect SQL verb and commit/rollback hook counts; direct or command boundary only |
| `--native-phases` | Opt-in Rust socket replay/restart/commit-boundaries/fanout/reconnect/blobs wall-time and calling-thread CPU phases; direct or command boundary, Linux or macOS |
| `--iterations` | Measured operations per read surface or native byte phase, default 10, after three warmups |
| `--output` | Artifact path, relative to the repository root or absolute; existing files are refused |

The commit-boundaries workload queues three commits with 499/2/1 or 500/2/1
operations (`--sizes 499,500`). Both cores must send the first commit alone,
then the two remaining commits together. `--reject-middle` installs a server
commit validator that rejects the marked middle commit after staging both writes.
Both writes must roll back; the later independent commit must apply. The runner
validates exact acknowledgement identities, the durable rejection code and
operation index, a server sequence of two instead of three, and full writer/reader
state. It also verifies all optimistic writes before syncing. This workload
requires the socket lane and supports SQLite and Postgres. Its schema and indexes
match ordinary replay.

Replay queues one operation per independent commit before allowing the writer
to sync. The independent reader remains online. The runner checks request order,
commit IDs, the 500-operation cap, an empty outbox, and exact final rows on both
clients. Queue construction, writer drain, and reader visibility have separate
timers.

Fanout and reconnect validate every client's bootstrap rows against the seed,
then compare writer and readers with independently generated expected edits.
They also require the original commit IDs in newest-first durable journal order,
one applied operation per commit, empty client outboxes, and the exact final
server sequence. Artifacts record `validation: independent-fixture-and-original-outcomes`
and `validatedCommitIds`. SQL and journal validation run outside observation
latency; preflight row reads warm the local database. Earlier observation
artifacts compared readers with the writer's rows and do not carry this stronger
validation marker.

Socket fanout and reconnect run every TS or Rust writer/reader in its own
process through the shared process runner. The server owns another process.
Artifacts record `executionModel: isolated-client-processes`, per-client OS
resources, and `clientSqlite` version/journal/synchronous settings. File clients
must report WAL/FULL; memory clients must report memory/FULL. TS engine readers
retain one shared process and report that execution model. Earlier TS socket
observation profiles used shared client processes and require that distinction
when interpreting cross-core timing differences.

Reconnect observations retain `reconnectSync.elapsedNs` and its stats snapshot.
That timer starts after connection setup and measures the explicit sync operation.
The following acknowledgement timer starts after that sync. Both timers sit
inside controller elapsed time; do not add them to controller elapsed.

Use `--native-sql` with Rust socket replay, restart, commit-boundaries, fanout,
or reconnect to count statement verbs,
pre-commit hooks, and rollback hooks. Counters start at the pre-measurement reset
and the reader snapshot ends at its acknowledgement, before final SQL validation.
Commit hooks count implicit writes and outermost savepoint releases as well as
explicit commits; a hook runs before commit and does not prove durability.
Exact fixture checks still establish final correctness. The collector retains
fixed SQL verb labels and counts; other leading tokens become `OTHER`. SQLite
expands statement parameters internally for tracing, so diagnostic timings include
that overhead. Compare ordinary timings with diagnostics disabled. Engine and FFI
boundaries reject this option.


Use `--native-phases` to collect private Rust core intervals. The recorder is
compiled only with `bench-internals` and remains disabled until the runner
requests an interval. Each client owns its recorder. Every phase reports
`calls`, `elapsedNs`, `threadCpuNs`, and `units`; `units` counts attempted
pending operations after changed-key filtering. Failed calls count too.
Reset starts a new generation and discards any open span from the old generation.
Phase names are fixed and contain no row values, IDs, SQL, or URLs.

Replay and observation retain phase snapshots in `writerStats.phases` and the
reader's `stats.phases`. Intervals begin after setup and end before validation.
Blob samples retain separate `nativePhases` snapshots for staging, download,
cache hit, interrupted download, and recovery. Staging currently has no internal
phase entries; its existing public operation timer remains available.
The extra stats calls sit outside operation and delivery timers.

| Phase | Included work |
| --- | --- |
| `requestPrepare`, `outboxEncode`, `requestEncode` | Request construction, its bounded outbox selection/row encoding, and SSP2 serialization |
| `responseDecode`, `rowDecode` | SSP2 message parsing and incoming commit row decoding/decryption |
| `responseApply`, `commitApply` | Pull response processing and each incoming frame's complete transaction |
| `rowWrite` | Base/visible upsert statement preparation, binding, and execution across apply/replay paths |
| `observationPrepare`, `observationCommit`, `cursorPersist` | Change-scope collection, revision persistence/publication, and subscription trailer persistence |
| `overlayRebuild`, `pendingReplay` | Complete base-to-visible reconciliation and pending-operation iteration/application, including changed-key filtering |
| `blobDownload`, `blobValidate` | Authorized inline/signed-URL body retrieval and content-address verification |
| `blobCacheInsert`, `blobCacheRead`, `blobEncode` | Cache insertion with refcount/retention work, cache read/materialization, and its hexadecimal encoding |
| `blobReconcile` | Visible-reference scans and cache refcount updates |

Durations are inclusive. Nested phases overlap, so summing them double-counts
work. Thread CPU excludes transport I/O threads and the server/controller.
The recorder uses the operating system's thread CPU clock; unsupported clocks
fail the explicit request. Enabled phases add clock reads and counter updates,
and disabled private builds retain recorder checks. Compare both against a
frozen uninstrumented binary when evaluating overhead. Normal builds contain
neither the recorder nor its checks. Public command/FFI envelopes and SSP2 do
not expose these fields. The shipping FFI benchmark boundary rejects the flag.

Rust engine replay uses the same fixture, FIFO checks, and direct/command loops
as socket replay. Each Rust client runs on a Bun worker in the server/controller
process. A private benchmark C ABI callback waits while the main thread runs
the real async server handler or realtime session. SSP2 bytes cross a shared
response buffer capped at 32 MiB; queued inbound events have the same cap.
Readiness comes from delivered events, and shutdown wakes a blocked reader
before releasing its native handle and library. Segment reads use the direct
server handler. Signed URL fetching and other engine workloads are unsupported
and fail explicitly.

Artifacts record the private library hash, shared process ID, distinct Rust
thread IDs, host call counts, bytes, and elapsed callback time. Direct Rust
operation timers include callback scheduling, SSP2 copies, and server work;
outer command JSON and worker delivery remain outside them. Callback time
overlaps operation time. The engine's `serverMetrics` CPU and RSS cover the
shared process; `clientResources` is empty because OS counters cannot isolate
these clients. This bridge measures the private benchmark seam. Shipping FFI
measurements retain their separate boundary.

Run the native engine contracts with `SYNCULAR_ENGINE_BENCH` pointing at
`rust/target/release/libsyncular_bench.dylib` on macOS or
`rust/target/release/libsyncular_bench.so` on Linux after the release build.
The TS process contract bounds actual SQLite commit calls for 501 queued commits
to 520, including delivered row commits and response bookkeeping. This budget
requires successful acknowledgements to share a transaction within each response.

The read workload supports the TS engine and Rust socket setup with SQLite. It bootstraps
the ordinary task fixture, then runs fixed primary-key and bounded-result SQL
through the database adapter, `query`, and `querySnapshot`. Each full-profile
bounded query returns 100 rows. Three warmup cycles precede the measured cycles;
surface order rotates, and each cycle uses a declared ID. The dataset
and SQLite pages are already warm. Snapshots use empty coverage requirements.
Every result is checked against independently generated rows in query order.
Final checks verify the full dataset, unchanged revision, and empty outbox.

Artifacts include per-operation latency samples, SQL, parameters, SQLite schema,
query plans, and a separate untimed statement-count pass. Direct database samples
include SQLite execution and row materialization. Public query and snapshot
samples include the query guard and reserved-column check; snapshots also read the revision in a transaction. The explicit projection has no reserved columns, so the check returns the original rows.
Validation and counter collection are outside latency samples. CPU includes
those passes; RSS describes the whole process. CI limits direct/query reads to
one database query and TS snapshots to two queries and one transaction, with no
latency threshold.

Rust runs each measurement loop inside the native driver. `--boundary direct`
measures public query/snapshot calls; `--boundary command` includes the shared
router and its JSON result construction. Both retain a raw SQLite baseline on
the same client connection. The private driver enables the Rust client's
`bench-internals` feature to access that connection and installs SQLite trace
callbacks only for the untimed counter pass. Default client builds omit the
hook. The raw fixture converter materializes null, safe integer, finite real,
and UTF-8 text cells; other cells fail explicitly.

Rust snapshots issue at most four statements, including savepoint and release;
raw/query reads issue one. Socket bootstrap and validation are outside read
timers. The aggregate process elapsed includes IPC, validation, and counters;
per-client OS resource records cover the complete process lifetime. `--boundary ffi` times the exported C call, including input parsing, command
dispatch, diagnostics, and response serialization. Its `ffi` records separate
host request serialization, response copying, freeing, and JSON parsing; byte
counts include NUL terminators. Raw SQLite still uses the same connection.
The private driver enables `bench-internals` on the FFI crate to borrow its
client between commands. Default FFI builds omit that Rust-only hook; the C ABI
has no benchmark command or new export.

Each FFI query also refreshes diagnostics: one local-revision read, two page
pragmas, an outbox size query, and an outcome count/size query. The task-only
fixture therefore permits six statements for `query` and nine for snapshots.
The untimed trace pass records these statements separately from latency samples.
Language-binding read measurements remain pending.


Fanout measures one write delivered to connected full clients. Reconnect
disconnects the readers, commits 100 updates, then measures connection restoration
and catch-up. Completion uses each reader's applied cursor acknowledgement.
Change callbacks count notifications without running a query per notification;
the final SQL comparison runs after timing.

The engine lane exchanges SSP2 through the production in-process seam. The
socket lane starts one repository-owned Bun server process, binds an ephemeral
loopback port, and uses the Hono adapter with shipping HTTP/WebSocket clients.
Both lanes use the same task fixture. TypeScript fanout and reconnect readers share the
controller process. Socket replay uses separate writer and reader processes for
both TS and Rust through the same harness. Each Rust reader owns a separate process; server CPU and
memory are measured in the server process. Rust replay, fanout, and reconnect
use the shipping native transport, applied acknowledgements, and its notification
callback. Native operation timers exclude controller delivery; parent timers
include stdio requests and responses. Native transport timings overlap apply
timings when applying a delta sends an acknowledgement.

Restart exercises TS and Rust socket clients with file storage through the same
process runner. The runner queues offline writes, verifies SIGKILL termination,
opens a new process with the same client identity and database, and verifies the
offline queue and optimistic rows before syncing. It checks that the server
commit sequence stays unchanged through construction and reopen. Drain validation
checks the original commit identities in requests and acknowledgements, request
boundaries, and independent reader state. Each client owns its own process.

Artifacts separate controller construction/drain times from operation times
inside the client process. Reopen includes process launch and client setup.
Reader completion includes controller receipt of the applied acknowledgement.
The TS driver collects HTTP push results across all rounds because the TS
`syncUntilIdle` result describes its last round. Driver dispatch and measurement
fields remain private benchmark code.

The native byte workload builds `syncular-bench` in release mode with the locked
Cargo dependencies. It measures the shipping byte-envelope encoder, JSON
serialization, parsing, and decoding inside Rust, then validates every byte.
Process elapsed includes startup and stdio delivery of the measurement result.
It does not measure blob download or byte delivery through a platform binding.

## Postgres

Use a dedicated test database and set `SYNCULAR_PG_URL` before selecting
`--backend postgres`. The role must be allowed to create and drop schemas.
Every attempt creates a unique `syncular_bench_*` schema and removes only that
schema during cleanup. An explicit Postgres request fails if the URL is absent
or the server cannot be reached. SQLite remains self-contained.

```sh
SYNCULAR_PG_URL=postgres://localhost/syncular_bench bun run bench \
  --workload replay --lane socket --backend postgres --storage file --sizes 1000
```

CI runs a separate `postgres-performance` job for TS and Rust socket clients.
Each job provisions its own Postgres 18.6 service and runs five fresh 1,000-commit
trials with 2,000 seed rows and file storage, followed by five 25-reader reconnect
trials. Both jobs also run the mixed-commit rejection fixture at 499 and 500 operations, plus five 2,000-row permission-purge trials with persistent reopen.
The Rust job also runs five C ABI blob lifecycle trials with two distinct 2 MiB bodies per trial.
The TS job also runs the real Postgres storage/fanout integration tests. The job pins Bun 1.4.0, Rust 1.96.0,
and the Postgres image digest, retains attempt artifacts on failure, and fails
on invalid state or an unavailable database. Its timing samples have no latency
threshold; hosted-runner calibration remains pending.

## Artifact interpretation

Raw runs default to the gitignored `bench/results/` directory. Artifacts use
schema `syncular-performance-v1` and contain workload options, source revision,
dirty diff, untracked source contents, source hashes, host/runtime information,
per-attempt samples, validation digests, failures, and measurement boundaries.
Native runs also record the release executable hash and Rust compiler version.

Process-backed replay, restart, mixed-commit, fanout, reconnect, and blob attempts
record `clientResources` after each client exits. Each entry identifies the role,
process ID, and client ID, with user/system/total CPU milliseconds and peak RSS
in bytes. Restart retains separate entries for the killed and reopened writer.
These OS counters cover the process lifetime, including setup, validation,
stdio, and shutdown. They exclude the server and controller. CPU totals do not
measure a single operation; peak RSS is a lifetime high-water mark. Do not sum
reader peaks to estimate simultaneous memory usage. Missing, unsafe, or
inconsistent counters fail the attempt. The runner normalizes both integer and
big-integer CPU counters before writing JSON.

An artifact is written after each attempt so later failure retains earlier work.

Method durations are inclusive: storage transactions, SQL execution, transport,
and client apply overlap. Do not add them to derive end-to-end time. Engine
server CPU overlaps controller CPU. RSS snapshots describe whole processes,
not allocation counts or precise peak memory. Native operation samples within
one process are distinct from independent trial samples.

Postgres server measurements include whitespace-normalized SQL shapes under
`postgres.query:` and `postgresTransaction.query:`. Bound values are excluded.
Each shape shares its enclosing executor method's duration. Transaction methods
still include their nested SQL calls; lock timing includes the lock query and
candidate savepoint, and commit timing includes the driver completing the durable
transaction. These durations include database waits and transport overhead.
`realtime.notifyCommit` measures the awaited local hub call for HTTP and socket
pushes. Its completion excludes later client apply and acknowledgement persistence.
Reader cursor writes overlap writer transactions and must remain separate totals.

Use at least five fresh trials for an investigation and ten for a curated
comparison. Alternate baseline and candidate order on the same host. Keep the
fixture, SQL, indexes, instrumentation, and storage configuration fixed. Retain
failed attempts and distinguish their count from successful timing samples.
Benchmark CI also runs a 501-commit TS process restart and the rejected 499/2/1
commit fixture with file storage.
The implementation and remaining workload coverage are tracked in
[the engine performance RFC](../docs/RFC-ENGINE-PERFORMANCE.md).
The [SQLite blob experiments](../docs/RFC-SQLITE-BLOB-PERFORMANCE.md)
extend that suite with large attachments and measured keep/discard decisions.

The private TS and Rust process drivers also support `benchBlobFile` with
`mode: direct`. Upload takes a fixture `path`, reads it inside the client process,
and reports source-read and public staging durations separately. Fetch takes a
`blob` reference and times complete public-API materialization. Both return a
full SHA-256/length receipt after the operation clock, without sending the body
through stdio. Rust's internal hex result remains inside its public API timing;
receipt validation decodes bounded pieces afterwards. This command is not yet
wired into the diagnostic CLI or its size limits.

Run its staged-restart and fresh-download contracts with:

```sh
(cd rust && cargo build -p syncular-bench --bin syncular-bench)
SYNCULAR_NATIVE_BENCH="$PWD/rust/target/debug/syncular-bench" bun test bench/src/blob-lane.test.ts --test-name-pattern 'blob file receipts'
```


## Blob lifecycle

`--workload blobs` runs TS clients through the engine or socket lane and Rust
clients through the socket lane. Its separate
attachment table contains one `blob_ref` column; the ordinary task schema stays
unchanged. The default profile covers 64 KiB, 2 MiB, and 16 MiB bodies. The 2 MiB
case uses two distinct bodies on the same clients. Each attempt owns a memory
server blob store and fresh writer, reader, and recovery clients.

The runner measures local staging, upload plus reference commit, fresh download,
cache hit, interrupted body consumption, and complete retry. The HTTP body fault
passes a prefix to the client, cancels the underlying response, then fails the
stream. A failed download must leave no cached body. A subsequent call must
re-authorize and fetch the full body. Every phase validates bytes outside its
timer; final checks verify reference rows, cache metadata, upload pins, and the
absence of network requests on cache hits. Each sample's `phases` records database
and blob-transport calls, failures, and inclusive durations for each operation.
SQL entries group statements by whitespace-normalized text and omit bound values.
SQL durations are subsets of method durations; transactions include nested SQL.
Do not sum these durations or add them to the phase time. Snapshot and delta
bookkeeping run outside phase timers. Aggregate method measurements also include
mutation and reference convergence between phases. CPU includes validation and
RSS is process-wide.

Successful transfers use inline HTTP bodies and the shipping Hono/blob transport
paths. Rust runs through the shipping native transport, with direct core or shared
command calls inside an isolated process. Native operation timers exclude stdio
serialization and parent parsing. Direct staging also excludes input-envelope
decoding; command staging includes it. The core's fetch result already contains
hexadecimal bytes, so native fetch time includes that encoding. Delivery timers
include stdio and parent parsing. Separate fields record request serialization,
response framing, response parsing, serialized byte counts, input hex encoding,
and output hex decoding. Framing covers UTF-8 decoding, newline search, and
joining message fragments; `responseScanChars` counts the character ranges
searched, and `responseChunks` counts received chunks. The reader searches each
new chunk once and joins each complete response once. Framing time is part of
delivery time. Exact-byte comparisons run after decoding timers.

`--boundary ffi` uses a Rust caller linked to the shipping C ABI. Its `ffi`
measurements replace `nativeOperationMs`: each phase records request JSON/C-string
construction, the complete C call, copying the returned string to host-owned
bytes, freeing the library string, and host JSON parsing. The C call includes
input parsing, core execution, event collection, and result serialization. Byte
counts include the NUL terminator. The caller frees each result exactly once
before parsing its owned copy and closes the handle once on exit. This profile
does not load a Swift, Kotlin, Flutter, React Native, or Tauri runtime.

The FFI owns its transport, so its lifecycle assertions use a server request trace
tagged by client identity. Trace reads occur outside delivery timers. The signed
URL fixture rejects forwarded host headers, and its trace records the truncated
response. Cache-hit reads must produce no request; recovery must call the
authorized endpoint again.

The Rust interruption fixture authorizes the ordinary blob request, then issues
a one-use signed URL. A private HTTP listener sends a prefix with the full body's
Content-Length and closes the connection. Rust must report a transport failure,
leave the cache empty, and re-request the authorized endpoint on retry. This
uses the native signed-URL fetch path; TS interrupts inline body consumption.
The native fixture retains orchestrator CPU/RSS alongside separate client process
resources. Per-phase native CPU/allocation attribution, successful presigned-storage
profiles, and language-binding delivery remain to measure.
Run the native lifecycle contracts with `SYNCULAR_NATIVE_BENCH` pointing at a
freshly built `syncular-bench` executable; the Rust CI job builds and runs them.
Before enabling native CLI contracts, run `cargo build --release --locked
--manifest-path rust/Cargo.toml -p syncular-bench`. The CLI always verifies a
release build; preparing it before tests keeps cold compilation outside the test
watchdog. CI prepares both debug and release profiles.

TS socket replay records operation construction/drain samples, all-round push
acknowledgements, and separate client lifetime CPU/peak memory. Earlier TS
socket replay artifacts used two clients in the controller process and aggregate
resource fields. Keep that boundary change explicit when comparing old results.
The engine replay lane retains its in-process setup.

Replay, restart, observation, blobs, purge and read artifacts record `clientSqlite`
for every client, including the old and reopened process in recovery workloads.
Each entry includes its role, client ID, process ID, SQLite version, journal mode
and synchronous setting. Native engine replay also records worker thread IDs.
File clients require WAL/FULL; memory clients require memory/FULL. A different
effective configuration fails the attempt. Metadata queries precede timed work;
reopened-client queries follow the reopen timer, and reads verify settings again
after measurement. Legacy `sqlite` fields retain their existing formats, including
the native read driver's version-row array.

`serverMetrics.database` records the actual SQLite version, memory journal and
FULL durability, or Postgres version and selected server settings. Postgres fields
are `version`, `versionNumber`, `synchronousCommit`, `fsync`, `fullPageWrites` and
`walSyncMethod` under `settings`. Setup reads those fields through the benchmark
pool before instrumentation starts. Metric resets retain this metadata and do
not query it again. Database URLs and credentials are excluded.

The SQLite benchmark server uses an in-memory database. File storage applies
to the client replicas. Use the explicit Postgres backend to measure a persistent
server; the client SQLite durability check does not describe server persistence.

TS process replay attributes SQL shapes and counts rows returned by successful
queries. Bound values and returned row contents stay out of measurements.
`clientSqlite.run` records actual transaction-control calls separately from
`database.transaction`: nested savepoints therefore remain distinguishable
from `COMMIT`. Their durations overlap outer database and drain timers. Full
outbox-read row counts measure pending bodies materialized for replay; bounded
encoder reads have their own SQL shape. Counts exclude construction after the
replay reset. Query timing excludes subsequent JSON decoding of operation bodies.

Server replay attribution distinguishes `storage.advanceClientCursor` from full
`putClientRecord` registration writes. Realtime ACKs use one atomic cursor UPDATE;
registration preserves the separate full-record path. The process replay contract
bounds full-record reads and writes independently of ACK count. Postgres artifacts
retain SQL shapes so an added round trip remains visible even when elapsed time
varies. The paired comparison and its unresolved replay regression are recorded
in RFC §9.34.


Async method and SQL-shape measurements include `pending`, `maxPending`, and
`overlappingCalls`. `pending` counts calls started in the current collection
epoch whose promises have not settled. `maxPending` records the peak count;
`overlappingCalls` counts starts while another call was pending. These fields
measure overlap at the instrumented method boundary. They do not distinguish
executor queueing from database execution. A reset starts a new collection epoch;
completion of a preceding call cannot decrement the new epoch's count.


Permission purge uses `--workload purge --lane socket --storage file` with TS
or Rust clients. `--sizes 2000,10000,100000` selects rows in the revoked project;
one additional row belongs to a retained grant. Rust supports direct and command
boundaries. The private server fixture removes the project grant through its
scope resolver. Grant removal completes before timing; the measured explicit
sync round includes authorization and local purge. Automatic discovery of a
grant change is outside this workload.

Each attempt verifies the revoked subscription and reason code, exact retained
row values, an unchanged authoritative commit sequence, and an empty outbox.
It closes the client, reopens the same SQLite file with the same identity in a
fresh process, and verifies the purged rows remain absent before and after
another sync. Artifacts separate client operation time, controller elapsed,
reopen time, SQL/transport attribution, and per-process lifetime resources.
Clients must report WAL and FULL durability. Validation reads remain bounded
across data sizes. Benchmark CI runs a reduced 2,000-row TS case.

```sh
bun run bench --workload purge --lane socket --storage file --trials 5
bun run bench --workload purge --core rust --lane socket --storage file --trials 5
bun run bench --workload purge --core rust --boundary command --lane socket --storage file --trials 5
```


## Swift read boundary

On macOS, add `--binding swift` to the Rust FFI read profile:

```sh
bun run bench --workload read --core rust --boundary ffi --binding swift --lane socket --storage file --iterations 100 --trials 5
```

The runner builds the native library with locked Cargo dependencies and the
`native-transport` feature in release mode. It compiles the shipping Swift SDK
as a separate optimized module, then links a private benchmark executable.
Builds stay under `bench/results/swift-build/`; the Swift package's `vendor/`
and public API remain unchanged. Artifacts record Swift compiler and build
commands, source hashes including bindings, executable hash, and both loaded
library paths and hashes. A different loaded library fails validation.

Each fresh client bootstraps the shared 1k/10k/100k task fixture over the shipping
socket transport. The Swift process measures `query` and `querySnapshot` calls
with the same SQL, parameters, and rows as the TS and Rust read profiles. Three
warmup cycles precede alternating query/snapshot order. Timers include Foundation
encoding, serial command dispatch, C ABI execution, response decoding, and SDK
result materialization. Validation and autorelease-pool drain follow each sample.
The SDK's event poll loop remains active with a dedicated serial delivery queue;
the benchmark installs no event callback. This profile measures no UI rendering.

The Swift profile exposes no raw SQLite timer or internal phase counters. Its
complete SDK durations have a different boundary from the Rust caller's FFI
`callNs`. Do not subtract independent runs to estimate wrapper overhead.
Configuration reads verify SQLite version, WAL for file storage or the memory
journal, and FULL durability. Exact results, unchanged revision, and empty outbox
are checked outside timing. Process elapsed includes controller delivery and
validation; CPU and peak RSS cover the complete client process lifetime.

Run the Swift contracts after building the profile:

```sh
SYNCULAR_SWIFT_BENCH="$PWD/bench/results/swift-build/swift-read" bun test bench/src/read-lane.test.ts bench/src/performance.test.ts
```

Kotlin, Flutter, React Native, and Tauri runtime performance remain unmeasured
by this profile. A Swift or FFI result does not establish their boundary costs.


## PostgreSQL WAL I/O diagnostics

Add `--pg-io` to an explicit Postgres workload to retain whole-attempt WAL I/O
and checkpoint counters. Use an isolated PostgreSQL 18 instance with
`track_wal_io_timing=on`; the observer rejects unsupported configuration and
waits for all other client connections to exit before reading counters. It
reads settings and statistics without changing durability or resetting counters.
The ordinary Postgres profile requires no I/O observer.

```sh
SYNCULAR_PG_URL=postgres://postgres@127.0.0.1:5432/syncular_bench bun run bench --workload replay --lane socket --backend postgres --storage file --sizes 1000 --trials 5 --pg-io
```

Each attempt's `postgresIo` contains server settings, `before` and `after`
snapshots of `pg_stat_io` WAL rows, `pg_stat_wal`, and `pg_stat_checkpointer`, plus
measurement boundaries. A counter reset or a failed diagnostic marks the
attempt failed and retains the result/error in the artifact. Bigint counters
retain their precision as strings when the driver returns big integers.

The interval includes server schema creation, bootstrap, validation, and cleanup.
The final snapshot follows closure of the benchmark's database sessions. WAL
counters remain cluster-wide, with PostgreSQL background processes represented
separately by backend type. They cannot isolate one commit, distinguish the
writer from reader ACKs, or be added to overlapping storage durations. Query
execution counts and method timings stay in the existing `serverMetrics` field.
`--pg-io` requires no `pg_stat_statements` extension and does not collect SQL text.

Run the optional database contract against the isolated instance:

```sh
SYNCULAR_PG_IO_TEST_URL=postgres://postgres@127.0.0.1:5432/syncular_bench bun test bench/src/pg-lane.test.ts
```


## TS sampling profiles

Add `--ts-profile` to TS socket replay, restart, commit-boundaries, fanout or
reconnect workloads. Each isolated client starts Bun's sampling profiler after
setup and before timed work, then stops it after convergence and before final
validation. The writer and each reader have separate captures. Start/stop RPCs,
profile formatting, compression and validation sit outside delivery timers.
Existing SQL and transport measurements remain available alongside the samples.

`writerStats.sampling` and reader `stats.sampling` contain a versioned envelope:
Bun version, nominal 1,000-microsecond interval, sample count, collection elapsed
time, and gzip/base64 data. Decode `data` as base64, decompress gzip, then parse
JSON to inspect Bun's original function/bytecode summaries, timestamped stacks
and source map. Runtime output has a structured `stackTraces` object even though
the installed Bun declaration describes a string array; the benchmark validates
the observed structure before recording it. Raw stacks retain source paths and
function locations, without recording SQL bindings or row values.

Sample counts describe observed stacks. Native waits can appear in those stacks;
counts multiplied by the nominal interval do not establish CPU time. Use the
existing SQL elapsed times and scoped process CPU to interpret them. Stack
categories overlap when one operation calls another. Monotonic trace timestamps
belong to their client process and cannot be subtracted across processes.
The collection interval includes benchmark protocol handling between its start
and stop commands. The stats CPU snapshot precedes profiler formatting and
compression; client lifetime resource counters include those costs. Small
fanout captures can contain few or zero samples. Sampling is opt-in and requires
paired overhead measurements for a performance investigation.
