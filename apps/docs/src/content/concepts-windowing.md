# Windowed sync

Most sync engines are all-or-nothing: a client holds every row it is
authorized for, forever. **Windowed sync** lets a client hold a **partial
local replica** — the hot projects, the last few months — while the server
keeps everything, with correct sync semantics throughout. It is syncular's
post-parity differentiator: the competitors either tombstone cold rows
forever, re-download the world on any change, or serve queries from a replica
they can't prove complete.

Normative detail: [SPEC.md §4.8](https://github.com/syncular/syncular/blob/main/SPEC.md#48-windowed-subscriptions).
The design record is
[DESIGN-eviction.md](https://github.com/syncular/syncular/blob/main/DESIGN-eviction.md) (W1 landed 2026-07-04).

## A window is a set of scope values

You already scope your tables ([Scopes](/concepts-scopes/)). A **window**
reuses that machinery: it is the set of scope **values** a client currently
holds locally. Subscribe to `project:{A,B}` now, `{B,C}` later; or to time
buckets `bucket:{2026-05, 2026-06, 2026-07}` and slide them. The **window
unit** — the atom of eviction and re-entry — is one scope value.

There is no second mechanism. Windowing is dynamic scope-set change, done
right: the scope column is already the authorization boundary, the fanout
index, and the segment cache key, so windowing by it costs nothing new on the
wire and **nothing on the server** — zero new frames, fields, codes, or server
behavior.

## Changing the window is a set difference

A window change is never a mutation of a subscription; it is a set difference
on a **family** of subscriptions, one per live unit:

- **Widen** `{A,B} → {A,B,C}`: `C` gets a fresh subscription and
  [bootstraps](/concepts-bootstrap/) via the image lane. `A` and `B` are
  untouched — their cursors stay honest.
- **Shrink** `{A,B,C} → {B,C}`: `A`'s subscription is dropped and its rows are
  **evicted** from the local database, fused into one atomic step with the
  unsubscription.
- **Replace** `{A,B} → {B,C}` is shrink + widen. Because units are
  value-sharded, `B` is **not** re-downloaded — the cost of a window change is
  proportional to the *delta*, not the window size. (The bench proves it on a
  segment counter: `{A,B}→{B,C}` re-applies one project's rows, not three.)

Because a window unit maps to a subscription, apps trade subscription count
against re-entry granularity by choosing the unit: per-project is exact,
per-month-bucket is exact, one subscription for a 500-value set re-bootstraps
the whole set on any change. Value-sharding is comfortable to a few hundred
units; beyond that, group values into coarser units.

## Eviction is not revocation

Eviction is a **voluntary** local delete — your retention policy, not the
server's authorization decision. The server is never told and tombstones
nothing; the rows still live server-side, and re-entering the window
re-delivers them. This is distinct from a
[scope revocation](/concepts-scopes/) purge, which is forced by lost
authorization. A few rules make it correct:

- **Outbox pin**: a row with a pending offline write is *not* evicted until
  that write drains — replaying it would otherwise resurrect an orphan.
- **Version state dies with the row**: a re-entered row's optimistic-write
  version comes only from its re-delivery, so there is no stale version cache.
- **Re-entry is a fresh bootstrap**: correct at any distance — it snapshots
  current server state, so it doesn't care how much log was pruned since the
  eviction. A re-entered row is writable immediately.

## The completeness oracle

The window registry doubles as an **honesty oracle**. A local query is
answerable in full only if every scope value it touches is windowed-in; if
not, the result is **partial** and the API says so — never silently returning
a partial replica as complete (the one thing we know from competitors doesn't
happen).

## Using it

Both the web client and the native (Rust) client expose the same surface:

```ts
// Hold p1 and p2 locally; drop p3 if it was held.
await client.setWindow({ table: 'tasks', variable: 'project_id' }, ['p1', 'p2']);

// The registry — which units are held in full (the oracle).
const { units } = client.windowState({ table: 'tasks', variable: 'project_id' });
```

In React, `useWindow` manages the set and exposes the verdict:

```tsx
const { units, setWindow, isComplete } = useWindow({
  table: 'tasks',
  variable: 'project_id',
});

// Render "showing local data" vs "widen to see everything" honestly.
if (!isComplete(activeProject)) {
  // this project is a window miss — widen, or flag the result partial
}
```

## What's next

- **W2 — TTL sugar**: codegen emits creation-time bucket scope columns plus a
  sliding-window helper (`window: { bucket: last(3, 'month') }`) — pure
  client/codegen sugar over W1.
- **Blob retention on eviction**: cached blob bodies are refcounted by
  referencing rows; eviction releases refs (LRU-retained, not deleted —
  evicted ≠ revoked), landing with the blob work.
