# Cloudflare Workers

`@syncular/server-workers` runs the sync server on Cloudflare's edge — D1
for storage, R2 for segment and blob bytes, and a Durable Object for
realtime. This page takes you from a bare Worker to a full deployment with
WebSockets and scheduled blob GC.

The package is deliberately thin: the server core is runtime-neutral
TypeScript (Web `Request`/`Response`/`fetch`/Web-Crypto only, enforced by a
static import-graph test), so the Workers lane is the same HTTP handler
wired to `env` bindings, not a second implementation.

## The fetch handler

`createWorkersFetchHandler(factory)` builds the Hono app per request from
your factory — stateless, the Workers-correct posture, since each
invocation may run on a fresh isolate. It mounts the same routes as the
Bun/Node adapter: `POST /sync`, `GET /segments/:id`, `PUT|GET /blobs/:id`,
plus `GET /realtime` when the Durable Object is enabled.

```ts
// src/worker.ts
import {
  D1ServerStorage,
  S3BlobStore,
  S3SegmentStore,
  s3PresignedBlobUrls,
  s3PresignedUrls,
  type SyncServerConfig,
} from '@syncular/server';
import { createWorkersFetchHandler } from '@syncular/server-workers';
import { schema } from './syncular.generated';

interface Env {
  DB: D1Database; // wrangler [[d1_databases]] binding = "DB"
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

function syncConfig(env: Env): SyncServerConfig {
  const r2 = {
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: 'auto' as const,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
  const segments = new S3SegmentStore({ ...r2, bucket: 'syncular-segments' });
  const blobs = new S3BlobStore({ ...r2, bucket: 'syncular-blobs' });
  return {
    schema,
    storage: new D1ServerStorage(env.DB),
    segments,
    blobs,
    signedUrls: s3PresignedUrls(segments, { ttlSeconds: 900 }),
    blobSignedUrls: s3PresignedBlobUrls(blobs, { ttlSeconds: 900 }),
    resolveScopes: (args) => resolveScopes(args, env),
  };
}

export default {
  fetch: createWorkersFetchHandler<Env>((env) => ({
    config: syncConfig(env),
    authenticate: (request) => authenticate(request, env),
  })),
};
```

This HTTP-only shape is **fully conformant** — clients that never open the
socket sync over `POST /sync` with identical semantics. It is a smaller
complete deployment, not a degraded one. One platform note: Workers has no
SQLite engine, so there is no `sqliteImageBuilder` — clients that advertise
the sqlite-image bootstrap lane are served the rows lane instead.

## D1 storage

`D1ServerStorage` shares its schema and value codecs with
`SqliteServerStorage` and differs only in execution shape. D1 has no
interactive transaction — the only atomic primitive is `db.batch([...])` —
so the storage executes reads immediately and **buffers** writes, flushing
them as one atomic batch at commit; a rejected op rolls back by never
flushing.

It does not apply DDL on construction (a cold request must never race a
schema apply). Generate the migration SQL from `sqliteDdlStatements()`
(exported from `@syncular/server`) into a `migrations/` file, then:

```sh
wrangler d1 create syncular
wrangler d1 migrations apply syncular
```

**Per-partition write serialization.** The dense per-partition `commitSeq`
is read live and buffered `+1` — exact under one request, but two
concurrent pushes to the *same* partition need a serialization point. The
realtime Durable Object is the natural one (all of a partition's writes
land in its single-threaded DO); an HTTP-only deployment expecting
concurrent same-partition writes should front them with a coordinating
primitive (a DO or a Queue). This mirrors Postgres's per-partition row
lock, achieved by placement rather than a lock D1 does not expose.

## Realtime: the Durable Object

Realtime on Workers rides `SyncularRealtimeHost` — one Durable Object per
partition (`idFromName(partition)`), hosting the same `RealtimeHub` the
Bun/Node path uses. Because a partition's sockets and its commit fan-out
are co-located and single-threaded, a sync round landing over the socket
fans its delta to the partition's other sockets with no LISTEN/NOTIFY —
and the DO doubles as the per-partition write serialization point D1
wants.

