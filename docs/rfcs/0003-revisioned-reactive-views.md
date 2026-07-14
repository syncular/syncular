# RFC 0003 — Revisioned reactive views across every client engine

- **Status:** Implemented for Syncular 0.5.0 on 2026-07-14. V0–V7 are green,
  including the browser and real Tauri/native bridge lanes, strict local-data
  performance gates, release documentation, and the Diego consumer migration.
  Native transport and read-path hardening shipped in 0.5.1 after live Tauri
  observation exposed two host-specific gaps (§15.1).
- **Date:** 2026-07-14
- **Scope:** `packages/web-client`, `packages/react`, `packages/typegen`,
  `packages/tauri`, `rust/crates/client`, `rust/crates/command`,
  `rust/crates/ffi`, `bindings/tauri`, `bindings/react-native`, the thin
  Swift/Kotlin/Flutter FFI wrappers, conformance, benchmarks, docs
- **Source:** the Diego `ui-poc` integration after Syncular 0.4.1, using one
  React tree over the browser worker/OPFS engine and the Tauri/Rust engine.
  The web integration is clean in ordinary use, but it exposed a timing-based
  query/window boundary, duplicated application metadata, avoidable worker/IPC
  traffic, and concrete native parity gaps.

## Summary

A UI should declare **what local data it reads**. Syncular should own the rest:
which window units make that read answerable, when those units must sync, which
local change makes the read stale, and which result is new enough to publish.

Today those responsibilities are split between generated queries, React hooks,
host scheduling, and application code. The split makes a truthful render depend
on issue order across multiple asynchronous reads. It also lets the TypeScript
and Rust hosts expose materially different invalidation and wake behavior while
still satisfying the same structural interface.

This RFC replaces that arrangement with one end-state architecture:

1. Every observer-visible local transaction commits a monotonically increasing
   **local revision**.
2. A live query reads its rows, required-window answerability, and revision from
   **one SQLite read snapshot**.
3. Both the TypeScript and Rust cores emit the same exact, revisioned
   **change batch** from the observer transaction boundary. Bridges forward
   it; they do not infer it by diffing unrelated counters.
4. Typegen emits table/scope dependencies, window coverage, parameter presence,
   and safe row identity with each named-query descriptor.
5. One client-scoped reactive store owns invalidation routing, query de-duplication,
   latest-revision wins, row reconciliation, status/conflict snapshots, and
   window ownership. React is a `useSyncExternalStore` adapter over it.
6. Window changes and local writes return explicit sync intent. Browser and
   native hosts run one event-driven wake policy; neither polls for work.
7. Client identity is generated and persisted by the core by default.

The target Diego code is deliberately boring:

```tsx
const todos = useQuery(listTodosQuery, { listId: list });
const mutation = useMutation();

const toggle = (row: TodosRow) =>
  mutation.patch(todosTable, {
    id: row.id,
    done: !row.done,
    updatedAtMs: Date.now(),
  });

if (todos.phase === 'loading') return <TodosSkeleton />;
if (todos.phase === 'error') return <ErrorState error={todos.error} />;
if (todos.phase === 'ready' && todos.rows.length === 0) return <EmptyState />;

return (
  <TodoRows
    rows={todos.rows}
    partial={todos.phase === 'partial'}
    onToggle={toggle}
  />
);
```

There is no hand-authored `WindowBase`, `setWindow` effect, separate
completeness read, settle timer, row-at-switch ref, request-order assumption,
or platform-specific refresh behavior.

## 1. Problem statement

### 1.1 Query rows and completeness are independent reads

`useQuery` currently re-runs a local SQL query after a matching invalidation.
`useWindow` independently re-reads `windowState`. A zero-row bootstrap can make
a window complete without changing any query row, so the completeness oracle
is necessary: local `[]` is not truthfully empty until the relevant window is
complete.

The two reads have no shared revision. `useWindow` therefore waits through two
`FrameScheduler` boundaries so query reads are issued before the completeness
read on the FIFO worker/IPC channel. That removed the ordinary false-empty
frame in 0.4.1, but it makes correctness depend on render scheduling and issue
order. Fast cross-window switching can still expose an edge, and another host
can preserve the structural API without preserving the same ordering.

Scheduling is useful for coalescing work. It must not decide whether data is
truthful.

### 1.2 The Tauri bridge does not carry the web client's change truth

The TypeScript client accumulates exact touched tables and available scope
keys at its single apply-path choke point. The Tauri plugin does not forward an
equivalent event from the Rust core. It snapshots counts after a command and
emits a bare `{ type: "invalidate" }` when a mutation or selected count change
suggests that data may have changed.

The bridge normalizes missing `tables` and `scopeKeys` to empty sets. React
correctly rejects an invalidation whose table set does not intersect the
query's dependencies. Consequently the event exists but cannot refresh a live
query or window oracle. Counter diffing also misses observer-visible changes
which do not alter pending-commit or conflict counts, including bootstrap and
remote-apply shapes.

