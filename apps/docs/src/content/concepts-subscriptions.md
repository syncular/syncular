# Subscriptions & the outbox

Every client keeps two durable lists. **Subscriptions** declare which rows the
client receives. The **outbox** holds the writes it sends. One sync round
carries both, and every other Core model page builds on these two terms.

::meta{for="App developers on any SDK" time="8 minutes" first="quickstart" spec="4 7"}

:::terms
- **Subscription**: A table plus the scope values a client receives.
- **Cursor**: The last commit a subscription has applied.
- **Effective scopes**: The requested scopes your backend allows.
- **Outbox**: The local queue of commits waiting to be sent.
- **Round**: One request and its response: push, then pull.
:::

:::figure{title="Two lists on every client" note="One round carries both" ticks}
<div class="node hot"><span class="t">Your server</span>Commit log <span class="chip">c45</span> <span class="chip">c46</span> <span class="chip">c47</span> <span class="chip amber">c48</span></div>
<div class="d-cols-2">
<div class="d-down ok">▼ Receives<small>rows in its scopes</small></div>
<div class="d-down up">▲ Sends<small>commits, in order</small></div>
</div>
<div class="d-box">
<p class="d-label">Client · local SQLite</p>
<div class="d-cols-2">
<div class="node ok"><span class="t">Subscriptions</span>todos<br>list_id = groceries<br>cursor c47</div>
<div class="node hot"><span class="t">Outbox</span>upsert "oat milk"<br>upsert "rye bread"<br>2 pending</div>
</div>
<div class="d-cols-2"><div class="d-down ok"><small>server rows</small></div><div class="d-down"><small>pending writes</small></div></div>
<div class="node"><span class="t">Local tables</span>What your queries read: server rows with pending writes applied on top</div>
</div>

::caption[The subscription pulls rows down; the outbox pushes writes up. Your app reads and writes only the local tables, so neither waits for the network.]
:::

## A subscription

A subscription names a table and the scope values the client asks for. The
client declares it locally; the next sync round registers it with the server
and starts filling the table.

:::tabs
```ts sdk=web title="src/sync.ts"
client.subscribe({
  id: 'todos',
  table: 'todos',
  scopes: { list_id: ['groceries'] },
});
```
```swift sdk=swift title="Sync.swift"
try client.subscribe(id: "todos", table: "todos",
                     scopes: ["list_id": ["groceries"]])
```
```kotlin sdk=kotlin title="Sync.kt"
client.subscribe(
    id = "todos",
    table = "todos",
    scopes = mapOf("list_id" to listOf("groceries")),
)
```
```dart sdk=flutter title="lib/sync.dart"
client.subscribe('todos', 'todos', scopes: {'list_id': ['groceries']});
```
```ts sdk=react-native title="src/sync.ts"
await client.subscribe({
  id: 'todos',
  table: 'todos',
  scopes: { list_id: ['groceries'] },
});
```
```ts sdk=tauri title="src/sync.ts"
await client.subscribe({
  id: 'todos',
  table: 'todos',
  scopes: { list_id: ['groceries'] },
});
```
```rust sdk=rust title="src/sync.rs"
client.subscribe(
    "todos".into(), "todos".into(),
    vec![("list_id".into(), vec!["groceries".into()])], None)?;
```
:::

### What a subscription holds

| Field | Set by | Meaning |
|---|---|---|
| `id` | you | Any name you choose. The server echoes it and never interprets it. |
| `table` | you | The synced table this subscription fills. |
| `scopes` | you | The **requested scopes**: which groups of rows you ask for, such as one list. |
| cursor | sync | The last commit this subscription has applied. Empty until the first sync. |

A subscription and its cursor survive an app restart.

:::rule{title="Omission unsubscribes"}
Each pull sends the client's complete subscription list, and that list
replaces the stored one. A subscription missing from the list stops receiving
changes and its cursor is forgotten. [Windowed sync](/concepts-windowing/)
builds on this rule: it keeps one subscription per window unit and turns a
window change into including or omitting subscriptions.
:::

:::warning{title="An id is bound to its query"}
Within one client, the table, requested scopes, and params of a registered id
cannot change. Declaring the same id again with the same values keeps the
cursor and bootstrap state. The same id with different values fails with
`client.subscription_intent_mismatch`; use a new id, or unsubscribe first.
:::

## What a subscription receives

The server filters everything a subscription receives to its **effective
scopes**: the requested scopes intersected with the scopes your backend allows
for this user ([Scopes](/concepts-scopes/)). What arrives depends on where the
subscription stands.

:::figure{title="Life of a subscription"}
<div class="d-row">
<div class="node"><span class="t">01 · New</span>No cursor yet</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">02 · Bootstrap</span>Downloads a snapshot of the current rows as segments</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">03 · Caught up</span>Receives each new commit above its cursor, oldest first, deletes included</div>
</div>
<p class="d-label">While caught up, one of these can happen</p>
<div class="d-cols-3">
<div class="node"><span class="t">Access narrows</span>Stays active on the remaining values. Rows for lost values stop updating and stay readable.<br><span class="chip">Still active</span></div>
<div class="node bad"><span class="t">Access lost entirely</span>A requested variable keeps none of its values.<br><span class="chip bad">Revoked · rows purged</span></div>
<div class="node cool"><span class="t">Fell behind pruning</span>The cursor is older than the server's pruning horizon.<br><span class="chip cool">Reset · bootstrap again</span></div>
</div>

::caption[Rows for lost values stay readable until the subscription is revoked or a fresh bootstrap applies the §5.6 first-page rule. To make the loss of one value purge its rows, give that value its own subscription.]
:::

The full rules for narrowing, revocation, and purging are on
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
<div class="node">① Header: client id, schema version</div>
<div class="node hot">② Outbox commits, oldest first</div>
<div class="node ok">③ Pull header and the complete subscription list</div>
</div>
</div>
<div class="d-box">
<p class="d-label">Server → client · response</p>
<div class="d-stack">
<div class="node">① One result per pushed commit</div>
<div class="node cool">② New subscriptions: bootstrap segments</div>
<div class="node ok">③ Caught-up subscriptions: commits above the cursor</div>
</div>
</div>
</div>
<div class="node"><span class="t">Then, on the client</span>Apply each block in its own transaction → advance cursors → store commit outcomes → replay the remaining outbox on top</div>

::caption[A response serves commits oldest first, bounded per response, and never splits one commit across two responses.]
:::

| Call | Runs |
|---|---|
| `sync()` | One round. |
| `syncUntilIdle()` | Rounds until the outbox is empty and every subscription has caught up. |
| Realtime | A connected client receives new commits as deltas without asking. |

On a headless client the [host scheduler](/guide-server-clients/) decides when
rounds run; the browser worker runs them itself with `autoSync`.

## Related pages

- [Commits, cursors, idempotency](/concepts-commits/): the server side of the
  same story.
- [Bootstrap & segments](/concepts-bootstrap/): what a new subscription
  downloads.
- [Conflicts & optimistic writes](/concepts-conflicts/): what happens when a
  pushed commit finds a newer row.
- [Windowed sync](/concepts-windowing/): families of subscriptions as a
  partial local copy.
