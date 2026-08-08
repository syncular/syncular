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

1. **Boot-time version change.** The client persists a **local schema-version
   marker** in its database. When you ship new code with a new generated
   schema, the client boots on top of the old local tables, notices the marker
   no longer matches the generated version, and runs the reset before its first
   sync round; no server involvement is needed.
2. **Server schema floor.** A running client whose generated schema is behind
   the server receives `requiredSchemaVersion` (SPEC §1.6) and stops, surfacing
   the upgrade requirement (`schemaFloor` / `stopped`). It does not reset on
   the floor alone: resetting while still generating old payloads would only
   hit the floor again. When the app updates to a new generated schema, the
   boot-time trigger fires and the two paths converge.

The server keeps N-version codec support for transition windows if it chooses;
the reference server serves one version and answers the floor for any other,
which is enough for both triggers.

## What the reset touches

The reset touches the whole local database except three things:

| Preserved | Wiped & rebuilt |
| --- | --- |
| the outbox (schema-agnostic by design, §0/§7.1) | every synced table, secondary index, and FTS projection |
| the client identity (`clientId`) | subscription cursors, resume tokens, effective-scope state |
| the auth lease (`leaseState`) | retired-table registrations and their window bookkeeping |

Subscription registrations for tables that still exist are kept and
re-bootstrapped. Registrations for a retired table are pruned on open, together
with their window bookkeeping; retaining one would make every later pull fail
with `sync.unknown_table`.

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
reset keeps every subscription *registration* (including the per-unit
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
