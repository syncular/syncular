---
title: 'Start Without a Server, Attach One Later'
description: A Syncular app can ship before its sync backend exists. A local authority runs the server inside the app over a second SQLite file, and attach later uploads its rows to a remote server while the client keeps its replica.
summary: Why a sync client cannot hold authoritative data alone, how an in-process server closes the gap, and how attach moves the data to a remote server.
author: Benjamin Kniffler
publishedAt: '2026-10-29'
---

# Start Without a Server, Attach One Later

Hamukko, a budgeting app built on Syncular, keeps its budgets on one Mac in
version 2 and adds sync between devices in version 3. Without a serverless
mode, version 2 stores its data in plain SQLite and version 3 migrates every
install into Syncular's replica. The
request filed on 2026-10-11 asked for the alternative: run on Syncular from
version 2 and attach a server in version 3 without migrating storage.

Syncular now ships a local authority for this: the Syncular server running in
the app's process over its own SQLite file. The client syncs against it the
same way it syncs against a remote server. When a remote server exists, attach
uploads the authority's rows to it, and the client switches over on the same
replica file. This post covers why the client could not do this alone, the
design that shipped, the attach protocol, and what the conformance lanes found
while it was built.

## The client depends on a server

A Syncular client that never syncs looks like the obvious serverless mode. Four
rules of the client core make it a poor database:

- `mutate` always appends a commit to the outbox, and a row reaches the
  replica's base tables only when a server delivers it (SPEC §7.1). Until
  then the row is an overlay that every reconciliation replays on top of the
  synced rows.
- A schema-version change resets the replica: the client drops every table
  outside `_syncular_*` and bootstraps from the server (SPEC §7.4.3).
- The server enforces declared references (SPEC §6.11). The replica's DDL
  omits them, so deleting a parent never cascades to its children locally.
- No code compacts the outbox, and SPEC §7.1 forbids coalescing a commit
  after it may have been sent.

After a year of serverless use under these rules, the outbox holds every write
the user made, each read reconciliation replays all of it, and the first schema
upgrade has nothing to bootstrap from.

## Five designs I rejected