This is not a bridge defaulting bug. It is missing native core output. Treating
an empty event as global would hide the contract violation and throw away the
precision the architecture needs.

### 1.3 Native window changes do not create sync work

The web worker schedules auto-sync after `setWindow`, because a widened unit
needs a bootstrap even if no unrelated realtime wake arrives. Rust
`set_window` updates subscriptions and the registry but does not set
`sync_needed`. The Tauri owner loop only runs a round when a 200 ms poll finds
that flag, then optionally sleeps for jitter.

Thus native window bootstrap is neither guaranteed by `setWindow` nor prompt
when another signal happens to make it eligible. The core should describe the
work it created, and the host should wake from that description immediately.

### 1.4 Hook-local async state has stale-result races and duplicates work

Each query hook owns its own invalidation listener, scheduler, in-flight read,
row hash baseline, and React state. A shared boolean cancellation flag protects
unmount, but it is not a request generation. During an A → B query change, A
can resolve after B starts and publish stale rows. Status and conflict hooks
have the same general overlapping-read problem.

Identical queries mounted in two components also issue two SQL reads. One data
change in the current PoC can cause a query RPC, a later window-state RPC, five
status RPCs, and two conflict RPCs. Most of those reads are unrelated to the
changed domain.

### 1.5 Typegen knows facts the application repeats

The manifest and query IR jointly know that:

- `todos` is scoped by `list_id` with scope prefix `list`;
- `WHERE list_id = :listId` restricts the query to one scope value;
- the corresponding value-sharded subscription/window base is `todos/list_id`;
- `id` is the primary key and is projected by the query;
- the query has parameters, independently of JavaScript function arity.

The generated descriptor currently carries only `sql`, `tables`, `bind`, and
optional `sqlFor`. The app therefore repeats window metadata and cannot pass
precise scope dependencies without hand-building them. The runtime then
reconciles row objects by array index because it was not told the generated
row key.

### 1.6 Application lifecycle and identity leak through the abstraction

Tauri requires the caller to manufacture and persist a `clientId`, while the
web core can own persisted identity. React 18/StrictMode initialization also
encourages apps to keep a module-level engine promise to avoid double creation.
Mutation errors are stored and re-thrown but cannot be reset explicitly, so an
app often mirrors the same error into another state just to render and clear
it predictably.

These are not app-domain decisions. They belong to the client and integration
runtime.

## 2. Goals and invariants

The implementation is accepted only if all of these hold.

### R1 — one atomic view truth

A query result and its answerability verdict come from one SQLite read
snapshot. A consumer never combines rows from revision `r` with a completeness
claim from revision `r + n`.

### R2 — revision ordering, never promise ordering

Every result and change batch carries a local revision. Older async results
cannot overwrite newer state, regardless of resolution order, React lifecycle,
worker scheduling, or IPC latency.

### R3 — exact core-originated changes on every engine

TypeScript and Rust produce the same table/scope/window/status/conflict change
domains at the same transaction boundaries. Host adapters forward normalized
core output. They never reconstruct data changes from outbox length, conflict
count, method name, or another proxy.

### R4 — completeness remains honest

A newly claimed or reset unit is incomplete until its bootstrap finishes,
including a zero-row bootstrap. A missing, pending, or partially held scope is
never represented as complete.

### R5 — window ownership composes

Two mounted consumers of the same window base cannot overwrite one another.
The effective window is the union of active claims. Releasing one claim removes
only units no other claim holds.

### R6 — generated precision is proven, never guessed

Typegen emits scope coverage and row identity only when it can prove them from
schema/query IR or an explicitly checked directive. Ambiguous queries fall
back conservatively or fail generation with an actionable error.

### R7 — one observer, one read

Equal query descriptors and canonical parameters share one store entry and one
SQL read per revision, independent of how many React components observe them.

### R8 — no polling on an interactive path

Mutation, window widening, realtime traffic, retry deadlines, and explicit
refresh all wake the owning loop through events or deadlines. No fixed-interval
poll is required for correctness or normal latency.

### R9 — engine-neutral user code

The generated descriptor, hook result state machine, invalidation semantics,
and auto-sync behavior are identical over in-process TypeScript, worker/OPFS,
Tauri/Rust, and future native bindings.

## 3. Local revision and atomic query snapshots

### 3.1 Persisted local revision

Each client database stores a `u64` local revision in Syncular metadata. It
starts at zero and increments exactly once for any committed transaction that
changes observer-visible state:

- materialized or optimistic rows;
- subscription/window registration or completeness;
- deferred eviction completion;
- outbox/status fields exposed by the client;
- conflicts or rejections;
- schema-floor, auth-lease, upgrade, or reset state.

The increment is in the same SQLite transaction as the change. The change
batch is emitted only after commit. A rolled-back transaction consumes no
public revision and emits nothing.

The normalized TypeScript API represents a revision as `bigint`. Worker
structured clone carries it directly. JSON bridges encode it as a decimal
string and parse it at the boundary, so no `u64` value passes through an
unsafe JavaScript number.

