# Web (browser)

How to run the syncular client in a browser: the whole core in a Web Worker
on SQLite (WASM) over OPFS, with the page holding a thin RPC handle. By the
end you have a persistent, offline-capable local database that syncs in the
background, plus the ephemeral and Node/Bun variants of the same core.

The client core (`@syncular/client`) is plain library code: storage behind a
`ClientDatabase`, network behind transport seams, multi-tab ownership behind a
leader lock. Local SQL is the query API — you read your own tables directly.

## Install

```sh
bun add @syncular/client   # or: npm install @syncular/client
```

## The architecture: whole core in a worker

There is one persistent browser mode, and it is the default: the entire
client core (`SyncClient`, the fetch/WebSocket transports, and SQLite on the
`opfs-sahpool` VFS) runs inside a Web Worker. SAHPool needs no COOP/COEP
headers and no SharedArrayBuffer. The UI thread drives the worker through a
thin postMessage RPC handle.

The worker bundle is one line that boots the whole core:

```ts
// worker.ts
import { startSyncWorker } from '@syncular/client/worker';
startSyncWorker();
```

On the main thread, `createSyncClientHandle` spawns that worker and returns
the handle:

```ts
// main thread
import { createSyncClientHandle } from '@syncular/client';
import { schema } from './syncular.generated';

const handle = await createSyncClientHandle({
  worker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  schema,
  database: { mode: 'persistent', name: 'my-app' }, // OPFS, survives reloads
  endpoints: {
    syncUrl: '/sync',
    segmentsUrl: '/segments',
    realtimeUrl: 'wss://example.com/realtime?clientId={clientId}',
  },
  autoSync: true,
});
```

The handle exposes the same logical API as `SyncClient` (`subscribe` /
`mutate` / `sync` / `query` / conflicts / …), every method a promise. It
acquires the Web Locks leader lock before spawning the worker, so there is one
core per origin. Wake-ups are handled inside the worker (with `autoSync` the worker
IS the sync host); the main thread gets `onSyncNeeded` / `onConflict` /
`onSynced` events for rendering.

## Reads & writes

Reads are local SQL against your own tables; every write goes through
`mutate`, which queues it in the outbox:

```ts
await handle.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['l1'] } });
await handle.syncUntilIdle();

const rows = await handle.query('SELECT id, title FROM todos ORDER BY id');
await handle.mutate([
  { table: 'todos', op: 'upsert', values: { id: crypto.randomUUID(), list_id: 'l1', title: 'hi', done: false } },
]);
```

