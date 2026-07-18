# Storage backends

The server core is written against three storage interfaces: `ServerStorage`
for the commit log and rows, `SegmentStore` for bootstrap segments, and
`BlobStore` for file-attachment bytes. Below is every shipped backend and
when to pick which; all backends sharing an interface pass one shared
contract suite.

## Choosing a database

| Backend | Adapter | Realtime fanout | When to use |
|---|---|---|---|
| SQLite (bun:sqlite) | `SqliteServerStorage` | in-process hub | Development, demos, single-node deployments |
| Postgres | `PostgresServerStorage` + your driver via `PgExecutor` | LISTEN/NOTIFY via `PostgresFanout` | Production on Bun/Node, especially multi-instance |
| Cloudflare D1 | `D1ServerStorage` | in-Durable-Object fanout | Cloudflare Workers, see [Cloudflare Workers](/server-workers/) |

## Materialized app tables

Every synced table is stored as a real table in the server database, on all
three backends. Each one carries your app's typed columns plus the sync
meta columns:

```sql
CREATE TABLE tasks(
  _sync_partition       TEXT NOT NULL,
  id                    TEXT NOT NULL,
  project_id            TEXT,
  title                 TEXT,
  done                  INTEGER,
  _sync_server_version  INTEGER NOT NULL,
  _sync_scopes          TEXT NOT NULL,      -- JSONB on Postgres
  _sync_payload         BLOB NOT NULL,
  PRIMARY KEY (_sync_partition, id)
);
```

The typed columns are a queryable projection: you can run live SQL, joins,
and analytics against synced data right in your server database, and
indexes declared in your migrations are created here as well. The sync
serve path (pull, bootstrap, segments) reads `_sync_payload`, the verbatim
wire bytes, so server-side querying and the protocol stay decoupled.
The low-level `storage.ensureSchema` method accepts a compiled schema. App
hosts should instead call `ensureSyncServerReady(config)` with the generated
schema before binding a port; it compiles the schema and creates or migrates
these tables. Request-time checks remain a defensive fallback.

A per-table `materialize` flag on the server schema controls the
projection:

- **Default `true`.** Tables whose every non-key, non-scope column is
  end-to-end encrypted default to `false`, since their projection would be
  columns of ciphertext. An explicit value always wins.
- **`materialize: false`** writes only the meta columns on push (skipping
  the row decode) and skips user indexes. Use it for very wide tables on
  D1, where the 100-bind-parameter cap holds a materialized row to roughly
  95 app columns.
- **Changing the flag requires a schema-version bump.** Turning it on
  backfills the typed columns from stored payloads; turning it off stops
  writing them, and the stale columns remain until you drop them manually.

The storage layout, scope index, and serve path are identical in both
modes; the flag only decides whether the typed projection is populated.

## Choosing the right row lookup

Syncular has four deliberately different lookup shapes. Do not turn a server
search need into a client scope unless clients genuinely need to subscribe by
that dimension.

| Need | API / pattern | Authorization meaning |
|---|---|---|
| One known row | `getRow(table, rowId)` | Trusted partition-local primary-key read |
| Rows in a client delivery scope | `scanRows({ scopeFilter, ... })` | Syncular scope-index scan; at least one variable is mandatory |
| Exact authoritative lookup by app columns | `scanRowsByIndex({ index, values, ... })` | Trusted server-host relational-index scan; never a client scope |
| Ordered/range work queue or derived topology | Atomically maintained reverse-index/queue rows | Explicit application projection with its own completeness invariant |

An empty or omitted `scopeFilter` is never an “all rows” request. All shipped
adapters throw `StorageQueryError` with
`code: 'sync.storage.scan_requires_scope'`; an empty result therefore cannot
hide an unsupported administrative scan. A relational index also does not
make its columns available to `scanRows`—scope indexes and SQL indexes solve
different problems.

### Trusted alternate lookup

Suppose encryption-key grants sync only to their exact user, but disconnecting
a Workspace must revoke every grant in that Workspace. Keep the client scope
small and declare an ordinary relational index for the authoritative lookup:

```ts
const schema: ServerSchema = {
  version: 12,
  tables: [{
    name: 'device_encryption_key_grants',
    columns: [
      { name: 'id', type: 'string', nullable: false },
      { name: 'user_id', type: 'string', nullable: false },
      { name: 'workspace_id', type: 'string', nullable: false },
      { name: 'wrapped_key', type: 'bytes', nullable: false },
    ],
    primaryKey: 'id',
    scopes: ['user:{user_id}'],
    indexes: [{
      name: 'device_key_grants_by_workspace',
      columns: ['workspace_id'],
    }],
  }],
};
```

The index does not enter `declaredVariables`, named-query scope coverage, a
subscription descriptor, or `resolveScopes`. A client can request only
`user_id`; knowing the Workspace ID or index name grants nothing. Trusted host
code can use the exact index inside the same authoritative transaction:

```ts
const tx = await storage.begin(partition);
if (tx.scanRowsByIndex === undefined) {
  throw new Error('storage adapter lacks trusted relational-index scans');
}

let afterRowId: string | null = null;
for (;;) {
  const page = await tx.scanRowsByIndex({
    table: 'device_encryption_key_grants',
    index: 'device_key_grants_by_workspace',
    values: [workspaceId], // one exact value per declared index column
    afterRowId,
    limit: 250,            // required integer, 1..1,000
  });
  for (const grant of page) {
    await tx.deleteRow('device_encryption_key_grants', grant.rowId);
  }
  if (page.length < 250) break;
  afterRowId = page.at(-1)?.rowId ?? null;
}
await tx.commit();
```

SQLite, PostgreSQL, and D1 implement ordered keyset pagination and
transaction-local read-your-own-writes. The table must be materialized, the
named index must exist, and every index column receives one exact value.
Failures use privacy-safe `StorageQueryError.code` values. The API exists only
on `@syncular/server` storage capabilities and is not reachable through SSP2;
never wrap it in a route that accepts table, index, or value choices from an
untrusted client. Custom storage adapters may omit this additive capability
and should fail the command closed, as above.

This is also the right shape for a provider webhook: declare, for example,
`facilities_by_workos_organization` over `workos_organization_id`, resolve the
exact Facility, then use another declared index or known primary key to find
its private Workspace. The external tenant identifier never becomes an actor
scope.

### When a reverse-index row is still correct

`scanRowsByIndex` is intentionally exact; it is not an arbitrary SQL or range
query escape hatch. A time-ordered expiry worker, a custom adapter without the
capability, or a derived relationship that is not a column on the target row
still needs an application projection. Model a small reverse-index/queue table
whose row ID begins with the lookup or sortable timestamp, give it a dedicated
server scope that `resolveScopes` never grants to application actors, and
create/delete that projection in the same authoritative transaction as the
domain change. Validate the projection's target row and rebuild it with an
idempotent repair job. Tests must prove both completeness (every live target
has the expected index row) and isolation (an application actor cannot
subscribe even when it knows IDs).

This differs from correlated scopes: multiple scope variables are independent
authorization dimensions, not alternate indexes or paired tuples. Use a
parent-and-child scope only when both values are real client delivery fences;
use the trusted relational lookup for an exact server command; use a reverse
projection when the lookup is derived, ordered, or ranged.

## SQLite (`SqliteServerStorage`)

`new SqliteServerStorage('./data.db')` (or `':memory:'`) over bun:sqlite is
the dev-speed default. The server manages all of its own tables (the
`sync_*` internals plus the materialized app tables above): your app
migrations feed typegen, and the server derives its DDL from the compiled
schema. It is
the storage the [quickstart](/quickstart/) uses and the baseline the load
suite runs against.

## Postgres (`PostgresServerStorage`)

The production database path. It implements the same `ServerStorage`
contract with the inverted scope index carried through as **covering
indexes**, so scope fanout always runs as an index range scan. A dedicated
test asserts via
`EXPLAIN` that the fanout candidate scans stay index-driven, so the
regression cannot silently return. `storage.migrate()` applies the DDL
idempotently: safe to call on every boot.