A state-only transition which does not otherwise need a data transaction is
serialized by the core as a metadata-only observation transaction. This keeps
status and query events in one total order instead of adding a second sequence
whose races every host would have to reconcile.

Revision is local-database state, not an SSP cursor or server commit sequence.
It survives client restart and schema re-bootstrap, alongside client identity
and the outbox, and resets only when the local client database is deliberately
destroyed.

### 3.2 Query snapshot API

The normalized client gains one read primitive:

```ts
interface QueryReadSpec {
  readonly sql: string;
  readonly params?: readonly SqlValue[];
  readonly coverage?: readonly WindowCoverage[];
}

interface WindowCoverage {
  readonly base: WindowBase;
  readonly units: readonly string[];
}

interface WindowUnitRef {
  readonly baseKey: string;
  readonly unit: string;
}

interface CoverageSnapshot {
  readonly complete: boolean;
  readonly pending: readonly WindowUnitRef[];
  readonly missing: readonly WindowUnitRef[];
}

interface QuerySnapshot<Row = SqlRow> {
  readonly revision: bigint;
  readonly rows: readonly Row[];
  readonly coverage: CoverageSnapshot;
}

querySnapshot<Row>(spec: QueryReadSpec): Promise<QuerySnapshot<Row>>;
```

The core opens one SQLite read transaction, reads the revision, executes the
SQL, evaluates every requested window unit against the registry/subscription
state, and closes the snapshot. Rows and coverage therefore describe the same
local state.

`query()` remains the low-level raw read API, but reactive integrations use
`querySnapshot()`. `windowState()` remains useful for diagnostics and explicit
window management; render-boundary correctness no longer composes it with a
separate query promise.

### 3.3 Race resolution

The reactive store tracks the highest change revision seen for a query entry.
If a snapshot at revision 20 resolves after a matching change at revision 21,
the store may retain it as explicitly stale data for the same query key, but it
must not publish it as current or `ready`; it immediately schedules one
revision-21-or-newer read. A snapshot older than the entry's already published
snapshot is discarded entirely.

This rule closes query-identity, invalidation-during-query, refresh, StrictMode,
worker, and Tauri completion-order races with one mechanism. Per-hook boolean
cancellation is no longer part of correctness.

### 3.4 Query result state machine

The public live result has explicit phases:

```ts
type LiveQueryPhase = 'loading' | 'partial' | 'ready' | 'error';

interface LiveQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly phase: LiveQueryPhase;
  readonly revision: bigint | undefined;
  readonly error: Error | undefined;
  readonly isRefreshing: boolean;
  readonly refresh: () => void;
}
```

- `loading`: no current complete snapshot and no useful partial rows exist.
- `partial`: the atomic snapshot contains rows but at least one required unit
  is pending or missing. The app may render them with an honest partial marker.
- `ready`: every required unit is complete. `rows.length === 0` now means
  truthfully empty.
- `error`: the first usable snapshot failed. When a previously usable snapshot
  exists, it remains visible with `isRefreshing`/`error` rather than being
  replaced by rows from another query identity.

A query-key change selects a different store entry. Rows from the previous key
are never relabeled as the new query's data.

## 4. The revisioned change-batch contract

### 4.1 Public shape

The current pair of global `tables` and `scopeKeys` sets loses which scope key
belongs to which table. Replace it with table-associated changes and explicit
observer domains:

```ts
interface TableChange {
  readonly table: string;
  /** undefined means table-wide / no more precise fact was available. */
  readonly scopeKeys?: ReadonlySet<string>;
}

interface WindowChange {
  readonly baseKey: string;
  readonly table: string;
  readonly units: ReadonlySet<string>;
}

interface SyncStatusSnapshot {
  readonly outbox: number;
  readonly upgrading: boolean;
  readonly leaseState: LeaseState | undefined;
  readonly schemaFloor: SchemaFloor | undefined;
  readonly syncNeeded: boolean;
}

interface ClientChangeBatch {
  readonly revision: bigint;
  readonly tables: readonly TableChange[];
  readonly windows: readonly WindowChange[];
  readonly status?: SyncStatusSnapshot;
  readonly conflictsChanged: boolean;
  readonly rejectionsChanged: boolean;
}
```

`syncNeeded` is specifically the coalesced inbound pull/catch-up signal. It is
not a lossy synonym for pending local work: `outbox` reports durable pushes,
while command effects carry the exact interactive/background scheduling intent.

An omitted `scopeKeys` is an honest table-wide change. An empty set is never
used to mean global. A window completion with zero rows can carry a window
change without inventing a row change. Query descriptors that depend on that
coverage still re-read; unrelated table-only queries do not.

Routing is deterministic: a table-wide change matches every dependency on that
table; a scoped change matches a table-wide dependency or an intersecting
table-associated scope key; a window change matches coverage on the same
canonical base and unit; status/conflict-only domains never refresh SQL.

