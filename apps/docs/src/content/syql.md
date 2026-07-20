# SYQL

SYQL is SQLite for named, typed, reactive reads, with a small amount of checked
sugar for optional filters, reusable predicates, finite sort choices, bounded
limits, and synchronization coverage.

The formal definition is the
[SYQL language specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md).
The executable vectors live under
[`spec/syql`](https://github.com/syncular/syncular/tree/main/spec/syql).

Use a plain `.sql` query when the statement is fixed. Use `.syql` when its
shape depends on optional inputs or when it should declare sync coverage.

Explore the compiler directly in the [SYQL playground](/playground/), or jump
to the [optional-filter](/playground/?example=optional),
[sort-and-limit](/playground/?example=sort-limit),
[sync-coverage](/playground/?example=sync-coverage), or
[reusable-predicate](/playground/?example=predicate) examples. Everything runs
locally in the browser against the same parser, validator, and lowerer used by
typegen.

## Complete example

```syql
import { matchesTitle } from "./todo-predicates.syql";

sync query listTodos(
  listId,
  status?: string | null,
  range?,
  q?: string,
  unassigned: bool = false,
) {
  select id, title, status, created_at
  from todos
  where todos.list_id = :listId
    and when(status) status is :status
    and when(range) created_at between :range
    and when(q) matchesTitle(:q)
    and when(unassigned) assignee_id is null
  order by sortBy default newest {
    newest: created_at desc, id desc;
    oldest: created_at asc, id asc;
    title: title collate nocase asc, id asc;
  }
  limit pageSize default 50 max 200;
}
```

Write the SQLite statement directly in the query body. The final semicolon
terminates the complete query.

## Inputs

The signature is the public API authority:

| Form | Meaning |
| --- | --- |
| `listId` | required, type inferred from SQL |
| `q?: string` | optional string |
| `status?: string \| null` | absent, present-null, or present-string |
| `unassigned: bool = false` | ordinary boolean, omitted as false |
| `bounds?: { start, end }` | atomic optional record |

Generated targets preserve presence separately from SQL `NULL`. Optional
records must be supplied completely; partial values fail before querying.

## Optional predicates

For optional values and records, `when(x)` means `when(present(x))`:

```syql
and when(status) status is :status
```

You can spell that explicitly:

```syql
and when(present(status)) status is :status
```

For `flag: bool = false`, `when(flag)` means the effective value is true.

Use braces when one optional section contains multiple conjuncts:

```syql
and when(bounds) {
  created_at >= :start
  and created_at <= :end
}
```

`when` must be a complete outer `WHERE` or `HAVING` conjunct. It cannot sit
under `OR` or inside a nested statement.

## Inclusive ranges

The common two-bound case is shorter:

```syql
query createdBetween(range?) {
  select id, created_at from events
  where when(range) created_at between :range;
}
```

The compiler exposes `range` as `{ start, end }`, infers the endpoint type, and
binds both endpoints atomically. It uses SQLite `BETWEEN`, so the range is
inclusive. If type inference has no evidence, write
`range?: range<integer>`.

## Reusable predicates

```syql
predicate matchesTitle(value: string) {
  title like '%' || :value || '%'
}
```

Import and call it with normal SQL-like syntax:

```syql
import { matchesTitle } from "./todo-predicates.syql";

and when(q) matchesTitle(:q)
```

Calls are expanded hygienically. An unrecognized call remains a SQLite
function and is checked against Syncular's portable SQLite profile.

## `query` and `sync query`

An ordinary `query` reads local data reactively. The compiler infers exact
dependency keys from required scope predicates when it can; otherwise it uses
safe table-wide invalidation. It does not claim download coverage.

`sync query` additionally asks Syncular to synchronize and cover the selected
units:

```syql
sync query listTodos(listId) {
  select id, list_id, title from todos
  where todos.list_id = :listId;
}
```

Coverage is accepted only when the covered table has one SQL instance and
every declared schema scope is proven from required, non-null equality/`IN`
predicates. Predicates under `OR`, negation, `when`, or nested queries never
prove coverage, and an `IN` proof may contain only required binds.

For a table with multiple scopes, choose the unit dimension:

```syql
sync query messages(roomId, left, right) by messages.thread_id {
  select id, room_id, thread_id, body from messages
  where messages.room_id = :roomId
    and messages.thread_id in (:left, :right);
}
```

There are no `@scope` or `@cover` directives.

## Reading the server version

Syncular owns a local `_sync_version` column for every synced row. Project it
with an explicit alias when a mutation needs optimistic-concurrency evidence:

```syql
query getTodo(listId, todoId) {
  select id, title, _sync_version as server_version
  from todos
  where todos.list_id = :listId and todos.id = :todoId;
}
```

Typegen emits `serverVersion` as an exact, non-null integer. The physical
column remains query-only: it is excluded from schema and mutation types and
from `select *`, so applications cannot accidentally write engine-owned state.
Use a positive observed value as the mutation `baseVersion`; omit it for a
local row that has not yet received a server version.

## Sort and limit

Dynamic sorting is a closed enum of named profiles; every runtime sort
resolves to one of the declared orderings:

```syql
order by sortBy default newest {
  newest: created_at desc, id desc;
  oldest: created_at asc, id asc;
}
```

Every profile is checked. Bounded queries must end each profile with a proven
unique tie-breaker, usually the projected primary key.

```syql
limit pageSize default 50 max 200;
```

The limit input is optional and validated as an integer from 1 through 200 in
every generated runtime.

## Identity and types

The compiler infers result identity from schema primary keys, SQL lineage, and
projection aliases. When proof is not possible, the generated query uses
unkeyed reconciliation.

Unannotated input types are inferred from all SQL and predicate uses. Add a
type when SQL provides no evidence. Conflicting evidence is a compile error.

## Generated targets

One QueryIR drives TypeScript, Swift, Kotlin, Dart, and Rust named-query
outputs. Every target receives the same public inputs, selected physical SQL,
bind order, reactive dependencies, synchronization coverage, and proven row
identity.

Rust is enabled explicitly:

```json
{
  "output": {
    "rust": {
      "queriesPath": "./src/syncular_queries.rs"
    }
  }
}
```

The output uses one snake-case module per query:

```rust
mod syncular_queries;

let params = syncular_queries::list_todos::Params::new(list_id);
let rows = syncular_queries::list_todos::run(&client, &params)?;
let snapshot = syncular_queries::list_todos::snapshot(&mut client, &params)?;
```

Rust maps exact integers to `i64`, optional nullable inputs to
`SyqlPresence<Option<T>>`, groups to generated structs, and sorts to closed
enums. Row decoding is strict: malformed or missing dynamic values return a
query/column-specific error. `DESCRIPTOR` exposes dependencies, coverage, and
row identity for hosts that build a reactive observer over change batches;
there is no framework-specific Rust hook.

## Tooling

```bash
bunx @syncular/typegen fmt queries
bunx @syncular/typegen generate
```

The formatter is semantic-preserving and idempotent. The VS Code extension and
language server provide diagnostics, formatting, symbols, and
hover/definition/references for imported predicates.

For exact grammar, lowering, portability, and diagnostic requirements, use the
[normative specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md).
