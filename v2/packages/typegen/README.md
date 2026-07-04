# @syncular-v2/typegen

SQL migrations + one manifest → neutral schema IR (JSON) → generated TS
module (REVISE B5). This file is the authoritative contract for the three
tool-level formats: the manifest, the IR, and the SQL subset. Wire-protocol
semantics (column types, scope patterns, schema-version gating) live in
[`../../SPEC.md`](../../SPEC.md) §2.4, §3.1, §1.5 — this document never
overrides it.

```sh
syncular-v2 generate [--manifest-dir <dir>] [--check] [--watch]
syncular-v2 init [--manifest-dir <dir>]
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
from the scaffolder instead (`bun create syncular-v2 my-app`), which emits the
same shape plus a server + client.

When `generate` cannot find the manifest or migrations, the error points at the
schema guide and suggests `syncular-v2 init`.

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
| `output.ir` | no (default `./syncular.ir.json`) | IR output path, relative to the manifest. |
| `output.module` | no (default `./syncular.generated.ts`) | Generated TS module path, relative to the manifest. |
| `output.swift` | no | Opt-in Swift emitter (see §5). A path string, or `{ "path", "enumName" }` (default `enumName` `SyncularSchema`). |
| `output.kotlin` | no | Opt-in Kotlin emitter (see §5). A path string, or `{ "path", "package", "objectName" }` (defaults `syncular.generated` / `SyncularSchema`). |
| `output.dart` | no | Opt-in Dart emitter (see §5). A path string, or `{ "path" }`. |
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

**Hard errors** (each names the construct and source file): any other
statement (`DROP`, `CREATE INDEX/TRIGGER/VIEW`, DML, `ALTER … RENAME`, …);
unknown or parameterized types (`VARCHAR(36)`); quoted identifiers
(`"t"`, `` `t` ``, `[t]`); table constraints (`FOREIGN KEY`, `UNIQUE`,
`CHECK`, `CONSTRAINT`); column constraints beyond the list above
(`REFERENCES`, `CHECK`, `COLLATE`, …); `DEFAULT (expression)`; composite
or missing primary keys; `PRIMARY KEY` on `ADD COLUMN`; duplicate
tables/columns; trailing clauses (`STRICT`).

**`DEFAULT` literals are accepted and ignored**: typegen extracts the
schema *shape*; executing migrations (where defaults matter) is the
host's job. Rejecting them would make real v1-style migrations unusable
as input; recording them is not needed by any emitter today.

## 4. Generated-module contract

The emitted `*.generated.ts` module:

- Header: `// Generated by @syncular-v2/typegen — DO NOT EDIT.` plus
  `irVersion` and the `irHash` of the IR bytes it was produced from.
- **Zero imports.** `schema` satisfies the server's `ServerSchema` type
  structurally (verified by the integration test) — using the generated
  file adds no dependency edge to `@syncular-v2/server`.
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
`v2/biome.json`) — hand-format rules on machine output only create churn.
Freshness and integrity are enforced instead by `syncular-v2 generate
--check`, which is byte-exact and therefore strictly stronger; the
generated fixture is still typechecked by `tsc` and exercised by tests.

## 5. Native emitter contracts (Swift / Kotlin / Dart)

The same IR feeds three additional emitters, opt-in per manifest via
`output.swift` / `output.kotlin` / `output.dart`. TS stays the default
(always emitted); a native emitter runs only when its key is present. Every
native file carries the same discipline as the TS module: the
`// Generated by @syncular-v2/typegen — DO NOT EDIT.` header, `irVersion`,
and the `irHash` of the IR bytes it was produced from — so `syncular-v2
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
