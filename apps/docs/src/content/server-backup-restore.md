# Backup and restore

A server backup must preserve one authoritative recovery point. Include the
row tables, commit log, partition registry, client records, reactions, leases,
and every backend table owned by `@syncular/server`. Include external segment
and blob objects referenced by that database recovery point. A database
snapshot that references missing objects fails during bootstrap or blob read.

Use the snapshot mechanism provided by the storage backend. SQLite can use its
online backup or serialization API. Postgres can use a physical snapshot or a
transactionally consistent logical backup. The host owns backup scheduling,
encryption, retention, and restore testing.

## Restore sequence

Run these steps for every restore, including a restore onto the same database
endpoint:

1. Stop sync HTTP traffic, WebSocket upgrades and delivery, remote operations,
   reaction runners, and maintenance jobs that write to the recovery target.
2. Wait for in-flight requests and storage transactions to finish.
3. Restore the database and its referenced segment and blob objects from one
   recovery point.
4. Open the restored storage backend through its normal startup path. Call
   `migrate()` for Postgres or D1; the SQLite constructor applies its internal
   DDL.
5. Rotate the log epoch for every restored partition while traffic remains
   stopped.
6. Read the partition registry and verify that every restored partition has
   the new epoch with `epochRequired: true`. Verify that its stored client
   records are empty.
7. Start the server, then restart maintenance and reaction runners.

Rotate after restoring the database. The restore would overwrite an epoch
written before step 3.

```ts
import { rotatePartitionLogEpoch } from '@syncular/server';

for (const entry of await storage.listPartitionRegistry()) {
  const rotated = await rotatePartitionLogEpoch({
    storage,
    partition: entry.partition,
  });

  if (!rotated.epochRequired) {
    throw new Error('restored partition did not require the new log epoch');
  }
}
```

`rotatePartitionLogEpoch` generates a random UUID by default. An operator tool
can pass `logEpoch` when an external recovery controller owns epoch generation.
The value must be nonempty and unique for that partition timeline.

## Client behavior after traffic resumes

A wire-version 2 client sends its stored partition log epoch on every round.
The server answers an epoch mismatch with a header-only response containing
the current epoch and `resetRequired: true`. The client then clears server
rows, subscription cursors, bootstrap state, and downloaded segment metadata.
It retains the client ID, subscriptions, local-only tables, and durable outbox.
The next rounds bootstrap current server state and replay pending outbox
commits against that state.

The reset prevents a cursor from the abandoned timeline from crossing the
restore boundary. It also preserves offline writes created before the client
learned about the restore.

A wire-version 1 client cannot observe a log epoch. Once any partition epoch
has rotated, the server rejects version 1 for that partition with
`sync.client_wire_unsupported`. Upgrade these clients before running a restore
that must preserve automatic recovery.

## Verification drill

Test restores with two client snapshots:

- `behind`: last synchronized before the backup recovery point.
- `ahead`: synchronized after the backup and holding an additional offline
  outbox write.

Restore the backup and rotate the partition epoch. Both clients must receive a
reset before any push or pull work. The ahead client must lose server rows that
existed only after the recovery point, retain its offline outbox write, replay
that write, and converge with a newly created client. The conformance catalog
runs this sequence against the TypeScript and Rust clients.

Record the backup identifier, restored partition list, old and new epoch
values, restore time, and verification result in the operator log. Do not log
row contents, authorization headers, or blob payloads.
