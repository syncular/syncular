# RFC 0004: SQL-first SYQL

- Status: accepted and implemented
- Authors: Syncular maintainers
- Last updated: 2026-07-14
- Normative specification: [`docs/SYQL.md`](../SYQL.md)
- Conformance entry point: [`spec/syql/manifest.json`](../../spec/syql/manifest.json)

## Summary

Replace the prototype SYQL container with a SQL-first language. A query now
contains its `SELECT` directly. Ordinary SQL predicates drive reactive scope
inference, `sync query` expresses coverage intent, row identity is inferred,
predicate calls use normal call syntax, and dynamic order/limit controls appear
where their SQL clauses would appear.

This is a destructive prototype change. There is no legacy parser and no
migration mode.

## Motivation

The earlier design proved the compiler architecture but made simple reads feel
like a configuration format wrapped around SQL:

```syql
query listTodos(listId) {
  sql {
    select id, title from todos
    where @cover(todos.list_id = :listId)
  }
  identity by id;
}
```

Three declarations described facts already present in the statement:

- `sql {}` said that the central body was SQL;
- `@cover(...)` duplicated an ordinary filtering predicate while combining
  dependency inference and download intent;
- `identity by id` repeated a primary key the schema and projection already
  exposed.

Optional inputs also accumulated syntax that was internally consistent but
unfamiliar to SQL and application developers: callable-looking groups,
`switch`, braces around every `when`, separate `sort`/`page` sections, and an
`@` sigil on reusable predicates.

The result was capable but too ceremonial for the intended purpose: make
complex, typed, reactive SQLite reads easier to author.

## Design principles

1. SQL is the visual and semantic center.
2. Sugar must remove work that SQL alone cannot do safely.
3. Existing schema facts should be inferred, not restated.
4. Synchronization intent must remain explicit because it changes network and
   coverage behavior.
5. Dynamic SQL structure must remain finite and compiler checked.
6. Presence and `NULL` must remain distinct.
7. The language has one grammar during prototyping.

