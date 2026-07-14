# Named queries

Write a query file, get a **typed function on every platform**. The
named-query tier is syncular's cross-platform answer to sqlc / SQLDelight:
typegen type-checks each query against your real SQLite schema at generate
time and emits it as a typed function for TypeScript, Swift, Kotlin, and
Dart, so a query and its row types can never drift apart.

There are two frontends, one pipeline:

- **`.sql`** — the compatibility floor. Plain SQL + `:params`; every SQL
  editor, formatter, and LLM understands the file with zero context.
- **`.syql`** — the DSL tier. A thin, GraphQL-style *container* around SQL
  expressions: declared optional params, reusable fragments, and safe
  `orderBy`/`limit` knobs, all composed at generate time into one plain,
  SQLite-checked statement.

This page is the workflow. The authoritative contract (naming rules, typing
fidelity, error catalog) is
[typegen README §6](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md);
the design of record is `DESIGN-queries.md` in the repo.

## Write a query (.sql)

Named queries live in a `queries/` directory next to `migrations/`
(override with the `"queries"` manifest key; subfolders are pure
organization). Each `.sql` file holds one or more `SELECT` statements:

```sql
-- queries/list-todos.sql
-- A list's todos, position-then-id ordered.
-- :listId infers to TEXT (compared against the todos.list_id column).
SELECT id, list_id, title, done, position, updated_at_ms
FROM todos
WHERE list_id = :listId
ORDER BY position, id
```

A query's default name is its path relative to the queries root, camelCased:
`list-todos.sql` → `listTodos`, `billing/invoices/list.sql` →
`billingInvoicesList`. Path segments and filename stems must be lowercase
kebab-case; anything else fails generation with an error naming the
offending segment.

## One or many statements per file

A file with a single statement may rely on the path-derived name. A file
with multiple statements (split on top-level `;`) requires a
`-- name: identifier` marker on every statement:

```sql
-- queries/task-reports.sql

-- name: reportOpenTasks
SELECT id, title, done
FROM tasks
WHERE project_id = :projectId AND done = 0
ORDER BY id;

-- name: reportDocScores
-- param :minScore float
SELECT id, org_id, score
FROM docs
WHERE score > :minScore * 1.0
ORDER BY id
```

`-- name:` and `-- param` comments are scoped to the statement they directly
precede. Only the marker form can name a query, so a prose comment can
never rename one by accident. Duplicate names anywhere in the manifest fail
generation with an error listing both source locations.

## SQL stays snake_case; your code gets camelCase

Column names are SQL truth: schema, `.sql`, and `.syql` bodies are authored
against the real snake_case names. **Casing is an emitter concern**: the
generated row types, params, and native struct fields are camelCase
(`created_at` → `createdAt`), and the projection is lowered with `AS`
aliases so the *runtime* result keys are the camelCase names too. There is
no runtime mapping step, and `generate --print` shows the lowered SQL.

- Author-written aliases are respected and convention-mapped like any
  column (`AS doc_count` → `docCount`).
- Collisions (`col_2` + `col2`), target-language keywords, and leading
  underscores on the Dart target are generate-time **errors**.
- `client.mutate` accepts value keys in both casings (the canonical
  camelCase of the generated row types and the SQL-truth snake_case),
  resolved with one map lookup per key.
- The raw tier is raw: `client.query` / `useRawSql` return whatever SQLite
  returns. Alias in SQL if you want camel keys there.
- Opt out with `"naming": "preserve"` in `syncular.json`.

## The `.syql` DSL tier

When a screen needs *optional* filters, reusable predicates, or a
user-selectable sort, plain SQL gets verbose. `.syql` files declare that
structure in the signature and keep every predicate real SQL:

```syql
fragment visibleIn(listId) {
  list_id = :listId and archived_at is null
}

fragment search(q?) {
  title like '%' || :q || '%'
}

query listTodos(listId, status?, from+to?, unassigned?: flag)
  orderBy position | created_at | title default position
  limit max 200 default 50
{
  select id, title, done, created_at
  from todos
  where @visibleIn(:listId)
    and @search(:q)
    and status = :status
    and created_at between :from and :to
    and if (:unassigned) { assignee_id is null }
}
```

What each piece means:

- **`status?` — auto-guarded optionals.** A top-level `where` conjunct that
  mentions an optional param applies **only when it is provided**. Omit
  `status` at the call site and `and status = :status` is a no-op; pass it
  and it filters. The signature's `?` is the entire conditional syntax.
- **`from+to?` — groups.** Both params apply together: the `between`
  conjunct runs only when *both* are provided.
