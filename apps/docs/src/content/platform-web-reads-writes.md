# Browser: reads & writes

Subscribe to rows, read them with local SQL, and write through `mutate`. You
finish knowing which handle calls read, which write, and what `mutate` rejects
before it records anything.

::meta{for="Web developers using the handle directly" time="6 minutes" first="platform-web-install concepts-subscriptions"}

:::terms
- **Unit**: One value per scope variable; the device receives the rows of every table that declares those variables.
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
await handle.subscribe({ list_id: 'groceries' });
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
`sync.invalid_request`. So does every value the server refuses at push
admission: a string or delete `rowId` containing U+0000, a `json` value outside
the [JSON validity rule](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#conventions-and-primitive-encodings)
(nested deeper than 64 containers, a number beyond binary64 such as `1e999`, a
string with U+0000 or an unpaired surrogate), and a `blob_ref` whose text is
not the canonical serialization. A rejected call appends no outbox commit,
writes no optimistic row, publishes no revision, and emits no event.

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
one read. `conflicts()` reports conflicts, and `commitDelivery(commitId)` reports
one commit's state:

```ts
const status = await handle.statusSnapshot();
if (status.schemaFloor) showUpgradeRequired(status.schemaFloor);
const conflicts = await handle.conflicts();
const delivery = await handle.commitDelivery(commitId);
```

`known` carries the recorded final server result. `pending` means the outbox
still holds the commit, and `unknown` means the client no longer holds its
outcome or never queued it; see
[Delivery status](/reference-outbox-outcomes/#delivery-status). For a rejection or conflict, apply the resolution actions in
[Conflicts & optimistic writes](/concepts-conflicts/).

## Windowed sync and local purge

`setWindow(base, units)` holds a partial local replica: the client bootstraps
what enters the window and evicts what leaves, and `windowState` flags a query
over unheld data as partial. See [Windowed sync](/concepts-windowing/).

`purgeLocalData({ purgeId, targets })` removes matching rows, FTS documents,
unsafe pending commits, and blob references atomically. Call it only after you
validate a server-authoritative revocation directive and gate any unit
that could download the rows again. For quarantine before data, create the
handle with `securityPreflight: true`. A follower's request applies to the one
shared origin leader. Diagnostics stay closed during preflight: an
`onDiagnostics` listener registered on the handle receives its first snapshot
when `activateSecurity()` completes. The gate belongs to the shared core, so
every tab meets it until the tab that owns the preflight activates; a
realtime supervisor in another tab waits in phase `protected` meanwhile
([Realtime & lifecycle](/platform-web-realtime/)). The lifecycle is defined in
[Authorized local purge](/concepts-local-data-purge/).

The tab that enters the preflight owns it: the tab whose handle started the
core with `securityPreflight: true`, or the tab whose
`beginSecurityPreflight()` closed an open gate. A second tab's
`beginSecurityPreflight()` enters the same gate and leaves the owner as it
is. `activateSecurity()` from any other tab fails with
`client.security_preflight_owned` and the gate stays closed; that tab waits
for a status with `securityLifecycle: 'active'`. When the owner tab closes or
crashes, the preflight stays closed, and a tab must call
`beginSecurityPreflight()` itself, which makes it the owner, before its
`activateSecurity()` releases the gate. A handle that opens with
`securityPreflight: true` while the leader tab closes opens in preflight on
the next core.

The preflight is stored in the replica. A client that opens a replica left in
preflight starts in preflight whatever its `securityPreflight` says and
installs no configured keyring, so a tab that promotes after the leader tab
closed during preflight runs a core in preflight with no owner. Closing an
active client stores nothing, and `activateSecurity()` clears the record.
