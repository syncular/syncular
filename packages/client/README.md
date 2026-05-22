# @syncular/client

Rust-owned SQLite browser client for Syncular.

This package is the TypeScript host binding over the Rust client. The browser
runtime is a dedicated Worker that owns the Rust WASM module and SQLite handle.
TypeScript keeps Kysely as the type-safe query builder; generated app code
supplies the DB type, schema installer, mutation helpers, subscriptions, and
runtime assertions.

## Generated App Entry

Configure Rust codegen to emit your browser helper into your app package:

```json
{
  "typescriptOutputPath": "src/generated/syncular.browser.ts",
  "typescriptRuntimeImportPath": "@syncular/client",
  "tables": {
    "profiles": {
      "serverVersionColumn": "server_version",
      "blobColumns": ["avatar"]
    }
  }
}
```

App code imports the generated helper, not a table-specific API from this
package:

```ts
import { createSyncularAppDatabase } from './generated/syncular.browser';

const syncular = await createSyncularAppDatabase({
  config: {
    baseUrl: '/sync',
    actorId: 'user-1',
    clientId: 'client-1',
    projectId: 'project-1',
    fileName: 'app.sqlite',
  },
  requestTimeoutMs: 30_000,
  getHeaders: async () => ({
    authorization: `Bearer ${await auth.currentAccessToken()}`,
  }),
  authLifecycle: {
    refreshToken: () => auth.refreshAccessToken(),
  },
});

const rows = await syncular.db
  .selectFrom('tasks')
  .select(['id', 'title'])
  .where('project_id', '=', 'project-1')
  .execute();

await syncular.mutations.tasks.insert({
  title: 'Typed Rust-owned write',
  completed: 0,
  user_id: 'user-1',
  project_id: 'project-1',
});

await syncular.client.issueAuthLease({
  schemaVersion: 1,
  scopes: [
    {
      subscriptionId: 'tasks:user-1',
      table: 'tasks',
      values: { user_id: 'user-1' },
      operations: ['upsert'],
    },
  ],
});

await syncular.leasedMutations.tasks.update('task-1', {
  title: 'Queued while offline',
});

// Local mutations sync automatically by default. To opt out, pass:
// sync: { autoSyncAfterMutation: false }

const live = await syncular.live(
  syncular.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('project_id', '=', 'project-1'),
  {
    onChange(rows) {
      console.log(rows);
    },
  }
);

live.unsubscribe();
await syncular.close();
```

Generated helpers intentionally do not emit table constants, column constants,
or canned queries. Reads stay plain Kysely. Sync-aware writes go through
`syncular.mutations` or generated operation helpers.

Use `bootstrapPhases` when the app should become usable before every
subscription has finished its first snapshot. Keys can be generated table names
or subscription ids. Phase `0` is critical by default, phase `1` is
interactive by default, and higher phases continue in the background:

```ts
const syncular = await createSyncularAppDatabase({
  config: {
    baseUrl: '/sync',
    actorId: 'user-1',
    clientId: 'client-1',
    pull: {
      criticalBootstrapPhase: 0,
      interactiveBootstrapPhase: 1,
    },
  },
  bootstrapPhases: {
    projects: 0,
    tasks: 1,
    comments: 2,
  },
});

const result = await syncular.client.syncOnce();

if (result.bootstrap.criticalReady) {
  renderShell();
}

const unsubscribeBootstrap = syncular.client.addEventListener(
  'bootstrapChanged',
  (bootstrap) => {
    if (bootstrap.interactiveReady) enableMainViews();
    if (bootstrap.complete) enableFullDataViews();
  }
);
```

Do not treat missing scopes as empty data while `bootstrap.complete` is false.
Use `bootstrap.pendingSubscriptionIds`, `bootstrap.phases`, or generated
subscription ids to decide which views can render complete results.

