# RFC: Sync correctness, bounded resource use, and client interfaces

- Status: implemented and verified; included in 0.16.0
- Date: 2026-09-05
- Review baseline: `197755fd`
- Scope: TypeScript and Rust clients, server storage, typegen, React, and tests

## 1. Problem and evidence

The review found two paths that violate existing contracts: registered queries
can read another partition, and the TypeScript outbox can send commits out of
creation order. It also found unsafe pruning interleavings, disclosure of
unexpected exception messages, stale presence results, and unbounded reactive
query retention.

The user authorized execution of this RFC on 2026-09-05. Implementation updates
the relevant specifications before changing observable behavior. Acceptance evidence and required gate results are recorded in §9.

| ID | Finding | Evidence at the review baseline | Priority |
| --- | --- | --- | --- |
| R1 | Registered-query partition escape | A SQLite reproduction returned both tenants through `tasks a JOIN "tasks" b`; typegen accepted the source | P1 |
| R2 | Outbox FIFO violation | Commits of 499, 2, and 1 operations sent in order 1, 3, 2; the older edit became the final server value | P1 |
| R3 | Pruning horizon regression | A controlled storage double interleaved two passes, deleting through 200 while persisting horizon 100; adapter inspection confirmed unconditional watermark assignment | P1 |
| R4 | Unexpected exception disclosure | A synthetic secret thrown by a validator appeared in the client's rejection message | P2 |
| R5 | Stale presence publication | Deferred reads resolved in reverse order replaced newer peers with older peers; changing scope retained the previous peers | P2 |
| R6 | Unbounded reactive retention | Inspection found retained query entries and rows after unsubscription, with every historical entry visited on change | P2 |

The baseline passed `bun run check`: 1,545 tests passed and 9 skipped. Rust unit
tests passed. An explicitly enabled Rust-client × TypeScript-server conformance
run passed 99 tests. These results establish missing coverage for the reproduced
cases. Native bindings and deployment adapters were not exhaustively reviewed.

Performance proposals below are based on code paths. The review did not measure
their latency or memory benefit.

## 2. Existing contracts to preserve

[SPEC.md](./SPEC.md) remains the wire authority. In particular, changes must
preserve FIFO outbox delivery (§7.1), whole-commit atomicity (§6.4), idempotent
retry (§2.3), retention floors (§4.6), snapshot application (§5.6), and atomic
reactive reads (§7.5).

[REMOTE.md](./REMOTE.md) requires every application-table relation to be bound
to the authenticated partition. A privileged query's authorization callback
grants access within that partition. It does not grant cross-partition reads.
[SYQL.md](./SYQL.md) remains authoritative for accepted SQL, generated query
plans, dependencies, and coverage.

The implementation retains one commit path and one generated query plan. It
does not add transport modes, weaken authorization, rewrite pending commit
contents, or change the release process. Unsupported inputs fail before SQL or
wire execution.

## 3. Correctness changes

### R1. Prove and rewrite every physical table relation

The current [authoritative query rewriter](../packages/server/src/authoritative-query.ts)
masks quoted identifiers before matching `FROM` and `JOIN`. Its completeness
check records distinct table names. An unquoted occurrence can satisfy that
check while another occurrence of the same table remains unpartitioned.

For example, this generated local query is accepted by typegen:

```sql
SELECT b.title
FROM tasks a
JOIN "tasks" b ON a.id = b.id
```

The first relation becomes a partition-filtered derived table. The quoted
relation remains the underlying server table. Matching row IDs in another
partition therefore contribute results. A host must register this query before
a remote caller can invoke it; the request does not supply arbitrary SQL.

Typegen should emit a relation plan for each physical statement. The plan must
identify every physical application-table occurrence, its resolved table and
alias, and its replacement boundary in that exact statement. CTE references
must resolve through the compiler's relation analysis. A set of table names is
insufficient evidence for repeated relations.

The generated descriptor must associate the relation plan with the selected
SQL variant. Registration and execution must reject missing, mismatched, or
unsupported plans before querying. The server inserts partition binds while
preserving the order and values of application binds. The host-provided
descriptor is trusted deployment code; request data cannot supply or replace
the relation plan.

Replace runtime relation discovery with this metadata and remove the regex
rewriter when the migration completes. Keep the portable generated descriptor
free of a runtime dependency on the compiler. Required metadata changes need a
documented regeneration step and updated generated fixtures.

The isolation fix must ship independently of that migration if necessary. A
first patch may reject SQL shapes whose complete relation set the existing
implementation cannot prove. It must inspect every occurrence and reject the
quoted example above. The later metadata implementation replaces this
restriction; it must not leave two runtime discovery paths.

Acceptance tests must execute through registered operations as well as the
storage contract. Seed two partitions with overlapping primary keys. Cover
mixed quoted/unquoted relations, quoted aliases, repeated relations, CTEs,
nested subqueries, comments, and dynamic statement variants. Run portable
cases on SQLite, Postgres, and D1. Accepted queries return only the caller's
partition; unsupported forms fail before execution. Comma joins already
rejected by typegen must remain rejected. Test both scoped and privileged
registration where their respective coverage rules permit the query.

### R2. Send a contiguous FIFO prefix