The batch may contain several domains because one transaction can update rows,
drain an outbox item, complete a window, and record a conflict atomically.

### 4.2 One accumulator per transaction in both cores

The TypeScript and Rust clients each implement the same accumulator operations:

- `table(table)` — table-wide change;
- `scope(table, scopeKey)` — precise scoped change;
- `window(baseKey, table, unit)` — registration/completeness change;
- `status()` — include the post-commit status snapshot;
- `conflicts()` / `rejections()` — mark the corresponding collection changed.

Every local apply path feeds this accumulator: commit apply, segment/image
apply, optimistic overlay rebuild, mutate, revocation purge, schema reset,
window widen/shrink, deferred eviction, outbox drain, conflict/rejection, and
zero-row bootstrap completion. The transaction wrapper increments the revision,
freezes one batch, commits, then emits it.

Scope-changing updates record the union of the row's before and after scope
keys; deletes record the before keys and inserts the after keys. Otherwise a
row moving from list A to list B could refresh B while leaving A stale. Bulk
formats which cannot provide per-row before/after facts remain honestly
table-wide.

The Rust core exposes batches directly through the command/FFI event queue.
The Tauri plugin deletes `ObservedState`-based data inference. The web worker,
Tauri bridge, FFI bindings, and future React Native/Swift/Kotlin bridges only
encode/decode the core event.

### 4.3 Status and conflict reads

The normalized client adds `statusSnapshot()` so an initial status read is one
core call rather than `pendingCommits()` plus four independent accessors.
Change batches include the full new status only when status changed, allowing
the reactive store to update without another worker/IPC round trip.

Conflicts and rejections remain potentially larger collections. Their changed
flags invalidate one shared collection store, which fetches the two collections
once per revision no matter how many components observe them. A future paged
API can replace that fetch without changing the change-batch contract.

## 5. Generated reactive-query metadata

### 5.1 Descriptor

Named-query generation grows from SQL plumbing into a complete reactive read
descriptor:

```ts
interface NamedQuery<Row, Params = undefined> {
  /** Includes the generated IR hash, so a changed query cannot reuse a cache. */
  readonly id: string;
  readonly hasParams: boolean;
  readonly sql: string;
  readonly sqlFor?: (params: Params) => string;
  readonly bind: (params: Params) => readonly QueryValue[];
  readonly dependencies: (params: Params) => readonly QueryDependency[];
  readonly coverage: (params: Params) => readonly WindowCoverage[];
  readonly rowKey?: (row: Row) => readonly QueryValue[];
  readonly __row?: Row;
}

interface QueryDependency {
  readonly table: string;
  /** undefined means every change to this table can affect the query. */
  readonly scopeKeys?: readonly string[];
}
```

`tables` can remain as generated compatibility information for non-reactive
consumers, but the reactive store routes from `dependencies`.
`hasParams` is explicit; runtime behavior never inspects `bind.length`.

### 5.2 Dependency and coverage inference

Typegen extends query analysis with column origin and predicate facts. It emits
a table-specific scope key only when all paths that read that table are proven
to be restricted to the corresponding scope value. Equality and checked `IN`
predicates over scope columns are the first supported forms. Optional groups,
backend variants, aliases, and imported predicates are evaluated in revision-1
SYQL QueryIR, not by regex over emitted SQL.

Coverage is emitted when the complete predicate footprint maps to a declared
value-sharded subscription/window base. Fixed scope literals and parameterized
units are included. A query which can read outside the proven units gets
table-wide dependencies and no automatic coverage.

Revision-1 SYQL derives dependencies from ordinary checked scope predicates.
`sync query` separately declares coverage intent and is rejected unless the
complete scope footprint can be proven. A shape that cannot be proven falls
back table-wide and uncovered; there is no unchecked metadata escape hatch.

Typegen never guesses coverage from a similarly named parameter.

### 5.3 Row identity

Typegen emits `rowKey` only when the projection is proven to contain a unique
key for each result row. A simple single-table query projecting its primary key
qualifies. Identity is inferred rather than authored. Joins,
grouping, `DISTINCT`, unions, or projections which can duplicate the key omit
identity unless that proof succeeds.

Development builds detect duplicate emitted keys and report the query id and
key. Correctness falls back to value comparison; it never reuses an object
against an ambiguous key.

Raw SQL accepts optional explicit `dependencies`, `coverage`, and `rowKey`.
Without them it retains conservative table inference, no completeness claim,
and index/value reconciliation.

### 5.4 Typed mutation descriptors

The schema emitter already generates `<Table>Insert` and `<Table>Update`
interfaces. It additionally emits a structural table descriptor carrying the
physical table name, primary-key field, and row/insert/update/id types:

```ts
export const todosTable: SyncTable<
  TodosRow,
  TodosInsert,
  TodosUpdate,
  string
> = {
  name: 'todos',
  primaryKey: 'id',
};
```

