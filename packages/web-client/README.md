# @syncular/client

The TypeScript client protocol core (SPEC.md §§3–8, client side) plus its
browser platform bindings.

## Client-local FTS5 projections

Generated schemas may attach `ftsIndexes` to a synced table (RFC 0005). The
client materializes each as a contentful local FTS5 table with a private stable
source identity and insert/update/delete triggers. Existing visible rows are
bulk-indexed on first creation; schema reset recreates the projection. The FTS
table is a read-only application query surface: it is never synced, subscribed,
or mutated. A missing FTS5 build fails schema setup explicitly—Syncular does
not substitute an unbounded `LIKE` scan. Indexed fields must be non-encrypted
strings.

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
  // Another tab owns the core for this origin. The default multi-tab mode
  // transparently proxies this handle to that leader.
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

By default, every tab of the same origin shares ONE core:
one sync loop, one WebSocket, one OPFS database, N tabs.

```ts
const handle = await createSyncClientHandle({
  worker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  schema, database: { mode: 'persistent', name: 'app' }, endpoints,
  onRoleChange: (role) => console.log('now', role), // 'follower' → 'leader'
});
// Compatibility: handle.role is 'leader' or 'follower'.
// Detailed state: handle.leadership / handle.leadershipSnapshot().
handle.onLeadershipChange((state) => renderConnectionState(state));
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

Leader announcements continue as heartbeats while followers are attached. If
a tab can acquire neither a response nor a new lock grant before the configured
`followerCallTimeoutMs`, `handle.leadership` becomes
`{ state: 'blocked', reason: 'leader-unreachable', code:
'client.follower_timeout', retryable: true }`. Calls then reject immediately.
A later announcement rebinds the same handle; a granted Web Lock promotes it.
An unreachable `BroadcastChannel` is never treated as evidence that the lock
owner is stale, so it never authorizes a second worker or database owner.

**Presence semantics — one device, one peer.** All tabs share the leader's
single connection, so a device is exactly ONE presence peer collectively:
identity is `(actorId, leaderClientId)`. A follower's `setPresence`
forwards to the leader's single publisher; there is no per-tab presence
peer. This is the honest model — the wire only ever sees one connection per
device.

The default is a **shared replica**: same-origin tabs must use the same
persistent database name, lock name, and derived channel name. For an embed,
preview, or history entry that is intentionally independent, derive the whole
ownership tuple from one stable identity:

```ts
const preview = await createSyncClientHandle({
  worker,
  schema,
  database: { mode: 'persistent', name: 'medical' },
  endpoints,
  replica: { mode: 'isolated', id: 'preview-42' },
});
```

This derives a distinct database name and pool directory, Web Lock name, and
`BroadcastChannel` name together. `isolatedReplicaNames()` exposes the same
deterministic tuple for diagnostics and host integration. Replica IDs are
stable code-like values (`A-Z`, `a-z`, `0-9`, dot, underscore, dash).

During Vite development, retain the React client resource only while its
captured generated schema version and published Syncular runtime identity both
match. The
[schema-and-runtime-aware Vite guide](https://syncular.dev/guide-vite/) uses
`retainViteSyncClientResource` to close the old worker before constructing a
schema-bump or package-upgrade replacement; hot-reloading query code alone does
not migrate the worker-owned database.

Set `multiTab: false` to opt out. A losing tab then becomes an
`isLeader === false` handle whose calls reject with `client.not_leader`. This
does not solve a coordination-partition mismatch by itself: an independent
instance must also use an isolated database and lock identity. Changing only
the channel, lock, or database name is unsafe or ineffective.

## React availability guard

The worker handle's schema and leadership snapshots feed the same public React
boundary as native clients. Guard the application once instead of parsing
errors or inspecting generated schema modules:

```tsx
<SyncProvider
  client={clientResource}
  renderBoundary={(state, actions) => (
    <SyncBlockedScreen state={state} onRetry={actions.retry} />
  )}
>
  <App />
</SyncProvider>
```

The state is a discriminated union covering startup, migration,
`client-upgrade-required`, `server-behind`, `incompatible-schema`, and
`leader-unreachable`. Recovery changes the same handle/provider back to its
children; a blocked live query has `phase === 'blocked'`, never an indefinite
loading state.

## Privacy-safe support diagnostics

Every direct and Worker/multi-tab client exposes the same versioned snapshot:

```ts
const snapshot = await client.diagnosticsSnapshot({
  expectedSubscriptions: [
    { id: 'membership-security', table: 'facility_memberships' },
    { id: 'scheduler-window', table: 'surgeries' },
  ],
});

