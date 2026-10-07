# Schema & typegen

You author your schema once, as SQL migrations plus one manifest. This page
takes you from an empty `migrations/` directory to a locked migration history
and a generated schema that your server and clients share, then lists the rules
the migration parser enforces. It is for developers who add or change synced
tables.

::meta{for="App developers on any SDK" time="15 minutes" first="quickstart" spec="2"}

:::terms
- **Migration**: A `migrations/NNNN_name/up.sql` file that declares table shape. Typegen reads it and never runs it.
- **Manifest**: `syncular.json`, which names the synced tables, their scopes, subscription templates, and schema versions.
- **Migration lock**: `syncular.migrations.lock.json`, the committed baseline that makes deployed history immutable.
- **Schema IR**: The neutral JSON description of the head schema that every generated output derives from.
- **Typegen**: The `syncular` CLI in `@syncular/typegen` that turns migrations into the IR and typed code.
:::

:::figure{title="From SQL to a schema both sides share" note="One command" ticks}
<div class="d-row">
<div class="d-stack">
<div class="node"><span class="t">Migrations</span>migrations/NNNN_name/up.sql</div>
<div class="node"><span class="t">Manifest</span>syncular.json</div>
<div class="node"><span class="t">Lock</span>checksums of deployed history</div>
</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">syncular generate</span>Checks history against the lock, then lowers the head schema</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Schema IR</span>syncular.ir.json</div>
<span class="d-arrow"></span>
<div class="d-stack">
<div class="node cool"><span class="t">Schema module</span>TypeScript (default), Swift, Kotlin, Dart</div>
<div class="node cool"><span class="t">Named queries</span>TypeScript, Swift, Kotlin, Dart, Rust</div>
</div>
</div>

::caption[The Rust core loads the schema IR directly and needs no generated schema module. Generated schema modules have zero imports, so importing one adds no dependency edge.]
:::

The manifest, IR, and SQL subset contract is in the
[typegen README](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md).
To add Syncular to an app that has no schema yet, start with
[Add Syncular to an existing app](/add-to-existing-app/).

## The committed schema inputs

Four files live in version control. Typegen reads the first three and writes the
fourth.

| File | Holds |
|---|---|
| `migrations/NNNN_name/up.sql` | Table shape, one directory per migration |
| `syncular.json` | Synced tables, scope patterns, subscription templates, schema versions, output paths |
| `syncular.migrations.lock.json` | Checksums of deployed migration history |
| Generated outputs | The IR, the schema module, and named-query modules, each stamped with the IR hash |

## Steps

:::::steps
::::step{title="Write the first migration" time="2 min"}
Create `migrations/0001_initial/up.sql`. Typegen parses a strict SQL subset:
`CREATE TABLE`, `ALTER TABLE ADD COLUMN`, `CREATE INDEX`, `DROP INDEX`, and
`DROP TABLE`, with the supported column types and one single-column primary
key per table. It reads only the head table shape. Your host runs the
migration SQL; the server manages its own internal tables.

