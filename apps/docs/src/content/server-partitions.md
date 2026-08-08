# Partitions & multi-tenancy

A **partition** is the server's isolation boundary: your tenant, workspace,
or organization. `authenticate` assigns one to every request, and everything
the server stores or serializes is partition-local. Partitions never appear
on the wire; clients cannot name or request one.

```ts
const app = createSyncularHono({
  config,
  authenticate: async (request) => {
    const actor = await verify(request);
    return actor ? { actorId: actor.id, partition: actor.tenant } : null;
  },
});
```

## What a partition scopes

- **The commit log.** `commitSeq` is dense and gap-free per partition;
  cursors, the pruning horizon, and bootstrap segments are all
  partition-local.
- **Write serialization.** Pushes to one partition serialize; pushes to
  different partitions run concurrently. On Postgres the per-partition
  sequence is an `UPDATE … RETURNING` row lock; on
  [Cloudflare Workers](/server-workers/) each partition is one Durable
  Object; `commitValidator` correctness depends on this boundary.
- **Client identity.** A `clientId` binds to one actor within its partition;
  reuse under a different actor fails with `sync.invalid_client_id`.
- **Maintenance.** `pruneCommitLog`, `pruneReactions`, `sweepOrphanBlobs`,
  reaction runners, and the admin console all take one partition per call.

[Scopes](/concepts-scopes/) authorize rows *within* a partition; they do not
cross it. Two actors in different partitions never see each other's data
regardless of scope values.

## Choosing the granularity

The partition is the unit of write serialization and of maintenance
scheduling, which pulls in opposite directions:

- **Too coarse** (one partition for everything): every push in the system
  serializes through one sequence, and one busy tenant delays the rest. On
  Workers, one Durable Object carries all traffic.
- **Too fine** (one partition per user in a collaborative app): rows that
  must sync between users would have to live in the same partition, so the
  boundary must contain every actor who shares data. Below that it only adds
  maintenance passes.

The working rule: the partition is the largest set of actors who share
synced rows, and no larger. In a B2B product that is the customer
organization; in a single-tenant deployment, one fixed value is fine.

## Enumerating partitions

The server derives partitions from `authenticate` and does not keep its own
registry; maintenance code that loops over partitions
([Operations](/server-operations/), the Workers `scheduled` handler) needs
the application's list. Maintain one where your tenants already live (the
application database, or a table the `authenticate` path updates), and treat
an empty maintenance pass for a retired tenant as harmless.

## Where to go next

- [Commits, cursors, idempotency](/concepts-commits/): the per-partition
  log.
- [Cloudflare Workers](/server-workers/): one Durable Object per partition.
- [Operations and maintenance](/server-operations/): the per-partition
  maintenance loops.