For apps that want a lifecycle-managed surface instead of wiring startup by
hand, `createSyncularClient` wraps the Rust-owned database with subscription
setup, initial sync, realtime, reconnect catchup, and coordinated shutdown:

```ts
import { createSyncularClient } from '@syncular/client';

const syncular = await createSyncularClient<AppDb>({
  config: {
    baseUrl: '/sync',
    actorId: 'user-1',
    clientId: 'client-1',
  },
  subscriptions: [
    {
      id: 'tasks:user-1',
      table: 'tasks',
      scopes: { user_id: 'user-1' },
    },
  ],
});

const unsubscribe = syncular.on('rowsChanged', (event) => {
  console.log(event.changedTables);
});

const status = syncular.getStatus();
if (status.hasPendingMutations) showSavingIndicator();

await syncular.resumeFromBackground();
await syncular.destroy();
```

The managed client starts realtime by default. Pass `realtime: false` only for a
host policy that cannot hold a websocket. Interval polling is still off by
default: websocket reconnects trigger HTTP catchup sync, and failed
inline/binary websocket applies already fall back to pull. Use
`lifecycle.pollIntervalMs` only for environments that explicitly need polling.

## React

React apps can import the separate `@syncular/react` package.
The adapter owns the Rust browser client lifecycle when passed `options`, or
can wrap an already-created managed client:

```ts
import { createSyncularReact } from '@syncular/react';

const {
  SyncProvider,
  useSyncQuery,
  useMutations,
  useLeasedMutations,
  useMutation,
  useOutboxStats,
  usePresenceWithJoin,
  useSyncConnection,
} = createSyncularReact<AppDb>();

function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SyncProvider
      options={{
        config: {
          baseUrl: '/sync',
          actorId: 'user-1',
          clientId: 'client-1',
        },
        subscriptions: [
          {
            id: 'tasks:user-1',
            table: 'tasks',
            scopes: { user_id: 'user-1' },
          },
        ],
        realtime: true,
      }}
    >
      {children}
    </SyncProvider>
  );
}

function TaskList() {
  const { data: tasks } = useSyncQuery(
    ({ selectFrom }) =>
      selectFrom('tasks')
        .select(['id', 'title'])
        .where('user_id', '=', 'user-1'),
    {
      tables: ['tasks'],
      deps: ['user-1'],
    }
  );

  const presence = usePresenceWithJoin('user:user-1', {
    metadata: { view: 'tasks' },
  });

  const m = useMutations();
  const leased = useLeasedMutations();
  const createTask = (title: string) =>
    m.tasks.insert({
      title,
      completed: 0,
      user_id: 'user-1',
    });

  const completeTask = useMutation({ table: 'tasks' });
  const markDone = (id: string) =>
    completeTask.mutate.update(id, { completed: 1 });

  const renameOffline = (id: string, title: string) =>
    leased.tasks.update(id, { title });

  const connection = useSyncConnection();
  const outbox = useOutboxStats();
}
```

The React entrypoint is intentionally ergonomic and Rust-backed: reads use typed
Kysely selectors through `useSyncQuery`, writes use generated mutations through
`useMutations` / `useLeasedMutations` or table-scoped
`useMutation` / `useLeasedMutation`, and presence stays scoped to server scope
keys. When the query is a Kysely builder, `useSyncQuery` uses the runtime
live-query observer; promise-only queries fall back to conservative row-change
refresh. `SyncProvider` does not recreate an owned client just because an inline
`options` object changed identity; pass `optionsKey` when the app intentionally
needs to tear down and reopen the Rust client for a new identity or database.

Generated apps also get typed row-delta helpers for realtime/UI routing. The
runtime event stays generic, while app code can branch on real table columns:

