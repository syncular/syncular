# SYQL language specification

- Status: normative, revision 1
- SQLite portability floor: 3.46.0
- File extension: `.syql`

This document defines the accepted source language, its static semantics, its
reactive meaning, and its target-neutral lowering contract. The conformance
manifest in [`spec/syql/manifest.json`](../spec/syql/manifest.json) is normative
alongside this specification.

SYQL is a small, statically checked layer over SQLite `SELECT`. SQL remains the
main language. SYQL adds only the pieces that cannot be expressed safely as a
single fixed statement:

- declared and inferred public inputs;
- optional predicates with explicit presence semantics;
- reusable hygienic predicates;
- finite, validated dynamic sort orders;
- a bounded dynamic limit;
- exact reactive dependency inference and explicit synchronization intent;
- portable generated APIs and execution plans.

## 1. Conformance terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** are to be interpreted as normative requirements.

An implementation conforms when it:

1. accepts every valid conformance vector;
2. rejects every invalid vector with the pinned primary diagnostic code;
3. produces the pinned span-free semantic AST, lowering facts, formatter
   output, and public target shapes;
4. preserves the semantics defined here for cases not represented by a vector.

Source spans use UTF-16 offsets, one-based lines, and one-based Unicode-scalar
columns. The lexer is lossless: concatenating every non-EOF token reproduces
the input byte-for-byte after decoding it as UTF-8 text.

## 2. Source files and names

A `.syql` file is UTF-8 text containing imports followed by declarations.
Imports MUST precede declarations. A UTF-8 BOM is accepted at the beginning.

Public language names use lower camel case:

```text
[a-z][A-Za-z0-9]*
```

Names beginning with the case-insensitive prefix `__syql` are reserved.
Declaration names, import aliases, input names, group-member bind names, sort
controls, limit controls, and sort-profile names MUST be unique in their
respective namespace. Generated target names MUST also survive the configured
naming transform without collision or target-keyword conflicts.

SQL identifiers retain SQLite spelling and are not subject to the camel-case
rule.

Under camelCase naming the compiler renames each projected result column to its
language name in the generated SQL. A select alias keeps its authored spelling
in the source: an outer `ORDER BY` or `GROUP BY` term, including a sort
profile term, names the alias as written (`as next_est ... order by next_est`)
and the compiler follows the rename. The camel-case spelling of a snake_case
alias is not an authored name and fails with `SYQL6002_INVALID_SQL`. `WHERE`
and `HAVING` do not resolve select aliases; they repeat the expression.

## 3. Lexical grammar

The lexer recognizes whitespace, `--` line comments, `/* ... */` block
comments, identifiers, numeric literals, SQL string and quoted-identifier
forms, blob literals, import-path strings, named binds, punctuation, and SQLite
operators.

Comments and quoted tokens are atomic. Text resembling `when`, a bind, or a
predicate call inside one of them has no SYQL meaning.

Only named `:camelCase` parameters are accepted in SQL templates. SQLite `?`,
`?NNN`, `@name`, and `$name` parameters are forbidden. Compiler-generated
binds use the reserved `:__syql...` namespace and cannot be authored.

Import paths use JSON double-quoted string rules. SQL strings continue to use
SQLite single-quote rules.

## 4. Container grammar

The following EBNF is descriptive. Lexical trivia may occur between tokens.
`SQL_TEMPLATE` and `ORDER_TERMS` are token sequences further constrained by
later sections.

