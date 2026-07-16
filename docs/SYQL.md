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

query             = [ "sync" ], "query", camel_name, "(",
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
```

The semicolon before the query's closing brace terminates the complete query,
including dynamic `order by` and `limit` declarations. A semicolon inside the
authored SQL statement is not permitted. Semicolons inside atomic SQL strings
or comments are ordinary token contents.

`by qualifier.column` is valid only on a `sync query`.

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
Projection names and types are derived from SQLite and schema metadata.

SYQL targets a portable SQLite 3.46.0 core profile. Non-core functions and
collations are rejected. Snapshot-external or nondeterministic constructs such
as `random()`, current-time keywords, `datetime('now')`, and
`last_insert_rowid()` are rejected. Nested `LIMIT`/`OFFSET` and window
expressions are rejected until the compiler can prove a local stable identity
and total order for those shapes.

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

Required equality and `IN` predicates over declared scope columns may produce
exact dependencies. The predicate must be an unconditional outer conjunct;
predicates under `when`, `OR`, or an ambiguous table reference do not. If any
instance of a read table cannot be scoped safely, that table falls back to
table-wide invalidation.

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

Coverage MUST resolve to exactly one instance of the covered table and MUST
bind every scope declared by that table through required, non-null equality or
`IN` predicates. A self-join therefore cannot claim coverage. Scope predicates
under `OR`, negation, a conditional, or a nested query are not proofs. An `IN`
proof may contain only required binds. Otherwise compilation fails; it never
silently widens coverage.

For a table with more than one scope, the query selects the unit dimension:

```syql
sync query threadMessages(roomId, left, right) by messages.thread_id {
  select id, room_id, thread_id, body from messages
  where messages.room_id = :roomId
    and messages.thread_id in (:left, :right);
}
```

The selected dimension may use equality or `IN`. Every other scope is fixed by
exactly one required equality bind. `by` names the SQL table name or alias used
by the selected instance and one of its declared scope columns.

## 14. Result identity

The compiler infers result identity conservatively from schema primary keys,
table references, joins, aliases, and projected result names. A simple
projection containing a base table's primary key commonly produces that
projected column as the row key.

When identity cannot be proved, it is omitted and consumers use unkeyed
reconciliation. A stable identity is required when another feature, such as a
bounded dynamic sort, depends on it.

## 15. Lowering and execution

The logical query is lowered to one target-neutral physical plan. Conditions
can be implemented by either backend:

- `variants`: enumerate the finite activation masks and omit inactive
  conjuncts;
- `neutralize`: retain one statement per sort profile and guard each
  conditional with a compiler-generated boolean bind.

`auto` chooses variants for a small condition count and neutralization
otherwise. Both backends MUST return the same rows for the same public input.
Sort profiles multiply physical statements. The dynamic limit remains a bind
and does not multiply them.

Compiler-generated binds are private and MUST NOT appear in public APIs.
Generated runtimes MUST reject unknown inputs, missing required inputs,
malformed presence wrappers, partial records/ranges, invalid enum cases, and
out-of-range limits before querying.

Exact integers remain exact: TypeScript SYQL APIs use `bigint`; Swift uses
`Int64`; Kotlin uses `Long`; Dart uses `int`.

## 16. Formatter

The canonical formatter is a lossless-token rewrite. It normalizes trivia and
SQL keyword case while preserving atomic token spellings and comment order.
Before returning output, it parses both forms and verifies span-free semantic
AST equality. Canonical formatting is byte-idempotent.

Optional records remain inline in signatures. SQL clauses and `and` conjuncts
are line-oriented. Simple sort profiles remain one line.

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
