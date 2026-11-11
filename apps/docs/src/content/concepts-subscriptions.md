# Subscriptions & the outbox

Every client keeps two durable lists. The **registration list** declares which
rows the client receives, as a list of units. The **outbox** holds the writes
it sends. One sync round carries both, and every other Core model page builds
on these two terms.

::meta{for="App developers on any SDK" time="8 minutes" first="quickstart" spec="4 7"}

:::terms
- **Unit**: A subscription to one value per scope variable, such as `{ list_id: 'groceries' }`. It covers every table that declares all of its variables.
- **Registration list**: The client's units in registration order.
- **Replica cursor**: The last commit the replica has applied for every live unit.
- **Effective scopes**: The requested scopes your backend allows.
- **Outbox**: The local queue of commits waiting to be sent.
- **Round**: One request and its response: push, then pull.
:::

:::figure{title="Two lists on every client" note="One round carries both" ticks}
<div class="node hot"><span class="t">Your server</span>Commit log <span class="chip">c45</span> <span class="chip">c46</span> <span class="chip">c47</span> <span class="chip amber">c48</span></div>
<div class="d-cols-2">
<div class="d-down ok">▼ Receives<small>rows in its units</small></div>
<div class="d-down up">▲ Sends<small>commits, in order</small></div>
</div>
<div class="d-box">
<p class="d-label">Client · local SQLite</p>
<div class="d-cols-2">
<div class="node ok"><span class="t">Registration list</span>list_id = groceries<br>list_id = work<br>replica cursor c47</div>
<div class="node hot"><span class="t">Outbox</span>upsert "oat milk"<br>upsert "rye bread"<br>2 pending</div>
</div>
<div class="d-cols-2"><div class="d-down ok"><small>server rows</small></div><div class="d-down"><small>pending writes</small></div></div>
<div class="node"><span class="t">Local tables</span>What your queries read: server rows with pending writes applied on top</div>
</div>

::caption[The registration list pulls rows down; the outbox pushes writes up. Your app reads and writes only the local tables, so neither waits for the network.]
:::

## A unit

A unit maps each scope variable it names to exactly one value. It names no
table: it covers every table whose scope patterns declare all of its
variables. With `todos` and `todo_comments` both scoped by `list_id`, the unit
`{ list_id: 'groceries' }` fills both tables. The client declares the unit
locally; the next sync round registers it with the server and starts filling
the tables.

:::tabs
```ts sdk=web title="src/sync.ts"
const unitId = client.subscribe({ list_id: 'groceries' });
```
```swift sdk=swift title="Sync.swift"
let unitId = try client.subscribe(scopes: ["list_id": "groceries"])
```
```kotlin sdk=kotlin title="Sync.kt"
val unitId = client.subscribe(mapOf("list_id" to "groceries"))
```
```dart sdk=flutter title="lib/sync.dart"
final unitId = client.subscribe({'list_id': 'groceries'});
```
```ts sdk=react-native title="src/sync.ts"
const unitId = await client.subscribe({ list_id: 'groceries' });
```
```ts sdk=tauri title="src/sync.ts"
const unitId = await client.subscribe({ list_id: 'groceries' });
```
```rust sdk=rust title="src/sync.rs"
use std::collections::BTreeMap;

let unit_id = client.subscribe(BTreeMap::from([
    ("list_id".into(), "groceries".into()),
]))?;
```
:::

`subscribe` returns the unit id: the first 16 bytes of SHA-256 over the
canonical JSON of the scope map, as 32 hex characters. The client and the
server derive the same id from the same scope map, so the app chooses no id
and one scope map always names one unit. Several values of one variable are
several units. To hold only some of the tables that declare a variable on a
device, give those tables their own scope variable.

Register many units at once with `subscribeMany` (`subscribe_many` in Rust).
The client writes them in one local transaction, so a cold start that
declares hundreds of units commits once; on OPFS a commit costs a few
milliseconds. The call applies the `subscribe` rules to each entry, returns
the ids in order, and registers none of them when one entry is invalid.