[Client outbox encoding](../packages/web-client/src/client.ts) must stop at the
first commit that exceeds the remaining operation budget. It must defer that
commit and every subsequent commit. The deferred count includes the entire
remaining suffix. A later, smaller commit cannot fill spare capacity.

Retain whole commits, stable commit IDs, and the existing handling of a first
commit that alone exceeds the server cap. Do not split or silently discard an
oversized commit. Schema-incompatible commits must continue through the
existing explicit rejection path.

Rust already stops at the first non-fitting commit. Extend the shared
conformance catalog to lock both cores to the same result. Queue commits of
499, 2, and 1 operations, with the second and third editing the same row. Assert
the first request contains only the first commit, subsequent delivery remains
FIFO, and the newest value survives. Add exact-cap, oversized-first,
lost-response, and restart cases. Assertions must inspect request order as
well as final convergence.

### R3. Make pruning atomic and the horizon monotonic

[pruneCommitLog](../packages/server/src/prune.ts) currently reads the horizon,
writes a candidate, then deletes history through separate storage calls. Two
passes can both read the old value and later assign their candidates in reverse
order. A failure after advancing the horizon can also leave cleanup unfinished,
while a retry skips deletion because the horizon no longer advances.

Move watermark advancement and history deletion into the existing
`pruneCommitsThrough` storage operation. Its proposed contract is:

```ts
pruneCommitsThrough(
  partition: string,
  input: { logEpoch: string; throughSeq: number },
): Promise<{
  previousHorizonSeq: number;
  horizonSeq: number;
  removedCommits: number;
}>;
```

Capture the log epoch before reading the retention inputs. Within one storage
transaction, verify that epoch still matches, then compute the effective
horizon as the maximum of the persisted horizon and the requested candidate,
advance the watermark, and delete eligible commit/change/scope records through
that horizon. Return
the values observed by that transaction. A transaction failure leaves all
records and the watermark unchanged. A retry after a committed but lost reply
performs harmless cleanup and returns the persisted horizon.

The top-level pruning function must call this operation even when its observed
horizon does not advance, so leftover records from older interrupted passes
can be removed. `prune.completed` must use the transaction's returned values.
Remove the independent setter from the production pruning path. Any retained
setter must enforce monotonic advancement within the same log epoch. Restore
rotation remains the explicit mechanism for starting a new log epoch; pruning
must serialize with it and reject an epoch mismatch before deleting anything.
The host must recompute retention inputs for a new attempt.

SQLite must use the storage transaction queue. Postgres must hold the partition
lock and use one connection. D1 must commit the watermark and deletion in one
atomic batch under its existing partition coordination. Pruning must preserve
application rows, push idempotency records, and durable reactions. Adapter
interface changes require updates to custom-storage documentation and test
doubles in the same change.

Use barriers to interleave two passes with different candidates. Inject failure
at each mutation boundary and after the commit but before the reply. Assert
that the watermark never decreases within an epoch and that deleted history
is always covered by it. Verify cleanup retries, retention boundaries, and
pulls below/at the final horizon across all storage adapters.

### R4. Sanitize unexpected hook failures

The catches in [push.ts](../packages/server/src/push.ts) must return static
public messages for unexpected row-validator, whole-commit-validator, and CRDT
merger failures. Retain the existing protocol codes:

| Failure source | Public code |
| --- | --- |
| Unexpected row or whole-commit validator exception | `sync.constraint_violation` |
| Unexpected CRDT merger exception | `sync.crdt_merge_failed` |

Deliberate `ValidationRejection` messages and validated rejection details
remain host-authored public content. Unexpected exception text must not enter
wire frames, persisted push results, client outcomes, or support diagnostics.
Hosts may capture the original error through an explicitly private diagnostic
sink. Diagnostic delivery must not affect transaction completion or retries.

Test a synthetic secret in each unexpected exception and assert its absence
from the initial result, cached replay, durable client outcome, and diagnostics.
Also verify deliberate host rejections retain their documented public fields.

Existing persisted rejection messages may contain historical exception text.
The fix prevents new disclosure; it must not claim to sanitize historical
records. Document this limitation. Any historical remediation needs a separate
policy that distinguishes deliberate host messages from unexpected failures
without breaking stored idempotency outcomes.

### R5. Order asynchronous observation results

[usePresence](../packages/react/src/use-presence.ts) must publish a response
only while it belongs to the current client, scope, and request generation.
Changing scope must stop exposing the previous scope's peers immediately,
including the render before the replacement effect completes. Cleanup must
invalidate outstanding requests.

Retain the existing array return type for this fix. Register invalidation before
starting the initial read. A failed newer request must not allow an older
request to become current. This RFC does not change the hook's error API.

Scan the same pattern in the reactive store's status, conflict, and outcome
reads. A direct change batch must invalidate an older pending snapshot read;
guarding only two successive requests is insufficient. Reuse existing revision
checks where snapshots expose revisions. Otherwise use request generations
and event ordering. Avoid a new general-purpose async framework.

Use manually resolved promises to test newer-before-older completion, scope
and client changes, unmount, failed newer reads, and a change event arriving
during the initial read. Run the shared store cases without React and the
presence lifecycle cases through React's promise-based client surface.

