# Named queries

Syncular generates typed query APIs from two source formats:

- `.sql` for a fixed SQLite `SELECT` with named `:params`;
- `.syql` for optional predicates, reusable predicates, finite sort choices,
  bounded limits, exact reactive dependencies, and explicit sync coverage.

The [SYQL language page](/syql/) teaches the second format; the
[SYQL playground](/playground/) compiles it in the browser. The
[formal language specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md)
is normative.

The same generated descriptor can be registered as a scoped or privileged
[authoritative remote query](/guide-remote-operations/#registered-typed-queries).
Remote callers send its generated ID and typed parameters; SQL remains in the
server registry.

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
select t.id, n.title as note_title
from todos t
left join notes n on n.list_id = t.list_id
```

Here `id` remains required while `noteTitle` is nullable. Aliases,
left-to-right join chains, and parenthesized relation groups retain any
nullability introduced by an earlier outer join. Physical tables inside a
derived subquery still participate in reactive dependencies.

Use plain SQL whenever the statement shape is fixed.

When a write needs compare-and-set semantics, explicitly project
`_sync_version AS server_version`; see the complete
[concurrency and correction guide](/guide-concurrency-correction/).

## `.syql`

```syql
sync query listTodos(listId) {
  select id, list_id, title, done from todos
  where todos.list_id = :listId
  order by sortBy default position {
    position: position asc, id asc;
    newest: updated_at_ms desc, id desc;
  }
  limit pageSize default 50 max 200;
}
```

`query` is a reactive local read; `sync query` also claims synchronization
coverage, so the query is not ready until every covered table window is
complete. Optional `when` predicates, reusable predicates, ranges, sort
profiles, limits, and the coverage proof rules are the
[SYQL language](/syql/); statements that cannot prove their claims fail
closed at generation time.

Use explicit `JOIN ... ON` syntax; comma-separated table sources are rejected
so a valid SQLite statement can never omit a table from reactive metadata.

## Generate and check

The `syncular` CLI ships in `@syncular/typegen`:

```bash
bunx syncular generate --manifest-dir .
bunx syncular generate --manifest-dir . --check
bunx syncular fmt queries
bunx syncular fmt --check queries
```

Wire `--check` into CI so it catches missing generated changes; the same CLI
also owns the [migration lock](/guide-schema/) subcommands.

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

For offline full-text search, declare a client-local FTS5
projection and query it through the same generated surface. See
[Local full-text search](/tooling-local-search/).
