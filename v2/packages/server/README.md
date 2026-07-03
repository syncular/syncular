# @syncular-v2/server

Framework-free embeddable SSP2 protocol library. Core surface:
`handleSyncRequest(bytes, ctx) → bytes` over host-provided storage /
scope-resolution / segment-store interfaces, plus the transport-agnostic
realtime hub (§8), the direct segment download handler (§5.5), commit-log
pruning (§4.6), and signed-URL token issuance (§5.4). `SPEC.md` is
normative for everything on the wire; this README covers the **host
surface** — in particular the ops seam and the pruning runbook.

## Structured events (the ops seam)

One optional interface, `SyncularServerEvents`, carries every
operator-relevant signal as a typed, JSON-able, stable-shaped event:

```ts
import { consoleJsonEvents, type SyncServerConfig } from '@syncular-v2/server';

const config: SyncServerConfig = {
  schema, storage, segments, resolveScopes,
  events: consoleJsonEvents(),          // one JSON line per event on stdout
};
```

There is no logger dependency and no formatting — emission only. The same
shapes feed one-line JSON logs, metrics counters, and error trackers; a
Sentry adapter is a ~20-line `emit` implementation over this seam. The
events sink rides on `SyncServerConfig`, so the Hono adapter (and any
other adapter that spreads the config into the request context) passes it
through with no extra wiring. The realtime hub and `pruneCommitLog` take
the same sink via their own config/options (they run outside the request
context). The demo server wires it behind `SYNCULAR_DEMO_EVENTS=1`.

### Guarantees

- **Never throws through.** Emission is fire-and-forget: a throwing
  `emit` is swallowed at the seam and cannot affect request processing,
  realtime delivery, or pruning. (Tested.)
- **Zero cost when off.** With no sink configured, no event object is
  ever built — every call site checks the sink before constructing the
  event. The benches run with events unset.
- **Stable, JSON-able shapes.** Flat objects, no `undefined` values, no
  classes; `JSON.stringify` round-trips every event. Shapes and `type`
  strings are append-only surface.
- **Virtual-clock clean.** All timestamps and durations come from the ctx
  clock (`clock` on the config / hub; `nowMs` for prune), so conformance
  and tests under a virtual clock stay deterministic. Wall clock is never
  read behind the host's back.

### Event catalog

| Event | When | Key fields |
| --- | --- | --- |
| `request.handled` | Once per `POST /sync`, after the response bytes are fully produced (or the request was rejected up front) | `kind` (`sync`), `partition`, `actorId`, `durationMs`, `bytesIn`, `bytesOut`, `outcome` (`ok` \| `schema_floor` \| `rejected` \| `error`), `errorCode?`, `pushCommits`, `pulled`, `subscriptions` |
| `push.applied` | A `PUSH_COMMIT` applied, or replayed from the idempotency cache (§2.3) | `clientId`, `clientCommitId`, `operations`, `commitSeq?`, `replay` |
| `push.rejected` | A commit rejected (§6.3) | `clientId`, `clientCommitId`, `operations`, `code` (§10.2), `opIndex` |
| `push.conflicted` | A commit terminated by a version conflict (§6.2) | `clientId`, `clientCommitId`, `operations`, `opIndex` |
| `pull.served` | Once per served pull half, after all sections streamed | `clientId`, `subscriptions[]`: `{id, table, status, mode` (`bootstrap` \| `incremental` \| `none`)`, fromCursor, nextCursor, commits, changes, segments[]}`; each segment: `{mediaType` (`rows` \| `sqlite`)`, delivery` (`inline` \| `ref`)`, origin` (`built` \| `reused`)`, bytes, rows}` |
| `segment.downloaded` | Every direct segment download (§5.5), success or failure | `segmentId`, `outcome` (`ok` \| `error`), `errorCode?`, `mediaType?`, `bytes?`, `durationMs` |
| `realtime.opened` | A socket registered with the hub and got `hello` (§8.1) | `sessionId`, `clientId`, `registrations`, `cursor`, `latestSeq` |
| `realtime.closed` | A session left the hub (once per session) | `sessionId`, `durationMs` |
| `realtime.delta` | A delta message pushed over the socket (§8.2) | `sessionId`, `commitSeq`, `bytes`, `changes` |
| `realtime.wake` | A `sync` wake-up sent (§8.3) | `sessionId`, `reason` (`catchup-required` \| `delta-too-large` \| `reset-required`) |
| `prune.completed` | Every `pruneCommitLog` pass, moved or not | `partition`, `previousHorizonSeq`, `horizonSeq`, `advanced`, `removedCommits` |
| `scopes.resolve_failed` | The host `resolveScopes` callback threw — the §3.2/§3.4 fail-loud path | `phase` (`request` \| `realtime` \| `segment-download`), `message` |

