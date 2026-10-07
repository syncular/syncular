# Commits, cursors & idempotency

Every server-side write flows through a **commit**: the atomic unit that
either applies entirely or not at all. Clients track how far they have caught
up with a **cursor**, and retries are safe because commits are **idempotent**.

Normative detail: [SPEC.md §2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#2-data-model-and-identity) and
[§4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#4-subscriptions-cursors-pull).

## The commit log

- Each applied commit gets a **`commitSeq`**: a strictly increasing integer,
  monotonic per partition. All changes in a commit share it
  ([SPEC §2.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#21-commits-and-the-log)).
- A **partition** is your tenant boundary. Your `authenticate()` maps each
  request to a single partition; commit logs, cursors, and segments are all
  partition-local. Partitions are server-internal and never appear on the wire.
- Every synced row carries a **`server_version`** (starts at 1, +1 per
  upsert). It is the optimistic-concurrency token behind conflict detection
  ([Conflicts](/concepts-conflicts/)).

## Push payloads

A push operation is an **upsert** or a **delete**. An upsert payload is a
**sparse row**: a presence bitmap names the columns the operation writes, and
the server writes exactly those columns and leaves absent ones unchanged.
`insert` and `mutate` mark every column present; `patch` marks the
primary key plus the columns the caller supplied. The sparse encoding exists on
the push path only: `COMMIT` delivery, rows segments, SQLite images, and a
conflict's `serverRow` all carry full rows
([SPEC §2.4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#24-schema-ir-and-the-generated-row-codec)).

## Push batching

A push request carries a FIFO prefix of whole commits. The client splits at
three configurable budgets: commits per request, operations per request
(default 500), and the encoded request byte size (including headers, framing,
and E2EE ciphertext). It never splits a commit. A later commit that does not
fit defers with the complete suffix; a first commit over the operation or byte
budget fails with `client.push_request_too_large` and stays queued with its
optimistic rows. See
[SPEC §7.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#71-the-outbox).

## Cursors

A subscription's cursor is the last `commitSeq` it has fully applied. Each
pull returns the window after the cursor, filtered to the subscription's
effective scopes, and reports the new cursor to persist. The cursor advances
even when no matching changes exist, which keeps quiet subscriptions
cheap ([SPEC §4.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#45-incremental-pull-and-commit-frames)).

`cursor = -1` means "never synced": the signal to bootstrap
([Bootstrap & segments](/concepts-bootstrap/)).

## Idempotency

Each pushed commit carries a client-chosen `clientCommitId`. The server keys
its result on the triple `(partition, clientId, clientCommitId)` and persists
the outcome before acknowledging
([SPEC §2.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#23-idempotency-identity)). So a retry after a lost
ack is safe:

- an originally-applied commit replays as `cached` ("already applied; you may
  have missed the ack");
- an originally-rejected commit replays as the same rejection.

Exactly-once apply per client commit; at-least-once delivery of results. This
is why the client outbox can retry freely after any network blip, and why
[offline replay](/platform-web/#offline-replay) is safe.

The key contains the commit ID and nothing about the operations. Host
authentication, request-envelope validation, and the §1.5 clientId-actor
binding run before the lookup.
`clientId` is a client-supplied namespace inside the authenticated partition,
not proof of an authenticated device. When a retained result exists for the ID,
the server returns it and skips `buildOperations`, the commit and write
validators, and the apply transaction: a retry that reuses the ID with
different operations gets the persisted result, and those operations are never
built, validated, or applied. Reuse a `clientCommitId` for one logical commit
only, including after the result has been pruned. The ID identifies that commit
permanently, and a later edit is a later commit with a new ID.

The contract keys on the ID alone. A client with
[encrypted columns](/concepts-encryption/) re-encrypts them at every send with
a fresh nonce, and a schema upgrade re-encodes pending commits, so the wire
payload of an unchanged commit differs between a lost-ack retry and the
original send. A payload fingerprint would reject those legitimate retries.

Per-device namespacing and content binding are not implemented. Each needs an
input the ID does not carry: an authenticated device identity from the host, or
a client-side format that binds the commit content. Neither is specified, and
the ID check does not authenticate the client.

## Local constraint failures

The client applies a new local commit to the optimistic read model inside the
same SQLite transaction that appends its outbox entry. A write that conflicts
with a declared secondary unique index throws `sync.constraint_violation`.
The transaction leaves no rows from the commit, no outbox entry, and no local
revision change.

## The pruning horizon

The log does not grow forever. The server maintains a per-partition
**`horizonSeq`**; commits at or below it may be pruned. A client whose cursor
falls behind the horizon gets a `reset` and re-bootstraps; this is the
designed recovery path ([SPEC §4.6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#46-the-pruning-horizon)). The server prunes delete tombstones at or below
`horizonSeq` in the same pass, so retention bounds delete precedence: a delete
beats a concurrent unversioned upsert only while its tombstone is inside the
horizon. Past it, the ordinary insert rule applies. Operating
the horizon (retention floors, when to prune, what to alert on) is covered in
[Server setup](/guide-server/) and the
[server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#horizon--pruning-operational-guidance).
