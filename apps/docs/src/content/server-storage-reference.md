# Storage reference

Look up how each shipped storage backend behaves: the materialized tables, row lookups, SQLite, Postgres, D1, the segment and blob stores, and the contract a custom adapter implements. This page is for backend developers who already chose a backend on [Choosing a database](/server-storage/).

::meta{for="Backend developers" first="server-storage"}

:::terms
- **Materialized table**: A synced table stored with typed columns beside the `_sync_*` columns.
- **Writer fence**: A per-partition schema version that rejects commits from processes running an older schema.
- **Log epoch**: A per-partition identifier that a restore rotates ([Backup and restore](/server-operations/#backup-and-restore)).
:::

## Materialized app tables

Every backend stores each synced table as a real table. It carries your typed columns plus the sync meta columns:

```sql
CREATE TABLE todos(
  _sync_partition       TEXT NOT NULL,
  _sync_row_id          TEXT NOT NULL,
  id                    TEXT NOT NULL,
  list_id               TEXT,
  title                 TEXT,
  done                  INTEGER,
  _sync_server_version  INTEGER NOT NULL,   -- BIGINT on Postgres
  _sync_scopes          TEXT NOT NULL,      -- JSONB on Postgres
  _sync_payload         BLOB NOT NULL,      -- BYTEA on Postgres
  _sync_column_versions BLOB,               -- BYTEA on Postgres
  PRIMARY KEY (_sync_partition, _sync_row_id)
);
```

The typed columns are a queryable projection: run live SQL, joins, and analytics against synced data in your server database, and the indexes declared in your migrations are created here too. The sync serve path (pull, bootstrap, segments) reads `_sync_payload`, the verbatim wire bytes, so server-side querying and the protocol stay decoupled.

`ensureSyncServerReady(config)` creates and migrates these tables before the server binds a port ([Server setup](/guide-server/)). The low-level `storage.ensureSchema` accepts a compiled schema directly.

### Layout check

When the stored schema version equals the running one, `ensureSchema` still checks the database before serving, on all three backends. It compares the stored column layouts with the configured schema, then reads each synced table from the catalog (`PRAGMA table_info` on SQLite and D1, `pg_attribute` on Postgres). A missing table or column, a `_sync_*` column whose type or nullability differs from the declaration above, or a primary key other than `(_sync_partition, _sync_row_id)` fails the open with `StorageQueryError`:

| Code | Cause | `details` |
|---|---|---|
| `sync.storage.stored_layout_mismatch` | Stored layouts differ from the configured schema | `table`, `column` |
| `sync.storage.physical_layout_mismatch` | A synced table differs from the storage layout | `table`, `column`, `reason`, and `expected`/`actual` for a type or nullability mismatch |

`reason` is one of `missing_table`, `missing_column`, `type`, `nullability`, or `primary_key`. Neither refusal writes DDL. A table from before `_sync_column_versions` existed gains the column only through a schema-version bump ([version-only bumps](/guide-schema/#a-version-only-bump-server-internal-storage-changes)).

D1 also refuses a missing core table that its request path reads or writes (`sync_tombstones`, `sync_commits`, `sync_clients`, and the rest of the `sync_*` tables except `sync_backfill_checkpoints` and `sync_writer_fence`), because D1 creates those tables only in `migrate()` or during a schema upgrade. On D1 the check costs one `sqlite_master` read plus one `PRAGMA table_info` statement per synced table the first time a storage instance opens.

### The `materialize` flag

A per-table `materialize` flag on the server schema controls the projection:

- **Default `true`.** Tables whose every non-key, non-scope column is end-to-end encrypted default to `false`, since their projection would be columns of ciphertext. An explicit value always wins.
- **`materialize: false`** writes only the meta columns on push, skipping the row decode, and skips user indexes. Use it for very wide tables on D1, where the 100-bind-parameter cap holds a materialized row to roughly 95 app columns.
- **Changing the flag requires a schema-version bump.** Turning it on backfills the typed columns from stored payloads. Turning it off stops writing them, and the stale columns remain until you drop them manually.

The storage layout, scope index, and serve path are identical in both modes. The flag decides only whether the typed projection is populated.

## Read freshness

Commit maxima, scope indexes, commit windows, row reads, and authorization reads must see committed writes immediately. They cannot use a stale query cache or a lagging replica. If a push accepts sequence N but the pull maximum is below N, the server returns `sync.storage_stale_read`. The push stays committed; repair the storage configuration before retrying its original idempotency key.

With Cloudflare Hyperdrive, pass a cache-disabled binding to `PostgresServerStorage` and to authentication and scope resolution. Hyperdrive enables query caching by default, and writes do not invalidate cached SELECT results. The default cache can serve an older result for 60 seconds plus a 15-second revalidation window ([Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)). Durable Object serialization does not change that cache contract.

## SQLite

`SqliteServerStorage` comes from `@syncular/server/sqlite`. Pass `'./data.db'` or `':memory:'`. The export selects `bun:sqlite` on Bun and built-in `node:sqlite` on Node 22.13 or newer. The server manages all of its own tables, the `sync_*` internals plus the materialized app tables: your app migrations feed typegen, and the server derives its DDL from the compiled schema.

SQLite and D1 row replacement and deletion remove the old row's exact scope entries through the existing scope primary key. The backend reads the old scope map before changing the row and keeps the deletion and row change in one transaction (one atomic batch on D1). The Postgres implementation keeps its row-ID predicate.

## Postgres

`PostgresServerStorage` implements the `ServerStorage` contract with the inverted scope index carried as **covering indexes**, so scope fanout runs as an index range scan. A server test asserts through `EXPLAIN` that the fanout candidate scans stay index-driven. `storage.migrate()` applies the DDL idempotently, so calling it on every boot is safe.

### Driver wiring

The server library never imports a Postgres driver. You wire yours through the minimal `PgExecutor` interface: `query(text, params)` plus a `transaction(fn)` scope. Bun.sql and node-postgres each adapt in about 20 lines:

```ts title="src/storage.ts"
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

Drivers decode `int8` differently (node-postgres returns `string`, Bun.sql returns `bigint`). The storage layer coerces every sequence read through `Number(...)`, so no type-parser configuration is needed. The node-postgres adapter and the full wiring notes are in the [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md).

### Push path

Per-partition `commitSeq` comes from an `UPDATE … RETURNING` row lock on the partition row. Sequences are dense and gap-free, concurrent pushes to one partition serialize, and pushes to different partitions never contend.

- **Locking.** A push locks an existing partition with `SELECT ... FOR UPDATE`. A new partition requires initialization and a second lock query to serialize concurrent first writers. Existing partitions skip the initialization statement. Each push keeps its own transaction and rejection savepoint, and a rollback does not consume a commit sequence.
- **Commit metadata.** Sequence allocation and commit metadata insertion share one SQL statement. The allocation feeds the commit insert through its returned sequence. Change rows and their scope entries stay in the same commit transaction.
- **Change rows.** One statement appends all of a commit's changes and fills their inverted scope entries and delete tombstones. It expands each inserted scope object and deduplicates entries that changes in the same commit share. Empty-scope changes still enter the log. Serialized scopes bind as text before JSONB parsing so driver JSON encoding cannot turn them into a JSON string. Existing change rows with string-form scopes stay readable.
- **Row writes.** Before a commit applies its operations, the push reads every row they target and its delete tombstone with one statement per table. Each operation reads that snapshot until it or an earlier operation in the commit writes the row. A row write is one statement: the upsert plus the row's scope-index entries. A commit that inserts rows into two tables costs 10 statements plus one per row, whatever the number of scope variables per row.

### Pull path

An HTTP `POST /sync` request and a realtime socket round run the same handler. A pull starts the commit-window read or first snapshot page of every subscription before it awaits any of them, then re-reads the pruning horizon once. `PostgresServerStorage` queues the page reads issued in one microtask turn and sends one `LATERAL` statement per table, where each subscription keeps its own scope filter, cursor, and limit. The statement count therefore grows with the tables a pull reads. In the server test suite, a 68-subscription pull over two tables issues 10 statements to bootstrap and 11 to catch up, the same counts as an 8-subscription pull. The serve gate reads the schema marker, the log epoch, and incomplete checkpoints in one statement. A custom `ServerStorage` receives these `readCommitWindow` and `scanRows` calls concurrently and may batch them the same way.

### Multi-instance fanout

Behind a load balancer, a commit applied on instance A reaches A's local realtime sessions in memory. A socket connected to instance B needs a bridge. `PostgresFanout` bridges over LISTEN/NOTIFY: the originating instance notifies `syncular_commit`, every instance's listen loop wakes its local hub, and remote sessions re-pull the delta from the shared Postgres they already read from. The NOTIFY payload only wakes listeners and stays small and capped, so only cross-instance delivery pays for a re-pull. Single-instance deployments install no fanout.

```ts title="src/storage.ts"
import { PostgresFanout, type PgNotificationConnection } from '@syncular/server';

const fanout = new PostgresFanout(conn); // conn: your driver's LISTEN + NOTIFY
await fanout.install(hub);               // start the LISTEN loop
// after a push commit lands:
await fanout.notifyCommit(partition, commitSeq);
```

## Cloudflare D1

D1 is SQLite behind an async, batch-at-a-time API. `D1ServerStorage` shares the schema and value codecs with `SqliteServerStorage` and differs only in execution shape: the concurrent page reads of a pull leave as one `db.batch` round trip. It ships in `@syncular/server`. Per-partition write serialization, the migration workflow, and the Durable Object are on [Cloudflare Workers](/server-workers/#advanced-d1-storage).

## Segment stores

Bootstrap segments are **TTL cache entries** with a default 24 h lifetime and hold no durable state. Three backends pass the shared contract suite:

| Backend | Use |
|---|---|
| `MemorySegmentStore` | Tests, single process |
| `SqliteSegmentStore` | Single node |
| `S3SegmentStore` | Production, any S3-compatible store (AWS S3, Cloudflare R2, MinIO), dependency-free |

`S3SegmentStore` hand-rolls SigV4 over `fetch` (no AWS SDK) and uses a deterministic content-addressed key layout, so every lookup is a direct GET or HEAD by key, with no LIST call. For R2 it takes `endpoint: 'https://<account-id>.r2.cloudflarestorage.com'` with `region: 'auto'`.

For zero-egress bootstrap storms, add signed URLs. Native HMAC (`SignedUrlConfig`) has you serve the bytes and verify the token. Delegated presign (`s3PresignedUrls(store)`) has the object store enforce the grant, so the sync server never proxies segment bytes. Both emit identical descriptors, and clients cannot tell them apart. Keep the direct-download endpoint mounted as the mandatory fallback.

A CDN can cache segment objects by path alone, because the key is the content address and clients verify the hash after download. It must never cache the authorization decision: cache on the path, keep forwarding the query for origin auth, and align the CDN TTL with the store `ttlMs`.

## Blob stores

File-attachment bytes use the same backend spread: `MemoryBlobStore`, `SqliteBlobStore`, and `S3BlobStore` (S3, R2, MinIO, with the same SigV4, the same content-addressed layout, and partition-scoped keys).

Blobs are durable and never expire. A blob referenced by a live row must stay downloadable indefinitely, so `S3BlobStore` has no `ttlMs` and maps to no lifecycle rule.

:::warning{title="No lifecycle rule on the blob prefix"}
An S3 or R2 lifecycle-expiration rule on the `blob/` prefix deletes attachments that live rows still reference. Reclamation is reference-driven: the scheduled `sweepOrphanBlobs` pass deletes only blobs that no live row references ([Blob GC](/server-operations/#blob-gc)).
:::

Two independent presign switches take the server out of the blob byte path. `blobSignedUrls: s3PresignedBlobUrls(blobs)` issues presigned download URLs after the row-derived authorization check. `blobUploadUrls: s3PresignedBlobUploads(blobs)` mints direct-to-storage upload grants. Without them, clients stream through the direct `PUT /blobs/:blobId` endpoint, which is fully supported.

## Upgrading a server database

- **Increment the schema version.** Declared server indexes lead with `_sync_partition`, and unique values are enforced within each partition. The generated client index columns are unchanged. When upgrading an existing server database, increment the application schema version and regenerate the schema before starting the server. The schema migration rebuilds Syncular-owned indexes with the partition column. Reopening the same schema version does not rebuild old indexes. Operator indexes and constraint-owned indexes stay outside the rebuild set.
- **Fence old processes.** A schema migration on SQLite or Postgres raises the writer fence of every existing partition to the new schema version inside the migration transaction. A process still running the previous schema then fails any commit it appends, including server-side writes through `storage.begin()`, with `sync.storage.writer_fence_rejected`, so it never stores payloads in the previous layout. Migrate the database, then replace the old processes; their requests fail until you replace them.
- **Table removal.** Removing a table in a schema migration also deletes its blob references. References from retained tables keep protecting their blobs from garbage collection.
- **D1.** D1 upgrades save progress between Worker invocations. Run `D1ServerStorage.migrateSchema` until it returns `complete: true` before admitting traffic ([D1 schema migration](/server-workers/#schema-migration)).

### Concurrent pulls during pruning

Incremental pulls read their commit window and recheck the retention horizon before starting an active subscription section. Pruning during that read returns `sync.cursor_expired` as a subscription reset. Both client cores report the reset, and `syncUntilIdle` follows it with a fresh bootstrap.

Realtime sessions track commit notification order, including commits outside their registered scopes. A sequence gap, duplicate, or regression sends a catch-up wake. A catch-up acknowledgment advances the notification watermark before deltas resume.

## Advanced: row lookups for trusted server code

Syncular has four lookup shapes. Do not turn a server search need into a client scope unless clients need to subscribe by that dimension.

| Need | API or pattern | Authorization meaning |
|---|---|---|
| One known row | `getRow(table, rowId)` | Trusted partition-local primary-key read |
| Rows in a client delivery scope | `scanRows({ scopeFilter, ... })` | Syncular scope-index scan; at least one variable is mandatory |
| Exact authoritative lookup by app columns | `scanRowsByIndex({ index, values, ... })` | Trusted server-host relational-index scan; never a client scope |
| Ordered or range work queue, or derived topology | Atomically maintained reverse-index or queue rows | Explicit application projection with its own completeness invariant |

An empty or omitted `scopeFilter` never means "all rows". Every shipped adapter throws `StorageQueryError` with `code: 'sync.storage.scan_requires_scope'`, so an empty result cannot hide an unsupported administrative scan. A relational index does not make its columns available to `scanRows`; scope indexes and SQL indexes solve different problems.

### Trusted alternate lookup

Suppose encryption-key grants sync only to their exact user, but revoking a clinic must revoke every grant in that clinic. Keep the client scope small and declare an ordinary relational index for the authoritative lookup:

```ts title="src/schema.ts"
const schema: ServerSchema = {
  version: 12,
  tables: [{
    name: 'device_encryption_key_grants',
    columns: [
      { name: 'id', type: 'string', nullable: false },
      { name: 'user_id', type: 'string', nullable: false },
      { name: 'clinic_id', type: 'string', nullable: false },
      { name: 'wrapped_key', type: 'bytes', nullable: false },
    ],
    primaryKey: 'id',
    scopes: ['user:{user_id}'],
    indexes: [{
      name: 'device_key_grants_by_clinic',
      columns: ['clinic_id'],
    }],
  }],
};
```

The index does not enter `declaredVariables`, named-query scope coverage, a subscription descriptor, or `resolveScopes`. A client can request only `user_id`; knowing the clinic ID or index name grants nothing. Trusted host code uses the exact index inside the same authoritative transaction:

```ts title="src/revoke-clinic.ts"
const tx = await storage.begin(partition);
if (tx.scanRowsByIndex === undefined) {
  throw new Error('storage adapter lacks trusted relational-index scans');
}

let afterRowId: string | null = null;
for (;;) {
  const page = await tx.scanRowsByIndex({
    table: 'device_encryption_key_grants',
    index: 'device_key_grants_by_clinic',
    values: [clinicId],    // one exact value per declared index column
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

SQLite, Postgres, and D1 implement ordered keyset pagination and transaction-local read-your-own-writes. The table must be materialized, the named index must exist, and every index column receives one exact value. Failures use privacy-safe `StorageQueryError.code` values. The API exists only on `@syncular/server` storage capabilities and is unreachable through SSP2. Never wrap it in a route that accepts table, index, or value choices from an untrusted client. A custom storage adapter may omit this capability, and the command then fails closed as above.

`values` is a complete, order-sensitive tuple, and a SQL-style leading-prefix request is unsupported. For an index declared as `columns: ['clinic_id', 'state', 'id']`, only `values: [clinicId, state, id]` is valid. `values: [clinicId]` fails with `sync.storage.index_value_count_mismatch` and does not enumerate the clinic. If a command needs that enumeration, declare a dedicated `columns: ['clinic_id']` index and query it with one value. Trusted prefix and range scans are outside this API.

A provider webhook uses the same shape. Declare `clinics_by_workos_organization` over `workos_organization_id`, resolve the exact clinic, then use another declared index or a known primary key from there. The external tenant identifier never becomes an actor scope.

### When a reverse-index row is still correct

`scanRowsByIndex` is exact and offers no arbitrary SQL or range query. A time-ordered expiry worker, a custom adapter without the capability, or a derived relationship that is not a column on the target row needs an application projection. Model a small reverse-index or queue table whose row ID begins with the lookup or sortable timestamp. Give it a dedicated server scope that `resolveScopes` never grants to application actors. Create and delete that projection in the same authoritative transaction as the domain change. Validate the projection's target row and rebuild it with an idempotent repair job. Tests must prove completeness (every live target has the expected index row) and isolation (an application actor cannot subscribe even when it knows IDs).

Multiple scope variables are independent authorization dimensions, so they are neither alternate indexes nor paired tuples. Use a parent-and-child scope only when both values are real client delivery fences. Use the trusted relational lookup for an exact server command. Use a reverse projection when the lookup is derived, ordered, or ranged.

## Advanced: writing a storage adapter

A custom `ServerStorage` implements these atomic operations on top of the shared contract suite in [`packages/server/test/storage-contract.ts`](https://github.com/syncular/syncular/blob/main/packages/server/test/storage-contract.ts).

| Method | Contract |
|---|---|
| `updateClientCursor(partition, clientId, cursor, updatedAtMs)` | Update only the existing record's cursor and timestamp, each to its maximum, atomically. Keep missing records absent. Preserve actor, wire version, and subscriptions. |
| `advanceClientCursor(partition, clientId, actorId, logEpoch, cursor, updatedAtMs)` | The realtime acknowledgment path. The same atomic update, plus checks of the actor and the current partition log epoch. Leave missing records unchanged. SQLite, Postgres, and D1 perform one update without reading or serializing the subscription list. |
| `putClientRecord` | A full replacement. Changing subscriptions can lower the retention cursor floor. HTTP registration keeps its cursor and subscription replacement rules. |
| `getActiveClientCursorFloor(partition, cutoffMs)` | Return the minimum cursor whose `updatedAtMs >= cutoffMs`, or `null` when no client qualifies. Preserve negative bootstrap cursors. Pruning and admin horizon status use this scalar aggregate; `listClientCursors` remains the explicit listing interface. |
| `getPartitionLogEpoch(partition)` | A point read that leaves the last-authenticated timestamp unchanged. `pruneCommitLog` reads it before computing retention inputs. |
| `pruneCommitsThrough(partition, { logEpoch, throughSeq })` | In one transaction: verify the epoch, compute `max(currentHorizon, throughSeq)`, advance the horizon, and delete commit, change, and scope records through it. Return `{ previousHorizonSeq, horizonSeq, removedCommits }`. Serialize it with restore rotation. An epoch mismatch rejects before deleting. A retry cleans up even when the horizon already covers the requested sequence. |
| `setHorizonSeq` | A monotonic update. |

The built-in adapters implement this contract. The D1 adapter requires partition coordination; call pruning through the Durable Object maintenance method ([Maintenance on a schedule](/server-workers/#schedule-maintenance)).

### SQLite image builders

A custom `sqliteImageBuilder` returns `Promise<Uint8Array>` and receives `rowBatches`, an iterable or async iterable of row arrays. Loop with `for await (const rows of input.rowBatches)`, insert each batch into the dedicated image database, and count rows while consuming. Write the final row count into `_syncular_segment` before serialization. Await `buildSqliteImage(input)` when calling the built-in Bun or Node builder directly.

The server shares in-flight builds for the same storage pair and artifact identity after authorization. Sharing is local to one process, and signed URL grants stay per request. The first eligibility probe reads at most `limitSnapshotRows + 1` rows, and later builder batches hold at most 5,000 rows. The image database and the serialized output still consume memory.