## 4. Resource and performance changes

### R6. Bound reactive query retention

[ReactiveClientStore](../packages/web-client/src/reactive-store.ts) retains
query entries by SQL, parameters, and other identity fields. Unsubscription
currently releases coverage claims but keeps the entry's last result. Every
change batch visits every historical entry.

The proposed default retains no inactive query results after a deterministic
microtask cleanup. Active equal queries must continue to share one entry and
one read per revision. Remove inactive entries from invalidation dispatch as
soon as their last subscriber leaves. Release their rows and store-owned
references during cleanup. No wall-clock eviction timer is required.

Account for entries allocated during a render that never subscribes. Cache
registration and subscription must allow a later subscription to reacquire or
join the current entry; cleanup must not leave two active entries for one key.
StrictMode cleanup/resubscription must preserve sharing and coverage ownership.
After an entry becomes inactive, its pending read must not repopulate the
retained cache. A remount after eviction performs a fresh atomic read.

Apply the same ownership audit to window entries and empty window-claim groups.
Keep a group alive until its pending release and waiters settle. Clear retained
state on final disposal while preserving the provider's documented restart
lifecycle. Existing lifecycle methods should own this cleanup.

Test 10,000 distinct parameter sets, including completed reads and abandoned
renders. After unsubscription and scheduler flush, retained inactive entries
and result rows must be zero. Keep one active query throughout and verify its
sharing, row identity, and coverage. A change batch's dispatch count must depend
on active entries, with no visits to the 10,000 historical entries. Benchmark
heap use and invalidation latency before and after this change.

### PERF1. Read only the outbox data each caller needs

[listOutbox](../packages/web-client/src/outbox.ts) parses the complete queue.
Several callers need only a count or existence check. Replace those uses with
`COUNT(*)` or `EXISTS` queries. Preserve the public `pendingCommits()` behavior
for callers that explicitly request complete commits.

Encode a bounded FIFO prefix for each sync request using ordered keyset reads
over `seq`. Stop after the first non-fitting commit. Compute the deferred count
without decoding the remaining operation bodies. At the 500-operation cap,
non-empty commits require at most 501 commit bodies to identify the boundary,
apart from commits explicitly processed by schema-incompatibility recovery.
A single atomic commit can still be larger than the cap.

Do not bound away optimistic replay or rollback work required by §7.1. Inspect
Rust's in-memory outbox separately; avoid adding SQL pagination to a core that
already holds its queue in memory.

Benchmark queues of 100, 1,000, and 10,000 commits with mixed operation counts.
Record decoded bodies, bytes allocated, SQL calls, and complete drain time.
Routine status reads must decode zero operation bodies. Keep the FIFO,
restart, rejection, and lost-response conformance cases passing.

### PERF2. Coalesce cold image builds and reduce staging memory

[SQLite-image bootstrap](../packages/server/src/pull.ts) checks the segment
cache, reads the complete snapshot into an array, builds an image, then stores
it. Concurrent misses can build the same image independently.

Share one in-flight build per storage/segment-store instance and complete
segment identity: partition, log epoch, table, schema version, media type,
effective-scope digest, and bootstrap pin. Clear the in-flight entry on success
and failure. Build sharing must occur only after each request's authorization.
Signed URLs remain request-specific grants issued after the artifact exists.
One request's cancellation must not cancel a build still awaited by another.

This change provides process-local coalescing. It does not claim one build
across multiple server processes. Cross-process coordination requires evidence
from a deployment benchmark before adding a distributed lock.

Refactor the existing image builder to accept bounded row batches and insert
them incrementally. Replace the complete `StoredRow[]` staging array. Preserve
the bootstrap pin, row versions, keyset ordering, schema metadata, and final
content-address verification. The database image and serialized output still
consume memory; measure them separately from source-row staging. Hosts with a
custom `sqliteImageBuilder` need an explicit migration if its interface changes.

Use barriers to start 20 requests for the same cold artifact and assert one
build within the owning instance. Separate scope digests, partitions, epochs,
and pins must never share artifacts. Test failure, cancellation, retry, and
signed-URL issuance. Benchmark cold and warm 100,000-row bootstraps, concurrent
misses, peak memory, and complete client convergence.

### PERF3. Aggregate retention cursors in storage

Pruning and [admin horizon status](../packages/server/src/admin.ts) both load
all client cursors to compute an active minimum. Add one shared storage
aggregate returning the minimum cursor whose `updatedAtMs` is at or after the
supplied cutoff, or `null` when no active cursor exists. Use the existing
adapter SQL facilities and verify the query plan before adding an index.

Use this aggregate in both callers and delete their duplicated array
filter/map/spread logic. Keep cursor enumeration for any actual listing use.
Preserve the active-window boundary and the existing interpretation of an
empty active set. The aggregate does not replace atomic pruning from R3.

Test no clients, only inactive clients, cutoff equality, negative bootstrap
cursors, and more than 100,000 client records. Assert that both callers receive
one scalar result and do not enumerate client identities. Benchmark transfer,
allocation, and execution time on every storage backend.

## 5. Public interfaces and code reduction

### D1. Name local mutation acceptance explicitly

