# Commits, cursors & idempotency

Every write reaches the server as a **commit**, the atomic unit that applies entirely or not at all. Each client tracks how far it has caught up with one **replica cursor**, and retries are safe because a commit is **idempotent**. This page is for developers who need to reason about delivery, retries, and log retention; it follows from [Subscriptions & the outbox](/concepts-subscriptions/).

::meta{for="App developers and server operators" time="8 minutes" first="concepts-subscriptions" spec="2 4 7"}

:::terms
- **Commit**: An atomic group of operations, each an upsert or a delete.
- **`commitSeq`**: The strictly increasing number the server gives each applied commit, per partition.
- **Replica cursor**: The `commitSeq` through which a replica holds every change of every live unit.
- **Partition**: Your tenant boundary. Commit logs, cursors, and segments are partition-local.
- **`clientCommitId`**: The key a client chooses for one commit, used for retries.
- **`horizonSeq`**: The per-partition number at or below which the server may prune commits.
:::

:::figure{title="The commit log and three cursors" note="One partition" ticks}
<div class="d-row">
<div class="node"><span class="t">Pruned</span><span class="chip">c1</span> <span class="chip">c2</span> <span class="chip">c3</span></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Retained log</span><span class="chip">c4</span> <span class="chip">c5</span> <span class="chip">c6</span> <span class="chip">c7</span> <span class="chip amber">c8</span></div>
</div>
<div class="d-cols-3">
<div class="node ok"><span class="t">Client A · replica cursor c8</span>Caught up. Receives c9 next.</div>
<div class="node"><span class="t">Client B · replica cursor c5</span>Pulls c6 to c8, oldest first.</div>
<div class="node cool"><span class="t">Client C · replica cursor c2</span>Behind <code>horizonSeq</code> c3. The server answers <code>reset</code>; C bootstraps again.<br><span class="chip cool">Re-bootstrap</span></div>
</div>

::caption[A new client holds replica cursor `-1` and bootstraps each unit ([Bootstrap & segments](/concepts-bootstrap/)).]
:::

## The commit log

