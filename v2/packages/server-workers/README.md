# @syncular-v2/server-workers

The Cloudflare Workers entry for the Syncular v2 sync server (TODO §4.2). It
wires the runtime-neutral server core to Workers bindings — **D1** for
storage, **R2** for durable segment/blob bytes, secrets for signing and
auth — behind a standard Workers module `fetch` handler.

This package is deliberately thin. `@syncular-v2/server-hono`'s
`createSyncularHono` is already Workers-native (it routes with Hono, which
runs unmodified on `workerd`, and speaks only Web `Request`/`Response`/
`fetch`/Web-Crypto). So the Workers lane is not a second adapter — it is the
same HTTP handler wired to `env` bindings.

## What it mounts

The HTTP binding (SPEC §1.1):

| Route | Method | Purpose |
|---|---|---|
| `<mount>/sync` | POST | Combined push+pull (§4, §6) |
| `<mount>/segments/{id}` | GET | Bootstrap segment download (§5.5) |
| `<mount>/blobs/{id}` | PUT | Blob upload, content-address verified (§5.9.3) |
| `<mount>/blobs/{id}` | GET | Blob download, row-derived re-auth (§5.9.5) |

**Realtime (`GET <mount>/realtime`, §8) is NOT mounted by this rung** — see
"Workers realtime — the DO follow-up" below. Per SPEC §1.1 an HTTP-only
deployment is fully conformant: reference clients that cannot open the socket
sync over `POST /sync`, which carries identical semantics. This is a smaller,
complete deployment, not a degraded one — no fallback is implied.

## Usage

```ts
// src/worker.ts
import {
  D1ServerStorage,
  S3SegmentStore,
  s3PresignedUrls,
  type SyncServerConfig,
} from '@syncular-v2/server';
import { createWorkersFetchHandler } from '@syncular-v2/server-workers';
import { schema } from './syncular.generated'; // typegen output

interface Env {
  DB: D1Database; // wrangler.toml [[d1_databases]] binding = "DB"
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  SYNC_JWT_SECRET: string;
}

function syncConfig(env: Env): SyncServerConfig {
  const segments = new S3SegmentStore({
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: 'auto',
    bucket: 'syncular-segments',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
  return {
    schema,
    storage: new D1ServerStorage(env.DB),
    segments,
    // §5.4 delegated presign: R2 mints the segment URL directly.
    signedUrls: s3PresignedUrls(segments, { ttlSeconds: 900 }),
    resolveScopes: (args) => resolveScopes(args, env),
    // No `sqliteImageBuilder`: Workers has no SQLite engine, so bit-2
    // clients are served the rows lane (§5.3 support floor). No `realtime`:
    // the DO follow-up.
  };
}

export default {
  fetch: createWorkersFetchHandler<Env>((env) => ({
    config: syncConfig(env),
    authenticate: (request) => authenticate(request, env),
  })),
};
```

`createWorkersFetchHandler(factory)` builds the Hono app once per request from
the factory and delegates. Building per request keeps the handler stateless
(no module-global mutable server) — the Workers-correct posture, since each
invocation may run on a fresh isolate.

See `wrangler.toml.example` for the binding config.

## Schema migration (D1)

`D1ServerStorage` does **not** apply its DDL on construction (a cold request
must never race a schema apply). Apply it once with wrangler. Generate the
migration SQL from `sqliteDdlStatements()` (exported from `@syncular-v2/server`)
into a `migrations/` file, then:

```sh
wrangler d1 create syncular
wrangler d1 migrations apply syncular
```

The schema is plain SQLite DDL (shared with `bun:sqlite` via
`sqlite-dialect.ts`), so it is portable across the two SQLite-family
storages.

## Storage: D1 (`D1ServerStorage`)

D1 *is* SQLite over an async, statement-at-a-time API, so `D1ServerStorage`
shares the schema and value codecs with `SqliteServerStorage` (the
`sqlite-dialect.ts` module) and differs only in execution shape.