const off = client.onDiagnostics(() => refreshSupportView());
```

`expectedSubscriptions` contains application intent only—stable PHI-free ids
and generated table names, never scopes. It lets a support screen distinguish
an absent registration from a legitimate zero-row completed bootstrap. The
snapshot also distinguishes reset, revocation, failure, schema floor, lease
stop, pending outbox, offline transport, and storage pressure/unreadability.
Worker leaders and followers return identical evidence with their honest role.

The contract intentionally excludes scope values, rows and clinical row
counts, SQL, paths, client/actor/lease ids, auth, keys, mutation bodies, stack
traces, and arbitrary prose. It is safe to copy the JSON snapshot into a
redacted support ticket as long as the application also keeps subscription ids
free of patient/user data. Do not attach database files, console dumps, query
results, or app state alongside it. See SPEC §7.6.

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

Rejected optimistic state is removed immediately, even when a validator emits
no server row in the pull half. The TypeScript client stores protected,
restart-safe before-images beside each pending outbox commit, restores the last
confirmed rows (including rejected deletes and atomic siblings), and then
replays later pending edits. These before-images are internal rollback state:
they are never encoded on the wire or exposed through pending commits, outcome
envelopes, diagnostics, preferences, or telemetry.

Use `patch(table, rowId, partial, { baseVersion? })` for editor-style partial
updates. The wire still carries a full row, but the durable local operation
records a sorted `changedFields` list so conflict and rejection UI knows which
fields the user intended to touch. That intent is local-only and never enters
`PUSH_COMMIT`; full-row `mutate` operations omit it.

## Application-authorized local security purge

`purgeLocalData({ purgeId, targets })` is the narrow local-storage primitive
for an application that has already validated a server-authoritative device,
membership, or key-revocation directive. It is available on direct clients,
worker handles, the normalized React client, and the Tauri bridge.

```ts
const result = await client.purgeLocalData({
  purgeId: directive.id,
  targets: [
    {
      table: 'patient_notes',
      selectors: { encryption_key_id: [directive.keyVersionId] },
    },
  ],
});
```

The host MUST first quarantine the affected feature and gate/remove any
subscription that could download the protected rows again. This method does
not authenticate a directive, revoke server authority, delete app-owned files,
or remove a key from the OS secure store.

For a race-free bootstrap, construct the client/worker handle with
`securityPreflight: true`. Before activation, protected reads, writes,
subscriptions, sync/realtime, blobs, and the automatic host loop fail with
`client.security_preflight_required`; status, local revision, lifecycle, and
the exact local purge remain available.

```ts
const client = await createSyncClientHandle({
  ...config,
  securityPreflight: true,
});

await client.purgeLocalData(directive.plan);
await client.activateSecurity({ encryption: acceptedKeyring });
```

Use `beginSecurityPreflight()` before a live key rotation/revocation. It gates
new calls immediately, disconnects realtime, waits for in-flight core/blob work,
and releases the old keyring before resolving. In multi-tab mode the gate
belongs to the single shared leader replica. Direct clients expose the same
lifecycle with an `EncryptionConfig`; Worker handles use the portable keyring.

Within one local SQLite transaction the engine deletes exactly the matching
synced rows, lets generated FTS triggers remove their projections, drops every
whole pending commit with a matching operation, restores/replays unrelated
optimistic state, reconciles blob references, persists the `purgeId`, and emits
one revisioned change batch. A retry with the same canonical plan returns
`alreadyApplied: true`; reusing an id with different selectors fails closed.
Only bounded, non-empty, code-like values on plaintext string schema columns
are accepted. There is intentionally no full-table mode. The result exposes
counts only—never row ids or selector values.

## Application-authorized projection rebootstrap

`rebootstrapLocalData({ rebootstrapId })` is the recovery primitive for a
locally damaged or persistently inconsistent replicated projection. It drops
and recreates only Syncular's server-derived tables, rewinds the existing
subscription registrations, and requests a fresh bootstrap. It preserves the
client id, lease state, pending outbox commits, commit outcomes, subscription
intent, and protected bookkeeping.

```ts
const result = await client.rebootstrapLocalData({
  rebootstrapId: crypto.randomUUID(),
});
```

The reset, durable idempotency marker, and optimistic outbox replay are one
SQLite transaction. An interruption therefore leaves either the old
projection or the fully reset projection with pending offline work still
visible. Reusing the same id returns `alreadyApplied: true`. The counts-only
result reports retained commits and reset subscriptions without exposing ids,
rows, scopes, or clinical values.

Worker, Tauri, and React Native adapters strictly decode the exact result
shape before returning it. Missing or additional fields, a non-boolean
`alreadyApplied`, or counts that are not non-negative safe integers fail with
`client.invalid_host_response`; raw bridge values and native error prose must
not be persisted as recovery evidence. `decodeLocalDataRebootstrapResult()` is
public for custom command hosts that expose the same operation.

This API is not a security erase, sign-out, membership revocation, schema
upgrade, or draft deletion mechanism. It fails closed during security
preflight and while a schema-floor stop is active. The application must show a
preview and explicit confirmation, preserve app-owned drafts/files separately,
and reserve the operation for diagnostics/support recovery rather than normal
startup.

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

### OPFS ownership and startup recovery

An OPFS SAH pool has exactly one live owner per storage directory. Syncular's
default multi-tab mode prevents ordinary same-origin tabs from opening a second
pool: followers proxy the one leader over `BroadcastChannel`. A collision can
still happen during rapid hot-module replacement, or in an embedded/test host
that shares OPFS data without sharing the same Web Locks and BroadcastChannel
coordination domain.

Pool acquisition failures surface as `ClientSyncError` with code
`client.storage_busy` and `retryable === true`. Treat that as a startup state:
close the competing instance or let it finish shutting down, then create the
handle again. **Do not delete, rename, or silently replace the database with an
in-memory one**; the local database and pending outbox may be perfectly healthy.
Missing or obsolete OPFS APIs instead use the non-retryable
`client.storage_unavailable` code.

A worker graph that still names a retired Vite optimizer chunk instead uses
the non-retryable `client.worker_restart_required` code. Restart the dev server
and reload the page; do not clear OPFS. The original bundler message and chunk
URL are deliberately not copied into the public error.

When using `@syncular/react`, `createSyncClientResource()` exposes `retry()` and
passes the same action as the second argument to `SyncProvider.renderError`.
Applications may use a small bounded backoff for errors whose `retryable` flag
is true, followed by a visible manual retry. Preserve the resource across HMR
or dispose the previous resource before replacing it so development reloads do
not manufacture a second owner.

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
