# Cloudflare Workers

Deploy the sync server on Cloudflare: D1 for storage, R2 for segment and blob bytes, and one Durable Object per partition for push serialization and optional realtime. This page is for backend developers shipping to Workers. You finish with a deployed Worker that answers sync rounds and a cron trigger that runs maintenance.

::meta{for="Backend developers on Cloudflare" time="25 minutes" first="guide-server"}

:::terms
- **D1**: Cloudflare's SQLite database. It has no interactive transaction, only atomic `db.batch([...])`.
- **Coordinator**: The Durable Object that serializes one partition's pushes and hosts its realtime sockets.
- **R2**: Cloudflare's S3-compatible object store, used through `S3SegmentStore` and `S3BlobStore`.
:::

:::figure{title="What the Worker runs" note="One Durable Object per partition" ticks}
<div class="d-row">
<div class="node"><span class="t">Client</span>POST /sync<br>GET /realtime</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">Worker</span>createWorkersFetchHandler<br>authenticate, route</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Durable Object</span>One per partition<br>FIFO for pushes, WebSocket hub</div>
<span class="d-arrow"></span>
<div class="d-stack">
<div class="node ok"><span class="t">D1</span>commit log, rows</div>
<div class="node ok"><span class="t">R2</span>segments, blobs</div>
</div>
</div>

::caption[The Worker forwards each authenticated `POST /sync` to the partition's Durable Object, which serializes pushes and writes D1. The same object hosts that partition's sockets, so a commit reaches them without LISTEN/NOTIFY.]
:::

