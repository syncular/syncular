# Browser: platform specifics

How the browser SDK behaves under the handle: the worker architecture, storage
durability, multi-tab ownership, the support floor, and the non-persistent
modes. Read it when you debug startup, storage, or tab behavior; the task pages
do not need it.

::meta{for="Developers debugging or hardening a browser deployment" time="15 minutes" first="platform-web-install" spec="1 8"}

:::terms
- **SAH pool**: The `opfs-sahpool` VFS, which keeps `FileSystemSyncAccessHandle`s open on the database files.
- **Leader lock**: The Web Locks lock that elects one owning tab per origin.
- **Best-effort bucket**: The origin storage class the browser may evict under pressure.
- **Replica**: One local database plus the lock and channel that guard it.
:::

## Architecture

There is one persistent browser mode. The whole client core (`SyncClient`, the
fetch and WebSocket transports, and SQLite on the `opfs-sahpool` VFS) runs
inside a Web Worker. The page drives it through a thin `postMessage` RPC handle.

:::figure{title="Ownership layers" note="Lock, worker, files" ticks}
<div class="d-stack">
<div class="node"><span class="t">Web Locks lock</span>Elects the leader tab for the origin</div>
<div class="d-down">▼ spawns<small>only the leader</small></div>
<div class="node hot"><span class="t">Worker</span>Holds a Web Lock for its OPFS directory while SQLite handles are open</div>
<div class="d-down">▼ opens</div>
<div class="node ok"><span class="t">SAH pool</span>Open access handles on the database files</div>
</div>

::caption[Closing the database pauses the SAH pool before it releases the directory lock, so the next owner never sees held handles.]
:::

Page teardown terminates the worker, including a worker that is still
bootstrapping. The next document waits for the physical owner to release its
handles. A live second tab uses the existing leader and follower state and takes
over after the leader closes or reloads.

Worker RPCs keep serving local mutations and queries while a sync response is
pending. Commits authored after request capture enter the next round.

## Transports

The browser bindings wrap `fetch` and WebSocket over the protocol
([SPEC §1.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md)):

| Binding | Does |
|---|---|
| `httpSyncTransport(syncUrl)` | `POST /sync` with protocol bodies. |
| `httpSegmentDownloader(segmentsUrl)` | Direct segment download plus the signed-URL capability. |
| `httpBlobTransport(blobsUrl)` | Blob upload and download ([Blobs](/concepts-blobs/)). |
| `webSocketRealtimeConnector(realtimeUrl)` | The realtime channel. |

The worker handle wires all four from the `endpoints` config. Construct them by
hand only for a direct `SyncClient`.

## Eviction-resistant storage

OPFS survives ordinary reloads, but it uses the origin's best-effort storage
bucket until the browser grants persistence. Under storage pressure the browser
can evict a best-effort origin, deleting the SQLite database and every pending
outbox commit together.

Check the state at startup. Request persistence from a user action near the
first important offline write, or when the user enables offline work:

```ts title="src/storage.ts"
import {
  checkBrowserStoragePersistence,
  requestBrowserStoragePersistence,
} from '@syncular/client';

let storagePersistence = await checkBrowserStoragePersistence();

protectOfflineDataButton.addEventListener('click', async () => {
  storagePersistence = await requestBrowserStoragePersistence();
  renderStoragePersistence(storagePersistence);
});
```

Both functions return `{ state: 'persistent' }` or a structured
`{ state: 'best-effort', reason }`. A denial is a valid browser policy decision,
and the database stays available. Show a visible warning whenever the result is
best effort and `pendingCommits()` is non-empty. An application whose offline
writes cannot accept that risk disables offline mutation until persistence is
granted.

