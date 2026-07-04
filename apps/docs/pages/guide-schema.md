# Schema & typegen

Your schema is authored once, as SQL migrations plus one manifest, and
compiled to a neutral **schema IR** and a generated TypeScript module. The
module exports the `schema` object both server and client use, plus per-table
row types — with **zero imports**, so using it adds no dependency edge.

The authoritative contract for the manifest, the IR, and the SQL subset is the
[typegen README](../../packages/typegen/README.md); this is the workflow.

## The two inputs

**Migrations** (`migrations/NNNN_name/up.sql`) declare table shape. typegen
parses a strict SQL subset — `CREATE TABLE` / `ALTER TABLE ADD COLUMN`, the
six column types, one single-column primary key per table — and reads the
*shape*, not the semantics. It never runs your migrations (your host does that;
the server manages its own internal tables).

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
syncular-v2 generate --manifest-dir .
```

This writes the IR JSON and the TS module. **Commit both.** The generated
module carries the IR hash in its header, so freshness is verifiable:

```sh
syncular-v2 generate --check     # exits non-zero unless on-disk files are byte-exact
```

Wire `--check` into CI so a schema change without a regenerate fails loudly.

## What you get

For a table `notes`, the module exports:

- `schema` — the object passed to both `SyncClient` and `SyncServerConfig`
  (structurally a `ServerSchema` *and* a `ClientSchema`).
- `NotesRow` — one field per column, in row-codec order.
- `NotesInsert` / `NotesUpdate` — client-side input conveniences (the wire
  stays full-row upserts; nothing partial is encoded).

For a subscription `notesInList`, a `notesInListSubscription` with a
`scopes(params)` builder and a typed `params` interface.

## Schema bumps — the upgrade story

When your schema changes, you bump `schemaVersions` in the manifest and
regenerate. The v2 model is **no client-side migration engine**
([direction decision 3](../../REVISE.md#direction-decisions-2026-07-03-confirmed-by-benjamin),
SPEC §7.4): a client never transforms its local tables from one version to the
next. On a version change it **keeps the outbox, wipes its local tables,
re-bootstraps at the new version, and replays the outbox on top**. Bootstrap
from a SQLite-image segment is fast enough (millions of rows/sec on the image
lane) that every upgrade drilling the bootstrap path is cheaper than carrying a
migration subsystem that runs only on upgrades.

### What triggers the flow

Two triggers converge on the same wipe-re-bootstrap-replay:

1. **Boot-time version change.** The client persists a **local schema-version
   marker** in its database. When you ship new code with a new generated
   schema, the client boots on top of the old local tables, notices the marker
   no longer matches the generated version, and runs the reset before its first
   sync round — no server involvement.
2. **Server schema floor.** A running client whose generated schema is behind
   the server receives `requiredSchemaVersion` (SPEC §1.6) and stops, surfacing
   the upgrade requirement (`schemaFloor` / `stopped`). It does **not** reset on
   the floor alone — resetting while still generating old payloads would only
   hit the floor again. When the app updates (new generated schema), the
   boot-time trigger fires and converges.

The server keeps N-version codec support for transition windows if it chooses;
the reference server serves one version and answers the floor for any other,
which is enough for both triggers.

### What the reset touches

The reset is a **whole-database local reset except three things**:

| Preserved | Wiped & rebuilt |
| --- | --- |
| the outbox (schema-agnostic by design, §0/§7.1) | every synced table |
| the client identity (`clientId`) | subscription cursors, resume tokens, effective-scope state |
| the auth lease (`leaseState`) | (subscription *registrations* are kept and re-bootstrapped) |

The outbox replays on top of the fresh bootstrap. Because outbox entries are
stored in schema-agnostic form and **encoded at send time** with the current
codec (§0), a commit written under version N pushes under N+1 by re-encoding —
the server never accepts a retired encoding, and pending offline writes stay
visible across the bump.

### Dropped columns

Re-encoding fails when a pending commit references a column the new schema no
longer has — the value has nowhere to go and there is no migration to fill or
drop it. This surfaces cleanly as a **rejection** with the client-local code
`sync.outbox_incompatible` (§7.4.4): the un-encodable commit leaves the outbox
and its purely-optimistic rows are undone, exactly like a server rejection.
Later outbox commits that *do* encode keep replaying — one incompatible commit
never wedges the queue.

### What the app sees

A small, queryable `upgrading` client state is `true` from the moment the reset
begins until the first post-reset bootstrap round reaches idle — the app's cue
to show an "upgrading…" affordance and, on completion, to re-run its live
queries against the rebuilt tables. In the worker transport it rides the event
channel as an `upgrading` event. Nothing about the flow crosses the wire: a
server sees a post-reset client as an ordinary fresh bootstrapper at the new
version.

This flow is conformance-locked across both client cores (the
`schema-bump/*` scenarios: local-bump replay, floor-triggered convergence,
dropped-column rejection, and image-lane re-bootstrap).
