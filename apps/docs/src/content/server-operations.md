# Operations and maintenance

Run a sync server day to day: read its events, open the admin console, seed data, schedule pruning and garbage collection, back it up, restore it, and load-test it. This page is for the operator of a running server. Each section is one task, and everything here is host-scheduled and opt-in.

::meta{for="Server operators" time="20 minutes" first="guide-server"}

:::terms
- **Event sink**: A `SyncularServerEvents` implementation that receives every operator-relevant signal.
- **Pruning horizon**: The commit sequence at or below which the server has deleted history ([Commits, cursors, idempotency](/concepts-commits/#the-pruning-horizon)).
- **Log epoch**: A per-partition identifier that a restore rotates so clients reset.
- **Orphan blob**: A stored blob that no live row references.
:::

:::figure{title="What you schedule" note="The server runs none of these on its own" ticks}
<div class="d-cols-3">
<div class="node ok"><span class="t">Continuous</span>Events to your sink<br>Admin console reads</div>
<div class="node hot"><span class="t">Hourly to daily, per partition</span>pruneCommitLog<br>pruneReactions<br>sweepOrphanBlobs</div>
<div class="node cool"><span class="t">On demand</span>seedMutations<br>Backup and restore<br>Load tests</div>
</div>

::caption[Loop the maintenance passes over `storage.listPartitionRegistry()`, because each pass takes one partition ([Partitions](/server-partitions/#enumerate-partitions)).]
:::

Application-level domain actions use immutable [domain event rows](/guide-domain-events/). Registered application queries and commands use [remote server operations](/guide-remote-operations/). `SyncularServerEvents` below is operational telemetry.

## Structured events

`SyncularServerEvents` is one optional interface that carries every operator-relevant signal as a typed, JSON-able event of stable shape: request, push, pull, segment, blob, realtime, prune, and resolver signals. Emission is fire-and-forget and never throws through. It costs nothing when unset, because no event object is built without a sink. It reads the ctx clock, so tests under a virtual clock stay deterministic.

`consoleJsonEvents()` is the reference sink and writes one JSON line per event to stdout. `RingBufferEvents` retains the last N events in memory with `query({ type?, sinceMs?, limit })`, which gives you the event stream without infrastructure. `composeEvents` fans one emission out to several sinks:

```ts title="src/server.ts"
import {
  RingBufferEvents, composeEvents, consoleJsonEvents,
  type SyncServerConfig,
} from '@syncular/server';

const ring = new RingBufferEvents({ capacity: 1000 });
const config: SyncServerConfig = {
  schema, storage, segments, resolveScopes,
  events: composeEvents(ring, consoleJsonEvents()), // both see every event
};
```

The sink is part of `SyncServerConfig`, so adapters pass it through without extra wiring. The realtime hub and `pruneCommitLog` take the same sink in their own options. The server has no logger dependency; a Sentry or metrics adapter is a `emit` implementation of about 20 lines. The event catalog is `request.handled`, `push.applied`, `push.rejected`, `push.conflicted`, `pull.served`, `segment.downloaded`, `blob.swept`, `reaction.*`, `realtime.*`, `prune.completed`, and `scopes.resolve_failed`, documented in the [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md). Reaction lifecycle events are on [Durable server reactions](/server-reactions/#observe-and-inspect-reactions).

`pull.served` carries the request's accepted push sequence and storage maximum. Each subscription in it lists requested and effective scopes, cursors before and after, and the first and last delivered commit sequence. Compare these fields with `push.applied.commitSeq` to tell a missing wake from a scope exclusion or a stale storage read. Hash subscription IDs and scope values in your sink before sending diagnostic evidence outside the application.

### What to alert on

| Event or field | Alert on |
|---|---|
| `push.rejected` rate by `code` | A rising `sync.forbidden` share usually marks an authorization regression in your host; check it before you suspect clients. `push.conflicted` is normal offline-first traffic. |
| `scopes.resolve_failed` | Any nonzero rate. This is the fail-loud path, and it is almost always a host bug or a dead resolver dependency. |
| `request.handled` with `outcome: "error"` and `errorCode: "internal"` | Storage failures that surface mid-stream. |
| `pull.served` with `status: "reset"` | Spikes relative to fleet size ([Commit-log pruning](#commit-log-pruning)). |
| `prune.completed` with `advanced: false` | Many consecutive passes while the log grows. One lagging cursor inside the active window pins retention; the floors bound the damage to `ageForceMs`. |
| `reaction.prune_completed` with `mayHaveMore: true` | After every scheduled batch: terminal rows accumulate faster than cleanup removes them. Raise the batch count or run passes more often. |
| `realtime.wake` with `reason: "delta-too-large"` | Sustained occurrences: commits routinely exceed the delta limit and clients fall back to HTTP pulls. Raise the limit or shrink commits. |

## Admin console

`SyncularAdmin` is a read-only, partition-scoped query surface over server storage plus the event ring. It shows clients and their cursors, commit metadata (never payloads), per-row version and scopes, scope activity, horizon status, durable reactions, segment and blob stats, and the event tail. Reaction reads include their persisted payload and failure details, so admin access is application-data access.

```ts title="src/server.ts"
import { SyncularAdmin } from '@syncular/server';
import { createSyncularAdminRoutes } from '@syncular/server-hono';

const admin = SyncularAdmin.fromConfig(config, { ring });
const routes = createSyncularAdminRoutes(admin, {
  defaultPartition: 'main',
  authorize: ({ request }) => isOperator(request), // YOUR check (mandatory)
});
app.route('/admin', routes);
```

:::warning{title="Authorization is mandatory"}
The factory throws if you omit `authorize`, and the console is never open by default. Every endpoint runs the guard first, and a falsy result answers 401.
:::

`GET /admin` serves a single static HTML page, built without a framework or a build step. It polls the sibling JSON endpoints and renders horizon, store stats, clients, recent commits, and the event tail with a 2 s auto-refresh. S3-backed stats are labeled `approximate`, because S3 does not report exact counts cheaply. A storage backend that omits an optional admin method raises an error, so the console never renders a silently empty view.

## Seeding data

`seedMutations` pushes app-shaped values through the real push pipeline (authorization, validation, idempotency, realtime fanout), so seeded rows behave exactly like synced rows. It is the supported seeding recipe for dev servers, demos, and ops scripts.

```ts title="scripts/seed.ts"
import { SeedMutationError, seedMutations } from '@syncular/server';

try {
  await seedMutations(
    config,
    {
      partition: 'demo',
      actorId: 'seed-user',
      clientId: 'demo-seed',
      commitId: 'welcome-v1',
    },
    [
      {
        table: 'todos',
        op: 'upsert',
        // SQL snake_case or the exact generated camelCase alias; missing
        // nullable columns become NULL.
        values: { id: 'seed-1', listId: 'groceries', title: 'Hello', done: false },
      },
    ],
  );
} catch (error) {
  if (error instanceof SeedMutationError) {
    console.error({
      code: error.code,
      operation: error.opIndex,
      replayed: error.replayed,
      recordedAtMs: error.recordedAtMs,
      cacheIdentity: error.cacheIdentity,
    });
  }
  throw error;
}
```

Fanout is in-process. A seed run inside the serving process reaches that process's realtime hub, so connected clients receive the commit. A seed run from a separate process against the same shared storage (an ops script, a second instance, a `bun run seed` job) cannot reach this process's in-memory hub. Fresh replicas and reconnects see the commits, and connected clients see them after they re-pull or reconnect. Every out-of-process writer has this limit. Bridge it as a multi-instance deployment does: `PostgresFanout` on Postgres, the Durable Object on Workers ([Choosing a database](/server-storage/)).

The commit ID defaults to the stable `seed-commit-1`, so re-running an accepted seed writes nothing twice. Rejections are terminal for the same `clientId` and `commitId` as well: fixing the resolver or validator does not alter the recorded outcome. `SeedMutationError` exposes the exact protocol or host-validator `code`, `opIndex`, `replayed`, the original `recordedAtMs`, and a privacy-safe `cacheIdentity`, so no message parsing is needed. Malformed helper input, such as an unknown table or column, throws `SyncError` before a push exists.

### Correct a seed

Inspect the structured error, fix the seed or the authority, and advance a reviewable seed revision such as `welcome-v1` to `welcome-v2`. Leave the database and unrelated rows intact, and keep the old idempotency outcome as it is. This revisioning applies to a changed seed definition. An application command keeps its original request ID after an unknown outcome, because a new ID can execute the same real-world operation twice.

The `clientId` has its own identity contract: its first registration binds it to one actor within the partition. Revisions by the same seed actor keep the stable client ID. If a security or ownership correction moves the seed to a different actor, advance both identities:

```ts title="scripts/seed.ts"
await seedMutations(config, {
  partition: 'production-eu',
  actorId: 'server-authority',       // changed from seed-user
  clientId: 'catalog-server-seed',   // new purpose-specific client identity
  commitId: 'catalog-v2',            // new seed definition revision
}, correctedRows);
```

Changing the actor and commit ID while keeping the old client ID fails with `sync.invalid_client_id` and `recommendedAction: resetClientId`. That error reports an actor and client mismatch. Recover with a new purpose-specific client ID as above. This recipe covers controlled seeding and backfills.

In tests, [`@syncular/testkit`](/tooling-testing/) covers the same ground with virtual time: a test client mutates and syncs.

## Pruning and garbage collection

Three passes reclaim storage, and each runs on a schedule you control. Run each over the storage-backed registry. Authenticated server endpoints refresh its timestamp, so the loop needs no second tenant list. Use `lastAuthenticatedAtMs` when the host excludes inactive partitions from frequent passes, and keep a slower pass over the full registry so retired partitions still get retention and blob cleanup.

```ts title="src/maintenance.ts"
for (const { partition } of await storage.listPartitionRegistry()) {
  await pruneCommitLog({ storage, partition, nowMs: Date.now(), events });
}
```

### Commit-log pruning

The commit log grows until you prune it. `pruneCommitLog` advances the per-partition horizon and deletes commits at or below it. Nothing prunes automatically. Hourly to daily is the usual range, and a pass with nothing to do is cheap.

```ts title="src/maintenance.ts"
import { pruneCommitLog } from '@syncular/server';

await pruneCommitLog({
  storage,
  partition: 'main',
  nowMs: Date.now(),
  events, // emits prune.completed per pass
});
```

Pruning commits the horizon and the history deletion atomically. Concurrent passes cannot lower the horizon, and repeating a completed pass removes only the remaining eligible records. A restore between the retention reads and the deletion fails with `sync.storage.prune_epoch_mismatch`; recompute the pass after the restore completes. An unregistered partition fails with `sync.storage.partition_unregistered`. On D1, call pruning through the partition's Durable Object maintenance method ([Schedule maintenance](/server-workers/#schedule-maintenance)). Reaction rows live in a separate table, and commit-log pruning never deletes them.

:::figure{title="What sets the horizon" note="RetentionPolicy floors"}
<div class="d-row">
<div class="node ok"><span class="t">Active-client floor</span>The horizon stops at the lowest cursor of clients seen within <code>activeWindowMs</code><br><span class="chip">14 days</span></div>
<div class="node bad"><span class="t">Age limit</span>Commits older than <code>ageForceMs</code> may go regardless<br><span class="chip bad">30 days</span></div>
<div class="node cool"><span class="t">Newest commits</span>The newest <code>minRetainedCommits</code> always stay<br><span class="chip cool">1000</span></div>
</div>

::caption[The defaults are conservative. Lowering them causes more client resets.]
:::

A client whose cursor fell behind the horizon receives a reset and re-bootstraps from scratch. That behavior is expected, and its rate is your pruning health signal. Devices returning from long absences produce a low steady rate. A rising rate means the horizon passed cursors the fleet still uses, and each affected client pays a full re-bootstrap. Observe it through `pull.served` subscriptions with `status: "reset"`.

### Reaction retention

The host schedules `pruneReactions` per partition alongside commit-log pruning. The defaults retain completed records for 30 days and dead-lettered records for 90 days, and one pass removes at most 1,000 records.

```ts title="src/maintenance.ts"
import { pruneReactions } from '@syncular/server';

let result;
do {
  result = await pruneReactions({
    storage,
    partition: 'main',
    nowMs: Date.now(),
    events,
  });
} while (result.mayHaveMore);
```

Only terminal records older than their cutoff are eligible. Pending and leased records stay, including expired leases that a worker can reclaim. Dead-letter retention sets how long operators can inspect and manually retry a failed record; configure a longer duration when failure investigation or retry procedures need it.

Each bounded pass emits `reaction.prune_completed`. A full batch reports `mayHaveMore: true`, so repeat until it is false. Timestamp indexes support both age filters, and the delete limit keeps a pass from monopolizing the storage writer. The lifecycle and retention API are on [Durable server reactions](/server-reactions/).

### Blob GC

Blobs are durable, so reclamation tracks live references on your schedule. `sweepOrphanBlobs` is the blob counterpart of `pruneCommitLog`.

```ts title="src/maintenance.ts"
import { sweepOrphanBlobs } from '@syncular/server';

const { swept } = await sweepOrphanBlobs(storage, blobs, partition, {
  graceMs: 24 * 60 * 60 * 1000, // default
  events,                        // emits blob.swept
});
```

The sweep reads the live keep-set from the storage reference index and deletes only blobs that are both unreferenced and older than the grace period. Clients upload bytes before they push the row that references them, so a fresh upload is unreferenced until its push lands, and the grace period covers that gap. The 24 h default sits far above any push window. Lower it only when you know your clients' outbox latency, because a grace period that is too tight deletes blobs that are still needed. The helper throws against a storage without the reference index instead of sweeping with an empty keep-set.

## Backup and restore

A backup preserves one authoritative recovery point. Include the row tables, commit log, partition registry, client records, reactions, leases, and every backend table that `@syncular/server` owns. Include the external segment and blob objects that the database recovery point references, because a snapshot that references missing objects fails during bootstrap or blob read.

Use the snapshot mechanism of the storage backend. SQLite offers its online backup or serialization API. Postgres offers a physical snapshot or a transactionally consistent logical backup. The host owns backup scheduling, encryption, retention, and restore testing.

:::figure{title="Why a restore rotates the log epoch" note="Per partition"}
<div class="d-row">
<div class="node"><span class="t">Backup point</span>Commits up to c900<br><span class="chip">epoch A</span></div>
<span class="d-arrow"></span>
<div class="node bad"><span class="t">Lost timeline</span>c901 … c960 existed only after the backup<br><span class="chip bad">abandoned</span></div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">After restore</span>Rotate to a new epoch<br><span class="chip ok">epoch B</span></div>
</div>

::caption[A client with a cursor from epoch A would otherwise cross the restore boundary. The epoch mismatch resets its server rows and keeps its outbox.]
:::

### Restore a server

Run these steps for every restore, including one onto the same database endpoint.

:::::steps
::::step{title="Stop all writers" time="2 min"}
Stop sync HTTP traffic, WebSocket upgrades and delivery, remote operations, reaction runners, and maintenance jobs that write to the recovery target. Wait for in-flight requests and storage transactions to finish.

::checkpoint[No process writes to the recovery target.]
::::

::::step{title="Restore the database and objects"}
Restore the database and its referenced segment and blob objects from one recovery point.

::checkpoint[The database and the object stores come from the same backup.]
::::

::::step{title="Open the restored storage"}
Open the restored storage backend through its normal startup path. Call `migrate()` for Postgres or D1. The SQLite constructor applies its internal DDL.

::checkpoint[The storage opens without a layout error ([Layout check](/server-storage-reference/#layout-check)).]
::::

::::step{title="Rotate the log epoch" time="1 min"}
Rotate after restoring the database, because the restore overwrites any epoch written before it. Keep traffic stopped.

```ts title="scripts/restore.ts"
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

`rotatePartitionLogEpoch` generates a random UUID by default. An operator tool can pass `logEpoch` when an external recovery controller owns epoch generation. The value must be nonempty and unique for that partition's timeline.

::checkpoint[The script finishes without throwing.]
::::

::::step{title="Verify the registry"}
Read the partition registry. Every restored partition shows the new epoch with `epochRequired: true`, and its stored client records are empty.

::checkpoint[Every entry reports `epochRequired: true`.]
::::

::::step{title="Start the server"}
Start the server, then restart maintenance and the reaction runners.

::checkpoint[Clients reconnect and reset once ([below](#client-behavior-after-traffic-resumes)).]
::::
:::::

### Client behavior after traffic resumes

A replica without a stored log epoch acquires it in its first round. The client persists the epoch and schedules the next round without raising `upgrading`, dropping tables, or resetting subscription progress. Local outbox rows stay visible throughout acquisition.

A client sends its stored partition log epoch on every round. A differing stored epoch resets the replica: the server answers with a header-only response that carries the current epoch and `resetRequired: true`. The client clears server rows, subscription cursors, bootstrap state, and downloaded segment metadata. It keeps the client ID, subscriptions, local-only tables, and the durable outbox. The next rounds bootstrap the current server state and replay pending outbox commits against it.

The reset stops a cursor from the abandoned timeline from crossing the restore boundary. It also preserves offline writes made before the client learned about the restore. Every durable replica resets exactly once per rotation, with no manual step.

### Verification drill

Test restores with two client snapshots:

- `behind`: last synchronized before the backup recovery point.
- `ahead`: synchronized after the backup and holding an additional offline outbox write.

Restore the backup and rotate the partition epoch. Both clients must receive a reset before any push or pull work. The `ahead` client loses server rows that existed only after the recovery point, keeps its offline outbox write, replays it, and converges with a newly created client. The conformance catalog runs this sequence against the TypeScript and Rust clients.

Record the backup identifier, restored partition list, old and new epoch values, restore time, and verification result in the operator log. Leave row contents, authorization headers, and blob payloads out of it.

## Load testing

The repo ships a Bun-native load suite with few dependencies: one real server process, N protocol-level virtual clients over the real wire, and pass or fail thresholds (zero protocol errors, p95 ceilings, a peak-RSS ceiling).

```sh title="terminal"
bun run load bootstrap-storm          # the scale scenario: 50 VUs / 100k rows
bun run load:smoke                    # tiny smoke profile of every scenario
SYNCULAR_PG_URL=postgres://… bun run load bootstrap-storm  # Postgres lane
```

The scenarios are `push-pull`, `bootstrap-storm`, `reconnect-storm`, `maintenance-churn`, and `mixed-soak`. `bootstrap-storm` asserts from the event stream that segment reuse beats segment build under a storm. The scenarios are documented in [load/README.md](https://github.com/syncular/syncular/blob/main/load/README.md).
