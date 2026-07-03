# Server setup

The server is a framework-free protocol library:
`handleSyncRequest(bytes, ctx) → bytes` over host-provided storage,
scope-resolution, and segment/blob-store interfaces. A thin Hono adapter
mounts the routes. `resolveScopes` runs in your process, next to your auth.

The full host surface is the
[server README](../../packages/server/README.md); this guide is the path
through it.

## The minimal server

Everything the [quickstart](/quickstart/) server needs: a schema, storage, a
segment store, and a resolver, wrapped by the Hono adapter.

```ts
import {
  MemorySegmentStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular-v2/server';
import { createSyncularHono } from '@syncular-v2/server-hono';
import { schema } from './syncular.generated';

const config: SyncServerConfig = {
  schema,
  storage: new SqliteServerStorage('./data.db'), // or ':memory:'
  segments: new MemorySegmentStore(),
  resolveScopes: async ({ actorId }) => ({ list_id: await listsFor(actorId) }),
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

The Hono adapter mounts `POST /sync`, `GET /segments/:id`, and `PUT|GET
/blobs/:id`. The realtime WebSocket upgrade is runtime-specific and stays with
your host process — the [demo server](../../apps/demo/src/server.ts) is a
worked example wiring `Bun.serve`'s WebSocket handler to the realtime hub.

## Storage: SQLite now, Postgres for production

`SqliteServerStorage` (bun:sqlite) is the dev-speed default. For production,
`PostgresServerStorage` implements the same contract with the inverted scope
index carried through as covering indexes — so scope fanout is an index range
scan, never a scan-before-`LIMIT` (v1's production wound). The server never
imports a Postgres driver; you wire yours through the `PgExecutor` seam
(Bun.sql or node-postgres). Multi-instance fanout uses LISTEN/NOTIFY.

Full wiring, the type-parser note, `commitSeq` allocation, and the fanout
bridge are in the
[server README → Postgres storage](../../packages/server/README.md#postgres-storage-the-production-database-path).

## Segments and CDN delivery

Three `SegmentStore` backends ship in-tree and pass one shared contract suite:

| Backend | Use |
|---|---|
| `MemorySegmentStore` | tests, single process |
| `SqliteSegmentStore` | single node |
| `S3SegmentStore` | production — any S3-compatible store (AWS S3, Cloudflare R2, MinIO), dependency-free |

For zero-egress bootstrap storms, add signed URLs — native HMAC
(`SignedUrlConfig`) or delegated presign (`s3PresignedUrls(store)`). Both emit
identical descriptors; clients cannot tell them apart. Keep the direct-download
endpoint mounted as the mandatory fallback. The CDN caching rules (cache on the
content-address path, never on the authorization decision) are in the
[server README → S3/R2 + CDN](../../packages/server/README.md#segment-storage-on-s3--r2-s3segmentstore).

## Ops: events and pruning

One optional interface, `SyncularServerEvents`, emits every operator-relevant
signal as a typed, JSON-able event — request/push/pull/segment/realtime/prune/
resolver. It never throws through, costs nothing when unset, and reads the ctx
clock so tests stay deterministic. `consoleJsonEvents()` is a reference sink
(one JSON line per event):

```ts
import { consoleJsonEvents } from '@syncular-v2/server';
const config: SyncServerConfig = { /* … */, events: consoleJsonEvents() };
```

The commit log grows until you prune it. `pruneCommitLog` advances the
per-partition horizon on a schedule you own (hourly to daily). The event
catalog, the retention floors, and what to alert on (rising `sync.forbidden`,
any `scopes.resolve_failed`, reset-rate spikes) are in the
[server README → ops seam](../../packages/server/README.md#structured-events-the-ops-seam)
and
[horizon & pruning](../../packages/server/README.md#horizon--pruning-operational-guidance).
