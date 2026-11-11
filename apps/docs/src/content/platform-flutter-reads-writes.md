# Reads & writes (Flutter)

Register units, write optimistically, and read it back with `readRows`, `query`, or `querySnapshot`.

::meta{for="Flutter developers building screens on a synced table" time="6 minutes"}

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

A unit is a scope map with one value per scope variable; it covers every table that declares those variables. Registering it is local; the next sync round fills it. [Subscriptions & the outbox](/concepts-subscriptions/#a-unit) defines the unit, and [Scopes & authorization](/concepts-scopes/) the scope vocabulary.

```dart title="subscribe.dart"
final unitId = client.subscribe({'list_id': 'groceries'});
final ids = client.subscribeMany([{'list_id': 'work'}, {'list_id': 'home'}]);
client.unsubscribe(unitId);
```

`subscribe` returns the unit id, a hash of the scope map. `units()` lists every registered unit, `unit(id)` reads one with its `status` (`active`, `revoked`, or `failed`), and `unitCatchup(id)` reports whether its bootstrap has completed. Registering an active unit again is a no-op. The generated `syncular.generated.dart` carries a typed row class per table and a builder per unit template declared in `syncular.json`: `client.subscribe(SyncularTodosInListSubscription.scopes(listId: id))`.

## Write

`mutate` takes a list of operation maps and returns the client commit id. It applies the rows locally, queues one commit, and works offline.

```dart title="write.dart"
final commitId = client.mutate([
  {
    'op': 'upsert',
    'table': 'todos',
    'values': {'id': 't1', 'list_id': 'groceries', 'title': 'Hello',
               'done': false, 'position': 1, 'updated_at_ms': 1},
  },
]);
```

An unknown column, a value that does not match the column type, or a missing required column throws `SyncularError` with code `sync.invalid_request`, and nothing is recorded. `delete` operations and base versions follow [Conflicts & optimistic writes](/concepts-conflicts/). `pendingCommitIds()` lists the commits the outbox still holds.

## Read

```dart title="read.dart"
final states = client.readRows('todos');
final rows = client.query(
  'SELECT id, title, done FROM todos WHERE list_id = ?',
  params: ['groceries'],
);
final snap = client.querySnapshot('SELECT id FROM todos');
```

- **`readRows`**: `RowState` maps `{rowId, version, values}`. `version == -1` marks an optimistic row.
- **`query`**: read-only SQL over the local tables, returned as `List<Map<String, Object?>>`. SQL that writes is refused.
- **`querySnapshot`**: rows, window coverage, and the local revision from one read transaction.

Generated named queries (`syncular generate` with a `queriesPath` output) give typed wrappers; see [Named queries](/tooling-queries/).

## Windows

`setWindow(variable, units, fixedScopes: ...)` sets the values of a window base, one unit per value; widening bootstraps the new units and narrowing evicts the removed ones. `windowState(variable, fixedScopes: ...)` returns a `WindowState` with `units`, `pending`, and `complete(unit)`. Render a pending unit as loading, because registration alone does not mean the unit has its rows. [Windowed sync](/concepts-windowing/) defines the window base. Swift and Kotlin expose the same typed `setWindow` and `windowState`.

## Collaborative text

A `crdt` column exposes text helpers (they need a core built with `crdt-yjs`):

```dart title="notes.dart"
final text = client.crdtText('notes', 'n1', 'doc');
client.crdtInsertText('notes', 'n1', 'doc', 0, 'Hi ');
client.crdtDeleteText('notes', 'n1', 'doc', 0, 3);
```

`crdtApplyUpdate` accepts a Yjs update as a `List<int>`. `crdtText` returns the current text; each of the other helpers returns the enqueued commit id. The merge model is on [CRDT columns](/concepts-crdt/).
