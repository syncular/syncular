# Storage backends

The server core is written against three storage seams — `ServerStorage`
for the commit log and rows, `SegmentStore` for bootstrap segments, and
`BlobStore` for file-attachment bytes. This page covers every shipped
backend and when to pick which; all backends of a seam pass one shared
contract suite.

## Choosing a database

| Backend | Adapter | Realtime fanout | When to use |
|---|---|---|---|
| SQLite (bun:sqlite) | `SqliteServerStorage` | in-process hub | Development, demos, single-node deployments |
| Postgres | `PostgresServerStorage` + your driver via `PgExecutor` | LISTEN/NOTIFY via `PostgresFanout` | Production on Bun/Node, especially multi-instance |
| Cloudflare D1 | `D1ServerStorage` | in-Durable-Object fanout | Cloudflare Workers — see [Cloudflare Workers](/server-workers/) |

## SQLite (`SqliteServerStorage`)

The dev-speed default: `new SqliteServerStorage('./data.db')` (or
`':memory:'`) over bun:sqlite. The server manages its own internal `sync_*`
tables — your app migrations only feed typegen, they never run here. It is
the storage the [quickstart](/quickstart/) uses and the baseline the load
suite runs against.

## Postgres (`PostgresServerStorage`)

The production database path. It implements the same `ServerStorage`
contract with the inverted scope index carried through as **covering
indexes**, so scope fanout is an index range scan, never a
scan-before-`LIMIT`. A dedicated test asserts via
`EXPLAIN` that the fanout candidate scans stay index-driven, so the
regression cannot silently return. `storage.migrate()` applies the DDL
idempotently — safe to call on every boot.

The server library never imports a Postgres driver. You wire yours through
the minimal `PgExecutor` seam (`query(text, params)` plus a
`transaction(fn)` scope) — Bun.sql or node-postgres both adapt in ~20
lines:

```ts
import {
  PostgresServerStorage,
  type PgExecutor,
  type PgQueryable,
} from '@syncular/server';

function bunSqlExecutor(sql: import('bun').SQL): PgExecutor {
  const over = (h: any): PgQueryable => ({
    async query(text, params) {
      const rows = await h.unsafe(text, params ? [...params] : []);
      return { rows, rowCount: rows.length };
    },
  });
  return {
    query: over(sql).query,
    transaction: (fn) => sql.begin((tx: any) => fn(over(tx))),
    close: () => sql.end(),
  };
}

const storage = new PostgresServerStorage(
  bunSqlExecutor(new Bun.SQL(process.env.DATABASE_URL!)),
);
await storage.migrate();
```

Drivers decode `int8` differently (node-postgres → `string`, Bun.sql →
`bigint`); the storage layer coerces every sequence read through
`Number(...)`, so no type-parser config is needed. Per-partition
`commitSeq` is allocated with an `UPDATE … RETURNING` row lock on the
partition row — dense and gap-free, concurrent pushes to the same
partition serialize, cross-partition pushes never contend. The node-postgres
adapter and the full wiring notes are in the
[server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md).

### Multi-instance fanout (`PostgresFanout`)

Behind a load balancer, a commit applied on instance A reaches A's local
realtime sessions in-memory — but a socket on instance B never sees it.
`PostgresFanout` bridges the gap over LISTEN/NOTIFY: the originating
instance notifies `syncular_commit`, every instance's listen loop wakes its
local hub, and remote sessions re-pull the delta from the shared Postgres
they already read from. Wakes, not byte re-broadcast — NOTIFY payloads are
capped, so only cross-instance delivery pays a re-pull. Single-instance
deployments install no fanout at all.

```ts
import { PostgresFanout, type PgNotificationConnection } from '@syncular/server';

const fanout = new PostgresFanout(conn); // conn: your driver's LISTEN + NOTIFY
await fanout.install(hub);               // start the LISTEN loop
// after a push commit lands:
await fanout.notifyCommit(partition, commitSeq);
```

## Cloudflare D1 (`D1ServerStorage`)

D1 is SQLite over an async, batch-at-a-time API; `D1ServerStorage` shares
the schema and value codecs with `SqliteServerStorage` and differs only in
execution shape. It ships in `@syncular/server` but its home is the Workers
deployment — per-partition write serialization, migration workflow, and the
Durable Object are covered in [Cloudflare Workers](/server-workers/).

## Segment stores

Bootstrap segments are **TTL cache entries** (default 24 h), never durable
state. Three backends pass the shared contract suite:

| Backend | Use |
|---|---|
| `MemorySegmentStore` | Tests, single process |
| `SqliteSegmentStore` | Single node |
| `S3SegmentStore` | Production — any S3-compatible store (AWS S3, Cloudflare R2, MinIO), dependency-free |

`S3SegmentStore` hand-rolls SigV4 over `fetch` (no AWS SDK), uses a
deterministic content-addressed key layout so every lookup is a GET/HEAD —
never a LIST — and for R2 takes
`endpoint: 'https://<account-id>.r2.cloudflarestorage.com'` with
`region: 'auto'`.

For zero-egress bootstrap storms, add signed URLs — native HMAC
(`SignedUrlConfig`, you serve the bytes and verify the token) or delegated
presign (`s3PresignedUrls(store)`, the object store enforces the grant and
the sync server never proxies segment bytes). Both emit identical
descriptors; clients cannot tell them apart. Keep the direct-download
endpoint mounted as the mandatory fallback. A CDN can cache segment objects
by path alone — the key is the content address and clients verify the hash
after download — but must never cache the authorization decision: cache on
the path, keep forwarding the query for origin auth, and align the CDN TTL
with the store `ttlMs`.

## Blob stores

File-attachment bytes get the same backend spread: `MemoryBlobStore`,
`SqliteBlobStore`, and `S3BlobStore` (S3, R2, MinIO — same SigV4, same
content-addressed layout, partition-scoped keys).

The honest interface difference from segments: **blobs are durable, not
TTL**. A blob referenced by a live row must stay downloadable
indefinitely, so `S3BlobStore` has no `ttlMs` and maps to no lifecycle
rule — do **not** put an S3/R2 lifecycle-expiration rule on the `blob/`
prefix; it would delete still-referenced attachments out from under live
rows. Reclamation is reference-driven: the only thing that deletes a blob
is the scheduled `sweepOrphanBlobs` pass, which deletes only blobs no live
row references — see [Operations](/server-operations/).

Two independent presign switches take the server out of the blob byte
path: `blobSignedUrls: s3PresignedBlobUrls(blobs)` issues presigned
download URLs after the row-derived authorization check, and
`blobUploadUrls: s3PresignedBlobUploads(blobs)` mints direct-to-storage
upload grants. Absent config means clients stream through the direct
`PUT /blobs/:blobId` endpoint — a capability choice, not a fallback.

## Where to go next

- [Server setup](/guide-server/) — wire a chosen backend into the minimal
  server.
- [Cloudflare Workers](/server-workers/) — D1, R2, and Durable Object
  realtime end to end.
- [Operations](/server-operations/) — pruning the commit log and sweeping
  orphan blobs.
- [Bootstrap & segments](/concepts-bootstrap/) — why segments are cache
  entries and how reuse absorbs storms.
