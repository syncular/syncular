# SYQL

SYQL is SQLite for named, typed, reactive reads, plus checked syntax for
optional filters, reusable predicates, finite sort choices, bounded limits, and
synchronization coverage. You need it when a query's shape depends on optional
inputs, or when a screen must know that the rows it shows are fully synced.
This page is the language reference for developers who write `.syql` files.

::meta{for="App developers who write named queries" time="Reference" first="tooling-queries" spec="2"}

:::terms
- **Presence**: Whether the caller supplied an optional input. Generated targets keep presence separate from SQL `NULL`.
- **`when` conjunct**: A `WHERE` or `HAVING` term that exists only when its input is present.
- **Sort profile**: A named, complete `ORDER BY` that a runtime sort choice selects.
- **Sync coverage**: The claim that every scope unit a query reads has a complete local window.
- **QueryIR**: The target-neutral compiled form that every SDK output consumes.
:::

## SQL or SYQL

Write a plain `.sql` query when the statement is fixed. Write `.syql` when one
of these applies:

| You need | SYQL gives you |
|---|---|
| A filter that applies only when the caller supplies it | `when(x)` conjuncts with presence-aware inputs |
| One predicate reused in several queries | `predicate` declarations and imports |
| A sort the user picks at runtime | A closed `order by` enum of named profiles |
| A result page of bounded size | `limit pageSize default 50 max 200` validated in every runtime |
| A ready state that waits for a complete local window | `sync query` with proven scope coverage |

:::figure{title="What the compiler does with an optional filter" note="One query, two inputs" ticks}
<div class="d-cols-2">
<div class="d-stack">
<div class="node"><span class="t">Caller omits status</span><code>and when(status) status is :status</code></div>
<div class="d-down"><small>conjunct dropped</small></div>
<div class="node ok"><span class="t">Selected SQL</span><code>where todos.list_id = ?</code></div>
</div>
<div class="d-stack">
<div class="node"><span class="t">Caller passes status</span><code>and when(status) status is :status</code></div>
<div class="d-down"><small>conjunct kept, bound</small></div>
<div class="node hot"><span class="t">Selected SQL</span><code>where todos.list_id = ? and status is ?</code></div>
</div>
</div>

::caption[The compiler lowers the query to one target-neutral physical plan. The `variants` backend omits an inactive conjunct; the `neutralize` backend keeps one statement and guards the conjunct with a generated boolean bind. Both return the same rows. `syncular generate --print <name>` shows the checked SQL.]
:::

