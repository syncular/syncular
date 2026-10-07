# CRDT columns

Add a `crdt` column when two people edit the same document at the same time and both edits must survive. Every other column stays last-write-wins: the newest write to a column wins, and two writes from the same `baseVersion` conflict ([Conflicts](/concepts-conflicts/)). A `crdt` column carries collaborative state that the server merges on push, so concurrent edits converge to identical bytes. This page is for developers building collaborative text or shared state on any SDK.

::meta{for="App developers who need concurrent editing of one value" time="8 minutes" first="concepts-conflicts" spec="5.10 6.2"}

:::terms
- **CRDT**: A data type whose updates merge in any order to the same state.
- **`crdt` column**: A column whose value is opaque CRDT bytes that the server merges instead of overwriting.
- **`crdtType`**: The name that selects the server-side merger for a column. `yjs-doc` is the only built-in.
- **Merger**: The server function `merge(stored, incoming)` that a host registers per `crdtType`.
- **Crdt-only operation**: A sparse operation that presents only `crdt` columns beside the primary key. It never conflicts.
:::

:::figure{title="Two edits, one converged document" note="Same row, same column" ticks}
<div class="d-cols-2">
<div class="node"><span class="t">Client A, offline</span>inserts "Hello " at 0<br><span class="chip">crdt-only operation</span></div>
<div class="node"><span class="t">Client B</span>inserts "world" at 0<br><span class="chip">crdt-only operation</span></div>
</div>
<div class="d-cols-2">
<div class="d-down">▼ Pushes<small>a Yjs update</small></div>
<div class="d-down">▼ Pushes<small>a Yjs update</small></div>
</div>
<div class="node hot"><span class="t">Server</span>doc = merge(merge(stored, A), B)<br>The merge is commutative, associative, and idempotent</div>
<div class="d-down ok">▼ Delivers<small>the merged bytes as an ordinary row upsert</small></div>
<div class="d-cols-2">
<div class="node ok"><span class="t">Client A</span>Same bytes, same text</div>
<div class="node ok"><span class="t">Client B</span>Same bytes, same text</div>
</div>

::caption[Arrival order does not change the result, and a replayed update is a no-op, so an offline outbox replays safely.]
:::

## The `crdt` column

A `CRDT` column in your migration declares one. The codec treats it as an ordinary `bytes` column, so it flows through commits, pushes, and segments unchanged. The schema, apply, and query layers know to hand the stored and incoming bytes to a merger.

```sql title="migrations/001_notes.sql"
CREATE TABLE notes (
  id      TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title   TEXT NOT NULL,   -- ordinary last-write-wins column
  doc     CRDT             -- collaborative text; NULL is the empty document
);
```