```ts
import { syncularChangedRows } from './generated/syncular.browser';

const unsubscribe = syncular.on('rowsChanged', (event) => {
  for (const task of syncularChangedRows.tasks(event)) {
    if (task.isDelete) {
      removeTaskFromList(task.rowId);
      continue;
    }
    if (task.changed.title || task.changed.completed) {
      refreshTaskRow(task.rowId);
    }
    if (task.crdt.title_yjs_state) {
      refreshActiveEditorState(task.rowId);
    }
  }
});
```

The returned `syncular.db` is a read/query-builder surface. Public SQL execution
rejects app-table and internal-table writes, including Kysely `insertInto`,
`updateTable`, `deleteFrom`, schema DDL, and raw mutating SQL. This prevents
local rows from bypassing Syncular's outbox, conflict, encryption, blob, and
realtime semantics. Generated app setup uses an internal schema-write path
before the database handle is returned; application writes should use
`syncular.mutations`.

Mutations schedule `client.syncOnce()` automatically after a successful local
commit. The scheduler coalesces repeated writes with a short debounce and queues
one follow-up sync if another mutation lands while sync is already running:

```ts
const syncular = await createSyncularAppDatabase({
  config: {
    baseUrl: '/sync',
    actorId: 'user-1',
    clientId: 'client-1',
  },
  sync: {
    autoSyncAfterMutation: true, // default
    mutationSyncDebounceMs: 25,
    rowsChangedDebounceMs: 16,
    autoProcessBlobUploadsAfterStore: false, // default
    blobUploadDebounceMs: 25,
  },
});
```

Set `autoSyncAfterMutation: false` when an app wants to batch its own sync
cycles explicitly. Set `autoProcessBlobUploadsAfterStore: true` when the
browser should process queued blob uploads after `blobs.store()` with the same
debounce/backpressure model. It is disabled by default so mobile/background
hosts can choose when network blob work is allowed.

## Blobs

Blobs are a sidecar API on the same Rust-owned SQLite client. App data still
uses typed Kysely queries; binary payloads are content-addressed and staged in
Syncular internal blob tables:

```ts
const avatar = await syncular.blobs.store(file, {
  mimeType: file.type,
});

await syncular.mutations.profiles.upsert(userId, {
  avatar,
});

await syncular.blobs.processUploadQueue();

const bytes = await syncular.blobs.retrieve(avatar);
```

`store()` hashes and caches bytes in Rust/WASM SQLite, then queues upload unless
`immediate: true` is passed. Upload/download requests use the same auth header
lifecycle as sync and talk to the server blob routes under `${baseUrl}/blobs`.
Apps can call `processUploadQueue()` manually or opt into
`sync.autoProcessBlobUploadsAfterStore`.
Columns listed in `blobColumns` are typed as `BlobRef` in generated Kysely
types and use generated codecs so SQLite stores JSON text while app code reads
and writes structured blob refs.

## Auth

App code owns authentication. Pass `getHeaders` to the generated app database
factory when sync requests need bearer tokens, session headers, or tenant
headers:

```ts
const syncular = await createSyncularAppDatabase({
  config: {
    baseUrl: '/sync',
    actorId: 'user-1',
    clientId: 'client-1',
  },
  getHeaders: async () => ({
    authorization: `Bearer ${await auth.currentAccessToken()}`,
  }),
});
```

The Worker refreshes those headers after opening and before `syncPull`,
`syncPush`, and `syncOnce`, then forwards them into Rust. The `actorId` config
is used for sync identity and generated default scopes; it is not sent as an
implicit auth credential.
If Rust reports HTTP 401/403 during sync, `authLifecycle` can refresh
credentials and the Worker retries that sync operation once with fresh headers.

Offline auth leases are explicit. They capture bounded local intent and audit
provenance, but the server still rechecks current authorization when queued
commits replay:

```ts
await syncular.client.issueAuthLease({
  schemaVersion: 1,
  scopes: [
    {
      subscriptionId: 'tasks:user-1',
      table: 'tasks',
      values: { user_id: 'user-1' },
      operations: ['upsert', 'delete'],
    },
  ],
});

const active = await syncular.client.activeAuthLeases('user-1');
await syncular.leasedMutations.tasks.update('task-1', {
  title: 'Offline edit',
});
```

