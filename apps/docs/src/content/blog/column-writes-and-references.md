---
title: 'Concurrent Edits, Late Deletes, and Declared References in Syncular'
description: A technician and a dispatcher edit the same customer record offline, and one deletes a customer the other still uses. How Syncular decides those cases with sparse payloads, tombstones, and declared references, and what a CRDT paper on replicated SQLite does with them.
summary: Two offline edits to one customer and a delete that races a new work order, decided by sparse payloads, tombstones, and declared references.
author: Benjamin Kniffler
publishedAt: '2026-09-16'
---

# Concurrent Edits, Late Deletes, and Declared References in Syncular

A technician corrects the site phone number of customer C-2291 on their phone
in a basement with no signal. At the same time the dispatcher fixes the billing
email of the same customer from the office. When the phone reconnects that
evening, the server holds one row for C-2291, and it must contain both
corrections.

The dispatcher also removes customer C-1187, a duplicate record. While offline,
the technician creates work order W-4410 for that customer. After both devices
sync, either the work order exists together with its customer, or the server
rejected one of the two writes and the device that made it can show why.

This post shows how Syncular decides these cases, what a paper on replicated
SQLite does with the same cases, and why the two answers differ. The schema is
the field-service example from the
[durable server work post](/blog/durable-server-work/), reduced to two tables.
Both declare the `organization:{organization_id}` scope in the
[schema configuration](/guide-schema/).

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

## Where a whole-row payload fails

The simplest sync design pushes the full row, keeps one version per row, and
deletes rows without a trace. Each of the three cases goes wrong under it.

**Two edits to C-2291.** Each device pushes its full row. Without a version
check, the second push overwrites the first: the laptop's row carries the
`site_phone` value the laptop read that morning, and the technician's
correction disappears without a record. With a version check on the row, the
second push conflicts, because the row's version moved, even though the two
edits touched different columns. The application then merges two rows by hand
and pushes again.

**A late edit to C-1187.** The delete removes the row and leaves nothing
behind. When the technician's offline correction arrives as a full row, the
server finds no row and inserts it. The duplicate customer returns with the
phone's copy of every column, and the dispatcher's delete is lost on both
devices.

**W-4410 against a deleted customer.** If the server knows nothing about the
relationship between rows, W-4410 is stored with a `customer_id` that points at
nothing, in either arrival order, and no device is told. An application that
wants the delete to fail while work orders exist writes a whole-commit
validator that scans `work_orders` by `customer_id` on every customer delete,
once per table pair.

All three outcomes follow from two facts: the payload is the whole row, and the
server knows nothing about the relationships between rows. Serialized pushes,
atomic commits, and durable rejection records cannot help; the operation needs
a finer statement of intent and the server a finer notion of identity.

## How Synql decides the same cases

