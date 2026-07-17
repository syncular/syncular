---
title: Here’s What Nobody Tells You About Offline-First
description: Why durable offline writes are the hard part of sync, how today’s engines work under the hood, and the architecture those lessons produced in Syncular.
author: Benjamin Kniffler
publishedAt: '2026-07-17'
---

# Here’s What Nobody Tells You About Offline-First

Offline reads are easy. Put data in SQLite, query it locally, and render it. Writes are the hard part. They are what will eat your weekends.

What happens when two devices edit the same row while one is on a plane? What happens when the server applies a push but the acknowledgement disappears? What happens when a user loses access to a project while their laptop still has three days of pending work for it? What happens when the schema changes before that laptop reconnects?

I have been circling this problem for years. Back in 2019 I built [debe](https://github.com/bkniffler/debe), a reactive offline-first datastore with CRDT-based sync, multi-master replication, and adapters for SQLite, Postgres, and in-memory stores. It never became production-ready. It did teach me that convergence is only one part of a real sync product. Authorization, durable recovery, bootstrap, retention, and debugging are just as fundamental.

Seven years later, the ecosystem is much larger. I spent a long time evaluating the current generation of sync tools, building prototypes, and finding the places where application-specific glue begins. Eventually I realized that the glue was the system I wanted to build.

The result became [Syncular](https://syncular.dev): local SQLite on every client, a server-authoritative commit log, explicit scopes, and one written protocol implemented independently in TypeScript and Rust.

This post is about the path from the landscape to that architecture. Even if you never use Syncular, the failure modes and tradeoffs apply to almost any application that accepts writes without a reliable network.

## Why offline writes are the real problem

Most sync products lead with the read path: how to get server data onto a device quickly and keep a UI reactive. It is valuable and comparatively well understood. Stream rows, maintain a local projection, invalidate queries, and render from the local copy.

Durable offline writes add a different class of requirements:

- **Durability across restarts.** The user typed something, killed the app, updated it two days later, and came back. Is the write still there?
- **Atomic optimism.** Can the UI show a local write without creating a state where the row exists but the outbox entry does not?
- **Ordering and idempotency.** A request timed out. Did the server reject it, apply it once, or apply it and lose the reply?
- **Conflict evidence.** Two users edited the same record offline. Can the application see the losing intent and the server’s winning row?
- **Authorization changes.** A user was removed from a project while offline. Which local data is purged, and what happens to pending writes?
- **Schema evolution.** An old outbox contains a column that no longer exists. Does the client guess, crash, or preserve enough evidence to recover?
- **Bootstrap and retention.** Does a new or long-absent client replay years of changes, or can it start from a trustworthy current snapshot?
- **Debugging.** When device B is missing a row, can you explain why from durable state rather than reconstructing a transient invalidation chain?

These are the normal operating conditions for apps used on trains, construction sites, factory floors, job sites, and mobile networks.

Zero’s current documentation puts the difficulty plainly. [Zero does not support long-term offline writes](https://zero.rocicorp.dev/docs/connection): disconnected clients may continue reading synced data, but writes are rejected. Its explanation points to arbitrary business rules, authorization, schema changes, and concurrent edits that a generic algorithm cannot resolve correctly.

Offline-first means preserving work, making authority explicit, and giving the application enough durable evidence to choose what happens next.

### The browser-storage floor

On the web, every offline architecture eventually meets the persistence substrate.

[IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) is an object store. Products that offer relational behavior on top of it must either emulate database semantics, store another database’s pages as objects, or adopt a different data model such as triples or key-value records.

[OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) makes a different design possible: run SQLite compiled to WebAssembly and persist its files inside the browser’s origin-private filesystem. You get real SQL, transactions, indexes, and a familiar storage engine.

Multiple tabs still need an explicit coordination model. A single elected owner is the simplest option, but it is no longer the only one. SQLite 3.53 added an [`opfs-wl` VFS](https://sqlite.org/wasm/doc/tip/persistence.md) backed by Web Locks, and its current guidance describes moderate concurrent access when clients keep transactions short and handle `SQLITE_BUSY`. PowerSync’s 2026 [`OPFSWriteAheadVFS`](https://powersync.com/blog/powersync-changelog-may-2026) enables concurrent reads and faster writes, but currently depends on a Chromium-only OPFS mode. OPFS supplies the storage primitive; the concurrency policy is still the application’s to choose, and the fastest capabilities are not yet uniform across browsers.

[Notion’s move to WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite) is a useful case study. The database was the easy part; coordinating it safely across tabs required a SharedWorker, an active-tab model, and Web Locks.

Syncular takes the same constraint seriously. The web client runs the complete TypeScript core and sqlite-wasm inside a Web Worker. Multi-tab mode elects one leader for the database; followers proxy operations and can take over after the leader closes. Native clients use SQLite through the Rust core. In both cases, one sync loop owns one local transactional state machine.

The general lesson is simple: a durable outbox is only as durable as the database transaction and ownership model underneath it.

## Following one write through the landscape

A feature matrix is the least interesting way to compare sync engines. The important differences are algorithmic: what is replicated, what is authoritative, and how speculative state is reconciled when reality catches up.

Imagine that I create a task on a laptop while offline. Another device edits the same project. My access is revoked before I reconnect. When I finally push, the server accepts or rejects the operation, but the response is lost. Meanwhile the application has shipped a new schema and the incremental history has been pruned.

No product can make those facts disappear. Each product chooses a unit of state and an algorithm around it:

- PowerSync replicates bucketed row operations and advances consistent checkpoints.
- Zero maintains the results of live queries through incremental view maintenance.
- Electric streams table-shaped logs; TanStack DB incrementally maintains local queries and optimistic overlays.
- Replicache records mutation invocations and rebases them over canonical patches.
- Turso Sync reconciles local and remote database histories.
- LiveStore syncs domain events and materializes them into SQLite.
- Jazz v2 keeps row-version histories and reconciles them through an integrated database hierarchy.

Those choices determine what a system can make simple, what the application still has to own, and what evidence exists after something fails.

### PowerSync: bucket logs and checkpointed SQLite

[PowerSync](https://www.powersync.com/) is one of the most mature offline-first systems in this group, with broad platform support and managed SQLite on the client. Its architecture cleanly separates the two directions of data flow.

Downstream starts at the source database. PowerSync takes an initial snapshot and then follows its change stream: Postgres logical replication, MongoDB change streams, the MySQL binlog, or SQL Server CDC. [The service preprocesses those changes into buckets](https://docs.powersync.com/architecture/powersync-service): append-only histories of `PUT` and `REMOVE` operations. A bucket might represent one user, one organization, or another parameterized slice shared by many clients. Bucket storage is durable and can be compacted; connected clients stream from it rather than querying the source database directly.

Its [Sync Streams reached GA in May 2026](https://releases.powersync.com/announcements/sync-streams-are-now-generally-available). SQL-like stream definitions select the data for a client from authentication, connection, and subscription parameters. Streams make buckets mostly implicit, but they do not remove them: the bucket is still the scalable unit of operation history and deduplication underneath.

The downstream protocol is more than row streaming. A client asks for operations after the IDs it already holds, receives a checkpoint and the missing operations, and verifies per-bucket checksums before exposing the new state. The [same checkpoint protocol](https://docs.powersync.com/architecture/powersync-protocol) handles first bootstrap, catch-up after a long absence, and live delivery. A checkpoint spans buckets and tables, so a client does not expose half of a large server transaction.

Upstream has a different shape:

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

Local mutations are applied immediately and recorded in `ps_crud`, a blocking FIFO upload queue. The SDK retries them and calls an [`uploadData()` function supplied by the application](https://docs.powersync.com/architecture/client-architecture). That is a deliberate strength: the real backend remains free to run arbitrary validation, authorization, side effects, and conflict rules. PowerSync does not ask the sync service to impersonate the application server.

PowerSync’s [causal+ consistency model](https://docs.powersync.com/architecture/consistency) makes the split coherent. Local mutations sit as an overlay on the last confirmed checkpoint. While the upload queue is non-empty, the client does not advance to a later checkpoint. After the write has reached the source database and come back through CDC, the client can replace the overlay with a new consistent checkpoint. It avoids trying to merge a half-confirmed local row with an unrelated point in server history.

What this buys is a mature relational replica, a robust download protocol, and application-controlled write semantics. The corresponding boundary is that the read protocol cannot define the final meaning of a rejected write for you. The application API still owns idempotency, conflict policy, authorization drift, and any durable repair record. Partial replication also has to be expressible as stream parameters and supported SQL. Flat ownership rules are elegant; deep organization → project → task permissions need routing columns or application code that resolves membership into parameters.

PowerSync made one design pressure impossible to ignore: every partial-replication system pays a routing tax, and a complete authoritative write protocol needs more than a read stream plus a durable upload queue.

### Zero: the query result is the replica

[Zero](https://zero.rocicorp.dev/) begins from a different question: what if the client could write an ordinary relational query and the system kept that exact result live?

A named ZQL query exists on the client and the server. It runs against the local store first, so cached rows render immediately. In parallel, the client sends the query name and arguments to `zero-cache`; `zero-cache` asks the application’s query endpoint for the server-side ZQL expression, which may add permission filters, and runs it against a read-only SQLite replica of Postgres. Logical replication advances that replica. A view-syncer hydrates the query once and then uses incremental view maintenance to push only affected row changes.

That last part matters. Re-running every active query after every database change would make reactive sync scale with `changes × queries`. Zero instead maintains query pipelines. Its own self-hosting guide describes the algorithm as [“hydrate once, then incrementally push diffs”](https://zero.rocicorp.dev/docs/self-host). Client View Records, or CVRs, remember what each client has already received so reconnects can be expressed as diffs rather than full query results.

The local database is therefore roughly the union of active and cached query results, with TTLs controlling how long inactive results stay warm. This keeps the replica shaped exactly like the UI: mount a query and the necessary rows appear; unmount it and the server can eventually stop maintaining it. It also means completeness is a query property. Zero exposes `complete` versus `unknown` results because an immediate local answer may be only the part of the query that happens to be present.

Writes use the same optimistic/authoritative split pioneered by Replicache. A [mutator](https://zero.rocicorp.dev/docs/mutators) first runs against the client store and updates open queries. A mutation record then goes to the application’s push endpoint, where the server-side mutator runs in a database transaction and records that it ran. Postgres logical replication carries the resulting rows back through `zero-cache`. When the client receives the authoritative rows and mutation confirmation, it removes the confirmed speculative effect and reconciles its remaining pending mutations.

The business operation consequently has two executions: fast and speculative on the client, authoritative on the server. They can share TypeScript, but they do not have to produce the same result. The server may see newer rows, reject access, or invoke systems that the client cannot reach. That freedom produces an excellent interaction model, but it also makes mutator compatibility part of the application’s correctness surface.

[Zero reached 1.0 and general availability in 2026](https://zero.rocicorp.dev/docs/status), and its offline boundary is deliberate rather than unfinished: once the connection state becomes disconnected, [writes are rejected](https://zero.rocicorp.dev/docs/connection). Reads of already-synced data continue to work. By refusing week-old offline writes, Zero avoids pretending that a generic query engine can decide how stale business operations, permissions, and schemas should be repaired.

For connected collaborative software, this is an unusually strong set of choices: query-shaped replication, server-side permission transforms, incremental computation, and immediate mutations. For field software that must accept work during a multi-day outage, the rejected-write boundary is decisive. Zero taught me two things: query-driven sync is at its core an incremental computation architecture, and long-term offline writes deserve an explicit protocol rather than an optimistic cache stretched beyond its intended lifetime.

### Electric and TanStack DB: compose the read path and write path

[Electric Sync](https://electric.ax/docs/sync/) intentionally calls itself a read-path sync engine for Postgres. Its primitive is a Shape: one table, an optional `WHERE` clause and projection, and an ordered log of changes.

A consumer requests a Shape from offset `-1` for its initial snapshot, then continues from the returned offset and handle. Once caught up, it can long-poll or use SSE. The stream mixes row operations with control messages such as `up-to-date` and `must-refetch`. Because the protocol is ordinary HTTP, Shape logs fit naturally behind proxies and CDNs. The [HTTP API](https://electric.ax/openapi) is deliberately small enough that different local stores can consume it.

TanStack DB supplies the client-side relational layer. Synced rows enter normalized collections. Live queries are not recomputed wholesale: they use [`d2ts`, a TypeScript differential-dataflow engine](https://tanstack.com/db/latest/docs/overview), to propagate changes through filters, joins, sorts, and aggregates. If one row changes in a large joined query, the system updates the affected part of the dataflow rather than starting the query again.

Writes travel through the application API instead of backward through the Shape log:

```text
TanStack optimistic transaction
  -> application mutation endpoint
  -> Postgres transaction (returns txid)
  -> Electric Shape log
  -> await that exact txid
  -> retire optimistic overlay
```

The transaction ID is the elegant part of this composition. Waiting for the exact Postgres transaction, rather than a matching row ID, lets TanStack DB know when the authoritative write has passed through Electric, even if other users changed the same rows in between. The [Electric/TanStack reference architecture](https://electric.ax/blog/2025/07/29/super-fast-apps-on-sync-with-tanstack-db) can then rebase the optimistic overlay over concurrent changes and remove it at the correct point in the stream.

TanStack DB 0.6 made the offline side substantially stronger. It added [optional SQLite-backed persistence](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes), and [`@tanstack/offline-transactions`](https://github.com/TanStack/db/tree/main/packages/offline-transactions) persists an outbox before applying optimism, processes it in FIFO order, retries with backoff and idempotency keys, and elects one browser-tab leader. This is a real durable write queue that survives restarts.

The power of this stack is composability. Electric specializes in turning Postgres changes into cache-friendly logs; TanStack DB specializes in local incremental computation; the application server keeps its own write API. A team can adopt those pieces independently.

The cost is that correctness crosses the seams. The outbox can supply an idempotency key, but the endpoint must persist and enforce it. It can retry, but only the application can decide whether an old command is still authorized. It can roll back an optimistic transaction, but it cannot invent the domain-specific repair UI or translate a queued payload across an incompatible schema. Electric’s [Durable Streams](https://electric.ax/blog/2026/01/22/announcing-hosted-durable-streams) add a separate append-only log with idempotent producers and exactly-once semantics, but they remain a coordination primitive rather than the relational business authority.

This stack clarified a distinction I had previously blurred: durable queueing is a client-library feature; durable application of a business operation is an end-to-end protocol property.

### Replicache: mutation logs and deterministic rebase

[Replicache](https://doc.replicache.dev/concepts/how-it-works) came closest to the state machine I had in mind. It is now in [maintenance mode](https://replicache.dev/) after Rocicorp shifted development to Zero, but its algorithm remains one of the clearest explanations of optimistic server-authoritative sync.

The client stores an ordered key-value map. An application mutator transactionally reads and writes that map. Running it immediately changes the Client View and also persists a mutation record:

```text
{ clientID, mutationID, name, args }
```

`mutationID` is a sequential per-client integer. During push, the server executes mutations in that order against its canonical database and atomically advances the client’s `lastMutationID`. That atomicity is the idempotency rule: if the server says mutation 42 is processed, the effects of 42 and every earlier mutation from that client must be visible in the same canonical state. A timed-out push can be retried; the high-water mark prevents the server from applying it twice.

Pull is the inverse. The client sends an opaque cookie identifying its last canonical server state. The server returns a new cookie, a patch over the client’s key space, and the `lastMutationID` values it has accepted. Replicache discards the mutations now confirmed by the server. Then comes the core algorithm: it rewinds to the last confirmed Client View, applies the server patch, and re-runs every still-pending mutator over that new base. Only after this rebase is complete does it atomically reveal the result to the application.

```text
old confirmed base + pending A + pending B
                 pull arrives
old confirmed base + server patch + replay(A) + replay(B)
```

The replay may legitimately produce a different answer. A local `reserveRoom` mutator might have succeeded offline, then discover during rebase that someone else reserved the room. Conflict resolution is ordinary program logic inside the mutator; each domain writes the rule it actually needs. A content-free “poke” over WebSocket or SSE tells the client when to pull; the recoverable data still moves through request/response sync.

This design gets a lot right. The server is authoritative, lost acknowledgements are safe, speculative work survives incoming server changes, and conflict behavior can be domain-specific. Its costs follow from the same choices. The client view is key-value rather than relational, so rich querying needs indexes and conventions. The server must implement the corresponding mutators and pull protocol. A client mutator must also be deterministic enough to replay and compatible enough with the server meaning that it represents.

Replicache gave me three foundations I kept: per-client mutation identity, rewind-and-replay reconciliation, and the doorbell transport pattern. It also convinced me that a relational system should generate as much of the cross-runtime contract as possible rather than making every product hand-maintain two versions of each mutation.

### Turso Sync: make the database the replication unit

[Turso Sync](https://docs.turso.tech/sync/usage) starts with the most literal local-first premise: the application opens a real local SQLite-compatible database, reads and writes it normally, and explicitly pushes or pulls against a remote Turso database.

The two directions use different representations. Push sends logical changes captured from the local write history. Pull transfers physical database state. If remote changes exist while local work is pending, Turso rolls the local database back to its last synced state, applies the remote state, and [replays the local changes atomically](https://docs.turso.tech/sync/conflict-resolution). The current conflict rule is last-push-wins: the order in which pushes reach the remote database decides the winner.

That is a compact algorithm because SQLite already supplies most of the machinery. The local database is both application read model and durable write substrate. There is no separate object cache to keep coherent, and no query language has to be translated into a client view.

Its natural security and provisioning boundary is the database. This is excellent for database-per-user, database-per-device, or database-per-tenant products. Turso’s experimental [partial sync](https://docs.turso.tech/sync/partial) can reduce bootstrap cost by downloading a prefix or only the pages touched by a server-side query, then lazily fetching missing page segments. That is physical demand paging: the remote database and its token remain the trust boundary, and access is granted per database rather than per row.

The tradeoff appears when collaboration does not align with database files. If one user belongs to 200 projects shared with different groups, the application must decide whether to provision many databases, broaden one database’s contents, or build routing above the sync layer. Whole-database sync removes a great deal of row-routing machinery by choosing a coarser unit. It does not remove the routing decision.

### LiveStore: events are the source of truth

[LiveStore](https://livestore.dev/) chooses domain events rather than rows as the replicated unit. An event has a name, typed arguments, a sequence number, and a parent sequence number. Clients sync those events through a central backend and run deterministic materializers to produce reactive local SQLite tables. SQLite is the queryable projection; the event log is the source of truth.

The sync algorithm is deliberately Git-like. The backend assigns a global total order. A client has local pending events on its own head. Before it can push, it pulls upstream events, rebases the pending events over the new head, and then pushes. On the web, a leader coordinates the local store across browser sessions. The three heads (session, local leader, and backend) make the location of pending work explicit.

Event sourcing buys something row replication cannot provide automatically: the original business intent. `TaskAssigned` is more informative than “the `assignee_id` column changed.” It is a strong basis for audit, debugging, undo, and rebuilding derived state. The [Riffle research](https://riffle.systems/) behind LiveStore also shows the appeal of treating the local database as a materialized application state machine rather than a disposable cache.

History is also the cost center. Event schemas and materializers become compatibility contracts. New clients need a bounded way to reach current state, and old history eventually needs compaction. Partitioning and authorization must decide which event histories a client may receive without leaking the events that produced forbidden rows.

LiveStore’s documentation is direct about its current frontier: [authorization is still a TODO, merge-conflict handling and compaction are not implemented, and the system currently assumes one event log per SQLite database](https://docs.livestore.dev/building-with-livestore/syncing/). That candor marks exactly where a general event-sourced local-first engine becomes a multi-tenant sync product. It reinforced two requirements for me: keep durable causal evidence, but let a current snapshot bound the cost of joining or returning after a long absence.

### Jazz v2: an integrated row-history database

[Jazz v2](https://jazz.tools/blog/what-is-jazz), released in public alpha in April 2026, is the most comprehensive attempt here to make the database itself own local persistence, partial replication, permissions, reconciliation, and schema evolution.

Jazz stores tables locally, but it does not simply overwrite a row. Every write creates a row version that points to its earlier version or versions. Concurrent edits form branches in a row-local history graph. The visible row is computed from that history: writes to the same field converge with last-writer-wins, while concurrent writes to different fields can both survive. Losing versions remain available as reconciliation evidence.

This is a notable change from classic Jazz. The team moved from pervasive CRDT histories to a [Git-like snapshot DAG](https://jazz.tools/blog/what-we-learned-from-classic-jazz), doing more work at rarer merge points so current-state reads do not require replaying as much history. It also moved permissions toward a trusted server that can enforce evolving policies at sync time, while still allowing selected encrypted columns.

Queries define the partial replica. A server remembers each subscription in a live query graph, re-settles only affected parts when rows or policies change, and sends deltas to the client. Offline writes enter local OPFS immediately and queue row-version updates. When connected, writes flow upward through local, edge, and global tiers; callers can wait for the durability level they require. The global tier reconciles concurrent versions and propagates the result back to subscribed clients.

Schema evolution is equally structural. Each schema has a hash and its own branch. Bidirectional [schema lenses](https://jazz.tools/docs/schemas/migrations) translate rows across versions, so old and new clients can continue to exchange data without rewriting all stored history at once.

Putting all of this in one system removes enormous amounts of glue. Query completeness, row history, rejected persisted writes, permission policies, migration compatibility, and durability acknowledgements can share one model. The adoption cost is equally clear: Jazz becomes the product’s database, query layer, permission system, migration model, and cloud protocol. It is also still alpha.

Jazz v2 is important because it converged independently on many of the same pressures that shaped Syncular: trusted sync-time authorization, relational partial replicas, retained conflict evidence, OPFS ownership, and schema-aware recovery. The difference is the architectural center. Jazz defines a new integrated database. Syncular starts with an application’s existing relational database and backend authority, then adds a portable synchronization protocol around them.

## Patterns that apply to almost any sync system

The implementations differ, but the same invariants keep resurfacing across those tools, debe, and Syncular. These are the parts I now look for before I look at an SDK.

### Optimistic state needs a confirmed base

“Optimistic update” sounds like a UI trick: change the screen now and undo it if the request fails. Durable offline work needs a stronger model.

At any moment the client conceptually holds two things:

```text
visible state = last confirmed base + ordered pending intent
```

PowerSync keeps local mutations over the last checkpoint and pauses checkpoint advancement. Replicache rewinds to its last canonical Client View, patches it, and replays pending mutators. Turso rolls back to the last synced database state, applies the remote state, and replays local changes. Zero retires confirmed speculative effects as authoritative rows arrive. The representations differ, but the invariant is the same: never confuse “the user can see it” with “the authority accepted it.”

This model also explains why FIFO matters. If pending write B was created after pending write A, rejecting A may change what B means. Dropping A from a queue is insufficient; the client must rebuild a coherent visible state from a confirmed base and the intent that still survives.

debe concentrated on making concurrent replicas converge. What I had underestimated was the value of preserving both layers, the confirmed base and the ordered speculative branch, long enough to explain a rejection and reconstruct the right local answer.

### Exactly-once application starts with durable identity

TCP does not tell an application whether a timed-out request committed. Retrying is unavoidable, so a write protocol needs an identity that survives process restarts and network attempts.

Replicache uses a client ID plus a sequential mutation ID and atomically stores the last applied ID with the mutation’s effects. TanStack’s offline queue provides idempotency keys, leaving the server endpoint to enforce them. PowerSync sends queued CRUD through an application API, which must decide its own idempotency contract. These are all versions of the same principle:

```text
at-least-once delivery + durable operation identity
  -> exactly-once application
```

The result also needs to be durable. If a server remembers only successful IDs, a retried rejected operation may be evaluated against a different authorization or schema and produce a different answer. If a client deletes a failed operation without recording its outcome, the UI cannot explain after restart why the optimistic row vanished.

“Exactly once” is therefore a state-machine guarantee over operation identity, authoritative effects, and the recorded outcome.

### The transport should serve one state machine

Replicache introduced many developers to the [“shoulder tap” or doorbell pattern](https://gist.github.com/pesterhazy/3e039677f2e314cb77ffe3497ebca07b): a WebSocket announces that something changed, while an ordinary HTTP request fetches the data.

It is a great pattern. HTTP is retryable, observable, and easy to replay. A socket doorbell avoids putting bulk transfer and recovery semantics into a long-lived connection.

The invariant that matters most is that push, pull, registration, ordering, and retry behavior belong to one synchronization state machine.

Syncular uses one handler with two transport bindings. Once connected, normal combined push/pull rounds and ordered deltas travel as framed SSP2 messages over the WebSocket. When the client is behind, a delta is too large, or a reset is required, the socket sends a wake-up that tells the client to run a full sync round instead of applying an inline delta. `POST /sync` remains a conformant HTTP binding for debugging, server-to-server integrations, push-only producers, and clients without a live socket. Snapshot segments and blobs stay on HTTP because those are the CDN and object-storage paths.

Transport recovery stays boring, and both bindings share one sync implementation.

### Append-only logs beat invisible invalidation when debugging

Reactive invalidation and ordered logs can both keep clients current. Their failure stories are very different.

With an ordered commit log, a client says “give me everything after cursor N.” Every accepted commit gets a sequence. When a row goes missing, you can inspect commits, scopes, cursors, and durable client outcomes. It is a receipt.

With dependency-driven invalidation, you often reconstruct which change invalidated which query, which recomputation ran, and which result was delivered. Excellent tooling can make that manageable, but the causal chain is less explicit by default.

Linear’s [January 2024 incident report](https://linear.app/now/linear-incident-on-jan-24th-2024) is a good illustration of why logs matter. Their action log enabled recovery and also made unresolved conflicts visible. A log does not prevent every failure; it gives you durable evidence with which to explain and repair one.

### A log needs a snapshot and a retention horizon

An append-only log is the best representation for “what changed after cursor N.” It is a terrible requirement for “give this new device the current 100,000 rows” if the only answer is to replay seven years of operations.

The stable architecture is a dual:

```text
snapshot at sequence N + ordered changes after N
```

PowerSync compacts bucket histories while preserving their checkpoint integrity. Electric starts a Shape with a snapshot and continues through its offset. Event-sourced systems eventually need snapshots or compaction so materialization time does not grow with the age of the product. A client that falls behind the retained history must stop pretending incremental recovery is possible and bootstrap again.

This makes retention a protocol boundary. The client needs a recognizable “cursor expired” result, and the snapshot must be pinned to an exact place in the change order so nothing is missed between the two paths.

### Choose consistency at the column level

The local-first conversation is often framed as CRDTs versus a server authority.

CRDTs such as Automerge and Yjs are excellent for data whose natural operation is merge: collaborative text, canvases, shared cursors, and replicated collections. Server-authoritative ordering is a better fit when writes must satisfy permissions, invariants, inventory limits, or accounting rules.

[Figma’s multiplayer architecture](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) is a famous server-authoritative example. The server orders updates; clients follow. On the other side, [Cinapse’s experience moving away from document-wide CRDT storage](https://www.powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync) shows how retaining granular history can become expensive for large structured datasets. That cost curve is moving: [Automerge 3 cut runtime memory by more than 10×](https://automerge.org/blog/automerge-3/) by keeping its compressed columnar representation in memory. Implementation improvements make CRDTs viable for more workloads, but they do not decide whether the application needs server authority.

Syncular chooses the consistency model per column rather than per product:

- ordinary columns use last-write-wins or explicit `baseVersion` conflicts;
- CRDT columns merge server-side using Yjs/yrs;
- encrypted columns remain ciphertext to the server;
- blob references point to content-addressed objects outside the row stream.

A collaborative description field can be a CRDT while the task row around it remains subject to scopes, validation, and server ordering. The useful boundary is the smallest piece of data that actually needs merge semantics.

### Every sync engine charges a routing tax

Every partial-replication system must answer one question: which rows belong on this device?

Some systems encode that answer in buckets. Others use shapes, query plans, triples, or subscriptions. None eliminates the need for routing metadata; they move it.

The dangerous version is an invisible tax where the sync model quietly dictates the application schema. The more honest version makes routing keys explicit and keeps authority in application code.

Syncular requires every synced table to declare at least one scope pattern, and every row carries the corresponding scope columns. A note might declare `list:{list_id}`. This is intentional denormalization at the authorization boundary: the server must be able to route the row and its changes without executing an arbitrary join for every client and every commit.

What Syncular avoids is encoding the entire membership hierarchy into a separate rules language. Your backend resolves the actor’s allowed values using ordinary code and relational queries. The sync layer intersects those values with the client’s requested subscriptions and enforces the result for both reads and writes.

The tax still exists. It is small, named, indexed, and testable.

## Applying those patterns: how Syncular works

By this point the design no longer felt like a menu of independent features. The preceding constraints force a fairly specific shape: a transactional local database, a confirmed base plus pending branch, durable commit identities and outcomes, an ordered authoritative log, explicit replica boundaries, and snapshots pinned into that log.

The shortest accurate description of Syncular is:

**local SQLite + a server-authoritative commit log + [scopes](/concepts-scopes/).**

Every client has a real SQLite database. Reads are local SQL. Mutations update local rows immediately and append the same operation to a durable outbox in one transaction. The server authorizes and validates commits, assigns their order, stores relational current state, and sends scoped changes to other clients.

```text
mutate()
  ↓
one local SQLite transaction
  ├─ apply optimistic row changes
  └─ append a durable outbox commit
  ↓
combined push/pull round
  ↓
server authorization + validation + conflict detection
  ↓
applied | cached | conflict | rejection
  ↓
drain outbox, journal outcome, reconcile local state
  ↓
deliver ordered changes to subscribed clients
```

Each step is observable and repeatable.

### Local SQLite is the application read model

The browser client runs sqlite-wasm over OPFS inside a Web Worker. Native clients use SQLite through the Rust core. Application queries never need a network round-trip.

The recommended read path is [generated SQL](/tooling-queries/) or [SYQL](/syql/). [Typegen](/guide-schema/) checks queries against the schema and emits typed APIs for TypeScript, Swift, Kotlin, Dart, and Rust. All five targets consume the same target-neutral QueryIR: the same public inputs, selected physical statement, positional bind order, reactive dependencies, synchronization coverage, and proven row identity. There is no second Rust query compiler quietly making different decisions.

The [generated Rust surface](/platform-rust/) is deliberately complete rather than a typed-row wrapper. Each query gets `Params` and `Row` types, an inspectable `select` function, `run`, an atomic `snapshot`, and a descriptor carrying dependencies and coverage. Integers stay exact `i64`; absent optional values remain distinct from present `NULL`; malformed dynamic rows fail with query-and-column context instead of being partially accepted. That is the kind of unglamorous cross-platform fidelity an offline system needs: local reads must mean the same thing everywhere before synchronization can make them converge.

```tsx
import { useQuery } from '@syncular/react';
import { listTodosQuery } from './syncular.queries';

const todos = useQuery(listTodosQuery, { listId });

if (todos.phase === 'loading') return <Skeleton />;
if (todos.phase === 'partial') {
  return <TodoList rows={todos.rows} incomplete />;
}

return <TodoList rows={todos.rows} />;
```

The [`partial` state](/concepts-windowing/) prevents an incomplete local replica from presenting an empty result as complete. Every required scope unit must finish [bootstrap](/concepts-bootstrap/) first. Query rows and completeness are read from the same SQLite snapshot.

Guarded raw SQL remains available for dynamic reads. Raw writes are rejected because they would bypass the outbox; inserts, updates, and deletes go through the mutation API.

### Scopes are code-backed and enforced on both paths

The schema declares routing fields:

```json
{
  "tables": [
    {
      "name": "notes",
      "scopes": ["list:{list_id}"]
    }
  ]
}
```

The application backend resolves what the authenticated actor may access:

```ts
const config = {
  schema,
  storage,
  segments,

  resolveScopes: async ({ actorId }) => {
    const lists = await listsForUser(actorId);
    return {
      list_id: lists.map((list) => list.id),
    };
  },
};
```

The client requests concrete values through generated subscription helpers or explicit subscriptions. Effective access is the intersection of requested and allowed values.

Writes use the same authority. Updates are authorized against the row currently stored on the server rather than scope values supplied by the client. Scope columns are immutable in client-originated updates, so a client cannot move a row into a scope it controls.

If a requested grant disappears, the [subscription is revoked as a unit](/concepts-scopes/). Its rows are purged locally, its realtime registration is removed, and pending writes into the revoked grant cannot land on the server.

An offline device cannot learn about revocation while physically disconnected. No sync protocol can fix that. The guarantee begins at reconnection: the server refuses unauthorized writes and the client removes data it is no longer allowed to hold.

### A durable outbox includes durable failure evidence

Applying the optimistic row and appending its [outbox commit](/concepts-conflicts/) happen in the same SQLite transaction. The process cannot stop between them and leave the UI showing work that the sync engine forgot.

```ts
const commitId = client.mutate([
  {
    table: 'notes',
    op: 'upsert',
    values: {
      id: 'note-1',
      list_id: 'welcome',
      body: 'Written while offline',
      updated_at_ms: Date.now(),
    },
  },
]);
```

The outbox stores schema-agnostic values and encodes them into SSP2 only when sending. After an app upgrade, compatible pending commits can be re-encoded with the [new schema](/guide-schema/). If a commit references a removed column or table, Syncular surfaces `sync.outbox_incompatible`, rolls back its optimistic state, and continues with later compatible work rather than silently dropping it.

Every final result is stored in a durable outcome journal in the same transaction that drains the outbox:

```ts
const outcome = client.commitOutcome(commitId);

if (outcome?.status === 'rejected') {
  // Restore a domain-specific repair or correction screen after restart.
}
```

Rejected operations keep their complete local envelope so the app can build one repair screen over every operation in the failed commit. The envelope stays on the device and is never uploaded as telemetry.

An outbox is not truly durable if the evidence explaining a lost write disappears on restart.

### Lost acknowledgements are harmless

Every commit is identified by:

```text
partition + clientId + clientCommitId
```

The server persists the result under that identity before acknowledging it. If the response is lost, the client retries the same commit and receives the cached result. Applied commits do not apply twice. Rejected commits remain rejected on replay.

Networks do not provide exactly-once delivery. Syncular builds exactly-once application per client commit on top of at-least-once attempts.

### The ghost-row failure

Consider one concrete sequence. A user creates a row in project A while offline, then edits an unrelated note in project B. Both changes appear locally. On reconnection, the first commit reaches the server after the user has lost access to project A. The server rejects it; the project B edit is still valid and pending behind it.

Merely deleting the rejected commit from the outbox leaves a ghost row in SQLite. Restoring an old database snapshot can remove the valid project B edit along with it.

Syncular retains protected before-images for pending commits. When an earlier commit fails, the client restores the affected confirmed rows and replays later pending commits in FIFO order. The rejected insert disappears while later independent intent survives.

The rollback bookkeeping is private engine state. The public outcome journal exposes only the durable evidence an application needs to explain or repair the failure.

### Conflicts are explicit and optional

Every server row has a monotonically increasing version. A mutation can include `baseVersion`, meaning “apply this only if the server still stores the version I edited.”

```ts
client.patch(
  'notes',
  'note-1',
  { body: 'My revised text' },
  { baseVersion: 3 },
);
```

If version 3 is still current, the write applies. Otherwise the commit produces a conflict containing the current server row and version. `patch()` also stores which fields the user intended to change. That intent remains local and durable, giving the application better merge evidence without asking the server to trust client-authored metadata.

Ordinary upserts use last-write-wins when `baseVersion` is absent. The application opts into optimistic concurrency where losing intent would matter.

### Bootstrap is a snapshot

An ordered log is ideal for incremental sync and debugging. A fresh client needs a snapshot of current state.

Syncular [bootstraps current authorized rows through content-addressed snapshot segments](/concepts-bootstrap/). The required rows format contains encoded row blocks. A faster SQLite-image format can be attached and copied directly into the local database. Segments are resumable, scope-bound, pinned to a commit sequence, and verified by hash.

Large segments use HTTP so operators can put them in [S3 or R2, issue signed URLs, and serve them through a CDN](/server-storage/). In the repository’s in-process benchmark, a warm 100,000-row SQLite-image bootstrap is about 30 ms, compared with roughly 363 ms through the row-decoding lane. These are best-case in-process measurements; a real deployment adds network and serialization costs.

The host schedules [commit-log pruning](/server-operations/). Active client cursors constrain the horizon subject to retention floors. A client returning behind the horizon receives `sync.cursor_expired`, drops the obsolete cursor, takes a fresh scoped snapshot, and resumes incrementally.

```text
incremental log while current
          ↓
cursor falls behind retention
          ↓
fresh scoped bootstrap
          ↓
resume from the snapshot pin
```

The operator-facing implementation is pruning plus re-bootstrap. The protocol leaves room for safe compaction later.

### Schema is part of the protocol

Applications author ordinary SQL migrations plus a `syncular.json` manifest. [Typegen](/guide-schema/) compiles them into a neutral schema IR, row codecs, scope metadata, subscription helpers, relational server projections, mutation types, and query APIs for TypeScript, Swift, Kotlin, Dart, and Rust.

Both client cores and the server consume the same generated contract. Runtime inference does not decide the wire format.

Schema upgrades deliberately reuse the bootstrap path. The client preserves its identity and schema-agnostic outbox, resets synced tables, bootstraps the new version, and replays compatible pending work. Maintaining one heavily tested recovery path is safer than maintaining a second local migration engine on every platform.

### One protocol, two independent client cores

The web core is TypeScript. The native core is Rust, exposed through thin Swift, Kotlin, Flutter, Tauri, React Native, and C bindings.

Both implement the written [SSP2 protocol](https://github.com/syncular/syncular/blob/main/docs/SPEC.md). Both consume the same generated schema contract. Both run the same implementation-agnostic [conformance scenarios and golden byte vectors](/guide-conformance/).

At the time of writing, the catalog contains 93 scenarios covering convergence, offline replay, lost acknowledgements, conflicts, scopes, revocation, bootstrap interruption, blobs, encryption, CRDTs, schema upgrades, realtime, presence, windowing, validation, and pruning. The repository gate passes more than 1,200 tests across the TypeScript and Rust paths.

Writing down a protocol is valuable because it removes implementation language as an excuse. If behavior can only be explained by pointing at a TypeScript object, it is not yet a portable protocol.

## The landscape in 2026

There is no universal winner because “sync” describes several different products. The right choice follows the product’s center of gravity.

**Reactive online collaboration** and **durable long-term offline work** have different failure budgets. Zero, now stable at 1.0, focuses on the connected experience and explicitly leaves long-term offline writes outside its current scope.

**Query-driven sync and explicit subscriptions are converging.** PowerSync Sync Streams, TanStack DB’s on-demand modes, Zero queries, and Jazz subscriptions all let application demand shape the local replica. The operational question is no longer simply “query or subscription?” It is whether the system exposes what was requested, what was authorized, what remains cached, and whether a local result is complete.

**Read-path replication** and **write-path coordination** can still be separate layers. Electric plus TanStack DB is a compelling example: Shapes deliver current Postgres state, TanStack DB can now persist local collections and queue offline transactions, and an application API remains responsible for authoritative mutation semantics. The libraries can supply an outbox; they cannot infer what your business should do with a week-old rejected operation.

**Managed client SQLite is becoming the default expectation.** PowerSync, TanStack DB, LiveStore, Jazz, Turso, browser WASM SQLite, and native embedded databases all point in the same direction: application reads should not wait for a network. The differentiation is moving upward into replica boundaries, authorization, write semantics, recovery, and operational evidence.

**Authorization and partial replication are inseparable.** A system that cannot explain why a row belongs on a device does not yet have a multi-tenant offline story.

**Vendor lifecycle is architecture.** MongoDB’s [Atlas Device Sync deprecation](https://www.mongodb.com/docs/atlas/app-services/sync/device-sync-deprecation/) forced production Realm users to migrate. Replicache’s transition is gentler because it was open-sourced and remains supported in maintenance mode, but development still moved to Zero. A sync engine may be an excellent product, but its replacement cost belongs in the decision alongside latency and API design.

**Decentralized systems start from a different authority model.** Projects such as [Evolu](https://www.evolu.dev/), [Anytype](https://anytype.io/), and Automerge-based applications focus on data sovereignty, cryptographic identity, or operation without one required server authority. Syncular assumes a server exists and makes it responsible for validation, authorization, audit, and final ordering. Jazz v2 no longer belongs cleanly in this category: it deliberately moved toward a trusted server for richer sync-time access control.

The [Ink & Switch local-first ideals](https://www.inkandswitch.com/local-first/) remain useful: fast, multi-device, offline, collaborative, durable, private, and user-controlled. The hard engineering work is deciding which of those properties the architecture can actually guarantee, and under what authority model.

## What Syncular does not do

The boundaries are as important as the feature list:

- It is server-authoritative. There is no peer-to-peer mode.
- It targets structured application data; frame-by-frame game state is out of scope.
- Ordinary writes are not automatically conflict-free. Without `baseVersion`, they are last-write-wins.
- Synced tables use one text primary key and must declare scopes.
- Browser persistence requires OPFS; there is no IndexedDB fallback.
- Scope columns and primary keys cannot be encrypted because the server needs them for routing.
- CRDT columns cannot also be encrypted because the server must merge them.
- Commit pruning and blob garbage collection are host-scheduled operations.
- It is self-hosted. There is no managed Syncular service.
- It is pre-1.0, and the protocol specification remains a draft.
- Native bindings exist, but packaging maturity differs across ecosystems.

If you need a decentralized database with no authority, this is the wrong architecture. If the whole product is one collaborative document, a document-centered CRDT system may be a better foundation.

Syncular is for applications that want local SQL and durable offline work while keeping a server responsible for permissions, invariants, and final ordering.

## Why Syncular has this shape

I did not set out to invent another consistency model. I wanted to combine the strongest ideas in the landscape without hiding their boundaries.

SQLite is the client substrate because the row and the intent to upload it must commit atomically, and because applications deserve a real relational read model offline. The server is authoritative because permissions and business invariants need current information that an isolated device cannot possess. Commits have durable identities and outcomes because networks can lose acknowledgements and applications must be able to explain rejected work after restart.

The server emits an ordered commit log because a cursor and a sequence are easier to inspect than an invisible invalidation graph. Scopes make the partial-replication and authorization unit explicit. Snapshots are part of the protocol because a log alone cannot give a fresh or long-absent client bounded recovery. CRDTs are available per column because collaborative text benefits from merge semantics while an inventory count or membership row usually needs authority. The TypeScript and Rust cores share generated schema IR and conformance scenarios because “the protocol” should mean the same thing on every platform.

That yields a deliberately opinionated set of guarantees:

- local writes and their outbox are one transaction;
- retries have durable identities;
- failed work leaves durable evidence;
- conflicts carry the server row;
- subscriptions say exactly what belongs on the device;
- authorization gates reads and writes;
- partial replicas admit when results are incomplete;
- fresh clients bootstrap current state instead of replaying history;
- independent implementations prove they agree.

It also identifies the intended user. If you have been burned by opaque sync layers, you may recognize the symptoms: one device is missing a row, a read-only framework needs a crash-safe outbox, or authorization guards reads while writes take another path. Syncular is the tool I wanted to exist for structured applications that must keep accepting work when the network disappears, without giving up a relational server as the final authority.

You can scaffold it with:

```sh
bun create syncular-app my-app
```

Then read the [quickstart](/quickstart/), inspect the [protocol](https://github.com/syncular/syncular/blob/main/docs/SPEC.md), try the [live demo](https://demo.syncular.dev), or explore the source on [GitHub](https://github.com/syncular/syncular).

Apache-2.0, self-hosted, and still evolving.

---

*Further reading: [Marco’s offline-first landscape](https://marcoapp.io/blog/offline-first-landscape) · [Ink & Switch on local-first software](https://www.inkandswitch.com/local-first/) · [Martin Kleppmann on local-first](https://martin.kleppmann.com/2024/05/30/local-first-conference.html) · [Figma’s multiplayer architecture](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) · [Replicache: how it works](https://doc.replicache.dev/concepts/how-it-works) · [TanStack DB 0.6](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes) · [Jazz v2](https://jazz.tools/blog/what-is-jazz) · [Turso Sync](https://docs.turso.tech/sync/usage) · [Automerge 3](https://automerge.org/blog/automerge-3/) · [Pesterhazy’s sync patterns](https://gist.github.com/pesterhazy/3e039677f2e314cb77ffe3497ebca07b) · [Notion’s WASM SQLite migration](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite) · [Linear’s incident report](https://linear.app/now/linear-incident-on-jan-24th-2024) · [Cinapse on moving away from CRDTs](https://www.powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync)*