Use normal `syncular.mutations` unless the app intentionally needs lease-backed
offline writes.

## Platform Bridges

`@syncular/client-tauri` and `@syncular/client-react-native` expose TypeScript
host bindings over a native Rust runtime. They are bridge adapters, not separate
JavaScript sync clients:

```ts
import { createSyncularTauriClient } from '@syncular/client-tauri';

const client = await createSyncularTauriClient<AppDb>({
  invoke,
  listen,
});

const rows = await client.db.selectFrom('tasks').selectAll().execute();
await client.leasedMutations.tasks.update('task-1', { title: 'Offline edit' });
await client.resumeFromBackground();
```

Bridge packages preserve row/field metadata on `rowsChanged` events and expose
the same leased mutation, auth lease, lifecycle, presence, conflict, and blob
client shape where the native module provides those commands. They do not
pretend to support live-query registration by rerunning table-level events; app
bridges can either use row/field metadata directly or wait for a native
observed-query stream. Command history remains generated-client owned, not a
generic bridge-level JavaScript undo stack.

## Diagnostics

Pass `diagnostics` to observe structured client, worker, auth, realtime,
storage, sync, and blob events. Header values and websocket URLs are not emitted.

```ts
const syncular = await createSyncularAppDatabase({
  config: {
    baseUrl: '/sync',
    actorId: 'user-1',
    clientId: 'client-1',
  },
  diagnostics(event) {
    logger.debug(event.code, event);
  },
});
```

`requestTimeoutMs` is enforced in the Worker. For long sync/blob requests the
Worker also aborts the Rust-owned browser fetches, including snapshot chunk
downloads, before dropping the timed-out response.

UI code can poll `syncular.client.connectionState()` for a cheap snapshot of the
Worker state: closed flag, pending request count, realtime connection state,
storage fallback, and the latest diagnostic/error.

## Realtime

Realtime is optional and runs inside the same dedicated Worker as Rust-owned
SQLite. Enable it with `realtime`:

```ts
const syncular = await createSyncularAppDatabase({
  config: {
    baseUrl: '/sync',
    actorId: 'user-1',
    clientId: 'client-1',
  },
  realtime: true,
});
```

The Worker connects to `${baseUrl}/realtime`, listens for server `sync`
wakeups, runs `syncPull()` in Rust, then emits affected live-query snapshots to
JS listeners. Browser WebSockets cannot send custom headers; use same-origin
cookie auth when possible, or pass non-sensitive server-supported params:

```ts
await createSyncularAppDatabase({
  config: {
    baseUrl: '/sync',
    actorId: 'user-1',
    clientId: 'client-1',
  },
  realtime: {
    wsUrl: 'wss://api.example.com/sync/realtime',
    getParams: async () => ({ token: await auth.realtimeToken() }),
  },
});
```

Realtime also carries presence. Scope keys match the sync scope keys exposed by
the server, for example `user:user-1` for a `user:{user_id}` handler scope:

```ts
const unsubscribePresence = syncular.client.addPresenceListener((event) => {
  renderCollaborators(event.scopeKey, event.presence);
});

syncular.presence.join('user:user-1', {
  editingTaskId: 'task-1',
});

syncular.presence.updateMetadata('user:user-1', {
  editingTaskId: 'task-2',
});

syncular.presence.leave('user:user-1');
unsubscribePresence();
```

`getPresence(scopeKey)` returns the latest in-memory snapshot for that scope.
The server authorizes presence against the websocket connection's current
subscriptions, so call `syncular.setSubscriptions()` and complete an initial
sync before joining presence.

Operational events are available on the same client surface:

```ts
syncular.on('outboxChanged', (stats) => {
  updateSyncBadge(stats.pending + stats.sending);
});

syncular.on('conflictsChanged', (stats) => {
  showConflictCount(stats.unresolved);
});

syncular.on('blobUploadFailed', ({ hash, error }) => {
  reportBlobUploadFailure(hash, error);
});
```

Browser event names intentionally use the Rust-native vocabulary shared with
native event payloads: `rowsChanged`, `outboxChanged`, `conflictsChanged`,
`presenceChanged`, `blobUploadCompleted`, and `blobUploadFailed`.

## Runtime Contract

The default API always uses a Worker. `createSyncularAppDatabase()` validates
the runtime before returning:

- package name/version must match `@syncular/client`
- Worker protocol version must match the generated helper
- generated app schema version must match the local SQLite schema state
- Rust runtime must include the generated schema's required feature list

`client.runtimeInfo()` exposes the package identity, Worker protocol, resolved
storage mode, fallback details, Worker/WASM asset URLs, Rust crate version,
generated schema version, and Rust feature list.

Generated clients emit `syncularGeneratedRequiredRuntimeFeatures` from schema
metadata. A basic app only needs `web-owned-sqlite-core`; apps using blob
columns, CRDT/Yjs, or field encryption add `blobs`, `crdt-yjs`, and/or `e2ee`.
`createSyncularAppDatabase()` passes those requirements into the Worker open
path automatically.

## Storage

Omitting `config.storage` defaults to `opfsSahPool`. If that default OPFS open
fails because the browser cannot create the sync access handle, the Worker
client retries with `indexedDb` and reports the fallback via
`runtimeInfo().storageFallback`.

Explicit storage is never silently changed:

```ts
await createSyncularAppDatabase({
  config: {
    baseUrl: '/sync',
    actorId: 'user-1',
    clientId: 'client-1',
    storage: 'indexedDb',
  },
});
```

`client.compactStorage()` performs bounded local cleanup in Rust-owned SQLite:
acked outbox commits and resolved conflicts by age, optional failed blob upload
rows and inactive subscription state by age, blob cache pruning by byte budget,
and tombstones only when the caller supplies `maxTombstoneServerVersion`.

```ts
await syncular.client.compactStorage({
  olderThanMs: 7 * 24 * 60 * 60 * 1000,
  maxBlobCacheBytes: 256 * 1024 * 1024,
  pruneFailedBlobUploads: true,
  maxTombstoneServerVersion: lastServerVersionKnownSafeToDrop,
});
```

Tombstone cleanup is intentionally not enabled by age alone; deleting
soft-deleted app rows before the server/version contract says they are safe can
break later sync repair.

## CRDT Document Fields

Generated app clients expose schema-derived CRDT field helpers, and the
low-level client exposes generic `openCrdtField`, `applyCrdtFieldYjsUpdate`,
`materializeCrdtField`, `snapshotCrdtFieldStateVector`, and `compactCrdtField`
methods. Keep editor-specific code above this package: TipTap schemas,
ProseMirror transforms, Excalidraw save policy, selection, undo, and WebView
messages belong in app code or optional app adapters.

Use `@syncular/client-crdt-adapters` for app-layer editor glue above this
package. It connects Yjs binary update streams to Syncular's durable CRDT field
API, preserves pending updates across failed writes, exposes backpressure,
prefers queued native host writes when available, and refreshes app view models
from materialized Syncular state after changed-row events.

For rich editors, keep Yjs as the canonical field state. ProseMirror JSON,
title, preview, outline, search text, and similar values are projections that
apps should rebuild after a CRDT changed-row event, remote apply, or compaction.
The Rust-owned client persists a compact binary Yjs state and state vector per
document field, plus an append-only binary Yjs update log with `pending`,
`flushed`, and `acked` status. Use `crdtDocumentSnapshot` to inspect the
current compacted state/vector and queue counts, `crdtUpdateLog` for adapter
diagnostics, and `compactStorage({ olderThanMs, pruneCrdtUpdateLog: true })` to
prune old acked log entries without touching the canonical compact state.

