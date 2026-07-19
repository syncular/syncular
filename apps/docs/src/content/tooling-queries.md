# Named queries

Syncular generates typed query APIs from two source formats:

- `.sql` for a fixed SQLite `SELECT` with named `:params`;
- `.syql` for optional predicates, reusable predicates, finite sort choices,
  bounded limits, exact reactive dependencies, and explicit sync coverage.

Read the dedicated [SYQL guide](/syql/) or the
[formal language specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md)
for the complete language.

## Plain `.sql`

```sql
-- queries/list-todos.sql -> listTodos
select id, list_id, title, done
from todos
where list_id = :listId
order by position, id
```

The file path becomes the generated API name. Parameters, result columns,
types, tables, and conservative reactive metadata are derived at generation
time.

Plain projected columns retain their schema type and nullability. Outer joins
also contribute SQL null-extension: columns from the optional side of a
`LEFT JOIN`, the prior side of a `RIGHT JOIN`, and both sides of a `FULL OUTER
JOIN` are generated as nullable in TypeScript, Swift, Kotlin, Dart, and Rust,
even when the physical column is `NOT NULL`.

```sql
select t.id, d.body as document_body
from tasks t
left join documents d on d.task_id = t.id
```

Here `id` remains required while `documentBody` is nullable. Aliases,
left-to-right join chains, and parenthesized relation groups retain any
nullability introduced by an earlier outer join. Physical tables inside a
derived subquery still participate in reactive dependencies.

Use plain SQL whenever the statement shape is fixed.

When a write needs compare-and-set semantics, explicitly project
`_sync_version AS server_version`; see the complete
[concurrency and correction guide](/guide-concurrency-correction/).

## `.syql`

```syql
sync query listTodos(
  listId,
  q?: string,
  range?,
  unassigned: bool = false,
) {
  select id, list_id, title, done, created_at
  from todos
  where todos.list_id = :listId
    and when(q) title like '%' || :q || '%'
    and when(range) created_at between :range
    and when(unassigned) assignee_id is null
  order by sortBy default position {
    position: position asc, id asc;
    newest: created_at desc, id desc;
  }
  limit pageSize default 50 max 200;
}
```

The SQL is direct. `when` controls complete optional conjuncts. `BETWEEN
:range` creates an atomic inclusive `{ start, end }` input. Sort profiles are a
generated enum, and the limit is validated before execution.

`query` is a reactive local read. `sync query` also claims synchronization
coverage, so the compiler requires complete scope proof for every read schema
table. Required scope binds may propagate through a qualified, mandatory
scope-column equality in `WHERE` or a simple `JOIN ... ON` clause. Generated
coverage is aggregate: the query is not ready until every table window is
complete. Ambiguous joins, optional boolean branches, nested SQL, and self-joins
fail closed instead of claiming partial readiness. Result identity is inferred
from projected schema keys.

Use explicit `JOIN ... ON` syntax; comma-separated table sources are rejected
so a valid SQLite statement can never omit a table from reactive metadata.

## Generate and check

```bash
bunx @syncular/typegen generate
bunx @syncular/typegen generate --check
bunx @syncular/typegen fmt queries
bunx @syncular/typegen fmt --check queries
```

Generation emits the target-neutral query IR plus configured TypeScript,
Swift, Kotlin, Dart, and Rust APIs. All targets consume the same physical plan,
bind order, input-presence semantics, reactive facts, and runtime validation
rules.

## Rust output

Rust named queries are opt-in because Rust loads the neutral schema IR directly
rather than needing a generated schema source file:

```json
{
  "output": {
    "ir": "./syncular.ir.json",
    "rust": {
      "queriesPath": "./src/syncular_queries.rs"
    }
  }
}
```

Each query becomes a snake-case module with typed `Params` and `Row` values,
an inspectable `select` function, one-shot `run`, atomic `snapshot`, and a
`DESCRIPTOR` containing its QueryIR identity, dependencies, coverage, and any
proven row key:

```rust
mod syncular_queries;

let params = syncular_queries::list_todos::Params::new(list_id);
let rows = syncular_queries::list_todos::run(&client, &params)?;
let view = syncular_queries::list_todos::snapshot(&mut client, &params)?;
```

Exact integers remain `i64`, optional nullable values preserve absent versus
present `NULL`, and row decoding is strict. The generated module uses the
`syncular-client` query boundary and requires no direct `serde_json`
dependency. See [Rust](/platform-rust/) for the complete client workflow.

For production-scale offline text search, declare a client-local FTS5
projection and query it through the same generated surface. See
[Local full-text search](/tooling-local-search/).
