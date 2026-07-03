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

## Schema bumps

On a `requiredSchemaVersion` floor, the server tells the client to upgrade.
The v2 model is **no client-side migration engine**
([direction decision 3](../../REVISE.md#direction-decisions-2026-07-03-confirmed-by-benjamin)):
keep the (schema-agnostic) outbox, wipe local tables, re-bootstrap, replay.
Bootstrap-from-segment is fast enough that every upgrade exercising the
bootstrap path is cheaper than carrying a migration subsystem. The server keeps
N-version codec support for transition windows.

> Roadmap: the wipe-and-rebootstrap flow has a conformance scenario and a
> demo/docs story pending on the ladder. The generated IR is designed to carry
> per-version table snapshots additively when multi-version codec serving lands.
