---
title: 'Concurrent Edits, Late Deletes, and Declared References in Syncular'
description: A technician and a dispatcher edit the same customer record offline, and one deletes a customer the other still uses. How Syncular handled those cases with a whole-row payload, what a CRDT paper on replicated SQLite does with them, and what changed in the engine as a result.
author: Benjamin Kniffler
publishedAt: '2026-09-16'
---

# Concurrent Edits, Late Deletes, and Declared References in Syncular

A technician corrects the site phone number of customer C-2291 on their phone in a basement with no signal. At the same time, the dispatcher fixes the billing email of the same customer from the office. When the phone reconnects that evening, the server holds one row for C-2291, and it has to contain both corrections.

The dispatcher also removes customer C-1187, a duplicate record. While offline, the technician creates work order W-4410 for that customer. After both devices sync, either the work order exists together with its customer, or the server rejected one of the two writes and the device that made it can show why.

I have been working on how Syncular decides these cases. Until this change, the answer was wrong for both of them in ways that were easy to miss in testing and hard to explain to a user. This post shows what the engine did, what a paper on replicated SQLite does with the same cases, and what changed in Syncular after reading it.

The application schema is the field-service example from the [previous post](/blog/durable-server-work/), reduced to two tables. Both declare the `organization:{organization_id}` scope in the [schema configuration](/guide-schema/). The `REFERENCES` clause on `customer_id` is part of what changed; the first section below describes the engine without it.

```sql
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  site_phone TEXT,
  billing_email TEXT
);

CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
);
```

## How Syncular handled the two cases

A push operation carried the full row. The server stored the pushed bytes as the row and served them back without re-encoding. Every row carried one `server_version`, incremented on each applied write. A client could send a `baseVersion` to say which version it had read; the server compared it against the row's version and rejected the write with `sync.version_conflict` if the row had moved.

For customer C-2291, both devices pushed a full row. Without a `baseVersion`, the second push overwrote the first: the laptop's row carried the `site_phone` value the laptop had read that morning, and the technician's correction disappeared without a trace. With a `baseVersion`, the second push conflicted, because the row's version had moved, even though the two edits touched different columns. The application then had to merge the two rows itself and push again. `patch` existed for edit forms, and it recorded which fields the user had changed in local metadata beside the outbox entry, but the wire still carried the full row, and the server could not tell an edit to `billing_email` from a rewrite of every column.

For customer C-1187, the delete removed the row and left nothing behind. When the technician's offline correction to C-1187 arrived later as a full row without a `baseVersion`, the server found no row and took the insert path. The duplicate customer came back at version 1 with the phone's copy of every column. The dispatcher's delete was lost on both devices, and nothing recorded that it had happened.

For work order W-4410, the migration parser rejected `REFERENCES`, and the server had no notion of a parent row. Whichever order the two writes arrived in, W-4410 was stored with a `customer_id` that opened nothing, and no device was told. An application that wanted the delete to fail while work orders existed wrote a whole-commit validator that scanned `work_orders` by `customer_id` on every customer delete. That validator had to be written once per table pair and repeated in every server the application ran.

Each of these outcomes follows from the same two facts: the payload is the whole row, and the server knows nothing about the relationship between rows. The rest of the design was sound. Pushes to a partition were serialized, commits were atomic, and rejected commits left the client's outbox with a durable record. What was missing was a finer statement of intent in the operation and a finer notion of identity on the server.

## How Synql decides the same cases