```ebnf
file              = { import }, { declaration }, EOF ;

import            = "import", "{", import_item,
                    { ",", import_item }, [ "," ], "}",
                    "from", IMPORT_PATH, ";" ;
import_item       = camel_name, [ "as", camel_name ] ;

declaration       = predicate | query ;

predicate         = "predicate", camel_name, "(",
                    [ predicate_param, { ",", predicate_param }, [ "," ] ],
                    ")", template_block ;
predicate_param   = camel_name, [ ":", value_type ] ;

query             = { acknowledgement },
                    [ "sync" ], "query", camel_name, "(",
                    [ query_param, { ",", query_param }, [ "," ] ],
                    ")", [ "by", sql_name, ".", sql_name ],
                    "{", SQL_TEMPLATE,
                    [ dynamic_order ], [ dynamic_limit ], ";", "}" ;

query_param       = value_param | record_param | explicit_range_param ;
value_param       = camel_name, [ "?" ], [ ":", value_type ]
                  | camel_name, ":", "bool", "=", "false" ;
record_param      = camel_name, "?", ":", "{", record_member, ",",
                    record_member, { ",", record_member }, [ "," ], "}" ;
record_member     = camel_name, [ ":", value_type ] ;
explicit_range_param
                  = camel_name, [ "?" ], ":", "range", "<",
                    value_type, ">" ;

value_type        = scalar_type, [ "|", "null" ] ;
scalar_type       = "string" | "integer" | "float" | "bool" |
                    "json" | "bytes" | "blob_ref" | "crdt" ;

dynamic_order     = "order", "by", camel_name, "default", camel_name,
                    "{", sort_profile, { sort_profile }, "}" ;
sort_profile      = camel_name, ":", ORDER_TERMS, ";" ;

dynamic_limit     = "limit", camel_name, "default", INTEGER,
                    "max", INTEGER ;

template_block    = "{", SQL_TEMPLATE, "}" ;

acknowledgement   = "allow", ( plan_finding | "plan" ), [ sql_name ],
                    SQL_STRING ;
plan_finding      = "scan" | "automatic_index" | "unbounded" |
                    "many_tables" ;
```

The semicolon before the query's closing brace terminates the complete query,
including dynamic `order by` and `limit` declarations. A semicolon inside the
authored SQL statement is not permitted. Semicolons inside atomic SQL strings
or comments are ordinary token contents.

`by qualifier.column` is valid only on a `sync query`.

An `acknowledgement` precedes the query it belongs to and follows §14.5.

## 5. Imports and predicate modules

Imports are relative, slash-separated `.syql` paths beginning with `./` or
`../`. Resolution is relative to the importing file and MUST remain inside the
configured query root. Missing modules, root escapes, import cycles, unknown
predicates, duplicate import targets, and duplicate reachable query names are
compile errors.

Only predicates may be imported. Queries are public entry points, not reusable
template fragments.

```syql
import { matchesTitle, visibleTo as canSee } from "./todo-predicates.syql";
```

## 6. Types and public inputs

The source types map to the target-neutral IR as follows:

| Source | IR meaning |
| --- | --- |
| `string` | UTF-8 text |
| `integer` | signed exact integer |
| `float` | finite floating-point number |
| `bool` | boolean |
| `json` | encoded JSON text |
| `bytes` | byte sequence |
| `blob_ref` | blob reference string |
| `crdt` | encoded CRDT bytes |

`T | null` describes a present value which may be SQL `NULL`. It is distinct
from an optional input.

```syql
query example(
  requiredId,
  status?: string | null,
  unassigned: bool = false,
) {
  select id from todos
  where id = :requiredId
    and when(status) status is :status
    and when(unassigned) assignee_id is null;
}
```

The signature is authoritative. Every input or record member MUST be used, and
every authored bind MUST be declared. An omitted type is inferred from all SQL
and predicate evidence. Conflicting evidence or insufficient evidence is a
compile error; an explicit type resolves otherwise uninferrable values.

### 6.1 Presence

For `x?: T`, absence and presence are different states. If `T` includes
`null`, the public runtime has three states: absent, present-null, and
present-value. Generated targets MUST preserve those states.

`flag: bool = false` is a normal boolean value with an omission default. Its
generated API may omit the argument, in which case its effective value is
`false`. It is active as a `when` control only when its effective value is
`true`.

### 6.2 Optional records

An optional record is atomic:

```syql
bounds?: { start: integer, end: integer }
```

It is either absent or present with every member. Partial objects, unknown
members, and invalid member values are runtime input errors. Member names are
SQL bind names within the query.

## 7. Range shorthand

The common inclusive-range case has dedicated sugar:

```syql
query createdBetween(range?) {
  select id, created_at from todos
  where when(range) created_at between :range;
}
```

Using `BETWEEN :range` promotes the declared input to an atomic range with
public shape `{ start, end }`. The compiler infers one element type from the
left SQL expression and lowers the expression to:

