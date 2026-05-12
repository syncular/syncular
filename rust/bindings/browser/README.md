# @syncular/client-rust

Rust-owned SQLite browser client for Syncular v2.

This package is intentionally separate from the v1 dialect packages. The
browser runtime is a dedicated Worker that owns the Rust WASM module and SQLite
handle. JavaScript keeps Kysely as the type-safe query builder; generated app
code supplies the DB type, schema installer, mutation helpers, subscriptions,
and runtime assertions.

## Generated App Entry

Configure Rust codegen to emit your browser helper into your app package:

```json
{
  "typescriptOutputPath": "src/generated/syncular.browser.ts",
  "typescriptRuntimeImportPath": "@syncular/client-rust",
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

## Runtime Contract

The default API always uses a Worker. `createSyncularAppDatabase()` validates
the runtime before returning:

- package name/version must match `@syncular/client-rust`
- Worker protocol version must match the generated helper
- Rust generated schema version must match the generated helper
- Rust runtime must include `web-owned-sqlite`

`client.runtimeInfo()` exposes the package identity, Worker protocol, resolved
storage mode, fallback details, Worker/WASM asset URLs, Rust crate version,
generated schema version, and Rust feature list.

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

## Assets

The package build writes the Rust WASM artifact to `dist/wasm`:

- `syncular_v2.js`
- `syncular_v2_bg.wasm`

The default Worker resolves those assets relative to the package runtime. Custom
asset serving can pass a custom `worker` to `createSyncularAppDatabase()`; the
lower-level direct Rust client also accepts advanced `module` and `wasmUrl`
options. Normal generated app code should not need either path.

## Package Scripts

```bash
bun run build
bun run test
bun run test:wasm:auth
bun run test:wasm:hono
bun run benchmark:browser -- --operations=100 --rounds=5 --warmup=10
bun run size:wasm
```

`test:wasm:hono` builds the dev WASM artifact and runs the Hono-backed browser
smokes for auth retry, sync protocol edge cases, realtime wakeups, and blob
transport behavior.

`benchmark:browser` builds/serves the browser runtime and compares Rust-owned
SQLite local mutation batches against the legacy JS/wa-sqlite host-store fixture.
That JS path is a benchmark baseline only, not a supported v2 client runtime.
From this package directory, pass
`--output=../../.context/benchmarks/rust-sqlite.json` to keep a JSON report.
