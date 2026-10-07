# Choosing a database

Pick the database, segment store, and blob store your sync server runs on. This page is for backend developers deciding before they build; it ends with one choice per store and a link to its wiring. Per-backend detail is on [Storage reference](/server-storage-reference/).

::meta{for="Backend developers" time="4 minutes" first="what-is"}

:::terms
- **`ServerStorage`**: The interface for the commit log and the rows. SQLite, Postgres, and D1 implement it.
- **`SegmentStore`**: The interface for bootstrap segments. Segments are cache entries with a 24 h default lifetime.
- **`BlobStore`**: The interface for file-attachment bytes. Blobs are durable until no row references them.
- **Realtime fanout**: How a commit applied on one process reaches sockets connected to another.
:::

:::figure{title="Pick by where the server runs" note="Three databases, one decision" ticks}
<div class="d-cols-3">
<div class="node ok"><span class="t">Cloudflare Workers</span><b>D1</b><br>R2 for segments and blobs<br>One Durable Object per partition<br><span class="chip ok">Edge</span></div>
<div class="node hot"><span class="t">Bun or Node, production</span><b>Postgres</b><br>S3-compatible segments and blobs<br>LISTEN/NOTIFY across instances<br><span class="chip amber">Multi-instance</span></div>
<div class="node cool"><span class="t">Bun or Node, one machine</span><b>SQLite</b><br>SQLite segments and blobs<br>In-process realtime hub<br><span class="chip">Dev and single node</span></div>
</div>

::caption[All three store the same tables and pass one shared contract suite, so moving between them changes configuration and no client or schema code.]
:::

## Database

| Backend | Adapter | Realtime fanout | Choose it for |
|---|---|---|---|
| SQLite (`bun:sqlite` or `node:sqlite`) | `SqliteServerStorage` from `@syncular/server/sqlite` | In-process hub | Development, demos, single-node deployments. The [quickstart](/quickstart/) and the load suite use it. |
| Postgres | `PostgresServerStorage` plus your driver through `PgExecutor` | LISTEN/NOTIFY through `PostgresFanout` | Production on Bun or Node, especially with more than one instance |
| Cloudflare D1 | `D1ServerStorage` | In-Durable-Object fanout | Cloudflare Workers ([Cloudflare Workers](/server-workers/)) |

`SqliteServerStorage` runs on `bun:sqlite` under Bun and on built-in `node:sqlite` under Node 22.13 or newer. The server library imports no Postgres driver; you adapt Bun.sql or node-postgres in about 20 lines ([Postgres](/server-storage-reference/#postgres)).

Every backend materializes each synced table as a real table with your typed columns beside the sync columns, so you can run SQL and analytics against synced data in the server database ([Materialized app tables](/server-storage-reference/#materialized-app-tables)).

:::rule{title="Reads must be fresh"}
Sync storage must read committed writes immediately. A stale query cache or a lagging replica on the sync path fails pushes with `sync.storage_stale_read`. This includes Cloudflare Hyperdrive, which caches SELECT results by default ([Read freshness](/server-storage-reference/#read-freshness)).
:::

## Segment stores

Bootstrap segments are cache entries, so losing them costs a rebuild and no data.

| Store | Choose it for |
|---|---|
| `MemorySegmentStore` | Tests and single processes |
| `SqliteSegmentStore` | A single node |
| `S3SegmentStore` | Production on any S3-compatible service (AWS S3, Cloudflare R2, MinIO) |

## Blob stores

Blobs carry file attachments and have no expiry, so the store must be durable.

| Store | Choose it for |
|---|---|
| `MemoryBlobStore` | Tests |
| `SqliteBlobStore` | A single node |
| `S3BlobStore` | Production on any S3-compatible service |

Presigned URLs for segments and blobs take the server out of the byte path. [Segment stores](/server-storage-reference/#segment-stores) and [Blob stores](/server-storage-reference/#blob-stores) cover them.

## Wire the choice

- **Bun or Node**: pass the three stores in `SyncServerConfig` ([Server setup](/guide-server/)).
- **Workers**: D1, R2, and the Durable Object are wired together on [Cloudflare Workers](/server-workers/).
- **Several partitions or tenants**: [Partitions & multi-tenancy](/server-partitions/) explains how the storage backend scopes them.
