# Cloudflare Workers

`@syncular/server-workers` runs the sync server on Cloudflare's edge: D1
for storage, R2 for segment and blob bytes, and one Durable Object per
partition for push serialization and optional realtime. This page takes you
from a bare Worker to a full deployment with WebSockets and scheduled blob GC.

The package is deliberately thin: the server core is runtime-neutral
TypeScript (Web `Request`/`Response`/`fetch`/Web-Crypto only, enforced by a
static import-graph test), so the Workers lane runs the same HTTP handler,
wired to `env` bindings.

## The fetch handler

`createWorkersFetchHandler(factory)` builds the Hono app per request from
your factory. This keeps it stateless, the correct posture on Workers
since each invocation may run on a fresh isolate. It mounts the same routes as the
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
  SYNC_COORDINATOR: DurableObjectNamespace<SyncularRealtimeDO>;
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
  fetch: createWorkersFetchHandler<Env>({
    config: (env) => ({
      config: syncConfig(env),
      authenticate: (request) => authenticate(request, env),
    }),
    coordinator: (env) => ({ namespace: env.SYNC_COORDINATOR }),
  }),
};
```

HTTP-only transport remains fully conformant, but D1 writes are not stateless:
the `coordinator` forwards authenticated `/sync` rounds through the partition
DO. WebSocket upgrades are optional; the DO binding and FIFO are mandatory for
D1 pushes. Workers has no SQLite engine, so there is no `sqliteImageBuilder`;
clients advertising that lane receive rows instead.

## D1 storage

`D1ServerStorage` uses the same schema and value codecs as
`SqliteServerStorage`; only the execution shape changes. D1 has no
interactive transaction: the only atomic primitive is `db.batch([...])`,
so the storage executes reads immediately and **buffers** writes, flushing
them as one atomic batch at commit. A rejected op rolls back by never
flushing.

It does not apply DDL on construction (a cold request must never race a
schema apply). Generate the migration SQL from `sqliteDdlStatements()`
(exported from `@syncular/server`) into a `migrations/` file, then:

```sh
wrangler d1 create syncular
wrangler d1 migrations apply syncular
```

**Per-partition write serialization.** Every push must serialize before row
reads/validation/CRDT merge and re-check idempotency under that boundary. The
Workers adapter forwards `/sync` to one DO per partition and the DO uses an
explicit FIFO; Durable Object events may otherwise interleave at `await`.

A plain `new D1ServerStorage(env.DB)` fails closed before every push, not only
when `commitValidator` is present. A custom coordinator may pass
`{ pushApplySerialized: true }`; a stateless Worker must not. Different
partitions still use different DOs and remain concurrent.

## Realtime: the Durable Object

Realtime on Workers runs through `SyncularRealtimeHost`: one Durable Object
per partition (`idFromName(partition)`), hosting the same `RealtimeHub` the
Bun/Node path uses. Because a partition's sockets, explicit sync FIFO, and
commit fan-out are co-located, a sync round landing over the socket
fans its delta to the partition's other sockets with no LISTEN/NOTIFY
needed, and the DO doubles as the per-partition write serialization point
D1 wants.

The DO is **hibernation-aware**: idle sockets do not pin the DO in memory
or bill wall time. On the first message after a wake, the host rebuilds
the session from a minimal serialized attachment plus the client record in
D1, the durable source of truth; nothing in-flight can be hibernated.

Wiring: declare the DO class delegating to `SyncularRealtimeHost`, reuse one
canonical sync-config factory for HTTP-forwarded and socket rounds, and pass a
`realtime` factory to `createWorkersFetchHandler`. Its namespace coordinates
HTTP `/sync` and also handles WebSocket upgrades.

```ts
import {
  createWorkersFetchHandler,
  D1ServerStorage,
  SyncularRealtimeHost,
  type RealtimeDOConfig,
} from '@syncular/server-workers';
import { DurableObject } from 'cloudflare:workers';
import type { RealtimeHubConfig } from '@syncular/server';

const canonicalSyncConfig = (
  env: Env,
  storage: D1ServerStorage,
) => ({
    schema,
    storage,
    resolveScopes: (args) => resolveScopes(args, env),
    segments: makeSegments(env),
    blobs: makeBlobs(env),
    crdtMergers: makeCrdtMergers(env),
  } satisfies RealtimeHubConfig);

const realtimeDOConfig = (env: Env): RealtimeDOConfig => ({
  syncConfig: (storage) => canonicalSyncConfig(env, storage),
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
      config: canonicalSyncConfig(env, new D1ServerStorage(env.DB)),
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
[`wrangler.toml.example`](https://github.com/syncular/syncular/blob/main/packages/server-workers/wrangler.toml.example).
Here are the blocks that matter:

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
HTTP-only deployment, keep the DO binding/migration and use `coordinator`
instead of `realtime`; only the WebSocket route is omitted.

## Blob GC on a schedule

Nothing reclaims blobs automatically. The host schedules the sweep. On
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

Getting the grace period right is what keeps this sweep safe. The full
runbook is in [Operations](/server-operations/).

## Where to go next

- [Operations](/server-operations/): events, pruning, blob GC, and what to
  alert on.
- [Storage backends](/server-storage/): how D1 compares to SQLite and
  Postgres, and the R2 store details.
- [Server setup](/guide-server/): the Bun/Node reference deployment.
- [Realtime](/concepts-realtime/): the protocol the Durable Object hosts.