```ts title="src/sync.ts"
const [groceries, work] = client.subscribeMany([
  { list_id: 'groceries' },
  { list_id: 'work' },
]);
```

A scope map with no variable, a `'*'` value, or a variable that no table
declares fails with `sync.invalid_subscription`.

### What a unit holds

| Field | Set by | Meaning |
|---|---|---|
| `id` | derived | The hash of `scopes`. Use it with `unsubscribe`, `unit` and `unitCatchup`. |
| `scopes` | you | The **requested scopes**: one value per variable. |
| `status` | sync | `active`, `revoked` (access lost) or `failed` (the schema has no local scope column). |
| live or catching up | sync | A live unit advances with the replica cursor. A new unit catches up through its bootstrap and then joins the live set. |

The registration list, each unit's state, and the replica cursor survive an
app restart. `units()` lists every unit in registration order, `unit(id)`
reads one, and `unitCatchup(id)` reports whether its bootstrap has completed.
`unitId(scopes)` from `@syncular/client` computes a scope map's id without
registering it.

An app that derives its units from synced rows releases the units it no
longer wants itself, because units registered by an earlier run survive the
restart. List `units()`, keep the explicit units of the variable the app
manages, and unsubscribe every one that the current set does not contain:

```ts
const wanted = rulesetIds.map((id) => ({ ruleset_id: id }));
const keep = new Set(client.subscribeMany(wanted));
for (const unit of client.units())
  if (unit.explicit && 'ruleset_id' in unit.scopes && !keep.has(unit.id))
    client.unsubscribe(unit.id);
```

`subscribe`, `subscribeMany` and `unsubscribe` raise `syncNeeded` and queue one
interactive sync intent when they change the registration list, in the web
and the Rust clients alike. Registering an active unit again and
unsubscribing an unknown id change nothing.

:::rule{title="Registration order is bootstrap order"}
The server answers new units in registration order. Register the units your
first screen needs first.
:::

:::rule{title="Unsubscribe releases a reference"}
An explicit `subscribe` holds a unit, and a [window](/concepts-windowing/)
holds each unit of its family. `unsubscribe(id)` releases the explicit
reference; the unit leaves the registration list when no window holds it
either. Its rows stay on the device. The next round sends the changed list,
and the server stops delivering the unit's changes.
:::

:::rule{title="Re-subscribing re-arms a revoked unit"}
Registering the scope map of a `revoked` unit again starts it over: cursor
back to `-1`, no bootstrap state, no reason code, and the client asks for a
sync. The next round resolves its scopes again. That is how an app whose
grant arrived after the first subscribe picks up its rows. A unit the client
marked `failed` because the schema has no local scope column stays `failed`;
fix the schema and subscribe again.
:::

## What a round sends for the list

The client sends its registration list only when the list changed since the
last round, after a reset of the server log, and when the server reports that
it stores no list for the client. Every other pull carries one replica cursor
and a 32-byte digest of the list. The server compares the digest with the list
it stored, scans its commit log once from the replica cursor for the changes
of every live unit, and answers with one live section. When every unit is
live and nothing changed, the request carries no unit and the answer carries
no commit, however many units and tables the client holds.

