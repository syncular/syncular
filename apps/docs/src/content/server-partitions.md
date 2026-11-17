# Partitions & multi-tenancy

A **partition** is the server's isolation boundary: a tenant, workspace, or organization. This page is for backend developers who run more than one tenant on one server and need to pick the boundary. You leave knowing what a partition isolates and how large to make one.

::meta{for="Backend developers" time="9 minutes" first="guide-server"}

:::terms
- **Partition**: The value `authenticate` assigns to every request. Everything the server stores or serializes is partition-local.
- **Log epoch**: The identifier of a partition's commit-log timeline. A restore rotates it.
- **Partition registry**: The storage backend's list of every partition that has authenticated.
:::

`authenticate` assigns the partition to every request. Partitions never appear on the wire, and clients cannot name or request one.

```ts title="src/server.ts"
const app = createSyncularHono({
  config,
  authenticate: async (request) => {
    const actor = await verify(request);
    return actor ? { actorId: actor.id, partition: actor.tenant } : null;
  },
});
```

:::figure{title="Two partitions on one server" note="Separate logs, separate write queues" ticks}
<div class="d-cols-2">
<div class="d-box">
<p class="d-label">Partition acme</p>
<div class="d-stack">
<div class="node hot"><span class="t">Commit log</span>c1 c2 c3 …<br>dense, gap-free</div>
<div class="node"><span class="t">Write queue</span>Pushes serialize</div>
<div class="node"><span class="t">Clients and cursors</span>Pruning horizon, segments</div>
</div>
</div>
<div class="d-box">
<p class="d-label">Partition globex</p>
<div class="d-stack">
<div class="node hot"><span class="t">Commit log</span>c1 c2 …<br>dense, gap-free</div>
<div class="node"><span class="t">Write queue</span>Pushes serialize</div>
<div class="node"><span class="t">Clients and cursors</span>Pruning horizon, segments</div>
</div>
</div>
</div>

::caption[Pushes to `acme` wait on each other. Pushes to `globex` run concurrently with them. [Scopes](/concepts-scopes/) authorize rows inside one partition and never cross the boundary.]
:::

## What a partition isolates

- **The commit log.** `commitSeq` is dense and gap-free per partition. Cursors, the pruning horizon, and bootstrap segments are partition-local.
- **Write serialization.** Pushes to one partition serialize, and pushes to different partitions run concurrently. On Postgres a push request locks the partition's `sync_partitions` row (`SELECT … FOR UPDATE`) as its transaction opens and holds the lock until COMMIT; [Throughput of one partition](#throughput-of-one-partition) measures what that costs. On [Cloudflare Workers](/server-workers/) each partition is one Durable Object. `commitValidator` correctness depends on this boundary.
- **Client identity.** A `clientId` binds to one actor within its partition. Reuse under a different actor fails with `sync.invalid_client_id`.
- **Maintenance.** `pruneCommitLog`, `pruneReactions`, `sweepOrphanBlobs`, reaction runners, and the admin console each take one partition per call.

Two actors in different partitions never see each other's data, whatever scope values they hold.

## Choose the granularity

The partition is the unit of write serialization and of maintenance scheduling, and the two pull in opposite directions.

- **Too coarse**, such as one partition for everything: every push in the system serializes through one sequence, and one busy tenant delays the rest. On Workers, one Durable Object carries all traffic.
- **Too fine**, such as one partition per user in a collaborative app: rows that sync between users must live in the same partition, so the boundary has to contain every actor who shares data. A finer boundary only adds maintenance passes.

Make the partition the largest set of actors who share synced rows and no larger. In a B2B product that is the customer organization. A single-tenant deployment uses one fixed value.

## Throughput of one partition

A push request on PostgreSQL holds the partition lock from its first statement after `SELECT … FOR UPDATE` until COMMIT returns, so one partition applies push requests one at a time. The time a request holds the lock is the number of statements it runs under the lock multiplied by the round-trip time to PostgreSQL, plus the database's own work. The ceiling of a partition follows from that product:

```text
commits per second ≈ commits per request / (statements under the lock × round-trip time)
```

Since 0.78.0 a request of several commits runs in one transaction under one lock. A request with one 1-row commit and a `commitValidator` that reads four rows runs 12 statements under the lock: the outbox settlement (2), the serve gate, a savepoint, the row upsert, the four validator reads, the commit-log append, the push results and COMMIT. A request of 10 such commits runs 74 to 75 statements, about 7.4 per commit. The row count barely changes it: a 10-row commit upserts its rows in one statement per table.

### Measured ceilings

The [partition ceiling](https://github.com/syncular/syncular/blob/main/load/README.md#partition-ceiling) harness in `load/` produced the figures below on 17 November 2026:

- Hardware: Apple M5 Pro (5 performance and 10 efficiency cores, 64 GB), macOS 27.2. Bun 1.4.4.
- PostgreSQL 17.12 in Docker inside a colima VM with 6 vCPUs and 8 GB, default settings (`fsync` and `synchronous_commit` on) except `max_connections=400`. The servers connect to the VM's own address; `SELECT 1` takes 0.1 to 0.4 ms there.
- Round-trip time: the direct connection (the 0 ms rows), and a TCP proxy that holds every chunk in each direction, set to measure 13 ms with `SELECT 1` (12.1 to 13.0 ms measured), the round trip a production Cloudflare Worker measured to Neon through Hyperdrive.
- Server: four Bun processes running `@syncular/server` 0.78.0 behind `createSyncularHono`, one pooled `Bun.SQL` connection per client each process serves. Client `n` talks to process `n mod 4`. No server process used more than 40% of a core, so the figures measure PostgreSQL and the partition lock.
- Commit shape: the reference app writes rows of the `tasks` table, one project scope per pusher; its `commitValidator` reads four rows with four sequential `getRow` calls.
- Clients: protocol-level HTTP clients. A pusher sends its next push request when the last one returns; each push request also carries its pull frames, as a client round does. A reader sends pull-only rounds back to back.
- Measurement: 30 seconds per point. The window opens after a 5-second warm-up once every pusher has finished a request (at most 120 seconds), so a saturated partition has its queue full. Commit latency is the latency of the request that carried the commit.

Pushers alone, one 1-row commit per request:

| Round trip | Pushers | Commits/s | Commit p50 / p99 | Lock held (p50) |
|---|---|---|---|---|
| 0.3 ms | 1 | 85.2 | 11.6 / 22 ms | 5.5 ms |
| 0.4 ms | 10 | 161.6 | 61.8 / 149 ms | 5.8 ms |
| 0.2 ms | 50 | 37.7 | 188 ms / 11.9 s | 7.6 ms |
| 4.7 ms | 200 | 60.7 | 2.2 / 23.2 s | 11.3 ms |
| 12.2 ms | 1 | 3.4 | 289 / 389 ms | 145 ms |
| 12.2 ms | 10 | 5.9 | 702 ms / 8.9 s | 157 ms |
| 12.1 ms | 50 | 6.9 | 438 ms / 28.2 s | 144 ms |
| 12.3 ms | 200 | 6.4 | 491 ms / 89.8 s | 156 ms |

With 20 readers sending pull-only rounds alongside:

| Round trip | Rows / commit | Commits / request | Pushers | Commits/s | Commit p50 / p99 | Pull rounds/s | Pull p50 / p99 |
|---|---|---|---|---|---|---|---|
| 0.3 ms | 1 | 1 | 1 | 38.4 | 24 / 60 ms | 1,957 | 9.0 / 30 ms |
| 0.3 ms | 1 | 1 | 10 | 63.3 | 143 / 488 ms | 1,753 | 10 / 30 ms |
| 0.3 ms | 1 | 1 | 50 | 47.6 | 687 ms / 5.4 s | 1,286 | 14 / 37 ms |
| 0.2 ms | 1 | 1 | 200 | 20.1 | 7.3 / 39.1 s | 401 | 49 / 89 ms |
| 0.3 ms | 1 | 10 | 1 | 100.0 | 93 / 194 ms | 1,753 | 9.8 / 38 ms |
| 0.3 ms | 1 | 10 | 10 | 96.3 | 965 ms / 2.5 s | 1,287 | 14 / 42 ms |
| 0.2 ms | 1 | 10 | 50 | 27.3 | 18.7 / 58.4 s | 227 | 92 / 126 ms |
| 0.2 ms | 1 | 10 | 200 | 17.3 | 59.3 / 145 s | 152 | 132 / 171 ms |
| 0.1 ms | 10 | 1 | 1 | 59.8 | 16 / 33 ms | 3,062 | 4.8 / 22 ms |
| 0.1 ms | 10 | 1 | 10 | 108.2 | 88 / 270 ms | 3,613 | 4.7 / 18 ms |
| 0.1 ms | 10 | 1 | 50 | 43.5 | 790 ms / 5.6 s | 1,580 | 12 / 22 ms |
| 0.1 ms | 10 | 1 | 200 | 30.9 | 4.4 / 29.3 s | 607 | 32 / 55 ms |
| 0.1 ms | 10 | 10 | 1 | 184.7 | 53 / 82 ms | 3,438 | 3.6 / 37 ms |
| 0.1 ms | 10 | 10 | 10 | 86.3 | 1.1 / 2.1 s | 1,022 | 19 / 41 ms |
| 0.1 ms | 10 | 10 | 50 | 52.3 | 10.1 / 21.5 s | 481 | 41 / 68 ms |
| 0.1 ms | 10 | 10 | 200 | 18.0 | 38.8 / 137 s | 164 | 122 / 159 ms |
| 12.7 ms | 1 | 1 | 1 | 3.2 | 310 / 438 ms | 165 | 120 / 139 ms |
| 12.9 ms | 1 | 1 | 10 | 6.1 | 479 ms / 6.6 s | 171 | 117 / 132 ms |
| 12.6 ms | 1 | 1 | 50 | 6.5 | 456 ms / 33.2 s | 176 | 114 / 127 ms |
| 12.7 ms | 1 | 1 | 200 | 6.4 | 474 ms / 75.0 s | 170 | 118 / 127 ms |
| 13.0 ms | 1 | 10 | 1 | 9.0 | 1.1 / 1.2 s | 173 | 114 / 130 ms |
| 13.0 ms | 1 | 10 | 10 | 10.0 | 10.0 / 11.1 s | 175 | 114 / 125 ms |
| 13.0 ms | 1 | 10 | 50 | 10.3 | 51.2 / 52.2 s | 179 | 112 / 118 ms |
| 13.0 ms | 1 | 10 | 200 | 10.7 | 135 / 150 s | 188 | 107 / 118 ms |
| 13.0 ms | 10 | 1 | 1 | 3.3 | 304 / 401 ms | 167 | 116 / 135 ms |
| 13.0 ms | 10 | 1 | 10 | 6.7 | 454 ms / 9.2 s | 176 | 113 / 127 ms |
| 12.9 ms | 10 | 1 | 50 | 6.5 | 456 ms / 32.9 s | 176 | 113 / 126 ms |
| 13.0 ms | 10 | 1 | 200 | 6.6 | 451 ms / 91.8 s | 177 | 112 / 126 ms |
| 12.8 ms | 10 | 10 | 1 | 9.0 | 1.1 / 1.2 s | 173 | 115 / 134 ms |
| 12.9 ms | 10 | 10 | 10 | 10.0 | 9.8 / 10.3 s | 177 | 113 / 123 ms |
| 12.8 ms | 10 | 10 | 50 | 10.3 | 50.7 / 52.3 s | 178 | 111 / 125 ms |
| 12.9 ms | 10 | 10 | 200 | 10.7 | 134 / 149 s | 190 | 105 / 120 ms |

At 13 ms the arithmetic holds: 12 statements hold the lock for 145 to 157 ms, and the partition applies 6 to 7 one-commit requests a second however many pushers queue. A request of 10 commits holds the lock for 940 to 980 ms and the partition applies 10 to 11 commits a second. A pusher's commit latency is its wait in that queue, so it grows with the number of pushers while throughput stays flat.

Pull-only rounds take no partition lock. At 13 ms a pull round takes about 115 ms, nine round trips to PostgreSQL, whether pushes saturate the partition or not, and 20 readers complete 165 to 190 rounds a second. At sub-millisecond round trips readers and pushers share PostgreSQL's CPU: 20 readers sending 1,750 to 3,600 rounds a second double the lock hold of a lone pusher (5.5 to 11.5 ms) and halve its throughput.

Past 10 pushers at sub-millisecond round trips throughput falls, from 161.6 to 37.7 and 60.7 commits a second without readers, and the lock hold rises from 5.8 to 11.3 ms. The lock wait is uneven at every round-trip time: at 13 ms the median commit waits under 0.5 seconds while the p99 reaches 33 seconds at 50 pushers and 75 to 92 seconds at 200, because PostgreSQL does not grant a waiting row lock in arrival order.

Size partitions from these figures. Divide the peak commit rate you expect by the partition's ceiling at your round-trip time; a peak above the ceiling needs a database closer to the server, fewer statements under the lock (a validator that reads its rows with one `getRows` call runs one statement instead of one per row), or more partitions.

The pool size matters as well. With one server process and `Bun.SQL`'s default pool of 10 connections, 50 pushers sending 10-commit requests at 13 ms held every connection while they waited for the lock, and no pull round completed in a 5-second window. Give the pool at least as many connections as the requests a server process runs at once.

### Measure your own app

The harness takes an app module with its own schema, server configuration, validators and commit shape:

```sh title="terminal"
bun run load:ceiling --pg-url postgres://user:pass@host:5432/postgres \
  --app /abs/path/to/ceiling-app.ts --rtt 0,13 --rows 1 --commits 1 \
  --pushers 1,10,50,200 --readers 20
```

The module default-exports a `CeilingApp`: `schema`, `createServer({ executor })` returning the handler for `POST /sync`, `headers(client)`, `scopes(client)` and `commit({ client, seq, rows })`. The runner recreates the database `syncular_ceiling` for every point, so point `--pg-url` at a disposable instance. `load/src/ceiling-app.ts` is the reference app that produced the figures above; [load/README.md](https://github.com/syncular/syncular/blob/main/load/README.md#partition-ceiling) lists every flag.

## Enumerate partitions

The storage backend keeps a partition registry. Every authenticated sync, operation, segment, blob, and realtime request reads the partition's registry row, and the first request creates the row with the partition's log epoch. A request writes `lastAuthenticatedAtMs` only when the stored value is at least 60 seconds (`PARTITION_TOUCH_INTERVAL_MS`) older than the request's clock, so a read-only request takes no write lock and a partition under steady traffic costs one registry write per minute. Treat `lastAuthenticatedAtMs` as accurate to that interval. Authentication stays the source of the partition value, so a client cannot write the registry.

Use the registry for maintenance loops:

```ts title="src/maintenance.ts"
for (const entry of await storage.listPartitionRegistry()) {
  await pruneCommitLog({
    storage,
    partition: entry.partition,
    nowMs: Date.now(),
  });
}
```

Each entry holds `partition`, `logEpoch`, `epochRequired`, and `lastAuthenticatedAtMs`. A maintenance policy can skip a long-inactive entry, while the admin fleet view lists every entry. A restore rotates the log epoch before traffic resumes ([Backup and restore](/server-operations/#backup-and-restore)). The per-partition log is described on [Commits, cursors, idempotency](/concepts-commits/).
