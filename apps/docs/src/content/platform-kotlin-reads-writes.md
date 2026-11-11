# Reads & writes (Kotlin)

Register units, write optimistically, and read it back with `readRows`, `query`, or `querySnapshot`.

::meta{for="Kotlin developers building screens on a synced table" time="6 minutes"}

:::figure{title="One write, one read" note="All local until the next round" ticks}
<div class="d-row">
<div class="node hot"><span class="t">mutate</span>validates, records a commit,<br>applies the row, queues it</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">query / readRows</span>return the row at once,<br><code>version == -1</code></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">sync</span>pushes the outbox,<br>the row gets a server version</div>
</div>
:::

## JsonValue

The wrapper builds and reads commands with `JsonValue`, a sealed class with `Null`, `Bool`, `Num`, `Str`, `Arr`, and `Obj` cases. Build values with `JsonValue.of(...)` (String, Boolean, Int, Double), `JsonValue.obj("k" to v, ...)`, and `JsonValue.arr(list)`. Read with `.string`, `.bool`, `.number`, `.array`, `.obj`, and `value["key"]`. The class has no third-party JSON dependency. The raw `client.command(method, params)` reaches any command a typed method does not cover.

## Subscribe

A unit is a scope map with one value per scope variable; it covers every table that declares those variables. Registering it is local; the next sync round fills it. [Subscriptions & the outbox](/concepts-subscriptions/#a-unit) defines the unit, and [Scopes & authorization](/concepts-scopes/) the scope vocabulary.

```kotlin title="Subscribe.kt"
val unitId = client.subscribe(mapOf("list_id" to "groceries"))
val ids = client.subscribeMany(listOf(mapOf("list_id" to "work"), mapOf("list_id" to "home")))
client.unsubscribe(unitId)
```

`subscribe` returns the unit id, a hash of the scope map. `units()` lists every registered unit, `unit(id)` reads one with its `status` (`active`, `revoked`, or `failed`), and `unitCatchup(id)` reports whether its bootstrap has completed. Registering an active unit again is a no-op. The generated `Syncular.generated.kt` carries a builder per unit template declared in `syncular.json`: `client.subscribe(SyncularSchema.Subscriptions.TodosInList.scopes(listId = id))`.

## Write

`mutate` takes JSON operations and returns the client commit id. It applies the rows locally, queues one commit, and works offline.

```kotlin title="Write.kt"
val commitId = client.mutate(listOf(JsonValue.obj(
    "table" to JsonValue.of("todos"), "op" to JsonValue.of("upsert"),
    "values" to JsonValue.obj(
        "id" to JsonValue.of("t1"), "list_id" to JsonValue.of("groceries"),
        "title" to JsonValue.of("Hello"), "done" to JsonValue.of(false),
        "position" to JsonValue.of(1), "updated_at_ms" to JsonValue.of(1),
    ),
)))
```

An unknown column, a value that does not match the column type, or a missing required column throws `SyncularException` with code `sync.invalid_request`, and nothing is recorded. `delete` operations and base versions follow [Conflicts & optimistic writes](/concepts-conflicts/). `pendingCommitIds()` lists the commits the outbox still holds.

## Read

```kotlin title="Read.kt"
val rows = client.readRows("todos")
val hits = client.query("SELECT id, title FROM todos WHERE list_id = ?",
                        listOf(JsonValue.of("groceries")))
val snap = client.querySnapshot("SELECT id FROM todos")
```

- **`readRows`**: `RowState` objects `{rowId, version, values}`. `version == -1` marks an optimistic row.
- **`query`**: read-only SQL over the local tables, returned as flat rows. SQL that writes is refused.
- **`querySnapshot`**: rows, window coverage, and the local revision from one read transaction.

Generated named queries (`syncular generate` with a `queriesPath` output) give typed wrappers; see [Named queries](/tooling-queries/).

## Collaborative text

A `crdt` column exposes text helpers (they need a core built with `crdt-yjs`):

```kotlin title="Notes.kt"
val text = client.crdtText("notes", "n1", "doc")
client.crdtInsertText("notes", "n1", "doc", 0, "Hi ")
client.crdtDeleteText("notes", "n1", "doc", 0, 3)
```

`crdtApplyUpdate` accepts a Yjs update as a `ByteArray`. Each helper returns the enqueued commit id. The merge model is on [CRDT columns](/concepts-crdt/).
