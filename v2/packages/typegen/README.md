# @syncular-v2/typegen

SQL migrations + one manifest → neutral schema IR (JSON) → generated TS
module (REVISE B5). This file is the authoritative contract for the three
tool-level formats: the manifest, the IR, and the SQL subset. Wire-protocol
semantics (column types, scope patterns, schema-version gating) live in
[`../../SPEC.md`](../../SPEC.md) §2.4, §3.1, §1.5 — this document never
overrides it.

```sh
syncular-v2 generate [--manifest-dir <dir>] [--check]
```

Reads `<dir>/syncular.json` plus its migrations directory; writes the IR
JSON and the generated TS module. `--check` regenerates in memory and
exits 1 unless both files on disk match **byte-exactly**.

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