Persistence applies to the origin's storage as a whole. It lowers the risk of
automatic eviction and cannot prevent a user from clearing site data. See the
[browser persistence API](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
and the [eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

## Multi-tab

`createSyncClientHandle` gives N tabs one core by default.

:::figure{title="Leader and followers" note="One core per origin"}
<div class="d-row">
<div class="d-stack">
<div class="node ok"><span class="t">Tab A · leader</span>Worker, one sync loop, one WebSocket, one OPFS database</div>
</div>
<div class="d-down">◀ BroadcastChannel ▶<small>calls and events</small></div>
<div class="d-stack">
<div class="node"><span class="t">Tab B · follower</span>Same async API, proxied</div>
<div class="node"><span class="t">Tab C · follower</span>Same async API, proxied</div>
</div>
</div>

::caption[All tabs share the leader's one connection, so a device is exactly one presence peer.]
:::

When the leader closes, a follower promotes in place over the same OPFS
database. The handle object survives, `role` flips to `'leader'`, and
`onRoleChange` fires, so a React provider keeps a stable reference. A visible
tab never takes leadership from a hidden leader: leadership moves only when the
leader tab closes and its Web Lock passes to a follower.

### Leader probes

A follower that has heard nothing from the leader for a third of
`followerCallTimeoutMs` (default 10 s) posts a probe on the channel, and the
leader's message handler answers it. Browsers throttle the timers of hidden tabs
but still deliver their channel messages, so a leader in a background tab keeps
every visible follower working.

When a probe stays unanswered for the rest of `followerCallTimeoutMs`,
`handle.leadership` becomes `blocked` with reason `leader-unreachable` and code
`client.follower_timeout`, and calls reject immediately. A hung or frozen leader
reaches this state within `followerCallTimeoutMs`. A blocked follower keeps
probing and rebinds when the leader answers. A forwarded call has no deadline of
its own: the leader's core can run a follower's `setWindow` after a long
bootstrap download, and the follower waits while the leader answers probes. The
call rejects when the link blocks or another leader takes over.

### Build compatibility

Every message carries the tab's `MULTI_TAB_PROTOCOL_VERSION` and schema version.
A follower whose leader differs becomes `blocked` with reason
`leader-incompatible`, code `client.leader_incompatible`, and `leader: 'older'`
or `'newer'`. A leader that hears from a newer tab closes its core and releases
the lock, so the newer tab promotes and the older one stays blocked until it
reloads.

### Single-tab and isolated replicas

Pass `multiTab: false` when the app must run in exactly one tab. A losing tab is
then a `role === 'follower'` handle whose calls reject with `client.not_leader`,
a state your code can detect to show an "already open elsewhere" screen.

Set `replica: { mode: 'isolated', id }` to give a handle its own independently
owned replica. Shared mode is the default. `isolatedReplicaNames()` derives the
database name, database directory, lock name, and channel name from the replica
id by appending `--replica-<id>`; the id contains only letters, digits, `.`,
`_`, and `-`, or the call fails with `sync.invalid_request`.

## Support floor

| Property | Behavior |
|---|---|
| Persistence | OPFS through `opfs-sahpool`. It needs no COOP/COEP headers and no `SharedArrayBuffer`. |
| Browsers without OPFS | Unsupported. `openPersistentWasmDatabase` throws immediately. |
| Other storage | The client does not use IndexedDB. No wa-sqlite or absurd-sql style fallback is planned. |
| Storage class | OPFS starts in the best-effort bucket. Use the persistence calls above to establish and surface the browser's decision. |
| Missing OPFS APIs | Non-retryable `client.storage_unavailable`. |

### Startup retries

Persistent worker startup retries a retryable `client.storage_busy` up to six
times after the first attempt, retaining its leader lease and opening the same
directory. The delays are 50, 100, 200, 400, 800, and 1000 ms, a 2550 ms total
that browser scheduling and storage operations can extend. If ownership stays
unavailable, handle creation rejects with `client.storage_busy` and releases the
worker and the leader lease. Close the competing instance, then create the
handle again. Never wipe the database because its live owner has not released
it. Direct database opens make a single attempt. Every other startup error fails
immediately.

### Interrupted writes

The persistent binding enables SQLite's rollback-journal recovery before the
first SQL statement. It corrects the SAH-pool VFS's reserved-lock callback,
which otherwise reports an active writer after a worker crash and suppresses
recovery. The database format and the DELETE/FULL journal settings stay
unchanged, and the correction applies to existing replicas as well as new ones.

Browser regression tests interrupt image bootstrap during download, before
import, during a physical database write, after import, and after the
subscription checkpoint. They reload within the same browser session and check
SQLite integrity, FTS integrity, rows, and checkpoint recovery. Separate
contention tests require a successful startup when another owner closes during
retry, and a bounded `client.storage_busy` failure while that owner stays live.
Both preserve the replica identity and the pending outbox. A database with lost
or overwritten journal data needs separate recovery.

## Ephemeral mode

The only main-thread mode is ephemeral: `openWasmDatabase()` returns an
in-memory sqlite-wasm database for tests, demos, and SSR. Reload wipes it.

```ts title="src/test-client.ts"
import { SyncClient } from '@syncular/client';
import { openWasmDatabase } from '@syncular/client/wasm';

const client = new SyncClient({ database: await openWasmDatabase(), schema, /* transports */ });
```

`openPersistentWasmDatabase` refuses to run on the main thread, which enforces
the whole-core-in-a-worker architecture.

## Node and Bun backends

The same core runs outside the browser (a CLI, a plain Node service, an Electron
main process) with `openSqliteDatabase()` from `@syncular/client/sqlite` as the
database backend. [Quickstart](/quickstart/) runs this shape in a terminal, and
[Server-side sync clients](/guide-server-clients/) covers the complete service
lifecycle.
