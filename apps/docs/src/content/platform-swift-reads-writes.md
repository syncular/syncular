# Reads & writes (Swift)

Subscribe to data, write it optimistically, and read it back with `readRows`, `query`, or `querySnapshot`.

::meta{for="Swift developers building screens on a synced table" time="6 minutes"}

:::figure{title="One write, one read" note="All local until the next round" ticks}
<div class="d-row">
<div class="node hot"><span class="t">mutate</span>validates, records a commit,<br>applies the row, queues it</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">query / readRows</span>return the row at once,<br><code>version == -1</code></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">sync</span>pushes the outbox,<br>the row gets a server version</div>
</div>
:::

## Subscribe

A subscription is an id, a table, and a scope map. It is local; the next sync round fills it. [Scopes & authorization](/concepts-scopes/) defines the scope vocabulary.

```swift title="Subscribe.swift"
try client.subscribe(id: "todos", table: "todos",
                     scopes: ["list_id": ["groceries"]])
try client.unsubscribe(id: "todos")
```

`subscriptionState(id:)` returns the subscription's status string: `active`, `revoked`, or `failed`. Calling `subscribe` again with the same id and the same table, scopes, and params is a no-op; a different definition under an existing id throws. The generated `Syncular.generated.swift` also carries a typed helper per subscription declared in `syncular.json`.

## Write

`mutate` takes JSON operations and returns the client commit id. It applies the rows locally, queues one commit, and works offline.

```swift title="Write.swift"
let commitId = try client.mutate([
    .object([
        "table": .string("todos"), "op": .string("upsert"),
        "values": .object(["id": .string("t1"), "list_id": .string("groceries"),
                           "title": .string("Hello"), "done": .bool(false),
                           "position": .number(1), "updated_at_ms": .number(1)]),
    ]),
])
```

An unknown column, a value that does not match the column type, or a missing required column throws `SyncularError` with code `sync.invalid_request`, and nothing is recorded. `delete` operations and base versions follow [Conflicts & optimistic writes](/concepts-conflicts/). `pendingCommitIds()` lists the commits the outbox still holds.

## Read

```swift title="Read.swift"
let rows = try client.readRows(table: "todos")
let hits = try client.query("SELECT id, title FROM todos WHERE list_id = ?",
                            params: [.string("groceries")])
let snap = try client.querySnapshot("SELECT id FROM todos")
```

- **`readRows`**: `RowState` objects `{rowId, version, values}`. `version == -1` marks an optimistic row.
- **`query`**: read-only SQL over the local tables, returned as flat rows. SQL that writes is refused.
- **`querySnapshot`**: rows, window coverage, and the local revision from one read transaction. Use it when a screen must know whether its window is complete.

Generated named queries (`syncular generate` with a `queriesPath` output) give typed `query` wrappers; see [Named queries](/tooling-queries/).

## Collaborative text

A `crdt` column exposes text helpers (they need a core built with `crdt-yjs`):

```swift title="Notes.swift"
let text = try client.crdtText(table: "notes", rowId: "n1", column: "doc")
try client.crdtInsertText(table: "notes", rowId: "n1", column: "doc",
                          index: 0, value: "Hi ")
try client.crdtDeleteText(table: "notes", rowId: "n1", column: "doc",
                          index: 0, len: 3)
```

`crdtApplyUpdate` accepts a Yjs update as `[UInt8]` for cases the text helpers do not cover. Each helper returns the enqueued commit id. The merge model is on [CRDT columns](/concepts-crdt/).