The server accepts at most 500 units in a request that carries the list
(`maxSubscriptionsPerRequest`). The limit counts units; the number of tables
a unit covers does not count. `diagnosticsSnapshot().activeUnits`
(`active_units` in the Rust snapshot) is the number of units the next list
carries ([Pitfalls](/pitfalls/#do-keep-the-unit-count-under-the-server-limit)).

## What a unit receives

The server filters everything a unit receives to its **effective scopes**:
the requested scopes intersected with the scopes your backend allows for this
user ([Scopes](/concepts-scopes/)). What arrives depends on where the unit
stands.

:::figure{title="Life of a unit"}
<div class="d-row">
<div class="node"><span class="t">01 · New</span>Catching up, cursor -1</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">02 · Bootstrap</span>Downloads a snapshot of the current rows of every covered table as segments</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">03 · Live</span>Receives each new commit above the replica cursor, oldest first, deletes included</div>
</div>
<p class="d-label">While live, one of these can happen</p>
<div class="d-cols-3">
<div class="node bad"><span class="t">Access lost</span>The unit's value leaves the allowed scopes.<br><span class="chip bad">Revoked · rows purged</span></div>
<div class="node"><span class="t">One table fenced</span>A wildcard fence revokes the unit on one covered table.<br><span class="chip">Active · that table purged</span></div>
<div class="node cool"><span class="t">Fell behind pruning</span>The replica cursor is older than the server's pruning horizon.<br><span class="chip cool">Reset · bootstrap again</span></div>
</div>

::caption[A reset keeps the local rows until the new bootstrap replaces them. Only a revocation purges.]
:::

The full rules for revocation and purging are on
[Scopes](/concepts-scopes/); the pruning horizon is on
[Commits](/concepts-commits/).

## The outbox

A write is one local transaction with two effects: the row changes in your
local table, and a commit joins the outbox under a `clientCommitId` the client
generates. Your queries see the change at once; the next sync round sends it.

:::figure{title="What one write does"}
<div class="d-row">
<div class="node hot"><span class="t">Your app</span>mutate(…)</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">One local transaction</span>① row written to the local table<br>② commit appended to the outbox</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Next sync round</span>Pushed in creation order</div>
</div>
<p class="d-label">Each commit ends in one stored outcome</p>
<div class="d-cols-3">
<div class="node ok"><span class="chip ok">Applied</span><br>The server accepted it. A retry reports cached.</div>
<div class="node"><span class="chip amber">Conflict</span><br>The row changed on the server first. Its server state arrives attached.</div>
<div class="node bad"><span class="chip bad">Rejected</span><br>A scope check, validator, or purge refused it, with recovery details.</div>
</div>
:::

:::tabs
```ts sdk=web title="src/sync.ts"
client.mutate([{
  table: 'todos',
  op: 'upsert',
  values: { id: 't1', list_id: 'groceries', title: 'Oat milk', done: 0 },
}]);
// Visible to local queries now; sent on the next sync round.
```
```tsx sdk=react title="src/Todo.tsx"
const { mutate } = useMutation();

mutate([{
  table: 'todos',
  op: 'upsert',
  values: { ...todo, done: 1 },
}]);
// Hooks reading todos re-render now; the commit waits in the outbox.
```
```swift sdk=swift title="Sync.swift"
let commitId = try client.mutate([
    .object([
        "table": .string("todos"), "op": .string("upsert"),
        "values": .object([
            "id": .string("t1"), "list_id": .string("groceries"),
            "title": .string("Oat milk"),
        ]),
    ]),
])
```
```kotlin sdk=kotlin title="Sync.kt"
client.mutate(listOf(JsonValue.obj(
    "op" to JsonValue.of("upsert"), "table" to JsonValue.of("todos"),
    "values" to JsonValue.obj(
        "id" to JsonValue.of("t1"),
        "list_id" to JsonValue.of("groceries"),
        "title" to JsonValue.of("Oat milk"),
    ),
)))
```
```dart sdk=flutter title="lib/sync.dart"
client.mutate([
  {'op': 'upsert', 'table': 'todos',
   'values': {'id': 't1', 'list_id': 'groceries', 'title': 'Oat milk'}},
]);
```
```rust sdk=rust title="src/sync.rs"
client.mutate(vec![Mutation::Upsert {
    table: "todos".into(),
    values: serde_json::json!({
        "id": "t1", "list_id": "groceries", "title": "Oat milk"
    }).as_object().cloned().unwrap(),
    base_version: None,
}])?;
```
:::

The outbox is first in, first out. Commits push strictly in creation order,
and once a push containing a commit may have reached the server, the client
never reorders or merges that commit, because its idempotency key pins its
content.

Each outbox has a random **outbox id**, and each commit carries a sequence
number that grows in creation order. A request names the outbox id and the
sequence of every commit it pushes. The first sequence of a request proves to
the server that every older commit has left the outbox for good, so the
server raises its **watermark** for that outbox to that sequence and deletes
the stored results below it. A commit below the watermark that has no stored
result receives `sync.commit_expired`, and the client records it as a
rejection.

:::warning{title="Reset a copied or restored replica"}
A replica copied to a second device, or restored from a backup, shares its
client id, outbox id and sequence with the original. Its commits below the
original's watermark receive `sync.commit_expired`. Give a restored or copied
replica a fresh local database: a new client id, a new outbox id and an empty
outbox.
:::

### Replay on top

Whenever server data arrives (a pull, a realtime delta, a bootstrap), the
client applies it and then re-applies every pending outbox commit over it. A
pending write stays visible the whole time. The server's version of a row
replaces your pending version once the commit that produced it has drained or
been dropped.

:::figure{title="What your queries see"}
<div class="d-stack">
<div class="node ok"><span class="t">Top · your queries</span>Server rows with pending writes applied</div>
<div class="node hot"><span class="t">Layer 2 · re-applied after every server update</span>Pending outbox commits, in creation order</div>
<div class="node"><span class="t">Layer 1</span>Rows from the server: pulls, deltas, bootstraps</div>
</div>
:::

:::tip{title="Pending writes survive schema upgrades"}
The outbox stores commits in a schema-independent form and encodes them when
it sends, so pending commits survive a
[schema upgrade](/concepts-schema-upgrades/). A row with a pending write also
stays through [window eviction](/concepts-windowing/) until the write drains.
:::

:::note{title="On the web"}
The outbox is as durable as the local store. OPFS data can be evicted until
the site holds the persistent-storage permission;
[eviction-resistant storage](/platform-web-specifics/#eviction-resistant-storage) shows
how to request it.
:::

## One sync round

A round is one request and one response, over `POST /sync` or the
[realtime socket](/concepts-realtime/); the frames are identical on both.

:::figure{title="One round, in order"}
<div class="d-cols-2">
<div class="d-box">
<p class="d-label">Client → server · request</p>
<div class="d-stack">
<div class="node">① Header: client id, outbox id, schema version</div>
<div class="node hot">② Outbox commits, oldest first, each with its sequence</div>
<div class="node ok">③ Pull header: replica cursor and list digest; the units only when the list changed</div>
</div>
</div>
<div class="d-box">
<p class="d-label">Server → client · response</p>
<div class="d-stack">
<div class="node">① One result per pushed commit</div>
<div class="node cool">② Unit sections: bootstrap segments for new units, revocations, resets</div>
<div class="node ok">③ One live section: commits above the replica cursor for every live unit</div>
</div>
</div>
</div>
<div class="node"><span class="t">Then, on the client</span>Apply each block in its own transaction → advance the replica cursor → store commit outcomes → replay the remaining outbox on top</div>

::caption[A response serves commits oldest first, bounded per response, and never splits one commit across two responses.]
:::

| Call | Runs |
|---|---|
| `sync()` | One round. |
| `syncUntilIdle()` | Rounds until the outbox is empty and every unit is live. |
| Realtime | A connected client receives new commits as deltas without asking. |

On a headless client the [host scheduler](/guide-server-clients/) decides when
rounds run; the browser worker runs them itself with `autoSync`.

## Related pages

- [Commits, cursors, idempotency](/concepts-commits/): the server side of the
  same story.
- [Bootstrap & segments](/concepts-bootstrap/): what a new unit
  downloads.
- [Conflicts & optimistic writes](/concepts-conflicts/): what happens when a
  pushed commit finds a newer row.
- [Windowed sync](/concepts-windowing/): families of units as a partial
  local copy.
- [Upgrade to wire version 4](/upgrade-wire-4/): the move from per-table
  subscriptions to units.
