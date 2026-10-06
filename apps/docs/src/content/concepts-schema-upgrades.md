# Schema upgrades

When your schema changes, you bump `schemaVersions` in the manifest and
regenerate. There is no client-side migration engine (SPEC §7.4): a client
does not transform its local tables from one version to the next. On a
version change it keeps the outbox, wipes its local tables, re-bootstraps at
the new version, and replays the outbox on top. Bootstrap from a SQLite-image
segment runs at millions of rows per second on the image lane, so the reset
is a background download rather than a migration pass.

Authoring the change (migrations, the lock, backfills) is
[Schema & typegen](/guide-schema/).

## What triggers the flow

Two triggers converge on the same wipe-re-bootstrap-replay:

1. **Boot-time version increase.** The client persists a **local schema-version
   marker** in its database. When you ship new code with a new generated
   schema, the client boots on top of the old local tables, reads a marker
   lower than the generated version, and runs the reset before its first
   sync round; no server involvement is needed.
2. **Server schema floor.** A running client whose generated schema is behind
   the server receives `requiredSchemaVersion` (SPEC §1.6) and stops, surfacing
   the upgrade requirement (`schemaFloor` / `stopped`). It does not reset on
   the floor alone: resetting while still generating old payloads would only
   hit the floor again. When the app updates to a new generated schema, the
   boot-time trigger fires and the two paths converge.

Every replica open and recreation reads the persisted schema-version marker
before changing bookkeeping, local tables, or previous-version context. The
marker guard and every write it authorizes run in one transaction, so a
concurrent open that upgrades the replica while this one starts refuses the
stale attempt instead of recreating an older schema. A v2
build opening a v3 replica fails with the non-retryable typed error
`client.schema_downgrade`. The replica and queued v3 writes remain intact;
reopen them with a compatible build. TypeScript error details contain
`persistedVersion` and `requestedVersion`; native command errors expose the same
static code.

An unreadable or corrupt marker fails with `sync.local_corrupt`, and so does a
metadata table carrying more than one marker row: the client never resolves
the ambiguity by picking a row. A generated schema version outside the marker's
range (1 through 2147483647) is refused with `sync.invalid_request` before the
replica is created or opened, and a refused open leaves the replica's journal
mode and contents untouched. The client accepts an absent metadata table or
marker for fresh and legacy replicas.
Equal versions keep ordinary startup behavior, and version increases keep the
wipe-re-bootstrap-replay flow. Discarding previous-version context does not
permit a schema downgrade. Older binaries that predate this guard retain their
historical reset behavior.

The server keeps N-version codec support for transition windows if it chooses;
the reference server serves its configured window and answers the floor for
versions outside it. Without a window it serves only its current version.

## What the reset touches

The reset touches the whole local database except three things:

| Preserved | Wiped & rebuilt |
| --- | --- |
| the outbox (schema-agnostic by design, §0/§7.1) | every synced table, secondary index, and FTS projection |
| the client identity (`clientId`) | subscription cursors, resume tokens, effective-scope state |
| the auth lease (`leaseState`) | incompatible registrations and their window bookkeeping |

Subscription registrations survive a bump when their table and requested scope
variables still exist and each variable keeps its pattern prefix and mapped
column. The client drops incompatible registrations and their window and eviction
bookkeeping before its first sync. The app registers its current subscriptions
again; the client never translates stored scope values. For example, changing
`calendar:{theatre_calendar_id}` to `calendar:{calendar_theatre_id}` removes
registrations using the old variable.

A compatible registration resets its cursor to `-1` because the bump wipes the
local rows and requires a fresh bootstrap. Reopening the same schema version
preserves its cursor. Replicas opened by versions before 0.30.11 have no stored
scope declaration evidence; their next bump requires re-registration even when
variable names match.

The outbox replays on top of the fresh bootstrap. Outbox entries are stored
in schema-agnostic form and encoded at send time with the current codec
(§0), so a commit written under version N pushes under N+1 by re-encoding.
The server never accepts a retired encoding, and pending offline writes stay
visible across the bump.

## Dropped columns and tables

Re-encoding fails when a pending commit references a column or table the new
schema no longer has: the value or operation has nowhere to go. This surfaces
as a rejection with the client-local code
`sync.outbox_incompatible` (§7.4.4). The un-encodable commit leaves the outbox
and its purely-optimistic rows are undone, exactly like a server rejection.
Later outbox commits that *do* encode keep replaying, so the queue keeps
moving past the one incompatible commit.

## What the app sees

A small, queryable `upgrading` client state is `true` from the moment the reset
begins until the first post-reset bootstrap round reaches idle. That is the
app's cue to show an "upgrading…" affordance and, on completion, to re-run its
live queries against the rebuilt tables. In the worker transport it appears on
the event channel as an `upgrading` event. Nothing about the flow crosses the
wire: a server sees a post-reset client as an ordinary fresh bootstrapper at
the new version.

This flow is conformance-locked across both client cores (the
`schema-bump/*` scenarios: local-bump replay, floor-triggered convergence,
dropped-column rejection, and image-lane re-bootstrap).

## What a bump costs

**Re-download volume.** Exactly the data the app still declares. The
reset keeps each compatible subscription *registration* (including the per-unit
subscriptions a [window](/concepts-windowing/) maintains) and clears only
their sync state, so the re-bootstrap covers the subscriptions and the
currently windowed-in units, nothing more. A phone holding a 3-list
window of a 500-list workspace re-downloads those 3 lists. Data
outside the window was never local and stays that way.

**Apply cost.** On the wire, one segment download of the
subscribed data at the new version: the same bytes as a fresh install, with
[segment compression](/concepts-bootstrap/) applied. Locally, the
[measured](/benchmarks/) apply cost on the sqlite-image lane is ~30 ms for
100k rows (~3.3M rows/sec); the rows lane applies ~275k rows/sec. The image
is built once per (scopes, pin) server-side, so a fleet of clients bumping
after a release deploy shares one build.

For cellular-sensitive apps, size the window to the user's working set; the
re-download stays proportional to it, and offline writes survive the bump.

## Serving a compatibility window

A reference server accepts `schemaWindow` on `SyncServerConfig`. Pass compiled
schemas newest first, with `compileSchema(config.schema)` as the first entry.
Storage, authorization, validators and the writer fence use the current schema.
Old clients push with their own codec. Their pulls, conflict rows, segments and
realtime deltas contain only columns their codec knows. New nullable columns are
null on old inserts and stay unchanged on old patches.

The window permits added tables and appended nullable columns. It rejects removed
or renamed columns, changed codecs, primary keys, references and scope patterns
before serving. The host must also exclude older clients across semantic changes
that these structural checks cannot detect. A client outside the window receives
a floor naming its oldest version and the latest server version.

A schema floor pauses network transfer while local queries keep reading the
retained replica, including newly opened queries. Reactive availability reports
the schema stop alongside the query's local completeness. Applications can show
a notice with the distribution host's update action and pause edits because an
incompatible outbox commit can be rejected during replay. Leadership and security
gates still refuse local access when the owner or authorization is unavailable.