[Synql](https://inria.hal.science/hal-04969158v2) is a paper by Claudia-Lavinia Ignat, Victorien Elvinger, and Habibatou Ba (DAIS 2024). It replicates a SQLite database between peers with no server. The implementation installs SQL triggers and views into an ordinary SQLite file, and a merge attaches the other replica's file and runs one SQL script. After two replicas integrate the same set of modifications they hold the same state, and the state preserves the effect of each user's modification even when it collides with a primary key, a unique index, or a foreign key. The [reference implementation](https://github.com/coast-team/synql) is a Python module and a test suite that enumerates the collision cases.

Every replica has an id and a counter, and every row and every write is identified by the pair. Three structures decide the two situations above.

The **per-field log** stores one entry per column write: row identity, column, value, timestamp. The effective value of a column is the entry with the highest timestamp. The technician's `site_phone` write and the dispatcher's `billing_email` write land in different columns, so both are the highest entry for their column and both survive.

The **foreign-key log** stores the identity of the referenced row and the declared `ON DELETE` action; it does not store the referenced value. W-4410's entry points at the row identity of C-1187. Under `RESTRICT`, the merge finds a live child referencing a deleted parent and undoes the parent delete: C-1187 comes back on every replica. Under `CASCADE`, the merge undoes the child: W-4410 disappears. Under `SET NULL`, the child's reference entry is replaced with a null entry.

The **undo counter** on every row and log entry makes a delete an undo of the row's identity. Writes to an undone row have no visible effect. A row returns through an explicit redo, through the `RESTRICT` rule above, and through nothing else. The technician's late correction to C-1187 sits in the log and changes nothing.

Synql gets all three cases right for its setting, and its setting is different from Syncular's in ways that decide what can be borrowed. There is no server, so any two replicas can merge in a basement with no signal. There is no authorization: every replica holds the whole database and every write is accepted. No user's write is ever discarded, because every collision is compensated. The metadata that makes this possible is kept for the life of the database: the log has no compaction, each replica holds a version vector over every replica it has met, and the merge script resolves conflicts with recursive queries over the undo state.

## What a server changes

Syncular serializes every push to a partition before any operation is read, authorized, or written. A commit applies whole or rolls back whole. A rejected commit leaves the client's outbox, and the client rebuilds its local view from the last confirmed server state plus the commits still pending. Those three facts give the server a total order over the two devices' writes, and the total order changes what the right resolution is.

Synql undoes the dispatcher's delete because a peer cannot know about W-4410 until the merge, and by then both writes are committed on their replicas. Syncular sees one of the two writes first. Whichever of the delete and the insert arrives second finds the first already applied, and the server rejects it with a structured reason. The device that made the rejected write receives the rejection in its outcome journal, and the rebuild restores C-1187 on the dispatcher's tablet or removes W-4410 from the technician's phone.

This is a different outcome from Synql's, and the difference is deliberate. Synql keeps both writes: the duplicate customer returns on every replica with a work order attached, and no user is told that a delete was undone. Syncular keeps one write and discards the other with a reason the application can show. For a dispatcher who deleted a duplicate, a customer that reappears the next morning with a work order attached is a defect. For a technician whose work order is rejected, a journal entry naming the missing customer is a task to redo. I would rather have the second conversation than the first.

The same choice repeats for the late correction to C-1187. Synql leaves the correction inert; Syncular rejects it and journals the rejection, so the technician can see that the record they edited had been removed.

For the two column edits on C-2291 the outcomes match: both survive. The mechanism differs, because a server does not need a per-field log to reach that outcome. It needs to know which columns an operation writes, and a version per column to detect a race on the same column. That is the change below.

The other things Synql does with its metadata stay in the paper. Version vectors and replica-labeled row identity exist to let peers merge without a coordinator; the server hub with commit-sequence cursors already converges clients and already prunes history. Undo counters exist to compensate; Syncular rejects. The per-field log keeps every historical value; a version per column keeps the current value and the version that wrote it, and the storage per row stays constant.

## Sparse push payloads

A push operation's payload names the columns it writes. A presence bitmap marks the present columns, a null bitmap covers the present columns, and the values follow in schema order. The primary key is always present. `patch` sends the key and the columns the caller supplied. `mutate` and `insert` send every column.

```ts
// technician's phone
client.patch('customers', 'C-2291', { site_phone: '+49 30 1234567' });

// dispatcher's office laptop
client.patch('customers', 'C-2291', { billing_email: 'billing@example.com' });
```

The server keeps a `column_version` for every stored column: the row's `server_version` at that column's last write. Applying a sparse operation writes the present columns, sets their `column_version` to the new row version, and leaves absent columns unchanged. C-2291 holds both corrections after the evening sync in either arrival order.

<figure>
  <img src="/blog/customer-c2291-columns.svg" width="480" height="920" alt="The technician's phone patches site_phone and the dispatcher's laptop patches billing_email on customer C-2291. With a whole-row payload, the laptop's push carries every column and overwrites the phone's correction. With a sparse payload, each push names only its column, the server writes the present columns with column versions 2 and 3, and both corrections are kept in either order." />
  <figcaption>Customer C-2291 under a whole-row payload and under a sparse payload. The second push decides the outcome in the first design; the presence set decides it in the second. <a href="/blog/customer-c2291-columns.svg">Open the full-size diagram</a>.</figcaption>
</figure>

A `baseVersion` on the operation asserts that the caller read version K of the row. The server compares only the present columns: a conflict fires when a present column has a `column_version` above K, and the conflict record carries `conflictColumns` marking exactly those columns. The technician and the dispatcher can both pass the same `baseVersion` and both apply, because each operation leaves the other's column absent. Two edits to `site_phone` from the same base produce one conflict naming one column, and the resolver recomputes that column against the server row included in the record. Synql has no equivalent of this conflict: the later timestamp wins the column and nobody is told. The application decides whether to pass a `baseVersion` and get the conflict, or omit it and get the later write.

Two rules from the whole-row design disappear with this one. The client kept `changedFields` beside the outbox entry to remember which fields the user touched; the operation's presence set is that record, it reaches the server, and it survives restart in the outcome journal. And a mutation touching only a `crdt` column had to push without a `baseVersion` so that the collaborative edit would never conflict, which also rewrote the row's plain columns with whatever the client had last seen. A crdt-only `patch` presents no comparable column, never conflicts with or without a `baseVersion`, and carries none of the row's other columns.

Every surface after the push keeps full rows. The server re-encodes the merged row once, and commit deliveries, bootstrap segments, SQLite images, and conflict rows use the full-row codec.

## Tombstones

Every applied delete records a tombstone: partition, table, row id, and the commit sequence of the delete. Pruning removes tombstones together with the commit log entries they belong to.

An upsert that finds its row absent consults the tombstone table:

| `baseVersion` | Tombstone inside the horizon | Outcome |
| --- | --- | --- |
| `0` | any | insert; an explicit insert recreates the row |
| `> 0` | any | `sync.row_missing`; the client re-syncs |
| absent | yes | `sync.row_deleted`; the operation is dropped and journaled |
| absent | no | insert when every column is present, otherwise `sync.row_missing` |

The dispatcher deletes C-1187 at 14:10. The technician's phone, still offline, records a phone-number correction to C-1187 at 15:30 and pushes it at 18:00. The server finds no row and a tombstone from 14:10, rejects the patch with `sync.row_deleted`, and the phone's rebuild removes C-1187 from its local database. A `baseVersion` of `0` is the only operation that recreates a deleted row.

<figure>
  <img src="/blog/customer-c1187-tombstone.svg" width="480" height="990" alt="At 14:10 the dispatcher deletes duplicate customer C-1187 and the server records a tombstone at commit 812. At 15:30 the offline technician patches the customer's phone number. At 18:00 the phone pushes; the server finds no row, a tombstone inside the horizon, and no baseVersion, and rejects with sync.row_deleted. The phone's rebuild removes C-1187 locally. Under a whole-row payload the customer would have been recreated at version 1. An insert with baseVersion 0 recreates a row on purpose." />
  <figcaption>Customer C-1187 is deleted at 14:10 and edited offline at 15:30. The tombstone decides the 18:00 push. <a href="/blog/customer-c1187-tombstone.svg">Open the full-size diagram</a>.</figcaption>
</figure>

The tombstone lives as long as the commit that produced it, where Synql's undone identity lives as long as the database. Syncular retains at least the newest 1,000 commits per partition and, by default, every commit an active client still needs for 14 days, with a 30-day force limit. After pruning passes the delete, an unversioned full-row upsert inserts again. A device that stays offline past the horizon has to re-bootstrap before it can push, so the tombstone covers every case in which the device could still deliver the stale edit.

## Declared references

The `customer_id` column in the schema above carries `REFERENCES customers(id) ON DELETE RESTRICT`. `typegen` accepts `REFERENCES parent(pk)` with an optional `ON DELETE RESTRICT`, `CASCADE`, or `SET NULL`. An absent clause means `RESTRICT`. Parent and child tables must declare the same scope patterns, the child column type must equal the parent key type, and `SET NULL` requires a nullable child column. `ON UPDATE` is rejected because primary keys are immutable. `typegen` records the reference in the schema IR and emits an index over the child column so the server reaches children through the index.

The server enforces the reference once per commit, after every client operation is staged and before the whole-commit validator runs. It reads the candidate state the commit would produce, so a commit that deletes a customer and all of its work orders together passes `RESTRICT`.

| Staged operation | Outcome |
| --- | --- |
| Insert or update naming an absent parent | reject `sync.reference_violation`, `reason = missing_parent` |
| Delete a parent with live children, `RESTRICT` | reject `sync.reference_violation`, `reason = restricted_delete` |
| Delete a parent, `CASCADE` | append one delete per child to the same commit, recursively |
| Delete a parent, `SET NULL` | append one update per child clearing the reference |
| Appended operations exceed 1,000 | reject `sync.reference_violation`, `reason = cascade_limit` |

If the dispatcher's delete of C-1187 arrives first, the technician's insert of W-4410 rejects with `missing_parent`, `fieldPaths` naming `customer_id`, and `references` carrying the parent table and row id. If W-4410 arrives first, the dispatcher's delete rejects with `restricted_delete` and `references.child` naming `work_orders`. The application maps those tokens to its own copy on the device that made the rejected write. Under `CASCADE`, the delete carries W-4410 with it, and every subscriber receives the child delete as an ordinary change in the same commit.

<figure>
  <img src="/blog/work-order-w4410-reference.svg" width="480" height="1050" alt="The tablet deletes customer C-1187 while the offline phone inserts work order W-4410 referencing it. If the delete arrives first, the insert rejects with missing_parent and the phone removes W-4410. If the insert arrives first, the delete rejects with restricted_delete and the tablet restores C-1187. Synql undoes the delete on every replica so both writes survive. Under CASCADE the delete appends the child delete to the same commit. Without a declared reference, W-4410 is stored pointing at a deleted customer." />
  <figcaption>Work order W-4410 and the delete of customer C-1187 in both arrival orders, next to Synql's resolution and the CASCADE alternative. <a href="/blog/work-order-w4410-reference.svg">Open the full-size diagram</a>.</figcaption>
</figure>

The local replica's DDL omits the clause. Windowed subscriptions evict parents independently of children, and segment application writes parents before children only as an ordering aid, so a local SQLite that enforced the reference would fail both. The local database can show W-4410 with a missing customer between the offline write and the server's verdict, the same way it shows any optimistic write before acknowledgement.

## What the change costs

For an application, the visible differences are these. `patch` now carries only the columns it names, so two `patch` calls to different columns of one row both apply, and a `baseVersion` conflict names the contended columns instead of the row. `mutate` still carries every column and still behaves as a full-row write; an application that wants disjoint edits to coexist uses `patch`. An unversioned edit to a deleted row is rejected instead of recreating it, and recreating a row on purpose requires `baseVersion: 0`. A partial payload against an absent row with no tombstone is rejected with `sync.row_missing`, because a partial payload names an update and there is no row to update. A `crdt` column is edited with an ordinary `patch`. Parent and child rules move from a whole-commit validator into the migration file, where `typegen` checks them.

The push payload format changed, so clients and servers upgrade together. Nothing after the push changed: commit deliveries, segments, and images carry the same full-row bytes as before.

On the server, every update now decodes the stored row, applies the present columns, and re-encodes. Under the whole-row design the server stored the client's bytes verbatim and never touched them; a `crdt` merge was the one path that re-encoded, and that path now runs for every update. The row store gains one blob per row holding the column versions that differ from the insert version, and a tombstone table that pruning empties along with the commit log. A declared reference costs one index per reference column, one parent lookup per present reference column on insert or update, and one index probe per child table on a parent delete; Postgres and D1 hosts batch these per commit. Cascades are capped at 1,000 appended operations per commit, because an unbounded cascade inside one serialized commit delays every other writer in the partition for its duration. A customer with more work orders than that under `CASCADE` rejects with `cascade_limit`, and the application deletes in batches.

The [bench lane](https://github.com/syncular/syncular/blob/main/bench/RESULTS.md) for the re-encode queues 500 `patch` calls, each writing two of twenty columns, and drains them in one round on the bun:sqlite loopback harness:

| Metric | Whole-row payload | Sparse payload |
| --- | ---: | ---: |
| Request bytes, 500 patches | 123,756 | 57,866 |
| Response bytes | 170,646 | 170,646 |
| Drain time, median | 35.8 ms | 38.1 ms |

Request bytes fall by 53.2 percent and repeat exactly across trials. Response bytes are identical because delivery stays full-row. The drain-time medians differ by 2.3 ms while each side's own spread is about 14 ms, so the re-encode sits inside the lane's noise.

## Where the rules live

Every rule above starts in [SPEC.md](https://github.com/syncular/syncular/blob/main/docs/SPEC.md): the sparse row in §2.4, column versions and tombstones in §2.2 and §6.2, declared references in §6.11. Appendix B scenarios 19 to 21 lock the outcomes in both client cores, and the Rust and TypeScript clients produce byte-identical sparse payloads for the same `patch`. The [RFC](https://github.com/syncular/syncular/blob/main/docs/RFC-WRITE-SEMANTICS.md) records the decision and the alternatives.

The [schema guide](/guide-schema/#declared-references) documents the `REFERENCES` clause. [Conflicts and optimistic writes](/concepts-conflicts/) documents column-granular conflicts, delete precedence, and reference outcomes. The [concurrency and correction guide](/guide-concurrency-correction/) shows how an application chooses a `baseVersion` by intent and presents a rejected reference to the user.
