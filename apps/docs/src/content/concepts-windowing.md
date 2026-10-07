# Windowed sync

Use windowed sync when a client should hold only part of a table, such as the busy lists or the last three months, while the server keeps the full history. A window is the set of scope values a client currently holds locally. Changing it transfers only the difference, evicted rows leave no tombstones, and every local query can ask whether its window is complete. This page is for developers whose data outgrows a full local copy; it assumes [Scopes](/concepts-scopes/) and [Subscriptions](/concepts-subscriptions/).

::meta{for="App developers who need a partial local replica" time="12 minutes" first="concepts-scopes" spec="4.8"}

:::terms
- **Window**: The set of scope values for one scope variable of a table that a client holds locally.
- **Window unit**: One scope value, the atom of eviction and re-entry.
- **Window base**: A table, the scope variable whose values are the units, and any fixed scopes every unit shares.
- **Family**: The subscriptions a window manages, one per live unit, with deterministic ids.
- **Pending unit**: A registered unit whose bootstrap has not finished. Its local rows may be empty or partial.
- **Completeness oracle**: The window registry's verdict on whether a local query is answerable in full.
:::

:::figure{title="A window is a set of scope values" note="Server keeps everything" ticks}
<div class="d-cols-2">
<div class="d-box">
<p class="d-label">Server · full history</p>
<div class="d-row">
<div class="node">list A</div><div class="node">list B</div><div class="node">list C</div><div class="node">list D</div>
</div>
</div>
<div class="d-box">
<p class="d-label">Client · window {B, C}</p>
<div class="d-row">
<div class="node ok">list B<br><span class="chip ok">complete</span></div><div class="node cool">list C<br><span class="chip cool">pending</span></div>
</div>
</div>
</div>

::caption[Each unit is its own subscription. Lists A and D are not held, so a query that touches them is partial.]
:::

## A window is a set of scope values

You already scope your tables ([Scopes](/concepts-scopes/)). A window reuses that machinery: subscribe to lists `A` and `B` now and `B` and `C` later, or to month buckets (`2026-05`, `2026-06`, `2026-07`) and slide them. The scope column is already the authorization boundary, the fanout index, and the segment cache key, so windowing by it adds nothing to the wire. The server is unchanged: windowing reuses the existing frames, fields, and codes.

## Changing the window is a set difference

A window change is a set difference on the family of subscriptions, one per live unit.

:::figure{title="Widen, shrink, replace"}
<div class="d-cols-3">
<div class="node ok"><span class="t">Widen {A,B} → {A,B,C}</span>C gets a fresh subscription and bootstraps. A and B keep their cursors.</div>
<div class="node bad"><span class="t">Shrink {A,B,C} → {B,C}</span>A's subscription is dropped and its rows are evicted.</div>
<div class="node hot"><span class="t">Replace {A,B} → {B,C}</span>Shrink A plus widen C. B stays cached and is neither re-downloaded nor evicted.</div>
</div>

