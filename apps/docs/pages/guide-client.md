# Web client

The client core (`@syncular/client`) is plain library code:
storage behind a `ClientDatabase`, network behind transport seams, multi-tab
ownership behind a leader lock. It runs on whatever thread you construct it on.
Local SQL is the query API — you read your own tables directly.

## The two browser modes

There is **one persistent browser mode**, and it is the default: the whole
core runs in a Web Worker on sqlite-wasm over the `opfs-sahpool` VFS
([direction decision 2](../../REVISE.md#direction-decisions-2026-07-03-confirmed-by-benjamin)).
SAHPool needs no COOP/COEP and no SharedArrayBuffer. The UI thread drives the
worker through a thin RPC handle:

```ts
import { createSyncClientHandle } from '@syncular/client';
import { schema } from './syncular.generated';

const handle = await createSyncClientHandle({
  worker: () => new Worker('/worker.js', { type: 'module' }),
  schema,
  database: { mode: 'persistent', name: 'my-app' }, // OPFS
  endpoints: {
    syncUrl: '/sync',
    segmentsUrl: '/segments',
    realtimeUrl: 'wss://…/realtime?clientId={clientId}',
  },
});
```

The worker bundle is one line — it boots the whole core:

```ts
// worker.ts
import { startSyncWorker } from '@syncular/client/worker';
startSyncWorker();
```

The **ephemeral mode** is explicit and in-memory only — for tests, demos, and
SSR. It runs the core on the main thread against `openWasmDatabase()` (always
`:memory:`); nothing survives a reload. Browsers without OPFS are unsupported
and fail loud — there is no IndexedDB fallback.

> The [quickstart](/quickstart/) uses a third backend, `openBunDatabase()` from
> `@syncular/client/bun`, so the same core runs in a terminal with no
> browser. Same `SyncClient`, different `ClientDatabase`.

## Transports

The browser bindings are `fetch`/WebSocket wrappers over the protocol
([SPEC §1.1](../../SPEC.md#11-endpoints)):

- `httpSyncTransport(syncUrl)` — `POST /sync` with SSP2 bodies.
- `httpSegmentDownloader(segmentsUrl)` — direct download plus the signed-URL
  capability (advertises accept bit 3 when present).
- `httpBlobTransport(blobsUrl)` — blob upload/download ([Blobs](/concepts-blobs/)).
- `webSocketRealtimeConnector(realtimeUrl)` — the realtime channel.

Core tests never use these (the loopback doctrine); the worker handle wires
them for you from the `transport` config above.

## The sync loop

Connect the socket, then run the first round over it — the
[connect-then-sync](/concepts-realtime/) boot order:

```ts
await client.start();
client.subscribe({ id: 'notes', table: 'notes', scopes: { list_id: [listId] } });
await client.connectRealtime();
await client.syncUntilIdle();
```

After that, deltas arrive on their own. Provide `onSyncNeeded` to run a `sync()`
when a wake-up fires. In worker mode the host loop (auto-sync + jitter) runs
inside the worker; you just react to change notifications and re-query.

## Offline replay

Take the transport offline and keep calling `mutate` — the outbox accumulates,
your local reads stay live. On reconnect, the next `sync()` drains the outbox
with [idempotent retry](/concepts-commits/); applied commits leave the outbox,
conflicts and rejections surface. Nothing is lost across a schema upgrade: the
outbox is schema-agnostic and re-encodes at send time.

The [demo app](../../apps/demo) exercises all of this live — two panes with
offline toggles, a pending-commit counter, surfaced conflicts, and file
attachments — and the [web-client README](../../packages/web-client) is the
API reference.

## React bindings & live queries

`@syncular/react` ships live queries over **fine-grained invalidation**:
every apply batch emits exactly one `{ tables, scopeKeys }` event, and
`useSyncQuery(sql, params?)` re-runs only when a table it depends on is
touched — never "re-run everything on any change". `SyncProvider` accepts
either a `SyncClient` or the worker handle; the other hooks are `useMutation`,
`useSyncStatus`, `useConflicts`, and `usePresence`. The granularity contract
(tables are the reliable floor; scope-key narrowing only where the wire
carried keys) is documented in the
[react package](../../packages/react/README.md).

## Three read tiers

Reads are local SQL by design, and syncular gives you three tiers over the
same `query(sql, params)` surface — pick the one that fits, mix freely:

1. **Named queries** (`.sql` → typed functions) — the type-safe default. You
   write a `.sql` file; typegen transpiles it into a typed function on **every**
   platform (TS/Swift/Kotlin/Dart), killing query↔type drift by construction.
   Cross-platform and byte-exact.
2. **Kysely** (TS only) — the dynamic tier, for reads whose shape is built at
   runtime (dynamic filters, composed builders). Fully typed by the generated
   `Database` interface.
3. **Raw `query(sql, params)`** — the escape hatch. Always there; no typing,
   no ceremony.

Writes are never a read tier — they go through `client.mutate()` (the outbox,
[SPEC §7.1](../../SPEC.md)), on every tier.

## Named queries (typed `.sql`)

Drop a `.sql` file in `queries/` next to your migrations (one file = one
query) and typegen emits a typed function per platform. The query is
type-checked **by SQLite itself** at generate time — a bad column reference is
a build error — and the projection gets its own typed row.

```sql
-- queries/list-todos.sql
-- :listId infers to the todos.list_id column's type (TEXT).
SELECT id, title, done, position
FROM todos
WHERE list_id = :listId
ORDER BY position, id
```

```ts
import { listTodosQuery, type ListTodosRow } from './syncular.queries';
import { useNamedQuery } from '@syncular/react';

const { rows } = useNamedQuery(listTodosQuery, { listId }); // ListTodosRow[]
```

The same `queries/list-todos.sql` also produces `SyncularSchemaQueries.listTodos(
client:listId:)` in Swift, `.listTodos(client, listId)` in Kotlin, and
`syncularListTodosQuery(client, listId:)` in Dart — one source, five typed
call sites, no drift. Named params (`:name`) get their types **inferred** from
comparisons against columns (or declared with a `-- param :name <type>` header
when ambiguous), and each query bakes in its exact table-dependency set for
`useNamedQuery`'s invalidation. Full contract (typing-fidelity table, the
tables-set mechanism and its honesty boundary) in the
[typegen README §6](../../packages/typegen/README.md).

## Typed reads (Kysely)

Local SQL is the query API by design. `@syncular/kysely` is the **dynamic
typed read tier**: a [Kysely](https://kysely.dev) dialect typed by the
`Database` interface `@syncular/typegen` emits from your schema.

```ts
import { Kysely } from 'kysely';
import { SyncularDialect } from '@syncular/kysely';
import type { Database } from './syncular.generated';

const db = new Kysely<Database>({ dialect: new SyncularDialect({ client }) });
const rows = await db
  .selectFrom('todos')
  .selectAll()
  .where('list_id', '=', 'demo')
  .execute(); // fully typed, no `any`
```

Two rules make it honest:

- **Reads only.** A Kysely INSERT/UPDATE/DELETE would write the local mirror
  directly and bypass the sync outbox ([SPEC §7.1](../../SPEC.md)). The dialect
  rejects any non-SELECT (and any transaction) loudly — do writes with
  `client.mutate()`, always.
- **Every host.** The dialect drives a host's `query(sql, params)` method — the
  one surface every host exposes: the direct `SyncClient`, the worker handle,
  the multi-tab follower, and the Tauri / React Native bridges. It never
  touches a `ClientDatabase`, so the handle hosts (which expose only `query`)
  are first-class. It ships as its own package, so Kysely never enters the
  client-core bundle.

In React, `@syncular/react/typed`'s `useTypedQuery(db => db.selectFrom(…))`
compiles a builder and re-runs it live, extracting the `{tables}` dependency
set from the compiled query's AST — exact invalidation with no SQL-text
heuristic. See the [react package](../../packages/react/README.md) and the
[hooks demo](../../apps/demo-react/README.md).

## Multi-tab

`createSyncClientHandle({ multiTab: true })` gives N tabs one core: the tab
holding the Web Locks leader lock spawns the worker (one sync loop, one
WebSocket, one OPFS database), and every other tab becomes a **follower**
proxying the identical async API over BroadcastChannel, with the leader's
events fanned out to all tabs. When the leader closes, a follower promotes in
place over the same OPFS database — the handle object survives, `role` flips
to `'leader'`, and `onRoleChange` fires, so a React provider keeps a stable
ref. All tabs share the leader's one connection, so a device is exactly one
presence peer.

## Tauri (native desktop/mobile)

For a [Tauri](https://tauri.app) app, syncular runs as a **native instance in
the host process** — not JS in the webview. Webview OPFS is eviction-prone and
inconsistent across WKWebView/webkitgtk; the Rust core gives a real on-disk
SQLite database and native performance. `tauri-plugin-syncular` (Rust) runs the
`syncular-client` core directly and exposes it to the webview as commands +
events; `@syncular/tauri` (JS) bridges that surface into the SAME
`SyncClientLike` the React hooks consume — so every hook works unchanged.

```rust
// src-tauri: register the plugin with a persisted db path + server URL
app.handle().plugin(tauri_plugin_syncular::init(SyncularConfig {
    base_url: Some("https://your.server".into()),
    db_path,          // under the app-data dir → survives restarts
    auto_sync: true,  // §8.4 background host loop
    ..Default::default()
}))?;
```

```ts
// webview: same hooks, native core behind them
import { createTauriSyncClient } from '@syncular/tauri';
const client = await createTauriSyncClient({ clientId: 'device-1', schema });
// <SyncProvider client={client}> … useSyncQuery / useMutation / usePresence
```

Every `useSyncQuery` run is one Tauri IPC round trip — fine for view queries;
for very large result sets, paginate with `LIMIT`/`OFFSET` in your SQL. See
[bindings/tauri/README.md](../../bindings/tauri/README.md) for the architecture,
the command/event surface, and the thread-safety model.

## Windowed sync

The client can hold a **partial local replica** — set the live scope values
with `client.setWindow(...)` (or the `useWindow` hook), and syncular bootstraps
what enters and evicts what leaves, with a completeness oracle so a query over
un-held data is flagged partial rather than served as complete. Shipped in W1;
see [Windowed sync](./concepts-windowing.md).