[useMutation](../packages/react/src/use-mutation.ts) invokes `onSuccess` when
the local mutation resolves. Its `isPending` covers that local operation. The
server can subsequently reject the commit.

First, document this boundary on the public types and in mutation examples.
Show how the returned commit ID connects to `commitOutcome`,
`useCommitOutcomes`, and resolution actions. Applications should distinguish
local persistence, queued sync work, and a terminal server outcome.

In the next explicitly documented source-breaking API revision, replace
`onSuccess` with `onEnqueued`. Keep the callback's commit ID and local completion
timing. Provide a direct migration example. Do not retain two callback names or
add a new receipt object while the existing outcome journal serves this need.

Tests must show that local enqueue succeeds while offline, that a later server
rejection appears in outcomes, and that restart preserves the outcome lookup.
The rename changes no SSP2 frame or Rust commit semantics.

### D2. Consolidate the application-facing client contract

The direct client exposes some state as getters, while the worker exposes
methods. [React's client interface](../packages/react/src/client.ts) accepts
both through value-or-method and sync-or-promise unions. The worker protocol,
normalizer, and native bridges repeat related declarations.

Use the existing snapshot methods as the canonical application-facing read
contract. Consolidate shared declarations around `statusSnapshot`,
`querySnapshot`, diagnostics, and commit-outcome methods. Promise-based host
projections should derive from the shared method contract where their types
permit it. Keep synchronous database primitives inside the direct cores.

Inventory actual consumers before removing a getter or adapter. Migrate React
and host bindings together, then remove obsolete union branches and forwarding
code. Public removals belong to the same documented source-breaking revision
as D1. Key-bearing activation and runtime-specific resources remain explicit
host capabilities; a common interface must not weaken their types.

Acceptance requires compile-time fixtures for direct clients, worker leaders
and followers, and native bridges, plus the same behavioral hook tests over
synchronous and delayed promise implementations. Preserve generated typed
mutation descriptors and query descriptors. Do not add another public facade
or a parallel command path.

### D3. Remove duplicated mechanisms as each change lands

Each implementation change must identify the code it replaces. R1 removes
runtime relation discovery after generated metadata becomes required. R3
removes separate production watermark assignment. PERF3 removes duplicated cursor
aggregation. D2 removes superseded getter normalization. R5 should localize
ordering checks in existing observation owners.

Retain shared storage contracts, the cross-core conformance catalog, and
backend-specific transaction implementations. File splitting by itself is not
an acceptance criterion. Run knip after removing obsolete code and update
exports and package documentation in the same change.

## 6. Test and benchmark policy

Add regression tests to the existing adjacent suites and shared catalogs.
Reproductions must assert the intended behavior and fail on the review
baseline. Do not encode incorrect behavior as a passing expectation.

| Area | Required test location or mechanism |
| --- | --- |
| Partition isolation | Server authoritative-query and registered-operation suites, storage contract, typegen fixtures |
| FIFO batching | Client tests and shared conformance catalog, executed against both cores |
| Pruning | Storage contract with barriers and injected failures; below/at-horizon pull cases |
| Error sanitization | Validator/CRDT tests, cached replay, client outcome assertions |
| Async observations | Reactive store tests, React hook tests, delayed host doubles |
| Cache retention | Query churn, abandoned renders, StrictMode, deterministic scheduler flush |
| Outbox cost | Instrumented database counts plus existing benchmark harness |
| Image builds | Controlled concurrent misses, builder counts, bootstrap convergence |
| Cursor aggregation | Storage contract and query-plan tests |
| API migrations | Type fixtures, React parity, worker RPC, native binding checks |

Replace the 2 ms polling sleep in
[the shared client-test helper](../packages/web-client/test/helpers.ts) with
completion signals from the operation or transport that owns the work. Update
its callers to await acknowledgements, applied revisions, explicit barriers, or
documented scheduler flushes. Do not replace sleeps with arbitrary fixed
microtask counts. Audit other timer uses and distinguish tests of injected
production scheduling from wall-clock waits used to guess readiness.

Extend enforcement of the no-sleep rule to the migrated helper and its callers.
Preserve the documented isolated Bun multi-tab lane; changing its runtime-crash
retry policy is outside this RFC.

Use the existing benchmark harness and retain machine/runtime metadata with
results. Record structural counts alongside p50/p95 latency and peak memory.
Loopback results must remain labeled as loopback. Add a browser worker/OPFS
measurement for changes affecting UI memory or bridge cost. Performance claims
require measured results; this RFC supplies workloads and invariants rather
than invented latency targets.

## 7. Compatibility and specification changes

| Change | Contract impact | Required documentation |
| --- | --- | --- |
| R1 | Enforces existing partition isolation; generated relation metadata requires regeneration | `REMOTE.md` §2, SYQL physical-plan contract, remote operation guide |
| R2 | Restores existing FIFO semantics | `SPEC.md` §§6.1 and 7.1, offline/conflict guidance |
| R3 | Changes the storage adapter contract; preserves retention semantics | `SPEC.md` §4.6, storage and operations guides, custom adapter examples |
| R4 | Changes unexpected public message text; preserves error codes | `SPEC.md` §§6.7, 6.8, and CRDT error rules; validation guidance |
| R5 | Corrects observation ordering and scope identity | `SPEC.md` §7.5 where shared observation guarantees apply, React presence guidance |
| R6 | Defines inactive result lifetime and remount behavior | Reactive store contract and React query/window guidance |
| PERF1 | Internal read optimization | Client contributor documentation and benchmark results |
| PERF2 | Changes builder ownership and potentially its host interface | Bootstrap/build-image documentation and benchmark results |
| PERF3 | Adds a storage aggregate and migrates its callers | Storage and admin documentation |
| D1/D2 | Source-breaking public API migration | React, client, worker, and native API migration guides |

The proposal introduces no new SSP2 frame layout. Any implementation that
requires one must first revise this RFC and follow `SPEC.md` §9. Generated
descriptor changes are source/build compatibility changes even when wire bytes
remain identical. Unsupported old descriptors must fail with regeneration
guidance before execution.

Client-surface behavior must remain equivalent across TypeScript and Rust.
Changes to shared semantics require both cores and a conformance scenario.
When one core already implements the required behavior, retain it and add the
shared regression case. React-only ownership fixes require the same host
behavioral tests across supported bridges; they do not require unrelated Rust
refactors.

Reader-facing behavior changes must update the relevant pages under
`apps/docs/src/content/`, including `guide-remote-operations.md`,
`server-storage.md`, `server-operations.md`, `platform-react.md`,
`concepts-conflicts.md`, and `concepts-windowing.md` as applicable. Feature-level
changes add newest-first entries to `apps/docs/src/changelog.mjs` linking to
the updated guide. Implementation entries in the changelog identify the changed behavior and migration steps.

## 8. Implementation sequence and completion criteria

1. Land R1 isolation enforcement and R2 FIFO repair with regressions. Complete
   R1 metadata migration before removing its temporary conservative checks.
2. Land R3 atomic pruning and R4 exception sanitization. Update every built-in
   storage adapter and the corresponding contract tests together.
3. Land R5 observation ordering and R6 cache ownership. Establish deterministic
   async and churn coverage before measuring the resulting performance.
4. Land PERF1 bounded outbox reads, PERF3 cursor aggregation, and PERF2 image
   build work as separate changes with before/after measurements. R2 is a prerequisite
   for PERF1; R3 is a prerequisite for integrating PERF3 into pruning.
5. Ship D1's documentation clarification. Complete the consumer inventory for
   D2, then perform the callback and interface migrations in a documented API
   revision. Remove superseded code and generated artifacts in the same work.

Every change must pass its targeted tests and `bun run check`. Shared client
semantics must also pass the explicitly enabled Rust conformance pairing.
Rust changes require `cargo test`, `cargo clippy -- -D warnings`, and the binding
gates activated by those paths. API changes require the affected binding checks
even when no Rust implementation file changes. Run the full applicable gates
again after integrating the final sequence.

The RFC is complete when all R, PERF, and D items have their acceptance evidence,
the timer-based helper is replaced, obsolete mechanisms are removed, and the
specification and user documentation updates are present. A performance
proposal that cannot meet its contract must be explicitly amended or withdrawn
with recorded measurements. An unfinished item cannot be counted as complete.

## 9. Implementation evidence (2026-09-05)

| Item | Implemented work | Verification | Acceptance status |
| --- | --- | --- | --- |
| R1 | Lexer-based relation analysis, per-statement QueryIR v4 metadata, metadata-based server rewriting, regeneration of repository descriptors, migration guidance | SQLite/PGlite/D1 partition and registered-operation tests; quoted joins, nested relations, CTE shadowing, bind preservation, invalid metadata, SQL variant selection; typegen suite | Complete; final gates below |
| R2 | Contiguous TypeScript outbox prefix; Rust already used this rule | Shared 499/500/501 operation scenarios pass for both clients, including lost acknowledgements; persistent SQLite reopen regression; initial epoch handshake drains an offline outbox with no subscriptions | Complete; final gates below |
| R4 | Static unexpected row-validator, whole-commit-validator, and CRDT messages; original errors remain available to host callback instrumentation | Server initial/replay/persistence tests, client outcome/diagnostic test, shared lost-rejection conformance; deliberate host rejection tests remain intact | Complete; final gates below |
| R5 | Presence generation and identity guards; shared value-read generations and event fencing; preserve method receivers; invalidate disposed reads and refresh on restart | 40 shared-store and React hook tests pass, including reversed completions, failed newer reads, status events, client/scope changes, cleanup and restart | Complete; final gates below |
| R3 | Atomic monotonic pruning with epoch validation, monotonic retained setter, continuity point read, and Durable Object maintenance method | Shared storage tests, controlled older/newer passes, restore race, injected failures before horizon/deletes/commit on all adapters, cleanup retries, and DO write-queue test | Complete; final gates below |
| R6 | Active-only dispatch, microtask eviction and row release, stale-render rejoining, pending-read generations, empty window-group cleanup, and disposal fencing | 10k churn and lifecycle regressions; 93 store/React tests; Chromium 151 heap and dispatch measurements below | Complete; final gates below |
| PERF3 | One active-cursor SQL aggregate shared by pruning and admin status | Shared boundary tests and 100,001-client tests on all adapters; callers reject enumeration; local plans and measurements below | Complete; final gates below |
| PERF1 | Count-only status/diagnostics, pinned keyset pages with lazy body decoding, and contiguous-prefix encoding | 100/1k/10k mixed-commit drains and zero-body status tests; before/after measurements below; Rust retains its in-memory queue | Complete; final gates below |
| PERF2 | Process-local build coalescing with complete identity, asynchronous batched image builder, per-request grants, and retry cleanup | 20-request barrier, authorization/grant counts, identity separation, failed build retry, cancelled stream, Bun runtime contract, 100k cold/warm client convergence; measurements below | Complete; final gates below |
| D1 | `onEnqueued` replaces `onSuccess`; callback and pending state describe local persistence | Offline enqueue, rejection after reconnect, and outcome lookup across two database reopens; React TSX files now included in the root typecheck | Complete; final gates below |
| D2 | Shared snapshot method contracts, promise projections, direct client identity in React, native snapshot/outcome wrappers; removed individual state getters/commands | Direct/worker compile fixture; synchronous and promise hook tests; leader/follower RPC tests; Tauri and RN bridge contracts; Swift/Kotlin/Dart real-core tests | Complete; final gates below |
| D3 | Removed runtime relation regex discovery, production split pruning, cursor enumeration in retention, getter normalizer, supervisor forwarding file/export, and duplicated snapshot declarations | Typecheck, lint, knip, runtime and native gates | Complete; final gates below |

The first integrated gate found outdated scenario-count documentation and an
incorrect scope-column mapping in a new test. Both were corrected. The final
integrated gate passed after all implementation items were integrated.

The intermediate gate after R1/R2/R4/R5 passed: 1,659 main-lane tests and 13
isolated multi-tab tests, plus typecheck, formatting/lint, knip, version checks,
and Bun/Node SQLite runtime checks. R3 adds further changes after that gate.
D1 batch atomicity was checked against the
[Cloudflare D1 database reference](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
and the maintenance RPC follows the
[Durable Object invocation contract](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/).
The D1 double proves local SQL and rollback behavior; it does not emulate remote
replica lag or network delivery. The DO maintenance test exercises the existing
partition FIFO without a wall-clock wait.

R6 browser benchmark: Chromium 151.0.7922.34 on local macOS arm64, three
fresh-page runs per version. `bench/src/reactive-churn.ts` creates 10,000
parameter keys, subscribes half long enough to read ten rows each, abandons
half, and retains one active query. CDP garbage collection precedes each heap
reading. The comparison uses the R5 implementation immediately before R6.
Retained heap delta was 16,023,880–16,024,080 bytes before and
275,104–275,508 bytes after. Total synchronous dispatch time for 200 matching
invalidations was 23.1–23.7 ms before and 0.2–0.4 ms after. Individual updated
dispatches fell below the browser timer resolution; zero-valued percentiles
do not establish zero execution cost. Active row identity remains covered by
tests. These measurements exclude a real database, transport, and UI rendering.

PERF3: `SYNCULAR_RETENTION_BENCH=1 bun test packages/server/test/storage.test.ts
-t '100001'` seeds 100,001 cursor records, half active at the inclusive cutoff.
Three local runs measured cursor enumeration versus aggregation: SQLite
11.5–13.5 ms versus 5.8–6.0 ms; PGlite 69.3–73.9 ms versus 7.7–8.7 ms;
D1 double 19.2–21.7 ms versus 6.0–7.9 ms. JSON result size fell from
5,327,843 bytes to 2 bytes. `process.memoryUsage().heapUsed` did not resolve
most short-lived allocations under Bun and supplies no reliable allocation
comparison. The record count and serialized result size establish bounded
result transfer; the tests assert that neither retention caller enumerates
client identities. SQLite uses its existing partition primary-key index.
PGlite chooses a sequential scan for this single-partition, 50%-active fixture.
No index was added. Remote Postgres and deployed D1 network latency remain
unmeasured; the D1 plan is the local SQLite plan.

PERF1: `SYNCULAR_OUTBOX_BENCH=1 bun test
packages/web-client/test/client.test.ts -t 'bounded outbox'` seeds 100, 1,000,
and 10,000 commits with repeating 1/2/3 operation counts, then drains through
the real SQLite server. The comparison restores the correct FIFO encoder
immediately before PERF1. One local run per version measured:

| Commits | Drain before/after | Decoded bodies before/after | Decoded JSON bytes before/after | Outbox SQL calls before/after |
| --- | --- | --- | --- | --- |
| 100 | 13.6 / 12.9 ms | 200 / 100 | 58,232 / 29,116 | 105 / 109 |
| 1,000 | 156.4 / 151.6 ms | 9,515 / 2,507 | 2,824,787 / 744,439 | 1,023 / 1,056 |
| 10,000 | 10,513 / 9,633 ms | 998,705 / 205,781 | 300,570,977 / 61,935,313 | 10,203 / 10,525 |

The SQL counter includes rollback-image reads. Keyset paging adds calls while
reducing decoded bodies. The first request reads 100/251/251 bodies after the
change; the old encoder decoded the full initial queue. A status plus
diagnostics read decoded 200/2,000/20,000 bodies before and zero after.
Complete optimistic replay still scans the remaining queue after each response;
its work dominates the 10k case and remains required by §7.1. Decoded JSON
bytes measure parser input, not exact JS object allocation. Process peak RSS
at the end of the 10k workload was 223.7 MB before and 219.1 MB after; this
includes SQLite, earlier workloads, and the server, so it does not isolate
encoder allocation. These single-run timings establish no throughput budget.

PERF2 local Bun/SQLite measurements, 100,000 rows, one run per case. Fixture
loading is outside the timer. The baseline restores the previous image path
and synchronous builder. The artifact has 4,407,296 bytes in both versions.

| Requests | Cold before/after | Warm before/after | Process peak RSS before/after |
| --- | --- | --- | --- |
| 1 | 238.9 / 192.0 ms | 0.41 / 0.30 ms | 222.5 / 152.0 MB |
| 20 concurrent | 3,340.4 / 197.9 ms | 3.35 / 1.34 ms | 2,061.4 / 146.4 MB |

Concurrent cold misses previously staged 2,000,000 source rows across twenty
builds. They now stage 100,000 rows through one build, with a maximum observed
batch of 5,000 rows. Peak RSS includes fixture storage and image buffers; it
is not a source-row-only allocation measurement. Separate end-to-end tests
converged a cold client in 205.8 ms and a warm client in 25.1 ms, including
content-address verification and local image application.

A separate write-path follow-up surfaced during fixture loading: SQLite
`writeRow` deletes `sync_row_scopes` by `(partition,tbl,row_id)`, while the
primary key orders `(partition,tbl,var,value,row_id)`. Loading 100k distinct
rows through replacement writes exceeded one minute locally before the test
was stopped. Bootstrap measurements use bulk fixture insertion. Investigate
a row-oriented index with write/read plans and measurements before folding
this separate finding into a production change.

### Interface consumer inventory

The migration scan resolved property references against the direct client type
before renaming them. It updated 64 references across tests, demos, and client
consumers. Status fields remain one atomic snapshot; immutable identity and
runtime ownership APIs remain concrete host capabilities.

| Consumer | Contract and migration |
| --- | --- |
| Direct TypeScript client | `conflicts()`, `rejections()`, and `securityLifecycle()` methods; four state getters replaced by snapshot fields |
| Worker leader and follower | `WorkerApi` derives snapshot methods from `ClientSnapshotMethods`; `SyncClientHandle` implements its promise projection; four redundant RPC methods removed |
| React provider, hooks, resources | `ClientSnapshotReader` accepts direct or promised results; provider retains the supplied identity; normalizer and getter unions removed; callback renamed |
| Tauri and React Native | Concrete bridges implement the promise snapshot projection; behavioral contract suites retain generated query decoding and host-specific security activation |
| Swift, Kotlin, Dart | Snapshot and outcome conveniences call the existing command dispatcher; obsolete state commands rejected; JSON value representations retained |
| Rust conformance driver | Reads status fields from one command; Rust internal synchronous core methods retained |

Removing the normalization facade also removes
`realtime-supervisor-observation.ts` and its package subpath. The realtime
supervisor now resolves attachments by the actual client identity. Root
TypeScript checking includes React TSX tests and direct/worker type assertions;
Tauri and RN gates compile their actual example apps. The Tauri example now
sets `customConditions: ["bun"]` to follow the repository's dist-free contract.

### Readiness audit

The shared client helper subscribes before checking its predicate and resolves
from owner notifications. Realtime tests await client change/sync-needed
signals, cursor persistence, or supervisor state. Worker RPC tests await
completed calls and explicit socket state notifications. An enforcement test
rejects sleeps in that helper and its three migrated callers. The HTTP error
case now awaits its rejection assertion directly.

The remaining audit findings are pre-existing wall-clock readiness guesses,
not tests of an injected production clock:

| Location | Existing wait | Follow-up boundary |
| --- | --- | --- |
| `packages/server/test/realtime.test.ts` | 5 ms predicate polling | Hub delivery completion |
| `packages/server/test/postgres-fanout.integration.test.ts` | 200 ms LISTEN delay and 50 ms delivery polling | LISTEN acknowledgement and notification callback |
| `packages/web-client/test/serialization.test.ts` | Two 5 ms delays and a 1.5 s race | Existing segment barrier and operation promises |
| `packages/web-client/test/multi-tab.test.ts` | 4 ms polling | Leadership and channel notifications |

This RFC migrates the shared helper and its callers, as specified in §6. The
remaining sites are recorded for a separate deterministic-readiness migration.
The isolated multi-tab lane and its documented runtime-crash retry remain
unchanged. No new wall-clock sleeps or unsafe TypeScript casts were introduced.

### Browser worker and OPFS measurement

Chromium 151.0.7922.34, macOS arm64, three fresh browser contexts per version.
The page uses the real `SyncClientHandle`, `startSyncWorker`, and
`openPersistentWasmDatabase` with `opfs-sahpool`. A persistent table holds ten
rows with 200-character titles. The workload creates 10,000 parameter keys,
reads 5,000 through worker RPC, and abandons the other 5,000. Each completed
read must return all ten rows; readiness comes from the observation callback.
The page retains the store, releases all subscriptions, and collects garbage
through CDP before measuring its heap. The baseline substitutes the shared
store immediately before R6; the worker and current snapshot methods are the
same in both runs.

| Metric | Before R6 | After R6 |
| --- | --- | --- |
| Retained page heap delta | 20,407,628–20,407,880 bytes | 275,220–275,400 bytes |
| Query RPC plus publication p50, 5,000 reads/run | 0.2 ms | 0.2 ms |
| Query RPC plus publication p95 | 0.3 ms | 0.3–0.5 ms |
| Status RPC p50, 200 reads/run | 0.1–0.2 ms | 0.1–0.2 ms |
| Status RPC p95 | 0.2–0.5 ms | 0.2–0.3 ms |

The updated cache reports zero retained query/window entries and claims at the
end. Page heap excludes the worker heap and WASM memory. The experiment proves
bounded page retention through the real persistent bridge; it establishes no
improvement in RPC latency and includes no network sync.

### Repeated outbox measurements

Two additional isolated runs repeat PERF1 against the same correct-FIFO
baseline, giving three runs per version. Structural counts match the first
run. These are empirical percentiles across three complete drains; the p95
is the largest sample and is not a production tail-latency estimate.

| Commits | Drain p50 before/after | Drain p95 before/after |
| --- | --- | --- |
| 100 | 13.7 / 16.1 ms | 15.3 / 21.9 ms |
| 1,000 | 160.6 / 157.9 ms | 173.9 / 178.4 ms |
| 10,000 | 10,521 / 9,718 ms | 12,136 / 10,288 ms |

The small-queue timing does not improve consistently. Paging adds SQL calls;
its established benefit is bounded encoder decoding and zero body decoding
for status reads. At 10k, observed peak RSS ranged from 221.1–228.4 MB before
to 205.6–219.1 MB after. Allocation claims remain limited to the recorded
parser input counts and process memory measurements.

### Repeated image and cursor measurements

PERF2 also has three isolated runs per case. Empirical p95 is the largest of
three samples. The same workload and limitations as the first run apply.

| Requests | Cold p50 before/after | Cold p95 before/after | Warm p50 before/after | Warm p95 before/after |
| --- | --- | --- | --- | --- |
| 1 | 178.1 / 186.9 ms | 238.9 / 192.0 ms | 0.255 / 0.255 ms | 0.414 / 0.302 ms |
| 20 | 3,427.6 / 196.9 ms | 3,500.1 / 197.9 ms | 2.357 / 1.344 ms | 3.354 / 1.703 ms |

Single-request median build latency did not improve. The concurrent build
count remains twenty before and one after. Peak RSS for twenty requests
ranged from 1,980–2,061 MB before to 146–159 MB after. For one request it ranged
from 220–226 MB before to 150–156 MB after. This supports the coalescing and
source-row memory changes without claiming a universal latency improvement.

PERF3's three recorded repetitions yield the following empirical percentiles:

| Backend | Enumeration p50/p95 | Aggregate p50/p95 |
| --- | --- | --- |
| SQLite | 12.2 / 13.5 ms | 5.9 / 6.0 ms |
| PGlite | 69.8 / 73.9 ms | 7.8 / 8.7 ms |
| D1 double | 20.6 / 21.7 ms | 6.0 / 7.9 ms |

Exact object-allocation bytes and deployed database percentiles remain
unmeasured. The implementation uses decoded input bytes, transferred result
bytes, page heap after GC, and process peak RSS for the distinct memory costs
each instrument can resolve. These measurements establish no release latency
budget; production capacity planning requires its own workload and host.

### Final verification

- `bun run check`: 1,701 main tests passed, 7 opt-in tests skipped, and all 13
  isolated multi-tab tests passed without the retry. Version validation,
  TypeScript including React TSX, lint/format, knip, and both Node SQLite
  adapter contracts passed.
- Explicit Rust-client × TypeScript-server conformance: all 104 catalog
  scenarios passed. The main gate also runs the TypeScript pairing.
- Rust workspace: formatting, clippy on all targets with warnings denied,
  and 108 tests passed. Five native-transport socket-round tests passed.
- Tauri: all three clippy feature lanes, default/native-transport tests,
  frontend bundle and typecheck, real native-to-TypeScript bridge tests
  (6 passed), and the example native build passed.
- Swift: 11 binding tests and the example build passed. Kotlin: 11 binding
  tests and the example compile passed using Temurin 21.0.12.1 and Gradle 9.7.1.
  Dart 3.13.3: analyzer and all 12 binding tests passed. React Native: 31 JS
  bridge/example integration tests and typecheck passed.
- Targeted before/after benchmark runs passed. Temporary baseline substitutions
  were restored. `git diff --check` passed, and the added-code audit found no
  `as any`, `as unknown`, or wall-clock sleep calls.

The seven skipped main-gate tests require an external Postgres connection or
opt-in template installs. PGlite and the D1 double cover the storage contracts;
deployed Postgres/D1 behavior and native mobile device builds were not run.
The remaining timer audit sites and the scope-deletion index investigation
above are follow-up work outside the implemented changes. Those verification runs preceded release preparation. Release 0.16.0 includes
the implemented changes and the documented source migrations.
