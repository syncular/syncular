# Reads & writes (Flutter)

Subscribe to data, write it optimistically, and read it back with `readRows`, `query`, or `querySnapshot`.

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

A subscription is an id, a table, and a scope map. It is local; the next sync round fills it. [Scopes & authorization](/concepts-scopes/) defines the scope vocabulary.

```dart title="subscribe.dart"
client.subscribe('todos', 'todos', scopes: {'list_id': ['groceries']});
client.unsubscribe('todos');
```

`subscriptionState(id)` returns `active`, `revoked`, or `failed`. Repeating a subscribe with the same definition is a no-op; a different definition under an existing id throws. The generated `syncular.generated.dart` carries a typed row class and a subscription helper per table declared in `syncular.json`.

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

`setWindow(base, units)` sets the active window of a windowed table; widening bootstraps the new units and narrowing evicts the removed ones. `windowState(base)` returns a `WindowState` with `units`, `pending`, and `complete(unit)`. Render a pending unit as loading, because registration alone does not mean the unit has its rows. [Windowed sync](/concepts-windowing/) defines the base descriptor. Swift and Kotlin reach the same commands through `command("setWindow", ...)`.

## Collaborative text

A `crdt` column exposes text helpers (they need a core built with `crdt-yjs`):

```dart title="notes.dart"
final text = client.crdtText('notes', 'n1', 'doc');
client.crdtInsertText('notes', 'n1', 'doc', 0, 'Hi ');
client.crdtDeleteText('notes', 'n1', 'doc', 0, 3);
```

`crdtApplyUpdate` accepts a Yjs update as a `List<int>`. Each helper returns the enqueued commit id. The merge model is on [CRDT columns](/concepts-crdt/).