`@syncular/server-workers` is thin. The server core is runtime-neutral TypeScript (Web `Request`, `Response`, `fetch`, and Web Crypto only, enforced by a static import-graph test), so the Workers lane runs the same HTTP handler as Bun and Node, wired to `env` bindings. The routes match [Server setup](/guide-server/#the-route-surface): `POST /sync`, `GET /segments/:id`, `PUT` and `GET /blobs/:id`, plus `GET /realtime` when you enable the Durable Object.

When PostgreSQL runs behind Hyperdrive instead of D1, disable query caching on the binding that sync storage, authentication, and scope resolution use. A serialized coordinator cannot make a cached SELECT fresh ([Read freshness](/server-storage-reference/#read-freshness)).

## Steps

:::::steps
::::step{title="Write the sync config" time="5 min"}
One factory builds the canonical sync capabilities for HTTP-forwarded rounds and socket rounds. Presigned URLs take segment and blob bytes out of the Worker.

```ts title="src/worker.ts"
import {
  D1ServerStorage,
  S3BlobStore,
  S3SegmentStore,
  s3PresignedBlobUrls,
  s3PresignedUrls,
  type RealtimeHubConfig,
} from '@syncular/server';
import { schema } from './syncular.generated';

interface Env {
  DB: D1Database; // wrangler [[d1_databases]] binding = "DB"
  REALTIME: DurableObjectNamespace<SyncularRealtimeDO>;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

const canonicalSyncConfig = (env: Env, storage: D1ServerStorage) => {
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
    storage,
    segments,
    blobs,
    signedUrls: s3PresignedUrls(segments, { ttlSeconds: 900 }),
    blobSignedUrls: s3PresignedBlobUrls(blobs, { ttlSeconds: 900 }),
    resolveScopes: (args) => resolveScopes(args, env),
  } satisfies RealtimeHubConfig;
};
```

Workers has no SQLite engine, so the config sets no `sqliteImageBuilder`. A client that advertises the image lane receives a stored image when one exists for its scope and rows otherwise. Store images for large tables from a Bun process with `publishSqliteImage` ([Bootstrap & segments](/concepts-bootstrap/#publishing-images-from-another-host)). `GET /segments/:id` streams them out of an `S3SegmentStore` without buffering them in the isolate.

::checkpoint[`canonicalSyncConfig` typechecks against `RealtimeHubConfig`.]
::::

::::step{title="Schema migration" time="5 min"}
Call `D1ServerStorage.migrateSchema(compileSchema(schema))` from an authenticated maintenance handler before the Worker admits sync traffic. It creates the core tables, applies application DDL, and rewrites stored rows. Each call saves its progress and returns `{ complete, statementsExecuted }`.

```ts title="src/maintenance.ts"
import { compileSchema, D1ServerStorage } from '@syncular/server';
import { schema } from './syncular.generated';

// Inside your authenticated maintenance handler:
const storage = new D1ServerStorage(env.DB);
const result = await storage.migrateSchema(compileSchema(schema), {
  maxStatements: 40,
});
return Response.json(result, { status: result.complete ? 200 : 202 });
```

Send another request after a `202` response. Run one migration call per Worker invocation, because a loop or `waitUntil` in the same invocation shares its query limit. `maxStatements` defaults to 50 and accepts integers from 10 through 1000. It counts the statements this call issues, including progress tracking, so leave room for other D1 queries in the invocation. Cloudflare allows 50 queries on Free and 1000 on Paid ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). A row batch rewrites at most 32 rows. Each DDL statement must still finish within D1's time limit; this budget cannot split an index build.

Retry the same schema after an interrupted request. The storage commits each batch and its progress together, and competing requests cannot apply the same batch twice. An unfinished migration rejects a different target schema with `sync.storage.schema_migration_conflict`, so keep the target schema available until the migration completes.

While a migration is pending, the storage rejects application row reads and transaction commits. A storage instance on an older schema stays unusable after completion. Each protected read or commit adds one guard statement to its D1 batch. Drain Workers that run Syncular versions without these checks before starting the first upgrade with this API. Direct SQL access must observe the same maintenance window.

`ensureSchema` runs one step with the default budget and throws `sync.storage.schema_migration_pending` if more work remains. `ensureSyncServerReady` wraps that as `sync.schema_not_ready` with the original error in `cause`. Finish the maintenance requests before the readiness helper admits traffic.

`migrateSchema` also creates `sync_reactions` before it completes. Planned reactions join the source commit's atomic batch, and `ReactionRunner` claims work with one atomic write statement. Drive it from a scheduled Worker event or a Durable Object alarm. D1 statement and invocation limits apply to the source batch and delivery passes ([Durable server reactions](/server-reactions/#storage-and-migrations)).

::checkpoint[The maintenance handler answers `200` with `complete: true`.]
::::

::::step{title="Add the Durable Object" time="8 min"}
D1 writes are not stateless. Every push must serialize before row reads, validation, and CRDT merge, and must re-check idempotency under that boundary. The Workers adapter forwards `/sync` to one Durable Object per partition, and the object runs an explicit FIFO, because Durable Object events can interleave at `await`. Different partitions use different objects and stay concurrent.

A plain `new D1ServerStorage(env.DB)` fails closed before every push, whether or not a `commitValidator` is present. A custom coordinator may pass `{ pushApplySerialized: true }`; a stateless Worker must not.

Declare a class that delegates to `SyncularRealtimeHost`, and pass a `realtime` factory to `createWorkersFetchHandler`. Its namespace coordinates HTTP `/sync` and also handles WebSocket upgrades.

```ts title="src/worker.ts"
import {
  createWorkersFetchHandler,
  D1ServerStorage,
  SyncularRealtimeHost,
  type RealtimeDOConfig,
} from '@syncular/server-workers';
import { DurableObject } from 'cloudflare:workers';

const realtimeDOConfig = (env: Env): RealtimeDOConfig => ({
  syncConfig: (storage) => canonicalSyncConfig(env, storage),
});

export class SyncularRealtimeDO extends DurableObject<Env> {
  #host = new SyncularRealtimeHost(this.ctx, this.env.DB, realtimeDOConfig(this.env));
  fetch(request: Request) { return this.#host.fetch(request); }
  pruneCommitLog(partition: string, nowMs: number) {
    return this.#host.pruneCommitLog({ partition, nowMs });
  }
  webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
    return this.#host.webSocketMessage(ws, msg);
  }
  webSocketClose(ws: WebSocket) { return this.#host.webSocketClose(ws); }
  webSocketError(ws: WebSocket) { return this.#host.webSocketError(ws); }
}

const handler = createWorkersFetchHandler<Env>({
  config: (env) => ({
    config: canonicalSyncConfig(env, new D1ServerStorage(env.DB)),
    authenticate: (request) => authenticate(request, env),
  }),
  realtime: (env) => ({
    namespace: env.REALTIME,
    authenticate: (request) => authenticateRealtime(request, env),
  }),
});
```

`createWorkersFetchHandler(factory)` builds the Hono app per request from your factory. That keeps it stateless, which Workers requires because each invocation may run on a fresh isolate.

The Durable Object is hibernation-aware. Idle sockets do not pin it in memory or bill wall time. On the first message after a wake, the host rebuilds the session from a minimal serialized attachment plus the client record in D1, the durable source of truth. Nothing in flight can hibernate. Because a partition's sockets, sync FIFO, and commit fan-out sit in one object, a round that lands over the socket fans its delta out to the partition's other sockets directly. The protocol it hosts is on [Realtime & the WebSocket-native loop](/concepts-realtime/).

For an HTTP-only deployment, keep the Durable Object binding and migration, and pass `coordinator: (env) => ({ namespace: env.REALTIME })` in place of `realtime`. Only the WebSocket route goes away; the FIFO stays mandatory for D1 pushes.

The package declares the platform types (`DurableObjectState`, `WebSocket`, `D1Database`) structurally, so it takes no `@cloudflare/workers-types` dependency. Your Worker's own types are structurally compatible.

::checkpoint[`wrangler dev` answers `POST /sync` through the Durable Object, and a WebSocket client connects to `/realtime`.]
::::

::::step{title="Configure wrangler" time="3 min"}
The package ships a complete [`wrangler.toml.example`](https://github.com/syncular/syncular/blob/main/packages/server-workers/wrangler.toml.example). These are the blocks that matter:

```toml title="wrangler.toml"
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

Set the secrets with `wrangler secret put`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, plus whatever `authenticate()` needs.

::checkpoint[`wrangler deploy` completes and lists the `SyncularRealtimeDO` class.]
::::

::::step{title="Schedule maintenance" time="4 min"}
The host schedules reaction retention, commit-log pruning, and blob cleanup. On Workers, add `[triggers] crons = [...]` and run the maintenance helpers per partition from the `scheduled` handler. Commit-log pruning calls the Durable Object method from step 3, which shares the HTTP and socket write queue. Type `REALTIME` as `DurableObjectNamespace<SyncularRealtimeDO>` so the RPC method exists on its stub. Direct uncoordinated D1 pruning fails.

```ts title="src/worker.ts"
import {
  D1ServerStorage,
  pruneReactions,
  sweepOrphanBlobs,
} from '@syncular/server';

export default {
  fetch: handler,
  async scheduled(_event: unknown, env: Env) {
    const storage = new D1ServerStorage(env.DB);
    await storage.migrate();
    const { blobs } = canonicalSyncConfig(env, storage);
    for (const { partition } of await storage.listPartitionRegistry()) {
      await env.REALTIME.getByName(partition).pruneCommitLog(partition, Date.now());

      let result;
      do {
        result = await pruneReactions({
          storage,
          partition,
          nowMs: Date.now(),
        });
      } while (result.mayHaveMore);

      await sweepOrphanBlobs(storage, blobs, partition);
    }
  },
};
```

Retention windows, eligibility rules, and what to alert on are in [Operations and maintenance](/server-operations/).

::checkpoint[A cron run logs `prune.completed` for each partition.]
::::
:::::

## Advanced: D1 storage

`D1ServerStorage` uses the same schema and value codecs as `SqliteServerStorage` and differs in execution shape. D1 has no interactive transaction, and its only atomic primitive is `db.batch([...])`. The storage executes reads immediately and **buffers** writes, then flushes them as one atomic batch at commit. A rejected operation rolls back by never flushing. The concurrent page reads of a pull leave as one `db.batch` round trip. Backend comparison is on [Storage reference](/server-storage-reference/#cloudflare-d1).

### Routine write cost

D1 bills `rows_written` per statement, and that count includes the index entries a write touches as well as the table rows ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)).

Two writes dominate a caught-up client that polls on a fixed interval, and each refreshes a different timestamp:

- The partition registry refreshes `last_authenticated_at_ms`, the partition's activity time. Hosts can use it to exclude long-inactive partitions from maintenance.
- The client record refreshes `updated_at_ms`, the per-client liveness time that the active-client retention floor reads. Both timestamps keep their existing refresh cadence.

The client record updates in place instead of deleting and reinserting, so an established round writes one client row. The actor comes from the authenticated context, the wire version and subscription list from the request, the cursor from the read, and `updated_at_ms` from the server clock.

A push that changes no value still applies: the server increments `server_version`, records the change, and stores the new payload. A row update whose scope map is unchanged leaves the scope-index entries in place. The replacement deletes only keys the new map drops, and the insert ignores keys already present.

Rows written on one two-column `tasks` table with one scope and no declared secondary index, driven through the real `handleSyncRequest` over a Miniflare D1 database and read from `meta.rows_written`:

| Path | Rows written |
|---|---|
| Established idle round | 2 |
| First write, warm client | 19 |
| Same-value commit | 14 |

The numbers are a regression baseline for that schema and not a billing estimate.
