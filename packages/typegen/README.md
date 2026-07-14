# @syncular/typegen

SQL migrations + one manifest → neutral schema IR (JSON) → generated TS
module (REVISE B5). This file is the authoritative contract for the three
tool-level formats: the manifest, the IR, and the SQL subset. Wire-protocol
semantics (column types, scope patterns, schema-version gating) live in
[`../../docs/SPEC.md`](../../docs/SPEC.md) §2.4, §3.1, §1.5 — this document never
overrides it.

```sh
syncular generate [--manifest-dir <dir>] [--check] [--watch]
syncular init [--manifest-dir <dir>]
```

`generate` reads `<dir>/syncular.json` plus its migrations directory and
writes the IR JSON and the generated TS module. `--check` regenerates in
memory and exits 1 unless both files on disk match **byte-exactly** (this is
the freshness contract; it is unchanged). `--watch` regenerates on any change
under the manifest dir (Bun's recursive `fs.watch`, debounced; it skips the
write when outputs are already fresh so it never loops on its own output).
`--check` and `--watch` are mutually exclusive.

`init` scaffolds a starter `syncular.json` + `migrations/0001_initial/up.sql`
into an existing project (the "add syncular to my app" path). It refuses to
overwrite an existing manifest or first migration. New projects usually start
from the scaffolder instead (`bun create syncular-app my-app`), which emits the
same shape plus a server + client.

When `generate` cannot find the manifest or migrations, the error points at the
schema guide and suggests `syncular init`.

---

## 1. Manifest reference (`syncular.json`)

```json
{
  "manifestVersion": 1,
  "migrations": "./migrations",
  "output": { "ir": "./syncular.ir.json", "module": "./syncular.generated.ts" },
  "schemaVersions": [
    { "version": 1, "through": "0001_initial" },
    { "version": 2, "through": "0002_add_task_estimate" }
  ],
  "tables": [
    { "name": "tasks", "scopes": ["project:{project_id}"] },
    {
      "name": "docs",
      "scopes": [
        "org:{org_id}",
        { "pattern": "project:{projectId}", "column": "project_id" }
      ]
    }
  ],
  "subscriptions": [
    {
      "name": "projectTasks",
      "table": "tasks",
      "scopes": { "project_id": ["{projectId}"] }
    }
  ],
  "extensions": {}
}
```

