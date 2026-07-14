# Windowed sync

Most sync engines are all-or-nothing: a client holds every row it is
authorized for, forever. **Windowed sync** lets a client hold a **partial
local replica** (the hot projects, the last few months) while the server
keeps everything, with correct sync semantics throughout. It is syncular's
post-parity differentiator, solving three problems at once: cold rows that
pile up as permanent tombstones, full re-downloads triggered by any change,
and queries served from a replica with no way to prove it complete.

Normative detail: [SPEC.md §4.8](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#48-windowed-subscriptions).
The design record is
[DESIGN-eviction.md](https://github.com/syncular/syncular/blob/main/docs/DESIGN-eviction.md) (W1 landed 2026-07-04).

## A window is a set of scope values

You already scope your tables ([Scopes](/concepts-scopes/)). A **window**
reuses that machinery: it is the set of scope **values** a client currently
holds locally. Subscribe to `project:{A,B}` now, `{B,C}` later; or to time
buckets `bucket:{2026-05, 2026-06, 2026-07}` and slide them. The **window
unit** (the atom of eviction and re-entry) is one scope value.

Windowing is the one mechanism: dynamic scope-set change. The scope column is
already the authorization boundary, the fanout index, and the segment cache
key, so windowing by it costs nothing new on the wire. The server side is
unchanged: windowing reuses the existing frames, fields, and codes.

## Changing the window is a set difference

A window change is a set difference on a **family** of subscriptions, one per
live unit:

- **Widen** `{A,B} → {A,B,C}`: `C` gets a fresh subscription and
  [bootstraps](/concepts-bootstrap/) via the image lane. `A` and `B` stay
  untouched, and their cursors remain valid.
- **Shrink** `{A,B,C} → {B,C}`: `A`'s subscription is dropped and its rows are
  **evicted** from the local database, fused into one atomic step with the
  unsubscription.
- **Replace** `{A,B} → {B,C}` is shrink + widen. Because units are
  value-sharded, `B` stays cached: the cost of a window change scales with the
  size of the *delta*. (The bench proves it on a segment counter:
  `{A,B}→{B,C}` re-applies only the one project's rows that changed.)

Because a window unit maps to a subscription, apps trade subscription count
against re-entry granularity by choosing the unit: per-project is exact,
per-month-bucket is exact, one subscription for a 500-value set re-bootstraps
the whole set on any change. Value-sharding is comfortable to a few hundred
units; beyond that, group values into coarser units.

## Eviction is a local storage decision

Eviction is a **voluntary** local delete, driven by your retention policy.
The server retains the evicted rows and creates no tombstones; re-entering
the window re-delivers them. A [scope revocation](/concepts-scopes/) purge
works differently: it is forced by lost authorization. A few rules make
eviction correct:

- **Outbox pin**: a row with a pending offline write stays local until that
  write drains, since replaying it would otherwise resurrect an orphan.
- **Version state dies with the row**: a re-entered row's optimistic-write
  version comes only from its re-delivery, so there is no stale version cache.
- **Re-entry is a fresh bootstrap**: correct at any distance. It snapshots
  current server state, so it doesn't care how much log was pruned since the
  eviction. A re-entered row is writable immediately.

## The completeness oracle

The window registry doubles as a **completeness oracle**. A local query is
answerable in full only if every scope value it touches is windowed-in
**and bootstrapped**: registration alone is not completeness. Between
`setWindow` and a unit's bootstrap landing, the unit is **pending** — its
local replica may be empty or partial, and the oracle says so instead of
letting the app render a false "empty" state on a list switch. A unit with
zero server rows still becomes complete once its bootstrap round finishes
(an empty replica is a truthful one). If a query touches a windowed-out or
pending unit, the result is **partial**, and the API reports that state
explicitly: the engine never reports a partial replica as complete.

## Using it

For named queries, typegen normally owns this plumbing. A predicate such as
`WHERE project_id = :projectId` is proven against the schema and emitted as
query coverage. `useQuery` claims that unit and reads rows, completeness, and
the exact local revision in one SQLite snapshot:

```tsx
const tasks = useQuery(listProjectTasksQuery, { projectId });

if (tasks.phase === 'loading') return <Skeleton />;
if (tasks.phase === 'ready' && tasks.rows.length === 0) return <Empty />;
return <Rows rows={tasks.rows} partial={tasks.phase === 'partial'} />;
```

That distinction makes a zero-row bootstrap safe: `[]` is not a complete empty
answer until the same snapshot says the unit has finished. There is no
render-order dependency between a query hook and a separate window hook.

Claims compose. If two mounted consumers require `{A,B}` and `{B,C}` on the
same base, the effective core window is `{A,B,C}`. Unmounting the first drops
only `A`; it cannot overwrite the second consumer's claim.

The lower-level API remains useful for prefetching, retention policies, and
runtime-built queries:

```ts
const store = useReactiveStore();
const retention = store.retainWindow(
  { table: 'tasks', variable: 'project_id' },
  ['p1', 'p2'],
);
await retention.ready;

// Later, release only this owner's claim.
retention.release();
```

React applications use the lifecycle-safe adapter for a known working set:

```tsx
const retention = useRetainedWindow(
  { table: 'tasks', variable: 'project_id' },
  ['p1', 'p2'],
);
```

It composes with generated query claims, normalizes duplicate units, cleans up
on unmount, and surfaces registration through `isPending` / `error`.

`setWindow`/`windowState` and React's `useWindow` remain explicit primitives.
They feed the same union coordinator, but ordinary generated queries should
not repeat their coverage by hand.

## What's next

- **W2, TTL sugar**: codegen emits creation-time bucket scope columns plus a
  sliding-window helper (`window: { bucket: last(3, 'month') }`), pure
  client/codegen sugar over W1.
- **Blob retention on eviction**: cached blob bodies are refcounted by
  referencing rows. Eviction releases refs, and the blobs follow LRU
  retention, persisting until cache pressure reclaims them: eviction is a
  local storage decision, server authorization is unchanged, and the rows can
  be re-synced. This lands with the blob work.