- **`unassigned?: flag` — boolean guards.** A flag gates a predicate
  through the explicit primitive and stays out of the SQL itself:
  `if (:unassigned) { assignee_id is null }` applies its predicate only
  when the flag is passed as `true`. (`if (:a, :b) { … }` is also how you
  guard a predicate on params it doesn't mention.)
- **`@visibleIn(:listId)` — fragments.** First-class, file-scoped, spliced
  at generate time. A fragment's own optional params propagate: using
  `@search(:q)` adds `q?` to `listTodos`' generated signature.
- **`orderBy … default …` — the identifier knob.** Column names cannot
  bind, so the allowlist is baked into the generated code: the function
  takes `orderBy?: 'position' | 'createdAt' | 'title'` + `dir?: 'asc' |
  'desc'`, user input only ever *selects* from the checked list, and every
  allowed column is prepared against the schema at generate time.
- **`limit max 200 default 50` — the value knob.** Limits bind as ordinary
  params; the default and clamp live in the SQL
  (`limit min(coalesce(:limit, 50), 200)`), so an absent value is a no-op.

Everything lowers to one plain SQL statement (optional conjuncts become
`(:p is null or (…))` guards), checked by SQLite like any `.sql` query.
Optional params outside a top-level `where` conjunct (under an `OR`,
inside a subquery, in the projection) are generate-time errors telling
you to use `if (…) { … }` or make the param required.

### Keyset pagination

There is no `offset` knob: offset pagination over *live* local queries
drifts as synced writes shift rows. The right pattern falls out of optional
params with zero new syntax:

```syql
query todosPage(listId, before?)
  limit max 100 default 50
{
  select id, title, created_at from todos
  where list_id = :listId
    and created_at < :before
  order by created_at desc
}
```

First call: no `before`, newest page. Next call: pass the last row's
`createdAt`. Stable under live updates and index-friendly.

### The variants backend

By default a `.syql` query is one neutralized statement. Add the `variants`
knob (or set `"queryBackend": "variants" | "auto"` in the manifest — `auto`
enumerates at ≤ 2 optional groups) and typegen instead emits one checked
statement per combination of provided optional groups, with the generated
function dispatching on provided-ness: perfect index use with the same
semantics and the same API. More than 8 groups is an error; a query with
nine independent optional filters needs a redesign.

### Checked reactive declarations

Typegen infers reactive metadata conservatively. When a valid SQL shape is too
complex to prove—an `OR`, a multi-table join, or a computed composite
identity—put the missing fact on the `.syql` query itself:

```syql
query compareLists(left, right)
  depends todos on list_id = left | right
  window todos by list_id = left | right
  key by id
{
  select id, title
  from todos
  where list_id = :left or list_id = :right
}
```

- `depends <table> on <scope> = <param> | …` supplies exact scope routing.
- `window <table> by <scope> = <param> | …` supplies required coverage.
  On a table with multiple scope variables, append
  `fixed <other_scope> = <param>, …` for every remaining scope.
- `key by <result-column> | …` supplies stable row identity, including a
  composite identity for joins.

These are checked declarations, not trust-me hints. The table must be read by
the query; scopes and params must exist and have compatible types; coverage
params must be required; every fixed scope must be present; and key columns
must appear in the result. Invalid declarations fail generation.

## Type-checked against the real schema

At generate time, typegen synthesizes your schema's DDL from the IR, builds
an in-memory SQLite database, and `prepare()`s each query (and every knob
variant), so SQLite itself is the correctness authority. A bad table or
column reference fails `syncular generate` with SQLite's own message, long
before the query reaches a device.

- A plain column reference (`title`, `t.title`, `title AS x`) resolves to
  the exact IR column type and nullability.
- A computed expression (`count(*)`, `done + 1`) falls back to number or
  string, always nullable — alias it to a plain ref if you want an exact type.
- Parameters use `:name`. A param compared against a column
  (`WHERE list_id = :listId`), a `BETWEEN` endpoint, or a `LIKE` operand
  infers its type; anything ambiguous needs a `-- param :name type` comment
  (`.sql` tier), and missing both is a generate-time error naming the param
  and the fix.

Named queries are **reads**. Any write statement is a hard error at
generate time, pointing at `mutate()`; writes go through the outbox. A
`WITH` is allowed when its main statement is a `SELECT` (SQLite also allows
`WITH … DELETE`; both the generator and the core's raw-query guard reject
those).

## Turn on the outputs you need

Each language's queries file is a separate, opt-in output, so schema-only
consumers never churn when a query changes:

```json
{
  "output": {
    "module": "./src/syncular.generated.ts",
    "queries": "./src/syncular.queries.ts",
    "swift": { "path": "./Syncular.generated.swift", "queriesPath": "./Syncular.queries.swift" },
    "kotlin": { "path": "./Syncular.generated.kt", "queriesPath": "./Syncular.queries.kt" },
    "dart": { "path": "./syncular.generated.dart", "queriesPath": "./syncular.queries.dart" }
  }
}
```

Then run `syncular generate`, the same command as the schema (see
[Schema & typegen](/guide-schema/)). Every queries file carries the
DO-NOT-EDIT header and IR hash, and `syncular generate --check` gates it
byte-exactly in CI.

## Calling a query, per platform

For `list-todos.sql` above, each platform gets the projection's own row type
(exactly what the SELECT returns) plus a typed function. TypeScript:

```ts
import { listTodos } from './syncular.queries';

const rows = await listTodos(client, { listId: 'demo' });
// rows: ListTodosRow[] — { id, listId, title, done, position, updatedAtMs }
```

`client` is anything with `query(sql, params)` — a direct `SyncClient`, a
worker handle, or the Tauri / React Native bridges. React gets a live hook:
`useQuery` from `@syncular/react` takes the generated descriptor and
re-runs exactly when a depended-on table changes:

```tsx
import { useQuery } from '@syncular/react';
import { listTodosQuery } from './syncular.queries';

const todos = useQuery(listTodosQuery, { listId });
```

Optional `.syql` params are optional keys (`status?: string | null`); knobs
add `orderBy?` / `dir?` / `limit?`. Swift (throws on failure, rows decode to
the generated struct):

```swift
let rows = try SyncularSchemaQueries.listTodos(client: client, listId: "demo")
```

Kotlin:

```kotlin
val rows = SyncularSchemaQueries.listTodos(client, listId = "demo")
```

Dart:

```dart
final rows = syncularListTodosQuery(client, listId: 'demo');
```

Native rows decode through the same rules as the schema structs: SQLite's
`0`/`1` booleans become real `Bool`/`Boolean`/`bool`, and bytes columns
decode from the core's hex marshaling. Optional params default to
`nil`/`null`; orderBy allowlists are per-query enums.

## Reactive descriptors

Each query emits a descriptor with a QueryIR-derived cache id, exact
table/scope dependencies, provable window coverage, and a safe row key when
the projection proves one. On React, `useQuery` claims the coverage and reads
rows, completeness, and local revision atomically. A zero-row bootstrap can
therefore transition from `loading` to an honestly empty `ready` without a
separate window read.

Set `output.queryIr` to keep the deterministic analyzed QueryIR JSON beside
generated code. Its hash is the descriptor identity, so changing only SQL or
reactive declarations invalidates old cache entries.

## Tooling

- **`syncular generate --print <name>`** — dump one query's lowered,
  checked SQL (params, tables, knob variants). "What does this actually
  run" is always one command away.
- **`syncular fmt`** — the canonical `.syql` formatter (one style, no
  options): lowercase keywords, one clause per line, and-prefixed WHERE
  conjuncts. `--check` for CI. `.sql` files are left to the ecosystem's
  formatters.
- **`syncular lsp`** — a zero-dependency language server over stdio:
  generate-time diagnostics as you type, hover shows the lowered SQL,
  go-to-definition on `@fragment` refs.
- **VS Code** — `editors/vscode-syql` in the repo highlights the container
  grammar with embedded SQL regions.

## Why this is the recommended read tier

- **Cross-platform**: one query file, four language outputs. It is the only
  typed read tier that covers Swift, Kotlin, and Dart as well as TypeScript.
- **Checked at generate time**: schema drift surfaces as a build failure.
- **Boring by design**: the SQL you ship is the SQL you wrote: comments
  stripped, `:name` rewritten to positional placeholders, camel aliases and
  optional-param guards visible via `--print`, nothing else.

Raw `client.query(sql, params)` (and React's `useRawSql`) covers queries
built at runtime. The core guards it read-only: one statement,
`SELECT`/`WITH`/`EXPLAIN`/`PRAGMA`/`VALUES` only (a `WITH` must resolve to
a read). Writes always go through `client.mutate()`.

## Where to go next

- [Schema & typegen](/guide-schema/) — the manifest, migrations, and generate workflow this builds on.
- [React](/platform-react/) — `useQuery`, `useRawSql`, and the rest of the hooks.
- [typegen README §6](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md) — the authoritative named-query contract.
