# Partitions & multi-tenancy

A **partition** is the server's isolation boundary: a tenant, workspace, or organization. This page is for backend developers who run more than one tenant on one server and need to pick the boundary. You leave knowing what a partition isolates and how large to make one.

::meta{for="Backend developers" time="4 minutes" first="guide-server"}

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
- **Write serialization.** Pushes to one partition serialize, and pushes to different partitions run concurrently. On Postgres the per-partition sequence is an `UPDATE … RETURNING` row lock. On [Cloudflare Workers](/server-workers/) each partition is one Durable Object. `commitValidator` correctness depends on this boundary.
- **Client identity.** A `clientId` binds to one actor within its partition. Reuse under a different actor fails with `sync.invalid_client_id`.
- **Maintenance.** `pruneCommitLog`, `pruneReactions`, `sweepOrphanBlobs`, reaction runners, and the admin console each take one partition per call.

Two actors in different partitions never see each other's data, whatever scope values they hold.

## Choose the granularity

The partition is the unit of write serialization and of maintenance scheduling, and the two pull in opposite directions.

- **Too coarse**, such as one partition for everything: every push in the system serializes through one sequence, and one busy tenant delays the rest. On Workers, one Durable Object carries all traffic.
- **Too fine**, such as one partition per user in a collaborative app: rows that sync between users must live in the same partition, so the boundary has to contain every actor who shares data. A finer boundary only adds maintenance passes.

Make the partition the largest set of actors who share synced rows and no larger. In a B2B product that is the customer organization. A single-tenant deployment uses one fixed value.

## Enumerate partitions

The storage backend keeps a partition registry. Every authenticated sync, operation, segment, blob, and realtime request refreshes `lastAuthenticatedAtMs`, and the first request creates the partition's log epoch. Authentication stays the source of the partition value, so a client cannot write the registry.

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