A `crdt` column is never a primary key, a scope column, or an [encrypted column](/concepts-encryption/), because the server cannot merge ciphertext. Generated row types keep the column a plain `Uint8Array` (or the SDK's byte type); codegen has no Yjs dependency.

### Register the merger on the server

A column names a `crdtType` that selects the merger. The Yjs merger lives in its own package, `@syncular/crdt-yjs`, so `@syncular/core` and `@syncular/server` stay free of Yjs. A host opts in by registering it, the way it registers a blob store.

```ts title="src/server.ts"
import { yjsCrdtMergers } from '@syncular/crdt-yjs';

const config: SyncServerConfig = {
  // …schema, storage, resolveScopes…
  crdtMergers: yjsCrdtMergers, // { 'yjs-doc': yjsDocMerger }
};
```

A table with a `crdt` column and no registered merger fails every push that touches the column with `sync.crdt_merge_failed`, and the commit rolls back. A merger that throws produces the same rejection. The code is non-retryable and never reaches the pull stream; fix the server configuration. To add a custom type, spread `yjsCrdtMergers` and add your own function, which must be commutative, associative, and idempotent. [Server setup](/guide-server/) shows where `crdtMergers` sits in the capability object.

## How merges stay conflict-free

Two rules govern a push that touches a `crdt` column ([SPEC §5.10.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#5103-the-62-push-interaction--the-pinned-merge-semantics)):

1. **`baseVersion` governs only the non-crdt columns.** A `crdt` column is excluded from the optimistic-concurrency comparison, so it never produces `sync.version_conflict` on its own.
2. **On apply, each present `crdt` column becomes `merge(stored, incoming)`.** The server never stores the raw pushed bytes. The merge runs inside the commit transaction, so a failing merger rejects the whole commit.

A crdt-only operation has no comparable column. It never conflicts, with or without `baseVersion`, and it merges no matter how far the row's other columns have advanced.

:::figure{title="What a mixed operation does"}
<div class="d-cols-2">
<div class="node ok"><span class="t">Only crdt columns present</span>Merges cleanly<br><span class="chip ok">Applied</span></div>
<div class="node hot"><span class="t">Also a non-crdt column present</span>Optimistic concurrency on exactly those columns<br><span class="chip amber">Conflict if one moved past baseVersion</span></div>
</div>

::caption[On a conflict the server rolls back the whole commit and merges nothing. The conflict's `serverRow` carries the already-merged crdt state, so the rebase needs no extra round trip.]
:::

Subscribers receive the merged bytes as a normal row upsert with the incremented `server_version`. No CRDT-specific frame exists. A push replayed under its idempotency key returns the cached result and does not merge again; even if identical bytes arrived twice, the merger's idempotency makes the second merge a no-op.

## Edit a column from your SDK

Clients push updates, the server merges, and clients apply the merged state on delivery. The shared text inside a document has a name, `text` by default; every SDK that edits the same document must use the same name.

:::tabs
```ts sdk=web title="src/notes.ts"
import { YjsColumn } from '@syncular/crdt-yjs';

// Load the current merged bytes from the row, edit, push the sparse update.
const col = new YjsColumn(row.doc); // row.doc is Uint8Array | null
col.text().insert(0, 'Hello ');
client.patch('notes', row.id, { doc: col.columnBytes() });
// The operation presents only the crdt column, so it never conflicts.

// On delivery of the server-merged value, apply it back (idempotent).
col.applyServerBytes(updatedRow.doc);
console.log(col.text().toString());
```
```ts sdk=tauri title="src/notes.ts"
const text = await client.crdtText('notes', 'n1', 'doc');
await client.crdtInsertText('notes', 'n1', 'doc', 0, 'Hello ');
await client.crdtDeleteText('notes', 'n1', 'doc', 0, 6);
await client.crdtApplyUpdate('notes', 'n1', 'doc', updateBytes);
```
```ts sdk=react-native title="src/notes.ts"
const text = await client.crdtText('notes', 'n1', 'doc');
await client.crdtInsertText('notes', 'n1', 'doc', 0, 'Hello ');
await client.crdtDeleteText('notes', 'n1', 'doc', 0, 6);
await client.crdtApplyUpdate('notes', 'n1', 'doc', updateBytes);
```
```swift sdk=swift title="Notes.swift"
let text = try client.crdtText(table: "notes", rowId: "n1", column: "doc")
try client.crdtInsertText(table: "notes", rowId: "n1", column: "doc",
                          index: 0, value: "Hello ")
try client.crdtDeleteText(table: "notes", rowId: "n1", column: "doc",
                          index: 0, len: 6)
```
```kotlin sdk=kotlin title="Notes.kt"
val text = client.crdtText("notes", "n1", "doc")
client.crdtInsertText("notes", "n1", "doc", 0, "Hello ")
client.crdtDeleteText("notes", "n1", "doc", 0, 6)
```
```dart sdk=flutter title="lib/notes.dart"
final text = client.crdtText('notes', 'n1', 'doc');
client.crdtInsertText('notes', 'n1', 'doc', 0, 'Hello ');
client.crdtDeleteText('notes', 'n1', 'doc', 0, 6);
```
```rust sdk=rust title="src/notes.rs"
let text = client.crdt_text("notes", "n1", "doc", "text")?;
client.crdt_insert_text("notes", "n1", "doc", "text", 0, "Hello ")?;
client.crdt_delete_text("notes", "n1", "doc", "text", 0, 6)?;
```
:::

The web helper wraps a `Y.Doc` bound to one column value. `columnBytes()` returns the whole document state as one update, which the merger accepts because a state is a legal update. To push a smaller delta, diff with `Y.encodeStateAsUpdate(doc, stateVector)`.

Every native helper loads the row's current merged bytes, applies the edit with [`yrs`](https://crates.io/crates/yrs) (the Rust Yjs port), re-encodes the whole state, and pushes a crdt-only operation. Each edit helper returns the enqueued `clientCommitId`. Index and length count UTF-16 code units, and an out-of-range index fails with an error. A missing row or `NULL` column reads as the empty string. Every helper except `crdtApplyUpdate` takes an optional shared-text `name` (default `text`; Swift and Kotlin take it as a trailing parameter, Flutter as a named one, and the Rust methods take it positionally).

`crdtApplyUpdate(table, rowId, column, update)` applies an arbitrary Yjs update that your app produced with its own model (maps, arrays, XML). It takes the update as `Uint8Array`, `[UInt8]`, `ByteArray`, `List<int>`, or `&[u8]` per SDK.

[React](/platform-react/) apps use the web helper through the TypeScript client.

### Enable the `crdt-yjs` feature on native builds

The native helpers sit behind the `crdt-yjs` cargo feature, which is off by default so lean and offline builds skip `yrs`. Enable it on the crate that owns the core: `syncular-ffi` (the Swift, Kotlin, and Flutter bindings), `tauri-plugin-syncular` (Tauri), or `syncular-command` directly. Without it, every `crdt*` command fails with `client.crdt_unavailable` and the rest of the client runs normally.

Because `yrs` produces Yjs v1 update bytes, a native edit merges byte-identically with a `@syncular/crdt-yjs` edit on the server. A Rust app and a web app can edit the same document. The conformance suite proves convergence in both directions: a scenario has the Rust core author edits with `crdtInsertText` and `crdtDeleteText` while the TypeScript server merges them, then reverses the roles, and asserts identical bytes.