The normalized client includes the existing local read-merge-write `patch`
operation on every engine. Rust, the shared command router, Tauri, worker, and
direct clients implement the same method. Generated descriptors let
`useMutation` expose typed `upsert`, `patch`, and `remove` helpers without
changing the SSP full-row mutation format. `patch` reads the currently held
local row and writes the merged full-row upsert in the client's serialized
operation domain; an absent row fails loudly because there is no honest merge
base.

## 6. Client-scoped reactive store

### 6.1 One store per normalized client

`@syncular/client` owns the renderer-independent `ReactiveClientStore` and the
normalized `SyncClientLike` contract. `SyncProvider` obtains a store from a
`WeakMap` keyed by the original client. Multiple providers over the same client
share it. The store owns exactly one change-batch listener; `@syncular/react`
exposes its snapshots to React.

Live query entries are keyed by generated query id plus a canonical encoding
of the selected SQL variant and bound values. Each entry owns:

- observer count;
- latest accepted snapshot and highest matching change revision;
- one in-flight read and one dirty flag;
- dependency and coverage metadata;
- keyed row reconciliation state;
- refresh/error state.

Many components observing the same entry receive the same immutable snapshot.
One matching batch schedules one re-read. If another batch lands during the
read, the dirty flag causes exactly one follow-up read. Frame coalescing may
reduce work between paints, but revision comparison remains the correctness
gate when frames are suspended or unavailable.

React hooks use `useSyncExternalStore`, giving concurrent rendering one stable
snapshot and removing hook-local listener/scheduler/cancellation lifecycles.

### 6.2 Canonical keys

The runtime owns a typed, collision-free canonical encoder for cache inputs:

- `null`, string, finite number, `bigint`, boolean, and bytes have distinct
  tags and length-delimited encodings;
- `Uint8Array` is encoded without expanding it to a JSON number array;
- fixed-scope object keys are sorted;
- scope keys and window units are normalized, de-duplicated, and sorted where
  order has no semantics;
- unsupported values fail loudly at the public boundary.

This replaces JSON serialization that throws on `bigint`, comma joins that can
collide, and object-order-sensitive window keys.

### 6.3 Keyed row reconciliation

When `rowKey` exists, the entry reconciles through a key → previous-row map.
An insertion, deletion, or reorder therefore preserves every unchanged row
object instead of only rows that stayed at the same array index. Row equality
uses typed field comparison, including direct byte comparison, without
serializing every blob into JSON.

When no safe key exists, reconciliation stays conservative. Whole-result
equality still suppresses a publish, but object reuse never assumes a false
identity.

## 7. Composable window ownership

### 7.1 Window claims

Generated coverage causes a live query entry to register a **window claim** in
the client store. A claim is `(queryEntry, base, units)`. The effective units
for a base are the union of all active claims plus any explicit retained units
created through the lower-level window API.

The coordinator flushes claim changes once after the current React commit turn:

- A → B query replacement becomes one `{A} → {B}` `setWindow` call, not an
  intermediate empty window.
- StrictMode mount → cleanup → mount in the same turn creates no subscription
  churn.
- Releasing one observer does not evict a unit still held by another query.
- Units are normalized and diffed before reaching the core.

The coordinator awaits the serialized `setWindow` acknowledgement before the
entry's first `querySnapshot`. The acknowledgement means the entering unit is
registered as pending in the same local ordering domain; the subsequent atomic
snapshot cannot mistake pre-registration emptiness for complete data.

### 7.2 Default and advanced behavior

`useQuery` claims its generated coverage by default. Applications no longer
call `useWindow` for ordinary value-sharded reads. An advanced observe-only
mode may read coverage without claiming it, for diagnostics or deliberately
partial views, but it reports `partial`/`loading` honestly.

The lower-level API remains for prefetching and non-React hosts. Registration
is awaitable so a rejected host window change is never forced into an ignored
fire-and-forget path:

```ts
const retention = store.retainWindow(base, units);
await retention.ready;
// ...
retention.release();
```

It feeds the same coordinator/union semantics. Imperative `setWindow` remains
a core primitive, not the recommended multi-consumer application API.

React applications with a small known working set use the lifecycle-safe
adapter rather than writing their own retention effect:

```ts
const retention = useRetainedWindow(projectWindow, recentProjectIds);
```

The hook normalizes the unit set, composes it with generated claims, releases
only its owner on cleanup, and surfaces registration progress/failure.

## 8. Explicit sync intent and event-driven hosts

### 8.1 Core command effects

Commands which create network work return an effect alongside their result:

```ts
type SyncIntent =
  | { kind: 'none' }
  | { kind: 'interactive' }
  | { kind: 'background'; delayMs: number };

interface CommandEffects {
  readonly sync: SyncIntent;
}
```

At minimum:

- opening a persistent client with active subscriptions or pending outbox
  commits → `interactive` (one catch-up round before relying on realtime);
- local mutation with an outbox write → `interactive`;
- window widening with pending units → `interactive`;
- realtime `catchup-required`/delta gap → `interactive`;
- retryable transport failure → `background` with an explicit retry deadline;
- idempotent window changes and read-only commands → `none` unless existing
  pending work independently requires a scheduled deadline.

