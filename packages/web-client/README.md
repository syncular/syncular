# @syncular-v2/web-client

The TypeScript client protocol core (SPEC.md §§3–8, client side) plus its
browser platform bindings.

## Browser modes — there are exactly two

**Persistent worker mode is THE mode** (REVISE Direction decision 2,
2026-07-03). The whole client core — `SyncClient`, the fetch/WebSocket
transports, and SQLite on the `opfs-sahpool` VFS — runs inside a Web
Worker. The UI thread talks to it through a thin postMessage RPC:

```ts
// worker.ts — the worker entry your bundler emits as its own script
import { startSyncWorker } from '@syncular-v2/web-client/worker';
startSyncWorker();
```

```ts
// main thread
import { createSyncClientHandle } from '@syncular-v2/web-client';

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
it (`req`/`res`), while the leader fans its worker events —
invalidate / presence / conflict / sync-needed / synced / upgrading — out
to all followers (`event`). Queries forward to the leader's one DB; rows
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

## Node / Electron-main backend (`./node`)

Hosts that run outside a browser — an **Electron main process**, a plain
**Node** service, a CLI — get a native SQLite backend through
`openNodeDatabase`, a `ClientDatabase` over
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3):

```ts
import { openNodeDatabase } from '@syncular-v2/web-client/node';
import { SyncClient } from '@syncular-v2/web-client';

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
`conflict` and `synced`. Query-result blobs transfer (not copy) when
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
