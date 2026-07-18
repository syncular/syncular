# Schema & typegen

Your schema is authored once, as SQL migrations plus one manifest, and
compiled to a neutral **schema IR** plus the language outputs you request. The
default TypeScript module exports the `schema` object both server and client
use, plus per-table row types. Swift, Kotlin, and Dart can receive native schema
modules; TypeScript, Swift, Kotlin, Dart, and Rust can receive generated named
queries. Rust loads the neutral schema IR directly. Generated schema modules
have zero imports, so pulling one in adds no dependency edge.

The authoritative contract for the manifest, the IR, and the SQL subset is the
[typegen README](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md); this is the workflow.

## The committed schema inputs

**Migrations** (`migrations/NNNN_name/up.sql`) declare table shape. typegen
parses a strict SQL subset (`CREATE TABLE`, `ALTER TABLE ADD COLUMN`,
`CREATE INDEX`, `DROP INDEX`, and `DROP TABLE`, plus the supported column types and one
single-column primary key per table) and reads only the head table shape. It
never runs your migrations: your host does that, and the server manages its
own internal tables.

**The manifest** (`syncular.json`) names the synced tables, their scope
patterns, subscription templates, and the schema-version history:

```json
{
  "manifestVersion": 1,
  "migrations": "./migrations",
  "queries": "./queries",
  "output": {
    "ir": "./syncular.ir.json",
    "module": "./src/syncular.generated.ts",
    "rust": { "queriesPath": "./src/syncular_queries.rs" }
  },
  "schemaVersions": [{ "version": 1, "through": "0001_initial" }],
  "tables": [{ "name": "notes", "scopes": ["list:{list_id}"] }],
  "subscriptions": [
    { "name": "notesInList", "table": "notes", "scopes": { "list_id": ["{listId}"] } }
  ]
}
```

Table array order is the bootstrap order (parents before children). Every table
present at the head of migration history must be listed; a table retired by
`DROP TABLE` is omitted. Unknown manifest keys are hard errors.

`DROP TABLE IF EXISTS name` is also accepted. A dropped table name cannot be
reused later: the generated head schema cannot safely distinguish that from an
incompatible in-place rewrite on an upgrading server. The reference server
drops the retired relational current-row table and its live scope index during
the schema bump. Historical commit-log rows remain subject to normal retention,
so table retirement is not a compliance erasure operation.

`DROP INDEX [IF EXISTS] name` removes a previously declared secondary index
from the generated head schema. You may recreate the same name later with a
new column or uniqueness definition. On a server schema bump, Syncular
rebuilds the declared secondary indexes on its relational projection tables;
clients recreate their application tables during their normal re-bootstrap.

**The migration lock** (`syncular.migrations.lock.json`) is the immutable,
version-controlled baseline. Compact format 2 stores migration names,
normalized SQL checksums, and one privacy-safe canonical head-schema snapshot
for diagnostics. It never stores SQL, rows, database paths, or secrets, and its
size grows with migration metadata plus the current schema rather than every
cumulative schema snapshot. Scaffolds and `syncular init` create it. For an
existing project, review the current migration history once and run:

```sh
syncular migrations baseline --manifest-dir .
syncular migrations check --manifest-dir .
```

The baseline command refuses overwrite. Once deployed, restore any accidentally
edited migration and add a new migration for the repair. Do not delete and
re-baseline the lock. Existing-table additions must be trailing nullable
columns; changing names, order, types, or nullability in locked history is not
an upgrade.

Existing format-1 locks remain valid and are not silently rewritten by
generation. Compact one only through the explicit, reviewable transition:

```sh
syncular migrations check --manifest-dir .
syncular migrations upgrade-lock --manifest-dir .
git add syncular.migrations.lock.json
```

`CREATE VIRTUAL TABLE … USING fts5` declares a client-local full-text
projection owned by an existing synced table. It is emitted into every client
schema but never enters the wire or server schema. See
[Local full-text search](/tooling-local-search/) for the accepted syntax,
query pattern, and lifecycle.

## Generate

```sh
syncular generate --manifest-dir .
```

This validates locked history, appends valid new migrations to the lock, and
writes the IR JSON plus every configured schema or named-query output. **Commit
the lock and all generated outputs.** Each generated file carries the IR hash
in its header, so freshness is verifiable:

```sh
syncular generate --check     # exits non-zero unless on-disk files are byte-exact
```

Wire `--check` into CI so it catches missing generated changes and any edit,
removal, rename, reorder, type change, or nullability change in deployed
history. `syncular migrations check` is a faster history-only CI gate.

## What you get

For a table `notes`, the module exports:

- `schema`: the object passed to both `SyncClient` and `SyncServerConfig`
  (structurally a `ServerSchema` *and* a `ClientSchema`).
- `NotesRow`: one field per column, in row-codec order.
- `NotesInsert` / `NotesUpdate`: client-side input conveniences (the wire
  stays full-row upserts; nothing partial is encoded).

For a subscription `notesInList`, a `notesInListSubscription` with a
`scopes(params)` builder and a typed `params` interface.

Configured `.sql` and `.syql` named queries add typed inputs, projection rows,
physical-plan selection, and proven reactive metadata. TypeScript, Swift,
Kotlin, Dart, and Rust consume the same QueryIR rather than independently
parsing or lowering the query. The Rust output additionally exposes typed
`run` and atomic `snapshot` functions over `syncular-client`; see
[Named queries](/tooling-queries/) and [Rust](/platform-rust/).

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

### Dropped columns and tables

Re-encoding fails when a pending commit references a column or table the new
schema no longer has: the value or operation has nowhere to go. This surfaces
as a rejection with the client-local code
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