This intent is produced by the core operation that knows what changed. Hosts
do not infer it from `sync_needed` after an arbitrary delay.

### 8.2 One wake loop

The worker and native owner use the same state machine:

1. commands and inbound transport frames arrive on the owner mailbox;
2. an interactive intent schedules one coalesced sync task immediately;
3. background intent installs or advances one monotonic retry deadline from
   `delayMs`;
4. a new command/frame can preempt that deadline;
5. a round runs serially with local commands and publishes its change batches;
6. the loop blocks until mailbox work or the next real deadline.

The native transport reader signals the same owner mailbox. The fixed 200 ms
poll and post-wake `sleep(jitter)` disappear. Jitter is represented in a
background deadline and never delays a user-initiated list switch or local
write.

Manual-sync mode preserves command effects for observability but does not
consume them automatically.

Opening a persistent database is itself a core operation. Active persisted
subscriptions always require one catch-up pull: a realtime connection can only
announce changes after it opens, and re-declaring the same window is correctly
idempotent. Both cores therefore expose `syncNeeded` plus one coalescible
interactive startup intent when an open restores any active subscription or
outbox work. The host consumes that output exactly like a command effect. An
application never calls `sync()` merely to make restart correct.

## 9. Identity, initialization, and mutation ergonomics

### 9.1 Core-owned client identity

`clientId` becomes optional on every persistent client constructor. On first
database creation the core generates a cryptographically random id and stores
it transactionally in Syncular metadata. Every later open returns that id.

An explicitly supplied id initializes an empty database. Supplying a different
id for a database which already owns one fails with a dedicated error and a
documented reset/migration action; it never silently rebinds the server identity.
Schema reset preserves the id, as required by the existing client identity
model.

The Tauri PoC therefore needs no `localStorage` helper, and web/native identity
semantics match.

### 9.2 Async client resource

`@syncular/react` gains a small `createSyncClientResource(factory)` abstraction
whose lifecycle is stable across React 18 StrictMode remounts. It owns one
in-flight initialization, exposes pending/ready/error, and closes the client
exactly once when the resource is disposed. `SyncProvider` accepts either a
ready client or this resource, with a render/fallback surface for initialization
and errors.

This replaces application module-level promise guards without making routing
or engine selection part of Syncular.

### 9.3 Mutation state

`useMutation` tracks a pending count rather than a boolean toggled by whichever
overlapping call settles first. It exposes `resetError` and optional lifecycle
callbacks while continuing to reject the returned promise:

```ts
const mutation = useMutation({
  onError(error) {},
  onSuccess(clientCommitId) {},
});

mutation.resetError();
```

The hook's error is the one renderable source of truth; applications do not
need a mirrored `writeError` solely to clear or display a rejection.
The typed table helpers from §5.4 remove full-row spreads for ordinary partial
edits while preserving the core/wire full-row invariant.

## 10. Conformance and performance gates

### 10.1 Cross-core conformance

The repository adds client-observation vectors consumed by both TypeScript and
Rust. Each vector pins command(s), resulting query/window/status snapshots,
revision, and emitted change batch. Required scenarios include:

1. optimistic upsert and delete with exact table/scope changes;
2. remote commit apply;
3. segment and SQLite-image apply at the honest available granularity;
4. window widen registration, pending state, and interactive sync intent;
5. zero-row bootstrap completion without a row change;
6. window replacement and shrink eviction;
7. outbox-pinned deferred eviction and later drain;
8. conflict/rejection and status-only changes;
9. schema reset/re-bootstrap;
10. transaction rollback emits no revision/batch;
11. revision continuity after restart;
12. persisted active subscriptions/outbox produce one startup catch-up intent;
13. explicit/persisted client-id behavior.

Tauri integration tests use the real Rust plugin event output through the
TypeScript bridge and React store. An adapter over the TypeScript client is not
accepted as native parity coverage.

### 10.2 React race tests

Deterministic deferred promises prove:

- A → B → C results resolving in every order publish only C;
- invalidation during a query forces one newer read;
- a completeness transition cannot publish against older rows;
- zero-row completion becomes `ready` without a false-empty intermediate;
- StrictMode does not lose subscriptions or churn windows;
- two equal hooks issue one read;
- two window consumers union claims correctly;
- prepend/delete/reorder preserve unchanged keyed row objects;
- hidden documents converge without waiting for visibility.

No acceptance test uses an arbitrary sleep or counts frame order as proof of
correctness.

### 10.3 Performance lanes and budgets

CI gains user-perceived lanes on both worker and Tauri IPC hosts:

| Lane | Measure |
| --- | --- |
| Invalidation → view | change commit to published fresh React snapshot |
| Window switch | claim change to `ready`, cold and already-cached |
| Query fan-out | SQL/IPC reads for N identical observers |
| Churn burst | reads and renders for N live queries across a batched burst |
| Status/conflicts | calls and transferred bytes per domain change |
| Row stability | retained object identities after prepend/delete/reorder |
| Native wake | command/window change to sync-round start; idle wake count |