Each applied commit gets a `commitSeq`, and every change in the commit shares it ([SPEC §2.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#21-commits-and-the-log)). Your `authenticate()` maps each request to one partition. Partitions are server-internal and never appear on the wire.

Every synced row carries a `server_version`. An insert starts it one above the partition's **delete floor**: the highest `server_version` recorded by a delete whose row the commit left absent, `0` before the first such delete. Every applied write to an existing row advances it by exactly 1: an upsert, a delete, and a scope move. Pruning never lowers the delete floor. A row id's versions therefore increase strictly across all of its writes and incarnations, and a new row can start above 1 ([SPEC §2.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#22-changes-rows-versions)). `server_version` is the optimistic-concurrency token behind [conflict detection](/concepts-conflicts/).

The client relies on that order. Its **version guard** applies a delivered change only when the change's version exceeds the local row's `server_version`; a change at an equal or lower version is skipped, and a delete of an absent row does nothing. Applying a commit, a segment block, or a delta a second time therefore changes nothing, and the newest state survives in any delivery order. An optimistic row the server never confirmed holds no server version and takes every change.

## Push payloads

A push operation is an **upsert** or a **delete**. An upsert payload is a **sparse row**: a presence bitmap names the columns the operation writes, and the server writes exactly those columns and leaves absent ones unchanged. `insert` and `mutate` mark every column present. `patch` marks the primary key plus the columns the caller supplied.

The sparse encoding exists on the push path only. `COMMIT` delivery, rows segments, SQLite images, and a conflict's `serverRow` carry full rows ([SPEC §2.4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#24-schema-ir-and-the-generated-row-codec)).

## Push batching

A push request carries a first-in-first-out prefix of whole commits. The client splits at three configurable budgets: commits per request, operations per request (default 500), and the encoded request size in bytes, which includes headers, framing, and E2EE ciphertext. The client never splits a commit.

| Case | Outcome |
|---|---|
| A later commit does not fit the budget | It defers, with every commit after it, to the next round. |
| The first commit exceeds the operation or byte budget | It fails with `client.push_request_too_large` and stays queued with its optimistic rows. |
| One commit exceeds the server's operation cap | It fails with `sync.too_many_operations`; the client keeps it atomic. |

Retries keep the original commit IDs and order ([SPEC §7.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#71-the-outbox)).

## The replica cursor

A replica holds one cursor for all of its live units. Each pull carries it, and the server answers with one live section: every commit above the cursor that carries a change matching the [effective scopes](/concepts-scopes/) of a live unit, oldest first, one `COMMIT` frame per commit with the matching changes of every table. The response's `throughSeq` becomes the new replica cursor. It advances even when no change matched, so a quiet replica's pull carries no unit and its answer no commit ([SPEC §4.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#45-the-replica-cursor-and-the-live-section)).

A new unit catches up first: it bootstraps, then holds its own cursor until a live section brings it level with the replica cursor, and then joins the live set. A unit that is still catching up never holds the replica cursor back.

## Idempotency

Each pushed commit carries a `clientCommitId`. The server keys its result on `(partition, clientId, clientCommitId)` and persists the outcome before it acknowledges ([SPEC §2.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#23-idempotency-identity)).

:::figure{title="A retry after a lost acknowledgement"}
<div class="d-row">
<div class="node hot"><span class="t">1 · Client</span>Pushes commit <span class="chip">k1</span></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">2 · Server</span>Applies it, stores the outcome under k1</div>
<span class="d-arrow"></span>
<div class="node bad"><span class="t">3 · Network</span>The ack is lost</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">4 · Client retries k1</span>Server returns the stored outcome<br><span class="chip">cached</span></div>
</div>

::caption[A rejected commit replays as the same rejection while its conflict row remains authorized.]
:::

Apply is exactly-once per client commit, and delivery of results is at-least-once. The client outbox can retry after any network failure, and [offline replay](/platform-web-realtime/#offline-replay) is safe.

### What the key covers

The key holds the commit ID and nothing about the operations. Host authentication, request-envelope validation, and the §1.5 clientId-actor binding run before the lookup. `clientId` is a client-supplied namespace inside the authenticated partition and does not prove an authenticated device.

When a retained result exists for the ID, the server returns it and skips `buildOperations`, the commit and write validators, and the apply transaction. A retry that reuses the ID with different operations gets the persisted result, and those operations are never built, validated, or applied. Use a `clientCommitId` for one logical commit only, including after the server deleted its result. A later edit is a later commit with a new ID.

The contract keys on the ID alone. A client with [encrypted columns](/concepts-encryption/) re-encrypts them at every send with a fresh nonce, and a schema upgrade re-encodes pending commits, so the wire payload of an unchanged commit differs between a lost-ack retry and the original send. A payload fingerprint would reject those legitimate retries.

### How long a result lives

A replica numbers its outbox commits with a sequence under a random outbox id and sends both with every push. The first sequence of a request proves that every older commit of that outbox has left the outbox for good, so the server raises the outbox's **watermark** to it and deletes the stored results below it ([SPEC §6.3.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#632-per-outbox-acknowledged-watermark)). A lost-ack retry carries a commit that is still in the outbox, so its result is still stored. A commit below the watermark without a stored result receives `sync.commit_expired`, and the client records it as a rejection. That happens for a delayed copy of an abandoned request and for a copied or restored replica, which shares the outbox id and sequence with its original. Give a restored or copied replica a fresh local database. A database-less producer and an attach upload send no outbox id, so their results stay until the partition is reset.

Per-device namespacing and content binding are not implemented. Each needs an input the ID does not carry: an authenticated device identity from the host, or a client-side format that binds the commit content. Neither is specified.

## The pruning horizon

The log does not grow forever. The server maintains a per-partition `horizonSeq`, and commits at or below it may be pruned. A replica whose cursor falls behind the horizon receives a `reset` and bootstraps every live unit again ([SPEC §4.6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#46-the-pruning-horizon)).

The server prunes delete tombstones at or below `horizonSeq` in the same pass. Retention therefore bounds delete precedence: a delete beats a concurrent unversioned upsert only while its tombstone is inside the horizon. Past it, the ordinary insert rule applies ([Conflicts](/concepts-conflicts/#delete-precedence)).

Operating the horizon (retention floors, when to prune, what to alert on) is covered in [Server setup](/guide-server/) and the [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#horizon--pruning-operational-guidance).