For typed reads (generated `.sql` queries) see
[Named queries](/tooling-queries/). For React live queries see
[React](/platform-react/). During development, use the
[schema-aware Vite owner recipe](/guide-vite/#keep-one-schema-correct-persistent-owner-during-hmr)
so query HMR cannot outpace the worker's generated schema; the
[official React example](https://github.com/syncular/syncular/blob/main/apps/demo-react/src/frontend/main.tsx)
uses that exact record.

Schema-declared [local FTS5 projections](/tooling-local-search/) are ordinary
local read targets too. They are built and maintained inside the worker-owned
SQLite database and invalidate through their synced owner table.

## Ephemeral mode (explicit, in-memory)

The only main-thread mode is ephemeral: `openWasmDatabase()` returns an
in-memory sqlite-wasm database for tests, demos, and SSR. Memory storage is
wiped on every reload, which is the point of that mode.

```ts
import { SyncClient } from '@syncular/client';
import { openWasmDatabase } from '@syncular/client/wasm';

const client = new SyncClient({ database: await openWasmDatabase(), schema, /* … */ });
```

`openPersistentWasmDatabase` refuses to run on the main thread; this enforces
the whole-core-in-a-worker architecture.

## Transports

The browser bindings are `fetch`/WebSocket wrappers over the protocol
([SPEC §1.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md)):

- `httpSyncTransport(syncUrl)` — `POST /sync` with protocol bodies.
- `httpSegmentDownloader(segmentsUrl)` — direct segment download plus the
  signed-URL capability.
- `httpBlobTransport(blobsUrl)` — blob upload/download ([Blobs](/concepts-blobs/)).
- `webSocketRealtimeConnector(realtimeUrl)` — the realtime channel.

The worker handle wires all of them for you from the `endpoints` config; you
only construct transports by hand when building a direct `SyncClient`.

## Realtime lifecycle and the sync loop

Install the supported supervisor after registering subscription intent:

```ts
import {
  browserConnectivitySignal,
  documentLifecycleSignal,
  installRealtimeSupervisor,
} from '@syncular/client';

await handle.subscribe({ id: 'todos', table: 'todos', scopes });
installRealtimeSupervisor(handle, {
  connectivity: browserConnectivitySignal(),
  lifecycle: documentLifecycleSignal(),
});
```

The supervisor owns initial connect, socket-close reconnect, bounded retry,
background/offline suspension, cancellation on close, and an explicit catch-up
before publishing `connected`. Render local rows immediately instead of
blocking startup on a network promise.

After connection, deltas arrive over the socket and server wake-ups raise an
immediate sync intent. With `autoSync`, the worker owns coalescing those
intents; the page reacts to revisioned changes and re-queries. The supervisor
is still required for reconnect policy. HTTP sync remains available while the
socket is absent, but it is not continuous remote convergence unless a host
event, deadline, or explicit command actually starts a round. On a direct
`SyncClient`, provide `onSyncNeeded` and run `sync()` when it fires.

## Offline replay

Take the network away and keep calling `mutate`: the outbox accumulates
and your local reads stay live. On reconnect, the next sync drains the outbox
with [idempotent retry](/concepts-commits/); applied commits leave the outbox,
conflicts and rejections surface. Nothing is lost across a schema upgrade: the
outbox is schema-agnostic and re-encodes at send time.

The [demo app](https://github.com/syncular/syncular/tree/main/apps/demo)
exercises all of this live: two panes with offline toggles, a pending-commit
counter, surfaced conflicts, and file attachments.

## Multi-tab

`createSyncClientHandle` gives N tabs one core by default: the tab holding
the Web Locks leader lock spawns the worker (one sync loop, one WebSocket,
one OPFS database), and every other tab becomes a follower proxying the
identical async API over BroadcastChannel, with the leader's events fanned
out to all tabs. When the leader closes, a follower promotes in place over
the same OPFS database: the handle object survives, `role` flips to
`'leader'`, and `onRoleChange` fires, so a React provider keeps a stable
reference. All tabs share the leader's one connection, so a device is exactly
one presence peer.

Pass `multiTab: false` to opt out: a losing tab is then a
`role === 'follower'` handle whose calls reject with `client.not_leader`, a
defined state your code can detect and render. Use this when your app must
run in exactly one tab and any second tab should show a "already open
elsewhere" screen.

## Windowed sync

The client can hold a partial local replica: set the live scope values
with `setWindow(base, units)` and syncular bootstraps what enters and evicts
what leaves, with a completeness oracle (`windowState`) that flags a query
over un-held data as partial. See
[Windowed sync](/concepts-windowing/).

## Authorized local purge

Direct clients and worker/multi-tab handles expose
`purgeLocalData({ purgeId, targets })`. Use it only after validating a
server-authoritative revocation directive and gating subscriptions that could
download the rows again. The client removes matching rows, FTS documents,
unsafe pending commits, and blob references atomically. See
[Authorized local purge](/concepts-local-data-purge/).

For quarantine-before-data, create the direct client or Worker handle with
`securityPreflight: true`, apply the validated purge, then call
`activateSecurity({ encryption })`. Protected work and automatic host-loop
sync fail with `client.security_preflight_required` until activation.
`beginSecurityPreflight()` gates new work immediately and drains in-flight
database/network work before releasing the old keyring. A follower request
applies to the one shared origin leader.

## Node and Bun backends

The same core runs outside the browser (a CLI, a plain Node service, an
Electron main process) by swapping the database backend:

```ts
import { SyncClient } from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';   // bun:sqlite
// or:
import { openNodeDatabase } from '@syncular/client/node'; // better-sqlite3

const client = new SyncClient({ database: openNodeDatabase('app.db'), schema, /* … */ });
```

Both default to `:memory:`; pass a path to persist. `better-sqlite3` is an
optional peer dependency, so browser-only apps skip the native build entirely;
`openNodeDatabase()` throws a clear error if the peer is missing
(`npm install better-sqlite3`). The [quickstart](/quickstart/) runs this exact
shape in a terminal.

## Browser support

There is a single support floor and a single persistence path:

- Persistence is OPFS via `opfs-sahpool`. It needs no COOP/COEP headers and
  no SharedArrayBuffer.
- Browsers without OPFS (~pre-2023) are unsupported:
  `openPersistentWasmDatabase` throws immediately on them.
- OPFS is the only persistence path. The client does not touch IndexedDB, and
  a wa-sqlite/absurd-sql style fallback is not planned.
- A temporarily occupied SAH pool fails with retryable
  `client.storage_busy`; missing/obsolete OPFS APIs fail with non-retryable
  `client.storage_unavailable`. Never wipe a database merely because its live
  owner has not released it yet; retry after the owner closes.

## Where to go next

- [React](/platform-react/) — live queries and the hook surface over this client.
- [Realtime](/concepts-realtime/) — the connect-then-sync boot order and wake-ups.
- [Named queries](/tooling-queries/) — typed `.sql` reads on every platform.
- [Local full-text search](/tooling-local-search/) — offline FTS5 over synced rows.
- [`@syncular/client` README](https://github.com/syncular/syncular/tree/main/packages/web-client) — the full API reference, including blob caching and the RPC protocol.
