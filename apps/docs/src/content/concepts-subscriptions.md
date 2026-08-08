# Subscriptions & the outbox

Every client holds two durable registries. **Subscriptions** declare what the
client receives; the **outbox** holds what it sends. A sync round carries
both. The other concept pages use these terms constantly; this page defines
them.

Normative detail: [SPEC.md §4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#4-subscriptions-cursors-pull)
and [§7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#7-offline-writes-and-replay).

## A subscription

```ts
client.subscribe({
  id: 'todos',
  table: 'todos',
  scopes: { list_id: ['groceries'] },
});
```

A subscription is client-defined: a client-chosen `id`, a `table`, the
**requested scopes**, and a per-subscription **cursor** that records how far
this subscription has caught up with the commit log. The server echoes ids
and never interprets them.

Registration is durable and survives restart. Within one client replica, the
tuple `(table, requested scopes, params)` is immutable for a registered id:
re-declaring the same tuple is idempotent and keeps the cursor, bootstrap
state, and effective scopes; reusing the id for a different tuple fails
locally with `client.subscription_intent_mismatch`. A different query needs a
distinct id, or an explicit unsubscribe first.

**Omission is unregistration.** Each steady-state pull carries the client's
complete current subscription list, and that list replaces the persisted one.
A subscription present earlier and absent later is unsubscribed: it stops
receiving deltas and its cursor is forgotten.
[Windowed sync](/concepts-windowing/) is built on exactly this: it maintains
one subscription per window unit (with a deterministic id per unit) and turns
a window change into including or omitting subscriptions.

What one subscription receives:

- With no cursor, a [bootstrap](/concepts-bootstrap/): a snapshot of the
  current scoped rows, delivered as segments.
- With a cursor, the commit-log window above it, filtered to the
  **effective scopes** (requested ∩ allowed; see
  [Scopes](/concepts-scopes/)), oldest first. Deletes propagate as ordinary
  `delete` change records in the same stream.
- If the allowed set loses a requested value, the whole subscription is
  revoked instead of silently narrowed.
- If the cursor fell below the server's
  [pruning horizon](/concepts-commits/), a reset: the subscription
  re-bootstraps from current state.

## The outbox

`mutate` does two things in one local transaction: append the commit to the
outbox under a client-generated `clientCommitId`, and apply it optimistically
to the local tables. The outbox is FIFO: commits push strictly in creation
order, and a commit is never reordered or coalesced once a push containing it
may have reached the server, because the idempotency key pins its content.

Reconciliation is **replay on top**: whenever server data applies (a pull, a
realtime delta, a bootstrap), the client re-applies every still-pending
outbox commit over the fresh server state. Pending writes stay visible
throughout; server rows replace optimistic state exactly when the commit that
produced them has drained or been dropped.

A drained commit ends in one of the durable outcomes:

- **applied**: the server accepted it; `cached` on an idempotent retry.
- **conflict**: a `baseVersion` check failed; the row's server state arrives
  attached ([Conflicts](/concepts-conflicts/)).
- **rejected**: a scope check, validator, or purge refused it, with
  structured recovery metadata.

Outbox entries are stored schema-agnostically and encoded at send time with
the current codec, so pending commits survive a
[schema upgrade](/concepts-schema-upgrades/). A row with a pending write is
pinned against [window eviction](/concepts-windowing/) until the write
drains. Durability is bounded by the local store itself: on the web, OPFS is
best-effort until the origin holds the persistence permission
([Web (browser)](/platform-web/#eviction-resistant-storage)).

## One sync round

A round is one request and one response, over `POST /sync` or the
[realtime socket](/concepts-realtime/); the frames are identical.

The request carries, in order: a header (`clientId`, `schemaVersion`), the
queued outbox commits in creation order, and optionally a pull header
followed by the complete subscription list. The response answers the pushes
with per-commit results, then serves each subscription: bootstrap segments
for fresh ones, `COMMIT` frames (`cursor < commitSeq ≤ maxCommitSeq`, oldest
first, bounded per response and never splitting a commit) for caught-up
ones. The client applies the response in one transaction per block, advances
each subscription's cursor, journals push outcomes, and replays the
remaining outbox on top.

`sync()` runs one round. `syncUntilIdle()` repeats rounds until the outbox
is empty and every subscription has caught up. Connected clients receive
further commits as deltas without asking; the
[host scheduler](/guide-server-clients/) decides when rounds run on a
headless client, and the browser worker owns it with `autoSync`.

## Where to go next

- [Commits, cursors, idempotency](/concepts-commits/): the server side of
  the same story.
- [Bootstrap & segments](/concepts-bootstrap/): what a fresh subscription
  downloads.
- [Windowed sync](/concepts-windowing/): subscription families as partial
  replicas.
- [Conflicts & optimistic writes](/concepts-conflicts/): what happens when a
  push fails.
