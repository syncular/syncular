# @syncular/client

The TypeScript client protocol core (SPEC.md §§3–8, client side) plus its
browser platform bindings.

## Browser modes — there are exactly two

**Persistent worker mode is THE mode** (REVISE Direction decision 2,
2026-07-03). The whole client core — `SyncClient`, the fetch/WebSocket
transports, and SQLite on the `opfs-sahpool` VFS — runs inside a Web
Worker. The UI thread talks to it through a thin postMessage RPC:

```ts
// worker.ts — the worker entry your bundler emits as its own script
import { startSyncWorker } from '@syncular/client/worker';
startSyncWorker();
```

```ts
// main thread
import { createSyncClientHandle } from '@syncular/client';

const handle = await createSyncClientHandle({
  worker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  schema,
  database: { mode: 'persistent', name: 'app' }, // OPFS, survives reloads
  endpoints: {
    syncUrl: '/sync',
    segmentsUrl: '/segments',
    realtimeUrl: 'wss://example.com/realtime?clientId={clientId}',
  },
});
if (handle.role === 'follower') {
  // Another tab owns the core for this origin. With `multiTab: true`
  // (below) this handle transparently proxies to that leader; without it,
  // every call rejects with `client.not_leader` (a clear state, not a
  // broken client).
}
await handle.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['l1'] } });
await handle.syncUntilIdle();
const rows = await handle.query('SELECT * FROM todos');
```

The handle exposes the same logical API as `SyncClient` (subscribe /
mutate / sync / query / conflicts / …), every method a promise. It
acquires the Web Locks leader lock *before* spawning the worker — one
core per origin. Wake-ups are handled inside the worker (`autoSync`,
SPEC §8.4: the sync-needed signal is host-driven and the worker IS the
host); the main thread gets `onSyncNeeded` / `onConflict` / `onSynced`
events for rendering.

**Ephemeral in-memory mode is EXPLICIT.** `openWasmDatabase()` returns an
in-memory sqlite-wasm database for tests, demos and SSR. Nothing
persists, on purpose, and that is the only main-thread mode.

## Multi-tab followers (TODO 3.2, REVISE B3)

Pass `multiTab: true` and every tab of the same origin shares ONE core:
one sync loop, one WebSocket, one OPFS database, N tabs.

```ts
const handle = await createSyncClientHandle({
  worker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  schema, database: { mode: 'persistent', name: 'app' }, endpoints,
  multiTab: true,
  onRoleChange: (role) => console.log('now', role), // 'follower' → 'leader'
});
// handle.role is 'leader' or 'follower'; the API is identical either way.
```

**Topology.** The tab that wins the Web Locks election is the **leader**:
it holds the lock, spawns the worker, and runs the core (the single-tab
path, unchanged — the lock IS the exactly-one-core invariant, and a worker
is *never* spawned without it). Every other tab is a **follower**: it opens
a `BroadcastChannel` to the leader and proxies the whole logical API over
it (`req`/`res`), while the leader fans its worker events — exact revisioned
change batches plus presence / conflict / sync-needed / synced / upgrading —
out to all followers (`event`). Queries forward to the leader's one DB; rows
(including `bytes` columns) ride back through structured clone.

**Promotion.** When the leader tab closes, its lock releases. Followers are
already blocked on `lock.acquire`; Web Locks grants it to exactly one, and
that tab **promotes in place** — spawns the worker over the *same* OPFS
database (which persisted; the server is the source of truth, so nothing is
replayed beyond the outbox the core already holds), re-announces on a new
**epoch**, and flips its `role` to `'leader'`. Remaining followers rebind
to the new leader on its announce. The handle object is kept across the
transition, so a React `SyncProvider` holds a stable reference.

**Epoch (generation token).** Each leader announces a monotonically
increasing epoch. Followers stamp requests with the epoch they last heard;
a leader ignores stale-epoch requests, and a follower discards any
`res`/`event` from an epoch other than its current one — so a late reply
from a tab that has since died can never be mistaken for a live answer.
Calls made during the handover gap are **queued with a deadline** and
flushed to the new leader on its announce; past the deadline they fail
loudly with `client.follower_timeout` (never a silent hang), and an
overflowing queue rejects rather than growing unbounded.

