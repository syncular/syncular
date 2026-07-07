# Migrating from 0.1.x

v2 is a **clean break**: a new wire protocol ([SSP2](https://github.com/syncular/syncular/blob/main/SPEC.md)), a new
server storage schema, and a consolidated package set. There is no
in-place upgrade — you stand up a v2 server, port your schema and init code
with this guide, and clients re-bootstrap. What carries over unchanged is the
part that matters: your mental model and your authorization logic.

> **Package names are final.** Everything ships under the `@syncular/*` scope
> (plus the unscoped scaffolder `create-syncular-app`). The names in this guide
> are the names you install — no further rename is coming. The v1-era npm names
> `@syncular/core`, `@syncular/server`, `@syncular/client`, `@syncular/typegen`,
> `@syncular/testkit`, and `create-syncular-app` are reused; the remaining
> packages (`@syncular/react`, `@syncular/crdt-yjs`,
> `@syncular/server-hono`, `@syncular/server-workers`, `@syncular/tauri`,
> `@syncular/react-native`) are new names reserved for this release.

## What stayed the same

The v1 semantics survive intact — port your mental model unchanged:

- **Scopes decide what syncs.** Rows are authorized by scope patterns like
  `user:{user_id}`, resolved per actor by a function that runs in *your*
  backend. Even the pattern syntax is the same
  ([Scopes & authorization](/concepts-scopes/)).
- **A server-authoritative commit log.** Clients pull ordered commits from a
  cursor; push is idempotent under retry
  ([Commits, cursors, idempotency](/concepts-commits/)).
- **The optimistic outbox.** `mutate` applies locally at once, queues the
  commit, and replays it after any offline gap
  ([Conflicts & optimistic writes](/concepts-conflicts/)).
- **Conflicts surface, never auto-resolve.** `baseVersion` checking rejects
  stale writes with a conflict record carrying the current server row.
- **Local SQLite is the query API.** You read your own tables with SQL.

## What changed conceptually

| v1 concept | v2 concept |
|---|---|
| Rust-WASM client — `@syncular/client` hosted a Rust binary in a worker | TypeScript client core on sqlite-wasm + OPFS (`@syncular/client`); the Rust core is a separate *native* client, kept in lockstep by a [conformance suite](/guide-conformance/) |
| SSP1, implicit — the protocol lived in code (wire v14) | SSP2, written — [SPEC.md](https://github.com/syncular/syncular/blob/main/SPEC.md) + golden vectors are normative |
| Dialect entry points — `@syncular/server/sqlite`, `/postgres`, `/pglite`, `/d1`, … | Storage backends in `@syncular/server`: `SqliteServerStorage`, `PostgresServerStorage`, `D1ServerStorage` (Workers) |
| HTTP push/pull loop + WS wake-ups | [WebSocket-native sync rounds](/concepts-realtime/) — one loop, over the socket ([SPEC §8.7](https://github.com/syncular/syncular/blob/main/SPEC.md#87-sync-rounds-over-the-socket)) |
| Snapshot chunks *and* snapshot artifacts (two systems) | One **bootstrap segment** concept, `rows` or `sqlite` media type ([Bootstrap & segments](/concepts-bootstrap/)) |
| Client-side migrations (`@syncular/migrations`) | No client migration engine — [wipe-and-rebootstrap](/guide-schema/) with the outbox preserved ([SPEC §7.4](https://github.com/syncular/syncular/blob/main/SPEC.md#74-schema-bump-flow--wipe-re-bootstrap-replay)) |
| `syncular.app.ts` authoring + Rust codegen binary | SQL migrations + `syncular.json` manifest + `syncular generate` — pure TypeScript, no cargo ([Schema & typegen](/guide-schema/)) |
| Relay (`@syncular/server/relay`) | Retired — realtime is a second binding of the same handler; multi-instance fanout is LISTEN/NOTIFY; Workers is a Durable Object design |
| Per-package micro-surface (~23 packages) | Consolidated set — see the [package map](/reference/): `core`, `server`, `server-hono`, `server-workers`, `client`, `react`, `crypto`, `crdt-yjs`, `typegen`, `tauri`, `testkit`, `create-syncular-app` |
| Full React console app (`@syncular/console`) | `SyncularAdmin` query surface + a single static admin page in `@syncular/server-hono` |
| `@syncular/testkit` mocks | `@syncular/testkit` reborn without mocks — an in-memory loopback of the real server + real clients for app tests; protocol work uses the conformance catalog ([Protocol & conformance](/guide-conformance/)) |

## Step by step

### 1. Schema

v1 authored the sync contract in TypeScript (`syncular.app.ts`) and ran a
Rust codegen binary:

```ts
// v1 — syncular.app.ts
import { defineSyncularClient, scope, syncedTable } from '@syncular/typegen';

export const app = defineSyncularClient({
  tables: {
    tasks: syncedTable({
      table: 'tasks',
      serverVersion: 'server_version',
      scopes: [scope('user_id', { column: 'user_id', source: 'actorId' })],
    }),
  },
});
```

```sh
npx syncular generate        # v1: emits codegen JSON, runs the Rust binary
```

v2 reads your **SQL migrations** for table shape and one **manifest** for
sync semantics, and generates a zero-import TypeScript module — no Rust
toolchain anywhere:

```json
// v2 — syncular.json
{
  "manifestVersion": 1,
  "migrations": "./migrations",
  "output": { "ir": "./syncular.ir.json", "module": "./src/syncular.generated.ts" },
  "schemaVersions": [{ "version": 1, "through": "0001_initial" }],
  "tables": [{ "name": "tasks", "scopes": ["user:{user_id}"] }],
  "subscriptions": [
    { "name": "tasksForUser", "table": "tasks", "scopes": { "user_id": ["{userId}"] } }
  ]
}
```

```sh
syncular init             # scaffold manifest + first migration
syncular generate         # → src/syncular.generated.ts (commit it)
```

Notes for porting: the scope pattern syntax is unchanged
(`user:{user_id}`); the explicit `server_version` column is gone — versioning
is protocol-level now; there are no `blobColumns` — declare a `BLOB_REF`
column type in the migration instead ([Blobs](/concepts-blobs/)). The full
manifest contract is the [typegen README](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md).

### 2. Server

v1 built per-table handlers (each with its own scope resolver) over your
Kysely database and a dialect:

```ts
// v1
import { createServerHandler } from '@syncular/server';
import { createSyncServer } from '@syncular/server/hono';
import { createSqliteServerDialect } from '@syncular/server/sqlite';

const tasksHandler = createServerHandler({
  table: 'tasks',
  scopes: ['user:{user_id}'],
  resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
});

const { syncRoutes } = createSyncServer({
  db,                                   // your Kysely instance
  dialect: createSqliteServerDialect(),
  sync: { authenticate, handlers: [tasksHandler] },
});
app.route('/sync', syncRoutes);
```

v2 takes the generated `schema` object, a storage backend, and **one**
`resolveScopes` for the whole actor — no per-table handlers, and the server
owns its own database (you never hand it your Kysely instance):

```ts
// v2
import {
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import { schema } from './syncular.generated';

const config: SyncServerConfig = {
  schema,
  storage: new SqliteServerStorage('./data.db'),
  segments: new MemorySegmentStore(),
  resolveScopes: async ({ actorId }) => ({ user_id: [actorId] }),
};

const app = createSyncularHono({
  config,
  authenticate: async (request) => {
    const actor = await verify(request); // your auth
    return actor ? { actorId: actor.id, partition: actor.tenant } : null;
  },
});
Bun.serve({ port: 8787, fetch: app.fetch });
```

Dialect mapping: `@syncular/server/sqlite` → `SqliteServerStorage`;
`/postgres` → `PostgresServerStorage` (bring your driver through the
`PgExecutor` seam); `/d1` → `D1ServerStorage` via `@syncular/server-workers`.
The v1 `pglite`/`libsql`/`neon`/`better-sqlite3` dialects have no v2
equivalent — the policy is adapters only where the conformance catalog runs.
See [Server setup](/guide-server/).

### 3. Client

v1's client was a generated helper over the Rust-WASM worker, with Kysely
reads and generated per-table mutation objects:

```ts
// v1
const syncular = await createSyncularAppDatabase({
  config: { baseUrl: '/sync', actorId, clientId, fileName: 'app.sqlite' },
  getHeaders: async () => ({ authorization: `Bearer ${token}` }),
});

const rows = await syncular.db.selectFrom('tasks').select(['id', 'title']).execute();
await syncular.mutations.tasks.insert({ title: 'hi', user_id: actorId });
const live = await syncular.live(query, { onChange: render });
```

v2's browser client is the TypeScript core in an OPFS worker, driven by a
handle; reads are plain SQL, writes are explicit change lists:

```ts
// v2
import { createSyncClientHandle } from '@syncular/client';
import { schema } from './syncular.generated';

const client = await createSyncClientHandle({
  worker: () => new Worker('/worker.js', { type: 'module' }),
  schema,
  database: { mode: 'persistent', name: 'my-app' },
  endpoints: { syncUrl: '/sync', segmentsUrl: '/segments', realtimeUrl: 'wss://…/realtime?clientId={clientId}' },
});

client.subscribe({ id: 'tasks', table: 'tasks', scopes: { user_id: [actorId] } });
await client.connectRealtime();
await client.syncUntilIdle();

const rows = await client.query('SELECT id, title FROM tasks ORDER BY id');
await client.mutate([
  { table: 'tasks', op: 'upsert', values: { id: crypto.randomUUID(), user_id: actorId, title: 'hi' } },
]);
```

Porting notes: Kysely reads move to [named queries](/tooling-queries/) —
author a `.sql` file, typegen type-checks it against your real schema and
emits a typed function (raw SQL via `client.query` remains the base layer,
guarded read-only);
`mutations.tasks.insert(...)` becomes
`mutate([{ table, op: 'upsert', values }])` (the wire is full-row upserts);
`live(query, { onChange })` becomes either the React `useQuery` / `useRawSql`
hooks (below) or `client.onInvalidate` — one `{ tables, scopeKeys }` event per
apply batch to drive your own re-query. Subscriptions are registered on the client
(`client.subscribe(...)`), not passed at construction. There is no
IndexedDB storage option — persistent means OPFS, and unsupported browsers
fail loud. See [Web client](/guide-client/).

### 4. React hooks

v1 created a typed hook set per app (`createSyncularReact<DB>()`); v2 exports
hooks directly from `@syncular/react` — wrap your tree in `SyncProvider`
and import:

| v1 hook | v2 |
|---|---|
| `SyncProvider` | `SyncProvider` (takes a `SyncClient` or worker handle) |
| `useSyncQuery(kyselyQuery)` (live) | `useQuery(descriptor, params?)` for generated named queries, or `useRawSql(sql, params?, { tables? })` — both live via fine-grained invalidation |
| `useQuery` (one-shot) | `useQuery` / `useRawSql` (all queries are live; `enabled` opts out) |
| `useMutations` / `useMutation` | `useMutation` |
| `useLeasedMutations` / `useLeasedMutation` | retired — see [leases](#7-auth-leases) below; ordinary `useMutation` |
| `useOutboxStats`, `useSyncStatus`, `useSyncConnection` | `useSyncStatus` |
| `useConflictStats` | `useConflicts` |
| `usePresence` / `usePresenceWithJoin` | `usePresence(scopeKey)` + `client.setPresence(scopeKey, doc)` |
| `useBlob` / `useBlobUploadQueue` | no hook — `client.uploadBlob` / `client.fetchBlob` directly |
| `useRowsChanged` | `client.onInvalidate` (or just depend on `useQuery` / `useRawSql`) |

The [react source](https://github.com/syncular/syncular/blob/main/packages/react/src/index.ts) documents the
invalidation granularity contract (`tables` is the reliable floor; scope-key
narrowing only where the wire carried keys).

### 5. Blobs

v1: `syncular.blobs.store(file, { mimeType })` → a `BlobRef` written into a
column declared via `blobColumns`, with an upload queue you could flush.
v2: declare a `BLOB_REF` column in the migration, then upload-before-push:

```ts
const ref = await client.uploadBlob(bytes, { mediaType: 'image/png', name: 'a.png' });
await client.mutate([{ table: 'tasks', op: 'upsert', values: { /* … */, attachment: client.blobRefString(ref) } }]);
const bytesBack = await client.fetchBlob(row.attachment);
```

Same model (content-addressed, refcounted cache, download re-authorized per
request), tighter surface. See [Blobs](/concepts-blobs/) and
[SPEC §5.9](https://github.com/syncular/syncular/blob/main/SPEC.md#59-blobs--file-attachments).

### 6. CRDT fields

v1 declared Yjs text columns in the authoring layer (`yjsText({ stateColumn })`)
with client CRDT adapters. v2 makes it a column type: declare `CRDT` in the
migration, register the merger on the server, and use the `YjsColumn` helper
on the client:

```ts
// server
import { yjsCrdtMergers } from '@syncular/crdt-yjs';
const config: SyncServerConfig = { /* … */, crdtMergers: yjsCrdtMergers };
```

Semantics moved server-side: clients push Yjs *updates*, the **server
merges**, and `crdt` columns are excluded from `baseVersion` conflict
detection — concurrent edits converge instead of conflicting
([SPEC §5.10](https://github.com/syncular/syncular/blob/main/SPEC.md#510-crdt-columns--opt-in-collaborative-state)).
v1's `encrypted-crdt` has no v2 equivalent: v2 [E2EE](/concepts-encryption/)
is per-column, and a server-merged `crdt` column cannot be an encrypted
column (the server cannot merge bytes it cannot read).

### 7. Auth leases

The v1 lease was client-driven: `issueAuthLease({ schemaVersion, scopes })`
granted per-operation offline write capability, used through
`leasedMutations`, with seven `sync.auth_lease_*` error codes.

The v2 lease is **server-issued and client-opaque**: enable
`leases: { ttlMs }` on the server config and the server records each actor's
resolved scopes as a signed, time-bounded grant, refreshed on every authorized
round. Its job is narrower — keeping sync authorized across a scope-resolver
outage — and there is no separate leased-write path: clients keep calling
`mutate`, and expose only a read-only `leaseState`. Two codes survive
(`sync.auth_lease_required`, `sync.auth_lease_revoked`); the other five are
pruned with rationale in
[SPEC §10.3](https://github.com/syncular/syncular/blob/main/SPEC.md#103-pruned-and-reserved-codes). Details:
[SPEC §7.3](https://github.com/syncular/syncular/blob/main/SPEC.md#73-auth-leases).

### 8. Presence

v1: `joinPresence(key, meta)` / `updatePresenceMetadata` / `leavePresence` /
`addPresenceListener`. v2 collapses join/update/leave into one call:

```ts
await client.setPresence('list:welcome', { editing: 'task-1' }); // join/update
await client.setPresence('list:welcome', null);                  // leave
const peers = await client.presence('list:welcome');
client.onPresence((scopeKey) => rerender(scopeKey));
```

Same model — ephemeral, scope-keyed, lost on disconnect; publishing requires
holding the scope key ([SPEC §8.6](https://github.com/syncular/syncular/blob/main/SPEC.md#86-presence)).

## Data migration — the honest story

v2 changes the wire protocol **and** the server storage schema, and this
rung ships **no automated data-migration tool**. Plainly: moving production
data is an export/import you write yourself, against your v1 database.

**Server data.** In v1 your application rows live in *your* database (the
Kysely instance you handed to `createSyncServer`); the `sync_*` bookkeeping
tables next to them are v1-internal and do not port. The working recipe is a
one-off backfill script: stand up the v2 server fresh, read the current rows
out of the v1 database, and push them into v2 as ordinary commits through a
backfill client (a `SyncClient` with a wide-open `resolveScopes` for the
backfill actor, batching `mutate` + `sync`). That replays your data through
the front door — scope extraction, versioning, and the commit log all come
out right by construction. Verify counts per table and per scope key before
cutover.

**Client data.** There is nothing to migrate — v2 clients **re-bootstrap from
the server**, and that is the design, not a workaround: fresh bootstrap rides
the [segment path](/concepts-bootstrap/) (a 100k-row SQLite image applies in
tens of milliseconds), the same flow every v2
[schema bump](/guide-schema/) already drills.

**Pending offline writes.** The v1 outbox cannot replay into a v2 server
(different wire, different encoding). Have v1 clients drain their outboxes —
sync to idle — before you cut over; anything still queued at cutover is lost
with the v1 database.

## What's not in v2

Three gaps this guide once listed have since **shipped**: E2EE
([per-column client-side encryption](/concepts-encryption/), with
`@syncular/crypto` for the key primitives), the binding packages
(`@syncular/tauri` + the `tauri-plugin-syncular` Rust plugin on npm;
`@syncular/react-native` in the repo at
[bindings/react-native](https://github.com/syncular/syncular/tree/main/bindings/react-native),
with npm publication a follow-up), and typed reads — as
[generated named queries](/tooling-queries/), not a runtime query builder
(a Kysely dialect shipped briefly and was retired in favor of them). What
genuinely remains out:

- **The relay.** Retired, not pending: v2 realtime is a second binding of the
  same sync handler, multi-instance fanout is LISTEN/NOTIFY, and the Workers
  path is a Durable Object design — each relay job is covered by a core
  mechanism.
- **The full React console.** Replaced by the leaner `SyncularAdmin` query
  surface + one static admin page ([Server setup](/guide-server/)).
- **Storage breadth.** No `pglite`/`libsql`/`neon`/`better-sqlite3` dialects;
  v2 ships SQLite (bun:sqlite), Postgres, and D1 — adapters exist only where
  the conformance catalog runs.
- **IndexedDB fallback, HTTP polling loop, service-worker transport.** All
  retired under the one-good-path rule: OPFS or fail-loud, sync over the
  socket, no degraded modes.
- **Node ClientDatabase.** The TS client's persistent backend is browser
  OPFS; a better-sqlite3 adapter for plain-Node / Electron-main hosts is
  roadmap.

## Where to go next

- [Quickstart](/quickstart/) — the v2 shape end to end in five minutes
  (`bun create syncular-app my-app`).
- [Server setup](/guide-server/) and [Web client](/guide-client/) — the full
  wiring this guide's snippets abridge.
- [SPEC.md §0](https://github.com/syncular/syncular/blob/main/SPEC.md#0-deliberate-simplifications-vs-wire-v14--decisions)
  — every v1→v2 protocol simplification, with the reasoning, decision by
  decision.