The [RFC](https://github.com/syncular/syncular/blob/main/docs/RFC-LOCAL-AUTHORITY.md)
weighed five designs before the one that shipped:

- Compact a never-sent outbox. This was the first proposal. Every row stays
  an overlay, a commit that no longer encodes after a schema bump waits for a
  send that never happens, and references still never cascade.
- Apply commits straight to the replica's base tables. The first schema reset
  drops those rows unless the client gains a migration engine, which SPEC §7.4
  rules out, and the client would reimplement the server's conflict (§6.2) and
  reference (§6.11) rules.
- Keep a schema-agnostic row store inside the replica file. It reimplements
  server push semantics in TypeScript beside the reference server.
- Upload from the replica through the client outbox at attach time. Rows
  outside the replica's windows (§4.8) never reach the remote server, and
  until the upload drains, each reconciliation replays every pending seed
  operation: about n²/500 row writes for n rows.
- Import the authority's database file as the remote partition. The client
  avoids a reset, but the device's data bypasses the remote server's
  authorization and validators, and every server storage backend needs an
  import path.

The first three move server behavior into the client, the fourth loses the
rows the replica does not hold, and the fifth skips the remote server's checks.
The shipped design moves the server onto the device.

## A server inside the app

A local authority is the Syncular server running in the client's process over
a second SQLite file beside the replica. The client reaches it through its
ordinary transport seam (`SyncTransport` in TypeScript, `Transport` in Rust).
A commit drains from the outbox, the authority applies it under the reference
rules for conflicts, tombstones, unique indexes, declared references and CRDT
merges, and the pull delivers the row into the base tables. The design adds
no wire frame and no client-core behavior, and the client cannot tell the
authority from a remote server.

In TypeScript the authority is the reference server. `openLocalAuthority` in
`@syncular/server` runs the shipped push and pull handlers over
`SqliteServerStorage`, authenticates every request to one partition and one
actor, and grants every scope value. It runs on Bun, on Node 22.13 or newer,
and in the browser worker over a second OPFS file:

```ts
const authority = await openLocalAuthority({
  database: new BunSqliteDatabase('./data/authority.sqlite'),
  schema,
});

const client = new SyncClient({
  database: openSqliteDatabase('./data/replica.sqlite'),
  schema,
  clientId: 'device-1',
  transport: authority.sync,
  segments: authority.downloadSegment,
});
```

The authority lives in its own file because of the reset rule: a schema reset
drops every replica table outside `_syncular_*`, and the authority's tables
would go with them.

Schema upgrades follow the remote-server path. The app opens both components
with the new generated schema. `openLocalAuthority` migrates its own tables in
place (added tables and appended nullable columns), and the client runs its
ordinary reset and bootstraps from the authority. The authority carries the
data across the upgrade, and the client keeps its rule that it never
transforms local tables.

The native cores (Tauri, Swift, Kotlin, Flutter, React Native and the C FFI)
have no server to embed, so a new Rust crate, `syncular-authority` (4,758
lines with its tests), implements the
authority profile in SPEC §12.2: log epochs, row and column versions,
idempotency records, subscriptions and incremental pull, pruning, bootstrap
with inline rows segments, push with conflicts and atomicity, declared
references, unique indexes, and CRDT merges. Realtime, segment references,
SQLite images, windows, leases, validators, blobs and remote operations are
absent. A client that calls one of them fails as it does against a server
without that feature configured. A native client config that names
`localAuthorityPath` opens the Rust authority, and every binding exposes
`localAuthorityState()`, `attachLocalAuthority()` and
`abandonLocalAuthorityAttach()`.

## Cost

Both authorities were measured with file-backed databases on Apple silicon
Macs; the Rust numbers come from a release build on an M6 with 12 cores. The
write latency covers one `mutate` followed by a sync until the row is
delivered, over 500 writes. The sizes and the bootstrap follow 100,500 rows
written in 700 commits.

| | TypeScript authority (Bun 1.4.4) | Rust authority (Rust 1.99.1) |
|---|---|---|
| Write to delivered row, p50 | 2.05 ms | 1.41 ms |
| Write to delivered row, p95 | 2.97 ms | 1.99 ms |
| Replica file | 11.1 MB | 18.9 MB |
| Authority file | 51.0 MB | 38.9 MB |
| Fresh client bootstrap, 100,500 rows | 161 ms | 340 ms |

The authority file holds a second copy of every row plus the change log, and
it keeps at least 1,000 commits of log (SPEC §4.6), so all 700 commits of the
benchmark were retained. The Rust authority serves bootstrap rows inline and
builds no SQLite images. In the browser, only a worker entry that imports
`openLocalAuthority` bundles the server code, and the authority adds 134.6 KB
minified and 36.3 KB gzipped to a bundle that already holds the client core.
The `authority-bench` binary in `rust/crates/bench` reproduces the Rust
numbers.

## Attach

Attach is the one-time upload of the authority's rows to a remote server (SPEC
§12.3). The app drains the outbox, closes the client's transport gate, and
calls `attach` with a transport for the remote server:

```ts
await client.syncUntilIdle();
client.setTransportEnabled(false);
await authority.attach(
  httpSyncTransport('https://api.example.com/sync', { headers }),
);
```

The authority first persists the `attaching` state and a random `attachId`.
From then on it refuses every client request with `sync.authority_unavailable`,
so its rows cannot change during the upload. It uploads every live row as an
insert (`baseVersion = 0`, every column present), acting as a database-less
producer (SPEC §6.10).

The remote server checks declared references against each commit's candidate
state, so a child row cannot arrive before its parent, and rows that reference
each other in a cycle must arrive in the same commit. The authority builds the
row-level reference graph across all tables, groups each strongly connected
component into one commit with Tarjan's algorithm, and emits the components
parents first, breaking ties by table name and then row ID. Consecutive
components share a commit up to 500 operations. A cycle of more than 500 rows
fails attach with `reason: cycle_too_large` before any upload.