## Assets

The generated JavaScript/WASM binding package under `rust/bindings/javascript`
writes the full Rust WASM artifact to `dist/wasm`:

- `syncular.js`
- `syncular_bg.wasm`
- `syncular-runtime-artifact.json`

It also writes the core artifact to `dist/wasm-core` and the ordered catalog to
`dist/syncular-runtime-artifacts.json`.

The default Worker resolves those assets relative to the package runtime.
Generated app code can select from that catalog without changing the public
query/mutation API:

```ts
import { resolveSyncularRuntimeArtifactCatalog } from '@syncular/client';

const catalogUrl = '/syncular/syncular-runtime-artifacts.json';
const catalog = await fetch(catalogUrl).then((response) => response.json());

await createSyncularAppDatabase({
  config,
  runtimeArtifacts: resolveSyncularRuntimeArtifactCatalog(catalog, {
    baseUrl: catalogUrl,
  }),
});
```

The first artifact containing every generated required feature is used. Custom
asset serving can still pass a custom `worker`; the lower-level direct Rust
client accepts advanced `runtime`, `module`, `wasmGlueUrl`, and `wasmUrl`
options. Normal generated app code should not need those lower-level paths.

Release WASM builds run a size budget check after `wasm-opt -Oz` and custom
section stripping. The current checked budgets are `3.25 MiB` raw and
`1.35 MiB` gzip. Override them only for an intentional release-size decision:

```bash
SYNCULAR_WASM_RAW_BUDGET_BYTES=3407872 \
SYNCULAR_WASM_GZIP_BUDGET_BYTES=1415578 \
  bun --cwd rust/bindings/javascript run size:wasm:check
```

The check writes an attribution report to
`.context/wasm-size/syncular-wasm-size.txt` when run through
`rust/bindings/javascript` `build:wasm` or `size:wasm:check`. Release builds
also write a non-shipping optimized profile WASM to
`.context/wasm-size/syncular_bg.profile.wasm` before final custom section
stripping so attribution can keep symbol names when available.

The current browser client is the canonical Rust-owned SQLite runtime wrapper
for generated clients. The no-CRDT/no-E2EE core binding artifact has measured
byte savings; the current core artifact also omits blob upload/cache helpers.
The JavaScript binding package `build` runs `build:wasm:variants`, which writes
both artifacts plus the catalog, and generated loading can select the smallest
matching artifact when an app serves the catalog. Publishing separate wrapper
packages around the same WASM would not remove bytes.

For local measurement or app experiments:

```bash
bun --cwd rust/bindings/javascript run build:wasm:core
bun --cwd rust/bindings/javascript run build:wasm:variants
bun --cwd rust/bindings/javascript run catalog:wasm
bun --cwd rust/bindings/javascript run size:wasm:core
```

`build:wasm:core` writes `dist/wasm-core/syncular.js` and
`dist/wasm-core/syncular_bg.wasm` with `web-owned-sqlite-core` only. That
artifact does not include blob, CRDT/Yjs, or E2EE support. `catalog:wasm`
combines `dist/wasm-core/syncular-runtime-artifact.json` and
`dist/wasm/syncular-runtime-artifact.json` into the top-level
`dist/syncular-runtime-artifacts.json` catalog.

## Package Scripts

```bash
bun run build
bun run test
bun run test:wasm:auth
bun run test:wasm:hono
bun run test:wasm:variants
```

`test:wasm:hono` builds the dev WASM artifact and runs the Hono-backed browser
smokes for auth retry, sync protocol edge cases, realtime wakeups, and blob
transport behavior.

`rust/bindings/javascript` `build:wasm`, `size:wasm:check`, and the conformance
gates are the current browser runtime validation path. The old JS/wa-sqlite
comparison benchmark was removed with the legacy TypeScript client runtime.
