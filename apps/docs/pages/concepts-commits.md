# Commits, cursors & idempotency

Every server-side write flows through a **commit**: the atomic unit that
either applies entirely or not at all. Clients track how far they have caught
up with a **cursor**, and retries are safe because commits are **idempotent**.
This is the spine of the whole system.

Normative detail: [SPEC.md §2](../../SPEC.md#2-data-model-and-identity) and
[§4](../../SPEC.md#4-subscriptions-cursors-pull).

## The commit log

- Each applied commit gets a **`commitSeq`** — a strictly increasing integer,
  monotonic per partition. All changes in a commit share it
  ([SPEC §2.1](../../SPEC.md#21-commits-and-the-log)).
- A **partition** is your tenant boundary. Your `authenticate()` maps each
  request to exactly one partition; commit logs, cursors, and segments are all
  partition-local. Partitions never appear on the wire.
- Every synced row carries a **`server_version`** (starts at 1, +1 per
  upsert). It is the optimistic-concurrency token behind conflict detection
  ([Conflicts](/concepts-conflicts/)).

## Cursors

A subscription's cursor is the last `commitSeq` it has fully applied. Each
pull returns the window after the cursor, filtered to the subscription's
effective scopes, and reports the new cursor to persist. The cursor advances
even when no matching changes exist — which is what makes quiet subscriptions
cheap ([SPEC §4.5](../../SPEC.md#45-incremental-pull-and-commit-frames)).

`cursor = -1` means "never synced" — the signal to bootstrap
([Bootstrap & segments](/concepts-bootstrap/)).

## Idempotency

Each pushed commit carries a client-chosen `clientCommitId`. The server keys
its result on the triple `(partition, clientId, clientCommitId)` and persists
the outcome before acknowledging
([SPEC §2.3](../../SPEC.md#23-idempotency-identity)). So a retry after a lost
ack is safe:

- an originally-applied commit replays as `cached` ("already applied — you may
  have missed the ack");
- an originally-rejected commit replays as the same rejection.

Exactly-once apply per client commit; at-least-once delivery of results. This
is why the client outbox can retry freely after any network blip — the
[offline replay](/guide-client/) story rests on it.

## The pruning horizon

The log does not grow forever. The server maintains a per-partition
**`horizonSeq`**; commits at or below it may be pruned. A client whose cursor
falls behind the horizon gets a `reset` and re-bootstraps — correct behavior,
not an error ([SPEC §4.6](../../SPEC.md#46-the-pruning-horizon)). Operating
the horizon (retention floors, when to prune, what to alert on) is covered in
[Server setup](/guide-server/) and the
[server README](../../packages/server/README.md#horizon--pruning-operational-guidance).
