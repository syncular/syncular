# Browser

`@syncular/client` runs the whole sync core in a Web Worker on SQLite (WASM)
over OPFS. The page holds a promise-based handle to it. This overview shows how
the pieces connect and the calls of a first sync; the pages after it cover each
task.

::meta{for="Web app developers using the TypeScript client" runs="TypeScript core in a Web Worker, SQLite WASM on OPFS" package="`@syncular/client`" threading="Core in the worker; page calls are promises over postMessage" time="4 minutes"}

:::terms
- **Handle**: The object `createSyncClientHandle` returns. It exposes the `SyncClient` API as promises.
- **Leader**: The one tab per origin that owns the worker, the database, and the socket.
- **Follower**: Any other tab. It proxies calls to the leader over a `BroadcastChannel`.
- **OPFS**: The browser's origin private file system, where the SQLite file lives.
:::

## How the pieces connect

:::figure{title="The browser SDK" note="One core per origin" ticks}
<div class="d-row">
<div class="d-stack">
<div class="node hot"><span class="t">Page · each tab</span>Your UI calls <code>handle.query</code>, <code>handle.mutate</code></div>
<div class="node"><span class="t">Follower tabs</span>Proxy the same API to the leader over <code>BroadcastChannel</code></div>
</div>
<span class="d-arrow"></span>
<div class="d-box">
<p class="d-label">Leader tab · Web Worker</p>
<div class="d-stack">
<div class="node hot"><span class="t">SyncClient</span>Outbox, subscriptions, sync rounds</div>
<div class="node ok"><span class="t">SQLite WASM</span><code>opfs-sahpool</code> file: rows, cursors, outbox</div>
</div>
</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Your server</span><code>fetch</code> for <code>/sync</code>, segments, blobs; one WebSocket for realtime</div>
</div>

::caption[The leader tab holds a Web Locks lock, spawns the worker, and runs the only sync loop, WebSocket, and OPFS connection for the origin. A follower promotes in place when the leader closes.]
:::

The worker entry is one line, `startSyncWorker()` from
`@syncular/client/worker`. The page side is `createSyncClientHandle`, which
takes a factory so the bundler sees `new Worker(new URL(...))` at the call site.
`opfs-sahpool` needs no COOP/COEP headers and no `SharedArrayBuffer`.

## First sync in four calls

[Install & first sync](/platform-web-install/) walks through the setup and the
generated schema. The shape of the calls:

```ts title="src/sync.ts"
import { createSyncClientHandle } from '@syncular/client';
import { schema } from './syncular.generated';

// 1. Create: spawns the worker and opens the OPFS database.
const handle = await createSyncClientHandle({
  worker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  schema,
  database: { mode: 'persistent', name: 'my-app' },
  endpoints: { syncUrl: '/sync', segmentsUrl: '/segments' },
});

// 2. Subscribe: which rows this device receives.
await handle.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });

// 3. Write: visible to local reads at once, queued in the outbox.
await handle.mutate([
  { table: 'todos', op: 'upsert', values: { id: crypto.randomUUID(), list_id: 'groceries', title: 'Hello', done: false } },
]);

// 4. Sync: push the outbox, pull new rows.
await handle.syncUntilIdle();
```

:::warning{title="Use a persistent database"}
`database: { mode: 'persistent' }` keeps rows, cursors, and the outbox across
reloads. The origin's storage is best-effort until the browser grants
persistence; [Platform specifics](/platform-web-specifics/#eviction-resistant-storage)
covers the check and the request.
:::

## The pages of this SDK

| Page | Type | You get |
|---|---|---|
| [Install & first sync](/platform-web-install/) | How-to | The package, the worker, the Vite config, and a first round against a server. |
| [Reads & writes](/platform-web-reads-writes/) | How-to | Subscriptions, local SQL reads, `mutate`, and the validation rules for authored values. |
| [Realtime & lifecycle](/platform-web-realtime/) | How-to | The realtime supervisor, the transport gate, sync progress, offline replay, and HMR handoff. |
| [Platform specifics](/platform-web-specifics/) | Reference | Persistent worker lifecycle, eviction-resistant storage, multi-tab, support floor, ephemeral and Node modes. |
| [Troubleshooting](/platform-web-troubleshooting/) | Reference | Segment transport failures, storage failures, and links to the shared failure catalog. |

The model behind the calls is shared across SDKs:
[Subscriptions & the outbox](/concepts-subscriptions/) defines it once. For
React hooks over this client, see [React](/platform-react/). The
[`@syncular/client` README](https://github.com/syncular/syncular/tree/main/packages/web-client)
documents the full API, including blob caching and the RPC protocol.
