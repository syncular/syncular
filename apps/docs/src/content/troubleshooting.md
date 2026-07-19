# Troubleshooting

The first-integration checklist: the symptoms integrators actually hit,
what each one means, and the fix.

## Debugging from the console

Every live client and handle on a dev page registers itself on
`window.__SYNCULAR__` (gated off when your bundler sets
`NODE_ENV=production`):

```js
await __SYNCULAR__.snapshot();
// [{ clientId, role, outbox, subscriptions, conflicts, rejections,
//    syncNeeded, upgrading, lastInvalidation }]

__SYNCULAR__.clients[0].ref; // the client itself — query it, sync it
await __SYNCULAR__.clients[0].ref.query('SELECT * FROM todos');
```

`lastInvalidation` carries the tables and scope keys of the most recent
apply batch — the fastest way to confirm data is arriving and your live
queries should have re-run.

## Enter/mutate silently does nothing

Seen in the dev loop: you restart the dev server while a tab stays open,
then adding an item does nothing — no new row, no error on screen. The old
page is still running against its old worker, and the worker's RPC (or its
transport session) is dead; every `mutate()` **rejects**, but an app that
never renders the failure can't show it, so the symptom reads as "the app
ignored me".

Two fixes, both worth doing:

- **Render `useMutation().error` — always.** The hook catches the rejection
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

That is the completeness oracle being honest. Registration is not
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
`client.patch(table, rowId, partial)` for partial updates — it reads the
current row, merges, and emits the full-row upsert for you.

## `sync.outbox_incompatible` rejections after a schema bump

A pending offline commit references a column your new schema removed, so it
can no longer encode (§7.4.4). The commit leaves the outbox, its optimistic
rows are undone, and the rejection surfaces with this code; later commits
keep draining. This is the designed behavior for dropped columns — see
[Schema bumps](/guide-schema/). If you hit it in development, wipe the
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
[schema-aware Vite resource recipe](/guide-vite/#keep-one-schema-correct-persistent-owner-during-hmr):
it preserves one resource for ordinary HMR but disposes it before constructing
a replacement when the captured generated-schema version changes. The
[official React example](https://github.com/syncular/syncular/blob/main/apps/demo-react/src/frontend/main.tsx)
uses the same record and startup boundary.

Do **not** wipe or rename the OPFS directory for this error: it may contain the
healthy local replica and unsynced outbox. Missing/obsolete browser APIs use
the separate, non-retryable `client.storage_unavailable` code.

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

## "Am I online?" — connectivity status

`useSyncStatus` exposes `outbox`, `syncNeeded`, `upgrading`, `schemaFloor`,
and `leaseState` — and deliberately no `online` flag, because the core does
not own connectivity: the host does (§8.4), and the browser already tells
you. The recipe every app wants:

```ts
const [online, setOnline] = useState(navigator.onLine);
useEffect(() => {
  const on = () => setOnline(true);
  const off = () => setOnline(false);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => {
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
}, []);
// "synced" = online && outbox === 0; wire onSynced (handle config) to
// refresh app-level state after each background round.
```

Pair it with `useSyncStatus().outbox` for the three states a status pill
needs: offline (queueing), online with a draining outbox, and in sync.

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
`worker.format: 'es'`. The full setup —
including the dev proxy for `/sync`, `/segments`, and the `/realtime`
WebSocket — is on the [Vite page](/guide-vite/).

## Where to go next

- **[Vite](/guide-vite/)** — the three-line config plus dev proxy.
- **[Schema bumps](/guide-schema/)** — the wipe-and-re-bootstrap flow and
  what it costs.
- **[Web (browser)](/platform-web/)** — worker mode, OPFS, multi-tab.