Each commit ID derives from the `attachId` and the commit's ordinal. The
authority is frozen and the order is deterministic, so a restarted attach
rebuilds the same plan and resends byte-equivalent commits, and the remote
server answers the commits it already applied with `cached` (SPEC §2.3). A
crash or a lost response during the upload needs no state beyond the
`attachId`.

A refused commit is final for its attach: the remote server stores the
rejection under the commit's idempotency key and returns it on every retry.
`abandonAttach(transport)` deletes every row the remote server applied from
this attach, children before parents, and the authority serves the client
again. The next attach uses a new `attachId` and recreates the rows over their
tombstones.

When every commit has applied, the authority records `attached` and the app
reopens the client against the remote server over the same replica file. The
remote server's log epoch differs from the authority's, so the first round
takes the existing log-epoch reset (SPEC §2.1): the client discards its synced
rows and cursors, keeps its client ID and outbox, and bootstraps from the
remote server. Writes made during the upload wait in the outbox and push after
the reset. Every attached row starts at version 1 on the remote server, so the
remote server refuses a queued write whose `baseVersion` is above 1; queue only
unversioned writes while attaching. In the browser worker and the native
bindings, `attachLocalAuthority()` runs the whole sequence, including the
switch to the remote server.

Encrypted and CRDT columns need no special handling. The authority stores the
client's ciphertext and uploads it as stored, so neither the authority nor the
remote server holds a key. A `crdt` column uploads its stored state, and the
remote server's `merge(null, state)` stores it unchanged. The Rust benchmark
attached its 100,500 rows to a second Rust authority in 1.03 s.

The authority grants every scope value, and a remote server grants only what
its `resolveScopes` returns. A row whose scope value the remote server denies
stops attach with `sync.forbidden`. Choose scope values the remote server will
grant: generate an owner ID on the device, use it as the scope value, and
register it to the account when the user signs up.

## What the conformance lanes found

The local authority added six scenarios to the conformance catalog (SPEC
Appendix B.24): a local round trip with cascading deletes, a schema bump that
keeps every row, attach with a write queued during the upload, a rejected
attach that rolls back and attaches again, and attach with encrypted columns
and with a CRDT column. Each runs against the TypeScript and the Rust authority
with both client cores. The Rust authority also runs as the server for the
whole catalog: 131 of the catalog's 259 scenarios fall inside the authority profile and
pass with both clients. The harness skips the rest by capability tag, because
they need realtime, narrower scope grants, segment references or SQLite
images.

Four defects surfaced along the way:

- Queued inserts across an appended column were lost on every server. A
  queued insert recorded before a schema bump re-encoded without the new
  column, and the server refused the partial payload for an absent row with
  `sync.row_missing`. SPEC §7.4.4 classified only commits that cannot encode,
  so the insert reached the server and was refused. Both cores now record insert intent at `mutate`
  and fill the missing columns with NULL (SPEC §7.1), and the scenario
  `schema-bump/queued-insert-survives-appended-column` pins it. The schema
  bump scenario for the local authority found it.
- The Rust authority did not record each client's last round outcome
  (SPEC §4.5), which the TypeScript server does. Running the full catalog
  against it found the gap.
- The Rust authority read the system clock and pruned only under fixed
  floors. It now takes a host clock (`open_with_clock`) and host retention
  floors (`prune`), as the TypeScript server does.
- A reopened TypeScript authority that had already attached recreated the 16
  server tables attach had dropped. The Rust authority kept only its state
  table. A Chromium test that runs the browser worker over OPFS through
  reloads, attach, a follower tab and a leader handover found it.

## Out of scope

- Several devices syncing with each other before any server exists.
- Attaching into a partition that already holds data, such as a second
  device's upload. Attach only inserts, so an overlapping row ID fails with
  `sync.version_conflict`, and attach never overwrites remote rows.
- Realtime, blobs, validators and remote operations while the authority serves
  the client.

The [Start without a server](/guide-local-authority/) guide covers the setup
for each platform, the attach error reasons, and rolling back a stopped
attach.