```sql
created_at between :__syqlRangeStart_range
               and :__syqlRangeEnd_range
```

Both endpoints have the same type and nullability. SQLite `BETWEEN` semantics
apply, so both bounds are inclusive. If inference is impossible, the author
may write `range?: range<integer>` (or another value type). A range input MUST
be used in `BETWEEN :name`; it cannot be passed to a reusable predicate.

An explicitly typed range always makes `BETWEEN :name` the shorthand form. An
untyped input is promoted when that form ends a SQL/`when` conjunct, including
`when(name) expression BETWEEN :name` followed by another conjunct. Within
such a same-name `when`, the shorthand interpretation takes precedence over
SQLite's ordinary two-expression `BETWEEN lower AND upper` form.

## 8. SQL statement

A query body directly contains one read-only SQLite `SELECT` or
`WITH ... SELECT` statement.

The reference realization, in which every conditional is active and default
sort/limit controls are selected, MUST prepare successfully against the schema.
Projection names and types are derived from SQLite and schema metadata;
the type of a computed column follows §14.4.

SYQL targets a portable SQLite 3.46.0 core profile. Non-core functions and
collations are rejected. Snapshot-external or nondeterministic constructs such
as `random()`, current-time keywords, `datetime('now')`, and
`last_insert_rowid()` are rejected. A nested `OFFSET`, a nested `LIMIT` other
than the bounded CTE body of §14.3, and window expressions are rejected
(`SYQL6003_NONDETERMINISTIC_SQL`) until the compiler can prove a local stable
identity and total order for those shapes.

A CTE declaration MAY carry SQLite's `AS MATERIALIZED` or `AS NOT MATERIALIZED`
hint. Each body of a top-level CTE whose first token is `SELECT` is a SELECT
scope of its own for scope proofs (§13), column lineage, and identity (§14). An
`ORDER BY` in a CTE body never orders the result; only the outer `ORDER BY`
does. With a body `LIMIT` (§14.3) it selects which rows the CTE keeps. §14.3
uses these rules for a ranked top-N.

## 9. Reusable predicates

A predicate is a closed SQL expression template:

```syql
predicate matchesTitle(value: string) {
  title like '%' || :value || '%'
}
```

Calls use ordinary function spelling:

```syql
and when(q) matchesTitle(:q)
```

A call whose name resolves to a local or imported predicate is expanded
hygienically. Its arguments MUST be named binds, its arity MUST match, and
types propagate through the call graph. Predicate bodies may call other
predicates. Cycles, undeclared predicate binds, unused predicate parameters,
and incompatible call types are errors.

A function-shaped expression that does not resolve to a SYQL predicate remains
an ordinary SQLite function call. It is then checked by the portable SQLite
profile. This rule avoids reserving a second call sigil while keeping calls
visually SQL-like.

## 10. Conditional predicates

`when` conditionally includes one complete outer `WHERE` or `HAVING` conjunct.

```syql
and when(status) status is :status

and when(filters) {
  priority >= :minimum
  and priority <= :maximum
}
```

The brace-free form consumes one SQL conjunct. Braces are REQUIRED when the
conditional body contains multiple conjuncts or needs an unambiguous boundary.

`when(x)` means:

- `present(x)` when `x` is an optional value, range, or record;
- `x = true` when `x` is a non-optional `bool = false` value.

Authors may spell the presence rule explicitly as `when(present(x))`. Explicit
`present` is valid only for optional inputs. Multiple controls are conjunctive:
`when(a, b)` is active only when both controls are active.

Every optional bind MUST be dominated by an active `when` that controls its
input. Every record member MUST be used under control of its record. A control
must govern a use of itself (or one of its members); guard-only flags are the
exception because their boolean value is itself the control.

`when` MUST occupy an entire outer conjunct. It cannot appear under `OR`, in a
nested subquery, as part of a larger expression, or in a compound outer
statement. These restrictions make both generated backends equivalent.

## 11. Dynamic sort

A dynamic sort is written at the SQL position where `ORDER BY` belongs:

```syql
order by sortBy default newest {
  newest: created_at desc, id desc;
  oldest: created_at asc, id asc;
  title: title collate nocase asc, id asc;
}
```

