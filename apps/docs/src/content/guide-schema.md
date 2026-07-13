# Schema & typegen

Your schema is authored once, as SQL migrations plus one manifest, and
compiled to a neutral **schema IR** and a generated TypeScript module. The
module exports the `schema` object both server and client use, plus per-table
row types. It has zero imports, so pulling it in adds no dependency edge.

The authoritative contract for the manifest, the IR, and the SQL subset is the
[typegen README](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md); this is the workflow.

## The two inputs

**Migrations** (`migrations/NNNN_name/up.sql`) declare table shape. typegen
parses a strict SQL subset (`CREATE TABLE` / `ALTER TABLE ADD COLUMN`, the
six column types, one single-column primary key per table) and reads only
the table shape. It never runs your migrations: your host does that, and
the server manages its own internal tables.

**The manifest** (`syncular.json`) names the synced tables, their scope
patterns, subscription templates, and the schema-version history:

```json
{
  "manifestVersion": 1,
  "migrations": "./migrations",
  "output": { "ir": "./syncular.ir.json", "module": "./src/syncular.generated.ts" },
  "schemaVersions": [{ "version": 1, "through": "0001_initial" }],
  "tables": [{ "name": "notes", "scopes": ["list:{list_id}"] }],
  "subscriptions": [
    { "name": "notesInList", "table": "notes", "scopes": { "list_id": ["{listId}"] } }
  ]
}
```

Table array order is the bootstrap order (parents before children). Every
migrated table must be listed; unknown manifest keys are hard errors.

## Generate

```sh
syncular generate --manifest-dir .
```

This writes the IR JSON and the TS module. **Commit both.** The generated
module carries the IR hash in its header, so freshness is verifiable:

```sh
syncular generate --check     # exits non-zero unless on-disk files are byte-exact
```

Wire `--check` into CI so it catches any schema change that was not regenerated.

## What you get

For a table `notes`, the module exports:

- `schema`: the object passed to both `SyncClient` and `SyncServerConfig`
  (structurally a `ServerSchema` *and* a `ClientSchema`).
- `NotesRow`: one field per column, in row-codec order.
- `NotesInsert` / `NotesUpdate`: client-side input conveniences (the wire
  stays full-row upserts; nothing partial is encoded).

For a subscription `notesInList`, a `notesInListSubscription` with a
`scopes(params)` builder and a typed `params` interface.

## Schema bumps and client upgrades

When your schema changes, you bump `schemaVersions` in the manifest and
regenerate. There is no client-side migration engine
([direction decision 3](https://github.com/syncular/syncular/blob/main/docs/ROADMAP.md),
SPEC §7.4): a client does not transform its local tables from one version to
the next. On a version change it keeps the outbox, wipes its local tables,
re-bootstraps at the new version, and replays the outbox on top. Bootstrap
from a SQLite-image segment runs at millions of rows per second on the image
lane, fast enough that drilling the bootstrap path on every upgrade costs
less than building and maintaining a migration subsystem that only runs
during upgrades.

### What triggers the flow

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

### What the reset touches

The reset touches the whole local database except three things:

| Preserved | Wiped & rebuilt |
| --- | --- |
| the outbox (schema-agnostic by design, §0/§7.1) | every synced table |
| the client identity (`clientId`) | subscription cursors, resume tokens, effective-scope state |
| the auth lease (`leaseState`) | (subscription *registrations* are kept and re-bootstrapped) |

The outbox replays on top of the fresh bootstrap. Outbox entries are stored
in schema-agnostic form and encoded at send time with the current codec
(§0), so a commit written under version N pushes under N+1 by re-encoding.
The server never accepts a retired encoding, and pending offline writes stay
visible across the bump.

### Dropped columns

Re-encoding fails when a pending commit references a column the new schema no
longer has: the value has nowhere to go, and there is no migration to fill or
drop it. This surfaces as a rejection with the client-local code
`sync.outbox_incompatible` (§7.4.4). The un-encodable commit leaves the outbox
and its purely-optimistic rows are undone, exactly like a server rejection.
Later outbox commits that *do* encode keep replaying, so the queue keeps
moving past the one incompatible commit.

### What the app sees

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

### What a bump costs

The two questions a production evaluator asks first, answered:

**How much re-downloads?** Exactly the data the app still declares. The
reset keeps every subscription *registration* — including the per-unit
subscriptions a [window](/concepts-windowing/) maintains — and clears only
their sync state, so the re-bootstrap covers the subscriptions and the
currently windowed-in units, nothing more. A phone holding a 3-project
window of a 500-project workspace re-downloads those 3 projects. Data
outside the window was never local and stays that way.

**What does N rows cost?** On the wire, one segment download of the
subscribed data at the new version — the same bytes as a fresh install, with
[segment compression](/concepts-bootstrap/) applied. Locally, the
[measured](/benchmarks/) apply cost on the sqlite-image lane is ~30 ms for
100k rows (~3.3M rows/sec); the rows lane applies ~275k rows/sec. The image
is built once per (scopes, pin) server-side, so a fleet of clients bumping
after a release deploy shares one build and each pays a file-copy-speed
import. For cellular-sensitive apps the lever is the window: keep the
windowed-in set proportional to what the user actually works with, and a
bump costs a few seconds of background download, an "upgrading…" affordance,
and no lost offline writes.