```sql title="migrations/0001_initial/up.sql"
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL,
  position INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

Two value rules apply to every table:

- Integer row values stay within `-9007199254740991..=9007199254740991`. Both
  client cores reject larger values before they queue a mutation or patch.
- A primary key is `TEXT`, `INTEGER`, `BOOLEAN`, or `JSON`. The wire addresses
  a row by a string form of its primary key, and only those types have a string
  form that the TypeScript core, the Rust core, and the SQLite build inside
  each render identically. Generation fails with the table and column name for
  `REAL`, `FLOAT`, `DOUBLE`, `BLOB`, `crdt`, and `blob_ref` keys. The server and
  client cores reject the same schema at compile time if it reaches them
  another way.

::checkpoint[The file parses: `syncular generate` in step 4 names no migration error.]
::::

::::step{title="Write the manifest" time="2 min"}
`syncular.json` lists every synced table with its scope patterns, the
subscription templates, and the schema-version history:

```json title="syncular.json"
{
  "manifestVersion": 1,
  "migrations": "./migrations",
  "output": {
    "ir": "./syncular.ir.json",
    "module": "./src/syncular.generated.ts"
  },
  "schemaVersions": [{ "version": 1, "through": "0001_initial" }],
  "tables": [{ "name": "todos", "scopes": ["list:{list_id}"] }],
  "subscriptions": [
    { "name": "todosInList", "table": "todos", "scopes": { "list_id": ["{listId}"] } }
  ]
}
```

The `tables` array order is the bootstrap order: parents before children. List
every table present at the head of migration history; omit a table that
`DROP TABLE` retired. Unknown manifest keys are hard errors.

::checkpoint[`syncular.json` names every table that `up.sql` creates.]
::::

::::step{title="Lock the migration history" time="1 min"}
The lock is the immutable, version-controlled baseline. Scaffolds and
`syncular init` create it. For an existing project, review the current history
once, then baseline it:

```sh title="terminal"
syncular migrations baseline --manifest-dir .
syncular migrations check --manifest-dir .
```

Compact format 2 stores migration names, normalized SQL checksums, and one
privacy-safe canonical head-schema snapshot for diagnostics. It never stores
SQL, rows, database paths, or secrets, and it grows with migration metadata
plus the current schema.

```output
migration history is locked and unchanged
```

::checkpoint[`syncular.migrations.lock.json` exists and `migrations check` prints the line above.]
::::

::::step{title="Generate and commit" time="1 min"}
```sh title="terminal"
syncular generate --manifest-dir .
```

`generate` validates locked history, appends valid new migrations to the lock,
and writes the IR plus every configured schema or named-query output. Commit
the lock and all generated outputs. Each generated file carries the IR hash in
its header, so freshness is verifiable:

```sh title="CI"
syncular generate --check     # exits non-zero unless on-disk files are byte-exact
```

Run `--check` in CI. It catches missing generated changes and any edit,
removal, rename, reorder, type change, or nullability change in deployed
history. `syncular migrations check` is a faster history-only gate. Every
command and option is on the [CLI reference](/tooling-cli/).

::checkpoint[`src/syncular.generated.ts` and `syncular.ir.json` exist, and `generate --check` prints `generated output is up to date`.]
::::

::::step{title="Pass the schema to server and client" time="2 min"}
For a table `todos`, the generated module exports:

- `schema`: the object you pass to both `SyncClient` and `SyncServerConfig`. It
  is structurally a `ServerSchema` and a `ClientSchema`.
- `TodosRow`: one field per column, in row-codec order.
- `TodosInsert` and `TodosUpdate`: client-side input types that honor
  nullability. Insert requires the non-nullable columns; update requires the
  primary key and makes the rest optional. A `patch` records the supplied
  columns as a sparse push operation.

For a subscription template `todosInList`, the module exports
`todosInListSubscription`, with a `scopes(params)` builder and a typed `params`
interface.

Configured `.sql` and `.syql` named queries add typed inputs, projection rows,
physical-plan selection, and proven reactive metadata. TypeScript, Swift,
Kotlin, Dart, and Rust consume the same QueryIR; none parses or lowers the
query independently. The Rust output also exposes typed `run` and atomic
`snapshot` functions over `syncular-client`. See [Named queries](/tooling-queries/)
and [Rust](/platform-rust/).

::checkpoint[The import `import { schema } from './syncular.generated'` typechecks in your server and client.]
::::
:::::

## Schema bumps

Add a migration, extend `schemaVersions` in the manifest with the new version
and the migration it runs through, and regenerate. A deployed migration is
immutable: restore any accidentally edited one and add a new migration for the
repair. Do not delete and re-baseline the lock.

Changes to existing tables follow three rules:

- An addition to an existing table is a trailing nullable column. A SQL
  `DEFAULT` does not backfill existing Syncular row payloads, so a required
  appended column is rejected even when it has a literal default.
- Renames, reordering, type changes, and nullability changes in locked history
  are not upgrades.
- A synced appended column stays nullable. Do not tighten its SQL nullability
  later.

There is no client-side migration engine. On a version change a client keeps its
outbox, wipes its local tables, re-bootstraps at the new version, and replays the
outbox on top. The triggers, what the reset preserves, dropped-column handling,
the `upgrading` state, and the cost of a bump are on
[Schema upgrades](/concepts-schema-upgrades/).

### Retire tables and indexes

`DROP TABLE [IF EXISTS] name` removes a table from the head schema. A dropped
table name cannot be reused later: the generated head schema cannot safely
distinguish that from an incompatible in-place rewrite on an upgrading server.
The reference server drops the retired relational current-row table and its live
scope index during the schema bump. Historical commit-log rows stay subject to
normal retention, so table retirement does not erase data for compliance.

`DROP INDEX [IF EXISTS] name` removes a previously declared secondary index
from the head schema. You may recreate the same name later with a new column or
uniqueness definition. On a server schema bump, Syncular rebuilds the declared
secondary indexes on its relational projection tables; clients recreate their
application tables during their normal re-bootstrap.

### Data changes and backfills

Migration SQL is schema-only. `UPDATE`, `INSERT`, and `DELETE` do not modify
accepted Syncular row payloads, and typegen rejects them before it parses their
inner SQL. Retain the old representation until the replacement is proven
complete, and roll a data change out in five steps:

1. Add the trailing column as nullable and deploy the schema.
2. Backfill existing rows with versioned, server-authoritative writes under a
   new idempotency key. A SQL `DEFAULT` on the appended column is accepted and
   ignored, so it does not stand in for this step.
3. Enforce the required value in host validation for future writes.
4. Validate the backfill and all supported client versions against accepted
   server evidence.
5. Retire the old column or table in a later schema version.

## Migration SQL rules

### Declared references

A column may declare a reference to another table's primary key:

```sql
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  parent_id TEXT REFERENCES todos(id) ON DELETE CASCADE
);
```

The parser accepts `REFERENCES parent(pk)` with an optional
`ON DELETE RESTRICT | CASCADE | SET NULL`. It rejects `ON UPDATE`, `SET DEFAULT`,
and `NO ACTION`. An absent `ON DELETE` clause means `RESTRICT`. The parent and
child tables declare the same scope patterns, the child column type equals the
parent primary-key type, and `SET NULL` needs a nullable child column.

Typegen records the reference in the schema IR and emits a non-unique index over
the child column. The local replica DDL omits the clause, so local SQLite never
enforces a reference. The server enforces it once per commit over the candidate
state the commit produces (SPEC §6.11):

- A commit that deletes a parent and its children together passes.
- A `CASCADE` delete emits the child deletes in the same commit.
- A `SET NULL` delete nulls the child column.
- `RESTRICT` rejects the delete while a child remains.

A violation rejects the commit with `sync.reference_violation`.

### Constraints and where they are enforced

The migration parser accepts a fixed constraint surface. The full table with the
accepted syntax is in the
[typegen README](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md#constraints-support-and-enforcement).

| Constraint | Enforced by |
|---|---|
| `NOT NULL` and the primary key | The row codec on the server candidate commit and on every client write and apply. The TypeScript local mirror also declares `NOT NULL`; the Rust local tables carry bare column names. A null in a non-nullable column fails the commit. |
| Declared reference | The server, once per commit. Local SQLite does not enforce it. |
| `CREATE UNIQUE INDEX` | A physical index in both client mirrors, the server relational projection, and typegen's query type-check database. A local collision fails atomically with `sync.constraint_violation` and leaves no outbox entry and no revision advance. The server rejects the same collision at commit. |
| Hand-written server write-validator (§6.7) | The server, on each candidate row operation during commit application. It does not run on optimistic local writes, so a rule that needs immediate local feedback also belongs in the application's pre-write guard. |
| SQL `DEFAULT` literal on `CREATE TABLE` | Nothing. Typegen accepts and ignores it, and the server projection adds no app-level default. The host runs the migration SQL where a default matters. |

Migration SQL cannot declare a closed value set. The IR column carries no enum
or check metadata, so an inline `CHECK`, a table-level `CHECK`, and a named
`CONSTRAINT` are hard errors. Use the stored column type plus a §6.7
write-validator for the closed set, and a named `CREATE UNIQUE INDEX` for
uniqueness. A table-level `UNIQUE` requires a named unique index, and a
table-level `FOREIGN KEY` requires a column `REFERENCES` declaration.

```sql
-- Declare uniqueness with a named index.
CREATE UNIQUE INDEX todos_list_title ON todos (list_id, title);