The control is a generated finite enum. Callers cannot supply arbitrary SQL.
Each profile is a complete `ORDER BY` term list and is validated against the
projection, portable collations/functions, determinism rules, and stable-order
requirements. A query cannot contain both an authored outer `ORDER BY` and a
dynamic order declaration.

For a bounded query, every profile MUST end in a compiler-proven unique suffix,
normally the projected primary key. This prevents page membership from changing
arbitrarily among tied rows.

## 12. Dynamic limit

The bounded dynamic limit is also written at its SQL position:

```syql
limit pageSize default 50 max 200;
```

It produces one optional integer input. The effective value defaults to 50 and
MUST be an integer in `1...200`. Every generated runtime validates the value
before executing SQL. The compiler lowers it to a checked internal limit bind.

An authored outer `LIMIT` or `OFFSET` conflicts with a dynamic limit.

## 13. Reactive dependencies

Every query reports tables it reads. The compiler additionally infers exact
scope keys from ordinary SQL predicates when it can prove them.

Given schema scope `list:{list_id}`, this predicate is constructive:

```sql
todos.list_id = :listId
```

Required equality and `IN` predicates over declared scope columns produce
exact dependencies. A predicate is a proof only when it is a whole top-level
conjunct of the `WHERE` clause of the SELECT scope that reads the instance:
the outer statement or the body of a top-level CTE (§8). Parentheses around a
whole conjunct are transparent. With `column` a declared scope column,
optionally qualified, the conjunct has one of these forms:

- `column = :bind`, `column == :bind`, or `column IS :bind`;
- `:bind = column` or `:bind == column`;
- `column IN (:a, :b)`, whose list holds binds only.

Nothing else proves a scope: a comparison under `NOT`, compared again
(`(column = :bind) = 0`, `column = :bind IS FALSE`), wrapped in a function,
`CASE`, or `IIF`, or followed by `COLLATE`; an `IN` list with a literal; a
`WHERE` clause with a top-level `OR`; a compound SELECT scope; predicates under
`when`, an ambiguous table reference, or any other nested statement. A table
without a proof keeps a table-wide dependency. Named `.sql` queries use the
same rule. A predicate proves only instances of its own scope, even when
another scope reuses the alias. A table
read through several instances (a self-join) produces one dependency when every
instance carries an identical scope proof: the same scope variables, each with
the same operator and the same set of parameters. If any instance of a read
table cannot be scoped safely, or the instances' proofs differ, that table
falls back to table-wide invalidation.

### 13.1 Ordinary query

`query` is a reactive local read. It declares dependencies but never claims
that its requested data window has been synchronized. Its coverage list is
empty.

### 13.2 Sync query

`sync query` explicitly requests and claims synchronization coverage:

```syql
sync query listTodos(listId) {
  select id, list_id, title from todos
  where todos.list_id = :listId;
}
```