| Key | Required | Semantics |
|---|---|---|
| `manifestVersion` | yes | Must be `1`. Format growth happens by bumping this, not by tolerating unknown keys. |
| `migrations` | no (default `./migrations`) | Directory of `NNNN_name/up.sql` migrations, relative to the manifest. |
| `queries` | no (default `./queries`) | Directory of `.sql` / `.syql` named-query files (see §6). Only read when some output requests a queries file. |
| `naming` | no (default `"camel"`) | §5-of-DESIGN-queries casing: `"camel"` maps snake_case SQL names to camelCase in generated row types/params (projections lower with `AS` aliases so runtime keys match); `"preserve"` keeps SQL-truth names. Collisions/keyword hazards are generate-time errors. |
| `queryBackend` | no (default `"neutralize"`) | `.syql` conditional lowering: `"neutralize"` (one guarded statement), `"variants"` (enumerate per provided-combination whenever eligible), `"auto"` (enumerate at ≤ 2 optional groups). The per-query `variants` knob always forces. |
| `output.ir` | no (default `./syncular.ir.json`) | IR output path, relative to the manifest. |
| `output.module` | no (default `./syncular.generated.ts`) | Generated TS module path, relative to the manifest. |
| `output.queryIr` | no | Deterministic analyzed QueryIR JSON. Its hash keys generated reactive query descriptors, so SQL-only changes invalidate caches. |
| `output.queries` | no | Opt-in TS named-queries output path (see §6). A sibling `.ts` file. |
| `output.swift` | no | Opt-in Swift emitter (see §5). A path string, or `{ "path", "enumName", "queriesPath" }` (default `enumName` `SyncularSchema`; `queriesPath` opts into §6 Swift named queries). |
| `output.kotlin` | no | Opt-in Kotlin emitter (see §5). A path string, or `{ "path", "package", "objectName", "queriesPath" }` (defaults `syncular.generated` / `SyncularSchema`). |
| `output.dart` | no | Opt-in Dart emitter (see §5). A path string, or `{ "path", "queriesPath" }`. |
| `schemaVersions` | yes, non-empty | The §1.5 version history. See below. |
| `tables` | yes, non-empty | Synced tables. **Array order is the handler-declared bootstrap order (§4.7)** and flows unchanged into the IR and `schema.tables`. |
| `tables[].name` | yes | Must be created by a migration. |
| `tables[].scopes` | yes, ≥ 1 | §3.1 scope patterns: `'prefix:{variable}'` (column = variable) or `{ "pattern", "column" }`. The column must exist on the table; one variable must not map to two different columns. |
| `tables[].extensions` | no (default `{}`) | Opaque passthrough into the IR table's `extensions` slot. |
| `subscriptions` | no (default `[]`) | Requested-scope templates. `name` must be a valid JS identifier and unique; `table` must be a listed table; every scope key must be a scope variable of that table. |
| `subscriptions[].scopes` | yes, non-empty | Map of variable → non-empty list of values. Each value is **either** a literal **or** exactly `"{param}"`. Partial templates (`"p-{x}"`) and `"*"` (§3.2 rejects requested wildcards) are hard errors. |
| `extensions` | no (default `{}`) | Opaque passthrough into the IR document's `extensions` slot. |

Unknown keys are hard errors at every level, except inside `extensions`
objects, which pass through verbatim.

**`schemaVersions` semantics.** Each entry is `{ "version", "through" }`:
`version` is an integer ≥ 1, strictly increasing across entries; `through`
names the last migration that version includes. Entries partition the
migration list in order: version *n* covers every migration after the
previous entry's `through` up to and including its own. **Gap rule**: the
final entry's `through` must be the final migration — a migration not
covered by any version is a hard error (so is a `through` naming a
missing or out-of-order migration).

**Every-migrated-table rule.** Every table created by the migrations must
appear in `tables`. A migrated-but-unlisted table is a hard error, not a
silent skip; internal/unsynced tables will be a future manifest flag.

## 2. IR reference (`irVersion` 1)

The IR is the language-neutral contract that all emitters (TS today,
Swift/Kotlin later) consume. No TS types appear in it — column types are
the six §2.4 names.

```json
{
  "irVersion": 1,
  "schemaVersion": 2,
  "schemaVersions": [{ "version": 1, "migrations": ["0001_initial"] }],
  "tables": [
    {
      "name": "tasks",
      "primaryKey": "id",
      "columns": [{ "name": "id", "type": "string", "nullable": false }],
      "scopes": [
        {
          "pattern": "project:{project_id}",
          "variable": "project_id",
          "column": "project_id"
        }
      ],
      "extensions": {}
    }
  ],
  "subscriptions": [
    {
      "name": "projectTasks",
      "table": "tasks",
      "scopes": [
        {
          "variable": "project_id",
          "values": [{ "kind": "parameter", "name": "projectId" }]
        }
      ]
    }
  ],
  "extensions": {}
}
```

- `schemaVersion` is the current (last) version; `schemaVersions` is the
  full history with the migrations each version added, in application
  order.
- `tables` is in manifest order (bootstrap order). `columns` is in SQL
  declaration order (CREATE columns, then ADD COLUMNs) — **this is the
  §2.4 row-codec positional order**; emitters must never reorder it.
- `scopes` entries are pre-resolved: `variable` and `column` are
  materialized so non-TS emitters never re-parse `pattern`.