**Transaction model.** D1 has no interactive transaction — the only atomic
primitive is `db.batch([...])`. The push handler reads first (conflict
detection) then writes, so `D1ServerStorage`'s transaction executes reads
immediately (autocommit) and **buffers** writes, flushing them as one atomic
`db.batch()` at `commit()` (the §6.4 all-or-nothing commit; a rejected op
rolls back by never flushing). A read-your-own-writes overlay makes `getRow`
see buffered writes of the same commit.

**Concurrency posture.** The dense per-partition `commitSeq` (§2.1) is
allocated by reading `max_commit_seq` live and buffering the `+1`. Under one
Worker request this is exact. For two concurrent pushes to the *same
partition*, serialize the writes: the DO realtime host (the follow-up) is the
natural per-partition serialization point; a stateless HTTP-only deployment
that expects concurrent same-partition writes SHOULD front D1 per-partition
writes with a coordinating primitive (a DO or a Queue). This mirrors
Postgres's per-partition row lock, achieved by placement rather than a lock
D1 does not expose. Cross-partition pushes never contend.

## Workers realtime — the DO follow-up (designed, deferred)

The realtime channel (§8) needs a durable, stateful WebSocket host. On
Workers that is a **Durable Object**. The design is mechanical from here; it
is deferred out of this rung, not unsolved:

- **One DO class hosting the `RealtimeHub` per partition-shard.** The DO id is
  derived from the partition (or a partition-shard, if a partition's fan-out
  outgrows one DO), so all of a partition's sockets and its commit fan-out
  live in one single-threaded DO — which is also the per-partition write
  serialization point the D1 storage wants (see "Concurrency posture").
- **WebSocket hibernation.** The DO uses the Hibernation API
  (`state.acceptWebSocket(ws)` + `webSocketMessage`/`webSocketClose`
  handlers) so idle connections do not pin the DO in memory or bill wall
  time. The existing `RealtimeSession` (`@syncular-v2/server`) is the
  per-connection state machine; the DO holds one `RealtimeSession` per
  accepted socket, keyed by the hibernation tag, and drives it from the
  hibernation callbacks — the same `createSyncResponseStream` the HTTP `/sync`
  binding uses (§8.7: two framings, one handler).
- **Storage via D1.** The DO reads/writes the same `D1ServerStorage` over the
  D1 binding (a DO can hold a D1 binding), so realtime rounds and `POST /sync`
  rounds share one commit log and one segment store. Commit fan-out (§8.2)
  runs in-DO: a push landing in the DO notifies the hub's registered
  sessions directly — no LISTEN/NOTIFY needed, because the partition's writes
  and its sockets are co-located in the one DO.
- **The Worker's `fetch` upgrades to the DO.** `GET <mount>/realtime` in the
  Worker resolves the partition's DO stub and forwards the upgrade
  (`stub.fetch(request)`); the DO does `new WebSocketPair()` +
  `acceptWebSocket`.

Building it is a self-contained follow-up: add the DO class, its
`wrangler.toml` binding + migration (sketched in `wrangler.toml.example`),
and the `/realtime` upgrade route — the session/hub/storage pieces it needs
already exist and are runtime-neutral.

## Runtime neutrality

The server core this entry loads (handler, realtime session, D1 storage,
memory stores, signed-URL/segment/blob machinery) is free of Bun- and
Node-only builtins — SigV4 and all hashing use Web Crypto, base64 uses
`btoa`/`atob`, and the SQLite-family stores that need `bun:sqlite`
(`SqliteServerStorage`, `SqliteSegmentStore`, `SqliteBlobStore`,
`SqliteLeaseStore`, `buildSqliteImage`) live in separate modules a Bun/Node
host opts into and a Workers bundle tree-shakes away. This is enforced by a
static import-graph scan in
`packages/server/test/runtime-neutrality.test.ts`.