Coverage MUST resolve every read schema table and bind at least one declared
scope of every table instance through required, non-null equality or `IN`
predicates. A multi-scope query MUST explicitly select its unit dimension with
`by`. The descriptor includes the selected scope and every other proven scope;
an unbound scope is omitted from the window base. The QueryIR contains one
coverage entry per read table; a client may report the query complete only when
all entries are complete. A generated descriptor's `coverage(params)` returns
the window bases of those entries ([SPEC.md §4.8](./SPEC.md#48-windowed-subscriptions)),
`{ base: { variable, fixedScopes? }, units }`. A base names no table, so
entries of tables proven by the same base are emitted once, and each fixed
scope holds one value.

A scope proof may propagate between qualified scope columns joined by a
required outer `WHERE` equality or by a simple mandatory `ON` equality. Either
equality is a whole conjunct `a.x = b.y` (or `==`) of two qualified scope
columns. For
example, `details.list_id = todos.list_id` inherits the required bind proven for
`todos.list_id`. An `ON` clause containing `OR`, `NOT`, a subquery, or a CTE is
not a proof. Only the §13 conjunct forms prove a scope. An `IN` proof may
contain only required binds. Otherwise compilation
fails; it never silently widens coverage or treats invalidation as readiness.
Comma-separated table sources are outside the proof-compatible SQL subset and
MUST fail generation with guidance to use an explicit `JOIN ... ON` relation.

A table read through several instances (a self-join) claims coverage only when
every instance carries an identical scope proof: the same scope variables, each
with the same operator and the same set of parameters, whether proven directly
or inherited through a join equality. Identical proofs select the same window
base and the same units, so the compiler emits one coverage entry and one
dependency for that table. An unproven instance, or instances whose proofs
differ in any parameter, operator, unit dimension, or fixed scope, fail
compilation: the table-level readiness boundary has one window base per table
and cannot represent two instances with different scopes.

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

This query has one coverage entry for `catalogue_codes/catalogue_set_id` and
one for `catalogue_relations/catalogue_set_id`, each with unit
`:catalogueSetId`. The `by` anchor of a multi-scope self-join may name any of
its instances.

```syql
sync query listTodosWithDetails(listId) {
  select t.id, t.title, d.body
  from todos as t
  left join todo_details as d
    on d.todo_id = t.id and d.list_id = t.list_id
  where t.list_id = :listId;
}
```

This query has aggregate coverage for both `todos/list_id` and
`todo_details/list_id`. The optional `d.body` result is nullable independently
of that completeness proof.

For a table with more than one scope, the query selects the unit dimension:

```syql
sync query threadMessages(roomId, left, right) by messages.thread_id {
  select id, room_id, thread_id, body from messages
  where messages.room_id = :roomId
    and messages.thread_id in (:left, :right);
}
```

The selected dimension may use equality or `IN`. Every other proven scope is
fixed by exactly one required equality bind. `by` names the SQL table name or alias used
by the selected anchor instance and one of its declared scope columns. A joined
single-scope table uses its sole dimension. A joined multi-scope table must have
exactly one proven dimension with the anchor's unit parameters and exact
fixed-scope proofs for its other proven dimensions; otherwise the query must be
split. A predicate binding two scope dimensions therefore produces their
intersection, while a query that binds only one requests that scope alone.
The server authorizes the requested scope values; declaring a scope on a table
does not grant it. Scoped remote query registration retains its stricter
requirement to cover every declared variable ([REMOTE.md §2.1](./REMOTE.md)).

## 14. Result types and identity

### 14.1 Outer-join nullability

A projected plain column MUST retain its schema type and schema nullability.
The compiler MUST additionally mark it nullable whenever SQL outer-join
semantics can synthesize `NULL` for its resolved table alias:

- `LEFT [OUTER] JOIN` null-extends the new right relation;
- `RIGHT [OUTER] JOIN` null-extends every prior relation in that join chain;
- `FULL [OUTER] JOIN` null-extends both sides;
- `INNER`, `CROSS`, and ordinary `JOIN` introduce no new nullability and MUST
  NOT erase nullability introduced earlier in the chain.

A parenthesized relation group is one relation unit for its enclosing join.
Outer null-extension applies to every physical relation inside the optional
group, while nested joins retain their own left-to-right semantics. Physical
tables read inside derived subqueries remain dependencies even when the derived
alias cannot provide an exact column origin.

This rule applies independently of a physical column's `NOT NULL` declaration
and is shared by every generated target. A result expression whose physical
origin or join-side nullability cannot be proven MUST use the documented
nullable (§14.4) or fail compilation; it MUST NOT be emitted as required.
Unqualified columns coalesced by `USING` or `NATURAL JOIN` MUST NOT be assigned
an arbitrary single-table origin.

### 14.2 Result identity

The compiler infers result identity conservatively from schema primary keys,
table references, joins, aliases, and projected result names. A simple
projection containing a base table's primary key commonly produces that
projected column as the row key.

When identity cannot be proved, it is omitted and consumers use unkeyed
reconciliation. A SELECT scope that reads one table through several instances
has no inferred identity, because one instance's primary key does not identify
a joined result row. A stable identity is required when another feature, such
as a bounded dynamic sort, depends on it.

A statement with top-level CTEs proves identity per SELECT scope (§8). Every
scope MUST be one `SELECT` without `DISTINCT`, `GROUP BY`, aggregates,
compound operators, outer joins, or subqueries, and MUST read each table at
most once; `WITH RECURSIVE`, a CTE column list, or any other nested statement
leaves the query without inferred identity. Within a scope:

- a physical relation contributes its primary key, and an FTS projection its
  `_syncular_source_id`;
- a reference to a CTE contributes the identity proven for the CTE body, under
  the body's result names;
- a physical relation joined by a required inner `ON` conjunct
  `rel.pk = cte.key`, where `cte.key` is part of that CTE's identity,
  contributes nothing, because each CTE row matches at most one of its rows.
  The conjunct MUST be a plain equality of two qualified columns in an `ON`
  clause without `OR`, `NOT`, `CASE`, `BETWEEN`, `COLLATE`, or a subquery.

Each contributed column MUST appear in the scope's projection as a plain column
reference, qualified unless the scope reads one relation, and every outer
identity field MUST be non-null. A bounded
order ends with the identity terms, qualified by the relation that contributes
them.

### 14.3 Ranked top-N

A bounded query that ranks many candidate rows and returns a few wide rows
ranks narrow rows in a CTE that keeps only the first rows, and reads the wide
row in the outer scope:

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

The CTE identity is `(fts_source_id, code_id)`. `c` is determined by
`c.id = ranked.code_id`, so the result identity is `(ftsSourceId, id)` and the
order ends with the two CTE identity terms. Each `codes` instance carries the
same `set_id` proof in its own scope, so the query has one coverage entry.

A top-level CTE body MAY end in `LIMIT <n>`, where `n` is an integer literal of
at least 1. The body MUST NOT carry `OFFSET`, its identity MUST be proven
(§14.2), and its `ORDER BY` MUST end with every identity term, each spelled as
the term's result alias or as its projected column. The order is then total,
so the CTE keeps the same `n` rows for the same database state. Any other body
`LIMIT` fails with `SYQL6003_NONDETERMINISTIC_SQL`. The outer scope returns the
plain form's rows only when it removes none of the kept rows: apply every
filter inside the CTE and repeat the CTE order in the outer `ORDER BY`.
SQLite keeps at most `n` rows in the CTE sort and reads the wide row only for
the rows it returns.

The CTE MAY instead omit its `LIMIT` and carry `AS MATERIALIZED`. SQLite then
sorts every candidate inside the materialization. `CROSS JOIN` keeps the CTE
scan as SQLite's outer loop, and SQLite 3.51 and later satisfy the outer order
from the materialized rows (`MATERIALIZE ranked`, `SCAN ranked`, a primary-key
`SEARCH` of `c`). The full sort costs more than the plain one-scope
`ORDER BY ... LIMIT` on narrow rows: on 50,000 hits it measured about 86 ms
against 65 ms on macOS arm64 and 140 ms against 99.8 ms on a Linux x64 CI
runner (Bun 1.4.0). It pays off only when the wide row is large; rows of about
21 KB read about 30 % faster. SQLite 3.46.0, the floor of the portable
profile, sorts the joined rows of that form again and returns the same result.
The browser build and the Rust core bundle SQLite 3.53.

### 14.4 Computed result columns

A result column that SQLite reports no declared type for is a computed column.
SQLite exposes no expression type at prepare time, so the compiler takes the
type from the query text and never infers it from the expression's operators or
function names. The compiler applies these rules in order:

1. A column with a declared type SQLite reports keeps that type, mapped like a
   schema column type.
2. A column whose whole expression is `CAST(<expr> AS <type>)` has the mapped
   type of `<type>` for `INTEGER`, `INT`, `BIGINT`, `SMALLINT`, `TEXT`, `REAL`,
   `FLOAT`, `DOUBLE`, `BLOB`, `BOOLEAN` and `BOOL`. SQLite performs the cast at
   run time, so every language receives a value of that storage class or
   NULL. `BOOLEAN` and `BOOL` have NUMERIC affinity: the expression must
   produce 0 or 1, and the generated decoder rejects any other value. The
   other schema column type names (`JSON`, `JSONB`, `BYTEA`, `BLOB_REF`,
   `BLOBREF`, `CRDT`) are refused, because their CAST affinity can change the
   value; cast a JSON expression to `TEXT`. A cast that is an
   operand, a function argument, or the left side of any operator
   is not the whole expression: `CAST(a AS INTEGER) + 1` has no type.
3. A column whose whole expression is `count(...)`, including `count(*)` and
   `count(DISTINCT x)`, is `integer`. `count(...)` with `FILTER` or `OVER` is
   not the whole expression.
4. Any other computed column fails compilation with
   `typegen.computed_column_type`. The error details carry the query name and
   the column name, and the message instructs the author to wrap the
   expression in `CAST(... AS <type>)`.

Every computed column is nullable. Any other `CAST` target fails under rule 4. These rules apply to `.syql` queries through §8
and to plain `.sql` queries alike; a `.syql` query reports the failure as
`SYQL6002_INVALID_SQL`, whose message contains the same text.

### 14.5 Query plan check

The compiler runs `EXPLAIN QUERY PLAN` on every physical statement (§15) of
every query, `.syql` and plain `.sql` alike, against the schema database of §8.
That database holds every declared table and index and no `sqlite_stat1`
statistics. Neither client runs `ANALYZE`, so a client plans without
statistics as well. The check reports four findings whose answer depends only
on the schema and the statement, never on row counts or the SQLite version:

| Code | Finding |
| --- | --- |
| `typegen.query_scan` | A plan scans a table, and an index on one column of that table removes a scan from the plan. The compiler finds those columns by planning the statement again once per column with a single-column index added. |
| `typegen.query_automatic_index` | A plan row uses an `AUTOMATIC` index: SQLite builds a transient index on every execution because no declared index serves the join constraint. |
| `typegen.query_unbounded` | The statement has no `WHERE` and no `LIMIT` outside parentheses, and a top-level plan row scans a table. The statement reads every row of that table. |
| `typegen.query_many_tables` | The query reads more than four tables. Every table is a reactive dependency (§13), so a change to any of them re-runs the query. |

A finding fails compilation. The error details carry `query`, `file` and, per
kind:

- `typegen.query_scan`: `statement`, `sql`, `table`, `columns` (the columns
  whose index removes the scan) and `plan` (the plan's detail lines);
- `typegen.query_automatic_index`: `statement`, `sql`, `table`, `columns`
  (the automatic index's key columns) and `plan`;
- `typegen.query_unbounded`: `statement`, `sql`, `table` and `plan`;
- `typegen.query_many_tables`: `tables`.

`statement` is the index of the physical statement in the query's execution
plan, `0` for a `.sql` query. `table` is the schema table the plan reads; a
plan row on a CTE names the CTE.

The check does not report which index the planner chooses, temporary B-trees
for `ORDER BY` or `GROUP BY`, or a cost. Statistics, row counts and the SQLite
version decide those.

An author resolves a finding by changing the query, by declaring an index, or
by acknowledging it on the query. An acknowledgement names the finding kind,
the table for every kind except `many_tables`, and a reason. It silences every
finding of that kind and table in every physical statement of its query. An
acknowledgement that matches no finding of its query fails compilation with
`typegen.query_acknowledgement_unused`, whose details carry `query`, `file`,
`finding` and `table`.

The acknowledgement `plan` names no table and acknowledges every finding of
its query. It marks a query that only the server runs as a registered query
(REMOTE.md §2), whose plan the server's database decides and the client
schema database does not predict. `plan` is the only acknowledgement of its
query, and a `plan` acknowledgement on a query with no finding fails with
`typegen.query_acknowledgement_unused` (`finding` is `plan`, `table` is
null).

In a `.syql` source, acknowledgements precede the query (§4). The reason is a
SQL string literal and MUST contain a non-blank character. A malformed
acknowledgement, an acknowledgement before a predicate, and a second
acknowledgement of the same kind and table on one query fail with
`SYQL2013_INVALID_ACKNOWLEDGEMENT`.

```syql
allow unbounded settings 'one row per setting key, at most 40 rows'
query allSettings() {
  select key, value from settings order by key;
}
```

In a `.sql` source, an acknowledgement is a line comment in the statement's
leading comment block, beside `-- name:` and `-- param`:

```sql
-- allow scan tasks: the filter reads at most 200 rows of one list
-- allow many_tables: the report joins five tables once per export
-- allow plan: registered on the server, which runs it on Postgres
```

A leading comment whose words after `--` are `allow` and a finding kind is an
acknowledgement. The kind is followed by the table (absent for
`many_tables`), a colon, and a non-blank reason. A comment of that form that
does not parse, a second acknowledgement of the same kind and table on one
statement, and `plan` beside another acknowledgement fail with
`typegen.query_acknowledgement_invalid`, whose details
carry `file` and `comment`.

## 15. Lowering and execution

The logical query is lowered to one target-neutral physical plan. Conditions
can be implemented by either backend:

- `variants`: enumerate the finite activation masks and omit inactive
  conjuncts;
- `neutralize`: retain one statement per sort profile and guard each
  conditional with a compiler-generated boolean bind.

Every physical statement also records its resolved physical table occurrences
and their UTF-16 source boundaries in positional SQL. The TypeScript descriptor
exports these statement-specific relation plans for authoritative server reads
under [REMOTE.md §2](./REMOTE.md#2-registered-queries). Aliases and quoted table
names retain exact boundaries. CTE references resolve through lexical query
scopes; their physical source relations remain dependencies. A compiler MUST
reject a relation whose identity it cannot resolve. Server registration
requires this metadata and never infers partition isolation from a deduplicated
table-name list.

**FTS source ids.** Reading an FTS projection's `_syncular_source_id` makes
FTS5 fetch the content row of every hit. The client keeps a mapping table for
each projection whose `id` equals the projection rowid (SPEC client-local FTS5
projections). The compiler lowers every FTS relation that `FROM` or an inner
`JOIN` introduces: it adds a join to the mapping table on `rowid` after the
relation's join constraint, and every reference that binds to that relation
reads the mapping's `source_id`. The added columns carry compiler-private
`__syql_fts_` names, and a bare projected reference keeps its result name
through an explicit alias. The authored SQL keeps its types, identity, and
coverage; SQLite prepares the lowered statement against the schema and MUST
return the authored result names. A null-extended FTS relation and a reference
the compiler cannot bind with certainty keep reading the projection. The
mapping table is not a relation an author can name.

`auto` chooses variants for a small condition count and neutralization
otherwise. Both backends MUST return the same rows for the same public input.
Sort profiles multiply physical statements. The dynamic limit remains a bind
and does not multiply them.

Compiler-generated binds are private and MUST NOT appear in public APIs.
Generated runtimes MUST reject unknown inputs, missing required inputs,
malformed presence wrappers, partial records/ranges, invalid enum cases, and
out-of-range limits before querying.

Exact integers remain exact: TypeScript SYQL APIs use `bigint`; Swift uses
`Int64`; Kotlin uses `Long`; Dart uses `int`; Rust uses `i64`. Generated Rust
also accepts the core's lossless `$bigint` result envelope without passing the
value through a JSON double.

## 16. Formatter

The canonical formatter is a lossless-token rewrite. It normalizes trivia and
SQL keyword case while preserving atomic token spellings and comment order.
Before returning output, it parses both forms and verifies span-free semantic
AST equality. Canonical formatting is byte-idempotent.

Optional records remain inline in signatures. SQL clauses and `and` conjuncts
are line-oriented. Simple sort profiles remain one line. Each acknowledgement takes one line directly
above its query.

## 17. Diagnostics

Diagnostics have stable codes grouped by compiler phase:

| Range | Phase |
| --- | --- |
| `SYQL1xxx` | lexical analysis |
| `SYQL2xxx` | container parsing |
| `SYQL3xxx` | embedded-template parsing |
| `SYQL4xxx` | module resolution |
| `SYQL5xxx` | semantic analysis |
| `SYQL6xxx` | schema/SQL validation |
| `SYQL7xxx` | lowering |
| `SYQL8xxx` | formatting |
| `SYQL9xxx` | project/editor context |

The conformance fixtures pin primary codes and selected source positions.
Messages may add context without changing the code's meaning.

The reference compiler exports `SYQL_DIAGNOSTIC_REMEDIES`, a complete mapping
from every compiler and generated-runtime diagnostic code to one remediation
instruction. `generateSyqlDiagnosticCatalog()` returns the mapping as a
code-sorted JSON-ready array. The language server includes the mapped text in
`Diagnostic.data.remedy`. A new diagnostic code MUST add its remedy in the
same change.

## 18. Complete example

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