[Synql](https://inria.hal.science/hal-04969158v2) is a paper by
Claudia-Lavinia Ignat, Victorien Elvinger, and Habibatou Ba (DAIS 2024). It
replicates a SQLite database between peers with no server. The implementation
installs SQL triggers and views into an ordinary SQLite file, and a merge
attaches the other replica's file and runs one SQL script. Two replicas that
integrate the same modifications hold the same state, and that state preserves
the effect of each user's modification even when it collides with a primary
key, a unique index, or a foreign key. The
[reference implementation](https://github.com/coast-team/synql) is a Python
module and a test suite that enumerates the collision cases.

Every replica has an id and a counter, and the pair identifies every row and
every write. Three structures decide the cases above.

The **per-field log** stores one entry per column write: row identity, column,
value, timestamp. A column's effective value is the entry with the highest
timestamp. The technician's `site_phone` write and the dispatcher's
`billing_email` write land in different columns, so each is the highest entry
for its column and both survive.

The **foreign-key log** stores the identity of the referenced row and the
declared `ON DELETE` action. W-4410's entry points at the row identity of
C-1187. Under `RESTRICT`, the merge finds a live child referencing a deleted
parent and undoes the parent delete: C-1187 returns on every replica. Under
`CASCADE`, the merge undoes the child and W-4410 disappears. Under `SET NULL`,
the child's reference entry is replaced with a null entry.

The **undo counter** on every row and log entry turns a delete into an undo of
the row's identity. Writes to an undone row have no visible effect. A row
returns through an explicit redo or through the `RESTRICT` rule above. The
technician's late correction to C-1187 sits in the log and changes nothing.

Synql decides all three cases correctly for its setting, and its setting
differs from Syncular's in ways that decide what can be borrowed. There is no
server, so any two replicas can merge in a basement with no signal. There is no
authorization: every replica holds the whole database and every write is
accepted. No write is ever discarded, because every collision is compensated.
The metadata behind this lives for the life of the database: the log is never
compacted, each replica keeps a version vector over every replica it has met,
and the merge script resolves conflicts with recursive queries over the undo
state.

## What a server changes

Syncular serializes every push to a partition before any operation is read,
authorized, or written. A commit applies whole or rolls back whole. A rejected
commit leaves the client's outbox, and the client rebuilds its local view from
the last confirmed server state plus the commits still pending. Together these
give the server a total order over the two devices' writes, and the total order
changes the right resolution.

Synql undoes the dispatcher's delete because a peer cannot know about W-4410
until the merge, and by then both writes are committed on their replicas.
Syncular's server sees one of the two writes first. The second one finds the
first already applied, and the server rejects it with a structured reason. The
device that made the rejected write receives it in its outcome journal, and its
rebuild restores C-1187 on the dispatcher's tablet or removes W-4410 from the
technician's phone.

Synql keeps both writes: the duplicate customer returns on every replica with a
work order attached, and no user learns that a delete was undone. Syncular
keeps one write and returns the other with a reason the application can show.
For a dispatcher who deleted a duplicate, a customer that reappears the next
morning with a work order attached is a defect. For a technician whose work
order is rejected, a journal entry naming the missing customer is a task to
redo. I prefer the second conversation.

The late correction to C-1187 follows the same choice. Synql leaves it inert;
Syncular rejects it and journals the rejection, so the technician sees that the
record they edited had been removed.

For the two column edits on C-2291 the outcomes match: both survive. The
mechanism differs. A server needs no per-field log to reach that outcome; it
needs to know which columns an operation writes, and a version per column to
detect a race on the same column.

The rest of Synql's metadata stays in the paper. Version vectors and
replica-labeled row identity let peers merge without a coordinator; a server
hub with commit-sequence cursors already converges clients and prunes history.
Undo counters compensate, and Syncular rejects instead. The per-field log keeps
every historical value; a version per column keeps the current value and the
version that wrote it, so storage per row stays constant.

## Sparse push payloads

A push operation's payload names the columns it writes. A presence bitmap marks
the present columns, a null bitmap covers them, and the values follow in schema
order. The primary key is always present. `patch` sends the key and the columns
the caller supplied; `mutate` and `insert` send every column.

```ts
// technician's phone
client.patch('customers', 'C-2291', { site_phone: '+49 30 1234567' });

// dispatcher's office laptop
client.patch('customers', 'C-2291', { billing_email: 'billing@example.com' });
```

The server keeps a `column_version` for every stored column: the row's
`server_version` at that column's last write. Applying a sparse operation writes
the present columns, sets their `column_version` to the new row version, and
leaves absent columns unchanged. C-2291 holds both corrections after the evening
sync, in either arrival order.

<figure>
  <img src="/blog/customer-c2291-columns.svg" width="480" height="920" alt="The technician's phone patches site_phone and the dispatcher's laptop patches billing_email on customer C-2291. With a whole-row payload, the laptop's push carries every column and overwrites the phone's correction. With a sparse payload, each push names only its column, the server writes the present columns with column versions 2 and 3, and both corrections are kept in either order." />
  <figcaption>Customer C-2291 under a whole-row payload and under a sparse payload. With full rows the second push decides the outcome; with sparse payloads the presence set does. <a href="/blog/customer-c2291-columns.svg">Open the full-size diagram</a>.</figcaption>
</figure>

A `baseVersion` on the operation asserts that the caller read version K of the
row. The server compares only the present columns: a conflict fires when a
present column has a `column_version` above K, and the conflict record's
`conflictColumns` marks exactly those columns. The technician and the
dispatcher can both pass the same `baseVersion` and both apply, because each
operation leaves the other's column absent. Two edits to `site_phone` from the
same base produce one conflict naming one column, and the resolver recomputes
that column against the server row in the record. Synql has no equivalent: the
later timestamp wins the column and nobody is told. The application chooses per
write whether to pass a `baseVersion` and get the conflict, or omit it and take
the later write.

The presence set is also the record of which fields the user touched. It
reaches the server and survives a restart in the outcome journal, so no side
table beside the outbox has to remember it. A `patch` that touches only a
`crdt` column presents no comparable column, never conflicts with or without a
`baseVersion`, and carries none of the row's other columns.

Every surface after the push keeps full rows. The server re-encodes the merged
row once, and commit deliveries, bootstrap segments, SQLite images, and conflict
rows use the full-row codec.

## Tombstones

Every applied delete records a tombstone: partition, table, row id, and the
commit sequence of the delete. Pruning removes tombstones together with the
commit log entries they belong to.

An upsert that finds its row absent consults the tombstone table:

| `baseVersion` | Tombstone inside the horizon | Outcome |
| --- | --- | --- |
| `0` | any | insert; an explicit insert recreates the row |
| `> 0` | any | `sync.row_missing`; the client re-syncs |
| absent | yes | `sync.row_deleted`; the operation is dropped and journaled |
| absent | no | insert when every column is present, otherwise `sync.row_missing` |

The dispatcher deletes C-1187 at 14:10. The technician's phone, still offline,
records a phone-number correction to C-1187 at 15:30 and pushes it at 18:00. The
server finds no row and a tombstone from 14:10, rejects the patch with
`sync.row_deleted`, and the phone's rebuild removes C-1187 from its local
database. Only a `baseVersion` of `0` recreates a deleted row.

<figure>
  <img src="/blog/customer-c1187-tombstone.svg" width="480" height="990" alt="At 14:10 the dispatcher deletes duplicate customer C-1187 and the server records a tombstone at commit 812. At 15:30 the offline technician patches the customer's phone number. At 18:00 the phone pushes; the server finds no row, a tombstone inside the horizon, and no baseVersion, and rejects with sync.row_deleted. The phone's rebuild removes C-1187 locally. Under a whole-row payload the customer would have been recreated at version 1. An insert with baseVersion 0 recreates a row on purpose." />
  <figcaption>Customer C-1187 is deleted at 14:10 and edited offline at 15:30. The tombstone decides the 18:00 push. <a href="/blog/customer-c1187-tombstone.svg">Open the full-size diagram</a>.</figcaption>
</figure>

A tombstone lives as long as the commit that produced it; Synql's undone
identity lives as long as the database. Syncular retains at least the newest
1,000 commits per partition and, by default, every commit an active client
still needs for 14 days, with a 30-day force limit. Once pruning passes the
delete, an unversioned full-row upsert inserts again. A device that stays
offline past the horizon must re-bootstrap before it can push, so the tombstone
covers every case in which a device could still deliver the stale edit.

## Declared references

The `customer_id` column in the schema above carries
`REFERENCES customers(id) ON DELETE RESTRICT`. Typegen accepts
`REFERENCES parent(pk)` with an optional `ON DELETE RESTRICT`, `CASCADE`, or
`SET NULL`; an absent clause means `RESTRICT`. Parent and child tables must
declare the same scope patterns, the child column type must equal the parent key
type, and `SET NULL` needs a nullable child column. `ON UPDATE` is rejected
because primary keys are immutable. Typegen records the reference in the schema
IR and emits an index over the child column, so the server reaches children
through the index.

The server enforces the reference once per commit, after every client operation
is staged and before the whole-commit validator runs. It reads the candidate
state the commit would produce, so a commit that deletes a customer together
with all of its work orders passes `RESTRICT`.

| Staged operation | Outcome |
| --- | --- |
| Insert or update naming an absent parent | reject `sync.reference_violation`, `reason = missing_parent` |
| Delete a parent with live children, `RESTRICT` | reject `sync.reference_violation`, `reason = restricted_delete` |
| Delete a parent, `CASCADE` | append one delete per child to the same commit, recursively |
| Delete a parent, `SET NULL` | append one update per child clearing the reference |
| Appended operations exceed 1,000 | reject `sync.reference_violation`, `reason = cascade_limit` |

If the dispatcher's delete of C-1187 arrives first, the technician's insert of
W-4410 rejects with `missing_parent`, with `fieldPaths` naming `customer_id` and
`references` carrying the parent table and row id. If W-4410 arrives first, the
dispatcher's delete rejects with `restricted_delete` and `references.child`
naming `work_orders`. The application maps those tokens to its own wording on
the device that made the rejected write. Under `CASCADE`, the delete takes
W-4410 with it, and every subscriber receives the child delete as an ordinary
change in the same commit.

<figure>
  <img src="/blog/work-order-w4410-reference.svg" width="480" height="1050" alt="The tablet deletes customer C-1187 while the offline phone inserts work order W-4410 referencing it. If the delete arrives first, the insert rejects with missing_parent and the phone removes W-4410. If the insert arrives first, the delete rejects with restricted_delete and the tablet restores C-1187. Synql undoes the delete on every replica so both writes survive. Under CASCADE the delete appends the child delete to the same commit. Without a declared reference, W-4410 is stored pointing at a deleted customer." />
  <figcaption>Work order W-4410 and the delete of customer C-1187 in both arrival orders, beside Synql's resolution and the CASCADE alternative. <a href="/blog/work-order-w4410-reference.svg">Open the full-size diagram</a>.</figcaption>
</figure>

The local replica's DDL omits the clause. Windowed subscriptions evict parents
independently of children, and segment application writes parents before
children only as an ordering aid, so a local SQLite that enforced the reference
would fail both. The local database can show W-4410 with a missing customer
between the offline write and the server's verdict, as it shows any optimistic
write before acknowledgement.

## What it costs

For an application, the rules come down to these:

- `patch` carries only the columns it names, so two patches to different
  columns of one row both apply, and a `baseVersion` conflict names the
  contended columns.
- `mutate` carries every column and behaves as a full-row write; use `patch`
  when disjoint edits must coexist.
- An unversioned edit to a deleted row is rejected. Recreating a row on
  purpose takes `baseVersion: 0`.
- A partial payload against an absent row with no tombstone is rejected with
  `sync.row_missing`: it names an update, and there is no row to update.
- A `crdt` column is edited with an ordinary `patch`.
- Parent and child rules live in the migration file, where typegen checks
  them.

On the server, every update decodes the stored row, applies the present
columns, and re-encodes it. A full-row design could store the client's bytes
verbatim; sparse payloads trade that for the column-level outcomes above. The
row store keeps one blob per row with the column versions that differ from the
insert version, plus a tombstone table that pruning empties along with the
commit log. A declared reference costs one index per reference column, one
parent lookup per present reference column on insert or update, and one index
probe per child table on a parent delete; Postgres and D1 hosts batch these per
commit. Cascades stop at 1,000 appended operations per commit, because an
unbounded cascade inside one serialized commit delays every other writer in the
partition. A customer with more work orders than that under `CASCADE` rejects
with `cascade_limit`, and the application deletes in batches.

The [patch bench lane](https://github.com/syncular/syncular/blob/main/bench/RESULTS.md)
queues 500 `patch` calls, each writing two of twenty columns, and drains them
in one round on the bun:sqlite loopback harness. It also measures the same
patches sent as full rows:

| Metric | Full-row payload | Sparse payload |
| --- | ---: | ---: |
| Request bytes, 500 patches | 123,756 | 57,866 |
| Response bytes | 170,646 | 170,646 |
| Drain time, median | 35.8 ms | 38.1 ms |

Sparse requests are 53.2 percent smaller, and the byte counts repeat exactly
across trials. Response bytes are identical because delivery stays full-row.
The drain-time medians differ by 2.3 ms while each side's own spread is about
14 ms, so the re-encode stays within the lane's noise.

## Where the rules live

Every rule above starts in
[SPEC.md](https://github.com/syncular/syncular/blob/main/docs/SPEC.md): the
sparse row in §2.4, column versions and tombstones in §2.2 and §6.2, declared
references in §6.11. Appendix B scenarios 19 to 21 lock the outcomes in both
client cores, and the Rust and TypeScript clients produce byte-identical sparse
payloads for the same `patch`. The
[RFC](https://github.com/syncular/syncular/blob/main/docs/RFC-WRITE-SEMANTICS.md)
records the decision and the alternatives.

The [schema guide](/guide-schema/#declared-references) documents the
`REFERENCES` clause. [Conflicts and optimistic writes](/concepts-conflicts/)
documents column-granular conflicts, delete precedence, and reference outcomes.
The [concurrency and correction guide](/guide-concurrency-correction/) shows
how an application chooses a `baseVersion` by intent and presents a rejected
reference to the user.