The server library never imports a Postgres driver. You wire yours through
the minimal `PgExecutor` interface (`query(text, params)` plus a
`transaction(fn)` scope). Bun.sql or node-postgres both adapt in ~20
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
partition row: dense and gap-free, concurrent pushes to the same
partition serialize, cross-partition pushes never contend. The node-postgres
adapter and the full wiring notes are in the
[server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md).

### Multi-instance fanout (`PostgresFanout`)

Behind a load balancer, a commit applied on instance A reaches A's local
realtime sessions in-memory. A socket connected to instance B does not see
it without help. `PostgresFanout` bridges the gap over LISTEN/NOTIFY: the
originating instance notifies `syncular_commit`, every instance's listen
loop wakes its local hub, and remote sessions re-pull the delta from the
shared Postgres they already read from. The NOTIFY payload only wakes
listeners and stays small and capped, so only cross-instance delivery pays
for a re-pull. Single-instance deployments install no fanout at all.

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
deployment: per-partition write serialization, migration workflow, and the
Durable Object are covered in [Cloudflare Workers](/server-workers/).

## Segment stores

Bootstrap segments are **TTL cache entries** with a default 24 h lifetime;
they hold no durable state. Three backends pass the shared contract suite:

| Backend | Use |
|---|---|
| `MemorySegmentStore` | Tests, single process |
| `SqliteSegmentStore` | Single node |
| `S3SegmentStore` | Production, any S3-compatible store (AWS S3, Cloudflare R2, MinIO), dependency-free |

`S3SegmentStore` hand-rolls SigV4 over `fetch` (no AWS SDK) and uses a
deterministic content-addressed key layout, so every lookup is a direct
GET/HEAD by key rather than a LIST call. For R2 it takes
`endpoint: 'https://<account-id>.r2.cloudflarestorage.com'` with
`region: 'auto'`.

For zero-egress bootstrap storms, add signed URLs: native HMAC
(`SignedUrlConfig`, you serve the bytes and verify the token) or delegated
presign (`s3PresignedUrls(store)`, the object store enforces the grant and
the sync server never proxies segment bytes). Both emit identical
descriptors; clients cannot tell them apart. Keep the direct-download
endpoint mounted as the mandatory fallback. A CDN can cache segment objects
by path alone, since the key is the content address and clients verify the
hash after download, but it must never cache the authorization decision:
cache on the path, keep forwarding the query for origin auth, and align the
CDN TTL with the store `ttlMs`.

## Blob stores

File-attachment bytes get the same backend spread: `MemoryBlobStore`,
`SqliteBlobStore`, and `S3BlobStore` (S3, R2, MinIO, same SigV4, same
content-addressed layout, partition-scoped keys).

Blobs differ from segments in one key way: they are durable, with no
expiration. A blob referenced by a live row must stay downloadable
indefinitely, so `S3BlobStore` has no `ttlMs` and maps to no lifecycle
rule. Do **not** put an S3/R2 lifecycle-expiration rule on the `blob/`
prefix; it would delete still-referenced attachments out from under live
rows. Reclamation is reference-driven: the only thing that deletes a blob
is the scheduled `sweepOrphanBlobs` pass, which deletes only blobs no live
row references. See [Operations](/server-operations/).

Two independent presign switches take the server out of the blob byte
path: `blobSignedUrls: s3PresignedBlobUrls(blobs)` issues presigned
download URLs after the row-derived authorization check, and
`blobUploadUrls: s3PresignedBlobUploads(blobs)` mints direct-to-storage
upload grants. Absent config means clients stream through the direct
`PUT /blobs/:blobId` endpoint, a fully supported path in its own right.

## Where to go next

- [Server setup](/guide-server/): wire a chosen backend into the minimal
  server.
- [Cloudflare Workers](/server-workers/): D1, R2, and Durable Object
  realtime end to end.
- [Operations](/server-operations/): pruning the commit log and sweeping
  orphan blobs.
- [Bootstrap & segments](/concepts-bootstrap/): why segments are cache
  entries and how reuse absorbs storms.
