# Tauri: reads & writes

Subscribe to rows, read them from the native database, write through
`mutate`, and follow commits to their final result. You finish knowing which
bridge calls read, which write, and how the webview learns about changes.

::meta{for="Developers using the Tauri client from a webview" time="7 minutes" first="platform-tauri-install" spec="5.10"}

:::terms
- **Query snapshot**: Rows, window completeness, and the local revision from one SQLite read.
- **Change batch**: One exact, revisioned set of table, scope, and window changes.
- **Outcome journal**: The native SQLite record of each commit's final server result.
:::

:::figure{title="A read and a write over IPC" note="Both stay local" ticks}
<div class="d-row">
<div class="node ok"><span class="t">Webview · read</span><code>client.query(sql)</code></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Read owner</span>Read-only SQLite connection</div>
</div>
<div class="d-row">
<div class="node hot"><span class="t">Webview · write</span><code>client.mutate([...])</code></div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">Mutable owner</span>Applies locally, queues the commit</div>
</div>

::caption[A file-backed plugin serves reads from the independent read owner, so network work on the mutable owner cannot stall a read. An in-memory database reads through the mutable owner.]
:::

:::::steps
::::step{title="Subscribe and query" time="2 min"}
```ts title="src/todos.ts"
await client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });
await client.syncUntilIdle();

const rows = await client.query('SELECT id, title FROM todos ORDER BY id');
```

`query` returns a local snapshot. It does not push updates; use `onChange` for
that.

::checkpoint[`rows` holds the todos of the `groceries` list.]
::::

::::step{title="Observe changes" time="2 min"}
`onChange` delivers a revisioned change batch for each observer transaction and
returns an unsubscribe function:

```ts title="src/todos.ts"
const stop = client.onChange((batch) => {
  // batch.tables, batch.windows, batch.revision
  void refreshTodos();
});

// when the component is disposed:
stop();
```

Remove listeners when their component is disposed, and call `client.close()`
when the app releases the shared client.

::checkpoint[Writing a row from another client calls your listener after the next round.]
::::

::::step{title="Write with mutate" time="2 min"}
```ts title="src/todos.ts"
const commitId = await client.mutate([
  { table: 'todos', op: 'upsert', values: { id: crypto.randomUUID(), list_id: 'groceries', title: 'hi', done: false } },
]);
```

`mutate` applies locally at once and queues the commit for the next push. It
resolves with the client commit id.

::checkpoint[The next `client.query` returns the row, offline too.]
::::
:::::

## Snapshots

`querySnapshot` reads rows, window completeness, and the exact local revision in
one IPC round trip. `snapshotRead({ statements, coverage })` reads several SQL
statements, plus catch-up and delivery state, in one read transaction at one
revision. The bridge decodes every row. React hooks use these paths, so a view
needs them only when you build your own reactive layer.

## Durable outcomes

The bridge exposes the native outcome journal through `commitOutcome`,
`commitOutcomes`, and `resolveCommitOutcome`. They survive restarts. React
observes the journal with `useCommitOutcomes()`; see
[React: realtime & lifecycle](/platform-react-realtime/#follow-a-write-to-its-outcome).

## Collaborative text

With the plugin's `crdt-yjs` feature, the bridge exposes `crdtText`,
`crdtInsertText`, `crdtDeleteText`, and `crdtApplyUpdate`. They are
byte-compatible with the web `@syncular/crdt-yjs` helper, so a Tauri app and a
browser can edit the same document. See [CRDT columns](/concepts-crdt/).

## Windows and local purge

`setWindow(base, units)` holds a partial replica; see
[Windowed sync](/concepts-windowing/). `purgeLocalData({ purgeId, targets })`
crosses the command bridge to the native core with the semantics defined in
[Authorized local purge](/concepts-local-data-purge/).

## Encrypted schemas

Build the plugin with its `e2ee` feature and pass the portable keyring the
browser worker accepts:

```ts title="src/sync.ts"
const client = await createTauriSyncClient({
  schema,
  encryption: {
    keys: { 'key-2026-07': activeKey, 'key-2026-06': previousKey },
    keyIdColumns: { patient_notes: 'encryption_key_id' },
  },
});
```

Raw keys cross only into the native command core and never reach the server. See
[Encryption keys](/concepts-encryption/#encryption-keys).