- `indexes` (additive, `irVersion` 1) is a per-table array of
  `{ "name", "columns": [...], "unique" }` in declaration order — emitted
  **only** when the table declares at least one index, so index-free tables
  (every pre-index manifest) keep byte-identical IR + generated output. It is a
  client-side/query-check concern; see §3's index note.
- `subscriptions[].scopes` is sorted by `variable`; each value is
  `{ "kind": "literal", "value" }` or `{ "kind": "parameter", "name" }`.
- **Determinism**: equal inputs produce byte-identical output — fixed key
  order (as shown above), 2-space indent, LF, trailing newline, extension
  objects recursively key-sorted. The IR file diffs cleanly.
- **Identity**: the IR's identity is `sha256:<hex>` over the exact IR file
  bytes (UTF-8). Every emitter must stamp this hash into its generated
  output header so `--check`-style freshness verification works per
  language.
- **`extensions`** (document- and table-level): reserved, opaque
  passthrough from the manifest — the designed-once home for the WP-49
  apply/read-model hooks. Always present, `{}` when unused. Emitters must
  round-trip unknown extension content without interpreting it.
- **Head-version-only**: `tables` describes the *current* schema version
  only. Per-version table snapshots (for serving multiple row codecs from
  one IR) are a planned additive change under a future `irVersion` bump;
  `schemaVersions` already carries the migration grouping needed to build
  them.

## 3. SQL subset

Migrations live in `NNNN_name/up.sql` (numeric prefix orders them;
duplicate ordinals are errors). The parser accepts exactly:

- `CREATE TABLE [IF NOT EXISTS] name ( column-defs…, [PRIMARY KEY (col)] ) [WITHOUT ROWID]`
- `ALTER TABLE name ADD [COLUMN] column-def`
- `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table ( col [, col…] )`
- column-def: `name TYPE [PRIMARY KEY] [NOT NULL] [NULL] [DEFAULT literal]`
- `--` line comments and `/* … */` block comments

Type map (case-insensitive) to the six §2.4 types:

| SQL keyword | IR type |
|---|---|
| `TEXT` | `string` |
| `INTEGER`, `INT`, `BIGINT`, `SMALLINT` | `integer` |
| `REAL`, `FLOAT`, `DOUBLE` | `float` |
| `BOOLEAN`, `BOOL` | `boolean` |
| `JSON`, `JSONB` | `json` |
| `BLOB`, `BYTEA` | `bytes` |

Nullability: `NOT NULL` (or being the primary key) → non-nullable;
otherwise nullable. Exactly one single-column primary key per table,
inline or table-level.

**Indexes** (`CREATE [UNIQUE] INDEX`). A migration may declare local
secondary indexes on an already-created table: `CREATE INDEX name ON table
(col)`, a compound `… (a, b)` (order preserved), the `UNIQUE` variant, and
`IF NOT EXISTS`. Each index becomes an `Ir​Table.indexes` entry
(`{ name, columns, unique }`, declaration order) and is materialized as a real
SQLite index by the **clients** (the TS web-client mirror + the Rust core's
base/visible table pair) and by typegen's own named-query type-check DB. Index
columns must exist on the table; index names must be unique across the schema;
a column must not repeat within one index. **Indexes are client-side only**:
the server stores rows in a generic `sync_rows` table with an opaque payload
(no per-user-table SQL columns exist server-side), so a user-column index has
nothing to attach to there — the scope inverted-index already covers server
reads. The column list is bare column names: **ASC/DESC**, **expression**
columns (`lower(a)`), and **partial** (`WHERE …`) indexes are hard errors (the
IR models column names only, so accepting a direction/expression would silently
drop it).

