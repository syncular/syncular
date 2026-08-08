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
  "tables": [{ "name": "todos", "scopes": ["list:{list_id}"] }],
  "subscriptions": [
    { "name": "todosInList", "table": "todos", "scopes": { "list_id": ["{listId}"] } }
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
an upgrade. A SQL `DEFAULT` does not backfill existing Syncular row payloads,
so a required appended column is rejected even when it has a literal default.

## Data changes and backfills

Migration SQL is schema-only. `UPDATE`, `INSERT`, and `DELETE` do not modify
accepted Syncular row payloads and are rejected before their inner SQL is
parsed. The diagnostic links back to this rollout contract instead of reporting
punctuation from SQL that cannot run here. Retain the old representation until
the replacement is proven complete.

Roll such a change out in five explicit steps:

1. Add the trailing column as nullable and deploy the schema.
2. Backfill existing rows with versioned, server-authoritative writes under a
   new idempotency key.
3. Enforce the required value in host validation for future writes.
4. Validate the backfill and all supported client versions against accepted
   server evidence.
5. Retire the old column or table only in a later schema version. Keep a synced
   appended column nullable; do not tighten its SQL nullability later.

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

For a table `todos`, the module exports:

- `schema`: the object passed to both `SyncClient` and `SyncServerConfig`
  (structurally a `ServerSchema` *and* a `ClientSchema`).
- `TodosRow`: one field per column, in row-codec order.
- `TodosInsert` / `TodosUpdate`: client-side input conveniences (the wire
  stays full-row upserts; nothing partial is encoded).

For a subscription `todosInList`, a `todosInListSubscription` with a
`scopes(params)` builder and a typed `params` interface.

Configured `.sql` and `.syql` named queries add typed inputs, projection rows,
physical-plan selection, and proven reactive metadata. TypeScript, Swift,
Kotlin, Dart, and Rust consume the same QueryIR rather than independently
parsing or lowering the query. The Rust output additionally exposes typed
`run` and atomic `snapshot` functions over `syncular-client`; see
[Named queries](/tooling-queries/) and [Rust](/platform-rust/).

## Schema bumps

When your schema changes, you bump `schemaVersions` in the manifest and
regenerate. There is no client-side migration engine: on a version change a
client keeps its outbox, wipes its local tables, re-bootstraps at the new
version, and replays the outbox on top. The triggers, what the reset
preserves, dropped-column handling, the `upgrading` state, and what a bump
costs are on [Schema upgrades](/concepts-schema-upgrades/).