::caption[The cost of a window change scales with the size of the delta. The benchmark confirms it on a segment counter: replacing {A,B} with {B,C} re-applies only the one list's rows that changed.]
:::

- **Widen**: the new unit [bootstraps](/concepts-bootstrap/) through the image lane.
- **Shrink**: the client drops the unit's subscription and evicts its rows in chunks of at most 1,024 unpinned rows. The first chunk and the unsubscription commit together, and coverage becomes missing immediately.

Choose the unit to trade subscription count against re-entry granularity. One unit per list or per month bucket is exact. One subscription for a 500-value set re-bootstraps the whole set on any change. Value-sharding works comfortably to a few hundred units; beyond that, group values into coarser units.

## Eviction is a local storage decision

Eviction is a voluntary local delete driven by your retention policy. The server retains the evicted rows and creates no tombstones; re-entering the window re-delivers them. A [scope revocation](/concepts-scopes/) purge differs because lost authorization forces it. Three rules make eviction correct:

- **Outbox pin**: a row with a pending offline write stays local until the write drains, since replaying the write would otherwise resurrect an orphan.
- **Version state dies with the row**: a re-entered row's optimistic-write version comes only from its re-delivery, so no stale version cache exists.
- **Re-entry is a fresh bootstrap**: it snapshots current server state and works at any distance, however much log the server pruned since the eviction. A re-entered row is writable immediately.

Cleanup yields between committed chunks. A durable pending-eviction record lets a reopened client resume cleanup before its next network request, including when that request fails offline. Re-entry cancels pending cleanup and starts a fresh bootstrap. Storage failures remain errors, including a failure to persist the cleanup record. Authorization revocation keeps its atomic security purge.

## The completeness oracle

The window registry also answers whether a local query is complete. A query is answerable in full only if every scope value it touches is windowed in and bootstrapped. Registration alone is not completeness: between `setWindow` and the unit's bootstrap, the unit is pending, and the oracle says so instead of letting the app render a false empty state on a list switch. A unit with zero server rows becomes complete once its bootstrap round finishes. A query that touches a windowed-out or pending unit is partial, and the API reports that state explicitly. The engine never reports a partial replica as complete.

## Set a window

Store an immutable UTC month bucket when each row is created, derive it from the creation timestamp, and use the same column as the scope variable. `creationTimeBucket(ms, 'month')` returns `YYYY-MM` for timestamps from 1970 through year 9999. `last(count, 'month', nowMs)` returns the current UTC month and the preceding `count - 1` months, oldest first, for a `count` from 1 through 1200; pass an explicit `nowMs` in jobs and tests that need a pinned boundary. `month` is the only unit.

Do not recompute `created_month` as time passes. The bucket records creation time, so a rolling window changes only its set of live scope values, and no timer mutates stored rows.

:::tabs
```ts sdk=web title="src/sync.ts"
import { creationTimeBucket, last } from '@syncular/client';

const createdAtMs = Date.now();
const row = {
  id: crypto.randomUUID(),
  created_at_ms: createdAtMs,
  created_month: creationTimeBucket(createdAtMs, 'month'),
};

await client.setWindow(
  { table: 'messages', variable: 'created_month' },
  last(3, 'month'),
);
```
```tsx sdk=react title="src/Messages.tsx"
// Generated named queries claim their own units. The explicit hook is for
// prefetching and retention policies.
const retention = useRetainedWindow(
  { table: 'messages', variable: 'created_month' },
  last(3, 'month'),
);
```
```dart sdk=flutter title="lib/sync.dart"
client.setWindow(
  {'table': 'messages', 'variable': 'created_month'},
  ['2026-06', '2026-07', '2026-08'],
);
final state = client.windowState({'table': 'messages', 'variable': 'created_month'});
// state.units, state.pending, state.complete('2026-07')
```
```swift sdk=swift title="Sync.swift"
_ = try client.command(method: "setWindow", params: .object([
    "base": .object(["table": .string("messages"),
                     "variable": .string("created_month")]),
    "units": .array([.string("2026-06"), .string("2026-07")]),
]))
```
```kotlin sdk=kotlin title="Sync.kt"
client.command("setWindow", JsonValue.obj(
    "base" to JsonValue.obj(
        "table" to JsonValue.of("messages"),
        "variable" to JsonValue.of("created_month"),
    ),
    "units" to JsonValue.arr(listOf(JsonValue.of("2026-06"), JsonValue.of("2026-07"))),
))
```
```ts sdk=react-native title="src/sync.ts"
await client.setWindow(
  { table: 'messages', variable: 'created_month' },
  ['2026-06', '2026-07', '2026-08'],
);
const state = await client.windowState({ table: 'messages', variable: 'created_month' });
```
```ts sdk=tauri title="src/sync.ts"
await client.setWindow(
  { table: 'messages', variable: 'created_month' },
  ['2026-06', '2026-07', '2026-08'],
);
```
```rust sdk=rust title="src/sync.rs"
use syncular_client::{last, TimeBucketUnit, WindowBase};

let base = WindowBase {
    table: "messages".into(),
    variable: "created_month".into(),
    fixed_scopes: vec![],
    params: None,
};
client.set_window(&base, &last(3, TimeBucketUnit::Month, now_ms)?)?;
let state = client.window_state(&base); // state.units, state.pending
```
:::

Native hosts that pass raw units, as the Swift and Kotlin samples do, can derive the buckets with the `timeWindowSugar` command, which returns `bucket` and `units` for a `createdAtMs`, `count`, `nowMs`, and `unit: "month"`. Widening bootstraps the new units and narrowing evicts the removed ones. Render a pending unit as loading.

## Read completeness in your UI

For named queries, typegen owns the plumbing. A predicate such as `WHERE list_id = :listId` is proven against the schema and emitted as query coverage. In React, `useQuery` claims that unit and reads rows, completeness, and the exact local revision in one SQLite snapshot:

```tsx title="src/Todos.tsx"
const todos = useQuery(listTodosQuery, { listId });

if (todos.phase === 'loading') return <Skeleton />;
if (todos.phase === 'ready' && todos.rows.length === 0) return <Empty />;
return <Rows rows={todos.rows} partial={todos.phase === 'partial'} />;
```

A zero-row bootstrap is safe: `[]` is not a complete empty answer until the same snapshot says the unit has finished. No render-order dependency exists between a query hook and a separate window hook. Other SDKs read the same verdict with `querySnapshot`, which returns rows, window coverage, and the local revision from one read transaction, or with `windowState(base)`.

## Advanced: claims, retention, and observers

This section covers the reactive store that the browser client and React share.

Queries request their local snapshot immediately while registration runs. Cached complete rows can render even if registration waits behind a download, and cached incomplete rows stay partial. Registration failures stay observable beside cached rows, and security and availability checks still gate every result. An additional owner of already-held units receives its registration acknowledgement without waiting for unrelated window widening. An in-flight removal still needs acknowledgement before those units are held again. A failed window edit invalidates the cached acknowledgement, so a retry reconciles ownership with the core even if an earlier eviction chunk already committed.

A query whose claim was rejected shows phase `error` with the rejection. The store claims again when a row of one of its tables changes, once per sync attempt (so the client's retry backoff paces it), when a leader serves the tab again, and on `refresh()`. A long-lived reader recovers without remounting.

Claims compose. If two mounted consumers require `{A,B}` and `{B,C}` on the same base, the effective core window is `{A,B,C}`. Unmounting the first drops only `A` and cannot overwrite the second consumer's claim.

The lower-level API serves prefetching, retention policies, and runtime-built queries:

```ts title="src/prefetch.ts"
const store = useReactiveStore();
const retention = store.retainWindow(
  { table: 'todos', variable: 'list_id' },
  ['groceries', 'work'],
);
await retention.ready;

// Later, release only this owner's claim.
retention.release();
```

React applications use the lifecycle-safe adapter for a known working set:

```tsx title="src/Todos.tsx"
const retention = useRetainedWindow(
  { table: 'todos', variable: 'list_id' },
  ['groceries', 'work'],
);
```

It composes with generated query claims, normalizes duplicate units, cleans up on unmount, and surfaces registration through `isPending` and `error`. Handle `error` even when another query already renders cached rows. `setWindow`, `windowState`, and React's `useWindow` remain explicit primitives that feed the same union coordinator; generated queries do not need their coverage repeated by hand.

Query and window observers keep inactive entries only until the next microtask. The final unsubscribe removes the entry from change dispatch immediately, and cleanup releases its rows and invalidates pending reads. A same-microtask remount preserves the shared snapshot, and a later subscription starts a fresh read, including subscriptions held by an older React render. Releasing the final window owner removes the empty claim group after the core applies the release. Disposing the store rejects unapplied retention handles with `client.reactive_store_disposed`.
