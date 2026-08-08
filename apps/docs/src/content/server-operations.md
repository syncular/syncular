# Operations and maintenance

Day-two concerns for a running sync server: the structured-events hook,
the admin console, commit-log pruning, reaction retention, blob GC, and the
load-test suite. Everything here is host-scheduled and opt-in.

Application-level domain actions use immutable
[domain event rows](/guide-domain-events/). Registered application queries and
commands use [remote server operations](/guide-remote-operations/).
`SyncularServerEvents` below remains operational telemetry.

## Structured events

One optional interface, `SyncularServerEvents`, carries every
operator-relevant signal as a typed, JSON-able, stable-shaped event:
request, push, pull, segment, blob, realtime, prune, and resolver
signals. It never throws through (emission is fire-and-forget), costs
nothing when unset (no event object is built without a sink), and reads
the ctx clock so tests under a virtual clock stay deterministic.

`consoleJsonEvents()` is the reference sink: one JSON line per event on
stdout. `RingBufferEvents` retains the last N events in memory with a
`query({ type?, sinceMs?, limit })`, giving you the event stream without any
infrastructure. `composeEvents` fans one emission to several sinks:

```ts
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

The sink is part of `SyncServerConfig`, so adapters pass it through with no
extra wiring; the realtime hub and `pruneCommitLog` take the same sink via
their own options. There is no logger dependency: a Sentry or metrics
adapter is a ~20-line `emit` implementation. The full event catalog
(`request.handled`, `push.applied` / `push.rejected` / `push.conflicted`,
`pull.served`, `segment.downloaded`, `blob.swept`, `reaction.*`, `realtime.*`,
`prune.completed`, `scopes.resolve_failed`) is in the
[server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md).
Reaction lifecycle meanings and the durable state machine are covered in
[Durable server reactions](/server-reactions/#observe-and-inspect-reactions).

## The admin console

`SyncularAdmin` is a read-only, partition-scoped query surface over server
storage plus the event ring: clients and their cursors, commit metadata
(never payloads), per-row version and scopes, scope activity, horizon
status, durable reactions, segment/blob stats, and the event tail. Reaction
reads include their persisted payload and failure details, so admin access is
application-data access.

```ts
import { SyncularAdmin } from '@syncular/server';
import { createSyncularAdminRoutes } from '@syncular/server-hono';

const admin = SyncularAdmin.fromConfig(config, { ring });
const routes = createSyncularAdminRoutes(admin, {
  defaultPartition: 'main',
  authorize: ({ request }) => isOperator(request), // YOUR check (mandatory)
});
app.route('/admin', routes);
```

**Authorization is mandatory**: the factory throws if you omit `authorize`;
there is no default-open admin. Every endpoint runs the guard first; a
falsy result is a 401. `GET /admin` serves a single static HTML page, built
without a framework or a build step, that polls the sibling JSON endpoints
and renders horizon, store stats, clients, recent commits, and the event
tail with a 2 s auto-refresh, at about 300 lines by design.
S3-backed stats are labeled `approximate` since S3 does not report exact
counts cheaply; a storage backend that omits an optional admin method
raises an error rather than rendering a silently-empty console.

## Commit-log pruning

The commit log grows until you prune it. `pruneCommitLog` advances the
per-partition horizon and deletes commits at or below it. Nothing prunes
automatically; you schedule it (hourly to daily is the sensible range, and
a pass with nothing to do is cheap).

Reaction rows use a separate table. Commit-log pruning does not delete pending,
leased, completed, or dead-lettered reactions. Use the separate reaction
retention pass below.

```ts
import { pruneCommitLog } from '@syncular/server';

await pruneCommitLog({
  storage,
  partition: 'main',
  nowMs: Date.now(),
  events, // emits prune.completed per pass
});
```

The retention floors (`RetentionPolicy`): the horizon never advances past
`min(cursor)` of clients active within `activeWindowMs` (default 14 days);
commits older than `ageForceMs` (default 30 days) may be pruned regardless;
and the newest `minRetainedCommits` (default 1000) are always kept.
The defaults are conservative; lowering them risks more client resets.

A client whose cursor fell behind the horizon gets a reset and
re-bootstraps from scratch. This is expected behavior, and its rate is
your pruning health signal: a steady trickle is devices returning from
long absences; a spike means you pruned faster than your fleet syncs and
are paying for it in bootstrap load. Observe it via
`pull.served` subscriptions with `status: "reset"`.

## Reaction retention

The host schedules `pruneReactions` per partition, alongside commit-log
pruning. Defaults retain completed records for 30 days, dead-lettered records
for 90 days, and remove at most 1,000 records in one pass.

```ts
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

