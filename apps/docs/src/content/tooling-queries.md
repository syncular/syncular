# Named queries and SYQL

Write a read query once and generate a checked function for TypeScript, Swift,
Kotlin, and Dart. Typegen prepares every executable SQL statement against the
schema built from your migrations, derives its row shape, and emits the same
public query contract on every selected target.

There are two source frontends:

- `.sql` is plain SQLite with named `:params`;
- `.syql` revision 1 adds typed operation boundaries, explicit conditional
  predicates, reusable imported predicates, reactive scope facts, finite sort
  profiles, bounded pages, and proven row identity.

Both lower into QueryIR v3 and the same target emitters. The normative language
definition is the [SYQL specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md).

## Plain `.sql`

Named queries live in `queries/` next to `migrations/`. Subfolders are only
organization. A single-statement file receives a camel-cased name from its
relative path:

```sql
-- queries/list-todos.sql -> listTodos
SELECT id, list_id, title, done, position
FROM todos
WHERE list_id = :listId
ORDER BY position, id
```

`list-todos.sql` becomes `listTodos`; `billing/invoices/list.sql` becomes
`billingInvoicesList`. Every path segment must be lowercase kebab-case.

A file may contain multiple top-level statements when every statement has an
explicit name:

```sql
-- name: reportOpenTasks
SELECT id, title FROM tasks
WHERE project_id = :projectId AND done = 0;

-- name: reportScores
-- param :minimum float
SELECT id, score FROM docs
WHERE score > :minimum * 1.0;
```

Parameter types are inferred from checked column comparisons. Use
`-- param :name type` only when the SQL does not provide enough evidence.
Writes are rejected: named queries are the read tier, while writes continue
through `mutate()` and the outbox.

## SYQL revision 1

Use `.syql` when a query needs conditional inputs, reusable predicates,
reactive coverage, or user-selectable ordering. SQL remains the expression
language; SYQL supplies a structured compiler boundary around it.

```syql
import { matchesTitle } from "./todo-predicates.syql";

query listTodos(
  listId,
  status?: string | null,
  range?(start: integer, end: integer),
  q?: string,
  unassigned?: switch,
) {
  sql {
    select id, title, status, created_at
    from todos
    where @cover(todos.list_id = :listId)
      and when(status) {
        status is :status
      }
      and when(range) {
        created_at between :start and :end
      }
      and when(q) {
        @matchesTitle(:q)
      }
      and when(unassigned) {
        assignee_id is null
      }
  }
  sort sortBy default newest {
    newest { created_at desc, id desc }
    oldest { created_at asc, id asc }
    title { title collate nocase asc, id asc }
  }
  page pageSize default 50 max 200;
  identity by id;
}
```

The imported predicate is an ordinary declaration in another `.syql` module:

```syql
predicate matchesTitle(needle: string) {
  title like '%' || :needle || '%'
}
```

### Inputs and presence

- `listId` is required. Its type is inferred from the schema comparison in
  `@cover`.
- `status?: string | null` is optional and nullable. Generated APIs preserve
  three states: absent, present null, and present value.
- `range?(start, end)` is one optional object/struct. Callers cannot provide a
  partial range.
- `unassigned?: switch` is a guard-only boolean control which defaults false.
- Every optional SQL bind is dominated by an explicit `when(...)` conjunct.
  Merely mentioning an optional input never changes SQL meaning.

TypeScript represents an optional nullable value with `SyqlPresent<T>` and the
`syqlPresent(value)` helper. Native emitters use their equivalent generated
presence type. SYQL integers are exact signed 64-bit values: TypeScript accepts
`bigint`, Swift uses `Int64`, Kotlin uses `Long`, and Dart uses `int`.

### Constructive reactive facts

`@scope` and `@cover` are real SQL predicate nodes, not unchecked annotations:

```syql
@scope(todos.list_id = :listId)
@cover(todos.list_id in (:left, :right))
```

Both produce the written restriction and exact invalidation keys from the same
AST node. `@cover` additionally proves window coverage and must bind every
declared scope of that table instance. When proof is unavailable, typegen falls
back safely to table-wide dependency and no coverage.

