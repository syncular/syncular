# RFC 0001 — The admin console: teletype restyle and the ops rework

- **Status:** Partially landed — Part 1 and Part 2 items 1–4 shipped;
  items 5–6 remain proposed (5 is decision-gated, 6 needs a design pass)
- **Date:** 2026-07-13
- **Scope:** `packages/server/src/admin.ts`, `packages/server-hono/src/admin.ts`,
  `packages/server-hono/src/admin-page.ts`, `docs/DESIGN.md`

## Summary

Syncular ships an embedded admin console: a read-only query layer
(`SyncularAdmin`) plus a single static HTML page mounted behind a
mandatory host `authorize` guard. This RFC covers two things. First, the
**style refactor** (landed): the console now follows the teletype design
system documented in `docs/DESIGN.md`, and the page exposes the full
existing read API. Second, the **ops rework**: six additions, ordered by
value per effort, that turn the console from a gauge into a cockpit — and
into a headline value prop for Syncular. Items 1–4 (lag + drill-down,
metrics statusbar, SSE tail, fleet view) have landed; items 5–6 (operator
actions, table browser) remain proposed.

## Background

Offline-sync engines are opaque in production. The questions that kill
adoption are operational: *why is this client stale*, *why did this
write vanish*, *is it safe to prune*. A console that ships inside the
server package, mounts in one line, and answers those questions is a
real differentiator against the rest of the sync-engine field.

What exists today (all read-only, auth-mandatory; partition-scoped except
the fleet view):

| Surface | Route | Backing |
| --- | --- | --- |
| Clients (cursor, lag, last-seen, subscriptions, active flag) | `GET /clients` | `storage.listClientRecords` |
| Client drill-down (record + lease + event slice) | `GET /clients/:clientId` | `admin.clientDetail` (item 1) |
| Commit metadata (`?afterSeq`, `?limit`, `?table`) | `GET /commits` | `storage.listCommitMetadata` |
| Row inspection (version, scopes, blob refs; payload undecoded) | `GET /rows/:table/:rowId` | `storage.getRowScopes` |
| Scope activity (index-driven, never a scan) | `GET /scope-activity` | `storage.scopeActivity` |
| Horizon health + prune recommendation | `GET /horizon` | cursor floor / retention math (§4.6) |
| Segment + blob store counters | `GET /stats` | store `stats()` (`approximate` marker) |
| Request/push metrics + sparkline buckets | `GET /metrics` | ring aggregation (item 2) |
| Fleet view (per-partition health, one call) | `GET /partitions` | `storage.listPartitions` (item 4) |
| Event tail (`?type`, `?sinceMs`, `?clientId`, `?actorId`, `?limit`) | `GET /events` | `RingBufferEvents` (default 1000) |
| Live event tail (SSE: backlog replay, then push) | `GET /events/stream` | `RingBufferEvents.subscribe` (item 3) |

The event seam (`packages/server/src/events.ts`) already emits 17
structured event types — `request.handled` (with `durationMs`,
`bytesIn`/`bytesOut`, `outcome`), `push.applied` / `rejected` /
`conflicted`, `pull.served`, segment/blob traffic, realtime lifecycle,
`prune.completed`, `scopes.resolve_failed`, lease issue/revoke. Most of
the proposal below is derivable from data the server already produces.

## Part 1 — the style refactor (landed)

### The design system

`docs/DESIGN.md` now pins the teletype theme, extracted from the site
stylesheet (`apps/docs/public/style.css`, the canonical
implementation): pure black `--void`, warm paper `--ink #f4efe4`, the
`--dim`/`--faint` muted tiers, one amber accent `#ffb000`, `--panel
#0a0908`, the universal `1px solid` border, zero radius, zero shadows,
IBM Plex Mono everywhere, UPPERCASE tracked headings, inverse-video
hover, `[ BRACKETED ]` labels, blinking `_`, ASCII rules, corner-tick
`+` glyphs, `END OF TRANSMISSION ■`.

### The console restyle

`ADMIN_CONSOLE_HTML` was rewritten against that system. Constraints
preserved:

- one exported string, zero framework, no build step;
- serves identically on Bun, Node, and Workers (no filesystem read);
- all fetches same-origin and mount-relative, so the host's `authorize`
  guard covers the page's own XHRs;
- system mono fallback stack (the page ships self-contained, so it
  carries no webfont assets);
- the existing test anchors (`Syncular console` title, doctype) hold.

The restyle also closed the gap between the page and the API it sits
on. The page now covers the **whole** read surface:

- **Row inspector panel** — `GET /rows/:table/:rowId` had no UI before;
  now a table/rowId form renders exists, `server_version`, stored
  scopes, and blob refs.
- **Scope activity panel** — `GET /scope-activity` had no UI before;
  now a variable/value form renders the recent commits touching that
  scope key.
- **Commits table filter** and **event type filter** — the routes
  already accepted `?table=` and `?type=`; the page now passes them.

Verified end-to-end against the demo server (`SYNCULAR_DEMO_ADMIN=1`):
all seven panels render live data; inspector round-trips both an
existing row (`todos/seed-1` → version 1, `{"list_id":"demo"}`) and a
missing one; scope query `list_id=demo` returns the seed commit; 14/14
admin tests, typecheck, and lint pass.

## Part 2 — the ops rework

Six additions, ordered by value per effort. Items 1–4 are landed; their
sections record the decisions taken.

### 1. Cursor lag + client drill-down (landed)