**Hard errors** (each names the construct and source file): any other
statement (`CREATE TRIGGER/VIEW`, `DROP`, DML, `ALTER … RENAME`, …); unknown
or parameterized types (`VARCHAR(36)`); quoted identifiers
(`"t"`, `` `t` ``, `[t]`); table constraints (`FOREIGN KEY`, `UNIQUE`,
`CHECK`, `CONSTRAINT`); column constraints beyond the list above
(`REFERENCES`, `CHECK`, `COLLATE`, …); `DEFAULT (expression)`; composite
or missing primary keys; `PRIMARY KEY` on `ADD COLUMN`; duplicate
tables/columns; ASC/DESC, expression, or partial (`WHERE`) index columns; a
duplicate or unknown-column index; trailing clauses (`STRICT`).

**`DEFAULT` literals are accepted and ignored**: typegen extracts the
schema *shape*; executing migrations (where defaults matter) is the
host's job. Rejecting them would make real-world migrations unusable
as input; recording them is not needed by any emitter today.

## 4. Generated-module contract

The emitted `*.generated.ts` module:

- Header: `// Generated by @syncular/typegen — DO NOT EDIT.` plus
  `irVersion` and the `irHash` of the IR bytes it was produced from.
- **Zero imports.** `schema` satisfies the server's `ServerSchema` type
  structurally (verified by the integration test) — using the generated
  file adds no dependency edge to `@syncular/server`.
- Exports per table `T` (PascalCase of the table name):
  - `TRow` — one field per column in row-codec order; nullable columns
    are `… | null`.
  - `TInsert` — non-nullable columns required; nullable columns optional
    (`?: … | null`).
  - `TUpdate` — primary key required; every other column optional.
  - Insert/Update are **client-side input conveniences only** — the wire
    stays full-row upserts (§6.1); nothing partial is ever encoded.
- Exports per subscription `s`: `sSubscription` with `name`, `table`, and
  a `scopes(params)` builder returning `Record<string, string[]>`
  (requested scopes), plus an `SParams` interface when the template has
  `{param}` placeholders.

**Lint/freshness split**: `*.generated.ts` is excluded from biome (see
`biome.json`) — hand-format rules on machine output only create churn.
Freshness and integrity are enforced instead by `syncular generate
--check`, which is byte-exact and therefore strictly stronger; the
generated fixture is still typechecked by `tsc` and exercised by tests.

## 5. Native emitter contracts (Swift / Kotlin / Dart)