Only terminal records older than their cutoff are eligible. Pending and leased
records are preserved, including expired leases that a worker can reclaim.
Dead-letter retention determines how long operators can inspect and manually
retry a failed record. Configure a longer duration when failure investigation
or retry procedures require it.

Each bounded pass emits `reaction.prune_completed`. A full batch reports
`mayHaveMore: true`; repeat until false. Timestamp indexes support both age
filters, and the delete limit keeps a maintenance pass from monopolizing the
storage writer. The full lifecycle and retention API are in
[Durable server reactions](/server-reactions/).

## Blob GC (`sweepOrphanBlobs`)

Blobs are durable, so reclamation tracks live references on a schedule you
control: the blob analogue of `pruneCommitLog`.

```ts
import { sweepOrphanBlobs } from '@syncular/server';

const { swept } = await sweepOrphanBlobs(storage, blobs, partition, {
  graceMs: 24 * 60 * 60 * 1000, // default
  events,                        // emits blob.swept
});
```

It reads the live keep-set from the storage reference index and deletes
only blobs that are **both** unreferenced **and** older than the grace
period. Clients upload bytes before pushing the row that references
them, so a fresh upload is legitimately unreferenced until its push
lands; the grace period covers that gap. The 24 h default sits
deliberately far above any push window; lower it only if you fully
understand your clients' outbox latency, since a grace period that is too
tight risks deleting blobs that are still needed. The helper throws
against a storage without the reference index rather than sweeping with
an empty keep-set.

## Load testing

The repo ships a bun-native, dependency-light load suite: one real server
process, N protocol-level virtual clients over the real wire, and
pass/fail thresholds (zero protocol errors, p95 ceilings, a peak-RSS
ceiling) that measure whether the system holds up under load:

```sh
bun run load bootstrap-storm          # the scale scenario: 50 VUs / 100k rows
bun run load:smoke                    # tiny smoke profile of every scenario
SYNCULAR_PG_URL=postgres://… bun run load bootstrap-storm  # Postgres lane
```

Scenarios: `push-pull`, `bootstrap-storm`, `reconnect-storm`,
`maintenance-churn`, `mixed-soak`. `bootstrap-storm` asserts, using the
event stream, that segment *reuse* beats *build* under a storm. Full docs in
[load/README.md](https://github.com/syncular/syncular/blob/main/load/README.md).

## Telemetry: what to alert on

- `push.rejected` rate by `code`: a rising `sync.forbidden` share usually
  points to an authorization regression on your side, worth checking
  before you suspect misbehaving clients. (`push.conflicted` is normal
  offline-first traffic.)
- `scopes.resolve_failed`: alert on any nonzero rate. This is the
  fail-loud path; it is almost always a host bug or a dead dependency of
  your resolver.
- `request.handled` with `outcome: "error"` and `errorCode: "internal"`:
  storage failures surfacing mid-stream.
- Reset rate (`pull.served` with `status: "reset"`): alert on spikes
  relative to fleet size; see pruning above.
- `prune.completed` with `advanced: false` for many consecutive passes
  while the log grows: one laggard cursor inside the active window is
  pinning retention; the floors bound the damage to `ageForceMs`.
- `reaction.prune_completed` with `mayHaveMore: true` after every scheduled
  batch: terminal rows are accumulating faster than the cleanup schedule
  removes them. Raise the batch count or run passes more often.
- `realtime.wake` with `reason: "delta-too-large"`: sustained occurrences
  mean commits routinely exceed the delta limit and clients fall back to
  HTTP pulls; raise the limit or shrink commits.

## Where to go next

- [Server setup](/guide-server/): where the config for these tools is
  wired.
- [Storage backends](/server-storage/): segment TTLs and blob durability,
  the policies pruning and GC interact with.
- [Cloudflare Workers](/server-workers/): running the sweep from a cron
  trigger.
- [Domain actions and event rows](/guide-domain-events/): durable application
  intent stored with domain writes.
- [Remote server operations](/guide-remote-operations/): database-less typed
  queries, commands, and live watches.