A `lag` field on `AdminClient` (`maxCommitSeq − max(cursor, 0)`, computed
server-side in `listClients`) and a per-client drill-down: `GET
/clients/:clientId` → `admin.clientDetail`, returning the record with lag,
the client's §7.3 lease when a lease store is wired (`SyncularAdmin` takes
an optional `leases`, picked up from `config.leases.store` by
`fromConfig`), and the client's slice of the event tail. The page renders
the lag column and opens the drill-down on row click. This directly
answers *why is this client stale* — the #1 support question for any sync
engine.

- Ring filtering landed as `clientId`/`actorId` fields on
  `RingEventQuery`, matched in `RingBufferEvents.query` via the shared
  `matchesRingQuery` predicate (open question 2: resolved in the ring, so
  the polled tail, the drill-down, and the SSE stream share one rule).

### 2. Derived metrics statusbar (landed)

A top strip in the console — `PUSH 12/min · CONFLICTS 0 · ERR 0.2% ·
P95 34ms` — plus an ASCII sparkline (`▁▂▃▅▇`) for the trailing window.
Landed server-side as `admin.metrics(partition, {windowMs?, buckets?})` +
`GET /metrics`: derived entirely from the ring's `request.handled` /
`push.*` events (zero new server state), windowed with per-bucket counts
so the page only renders.

### 3. Live event tail over SSE (landed)

`GET /events/stream` streams the ring as server-sent events: backlog
replay first, then live events via the new `RingBufferEvents.subscribe`
hook (`admin.subscribeEvents`), heartbeat comments every 5 s (under
Bun.serve's 10 s default idle timeout). Plain
web-streams — serves identically on Bun, Node, and Workers. The page
upgrades the event panel to the stream when the ring is wired and falls
back to the 2-second poll otherwise. The live tail is also the best demo
asset Syncular has — an embedded live console on syncular.app would sell
the engine better than copy.

### 4. Partition discovery / fleet view (landed)

`storage.listPartitions()` landed as the optional admin-surface method on
all three backends — derived as the union of the existing
`sync_partitions` registry and `sync_clients` partitions, no new table
(open question 3: the registry already existed). `admin.listPartitions()`
+ `admin.partitionsOverview()` + `GET /partitions` return one row per
partition with retained backlog, known/active client counts, and the
prune recommendation in a single call (open question 4: server-side
fan-in, so the page issues one request). The page's fleet panel doubles
as the partition picker (row click + datalist on the partition input).

### 5. Guarded operator actions

Everything is read-only today, yet the horizon panel says
`[ PRUNE RECOMMENDED ]` and the operator then has to write code to act.
The server already implements the actions:

| Action | Existing API | Console affordance |
| --- | --- | --- |
| Advance the horizon | `pruneCommitLog` (`prune.ts`) | `[ RUN PRUNE ]` on the horizon panel |
| Revoke a lease | lease store (§7.3) | `[ REVOKE ]` in the client drill-down |
| Sweep orphan blobs | `sweepOrphanBlobs` (§5.9) | `[ SWEEP BLOBS ]` on store stats |

Expose them as POST routes behind the same `authorize` guard, with an
explicit inverse-video confirm step in the page. Add a
`readOnly: true` option on `createSyncularAdminRoutes` so cautious
hosts keep the current posture; the guard gains the method/route in its
context so hosts can authorize reads and actions differently.

This is the single biggest capability jump: the console goes from gauge
to cockpit.

- Effort: M. Requires the security section below.

### 6. Table browser (the big one)

The server materializes relational tables
(`DESIGN-relational-server-storage.md`), so a paged per-table browser
is feasible: rowId, `server_version`, scopes, blob refs, with
scope-key filtering. Payloads stay undecoded by default (the current
privacy stance: the console shows metadata only); an opt-in
schema-decode toggle is a host decision (`decodePayloads: true`), since
`SyncularAdmin` already holds the schema.

- New surface: `storage.listRows(partition, table, {afterRowId, limit,
  scopeFilter})` per backend + route + panel.
- Effort: L. Worth its own design pass before building.

### Sequencing

1. **Landed:** teletype restyle; full read surface exposed.
2. **Landed:** items 1–2 — lag column, drill-down, metrics statusbar.
3. **Landed:** items 3–4 — SSE tail, fleet view.
4. **Decision-gated:** item 5 — mutating admin routes (Benjamin call:
   default posture, `readOnly` flag semantics).
5. **Design pass first:** item 6 — table browser + payload decode.

## Security considerations

- The mandatory `authorize` guard stays the foundation; nothing here
  weakens the refuse-to-mount-open construction.
- Mutating routes (item 5) escalate the console from privileged-read to
  privileged-write. Mitigations: POST-only, `readOnly` opt-out, richer
  guard context (route + method) so hosts can split read/write
  authorization, and confirm steps in the page. Actions should emit
  ring events (`prune.completed` already exists; lease revoke and blob
  sweep already have event types) so every operator action lands in the
  audit tail.
- Payload decode (item 6) moves user data into the console. Default
  stays metadata-only; decode is an explicit host opt-in and should be
  called out in the server README's admin section.
- The event tail can carry sensitive identifiers (actorIds, session
  ids). That is already true today; SSE (item 3) widens the pipe, so
  the server README notes that admin authorization gates the stream the
  same as the polled tail.
- The fleet view (item 4) is the one cross-partition read. The guard
  still runs on `GET /partitions`, with an empty `partition` in its
  context — documented in the README so hosts that authorize per
  partition treat it deliberately.

## Open questions

Questions 2–4 were resolved by the item 1–4 implementation (decisions
recorded in the item sections above). Still open:

1. Item 5's default posture: should mutating routes require a second
   explicit flag (`actions: true`) on top of `authorize`, mirroring the
   refuse-to-mount-open principle?
2. Client devtools (`docs/TODO.md` §3) share the panel language and the
   design system — should the console page factor its CSS into a shared
   snippet then, or stay fully self-contained per surface?