The same IR feeds three additional emitters, opt-in per manifest via
`output.swift` / `output.kotlin` / `output.dart`. TS stays the default
(always emitted); a native emitter runs only when its key is present. Every
native file carries the same discipline as the TS module: the
`// Generated by @syncular/typegen — DO NOT EDIT.` header, `irVersion`,
and the `irHash` of the IR bytes it was produced from — so `syncular
generate --check` gates freshness byte-exactly per language. Each language's
golden fixture lives under `test/fixtures/basic/` and is asserted
byte-exactly + for determinism by `test/golden-native.test.ts` (the TS
golden's pattern). The emitters are dependency-free string builders; the
generated files depend only on the wrapper package's `JSONValue`/`JsonValue`.

Each generated file exports, per language:

- a **schema constant** built from the IR (byte-stable ordering) — pass it
  straight to the wrapper's `create(schema:)`;
- **one typed row type per table** with a `fromRow` factory that lifts a
  `query`/`readRows` row into the typed shape (returning null/nil when a
  non-nullable column is missing or mistyped);
- **one requested-scope builder per subscription**, `{param}` placeholders
  becoming typed function arguments.

| | Swift | Kotlin | Dart |
|---|---|---|---|
| Schema | `enum <EnumName> { static let schema: JSONValue }` | `object <ObjectName> { val schema: JsonValue }` | `const Map<String, Object?> syncularSchema` |
| Row | `struct <Table>` + `init?(row: [String: JSONValue])` | `data class <Table>` + `fromRow(row: JsonValue)` | `class <Table>` + `static <Table>? fromRow(Map<String, Object?>)` |
| Subscription | `enum subscriptions.<Name>` w/ `scopes(...)` | `object Subscriptions.<Name>` w/ `scopes(...)` | `class Syncular<Name>Subscription` w/ static `scopes(...)` |
| Imports | `Foundation`, `Syncular` | `dev.syncular.JsonValue` | (none) |

**Type mapping** (the six §2.4 types + blob_ref/crdt):

| IR type | Swift | Kotlin | Dart | notes |
|---|---|---|---|---|
| `string` | `String` | `String` | `String` | |
| `integer` | `Int` | `Long` | `int` | JVM widens to `Long`; SQLite integers ride as JSON numbers |
| `float` | `Double` | `Double` | `double` | |
| `boolean` | `Bool` | `Boolean` | `bool` | see boolean note below |
| `json` | `String` | `String` | `String` | the raw canonical JSON string |
| `bytes` | `[UInt8]` | `ByteArray` | `List<int>` | decoded from the core's `{"$bytes":"<hex>"}` marshaling |
| `blob_ref` (§5.9) | `String` | `String` | `String` | the raw canonical BlobRef JSON string; the client's blob API parses it |
| `crdt` (§5.10) | `[UInt8]` | `ByteArray` | `List<int>` | opaque bytes; the Y.Doc accessor is an app-level helper, not generated |

**Booleans and SQLite 0/1.** SQLite has no boolean type — it stores `0`/`1`.
`fromRow` therefore accepts **either** a real JSON boolean **or** a number
(`0` → false, non-zero → true), in every language. This is the honest
mapping: a row read back from the local SQLite mirror surfaces `done` as `1`,
while an optimistic in-memory row may surface it as `true`; both decode to the
typed `Bool`/`Boolean`/`bool`.

**Nullability.** A nullable column becomes an optional property (`T?` in
Swift/Kotlin, `T?` in Dart) and `fromRow` tolerates its absence; a
non-nullable column that is missing/mistyped makes `fromRow` return
null/nil (fail-soft at the decode boundary, not a crash).

## 6. Named queries (the `.sql` → typed-function tier)

The **named-query** tier is syncular's cross-platform answer to sqlc /
SQLDelight: you write a query file, and typegen transpiles it into a typed
function on every platform — killing query↔type drift *by construction*. It is
the type-safe **read** tier; raw `query(sql, params)` — guarded read-only —
stays the escape hatch for queries built at runtime.

Two frontends feed one pipeline (DESIGN-queries.md is the design of record):
**`.sql`** — plain SQL + `:params`, the compatibility floor, documented in
this section — and **`.syql`** — the DSL container (declared optional params
with auto-guarded conjuncts, `from+to?` groups, `?: flag` guards with
`if (…) { … }`, file-scoped `@fragments`, `orderBy`/`limit` knobs, and the
opt-in `variants` enumeration backend), which lowers at generate time to the
same checked plain SQL. Tooling: `syncular generate --print <name>` (the
lowered SQL), `syncular fmt` (canonical `.syql` style), `syncular lsp`
(diagnostics/hover/definition over stdio). Casing follows the manifest
`naming` mode (§1): generated rows/params are camelCase and projections are
`AS`-aliased so runtime keys match; `mutate` accepts camel and snake keys
both.

**File & naming convention.** Named queries live in a `queries/` directory
next to `migrations/` (override with the top-level `"queries"` manifest key).
The directory is **walked recursively** — subfolders are pure organization.
Each language's queries file is a **separate output** (`output.queries` for TS,
and `queriesPath` on `output.swift`/`output.kotlin`/`output.dart`), so
schema-only consumers never churn when a query changes. A queries output is
opt-in per language; when none is requested the `queries/` dir is not even
read.

A query's **default name** is its path relative to the queries root — every
folder segment plus the filename stem, joined and camelCased:

| Path | Default name |
|---|---|
| `list-todos.sql` | `listTodos` (flat files are unchanged) |
| `billing/invoices/list.sql` | `billingInvoicesList` |
| `reporting/tasks-by-priority.sql` | `reportingTasksByPriority` |

