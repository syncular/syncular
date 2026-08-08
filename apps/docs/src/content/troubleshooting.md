# Troubleshooting

The first-integration checklist: the symptoms integrators hit, what each one
means, and the fix.

## Error code index

Errors carry stable codes. Arriving from a stack trace, start here:

| Code | Meaning | Detail |
|---|---|---|
| `sync.invalid_request` naming `_sync_*` | A write carried an engine-owned column | [below](#syncinvalid_request-naming-an-_sync_-column) |
| `sync.outbox_incompatible` | A pending commit references a dropped column | [below](#syncoutbox_incompatible-rejections-after-a-schema-bump) |
| `sync.unknown_table` | A subscription names a table the schema retired | [Schema upgrades](/concepts-schema-upgrades/) |
| `sync.schema_not_ready` | The server booted without a readiness check | [Server setup](/guide-server/) |
| `sync.invalid_client_id` | A client id was reused under a different actor | [Seeding data](/server-operations/#seeding-data) |
| `sync.forbidden` | A write failed the scope check | [Scopes & authorization](/concepts-scopes/) |
| `sync.storage.scan_requires_scope` | A row scan omitted its mandatory scope filter | [Storage backends](/server-storage/#choosing-the-right-row-lookup) |
| `client.not_leader` | Another tab owns the origin leader lock | [below](#clientnot_leader-on-a-second-tab) |
| `client.storage_busy` | The OPFS pool is still held by another engine | [below](#clientstorage_busy-while-opening-the-app) |
| `client.worker_restart_required` | A stale dev-server worker graph | [below](#clientworker_restart_required-after-a-package-upgrade) |
| `client.decrypt_failed` | No key for an envelope's key id | [Encryption keys](/concepts-encryption-keys/) |
| `client.security_preflight_required` | Protected work before `activateSecurity` | [Authorized local purge](/concepts-local-data-purge/) |
| `client.local_data_purged` | A pending commit touched a purged target | [Authorized local purge](/concepts-local-data-purge/) |
| `client.crdt_unavailable` | The `crdt-yjs` feature is off in this build | [CRDT columns](/concepts-crdt/) |
| `client.identity_mismatch` | An explicit `clientId` differs from the database's | [Tauri](/platform-tauri/) |
| `operation.invalid_request` | A remote query without complete scope proof | [Remote server operations](/guide-remote-operations/) |
| `presence.forbidden` | A presence publish to an unheld scope key | [Realtime](/concepts-realtime/) |

The normative catalog is
[SPEC §10](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#10-errors).

## Debugging from the console

Every live client and handle on a dev page registers itself on
`window.__SYNCULAR__` (gated off when your bundler sets
`NODE_ENV=production`):

```js
await __SYNCULAR__.snapshot();
// [{ clientId, role, outbox, subscriptions, conflicts, rejections,
//    syncNeeded, upgrading, lastInvalidation }]

__SYNCULAR__.clients[0].ref; // the client itself: query it, sync it
await __SYNCULAR__.clients[0].ref.query('SELECT * FROM todos');
```

`lastInvalidation` carries the tables and scope keys of the most recent
apply batch, the fastest way to confirm data is arriving and your live
queries should have re-run.

## Enter/mutate silently does nothing

Seen in the dev loop: you restart the dev server while a tab stays open,
then adding an item does nothing: no new row, no error on screen. The old
page is still running against its old worker, and the worker's RPC (or its
transport session) is dead; every `mutate()` **rejects**, but an app that
never renders the failure can't show it, so the symptom reads as "the app
ignored me".

Two fixes, both worth doing:

- **Always render `useMutation().error`.** The hook catches the rejection
  and exposes it; an app that only calls `mutate` and drops the promise has
  no failure surface at all. The submit-wrapper pattern:

  ```tsx
  function AddForm() {
    const { mutate, isPending, error } = useMutation();
    const add = (title: string) =>
      void mutate([{ table: 'todos', op: 'upsert', values: /* … */ }]);
    return (
      <form onSubmit={/* … calls add() */}>
        <input name="title" />
        <button disabled={isPending}>add</button>
        {error !== undefined ? (
          <div className="error">write failed: {String(error)}</div>
        ) : null}
      </form>
    );
  }
  ```

  The scaffolded templates ship this shape; keep it when you grow the form.

- **Reload open tabs after a dev-server restart.** The served bundles and
  the worker changed under the page; a stale page over a fresh server is
  not a state the dev loop tries to preserve.

## Data is in the local database, the UI never updates

Reactive queries consume core-originated revisioned change batches and
schedule store reads with microtasks; correctness does not depend on animation
frames or document visibility. If a current client has committed local rows
but an observed generated query does not advance revision, capture the change
batch and query descriptor and report it as a parity/routing bug.

## A list switch is briefly `loading` or `partial`

Registration is not
completeness (§4.8): a newly claimed unit is pending until bootstrap finishes.
A generated `useQuery` reads rows and that verdict atomically, so render from
its `phase`; only `phase === 'ready' && rows.length === 0` is a truthful empty
list. Zero-row bootstrap completion advances the same snapshot to `ready`.
See [Windowed sync](/concepts-windowing/).

## `sync.invalid_request` naming an `_sync_*` column

`_sync_version` is the client engine's internal per-row version column.
`client.query()` strips `_sync_*` columns from results, so a `SELECT *` row
feeds straight back into `mutate()`; rows read through the raw
`client.database` tier keep them, and hand-built records can carry them by
accident. Remove the key, or better, use
`client.patch(table, rowId, partial)` for partial updates; it reads the
current row, merges, and emits the full-row upsert for you.

## `sync.outbox_incompatible` rejections after a schema bump

A pending offline commit references a column your new schema removed, so it
can no longer encode (§7.4.4). The commit leaves the outbox, its optimistic
rows are undone, and the rejection surfaces with this code; later commits
keep draining. This is the designed behavior for dropped columns; see
[Schema upgrades](/concepts-schema-upgrades/). If you hit it in development, wipe the
client database (below) and move on.

## `client.not_leader` on a second tab

Another tab holds this origin's leader lock and the handle was created with
`multiTab: false`. Multi-tab followers are the default: a losing tab proxies
the full API to the leader over a BroadcastChannel and promotes when the
leader closes. Remove the `multiTab: false` opt-out, or keep it and render
the not-leader state deliberately ("already open in another tab"). Details
in [Web (browser)](/platform-web/).

## `client.storage_busy` while opening the app

The OPFS SAH pool is still owned by another live engine, or a recently closed
worker has not released it yet. This is a retryable startup state, not evidence
of a corrupt database. Close the competing app/tab or wait briefly, then retry
the same client resource:

```tsx
<SyncProvider
  client={clientResource}
  fallback={<p>Opening local database…</p>}
  renderError={(error, retry) => (
    <button onClick={() => void retry()}>Try again: {error.message}</button>
  )}
>
  <App />
</SyncProvider>
```

Ordinary same-origin tabs are coordinated by Syncular's default multi-tab
mode. Collisions are most often caused by rapid hot-module replacement or by
embedded/test hosts that share OPFS without sharing the same Web Locks and
BroadcastChannel domain. Use the
[schema-aware Vite resource recipe](/guide-vite/#keep-one-schema-and-runtime-correct-persistent-owner-during-hmr):
it preserves one resource for ordinary HMR but disposes it before constructing
a replacement when the captured generated-schema version changes. The
[official React example](https://github.com/syncular/syncular/blob/main/apps/demo-react/src/frontend/main.tsx)
uses the same record and startup boundary.

Do **not** wipe or rename the OPFS directory for this error: it may contain the
healthy local replica and unsynced outbox. Missing/obsolete browser APIs use
the separate, non-retryable `client.storage_unavailable` code.

## Pending outbox on best-effort browser storage

`openPersistentWasmDatabase` means the SQLite database survives ordinary
reloads. Browser eviction resistance is a separate origin-level permission.
Use `checkBrowserStoragePersistence()` at startup and call
`requestBrowserStoragePersistence()` from a user action near the first
important offline write. If the result remains `best-effort`, warn whenever
the outbox is non-empty. Clearing or evicting the origin removes both the local
rows and the pending outbox.

Do not mirror the outbox into IndexedDB for this condition. IndexedDB and OPFS
share the origin storage policy and are deleted together when the origin is
evicted.

## Wiping OPFS for a clean test

The persistent worker database lives in the origin's OPFS. To reset a dev
client to factory state, run this in the console (with the app's tabs
closed, so the pool isn't held open):

```js
const root = await navigator.storage.getDirectory();
for await (const name of root.keys()) {
  await root.removeEntry(name, { recursive: true });
}
```

Clearing site data in devtools (Application → Storage → Clear site data)
does the same and also drops the leader lock.

## `client.worker_restart_required` after a package upgrade

The page tried to start a worker graph that still referred to a retired Vite
optimizer chunk. This is a development-host identity mismatch, not evidence of
replica corruption. Stop Vite, reinstall from the lockfile, restart once with
`--force`, and reload every open app tab. Do not clear OPFS: device identity,
subscription progress, and an unsynced outbox may live there.

Use `SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE` from `@syncular/react/vite` and the
schema-and-runtime-aware `retainViteSyncClientResource` recipe in the
[Vite guide](/guide-vite/). Current clients sanitize the original bundler text
and URL before surfacing this stable code, so support diagnostics do not retain
local paths or chunk names.

## Vite build errors mentioning sqlite-wasm or the worker

Two config lines fix both: `optimizeDeps.exclude` for
`@sqlite.org/sqlite-wasm` plus `SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE`, and
`worker.format: 'es'`. The full setup,
including the dev proxy for `/sync`, `/segments`, and the `/realtime`
WebSocket, is on the [Vite page](/guide-vite/).

## Tauri

Web and Tauri clients converge in both directions. They are separate local
replicas and therefore need distinct persisted client ids, but they must
connect to the same server partition with a compatible schema and overlapping
authorized scopes. A web mutation drains through its outbox, commits on the
server, and wakes the Tauri client over realtime; the reverse path is
identical.

If a Tauri view is slow, remains partial, or does not react to another
client:

1. Confirm the npm bridge and Rust plugin resolve to matching versions; do
   not mix an older crate with a newer JS bridge.
2. Confirm `db_path` is set and writable. Without it, snapshots share the
   mutable owner by design.
3. Let the database own its persisted client id. Do not reuse one database or
   explicit `clientId` across devices or actors; the native transport puts the
   restored id on the realtime URL automatically.
4. Verify the HTTP and WebSocket endpoints authenticate into the same server
   partition and grants as the web client, and that both clients use the same
   generated schema version.
5. Check the surfaced sync error and outbox count. A non-draining outbox
   points to transport/auth/server work; an empty outbox with slow large
   queries points to result serialization or rendering, where bounded windows
   and pagination are the appropriate fix.

The read-path latency contract behind these checks is the
[performance contract](/platform-tauri/#performance-contract).

## Where to go next

- **[Vite](/guide-vite/)**: the config plus dev proxy.
- **[Schema upgrades](/concepts-schema-upgrades/)**: the wipe-and-re-bootstrap flow and
  what it costs.
- **[Web (browser)](/platform-web/)**: worker mode, OPFS, multi-tab.
