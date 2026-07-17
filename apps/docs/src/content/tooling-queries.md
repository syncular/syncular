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

Use plain SQL whenever the statement shape is fixed.

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
coverage, so the compiler requires complete scope proof from ordinary SQL
predicates. Result identity is inferred from projected schema keys.

## Generate and check

```bash
bunx @syncular/typegen generate
bunx @syncular/typegen generate --check
bunx @syncular/typegen fmt queries
bunx @syncular/typegen fmt --check queries
```

Generation emits the target-neutral query IR plus configured TypeScript,
Swift, Kotlin, and Dart APIs. All targets consume the same physical plan and
runtime validation rules.

For production-scale offline text search, declare a client-local FTS5
projection and query it through the same generated surface. See
[Local full-text search](/tooling-local-search/).
