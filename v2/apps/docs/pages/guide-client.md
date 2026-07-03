# Web client

The client core (`@syncular-v2/web-client`) is plain library code:
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
import { createSyncClientHandle } from '@syncular-v2/web-client';
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
import { startSyncWorker } from '@syncular-v2/web-client/worker';
startSyncWorker();
```

The **ephemeral mode** is explicit and in-memory only — for tests, demos, and
SSR. It runs the core on the main thread against `openWasmDatabase()` (always
`:memory:`); nothing survives a reload. Browsers without OPFS are unsupported
and fail loud — there is no IndexedDB fallback.

> The [quickstart](/quickstart/) uses a third backend, `openBunDatabase()` from
> `@syncular-v2/web-client/bun`, so the same core runs in a terminal with no
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

`@syncular-v2/react` ships live queries over **fine-grained invalidation**:
every apply batch emits exactly one `{ tables, scopeKeys }` event, and
`useSyncQuery(sql, params?)` re-runs only when a table it depends on is
touched — never "re-run everything on any change". `SyncProvider` accepts
either a `SyncClient` or the worker handle; the other hooks are `useMutation`,
`useSyncStatus`, `useConflicts`, and `usePresence`. The granularity contract
(tables are the reliable floor; scope-key narrowing only where the wire
carried keys) is documented in the
[react package](../../packages/react/README.md).

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
events; `@syncular-v2/tauri` (JS) bridges that surface into the SAME
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
import { createTauriSyncClient } from '@syncular-v2/tauri';
const client = await createTauriSyncClient({ clientId: 'device-1', schema });
// <SyncProvider client={client}> … useSyncQuery / useMutation / usePresence
```

Every `useSyncQuery` run is one Tauri IPC round trip — fine for view queries;
for very large result sets, paginate with `LIMIT`/`OFFSET` in your SQL. See
[bindings/tauri/README.md](../../bindings/tauri/README.md) for the architecture,
the command/event surface, and the thread-safety model.

## Roadmap

**Windowed sync / local eviction** is designed
([DESIGN-eviction.md](../../DESIGN-eviction.md)) but not yet shipped. A typed
Kysely query layer over the generated row types is a follow-up — reads are raw
SQL today.