Every path segment **and** the filename stem must be lowercase kebab-case; a
stray `List.sql` or `Billing/` is a **hard error** naming the offending
segment. (Flat single-statement layouts keep exactly today's names, so
existing consumers are unchanged.)

**Name override.** A comment line `-- name: billingInvoicesList` in a
statement's leading comment block overrides the **full** name verbatim (it must
be a valid camelCase identifier — validated loudly). The override is
deliberately the **marker form** (`-- name: ident`), *not* a bare
`-- ident` one-word comment: a plain prose comment must **never** silently
rename a query, so a stray `-- todos` above a statement is ignored and the
path-derived name stands. Prose comments remain allowed anywhere (and are
stripped from the emitted SQL).

**One or many statements per file.** A file may hold multiple statements,
split on **top-level `;`** (a small splitter that respects single-quoted
strings, `--` line comments, and `/* … */` block comments; the SELECT-only
subset has no `BEGIN/END` blocks, so top-level semicolons are unambiguous, and
a trailing `;` on the last statement is optional). The rule:

- a file with **one** statement may omit `-- name:` — it gets the path-derived
  default;
- a file with **multiple** statements requires `-- name:` on **every**
  statement — a missing one is a generate-time error naming the file and the
  statement's position/first line.

`-- name:` and `-- param :x <type>` comments are **scoped to the statement they
directly precede** (the leading comment block between the previous statement's
`;` and this statement's first token), not file-header-scoped.

**Global uniqueness.** After collection, a duplicate name anywhere in the
manifest is a **hard error** listing **both** source locations (file + statement
position, e.g. `dup.sql#1` / `dup.sql#2`). The filesystem no longer guarantees
uniqueness once `-- name:` overrides exist, so this is checked explicitly.

**SELECT-only.** Named queries are reads. Any statement that is not a `SELECT`
is a **hard error at generate time**, pointing at `mutate()` — writes go
through the outbox (SPEC §7.1).

**Type-checking via SQLite itself** (the load-bearing trick). At generate time
typegen synthesizes the schema's DDL from the IR (a `CREATE TABLE` per table,
the reverse of the migration parser), builds an in-memory `bun:sqlite`
database, and `prepare()`s each query. **SQLite is the correctness authority**:
a bad table/column reference or a syntax error throws with SQLite's own
message. The prepared statement then yields the result column names +
`declaredTypes` (SQLite's `sqlite3_column_decltype`).

**Typing fidelity** (what `bun:sqlite` actually exposes, and its honest
boundary):

| Result column | Type source | Nullability | Fidelity |
|---|---|---|---|
| **plain column ref** (`title`, `t.title`, `title AS x`) | resolved to the IR column (decltype confirms) — exact IR type, incl. `json`/`blob_ref`/`crdt` | the IR column's `NOT NULL` | **exact** |
| **computed expression** (`count(*)`, `done + 1`, `:p AS l`) | decltype is null → documented fallback: aggregate/arithmetic → number, else string | always nullable (an expression's nullability is not knowable from decltype) | **fallback** |

`bun:sqlite` exposes `columnNames`, `declaredTypes` (once executed once — we
run the statement against the empty DB), and `paramsCount`. It does **not**
expose column origin (table/column), param **names**, or `NOT NULL` flags — so
typegen resolves plain refs against the IR itself (parse the SELECT list +
FROM/JOIN, match `name`/`alias.name`) to attach exact nullability, and parses
`:name` placeholders from the SQL text for param names. Want an exact type for
a computed column? Alias it to a plain ref, or accept the honest fallback.

**Parameters** use the `:name` convention. A param's type is **inferred** where
it compares against a plain column ref — `WHERE list_id = :listId` (equality,
`<`/`>`/`<=`/`>=`/`!=`/`LIKE`/`IS`) or `col IN (:a, :b)` — taking that column's
IR type. Where inference is ambiguous (compared to an expression, used only in
a projection, …) a per-statement `-- param` comment (in that statement's
leading comment block) overrides:

```sql
-- param :sinceMs integer
SELECT id, title FROM tasks WHERE estimated_at > :sinceMs + 0
```

Missing **both** inference and a comment is a generate-time error naming the
param and the fix. A `-- param` comment for a param the query does not use is
also an error. The inference is deliberately simple and honest.

**Emitted SQL.** Wrappers take **positional** params (`query(sql, params[])`),
so the emitted SQL rewrites `:name` → `?` (repeats included) and each runner
reorders the named params object into the positional array. Comments are
stripped and whitespace collapsed to a clean one-line string.

**Reactive metadata.** Each query emits a QueryIR-derived cache id, the
FROM/JOIN table set, table-associated scope dependencies, provable window
coverage, and a safe row identity when the primary key is projected by an
unambiguous single-table query. React uses these facts to share one query per
revision, route exact change batches, claim window coverage, and retain
unchanged row objects. The cache id is derived from the query IR rather than
the schema IR, so a SQL-only change cannot reuse old state. **Boundary**:
`bun:sqlite` exposes no authorizer and no statement table-list, and EXPLAIN
opcodes are fragile — so the set is derived by scanning every `FROM`/`JOIN`
identifier and keeping those that name an IR table. This captures subquery /
`WHERE EXISTS (…)` tables (they still appear under `FROM`/`JOIN`), and the
prepare() still guarantees the SQL itself is correct.

Inference is deliberately conservative around `OR`, joins, grouping, and
computed identity. A `.syql` query can state the missing fact explicitly:

```syql
query compareLists(left, right)
  depends tasks on project_id = left | right
  window tasks by project_id = left | right
  key by id
{
  select id, title from tasks
  where project_id = :left or project_id = :right
}
```

The declaration grammar is:

- `depends <table> on <scope> = <param> | <param>`;
- `window <table> by <scope> = <param> | <param>` with optional
  `fixed <other_scope> = <param>, ...` for every other scope on that table;
- `key by <result-column> | <result-column>`.

These escape hatches are checked against the prepared query, schema, inferred
param types, and result projection. They reject unread tables, unknown scopes
or params, optional/incompatible coverage params, incomplete fixed scopes,
duplicate declarations, and unprojected key fields.

**Emitted shape, per language** (one query, five outputs — abbreviated):

| | Output |
|---|---|
| TS | `listTodosRow` interface + `ListTodosParams` + `listTodosTables` + `async listTodos(client, params): Promise<ListTodosRow[]>` + a `listTodosQuery` descriptor for React |
| Swift | `struct ListTodosRow` + `init?(row:)` and `<Enum>Queries.listTodos(client:listId:) throws -> [ListTodosRow]` + `listTodosTables` |
| Kotlin | `data class ListTodosRow` + `fromRow` and `<Object>Queries.listTodos(client, listId): List<ListTodosRow>` + `listTodosTables` |
| Dart | `class ListTodosRow` + `fromRow` and `syncularListTodosQuery(client, listId): List<ListTodosRow>` + `syncularListTodosQueryTables` |

Each projection row is its **own** generated type per query (the drift-kill:
the row shape is exactly what the SELECT returns). Native rows decode through
the same `fromRow` mapping rules (0/1 booleans, `{"$bytes":"<hex>"}` bytes) as
the schema structs. `--check` gates every queries file byte-exactly, like the
schema files; each carries the DO-NOT-EDIT header + IR hash.

**React helper.** `@syncular/react` exports `useQuery(query, params?)`,
which takes the TS `NamedQuery` descriptor and observes the client-scoped
revisioned store:

```ts
import { listTodosQuery } from './syncular.queries';
const todos = useQuery(listTodosQuery, { listId });
// todos.rows: ListTodosRow[]; todos.phase: loading | partial | ready | error
```
