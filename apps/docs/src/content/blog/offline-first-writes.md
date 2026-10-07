---
title: 'Durable Offline Writes, Part 1: Seven Sync Engines'
description: How PowerSync, Zero, Electric with TanStack DB, Replicache, Turso, LiveStore, and Jazz handle a write made without a network, and the patterns that hold across all of them.
summary: One offline write followed through seven sync engines, and the seven patterns that hold across them.
author: Benjamin Kniffler
publishedAt: '2026-07-17'
---

# Durable Offline Writes, Part 1: Seven Sync Engines

Offline reads come down to a known recipe: put the data in SQLite, query it
locally, render it. Offline writes are where sync engines differ.

Two devices edit the same row while one is on a plane. The server applies a
push and the acknowledgement disappears. A user loses access to a project while
their laptop holds three days of pending work for it. The schema changes before
that laptop reconnects. A sync engine's write path is the sum of its answers to
these situations.

I have worked on this problem for years. In 2019 I built
[debe](https://github.com/bkniffler/debe), a reactive offline-first datastore
with CRDT-based sync, multi-master replication, and adapters for SQLite,
Postgres, and in-memory stores. It never reached production. Building it
taught me that convergence is one requirement among several: authorization,
durable recovery, bootstrap, retention, and debugging carry the same weight.

Seven years later I spent months evaluating the current sync tools, building
prototypes, and finding where application-specific glue begins. The glue
turned out to be the system I wanted to build. It became
[Syncular](https://syncular.dev), and
[Part 2](/blog/syncular-write-path/) describes how it handles the same write.
This part covers the landscape: what each engine replicates, what it makes
authoritative, and how it reconciles speculative state. The patterns at the
end apply to any application that accepts writes without a reliable network.

## What an offline write requires

Most sync products lead with the read path: get server data onto a device and
keep the UI reactive. The techniques are known: stream rows, maintain a local
projection, invalidate queries, render from the local copy.

A durable offline write adds eight requirements:

- **Durability across restarts.** The user typed something, killed the app,
  updated it two days later, and came back. The write must still be there.
- **Atomic optimism.** The UI shows a local write. No crash may leave the row
  on screen without its entry in the upload queue.
- **Ordering and idempotency.** A request timed out. The client must learn
  whether the server rejected it, applied it once, or applied it and lost the
  reply.
- **Conflict evidence.** Two users edited the same record offline. The
  application needs the losing intent and the server's winning row.
- **Authorization changes.** A user was removed from a project while offline.
  Something must decide which local data is purged and what happens to the
  pending writes.
- **Schema evolution.** An old outbox holds a column that no longer exists.
  The client must keep enough evidence to recover instead of guessing or
  crashing.
- **Bootstrap and retention.** A new or long-absent client needs a trustworthy
  current snapshot instead of years of replay.
- **Debugging.** When device B is missing a row, durable state must explain
  why, without reconstructing a transient invalidation chain.

These are normal operating conditions for apps used on trains, construction
sites, factory floors, and mobile networks.

Zero's documentation states the difficulty directly.
[Zero does not support offline writes and is not designed for long periods offline](https://zero.rocicorp.dev/docs/connection):
a disconnected client keeps reading synced data, and writes are rejected. Its
explanation names concurrent edits that no algorithm can resolve automatically,
constraints, business logic, and authorization rules that pass offline and fail
on reconnect, and schema changes that leave queued data unprocessable.

An offline-first system therefore has three jobs: preserve the user's work,
make authority explicit, and give the application enough durable evidence to
decide what happens next.

## The browser-storage floor

On the web, every offline architecture sits on the browser's persistence
layer.

[IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) is
an object store. A product that offers relational behavior on top of it must
emulate database semantics, store another database's pages as objects, or adopt
a different data model such as triples or key-value records.

[OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
allows a different design: run SQLite compiled to WebAssembly and keep its
files in the browser's origin-private file system. That gives the browser real
SQL, transactions, and indexes on a storage engine developers already know.

Multiple tabs still need a coordination model. A single elected owner is the
simplest. SQLite 3.53 added an
[`opfs-wl` VFS](https://sqlite.org/wasm/doc/tip/persistence.md) that locks with
Web Locks instead of a bespoke protocol and queues lock requests in FIFO order;
it needs `Atomics.waitAsync()`, and its guidance has clients handle
`SQLITE_BUSY`. PowerSync's 2026
[`OPFSWriteAheadVFS`](https://powersync.com/blog/powersync-changelog-may-2026)
(Web SDK 1.38.0) lets reads run in parallel with writes and speeds up writes,
and depends on an OPFS mode only Chromium ships. OPFS supplies the storage primitive; the application still
chooses the concurrency policy, and the fastest options differ by browser.

[Notion's move to WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)
shows where the work lands. Running the database took little effort;
coordinating it across tabs took a SharedWorker, an active-tab model, and Web
Locks.

A durable outbox is only as durable as the database transaction and the
ownership model underneath it.

## One write, seven engines

A feature matrix hides the differences that matter. They are algorithmic: what
is replicated, what is authoritative, and how speculative state is reconciled
when the server answers.

Take one sequence. I create a task on a laptop while offline. Another device
edits the same project. My access is revoked before I reconnect. When I push,
the server accepts or rejects the operation, and the response is lost.
Meanwhile the application has shipped a new schema and the server has pruned
the incremental history.

No engine makes those facts disappear. Each picks a unit of state and builds
its algorithm around it:

| Engine | Replicated unit |
| --- | --- |
| PowerSync | Bucketed row operations, delivered at consistent checkpoints |
| Zero | Results of live queries, kept current by incremental view maintenance |
| Electric with TanStack DB | Table-shaped change logs into locally maintained queries |
| Replicache | Mutation invocations, rebased over canonical patches |
| Turso Sync | Whole database histories |
| LiveStore | Domain events, materialized into SQLite |
| Jazz v2 | Row-version histories in an integrated database |

The unit decides what the engine makes simple, what the application still
owns, and what evidence exists after a failure. The chapters below take the
engines one at a time.

## PowerSync: bucket logs and checkpoints

[PowerSync](https://www.powersync.com/) manages SQLite on the client and
separates the two directions of data flow.

Downstream starts at the source database. PowerSync takes an initial snapshot,
then follows the change stream: Postgres logical replication, MongoDB change
streams, the MySQL binlog, SQL Server CDC, or Convex document deltas.
[The service preprocesses those changes into buckets](https://docs.powersync.com/architecture/powersync-service):
append-only histories of `PUT` and `REMOVE` operations. A bucket can represent
one user, one organization, or another parameterized slice shared by many
clients. Bucket storage is durable and compactable, and connected clients
stream from it instead of querying the source database.

[Sync Streams reached general availability in May 2026](https://releases.powersync.com/announcements/sync-streams-are-now-generally-available).
SQL-like stream definitions select a client's data from authentication,
connection, and subscription parameters. Streams hide buckets from the
developer; underneath, the bucket remains the unit of operation history and
deduplication.

A client asks for operations after the IDs it holds, receives a checkpoint and
the missing operations, and verifies per-bucket checksums before exposing the
new state. The
[same checkpoint protocol](https://docs.powersync.com/architecture/powersync-protocol)
handles first bootstrap, catch-up after a long absence, and live delivery. A
checkpoint spans buckets and tables, so a client never exposes half of a large
server transaction.

Upstream takes a longer path:

```text
local SQL transaction
  -> SQLite row changes + ps_crud FIFO queue
  -> application-defined uploadData()
  -> application API
  -> source database
  -> CDC
  -> bucket operation log
  -> next client checkpoint
```

Local mutations apply at once and enter `ps_crud`, a blocking FIFO upload
queue. The SDK retries them through an
[`uploadData()` function the application supplies](https://docs.powersync.com/architecture/client-architecture).
The indirection is deliberate: the backend keeps arbitrary validation,
authorization, side effects, and conflict rules, and the sync service never
impersonates the application server.

PowerSync's
[causal+ consistency model](https://docs.powersync.com/architecture/consistency)
holds the two directions together. Local mutations sit as an overlay on the
last confirmed checkpoint. While the upload queue holds entries, the client
does not advance to a later checkpoint. Once the write has reached the source
database and returned through CDC, the client replaces the overlay with a new
consistent checkpoint, so it never merges a half-confirmed local row with an
unrelated point in server history.

The result is a relational replica, a checkpointed download protocol, and
write semantics the application controls. The boundary sits at rejection: the
read protocol cannot define what a rejected write means. The application API
owns idempotency, conflict policy, authorization drift, and any durable repair
record. Partial replication must be expressible as stream parameters and
supported SQL. Flat ownership rules map directly to parameters; an
organization → project → task hierarchy needs routing columns or application
code that resolves membership into parameters.

PowerSync is where two pressures first became concrete for me: every
partial-replication system pays a routing cost, and an authoritative write
protocol needs more than a read stream plus a durable upload queue.

## Zero: the query result is the replica

[Zero](https://zero.rocicorp.dev/) starts from a different question: what if
the client wrote an ordinary relational query and the system kept that exact
result live?

A named ZQL query exists on the client and the server. It runs against the
local store first, so cached rows render at once. In parallel the client sends
the query name and arguments to `zero-cache`, which asks the application's
query endpoint for the server-side ZQL expression (which may add permission
filters) and runs it against a read-only SQLite replica of Postgres. Logical
replication advances that replica. A view-syncer hydrates the query once, then
uses incremental view maintenance to push only the affected row changes.

Re-running every active query after every database change would scale with
`changes × queries`. Zero maintains query pipelines instead; its self-hosting
guide summarizes the algorithm as
[“hydrate once, then incrementally push diffs”](https://zero.rocicorp.dev/docs/self-host).
Client View Records remember what each client already holds, so a reconnect
transfers a diff.

The local database is the union of active and cached query results, with TTLs
controlling how long inactive results stay warm. The replica takes the shape of
the UI: mount a query and its rows appear; unmount it and the server can stop
maintaining it. Completeness becomes a property of each query, and Zero reports
`complete` or `unknown` because an immediate local answer may hold only the
rows that happened to be present.

Writes use the same optimistic and authoritative split as Replicache.
A [mutator](https://zero.rocicorp.dev/docs/mutators) runs against the client
store and updates open queries. A mutation record goes to the application's push
endpoint, where the server-side mutator runs in a database transaction and
records that it ran. Logical replication carries the resulting rows back
through `zero-cache`. When the client receives the authoritative rows and the
mutation confirmation, it removes the confirmed speculative effect and
reconciles its remaining pending mutations.

Each business operation therefore runs twice: speculatively on the client and
authoritatively on the server. The two can share TypeScript and can still
produce different results, because the server sees newer rows, checks access,
and reaches systems the client cannot. Mutator compatibility becomes part of
the application's correctness surface.

[Zero reached general availability in March 2026](https://zero.rocicorp.dev/docs/status), and its
offline boundary is deliberate: once the connection state becomes
disconnected, [writes are rejected](https://zero.rocicorp.dev/docs/connection)
while reads of synced data continue. By refusing week-old writes, Zero leaves
the repair of stale business operations, permissions, and schemas to the
application, where a generic query engine could not decide it.

For connected collaborative software these choices fit together:
query-shaped replication, server-side permission transforms, incremental
computation, and immediate mutations. For field software that must accept work
through a multi-day outage, the rejected-write boundary decides the question.
Zero taught me that query-driven sync is an incremental computation
architecture, and that long-term offline writes need their own protocol.

## Electric and TanStack DB: a read path and a write path

[Electric Sync](https://electric.ax/docs/sync/) describes itself as a
read-path sync engine for Postgres. Its primitive is a Shape: one table, an
optional `WHERE` clause and projection, and an ordered log of changes.

A consumer requests a Shape from offset `-1` for the initial snapshot, then
continues from the returned offset and handle. Once caught up, it long-polls or
uses SSE. The stream mixes row operations with control messages such as
`up-to-date` and `must-refetch`. Because the protocol is plain HTTP, Shape logs
sit behind proxies and CDNs, and the [HTTP API](https://electric.ax/openapi) is
small enough for different local stores to consume.

TanStack DB supplies the client-side relational layer. Synced rows enter
normalized collections, and live queries use
[`d2ts`, a TypeScript differential-dataflow engine](https://tanstack.com/db/latest/docs/overview),
to propagate changes through filters, joins, sorts, and aggregates. When one
row changes in a large joined query, only the affected part of the dataflow
updates.

Writes travel through the application API:

```text
TanStack optimistic transaction
  -> application mutation endpoint
  -> Postgres transaction (returns txid)
  -> Electric Shape log
  -> await that exact txid
  -> retire optimistic overlay
```

Waiting for the exact Postgres transaction ID tells TanStack DB when the
authoritative write has passed through Electric, even if other users changed
the same rows in between. The
[Electric and TanStack reference architecture](https://electric.ax/blog/2025/07/29/super-fast-apps-on-sync-with-tanstack-db)
then rebases the optimistic overlay over concurrent changes and removes it at
the right point in the stream.

TanStack DB 0.6 added
[optional SQLite-backed persistence](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes),
and
[`@tanstack/offline-transactions`](https://github.com/TanStack/db/tree/main/packages/offline-transactions)
records each mutation in a durable outbox before sending it, processes the
outbox first in, first out, retries with exponential backoff and jitter,
supports idempotency keys, and elects one browser-tab leader. Non-leader tabs
run online-only.

Electric turns Postgres changes into cacheable logs, TanStack DB computes
locally, and the application server keeps its own write API. A team can adopt
each piece on its own.

Correctness then crosses the seams. The outbox supplies an idempotency key, and
the endpoint must persist and enforce it. The outbox retries, and only the
application can decide whether an old command is still authorized. It rolls back
an optimistic transaction, and the domain-specific repair UI and the
translation of a queued payload across an incompatible schema stay with the
application. Electric's
[Durable Streams](https://electric.ax/blog/2026/01/22/announcing-hosted-durable-streams)
add a separate append-only log with idempotent producers and exactly-once
semantics; it coordinates, and the relational business authority stays
elsewhere.

Durable queueing is a client-library feature. Durable application of a
business operation is a property of the end-to-end protocol. Before working
through this stack I had treated the two as one.

## Replicache: mutation logs and rebase

[Replicache](https://doc.replicache.dev/concepts/how-it-works) came closest to
the state machine I had in mind. It is in
[maintenance mode](https://replicache.dev/) since Rocicorp moved development to
Zero, and its algorithm remains one of the clearest descriptions of optimistic,
server-authoritative sync.

The client stores an ordered key-value map. An application mutator reads and
writes that map in a transaction. Running it changes the Client View and
persists a mutation record:

```text
{ clientID, mutationID, name, args }
```

`mutationID` is a sequential per-client integer. During push the server runs
mutations in that order against its canonical database and advances the
client's `lastMutationID` in the same transaction. That is the idempotency
rule: if the server reports mutation 42 as processed, the effects of 42 and of
every earlier mutation from that client are visible in the same canonical
state. A timed-out push can be retried, and the high-water mark keeps the
server from applying it twice.

Pull runs the other way. The client sends an opaque cookie naming its last
canonical server state. The server returns a new cookie, a patch over the
client's key space, and the `lastMutationID` values it has accepted. Replicache
discards the confirmed mutations, rewinds to the last confirmed Client View,
applies the patch, and re-runs every pending mutator over the new base. Only
after the rebase completes does it reveal the result to the application.

```text
old confirmed base + pending A + pending B
                 pull arrives
old confirmed base + server patch + replay(A) + replay(B)
```

A replay may produce a different answer. A `reserveRoom` mutator might succeed
offline and then, during rebase, find the room reserved by someone else.
Conflict resolution is program logic inside the mutator, so each domain writes
the rule it needs. A content-free "poke" over WebSocket or SSE tells the client
when to pull; recoverable data still moves through request and response.

The server is authoritative, lost acknowledgements are safe, speculative work
survives incoming server changes, and conflict behavior is domain-specific. The
costs follow from the same choices. The client view is key-value, so rich
queries need indexes and conventions. The server implements the matching
mutators and pull protocol. A client mutator must be deterministic enough to
replay and close enough to the server's meaning to represent it.

Replicache gave me three foundations: per-client mutation identity,
rewind-and-replay reconciliation, and the doorbell transport. It also
convinced me that a relational system should generate as much of the
cross-runtime contract as it can, so a product does not maintain two copies of
every mutation by hand.

## Turso Sync: the database is the unit

[Turso Sync](https://docs.turso.tech/sync/usage) takes the most literal
local-first premise. The application opens a local SQLite-compatible database,
reads and writes it normally, and pushes to or pulls from a remote Turso
database on request.

Turso's wire format is logical change-data-capture, sent as logical statements.
If remote changes exist while local work is pending, a pull rolls the local
database back to its last synced state, applies the remote changes, and
[replays the unpushed local changes atomically](https://docs.turso.tech/sync/conflict-resolution).
The conflict rule is last-push-wins: the order in which pushes reach the
remote decides the winner.

SQLite supplies most of the machinery, which keeps the algorithm short. The
local database is the application's read model and its durable write store, so
no object cache needs to stay coherent and no query language needs translating
into a client view.

The security and provisioning boundary is the database, which fits
database-per-user, database-per-device, and database-per-tenant products.
Turso's experimental [partial sync](https://docs.turso.tech/sync/partial) cuts
bootstrap cost by downloading a prefix, or only the pages a server-side query
touches, and fetching missing pages on demand. That is physical demand paging
over one database, so access is still granted per database.

The cost appears when collaboration does not line up with database files. If
one user belongs to 200 projects shared with different groups, the
application provisions many databases, widens one database's contents, or
builds routing above the sync layer. Whole-database sync removes row-routing
machinery by choosing a coarser unit, and the routing decision moves to the
application.

## LiveStore: events as the source of truth

[LiveStore](https://livestore.dev/) replicates domain events. An event has a
name, typed arguments, a sequence number, and a parent sequence number. Clients
sync events through a central backend and run deterministic materializers that
produce reactive local SQLite tables. SQLite is the queryable projection; the
event log is the source of truth.

The sync algorithm follows Git. The backend assigns a global total order. A
client keeps pending events on its own head; before it pushes, it pulls
upstream events, rebases its pending events over the new head, then pushes. On
the web a leader coordinates the local store across browser sessions. Three
heads (session, local leader, backend) show where pending work sits.

Event sourcing keeps the original business intent, which row replication loses.
`TaskAssigned` says more than "the `assignee_id` column changed," and it
supports audit, debugging, undo, and rebuilding derived state. LiveStore is
based on the [Riffle research project](https://riffle.systems/), which builds
data-centric apps on a reactive relational database.

The history is also where the costs collect. Event schemas and materializers
become compatibility contracts. New clients need a bounded way to reach
current state, and old history needs compaction. Partitioning and
authorization must decide which histories a client may receive without
leaking the events behind forbidden rows.

LiveStore's documentation states its current limits:
[merge-conflict handling and compaction are not implemented, and LiveStore assumes one event log per SQLite database](https://docs.livestore.dev/building-with-livestore/syncing/).
It also ships no built-in authorization.
Those items mark where a general event-sourced engine becomes a multi-tenant
sync product, and they settled one requirement for me: keep durable causal
evidence, and let a current snapshot bound the cost of joining or returning
after a long absence.

## Jazz v2: a database that owns sync

[Jazz v2](https://jazz.tools/blog/what-is-jazz), in public alpha since April
2026 and still alpha in its current docs, makes the database itself responsible for local persistence, partial
replication, permissions, reconciliation, and schema evolution.

Jazz stores tables locally, and every write creates a row version that points
to its parent version or versions. Concurrent edits branch in a row-local
history graph. The visible row is computed from that history: writes to the
same field converge by last-writer-wins, concurrent writes to different fields
both survive, and losing versions stay available as reconciliation evidence.

The team's retrospective on classic Jazz argues for a
[Git-like model of snapshot DAGs](https://jazz.tools/blog/what-we-learned-from-classic-jazz),
which keeps the same history fidelity and makes reads of current state and of
history cheaper. Jazz v2 treats the server as trusted for access control, and
sensitive fields can still be hidden from it with encrypted columns.

Queries define the partial replica. The server keeps each subscription in a
live query graph, re-settles only the affected parts when rows or policies
change, and sends deltas. Offline writes apply to the local replica at once
and queue row-version updates; in the browser, a SharedWorker owns the replica
in IndexedDB, and Jazz uses no tab leader election. Core, the server that
authorizes and durably accepts writes, settles concurrent versions and sends the
authorized result to subscribed clients. Callers can wait for the `local` or
`global` durability tier, and a rejected write is removed from the local
replica.

Each schema version has a hash, and bidirectional
[schema lenses](https://jazz.tools/docs/schemas/migrations) translate rows
across versions, so clients on different versions keep exchanging data and
nothing on disk is rewritten when a new schema ships.

One model then covers query completeness, row history, rejected persisted
writes, permission policies, migration compatibility, and durability
acknowledgements. In exchange, Jazz becomes the product's database, query
layer, permission system, migration model, and cloud protocol, and it is in
alpha.

Jazz v2 reached many of the same conclusions that shaped Syncular:
authorization at sync time on a trusted server, relational partial replicas,
retained conflict evidence, a single browser runtime that owns local storage,
and schema-aware recovery. The architectural centers differ. Jazz defines a new
integrated database. Syncular is a protocol library that the application's own
backend hosts over a SQLite, Postgres, or D1 database, with authentication and
scope resolution in application code.

## Patterns that hold across engines

The implementations differ, and the same invariants keep returning across
these engines, debe, and Syncular. These are what I now check before I look at
an SDK.

### Optimistic state needs a confirmed base

An "optimistic update" sounds like a UI technique: change the screen now, undo
it if the request fails. Durable offline work needs a stronger model. At any
moment the client holds two things:

```text
visible state = last confirmed base + ordered pending intent
```

PowerSync keeps local mutations over the last checkpoint and pauses checkpoint
advancement. Replicache rewinds to its last canonical Client View, patches it,
and replays pending mutators. Turso rolls back to the last synced state,
applies remote state, and replays local changes. Zero retires confirmed
speculative effects as authoritative rows arrive. The representations differ,
and the invariant is shared: what the user sees and what the authority
accepted are two separate facts.

Order matters for the same reason. If pending write B came after pending write
A, rejecting A can change what B means. Removing A from a queue leaves the
screen wrong; the client must rebuild a coherent state from the confirmed base
and the intent that survives.

debe concentrated on making replicas converge. I had underestimated the value
of keeping both layers, the confirmed base and the ordered speculative branch,
long enough to explain a rejection and rebuild the right local answer.

### Exactly-once application starts with durable identity

TCP cannot tell an application whether a timed-out request committed. Retries
are unavoidable, so a write protocol needs an identity that survives process
restarts and network attempts.

Replicache stores a client ID with a sequential mutation ID, and records the
last applied ID together with the mutation's effects. TanStack's offline queue
provides idempotency keys and leaves enforcement to the endpoint. PowerSync
sends queued CRUD through an application API that defines its own idempotency
contract. All three apply one principle:

```text
at-least-once delivery + durable operation identity
  -> exactly-once application
```

The result needs to be durable too. If a server remembers only successful IDs,
a retried rejected operation is evaluated again, possibly against a different
authorization or schema, and can produce a different answer. If a client
deletes a failed operation without recording the outcome, the UI cannot
explain after a restart why the optimistic row vanished. Exactly-once is a
state-machine guarantee over operation identity, authoritative effects, and the
recorded outcome.

### The transport serves one state machine

Replicache implements this as a contentless "poke", and Pesterhazy's survey
names the same
["shoulder tap" pattern](https://gist.github.com/pesterhazy/3e039677f2e314cb77ffe3497ebca07b):
a lightweight message announces a change, and an HTTP request fetches the
data. HTTP is
retryable, observable, and replayable, and the socket carries no bulk transfer
or recovery semantics.

The invariant underneath is that push, pull, registration, ordering, and retry
belong to one synchronization state machine, whichever transport carries a
given round.

### Append-only logs leave evidence

Reactive invalidation and ordered logs both keep clients current, and they
fail differently.

With an ordered commit log, a client asks for everything after cursor N, and
every accepted commit has a sequence. When a row goes missing, the commits,
scopes, cursors, and recorded client outcomes are there to inspect. With
dependency-driven invalidation, debugging means reconstructing which change
invalidated which query, which recomputation ran, and which result was
delivered. Tooling helps, and the causal chain stays implicit by default.

Linear's
[January 2024 incident report](https://linear.app/now/linear-incident-on-jan-24th-2024)
shows the difference: their action log enabled recovery and made unresolved
conflicts visible. A log prevents nothing on its own; it gives you durable
evidence to explain and repair a failure.

### A log needs a snapshot and a retention horizon

An append-only log answers "what changed after cursor N." Replaying seven
years of operations to give a new device its current 100,000 rows is the wrong
answer to a different question. The stable structure has two parts:

```text
snapshot at sequence N + ordered changes after N
```

PowerSync compacts bucket histories while keeping checkpoint integrity.
Electric starts a Shape with a snapshot and continues from its offset.
Event-sourced systems need snapshots or compaction so materialization time
stops growing with the product's age. A client that falls behind the retained
history must bootstrap again.

Retention is therefore part of the protocol. The client needs a recognizable
"cursor expired" result, and the snapshot must be pinned to an exact position
in the change order so nothing falls between the two paths.

### Consistency is a per-column choice

Local-first discussions often set CRDTs against server authority. CRDTs such as
Automerge and Yjs fit data whose natural operation is a merge: collaborative
text, canvases, shared cursors, replicated collections. Server ordering fits
writes that must satisfy permissions, invariants, inventory limits, or
accounting rules.

[Figma's multiplayer architecture](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
is a server-authoritative design: the server is the central authority and keeps
the latest value of each property, and Figma states it does not use true CRDTs.
[Cinapse's move away from Automerge](https://www.powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync)
shows file history growing past a 4 GB WebAssembly memory limit for
multi-year scheduling files, which pushed some customers onto extra sync
servers. That cost keeps falling:
[Automerge 3 cut runtime memory by more than 10×](https://automerge.org/blog/automerge-3/)
by using its compressed representation at runtime. Cheaper CRDTs fit more
workloads, and whether the application needs server authority remains a
separate question.

The useful boundary is the smallest piece of data that needs merge semantics.
A collaborative description field can merge while the task row around it stays
under authorization, validation, and server order.

### Every engine pays a routing cost

Every partial-replication system answers one question: which rows belong on
this device? Buckets, shapes, query plans, triples, and subscriptions all carry
routing metadata in different places, and none removes it.

The routing cost turns harmful when the sync model quietly dictates the
application schema. It stays manageable when routing keys are explicit and
authority stays in application code.

## The landscape in 2026

"Sync" names several products, so the right choice follows a product's center
of gravity.

**Connected collaboration and long-term offline work have different failure
budgets.** Zero, stable at 1.0, serves the connected experience and leaves
long-term offline writes outside its scope.

**Query-driven sync and explicit subscriptions are converging.** PowerSync Sync
Streams, TanStack DB's on-demand modes, Zero queries, and Jazz subscriptions all
let application demand shape the local replica. The operational question is
whether a system exposes what was requested, what was authorized, what remains
cached, and whether a local result is complete.

**Read-path replication and write-path coordination can stay separate layers.**
Electric with TanStack DB delivers current Postgres state through Shapes,
persists local collections, and queues offline transactions, while an
application API owns authoritative mutation semantics. A library can supply an
outbox; what the business does with a week-old rejected operation stays the
application's decision.

**Managed client SQLite is the expected baseline.** PowerSync, TanStack DB,
LiveStore, Jazz, Turso, browser WASM SQLite, and native embedded databases all
keep reads off the network. The differences have moved to replica boundaries,
authorization, write semantics, recovery, and operational evidence.

**Partial replication is an authorization problem.** A system that cannot say
why a row belongs on a device has no multi-tenant offline story yet.

**Vendor lifecycle belongs in the decision.** MongoDB's
[Atlas Device Sync end of life on September 30, 2025](https://www.mongodb.com/docs/atlas/app-services/sync/device-sync-deprecation/)
forced production Realm users to migrate. Replicache's transition was gentler,
since it was open-sourced and stays supported in maintenance mode, and
development still moved to Zero. Replacement cost sits beside latency and API
design.

**Decentralized systems start from another authority model.**
[Evolu](https://www.evolu.dev/), [Anytype](https://anytype.io/), and
Automerge-based applications focus on data sovereignty, cryptographic identity,
or operation without a required server. Jazz v2 moved out of this group when it
adopted a trusted server for sync-time access control.

The [Ink & Switch local-first ideals](https://www.inkandswitch.com/local-first/)
remain a useful checklist: fast, multi-device, offline, collaborative, long-lived,
private, and user-controlled. The engineering work is deciding which of those
an architecture can guarantee, and under which authority model.
[Part 2](/blog/syncular-write-path/) shows the choices Syncular made.

---

*Further reading: [Marco's offline-first landscape](https://marcoapp.io/blog/offline-first-landscape) · [Ink & Switch on local-first software](https://www.inkandswitch.com/local-first/) · [Martin Kleppmann on local-first](https://martin.kleppmann.com/2024/05/30/local-first-conference.html) · [Figma's multiplayer architecture](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) · [Replicache: how it works](https://doc.replicache.dev/concepts/how-it-works) · [TanStack DB 0.6](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes) · [Jazz v2](https://jazz.tools/blog/what-is-jazz) · [Turso Sync](https://docs.turso.tech/sync/usage) · [Automerge 3](https://automerge.org/blog/automerge-3/) · [Pesterhazy's sync patterns](https://gist.github.com/pesterhazy/3e039677f2e314cb77ffe3497ebca07b) · [Notion's WASM SQLite migration](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite) · [Linear's incident report](https://linear.app/now/linear-incident-on-jan-24th-2024) · [Cinapse on moving away from CRDTs](https://www.powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync)*