`identity by id;` is also checked. It is accepted only when the named projected,
non-null fields are proven unique for the outer query. Otherwise generation
fails or safe unkeyed reconciliation is used when identity is omitted.

### Sort and page

A sort profile is a complete checked `ORDER BY` list. There is no free runtime
direction or identifier interpolation. For bounded queries every profile must
end with the proven identity as a unique tie-breaker, such as `id asc` or
`id desc` above.

`page pageSize default 50 max 200;` adds one optional public input. Every
emitter rejects non-integral, negative, zero, or over-maximum values before
calling the client. Page is a bounded outer limit, not offset or cursor
pagination.

Revision 1 rejects window expressions and nested `LIMIT`/`OFFSET`, because it
does not define a local identity/total-order proof for those shapes. External
state such as clocks or random seeds must be required inputs; wall-clock,
random, connection-local, and SQLite-version functions are rejected.

### Physical backends

The compiler may select a neutralized plan or a finite statement matrix. This
is not SYQL source syntax and does not change the generated API. `queryBackend`
in `syncular.json` is an advanced diagnostic/performance override; its default
is `auto`. Every selected statement is prepared, serialized in QueryIR, and
implemented by all four emitters.

## Outputs

Enable only the query files your project needs:

```json
{
  "output": {
    "module": "./src/syncular.generated.ts",
    "queryIr": "./syncular.queries.ir.json",
    "queries": "./src/syncular.queries.ts",
    "swift": {
      "path": "./Syncular.generated.swift",
      "queriesPath": "./Syncular.queries.swift"
    },
    "kotlin": {
      "path": "./Syncular.generated.kt",
      "queriesPath": "./Syncular.queries.kt"
    },
    "dart": {
      "path": "./syncular.generated.dart",
      "queriesPath": "./syncular.queries.dart"
    }
  }
}
```

Run `syncular generate`. `syncular generate --check` is the byte-exact CI
freshness gate for QueryIR and every generated target.

## Calling generated queries

TypeScript:

```ts
import { listTodos, syqlPresent } from './syncular.queries';

const rows = await listTodos(client, {
  listId: 'demo',
  status: syqlPresent(null),
  range: { start: 100n, end: 500n },
  sortBy: 'newest',
  pageSize: 25,
});
```

React consumes the generated descriptor:

```tsx
import { useQuery } from '@syncular/react';
import { listTodosQuery } from './syncular.queries';

const todos = useQuery(listTodosQuery, { listId });
```

Swift:

```swift
let rows = try SyncularSchemaQueries.listTodos(
    client: client,
    listId: "demo",
    sortBy: .newest
)
```

Kotlin:

```kotlin
val rows = SyncularSchemaQueries.listTodos(
    client,
    listId = "demo",
    sortBy = ListTodosSortBy.newest,
)
```

Dart:

```dart
final rows = syncularListTodosQuery(
  client,
  listId: 'demo',
  sortBy: ListTodosSortBy.newest,
);
```

Names in the abbreviated native examples follow the manifest's configured
namespace/package. Generated source is the exact API authority.

## Tooling

- `syncular generate --print <name>` prints public inputs, the selected
  backend, statement selectors, checked SQL, and physical binds.
- `syncular fmt [files...]` formats revision-1 SYQL canonically and refuses any
  rewrite whose normalized AST or comment order changes. Use `--check` in CI.
- `syncular lsp` runs the project-aware language server. It reports parser,
  module, schema, SQLite, and target-naming errors with exact spans and supports
  hover, imported predicate definition/references, symbols, and formatting.
- `editors/vscode-syql` provides revision-1 TextMate highlighting and an LSP
  client configuration.

The normative fixtures and JSON Schemas live in
[`spec/syql`](https://github.com/syncular/syncular/tree/main/spec/syql). They
pin lexical tokens, semantic ASTs, imports and controls, diagnostics, lowering,
backend execution equivalence, QueryIR v3, and formatter output.

## Where to go next

- [Schema and typegen](/guide-schema/)
- [React](/platform-react/)
- [SYQL language specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md)
- [RFC 0004](https://github.com/syncular/syncular/blob/main/docs/rfcs/0004-syql-language.md)