**Presence semantics — one device, one peer.** All tabs share the leader's
single connection, so a device is exactly ONE presence peer collectively:
identity is `(actorId, leaderClientId)`. A follower's `setPresence`
forwards to the leader's single publisher; there is no per-tab presence
peer. This is the honest model — the wire only ever sees one connection per
device.

With `multiTab` off (the default) the single-tab contract is unchanged: a
losing tab is an `isLeader === false` handle whose calls reject with
`client.not_leader`.

## Durable commit outcomes

`SyncClient` and every host bridge expose `commitOutcome(id)`,
`commitOutcomes({ limit?, activeOnly? })`, and `resolveCommitOutcome(input)`.
Final `applied`, `cached`, `conflict`, and `rejected` results are journaled in
the same SQLite transaction that drains their outbox commit. Conflict entries
retain the losing operation plus `serverVersion`/`serverRow`; active failures
restore after restart and are never removed by retention. Configure the
history cap with `limits.outcomeRetentionMaxEntries` (default 1,000).
Failed outcomes additionally retain the complete ordered local commit envelope
as `outcome.operations`, so a domain recovery flow can reconstruct siblings
that rolled back with the terminating operation. It stays in the protected
client database and is never added to the wire protocol, preferences, or
telemetry; successful and historical outcomes may omit it.

Use `patch(table, rowId, partial, { baseVersion? })` for editor-style partial
updates. The wire still carries a full row, but the durable local operation
records a sorted `changedFields` list so conflict and rejection UI knows which
fields the user intended to touch. That intent is local-only and never enters
`PUSH_COMMIT`; full-row `mutate` operations omit it.

Validator rejections may include bounded `details` (`fieldPaths`, `reason`,
`requiredAction`, and explicitly safe `references`). The details persist with
the rejection. Treat every value as a machine hint: map known values to
localized app UI and never render the diagnostic `message` directly.

Resolution is explicit and one-way: conflicts can keep the server result or
link to a replacement commit, rejections can link to a replacement, and
successful history may be dismissed. See SPEC §7.2.1.

## The support floor (no fallback ladder)

- Persistence is **OPFS via `opfs-sahpool`, only**. No COOP/COEP headers
  and no SharedArrayBuffer are required (sahpool is built on
  `FileSystemSyncAccessHandle`, unlike the Atomics-based `opfs` VFS).
- Browsers without OPFS (~pre-2023) are **unsupported**:
  `openPersistentWasmDatabase` fails loud instead of degrading.
- **Never IndexedDB.** There is no wa-sqlite/absurd-sql style fallback
  and none is planned.
- `openPersistentWasmDatabase` refuses to run on the main thread — not a
  sahpool limitation, an enforcement of whole-core-in-a-worker.

## Blob attachments (§5.9) — the client storage model

File attachments (`blob_ref` columns) ride the `uploadBlob` / `fetchBlob` API
and are cached locally. **Blob bytes live as `BLOB` columns in the client's own
SQLite database** (a `_syncular_blobs` cache table), not in a separate OPFS
directory or IndexedDB store. This is the pinned decision (SPEC §5.9.7 B1):

- **One storage system.** The bytes are transactional with the refcount rows
  that pin them — a refcount adjust and a body insert/delete commit atomically,
  so a crash never strands a body against a stale count.
- **Survives restarts for free.** The client DB already rides OPFS via the
  sahpool VFS in the browser (and a plain file under `rusqlite`/better-sqlite3
  on native/Node), so there is no second persistence surface and no second
  eviction policy to keep coherent. Close the app, reopen it: `fetchBlob` serves
  the cached body with no network.
- **SQLite handles multi-MB images fine.** A page-cached `BLOB` read is a memory
  copy, well within the image/document envelope this targets.

### Size cap + LRU eviction

Pass `blobCacheMaxBytes` to cap the on-device cache. When the sum of cached body
sizes exceeds the cap, the client evicts **zero-ref, non-pinned** bodies in
least-recently-used order until back under the cap:

```ts
new SyncClient({ /* … */, blobCacheMaxBytes: 256 * 1024 * 1024 }); // 256 MiB
```

- A body **referenced by a live row** (refcount > 0) is **never** evicted — it
  stays resolvable without a re-download.
