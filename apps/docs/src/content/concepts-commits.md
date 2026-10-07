# Commits, cursors & idempotency

Every write reaches the server as a **commit**, the atomic unit that applies entirely or not at all. Clients track how far they have caught up with a **cursor**, and retries are safe because a commit is **idempotent**. This page is for developers who need to reason about delivery, retries, and log retention; it follows from [Subscriptions & the outbox](/concepts-subscriptions/).

::meta{for="App developers and server operators" time="8 minutes" first="concepts-subscriptions" spec="2 4 7"}

:::terms
- **Commit**: An atomic group of operations, each an upsert or a delete.
- **`commitSeq`**: The strictly increasing number the server gives each applied commit, per partition.
- **Cursor**: The last `commitSeq` a subscription has fully applied.
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
<div class="node ok"><span class="t">Client A · cursor c8</span>Caught up. Receives c9 next.</div>
<div class="node"><span class="t">Client B · cursor c5</span>Pulls c6 to c8, oldest first.</div>
<div class="node cool"><span class="t">Client C · cursor c2</span>Behind <code>horizonSeq</code> c3. The server answers <code>reset</code>; C bootstraps again.<br><span class="chip cool">Re-bootstrap</span></div>
</div>

::caption[A new client has cursor `-1` and bootstraps ([Bootstrap & segments](/concepts-bootstrap/)).]
:::

## The commit log

Each applied commit gets a `commitSeq`, and every change in the commit shares it ([SPEC §2.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#21-commits-and-the-log)). Your `authenticate()` maps each request to one partition. Partitions are server-internal and never appear on the wire.

Every synced row carries a `server_version`. It starts at 1 and increases by 1 per upsert. It is the optimistic-concurrency token behind [conflict detection](/concepts-conflicts/).

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

## Cursors

A subscription's cursor is the last `commitSeq` it has fully applied. Each pull returns the window after the cursor, filtered to the subscription's [effective scopes](/concepts-scopes/), and reports the new cursor to persist. The cursor advances even when no matching changes exist, which keeps quiet subscriptions cheap ([SPEC §4.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#45-incremental-pull-and-commit-frames)).

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

::caption[An originally rejected commit replays as the same rejection.]
:::

Apply is exactly-once per client commit, and delivery of results is at-least-once. The client outbox can retry after any network failure, and [offline replay](/platform-web-realtime/#offline-replay) is safe.

### What the key covers

The key holds the commit ID and nothing about the operations. Host authentication, request-envelope validation, and the §1.5 clientId-actor binding run before the lookup. `clientId` is a client-supplied namespace inside the authenticated partition and does not prove an authenticated device.

When a retained result exists for the ID, the server returns it and skips `buildOperations`, the commit and write validators, and the apply transaction. A retry that reuses the ID with different operations gets the persisted result, and those operations are never built, validated, or applied. Use a `clientCommitId` for one logical commit only, including after the result has been pruned. A later edit is a later commit with a new ID.

The contract keys on the ID alone. A client with [encrypted columns](/concepts-encryption/) re-encrypts them at every send with a fresh nonce, and a schema upgrade re-encodes pending commits, so the wire payload of an unchanged commit differs between a lost-ack retry and the original send. A payload fingerprint would reject those legitimate retries.

Per-device namespacing and content binding are not implemented. Each needs an input the ID does not carry: an authenticated device identity from the host, or a client-side format that binds the commit content. Neither is specified.

## The pruning horizon

The log does not grow forever. The server maintains a per-partition `horizonSeq`, and commits at or below it may be pruned. A client whose cursor falls behind the horizon receives a `reset` and bootstraps again ([SPEC §4.6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#46-the-pruning-horizon)).

The server prunes delete tombstones at or below `horizonSeq` in the same pass. Retention therefore bounds delete precedence: a delete beats a concurrent unversioned upsert only while its tombstone is inside the horizon. Past it, the ordinary insert rule applies ([Conflicts](/concepts-conflicts/#delete-precedence)).

Operating the horizon (retention floors, when to prune, what to alert on) is covered in [Server setup](/guide-server/) and the [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#horizon--pruning-operational-guidance).
