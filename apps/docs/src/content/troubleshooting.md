# Troubleshooting

Use this page when a Syncular client or server misbehaves during a first integration. It lists the shared failures in the order integrators hit them: the symptom, what it means, and the fix. Failures that belong to one SDK live on that SDK's troubleshooting page; the browser failures here are linked from the Browser, React, and React Native pages.

::meta{for="Developers debugging a first integration on any SDK" time="Look up one entry" first="quickstart" spec="10"}

## Find the symptom

| Symptom | Section |
|---|---|
| A write does nothing and shows no error | [Enter/mutate silently does nothing](#entermutate-silently-does-nothing) |
| `client.storage_busy` when the app opens | [`client.storage_busy` while opening the app](#clientstorage_busy-while-opening-the-app) |
| `client.not_leader` in a second tab | [`client.not_leader` on a second tab](#clientnot_leader-on-a-second-tab) |
| The Vite build fails on sqlite-wasm or the worker | [Vite build errors](#vite-build-errors-mentioning-sqlite-wasm-or-the-worker) |
| `client.worker_restart_required` after an upgrade | [`client.worker_restart_required`](#clientworker_restart_required-after-a-package-upgrade) |
| Rows are in the local database and the UI stays stale | [The UI never updates](#data-is-in-the-local-database-the-ui-never-updates) |
| A list is briefly `loading` or `partial` after a switch | [A list switch is briefly `loading` or `partial`](#a-list-switch-is-briefly-loading-or-partial) |
| `sync.invalid_request` naming `_sync_version` | [`sync.invalid_request` naming an `_sync_*` column](#syncinvalid_request-naming-an-_sync_-column) |
| Pending commits vanish after a schema change | [`sync.outbox_incompatible`](#syncoutbox_incompatible-rejections-after-a-schema-bump) |
| Offline writes risk loss on a browser that has not granted persistence | [Pending outbox on best-effort browser storage](#pending-outbox-on-best-effort-browser-storage) |
| `client.follower_timeout` in a follower tab | [`client.follower_timeout`](#clientfollower_timeout-in-a-follower-tab) |
| `client.leader_incompatible` in a follower tab | [`client.leader_incompatible`](#clientleader_incompatible-in-a-follower-tab) |
| A Tauri view is slow, partial, or ignores another client | [Tauri troubleshooting](/platform-tauri-troubleshooting/#slow-partial-or-non-converging-views) |

## Error code index

Errors carry stable codes. When you arrive from a stack trace, start here:

| Code | Meaning | Detail |
|---|---|---|
| `sync.invalid_request` naming `_sync_*` | A write carried an engine-owned column | [below](#syncinvalid_request-naming-an-_sync_-column) |
| `sync.outbox_incompatible` | A pending commit references a dropped column | [below](#syncoutbox_incompatible-rejections-after-a-schema-bump) |
| `sync.unknown_table` | A subscription names a table the schema retired | [Schema upgrades](/concepts-schema-upgrades/) |
| `sync.schema_not_ready` | The server booted without a readiness check | [Server setup](/guide-server/) |
| `sync.internal_error` | A storage, network, or host-code exception reached the server adapter; the client retries | [Reporting server errors](/guide-server/#reporting-server-errors) |
| `sync.invalid_client_id` | A client id was reused under a different actor | [Seeding data](/server-operations/#seeding-data) |
| `sync.forbidden` | A write failed the scope check | [Scopes & authorization](/concepts-scopes/) |
| `sync.crdt_merge_failed` | A `crdt` column has no registered merger, or the merger threw | [CRDT columns](/concepts-crdt/#register-the-merger-on-the-server) |
| `sync.storage.scan_requires_scope` | A row scan omitted its mandatory scope filter | [Storage reference](/server-storage-reference/#advanced-row-lookups-for-trusted-server-code) |
| `sync.storage.stored_layout_mismatch` | Stored layouts disagree with the schema at the same version | [Storage reference](/server-storage-reference/#materialized-app-tables) |
| `sync.storage.physical_layout_mismatch` | A synced table's columns or key differ from the storage layout | [Storage reference](/server-storage-reference/#materialized-app-tables) |
| `blob.not_found`, `blob.forbidden`, `blob.hash_mismatch` | A blob is absent, unauthorized, or uploaded under the wrong address | [Blobs](/concepts-blobs/#transfer-failures) |
| `client.not_leader` | Another tab owns the origin leader lock | [below](#clientnot_leader-on-a-second-tab) |
| `client.follower_timeout` | The leader tab answered no probe in time | [below](#clientfollower_timeout-in-a-follower-tab) |
| `client.leader_incompatible` | The leader tab runs another protocol or schema version | [below](#clientleader_incompatible-in-a-follower-tab) |
| `client.storage_busy` | The OPFS pool is still held by another engine | [below](#clientstorage_busy-while-opening-the-app) |
| `client.worker_restart_required` | A stale dev-server worker graph | [below](#clientworker_restart_required-after-a-package-upgrade) |
| `client.decrypt_failed` | No key for an envelope's key id | [Encryption keys](/concepts-encryption/#encryption-keys) |
| `client.encrypt_failed` | No usable key id at the push encode seam | [Encryption keys](/concepts-encryption/#encryption-keys) |
| `client.security_preflight_required` | Protected work before `activateSecurity` | [Authorized local purge](/concepts-local-data-purge/#race-free-security-bootstrap) |
| `client.local_data_purged` | A pending commit touched a purged target | [Authorized local purge](/concepts-local-data-purge/#what-the-purge-does) |
| `client.crdt_unavailable` | The `crdt-yjs` feature is off in this build | [CRDT columns](/concepts-crdt/#enable-the-crdt-yjs-feature-on-native-builds) |
| `client.identity_mismatch` | An explicit `clientId` differs from the database's | [Tauri troubleshooting](/platform-tauri-troubleshooting/#identity-and-database-names) |
| `operation.invalid_request` | A remote query without complete scope proof | [Remote server operations](/guide-remote-operations/) |
| `presence.forbidden` | A presence publish to an unheld scope key | [Realtime](/concepts-realtime/) |

The normative catalog is [SPEC §10](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#10-errors).

## Enter/mutate silently does nothing

Seen in the dev loop: you restart the dev server while a tab stays open, then adding an item does nothing. No new row appears and no error shows. The old page still runs against its old worker, and the worker's RPC (or its transport session) is dead. Every `mutate()` rejects, but an app that never renders the failure cannot show it, so the symptom reads as "the app ignored me".

Two fixes, both worth doing:

- **Render `useMutation().error`.** The hook catches the rejection and exposes it. An app that calls `mutate` and drops the promise has no failure surface. The submit-wrapper pattern:

  ```tsx title="src/AddForm.tsx"
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

- **Reload open tabs after a dev-server restart.** The served bundles and the worker changed under the page, and the dev loop does not try to preserve a stale page over a fresh server.

## `client.storage_busy` while opening the app

The OPFS SAH pool is still owned by another live engine, or a recently closed worker has not released it yet. The state is a retryable startup condition and leaves the database intact. Close the competing app or tab, or wait briefly, then retry the same client resource:

```tsx title="src/main.tsx"
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

Syncular's default multi-tab mode coordinates ordinary same-origin tabs. Collisions most often come from rapid hot-module replacement or from embedded and test hosts that share OPFS without sharing the same Web Locks and BroadcastChannel domain. Use the [schema-aware Vite resource recipe](/platform-web-realtime/#keep-one-owner-during-hmr): it keeps one resource across ordinary HMR and disposes it before it builds a replacement when the captured generated-schema version changes. The [official React example](https://github.com/syncular/syncular/blob/main/apps/demo-react/src/frontend/main.tsx) uses the same record and startup boundary.

Do not wipe or rename the OPFS directory for this error: it may hold the healthy local replica and the unsynced outbox. Missing or obsolete browser APIs use the separate non-retryable code `client.storage_unavailable`.

## `client.not_leader` on a second tab

Another tab holds this origin's leader lock, and the handle was created with `multiTab: false`. Multi-tab followers are the default: a losing tab proxies the full API to the leader over a BroadcastChannel and promotes when the leader closes. Remove the `multiTab: false` opt-out, or keep it and render the not-leader state deliberately ("already open in another tab"). Details are on [Browser](/platform-web/).

## Vite build errors mentioning sqlite-wasm or the worker

Two config changes fix both: add `@sqlite.org/sqlite-wasm` plus `SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE` to `optimizeDeps.exclude`, and set `worker.format: 'es'`. The full setup, including the dev proxy for `/sync`, `/segments`, and the `/realtime` WebSocket, is in [Configure Vite](/platform-web-install/#configure-vite).

## `client.worker_restart_required` after a package upgrade

The page tried to start a worker graph that still referred to a retired Vite optimizer chunk. This is a development-host identity mismatch, and the replica is intact. Stop Vite, reinstall from the lockfile, restart once with `--force`, and reload every open app tab. Do not clear OPFS: device identity, subscription progress, and an unsynced outbox may live there.

Use `SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE` from `@syncular/react/vite` and the schema-and-runtime-aware `retainViteSyncClientResource` recipe in [Configure Vite](/platform-web-install/#configure-vite). The client sanitizes the original bundler text and URL before it surfaces this code, so support diagnostics retain no local paths or chunk names.

## Data is in the local database, the UI never updates

Reactive queries consume core-originated revisioned change batches and schedule store reads with microtasks. Correctness does not depend on animation frames or document visibility. If a current client has committed local rows and an observed generated query does not advance its revision, capture the change batch and the query descriptor and report a parity or routing bug.

## A list switch is briefly `loading` or `partial`

Registration is not completeness (SPEC §4.8): a newly claimed unit is pending until its bootstrap finishes. A generated `useQuery` reads rows and that verdict atomically, so render from its `phase`. Only `phase === 'ready' && rows.length === 0` is a truthful empty list. A zero-row bootstrap completion advances the same snapshot to `ready`. [Windowed sync](/concepts-windowing/) explains the oracle.

## `sync.invalid_request` naming an `_sync_*` column

`_sync_version` is the client engine's internal per-row version column. `client.query()` strips `_sync_*` columns from results, so a `SELECT *` row feeds straight back into `mutate()`. Rows read through the raw `client.database` tier keep them, and hand-built records can carry them by accident. Remove the key, or use `client.patch(table, rowId, partial)` for partial updates: it records a sparse upsert that names only the columns you pass, so stored columns you did not touch keep their values.

## `sync.outbox_incompatible` rejections after a schema bump

A pending offline commit references a column your new schema removed, so it can no longer encode (SPEC §7.4.4). The commit leaves the outbox, its optimistic rows are undone, and the rejection surfaces with this code while later commits keep draining. This is the designed behavior for dropped columns ([Schema upgrades](/concepts-schema-upgrades/)). If you hit it in development, [wipe the client database](#wiping-opfs-for-a-clean-test) and continue.

## Pending outbox on best-effort browser storage

`openPersistentWasmDatabase` makes the SQLite database survive ordinary reloads. Eviction resistance is a separate origin-level permission. Call `checkBrowserStoragePersistence()` at startup and `requestBrowserStoragePersistence()` from a user action near the first important offline write. If the result stays `best-effort`, warn whenever the outbox is non-empty. Clearing or evicting the origin removes both the local rows and the pending outbox.

Do not mirror the outbox into IndexedDB for this condition. IndexedDB and OPFS share the origin storage policy, and the browser deletes them together when it evicts the origin.

## `client.follower_timeout` in a follower tab

The follower's probe to the leader tab got no answer within `followerCallTimeoutMs` (default 10 s), so `handle.leadership` is `blocked` with reason `leader-unreachable` and calls reject immediately. A leader in a hidden or throttled tab still answers probes. This state means the leader tab's main thread processed no messages for the whole window, for example during a long synchronous task or while the browser froze the tab. The follower keeps probing and rebinds when the leader answers, and closing the leader tab promotes a follower. Render the blocked state. Raising `followerCallTimeoutMs` only delays detection of a hung leader. Details are on [Platform specifics](/platform-web-specifics/#multi-tab).

## `client.leader_incompatible` in a follower tab

The tab that holds the database runs another `MULTI_TAB_PROTOCOL_VERSION` or schema version, so `handle.leadership` is `blocked` with reason `leader-incompatible`. With `leader: 'newer'`, reload this tab. With `leader: 'older'`, reload or close the other tab: a leader of this build steps down for a newer tab by itself, and an older leader does not. Once a leader of this build holds the lock, the same handle binds or promotes.

## Debugging from the console

Every live client and handle on a dev page registers itself on `window.__SYNCULAR__`. Your bundler turns the registry off when it sets `NODE_ENV=production`.

```js title="browser console"
await __SYNCULAR__.snapshot();
// [{ clientId, role, outbox, subscriptions, conflicts, rejections,
//    syncNeeded, upgrading, lastInvalidation }]

__SYNCULAR__.clients[0].ref; // the client itself: query it, sync it
await __SYNCULAR__.clients[0].ref.query('SELECT * FROM todos');
```

`lastInvalidation` carries the tables and scope keys of the most recent apply batch. It is the fastest way to confirm that data arrives and that your live queries should have re-run.

## Wiping OPFS for a clean test

The persistent worker database lives in the origin's OPFS. To reset a dev client to factory state, close the app's tabs so the pool is not held open, then run this in the console:

```js title="browser console"
const root = await navigator.storage.getDirectory();
for await (const name of root.keys()) {
  await root.removeEntry(name, { recursive: true });
}
```

Clearing site data in devtools (Application → Storage → Clear site data) does the same and also drops the leader lock.