-- A reference stays a column constraint.
ALTER TABLE todos ADD COLUMN parent_id TEXT REFERENCES todos(id) ON DELETE SET NULL;
```

### Local full-text projections

`CREATE VIRTUAL TABLE … USING fts5` declares a client-local full-text
projection owned by an existing synced table. Typegen emits it into every
client schema and keeps it out of the wire and the server schema. The accepted
syntax, query pattern, and lifecycle are on
[Local full-text search](/tooling-local-search/).

## Advanced

### A version-only bump (server-internal storage changes)

A Syncular release can change only the engine's own storage, such as a new
internal column on every synced table, with no application column change. The
application schema version still has to advance. `ensureSchema` compares the
server's `sync_schema_meta` marker with the generated schema version and skips
all DDL when the two match, so a deployment that never advances keeps serving
the old storage layout while reporting healthy.

Append an empty migration and point the version at it. Migration history is
immutable, so the version can only advance by appending a migration, and the
server owns its internal DDL instead of running application SQL for it.

```sh title="terminal"
mkdir -p migrations/0002_storage_internal
touch migrations/0002_storage_internal/up.sql
```

Set `schemaVersions` in `syncular.json` to version `2` through
`0002_storage_internal`, then regenerate and validate:

```sh title="terminal"
syncular generate --manifest-dir .
syncular migrations check --manifest-dir .
```

`generate` appends the migration to the lock and rewrites the generated schema's
`version`; the IR's table shapes stay unchanged. `migrations check` confirms the
committed history is an unchanged prefix. Deploy the server and let its gate
apply the pending version before the port opens:

```ts title="src/server.ts"
await ensureSyncServerReady(config);
```

A failure surfaces as `sync.schema_not_ready` with a compile or migration phase
instead of a request-time error. Confirm the bump landed:

- `sync_schema_meta.schema_version` on the server database equals the new
  version. A marker at the old version means the bump never ran.
- For a new internal column, the column exists on a synced table
  (`PRAGMA table_info('todos')` on SQLite, `information_schema.columns` on
  Postgres). A marker at the new version whose synced tables miss an internal
  column, or carry one with the wrong type, nullability, or primary key, fails
  closed at startup with `sync.storage.physical_layout_mismatch`, before the
  first write.
