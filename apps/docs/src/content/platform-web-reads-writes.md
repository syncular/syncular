# Browser: reads & writes

Subscribe to rows, read them with local SQL, and write through `mutate`. You
finish knowing which handle calls read, which write, and what `mutate` rejects
before it records anything.

::meta{for="Web developers using the handle directly" time="6 minutes" first="platform-web-install concepts-subscriptions"}

:::terms
- **Subscription**: A table plus the scope values this device receives.
- **Outbox**: The local queue of commits waiting to be sent.
- **Authored value**: A value you pass to `mutate` or `patch`.
:::

:::figure{title="Reads and writes through the handle" note="Neither waits for the network" ticks}
<div class="d-row">
<div class="d-stack">
<div class="node ok"><span class="t">Read</span><code>handle.query(sql)</code></div>
<div class="node hot"><span class="t">Write</span><code>handle.mutate([...])</code></div>
</div>
<span class="d-arrow"></span>
<div class="d-box">
<p class="d-label">Worker · local SQLite</p>
<div class="d-stack">
<div class="node ok"><span class="t">Your tables</span>Server rows with pending writes on top</div>
<div class="node hot"><span class="t">Outbox</span>The commit waits for the next round</div>
</div>
</div>
</div>

::caption[A write is visible to the next query at once. The next sync round sends it.]
:::

:::::steps
::::step{title="Subscribe and read" time="2 min"}
Reads are SQL against your own tables. `subscribe` declares which rows the
device receives; `syncUntilIdle` runs rounds until the local tables are filled.

```ts title="src/todos.ts"
await handle.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });
await handle.syncUntilIdle();

const rows = await handle.query('SELECT id, title FROM todos ORDER BY id');
```

::checkpoint[`rows` holds the todos of the `groceries` list.]
::::

::::step{title="Write with mutate" time="2 min"}
Every write goes through `mutate`, which applies it locally and queues it in
the outbox.

```ts title="src/todos.ts"
await handle.mutate([
  {
    table: 'todos',
    op: 'upsert',
    values: { id: crypto.randomUUID(), list_id: 'groceries', title: 'hi', done: false },
  },
]);
```

::checkpoint[The next `handle.query` returns the new row before any network round trip. `await handle.pendingCommits()` lists the commit until a round sends it.]
::::
:::::

## Typed reads and local search

Generated `.sql` queries give typed reads on every platform; see
[Named queries](/tooling-queries/). For live queries in React, see
[React](/platform-react/). Schema-declared
[local FTS5 projections](/tooling-local-search/) are ordinary local read
targets. The worker builds and maintains them inside its SQLite database, and
they invalidate through their synced owner table.

## Authoring value validation

`mutate` and `patch` validate every supplied value against the declared column
type before the call records anything. A wrong type, an absent required column,
a non-finite float, or a malformed byte envelope rejects with
`sync.invalid_request`. A rejected call appends no outbox commit, writes no
optimistic row, publishes no revision, and emits no event.

Two normalizations let a row read from the local mirror feed back into
`mutate`:

- A `bigint` within the safe-integer range is accepted for an `integer` column.
- `0` and `1` are accepted for a `boolean` column.

A `bytes` or `crdt` column takes a `Uint8Array` or the canonical
`{"$bytes": "<hex>"}` envelope: one key and an even number of hexadecimal
digits. The client accepts uppercase digits and emits lowercase.

:::note{title="Pending commits with refused values"}
A pending commit whose stored value the current codec refuses leaves the outbox
at the startup or reset reconciliation boundary, before any replay. The
rejection carries `sync.outbox_incompatible` with `details.reason` set to
`invalid_stored_values`. The commit's operation envelope stays in the journal
when its stored shape is representable; the client omits a malformed envelope so
the journal keeps a canonical shape. Commits behind the recovered one survive
and drain.
:::

## Reading local state

The handle exposes the read methods as promises: `statusSnapshot()` returns the
outbox count, the upgrade state, the lease state, and the schema floor in one
call. `querySnapshot` returns rows, window coverage, and the local revision from
one read. `conflicts()` and `commitOutcome(commitId)` report conflicts and
final commit results:

```ts
const status = await handle.statusSnapshot();
if (status.schemaFloor) showUpgradeRequired(status.schemaFloor);
const conflicts = await handle.conflicts();
const outcome = await handle.commitOutcome(commitId);
```

An absent outcome means the commit has not reached a recorded final server
result. For a rejection or conflict, apply the resolution actions in
[Conflicts & optimistic writes](/concepts-conflicts/).

## Windowed sync and local purge

`setWindow(base, units)` holds a partial local replica: the client bootstraps
what enters the window and evicts what leaves, and `windowState` flags a query
over unheld data as partial. See [Windowed sync](/concepts-windowing/).

`purgeLocalData({ purgeId, targets })` removes matching rows, FTS documents,
unsafe pending commits, and blob references atomically. Call it only after you
validate a server-authoritative revocation directive and gate any subscription
that could download the rows again. For quarantine before data, create the
handle with `securityPreflight: true`. A follower's request applies to the one
shared origin leader. The lifecycle is defined in
[Authorized local purge](/concepts-local-data-purge/).
