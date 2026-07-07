# Named queries

Write a `.sql` file, get a **typed function on every platform**. The
named-query tier is syncular's cross-platform answer to sqlc / SQLDelight:
typegen type-checks each query against your real SQLite schema at generate
time and emits it as a typed function for TypeScript, Swift, Kotlin, and
Dart — killing query↔type drift by construction.

This page is the workflow. The authoritative contract (naming rules, typing
fidelity, error catalog) is
[typegen README §6](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md).

## Write a query

Named queries live in a `queries/` directory next to `migrations/`
(override with the `"queries"` manifest key; subfolders are pure
organization). Each file holds one or more `SELECT` statements:

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
kebab-case — anything else is a hard error naming the offending segment.

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
precede. The marker form is deliberate: a plain prose comment never silently
renames a query. Duplicate names anywhere in the manifest are a hard error
listing both source locations.

## Type-checked against the real schema

At generate time, typegen synthesizes your schema's DDL from the IR, builds
an in-memory SQLite database, and `prepare()`s each query — **SQLite itself
is the correctness authority**. A bad table or column reference fails
`syncular generate` with SQLite's own message, not at runtime on a device.

- A plain column reference (`title`, `t.title`, `title AS x`) resolves to
  the exact IR column type and nullability.
- A computed expression (`count(*)`, `done + 1`) falls back to number or
  string, always nullable — alias it to a plain ref if you want an exact type.
- Parameters use `:name`. A param compared against a column
  (`WHERE list_id = :listId`) infers that column's type; anything ambiguous
  needs a `-- param :name type` comment, and missing both is a generate-time
  error naming the param and the fix.

Named queries are **reads**. Any non-`SELECT` statement is a hard error at
generate time, pointing at `mutate()` — writes go through the outbox.

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

Then `syncular generate` — the same command as the schema (see
[Schema & typegen](/guide-schema/)). Every queries file carries the
DO-NOT-EDIT header and IR hash, and `syncular generate --check` gates it
byte-exactly in CI.

## Calling a query, per platform

For `list-todos.sql` above, each platform gets the projection's own row type
(exactly what the SELECT returns) plus a typed function. TypeScript:

```ts
import { listTodos } from './syncular.queries';

const rows = await listTodos(client, { listId: 'demo' });
// rows: ListTodosRow[] — typed by the query's own projection
```

`client` is anything with `query(sql, params)` — a direct `SyncClient`, a
worker handle, or the Tauri / React Native bridges. React gets a live hook —
`useQuery` from `@syncular/react` takes the generated descriptor and
re-runs exactly when a depended-on table changes:

```tsx
import { useQuery } from '@syncular/react';
import { listTodosQuery } from './syncular.queries';

const { rows, isLoading } = useQuery(listTodosQuery, { listId });
```

Swift (throws on failure, rows decode to the generated struct):

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
decode from the core's hex marshaling.

## Exact invalidation

Each query also emits a `tables` constant — the set of tables it reads,
validated by the same `prepare()`. On React, `useQuery` uses it as the exact
dependency set, so a named query re-runs exactly when one of its tables
invalidates, never on unrelated writes.

## Why this is the recommended read tier

- **Cross-platform**: one `.sql` file, four language outputs — the only
  typed read tier that exists on Swift, Kotlin, and Dart, not just TypeScript.
- **Checked at generate time**: schema drift breaks the build, not the app.
- **Boring by design**: the SQL you ship is the SQL you wrote — comments
  stripped, `:name` rewritten to positional `?`, nothing else.

Raw `client.query(sql, params)` (and React's `useRawSql`) is the escape
hatch for queries built at runtime — guarded read-only in the core: exactly
one statement, `SELECT`/`WITH`/`EXPLAIN`/`PRAGMA`/`VALUES` only. Writes
always go through `client.mutate()` — no query tier writes.

## Where to go next

- [Schema & typegen](/guide-schema/) — the manifest, migrations, and generate workflow this builds on.
- [React](/platform-react/) — `useQuery`, `useRawSql`, and the rest of the hooks.
- [typegen README §6](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md) — the authoritative named-query contract.