The formal definition is the
[SYQL language specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md),
and the executable vectors are under
[`spec/syql`](https://github.com/syncular/syncular/tree/main/spec/syql). The
CLI, output configuration, and generated shapes are on
[Named queries](/tooling-queries/).

The [SYQL playground](/playground/) runs the same parser, validator, and
lowerer as typegen in the browser, against the Release board schema of the
[hosted demo](/demos/). It shows the physical SQL of every statement, the typed
inputs and result columns, dependencies, coverage, and row identity, and its
Run tab executes the selected statement on the demo's sample data in SQLite
WASM. The examples are grouped by topic, from
[optional filters](/playground/#example=optional) and
[sort profiles](/playground/#example=sort-limit) to
[sync coverage](/playground/#example=sync-board) and queries that
[fail closed](/playground/#example=sync-unscoped). The address bar carries the
example and any edited source, so a copied link reopens the same state.

## Complete example

```syql
import { matchesTitle } from "./todo-predicates.syql";

sync query searchTodos(
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

Unannotated input types are inferred from all SQL and predicate uses. Add a
type when SQL provides no evidence. Conflicting evidence is a compile error.

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

Coverage is accepted only when every declared schema scope of every table
instance is proven from required, non-null equality/`IN` predicates. A
required scope bind may propagate through a qualified, mandatory scope-column
equality in `WHERE` or a simple `JOIN ... ON` clause. The body of a top-level
CTE is a scope of its own: its `WHERE` proves the instances it reads, and the
outer `WHERE` proves only the outer instances. Predicates under `OR`,
negation, `when`, or other nested queries never prove coverage, and an `IN`
proof may contain only required binds. Ambiguous joins, optional boolean branches, and
nested SQL fail closed instead of claiming partial readiness.

A self-join claims coverage when every instance of the table binds the same
scopes with the same operator and parameters:

```syql
sync query relatedCodes(catalogueSetId) {
  select c.id, rc.id as related_id
  from catalogue_codes as c
  join catalogue_relations as r
    on r.code_id = c.id and r.catalogue_set_id = c.catalogue_set_id
  join catalogue_codes as rc on rc.id = r.related_code_id
  where c.catalogue_set_id = :catalogueSetId
    and rc.catalogue_set_id = :catalogueSetId;
}
```

Both `catalogue_codes` instances select the same window base and unit, so the
generated descriptor holds one coverage entry and one dependency for that
table. If one instance is unconstrained, or the instances differ in a
parameter, operator, unit dimension, or fixed scope, generation fails with
`SYQL6005_INVALID_SYNC_QUERY`; split the query instead. A self-join within
one SELECT has no inferred row identity, so the result reconciles unkeyed and
cannot use a bounded `limit`.

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

## Result identity

The compiler infers result identity from schema primary keys, SQL lineage, and
projection aliases. When proof is not possible, the generated query uses
unkeyed reconciliation.

## Ranked top-N

A search that ranks every match and returns a page of wide rows ranks narrow
rows in a CTE that keeps only the page, then reads the wide row after the limit:

```syql
sync query searchCodes(setId, searchQuery, codeQuery: string) by c.set_id {
  with ranked as (
    select codes_fts._syncular_source_id as fts_source_id, hit.id as code_id,
      case when hit.code = :codeQuery collate nocase then 0 else 1 end
        as code_rank,
      bm25(codes_fts) as score
    from codes_fts
    join codes hit on hit.id = codes_fts._syncular_source_id
    where codes_fts match :searchQuery and hit.set_id = :setId
    order by code_rank, score, fts_source_id, code_id
    limit 80
  )
  select ranked.fts_source_id, ranked.code_id as id, c.code, c.title,
    c.description
  from ranked
  cross join codes c on c.id = ranked.code_id
  where c.set_id = :setId
  order by ranked.code_rank, ranked.score, ranked.fts_source_id asc,
    ranked.code_id asc
  limit 80;
}
```

The rules that make this compile:

- The CTE body projects the key of every relation it reads, here
  `fts_source_id` and `code_id`. Those columns are the CTE's identity.
- The CTE `LIMIT` is an integer literal without `OFFSET`, and the CTE
  `ORDER BY` ends with every identity column, spelled as its alias or its
  projected column. Any other nested `LIMIT` fails with
  `SYQL6003_NONDETERMINISTIC_SQL`.
- The outer query projects the CTE identity columns and joins the wide table
  with `ON c.id = ranked.code_id`. That equality determines `c`, so the result
  identity is `(ftsSourceId, id)` and the wide table adds no key.
- The outer `ORDER BY` repeats the CTE order and ends with the CTE identity
  terms. The CTE's `ORDER BY` alone does not order the result.
- Each instance of a synced table proves its scope in its own `WHERE`. Here
  both `codes` instances bind `set_id = :setId`, so the query has one coverage
  entry.

Apply every filter inside the CTE. An outer filter that removes kept rows
returns fewer rows than the page. SQLite keeps at most 80 rows in the CTE sort
and reads a wide row only for a returned row.

Without the CTE `LIMIT`, mark the CTE `as materialized`. SQLite then sorts
every match inside the materialization, which on 50,000 narrow matches cost
about 30 % more than a plain one-scope `ORDER BY ... LIMIT`; that form pays off
only for wide rows of several kilobytes. The
[SYQL specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md#143-ranked-top-n)
states the identity rules and the measurements.

## Generated targets and tooling

One QueryIR drives TypeScript, Swift, Kotlin, Dart, and Rust named-query
outputs. Every target receives the same public inputs, selected physical SQL,
bind order, reactive dependencies, synchronization coverage, and proven row
identity. The CLI, per-target output configuration, and the Rust module shape
are on [Named queries](/tooling-queries/).

The `syncular fmt` formatter is semantic-preserving and idempotent. The VS
Code extension and language server provide diagnostics, formatting, symbols,
and hover/definition/references for imported predicates. Rust maps exact
integers to `i64`, optional nullable inputs to `SyqlPresence<Option<T>>`,
groups to generated structs, and sorts to closed enums.

Every stable diagnostic code has one remediation instruction. The language
server publishes it as `Diagnostic.data.remedy`, and tooling can generate the
same catalog from `@syncular/typegen`:

```ts
import { generateSyqlDiagnosticCatalog } from '@syncular/typegen';

const catalog = generateSyqlDiagnosticCatalog();
```

For exact grammar, lowering, portability, and diagnostic requirements, use the
[normative specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md).