For the repository's narrow-row reference query on a warm client, the initial
budgets are normative:

| Budget | Gate |
| --- | --- |
| Core SQLite `querySnapshot` | p95 ≤ 2 ms |
| Worker/Tauri snapshot round trip | p95 ≤ 5 ms |
| Warm retained-window switch → external-store publish | p95 ≤ 8 ms |
| Warm switch → browser paint | no more than one display frame |
| Identical observers | exactly one core read per revision |
| Status-only change | zero SQL query reruns and zero status follow-up RPCs |
| Idle native owner | zero periodic wakeups |

Absolute budgets run on the pinned CI performance runner; other environments
report them without failing when the runner is not comparable. Row-count lanes
at 100, 1,000, and 10,000 rows additionally enforce non-regressing scaling.
The tests assert message/IPC counts because a locally fast benchmark can hide
an architecture which scales linearly with mounted hooks.

A cold window bootstrap is a network/snapshot operation and has its own lane;
it is never reported as local-query latency. Which units remain retained is an
application working-set policy. Syncular supplies composable generated claims
and `retainWindow`, but it does not silently keep every departed unit or weaken
the §4.8 eviction invariant. An app requiring instant navigation between a
small known set retains or prefetches that set explicitly.

Incremental view maintenance is explicitly deferred. Local SQLite query reruns
remain the baseline until these measurements show SQL execution, rather than
duplicate reads, IPC, serialization, or rendering, is the dominant cost.

## 11. Delivery plan

This is one cohesive milestone. Intermediate branches may stage the work, but
no release claims the new model until both cores, all hosts, typegen, React, and
conformance satisfy it.

| Stage | Work | Gate |
| --- | --- | --- |
| V0 | Freeze `LocalRevision`, `ClientChangeBatch`, `QuerySnapshot`, `SyncIntent`, and golden vector format | RFC decision + fixture review |
| V1 | Add transactional revision/change accumulators and atomic query snapshots to TypeScript and Rust | cross-core observation vectors green |
| V2 | Replace Tauri/FFI derived events and Tauri polling; update worker/native command effects and exact bridges | real plugin/bridge integrations green; zero idle polling |
| V3 | Extend typegen with origins, dependencies, coverage, row keys, and typed table descriptors | deterministic golden generation + ambiguity tests |
| V4 | Build the client-scoped reactive store, canonical keys, claims, status/conflict stores, and `useSyncExternalStore` hooks | race/StrictMode/dedupe tests green |
| V5 | Add persisted native identity, async resource, and mutation lifecycle API | web/Tauri example code contains no identity/promise/error mirrors |
| V6 | Port demos and Diego PoC; delete render-order and manual-window composition paths | identical web/Tauri behavior + performance budgets green |
| V7 | Update SPEC/design/docs and release as one versioned API change | full `bun run check`, Rust clippy/tests, cross-host E2E |

Existing public APIs may be implemented on the new core where their semantics
remain honest, but the release does not ship a compatibility shim that treats
missing native change data as global or preserves the old timing dependency.

## 12. Explicitly rejected approaches

- **Bare native invalidation means every table.** This hides missing core data,
  destroys scope precision, and lets native parity regress silently.
- **Another frame, timeout, settle deadline, or row-at-switch heuristic.** Time
  and FIFO issuance are not a snapshot consistency protocol.
- **Polling `windowState`, status, or `sync_needed`.** Observer changes and sync
  intent are explicit core outputs.
- **A per-hook request token only.** Generation guards are necessary, but a
  hook-local patch leaves duplicate reads, separate window truth, and other
  observers with the same race. Revision ordering belongs in the shared store.
- **Naive automatic `setWindow` per component.** Components overwrite each
  other; claims must union before the core sees an effective window.
- **Parameter-name guessing in typegen.** Coverage is derived from checked
  column/predicate/subscription facts or an explicit checked declaration.
- **Index-only row identity for generated queries.** Inserts and reorders turn
  a one-row change into whole-list render churn despite available primary-key
  knowledge.
- **Web-only `patch`.** A convenience used by application code is part of the
  normalized capability contract and must exist on native engines too.
- **Incremental SQL/view maintenance now.** It adds a second query engine before
  removing known cross-boundary overhead and measuring the remaining bottleneck.

## 13. Non-goals

- No SSP wire-format change is required. Local revision is a client-observation
  concept and never replaces server cursors or commit sequence.
- This RFC does not change window eviction, outbox pinning, bootstrap, conflict,
  or authorization semantics in `SPEC.md`; it makes their local observation
  atomic and uniform.
- It does not introduce a router, application cache policy, optimistic mutation
  DSL, global application state manager, or wire-level partial-update operation.
- It does not promise exact scope invalidation where a segment or query shape
  lacks that information. Table-wide fallback remains the honest floor.
- It does not infer network connectivity. `online` remains transport/host state,
  not a guessed sync-core status.