- A body **pinned by a pending upload** (not yet pushed) is never evicted — its
  bytes are the only copy until the commit drains.
- Evicting a zero-ref body only costs a future re-download, never correctness:
  any surviving `blob_ref` value re-enables the fetch (§5.9.7 B3). If every
  over-cap body is referenced or pinned, the cache stays over the cap
  (correctness beats the cap). A cache-hit read touches "recently used", so a
  hot image survives a trim. Absent `blobCacheMaxBytes` ⇒ retain until storage
  pressure (the default).

### Very large media — the escape hatch

SQLite is **not** the store for gigabyte video: a single `BLOB` must fit the
client's memory and the SQLite row-size envelope. For very large media, run the
server with presigned downloads (`blobSignedUrls`) and hand the presigned URL
straight to a media element instead of pulling bytes through the cache — the
image-app default (refcounted `BLOB` cache) and the large-media path (presigned
URL, no byte cache) coexist per attachment.

## Node / Electron-main backend (`./node`)

Hosts that run outside a browser — an **Electron main process**, a plain
**Node** service, a CLI — get a native SQLite backend through
`openNodeDatabase`, a `ClientDatabase` over
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3):

```ts
import { openNodeDatabase } from '@syncular/client/node';
import { SyncClient } from '@syncular/client';

const database = openNodeDatabase('app.db'); // or ':memory:' (default)
const client = new SyncClient({ database, schema, /* … */ });
```

It mirrors the bun:sqlite adapter exactly: synchronous `exec` / `query` /
`transaction` (nested calls are savepoints — an inner failure rolls back only
the inner scope), the same boolean→0/1 bind coercion, `null` round-trips, and
BLOB columns handed back as plain `Uint8Array`s. The §5.3 `withSqliteImage`
attach path is supported too, so a Node host can accept sqlite-image segments.

**better-sqlite3 is an OPTIONAL peer dependency, not a hard one.** The package
installs cleanly without it (browser-only apps never pay for a native build);
`openNodeDatabase()` loads it lazily on first call and throws a clear,
actionable error if the peer is missing. Add it in your app:

```sh
npm install better-sqlite3     # or: bun add better-sqlite3
```

**Verifying the Node adapter — and why not under bun.** bun **cannot** dlopen
better-sqlite3 (`ERR_DLOPEN_FAILED`,
[oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)); calling
`openNodeDatabase()` under bun deliberately raises the same helpful error and
points you at `./bun` instead. So the bun test suite
(`test/node-database.test.ts`) proves what it can under bun — type/subpath
conformance, the missing-peer error, and that the shared behavioral contract
(`test/node-database/adapter-contract.ts`) passes on the reference bun:sqlite
backend — while the better-sqlite3 adapter's real behavior is proven under
**Node** against the actual native module by running that same contract:

```sh
cd packages/web-client
bun run verify:node
```

That bundles the verifier with bun (transpile + resolve only — bun never
executes the native module) and runs the plain-JS bundle under Node, which
exercises `openNodeDatabase` against real better-sqlite3 and exits non-zero on
any divergence from the contract.

## RPC protocol (6 message types)

`init`, `call`, `ready`, `result`, `error`, `event` — every API method
multiplexes over `call` (typed end-to-end from the single `WorkerApi`
shape in `worker-protocol.ts`); `event` carries `sync-needed`,
`change`, `conflict` and `synced`. Query-result blobs transfer (not copy) when
they own their buffer.

## Package layout

| Entry | Contents |
|---|---|
| `.` | protocol core, transports, handle + RPC protocol (browser-safe, no SQLite) |
| `./worker` | `startSyncWorker` — worker-side bootstrap (pulls sqlite-wasm) |
| `./wasm` | sqlite-wasm bindings: `openPersistentWasmDatabase`, `openWasmDatabase` |
| `./bun` | bun:sqlite binding for tests |
| `./node` | better-sqlite3 binding: `openNodeDatabase` (Electron-main / plain Node) |

Tests drive the real worker entry in a bun `Worker` with bun:sqlite
injected through the bootstrap's database-factory override
(`test/worker-rpc.test.ts`); the OPFS path itself is browser-only and is
exercised by `apps/demo`.
