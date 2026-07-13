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

## Data is in the local database, the UI never updates

Live queries in `@syncular/react` schedule their re-runs on
`requestAnimationFrame`, and browsers suspend rAF while
`document.visibilityState === 'hidden'` — background tabs, occluded
webviews, headless embeds. Current releases fall back to a microtask while
the document is hidden (plus a `visibilitychange` re-dispatch), so scheduled
re-runs keep firing everywhere. If you see this symptom, upgrade
`@syncular/react` to the latest release; if it persists on the latest,
that's a bug — please report it.

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

## Vite build errors mentioning sqlite-wasm or the worker

Two config lines fix both: `optimizeDeps.exclude` for
`@sqlite.org/sqlite-wasm` and `worker.format: 'es'`. The full setup —
including the dev proxy for `/sync`, `/segments`, and the `/realtime`
WebSocket — is on the [Vite page](/guide-vite/).

## Where to go next

- **[Vite](/guide-vite/)** — the three-line config plus dev proxy.
- **[Schema bumps](/guide-schema/)** — the wipe-and-re-bootstrap flow and
  what it costs.
- **[Web (browser)](/platform-web/)** — worker mode, OPFS, multi-tab.
