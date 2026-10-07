---
title: 'Durable Offline Writes, Part 2: The Syncular Write Path'
description: How Syncular handles a write made without a network, from the local SQLite transaction through the server's verdict, and why each step has the shape it has.
summary: The same offline write followed through Syncular, from one local transaction to a recorded outcome on every device.
author: Benjamin Kniffler
publishedAt: '2026-07-17'
---

# Durable Offline Writes, Part 2: The Syncular Write Path

[Part 1](/blog/offline-first-writes/) followed one offline write through seven
sync engines and ended with a set of patterns: a confirmed base under pending
intent, durable operation identity, one state machine across transports, an
ordered log with a pinned snapshot, consistency chosen per column, and
explicit routing. This part shows the system those patterns produced.

Together they force a specific shape: a transactional local database, a
confirmed base plus a pending branch, durable commit identities and outcomes,
an ordered authoritative log, explicit replica boundaries, and snapshots
pinned into that log. The shortest accurate description of
[Syncular](https://syncular.dev) is **local SQLite, a server-authoritative
commit log, and [scopes](/concepts-scopes/)**.

## One write, end to end

Every client has a real SQLite database, and reads are local SQL. A mutation
updates local rows and appends the same operation to a durable outbox in one
transaction. The server authorizes and validates commits, orders them, stores
relational current state, and sends scoped changes to other clients.

:::figure{title="One write through Syncular" ticks}
<div class="d-stack">
<div class="node hot"><span class="t">Your app</span>mutate()</div>
<div class="node"><span class="t">One local SQLite transaction</span>① apply the optimistic row changes<br>② append a durable outbox commit</div>
<div class="node"><span class="t">Sync round</span>push the outbox and pull new commits in one request</div>
<div class="node"><span class="t">Server</span>authorize, validate, detect conflicts, append to the commit log</div>
<div class="d-cols-2">
<div class="node ok"><span class="t">Back on the device</span>drain the outbox, record the outcome, reconcile local state</div>
<div class="node cool"><span class="t">Other devices</span>receive the ordered change if they subscribe to its scope</div>
</div>
</div>

::caption[The outcome is one of applied, cached (a retry of an applied commit), conflict, or rejected. Each step leaves durable state you can inspect and replay.]
:::

## Local SQLite is the read model

The browser client runs sqlite-wasm on OPFS inside a Web Worker. One tab per
origin holds a Web Locks lock and owns the worker, the database, and the
socket; the other tabs proxy calls to it, and one of them promotes itself when
the owner closes. Native clients use SQLite through the Rust core. In both
cases one sync loop owns one transactional state machine, and application
queries never wait for the network.

The recommended read path is [generated SQL](/tooling-queries/) or
[SYQL](/syql/). [Typegen](/guide-schema/) checks queries against the schema and
emits typed APIs for TypeScript, Swift, Kotlin, Dart, and Rust. All five
targets consume one target-neutral query plan: the same inputs, the same
physical statement, the same bind order, reactive dependencies, sync coverage,
and row identity. No second compiler makes its own decisions for one language.

The [generated Rust surface](/platform-rust/) shows the level of detail. Each
query gets `Params` and `Row` types, an inspectable `select` function, `run`,
an atomic `snapshot`, and a descriptor carrying dependencies and coverage.
Integers stay exact `i64`, an absent optional value stays distinct from a
present `NULL`, and a malformed dynamic row fails with query and column context.
Local reads must mean the same thing everywhere before sync can make them
converge.

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

The [`partial` phase](/concepts-windowing/) keeps an incomplete local replica
from presenting an empty result as complete: every required scope unit must
finish [bootstrap](/concepts-bootstrap/) first, and the rows and their
completeness come from the same SQLite snapshot.

Raw SQL stays available for statements built at runtime. The core accepts one
read-only statement per call; inserts, updates, and deletes go through the
mutation API, because a raw write would bypass the outbox.

## Scopes on both paths

Part 1 ended with the routing cost every partial-replication system pays.
Syncular makes it explicit. Every synced table declares at least one scope
pattern, and every row carries the matching scope column:

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

That column is deliberate denormalization at the authorization boundary: the
server routes a row and its changes without running a join per client per
commit. The membership hierarchy stays in your backend, written as ordinary
code and relational queries:

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

A client requests concrete values through generated subscription helpers or
explicit subscriptions, and the effective scopes are the intersection of what
it requested and what the resolver allows.

Writes go through the same authority. The server authorizes an update against
the row it stores, so a client cannot claim access through the payload. Scope
columns are immutable in client updates, so a client cannot move a row into a
scope it controls.

When the allowed values shrink, a subscription narrows to the values that
remain. When a requested variable loses every requested value, the server
[revokes the subscription](/concepts-scopes/): the client purges its rows,
drops its realtime registration, and pending writes into that scope cannot land
on the server.

An offline device cannot learn about a revocation while disconnected, and no
protocol changes that. The guarantee starts at reconnection: the server refuses
unauthorized writes and the client removes data it may no longer hold.

## The outbox keeps failure evidence

Applying the optimistic row and appending its
[outbox commit](/concepts-subscriptions/) happen in one SQLite transaction. The
process cannot stop between them and leave the UI showing work the engine has
forgotten.

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

The outbox stores schema-independent values and encodes them when it sends, so
pending commits survive an [app upgrade](/concepts-schema-upgrades/). A commit
that names a removed column or table cannot be encoded; it receives a rejection
with the code `sync.outbox_incompatible`, its optimistic rows roll back, and
later commits keep replaying.

Every final result enters a durable outcome journal in the transaction that
drains the outbox:

```ts
const outcome = client.commitOutcome(commitId);

if (outcome?.status === 'rejected') {
  // Restore a domain-specific repair screen, also after a restart.
}
```

A rejected commit keeps its complete local envelope, so the app can build one
repair screen over every operation in it. The envelope stays on the device.

### Lost acknowledgements

Every commit is identified by:

```text
partition + clientId + clientCommitId
```

The server persists the result under that identity before it acknowledges. If
the response is lost, the client retries the same commit and receives the
stored result, reported as `cached`. An applied commit never applies twice, and
a rejected commit stays rejected on replay. Networks deliver at least once;
Syncular builds exactly-once application per client commit on top of those
attempts.

### The ghost row

A user creates a row in project A while offline, then edits an unrelated note
in project B. Both changes show locally. On reconnection the first commit
reaches the server after the user has lost access to project A. The server
rejects it, and the project B edit, still valid, waits behind it.

Deleting the rejected commit from the outbox would leave a ghost row in
SQLite. Restoring an old database snapshot would remove the valid project B
edit as well. Syncular keeps protected before-images for pending commits. When
an earlier commit fails, the client restores the affected confirmed rows and
replays the later pending commits in order. The rejected insert disappears and
the project B edit survives.

The rollback bookkeeping is private engine state. The outcome journal exposes
the evidence an application needs to explain or repair the failure.

## Conflicts are opt-in, per column

Every server row has a version that increases on each applied write, and every
column records the version that last wrote it. A mutation can carry a
`baseVersion`: apply this only if the columns I present still hold the
version I read.

```ts
client.patch(
  'notes',
  'note-1',
  { body: 'My revised text' },
  { baseVersion: 3 },
);
```

If no column the patch presents has moved past version 3, the write applies.
Otherwise the commit produces a conflict carrying the current server row, its
version, and the columns that moved. `patch()` sends only the fields the caller
supplied, so two patches to different columns of one row both apply, and a
merge recomputes only the contended columns. Without a `baseVersion`, writes
are last-write-wins per column; the application opts into version checks where
losing intent matters. [Conflicts](/concepts-conflicts/) has the full rules.

The same per-column view extends past conflicts:

- ordinary columns use last-write-wins or explicit `baseVersion` conflicts;
- [CRDT columns](/concepts-crdt/) merge on the server through Yjs and yrs;
- [encrypted columns](/concepts-encryption/) stay ciphertext to the server;
- [blob](/concepts-blobs/) references point to content-addressed objects
  outside the row stream.

A collaborative description field can be a CRDT while the task row around it
stays under scopes, validation, and server order.

## Bootstrap and retention

An ordered log serves incremental sync and debugging. A fresh client needs
current state. Syncular
[bootstraps current authorized rows through content-addressed segments](/concepts-bootstrap/):
row segments are always available, and when the server is configured with an
image builder, a prebuilt SQLite image is attached and copied into the local
database. Segments are resumable, scope-bound, pinned to a commit sequence, and
verified by hash.

Segments travel over HTTP, so operators can keep them in
[S3 or R2, issue signed URLs, and serve them through a CDN](/server-storage/).
On the repository's in-process benchmark, 100,000 six-column rows bootstrap in
379.9 ms through row segments, and in 46.5 ms from a SQLite image the server
has already built (246.6 ms when it builds the image on first request). The
client runs on bun:sqlite in the server's process, so these are best cases; a
deployment adds network and serialization costs.

The host schedules [commit-log pruning](/server-operations/). Active client
cursors hold the horizon back, within retention limits. A client that returns
behind the horizon receives `sync.cursor_expired`, drops its cursor, takes a
fresh scoped snapshot, and resumes incrementally:

```text
incremental log while current
          ↓
cursor falls behind retention
          ↓
fresh scoped bootstrap
          ↓
resume from the snapshot pin
```

## Schema is part of the protocol

Applications write ordinary SQL migrations plus a `syncular.json` manifest.
[Typegen](/guide-schema/) compiles them into a neutral schema IR, row codecs,
scope metadata, subscription helpers, relational server projections, mutation
types, and query APIs for TypeScript, Swift, Kotlin, Dart, and Rust. Both
client cores and the server consume the same generated contract, so runtime
inference never decides the wire format.

[Schema upgrades](/concepts-schema-upgrades/) reuse the bootstrap path. The
client keeps its identity and its schema-independent outbox, resets the synced
tables, bootstraps at the new version, and replays the compatible pending work.
One recovery path, tested once, replaces a local migration engine on every
platform.

## One protocol, two cores

The transport follows Part 1's doorbell pattern with one change: both
transports carry the same rounds. Once connected, push and pull rounds and
ordered deltas travel as framed messages over the WebSocket. When the client is
behind, a delta is too large, or a reset is required, the socket sends a
wake-up and the client runs a full round. `POST /sync` carries the same frames
for debugging, server-to-server integrations, push-only producers, and clients
without a socket. Segments and blobs stay on HTTP, the CDN and object-storage
path. One handler serves both bindings, so recovery follows one code path.

The web core is TypeScript. The native core is Rust, exposed through Swift,
Kotlin, Flutter, Tauri, React Native, and C bindings that marshal calls into
it. Both cores implement the written
[SSP2 protocol](https://github.com/syncular/syncular/blob/main/docs/SPEC.md),
consume the same generated schema contract, and run the same
[conformance scenarios and golden byte vectors](/reference/#protocol--conformance).

The catalog contains 242 scenarios covering convergence, offline replay, lost
acknowledgements, conflicts, scopes, revocation, bootstrap interruption,
blobs, encryption, CRDTs, schema upgrades, realtime, presence, windowing,
validation, and pruning. The repository gate runs it against both cores
alongside the unit and integration tests of each package.

A written protocol removes the implementation language as an explanation. If a
behavior can only be explained by pointing at a TypeScript object, it is not
yet a portable protocol.

## What Syncular does not do

- It is server-authoritative. There is no peer-to-peer mode.
- It targets structured application data; frame-by-frame game state belongs in
  a netcode layer.
- Writes without a `baseVersion` are last-write-wins per column.
- Synced tables have a single-column primary key (`TEXT`, `INTEGER`,
  `BOOLEAN`, or `JSON`) and declare at least one scope.
- Browser persistence requires OPFS; a browser without it is unsupported.
- Scope columns, primary keys, and CRDT columns cannot be encrypted, because
  the server routes by the first two and merges the third.
- Commit pruning and blob garbage collection are operations the host
  schedules.
- It is self-hosted. There is no managed Syncular service.
- Native packaging differs in maturity across ecosystems.

For a decentralized database with no authority, this is the wrong
architecture. If the whole product is one collaborative document, a
document-centered CRDT system is the better foundation. Syncular is for
applications that want local SQL and durable offline work while a server keeps
responsibility for permissions, invariants, and final order.

## Why this shape

I did not set out to invent a consistency model. I wanted to combine the
strongest ideas from Part 1 and keep their boundaries visible.

SQLite is the client store because the row and the intent to upload it must
commit together, and because applications need a relational read model offline.
The server is authoritative because permissions and business invariants need
current information an isolated device cannot have. Commits have durable
identities and outcomes because networks lose acknowledgements and applications
must explain rejected work after a restart.

The server keeps an ordered commit log because a cursor and a sequence are
easier to inspect than an invalidation graph. Scopes make the
partial-replication and authorization unit explicit. Snapshots are in the
protocol because a log alone cannot bound recovery for a fresh or long-absent
client. CRDTs are available per column because collaborative text benefits from
merging while an inventory count or a membership row needs authority. The two
cores share generated schema IR and conformance scenarios so the protocol means
the same thing on every platform.

The resulting guarantees:

- a local write and its outbox entry commit in one transaction;
- retries carry durable identities;
- failed work leaves durable evidence;
- conflicts carry the server row;
- subscriptions state exactly what belongs on the device;
- authorization gates reads and writes;
- partial replicas report when a result is incomplete;
- fresh clients bootstrap current state instead of replaying history;
- two independent implementations show they agree.

If you have debugged a missing row on one device, added a crash-safe outbox to
a read-only sync framework, or found authorization guarding reads while writes
took another path, Syncular was built for that application: structured data
that must keep accepting work when the network disappears, with a relational
server as the final authority.

```sh
bun create syncular-app my-app
```

Then read the [quickstart](/quickstart/), the
[protocol](https://github.com/syncular/syncular/blob/main/docs/SPEC.md), try the
[live demo](/demo/), or read the source on
[GitHub](https://github.com/syncular/syncular). Syncular is Apache-2.0 and
self-hosted.