All events also carry `type`, `atMs`, and (where a request identity
exists) `partition` / `actorId`.

## Horizon & pruning: operational guidance

The commit log grows forever unless you prune it. `pruneCommitLog`
(SPEC §4.6) advances the per-partition `horizonSeq` and deletes commits
at or below it. Nothing prunes automatically — the host schedules it.

**When to run.** A periodic job per partition — hourly to daily is the
sensible range; there is no benefit below the granularity of your
`activeWindowMs`. Prune is cheap when there is nothing to do (one cursor
scan + two point reads), so err on the side of running it often rather
than letting a backlog build. Pass `events` to get `prune.completed`
per pass.

**The retention floors (§4.6, encoded in `RetentionPolicy`).** The
horizon never advances past `min(cursor)` of *active* clients — clients
whose cursor record was touched within `activeWindowMs` (default 14
days). Two escape hatches keep laggards from pinning the log forever:
commits older than `ageForceMs` (default 30 days) may be pruned
regardless, and at least the newest `minRetainedCommits` (default 1000)
commits are always kept. Defaults are the v1 production values; raise
them freely, lower them with care.

**What `sync.cursor_expired` means operationally.** A client whose
cursor fell behind the horizon gets `SUB_START.status = reset` and
re-bootstraps from scratch (§4.7). That is correct behavior, not an
error — but its *rate* is your pruning health signal. A steady trickle
means devices returning from >30-day absences (expected). A spike means
you pruned faster than your fleet syncs: `ageForceMs` or
`activeWindowMs` is too tight for real usage, and you are paying for it
in bootstrap load (full re-scans + segment builds), not just in resets.
Observe it via `pull.served` subscriptions with `status: "reset"`.

**Segment TTL interplay.** Segments are cache entries, not durable state
(§5.1; default TTL 24 h). A bootstrap that resumes past segment expiry
answers `sync.segment_expired` and the client re-pulls for fresh
descriptors — again correct, again a cost signal. Keep the segment TTL
comfortably longer than the slowest plausible bootstrap (a multi-page
bootstrap must finish while its segments live), and note that pruning
and segment expiry compound: a reset storm triggers a bootstrap storm,
which the §5.3 image-reuse rule absorbs only while images stay
unexpired. If you see `origin: "built"` dominating `"reused"` for the
same table+scope during a storm, your TTL is shorter than the storm.

**What to alert on.**

- `push.rejected` rate, by `code` — a rising `sync.forbidden` share
  usually means an authorization regression, not misbehaving clients.
  (`push.conflicted` is normal offline-first traffic; alert only on
  gross shifts.)
- `scopes.resolve_failed` — any nonzero rate. This is the fail-loud
  path: every occurrence revokes subscriptions or rejects writes for a
  real request, and it is almost always a host bug or a dead dependency
  of the resolver.
- `request.handled` with `outcome: "error"` and `errorCode: "internal"`
  — storage failures surfacing mid-stream.
- Reset rate (`pull.served` → `status: "reset"`) — see above; alert on
  spikes relative to fleet size.
- Prune backlog: `prune.completed` with `advanced: false` for many
  consecutive passes *while the log grows* means one laggard cursor
  inside the active window is pinning retention — inspect
  `listClientCursors` for the offender; the §4.6 floors bound the damage
  to `ageForceMs`.
- `realtime.wake` with `reason: "delta-too-large"` — sustained
  occurrences mean commits routinely exceed `maxDeltaBytes` and clients
  are falling back to HTTP pulls; raise the limit or shrink commits.
