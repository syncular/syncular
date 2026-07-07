# Operations

Day-two concerns for a running sync server: the structured-events seam,
the admin console, commit-log pruning, blob GC, and the load-test suite.
Everything here is host-scheduled and opt-in — the server automates none
of it behind your back.

## Structured events

One optional interface, `SyncularServerEvents`, carries every
operator-relevant signal as a typed, JSON-able, stable-shaped event —
request, push, pull, segment, blob, realtime, prune, and resolver
signals. It never throws through (emission is fire-and-forget), costs
nothing when unset (no event object is built without a sink), and reads
the ctx clock so tests under a virtual clock stay deterministic.

`consoleJsonEvents()` is the reference sink — one JSON line per event on
stdout. `RingBufferEvents` retains the last N events in memory with a
`query({ type?, sinceMs?, limit })` — the event stream without any
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

The sink rides on `SyncServerConfig`, so adapters pass it through with no
extra wiring; the realtime hub and `pruneCommitLog` take the same sink via
their own options. There is no logger dependency — a Sentry or metrics
adapter is a ~20-line `emit` implementation. The full event catalog
(`request.handled`, `push.applied` / `push.rejected` / `push.conflicted`,
`pull.served`, `segment.downloaded`, `blob.swept`, `realtime.*`,
`prune.completed`, `scopes.resolve_failed`) is in the
[server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md).

## The admin console

`SyncularAdmin` is a read-only, partition-scoped query surface over server
storage plus the event ring: clients and their cursors, commit metadata
(never payloads), per-row version and scopes, scope activity, horizon
status, segment/blob stats, and the event tail.

```ts
import { SyncularAdmin } from '@syncular/server';
import { createSyncularAdminRoutes } from '@syncular/server-hono';

const admin = SyncularAdmin.fromConfig(config, { ring });
const routes = createSyncularAdminRoutes(admin, {
  defaultPartition: 'main',
  authorize: ({ request }) => isOperator(request), // YOUR check — mandatory
});
app.route('/admin', routes);
```

**The auth seam is required**: the factory throws if you omit `authorize` —
there is no default-open admin. Every endpoint runs the guard first; a
falsy result is a 401. `GET /admin` serves a single static HTML page (no
framework, no build step) that polls the sibling JSON endpoints and
renders horizon, store stats, clients, recent commits, and the event tail
with a 2 s auto-refresh — ~300 lines by design, replacing what used to be
a full console app.
S3-backed stats are labeled `approximate` honestly; a storage backend that
omits an optional admin method fails loud rather than rendering a
silently-empty console.

## Commit-log pruning

The commit log grows until you prune it. `pruneCommitLog` advances the
per-partition horizon and deletes commits at or below it — nothing prunes
automatically; you schedule it (hourly to daily is the sensible range, and
a pass with nothing to do is cheap).

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
Defaults are battle-tested production values — raise them freely, lower them with
care.

A client whose cursor fell behind the horizon gets a reset and
re-bootstraps from scratch. That is correct behavior, not an error — but
its *rate* is your pruning health signal: a steady trickle is devices
returning from long absences; a spike means you pruned faster than your
fleet syncs and are paying for it in bootstrap load. Observe it via
`pull.served` subscriptions with `status: "reset"`.

## Blob GC (`sweepOrphanBlobs`)

Blobs are durable, so reclamation is reference-driven, not time-driven —
the blob analogue of `pruneCommitLog`, scheduled by you:

```ts
import { sweepOrphanBlobs } from '@syncular/server';

const { swept } = await sweepOrphanBlobs(storage, blobs, partition, {
  graceMs: 24 * 60 * 60 * 1000, // default
  events,                        // emits blob.swept
});
```

It reads the live keep-set from the storage reference index and deletes
only blobs that are **both** unreferenced **and** older than the grace
period. **The grace period is the correctness mechanism**: clients upload
bytes before pushing the row that references them, so a fresh upload is
legitimately unreferenced until its push lands. The 24 h default is
deliberately far above any push window; lower it only if you fully
understand your clients' outbox latency — there is no upside to a tight
grace and a real data-loss risk. The helper throws against a storage
without the reference index rather than sweeping with an empty keep-set.

## Load testing

The repo ships a bun-native, dependency-light load suite — one real server
process, N protocol-level virtual clients over the real wire, pass/fail
thresholds (zero protocol errors, p95 ceilings, a peak-RSS ceiling), not a
leaderboard:

```sh
bun run load bootstrap-storm          # the scale scenario: 50 VUs / 100k rows
bun run load:smoke                    # tiny smoke profile of every scenario
SYNCULAR_PG_URL=postgres://… bun run load bootstrap-storm  # Postgres lane
```

Scenarios: `push-pull`, `bootstrap-storm`, `reconnect-storm`,
`maintenance-churn`, `mixed-soak`. `bootstrap-storm` is the headline — it
asserts, via the events seam, that segment *reuse* beats *build* under a
storm. Full docs in
[load/README.md](https://github.com/syncular/syncular/blob/main/load/README.md).

## Telemetry: what to alert on

- `push.rejected` rate by `code` — a rising `sync.forbidden` share usually
  means an authorization regression, not misbehaving clients.
  (`push.conflicted` is normal offline-first traffic.)
- `scopes.resolve_failed` — any nonzero rate. This is the fail-loud path;
  it is almost always a host bug or a dead dependency of your resolver.
- `request.handled` with `outcome: "error"` and `errorCode: "internal"` —
  storage failures surfacing mid-stream.
- Reset rate (`pull.served` with `status: "reset"`) — alert on spikes
  relative to fleet size; see pruning above.
- `prune.completed` with `advanced: false` for many consecutive passes
  while the log grows — one laggard cursor inside the active window is
  pinning retention; the floors bound the damage to `ageForceMs`.
- `realtime.wake` with `reason: "delta-too-large"` — sustained occurrences
  mean commits routinely exceed the delta limit and clients fall back to
  HTTP pulls; raise the limit or shrink commits.

## Where to go next

- [Server setup](/guide-server/) — where the config these tools ride on is
  wired.
- [Storage backends](/server-storage/) — segment TTLs and blob durability,
  the policies pruning and GC interact with.
- [Cloudflare Workers](/server-workers/) — running the sweep from a cron
  trigger.