## Accepted syntax

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
  }
  limit pageSize default 50 max 200;
}
```

## Decisions

### Direct SQL body

The query's body is one `SELECT` or `WITH ... SELECT`. The final semicolon
terminates the complete query. Removing `sql {}` saves indentation and makes
the file read like SQLite with a few recognizable extensions.

Rejected alternative: a triple-quoted SQL string. It would weaken source
spans, editor embedding, structural validation, and formatting.

### `query` versus `sync query`

An ordinary `query` is a reactive local read. It can infer exact dependency
keys, but it never claims that those keys are downloaded.

A `sync query` explicitly claims coverage. The compiler accepts it only when
the covered table has one SQL instance and all of its declared scopes are
proven from required, non-null outer predicates. Predicates under `OR`,
negation, conditionals, or nested queries do not qualify. This separates two
concepts that `@cover` had conflated:

- which changes invalidate a read;
- which remote units the read is authorized to request and regard as covered.

Multi-scope tables require `by alias.scope_column` to select the unit
dimension. Fixed scopes still require one equality bind.

Rejected alternative: infer coverage for every query. A local join or
accidental scope predicate must not silently cause network synchronization.

### Infer dependency scopes from SQL

Required equality and `IN` predicates over schema scope columns are already
constructive facts. The compiler extracts them when they are unconditional and
unambiguous. Otherwise it safely falls back to table-wide invalidation.

This removes `@scope` without losing precision.

### Infer row identity

The schema owns primary keys, SQLite analysis owns table lineage, and the
projection owns output aliases. The compiler combines those facts to infer a
result key. It omits identity when proof is not possible.

Rejected alternative: keep `identity by` as an override. An unchecked override
could make keyed reconciliation unsound; a checked override is redundant when
the proof already exists.

### `bool`, not `switch`

`switch` described activation mechanics rather than a value type and looked
foreign beside `string` and `integer`. The accepted form is a normal boolean
with an explicit omission default:

```syql
unassigned: bool = false
```

`when(unassigned)` means the effective value is true. This also makes the
generated APIs ordinary booleans on every target.

The source spelling is `bool`, matching common application languages and
avoiding the longer prototype `boolean`. The target-neutral IR continues to
call the type `boolean`.

### Presence is the default `when` meaning

For an optional input, `when(x)` means `when(present(x))`. Authors may use the
explicit form when it improves clarity, especially for nullable values.

Required default-false booleans are the one deliberate overload:
`when(flag)` means `flag = true`. Static analysis knows the input category, so
the meaning is not runtime-ambiguous.

### Optional record syntax

General atomic groups use an inline record:

```syql
bounds?: { start: integer, end: integer }
```

The previous `bounds?(start, end)` looked like a function declaration and made
the optional marker hard to interpret. Records make the public API shape
visible.

### Inclusive range shorthand

The common range record was still too repetitive. The accepted shorthand is:

```syql
query q(range?) {
  select id from events
  where when(range) created_at between :range;
}
```

`BETWEEN :range` promotes `range` to an atomic `{ start, end }` input, infers
the element type, and lowers to two internal binds. It preserves SQLite's
inclusive `BETWEEN` behavior. Explicit `range<T>` is available when inference
has no SQL evidence.

Rejected alternatives:

- `between :range.start and :range.end`: SQLite bind syntax and existing named
  parameter tooling do not support member access cleanly;
- `between range(:range)`: more ceremony and less SQL-like;
- globally interpreting every two-member record as a range: too magical and
  prevents other record uses.

### Brace-free simple `when`

One conjunct may follow `when(...)` directly. Braces remain for compound
conditions. Placement remains deliberately strict: the conditional must be a
whole outer `WHERE`/`HAVING` conjunct. That restriction keeps variant omission
and neutralized execution equivalent.

### Normal predicate calls

Reusable predicates now use `matchesTitle(:q)`, not `@matchesTitle(:q)`. A
name that resolves in the local/imported predicate scope expands hygienically;
an unresolved function-shaped expression stays SQLite and is checked against
the portability profile.

This resolution rule is the main tradeoff. A newly imported predicate can
shadow a same-named SQLite function call in that module. We accept that cost
because imports are explicit and the resulting syntax stays close to SQL.

### Dynamic order at `ORDER BY`

Sort profiles remain finite enums, but their declaration moves to the SQL
position:

```syql
order by sortBy default newest {
  newest: created_at desc, id desc;
  oldest: created_at asc, id asc;
}
```

The colon/semicolon profile syntax is compact and avoids nested blocks. Free
runtime SQL remains forbidden.

### Dynamic limit at `LIMIT`

The old `page` name implied pagination strategy although it only bounded a
limit. The accepted form is:

```syql
limit pageSize default 50 max 200;
```

It retains runtime validation and internal bind lowering.

## Other issues carried into the redesign

The syntax change does not relax compiler correctness requirements found in
the original review:

- Optional nullable values still require tri-state target APIs.
- Record/range inputs remain atomic and reject partial values.
- Every optional bind requires dominance by its control.
- Conditional nodes under `OR`, nested queries, or compound statements remain
  forbidden until lowering has a formally equivalent model.
- Sort choices remain closed enums and every bounded profile needs a proven
  unique suffix.
- Query SQL remains read-only, deterministic, and constrained to the portable
  SQLite profile.
- Multiple references to the same table are analyzed per instance; ambiguity
  falls back to table-wide dependencies and cannot claim sync coverage.
- Compiler binds remain private and collision-proof.
- Generated targets must agree on exact integer, `NULL`, presence, validation,
  statement selection, dependencies, coverage, and identity behavior.
- The formatter must prove semantic equivalence and idempotence.
- Diagnostics and conformance vectors remain part of the language contract.

## Destructive migration

The implementation rejects all prototype forms. Repository queries, examples,
fixtures, generated artifacts, formatter tests, editor grammar, LSP behavior,
the language specification, and conformance schemas/vectors are updated in one
change.

Mechanical mapping:

| Prototype | Revision 1 |
| --- | --- |
| `sql { ... }` | direct SQL |
| `@scope(p)` | `p` |
| `@cover(p)` | `sync query` plus `p` |
| `@predicate(:x)` | `predicate(:x)` |
| `x?: switch` | `x: bool = false` |
| `g?(a, b)` | `g?: { a, b }` |
| range record + two binds | `range?` + `BETWEEN :range` |
| `sort name ...` | `order by name ...` |
| `page size ...` | `limit size ...` |
| `identity by ...` | inferred |

No runtime compatibility burden exists because the project is still in the
prototype phase.

## Consequences

Benefits:

- the common query is nearly ordinary SQL;
- synchronization intent is more obvious than an expression-level directive;
- less schema information is duplicated;
- optional filters, ranges, and sorts remain concise and typed;
- generated APIs become more conventional;
- the language is easier to teach from one complete example.

Costs:

- the parser must recognize a small amount of clause-position syntax;
- normal predicate calls require name-resolution before deciding whether a
  call is SYQL or SQLite;
- exact reactive inference is conservative and may fall back table-wide;
- range shorthand requires context-sensitive promotion and synthetic binds;
- all prototype sources break immediately.

These costs are accepted because they live in the compiler and remove repeated
complexity from every query author.

## Implementation checklist

- [x] parser and span-free AST
- [x] semantic predicate resolution and presence rules
- [x] range promotion and type inference
- [x] reactive dependency and sync-coverage inference
- [x] identity inference only
- [x] dynamic order/limit lowering
- [x] TypeScript, Swift, Kotlin, and Dart emitters
- [x] formatter, LSP, and TextMate grammar
- [x] repository query migration and regenerated goldens
- [x] normative specification and RFC
- [x] conformance schemas and vectors
- [x] authoring documentation