The DO is **hibernation-aware**: idle sockets do not pin the DO in memory
or bill wall time. On the first message after a wake, the host rebuilds
the session from a minimal serialized attachment plus the client record in
D1 — the durable truth; nothing in-flight can be hibernated.

Wiring: declare the DO class delegating to `SyncularRealtimeHost`, pass a
`realtime` factory to `createWorkersFetchHandler`, and give the HTTP path
`durableObjectRealtimeNotifier(env.REALTIME)` so a push landing in a plain
isolate wakes the partition's DO — the in-platform LISTEN/NOTIFY analogue
(a wake, not a byte re-broadcast; the wake is fire-and-forget and never
fails the push).

```ts
import {
  createWorkersFetchHandler,
  durableObjectRealtimeNotifier,
  D1ServerStorage,
  SyncularRealtimeHost,
  type RealtimeDOConfig,
} from '@syncular/server-workers';
import { DurableObject } from 'cloudflare:workers';

const realtimeDOConfig = (env: Env): RealtimeDOConfig => ({
  hubConfig: () => ({
    schema,
    resolveScopes: (args) => resolveScopes(args, env),
    segments: makeSegments(env), // the SAME store the HTTP path uses
  }),
});

export class SyncularRealtimeDO extends DurableObject<Env> {
  #host = new SyncularRealtimeHost(this.ctx, this.env.DB, realtimeDOConfig(this.env));
  fetch(request: Request) { return this.#host.fetch(request); }
  webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
    return this.#host.webSocketMessage(ws, msg);
  }
  webSocketClose(ws: WebSocket) { return this.#host.webSocketClose(ws); }
  webSocketError(ws: WebSocket) { return this.#host.webSocketError(ws); }
}

export default {
  fetch: createWorkersFetchHandler<Env>({
    config: (env) => ({
      config: {
        ...syncConfig(env),
        realtime: durableObjectRealtimeNotifier(env.REALTIME),
      },
      authenticate: (request) => authenticate(request, env),
    }),
    realtime: (env) => ({
      namespace: env.REALTIME,
      authenticate: (request) => authenticateRealtime(request, env),
    }),
  }),
};
```

The platform types (`DurableObjectState`, `WebSocket`, `D1Database`) are
declared structurally, so the package takes no `@cloudflare/workers-types`
dependency; your Worker's own types are structurally compatible.

## Wrangler config

The package ships a complete
[`wrangler.toml.example`](https://github.com/syncular/syncular/blob/main/packages/server-workers/wrangler.toml.example);
the load-bearing blocks:

```toml
name = "syncular-sync"
main = "src/worker.ts"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"                # env.DB -> D1ServerStorage
database_name = "syncular"
database_id = "..."

[[durable_objects.bindings]]
name = "REALTIME"
class_name = "SyncularRealtimeDO"

[[migrations]]
tag = "v1"
new_classes = ["SyncularRealtimeDO"]
```

Secrets (`wrangler secret put`): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, plus whatever your `authenticate()` needs. For an
HTTP-only deployment, omit the DO binding and migration blocks and drop the
`realtime` option.

## Blob GC on a schedule

Nothing reclaims blobs automatically — the host schedules the sweep. On
Workers the natural place is a cron trigger: add `[triggers] crons = [...]`
and run `sweepOrphanBlobs` per partition from the `scheduled` handler.

```ts
import { sweepOrphanBlobs, D1ServerStorage } from '@syncular/server';

export default {
  fetch: /* … as above … */,
  async scheduled(_event: unknown, env: Env) {
    const storage = new D1ServerStorage(env.DB);
    const blobs = makeBlobs(env); // the same S3BlobStore config
    for (const partition of await listPartitions(env)) {
      await sweepOrphanBlobs(storage, blobs, partition);
    }
  },
};
```

The grace period is the correctness mechanism, not tuning — the full
runbook is in [Operations](/server-operations/).

## Where to go next

- [Operations](/server-operations/) — events, pruning, blob GC, and what to
  alert on.
- [Storage backends](/server-storage/) — how D1 compares to SQLite and
  Postgres, and the R2 store details.
- [Server setup](/guide-server/) — the Bun/Node reference deployment.
- [Realtime](/concepts-realtime/) — the protocol the Durable Object hosts.