## 14. Decisions required for acceptance

1. **Atomic query snapshot is the public reactive read primitive.** Rows and
   coverage are not composed across separate calls.
2. **Local revision is persisted `u64`, normalized to `bigint`.** JSON bindings
   use decimal strings.
3. **Change batches originate inside both cores.** Tauri deletes observed-state
   data inference.
4. **Generated coverage claims windows by default.** Advanced consumers can
   observe without claiming or retain explicit units through the coordinator.
5. **Reactive state is client-scoped and renderer-independent.** React adapts
   it with `useSyncExternalStore`.
6. **Interactive sync intent is immediate and event-driven.** Jitter applies
   only to background retry/coalescing deadlines.
7. **The milestone releases as a coherent end state.** No bare-invalidation,
   extra-frame, timer, or polling patch is accepted as the architecture.

## 15. Implementation result

The completed implementation follows the architecture above without a
compatibility fallback:

- TypeScript and Rust persist the local revision, produce exact transactional
  change batches, and serve rows/coverage/revision through one snapshot read.
- Worker, Tauri, FFI, React Native, Swift, Kotlin, and Flutter bridges forward
  core facts and sync intents instead of deriving invalidation from counters.
- The worker and native Tauri owner are mailbox/deadline driven, with zero idle
  polling. Persistent active subscriptions/outbox work also produces a startup
  catch-up intent, cross-core conformance-locked after a real Tauri restart
  exposed that missing case.
- QueryIR/typegen supplies dependencies, constructive coverage, row identity,
  and typed table descriptors; the renderer-independent client store owns
  dedupe, revision races, reconciliation, status domains, and window claims.
- React is a `useSyncExternalStore` adapter with resource initialization,
  typed mutation lifecycle, generated coverage claims, and explicit retained
  working sets. The old query-churn/frame-order implementation is deleted.
- The Diego PoC contains no manual `setWindow` effect, settle timer,
  rows-at-switch ref, full-row edit spread, mirrored mutation error, identity
  localStorage helper, or promise-initialization mirror. Its known three-list
  working set uses the composable retention API.

Observed on the PoC reference flow: warm retained first-list publication was
6.2 ms, an optimistic local mutation reached the DOM in 11.5 ms, and a cold
network/bootstrap switch reached rows in 31.8 ms. The strict repository gates
enforce p95 ≤2 ms core snapshots, ≤5 ms worker/Tauri snapshot round trips, and
≤8 ms retained-window publication on the pinned performance lane.

The implementation passed the full Bun gate, Rust fmt/clippy/tests, the real
native-core → Tauri bridge → reactive-store harness, TS/Rust observation
conformance, React Native and Swift gates, docs build, generated Kotlin/Flutter
freshness checks, and a launched macOS Tauri PoC using its persisted file DB
and native realtime socket. Kotlin execution remains environment-skipped
without JDK 21; Flutter execution remains environment-skipped without Dart,
as documented by their check scripts.

### 15.1 Native hardening after live 0.5.0 observation

The first published 0.5.0 Tauri run exposed two assumptions that the original
native harness did not exercise:

1. The Tauri transport had drifted from the FFI transport's socket-fairness
   fix, and its realtime URL did not carry the persisted database client id.
   A quiet reader could starve socket sends, and the server registered a random
   socket identity while sync requests carried the real identity. This broke
   native realtime invalidation and could strand interactive sync work.
2. `querySnapshot` was atomic but still shared the mutable core owner's
   mailbox. An immediate local mutation correctly scheduled network sync, then
   the React reread queued behind that HTTP/WebSocket round. SQLite itself was
   fast; the UI latency was cross-domain head-of-line blocking.

Syncular 0.5.1 applies the long-term host architecture:

- `syncular-client` owns the single feature-gated native transport used by
  both FFI and Tauri. Realtime URL construction replaces or appends exactly one
  `clientId` query parameter from the persisted core identity, retains other
  query parameters, and uses the proven short read quantum plus an explicit
  yield outside the socket mutex.
- A file-backed native client exposes `FileQuerySnapshotReader`, a long-lived
  read-only SQLite connection. Tauri routes atomic reactive snapshots through
  a dedicated command, mailbox, and reader thread. The mutable owner remains
  the sole writer and sync owner; in-memory clients intentionally fall back to
  it because anonymous SQLite databases cannot be shared across connections.
- The snapshot sidecar reads rows, local revision, and persisted window
  coverage inside one SQLite savepoint. It therefore preserves the RFC's
  atomic-publication contract while allowing local UI reads during network
  work.
- Regression coverage now includes scripted socket identity/fairness rounds,
  sidecar/owner snapshot parity, and a deterministic Tauri test that blocks
  the owner for 200 ms but requires the local snapshot to return within 50 ms.

This does not reintroduce polling, timers, render-order inference, or a second
mutable client. It separates read and write scheduling at SQLite's native
concurrency boundary, which is the architecture required for local-first
latency under an active network connection.
