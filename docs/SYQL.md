# SYQL Language Specification

- **Status:** Draft, normative upon acceptance of
  [RFC 0004](./rfcs/0004-syql-language.md)
- **Specification revision:** 1
- **Date:** 2026-07-14
- **File extension:** `.syql`
- **Encoding:** UTF-8

## 0. Status and terminology

This document defines the SYQL source language, static semantics, lowering
contract, and conformance requirements. Once RFC 0004 is accepted, this
document supersedes descriptive SYQL grammar in `docs/DESIGN-queries.md`, the
typegen README, implementation comments, tests, editor grammars, and examples.
Those artifacts may explain or implement the language but may not contradict
this specification.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be
interpreted as normative requirements.

This specification uses these terms:

- **container syntax:** SYQL declarations, imports, signatures, sections,
  predicate calls, `when`, `@scope`, and `@cover`;
- **SQL token:** a token whose spelling and lexical meaning belong to SQLite;
- **SQL template:** SQLite tokens containing the explicitly permitted SYQL
  nodes;
- **bind:** a colon-prefixed value reference such as `:listId`;
- **control:** an optional scalar, optional group, or switch named by `when`;
- **logical query:** the backend-independent result after imports, name/type
  resolution, and predicate expansion but before neutralized/enumerated SQL;
- **executable statement:** one concrete SQLite statement the generated
  runtime may execute;
- **source name:** the SQL-facing spelling in SYQL;
- **language name:** a target-language spelling derived by the configured
  naming map.

The grammar defined here is a destructive replacement for the earlier
prototype. There is no source version marker and no compatibility mode.

## 1. Design contract

SYQL is a compile-time container around SQLite. It adds operation inputs,
explicit conditional conjuncts, hygienic reusable predicates, constructive
reactive predicates, finite sort profiles, bounded page size, and checked row
identity. It does not replace SQLite's relational or expression language.

Every conforming implementation SHALL preserve these invariants:

1. User values enter executable SQL only through bound parameters.
2. Runtime-selected SQL text comes only from finite author-written sort
   profiles or compiler-generated text checked at generation.
3. Ordinary SQL token values are not changed by container transformations.
4. Query signatures and group membership are authoritative.
5. Optional behavior is expressed only by `when`.
6. Absent, present-null, present-value, false, and true have the distinct
   semantics defined in §8.
7. Reactive precision is generated only by constructive `@scope`/`@cover`
   restrictions; their absence falls back conservatively.
8. Every executable statement is accepted by SQLite against the generated
   schema before code is emitted.
9. All requested target emitters implement the same logical query and error
   behavior.

## 2. Source text and lexical rules

### 2.1 Encoding and line endings

A source file MUST be valid UTF-8. A leading UTF-8 byte-order mark is accepted
as trivia. Implementations MUST accept LF and CRLF line endings. Line-ending
choice has no semantic meaning except that it terminates a line comment.

Source positions used in diagnostics MUST identify a file, a one-based line,
and a one-based source column. LSP implementations SHALL convert source
positions to UTF-16 code units at the protocol boundary.

### 2.2 Trivia

Outside SQL string and quoted-identifier tokens, trivia consists of:

- ASCII whitespace (`U+0009`–`U+000D`) and space
  (`U+0020`);
- a line comment beginning with `--` and ending immediately before LF, CRLF,
  or end-of-file;
- a block comment beginning with `/*` and ending at the next `*/`.

Block comments do not nest. An unterminated string, quoted identifier, bracket
identifier, or block comment is a lexical error; it MUST NOT be silently
treated as end-of-file.

Comments have no query semantics, but their exact text MUST survive parsing and
formatting. A compiler MAY omit comments from embedded executable SQL only
after tokenization, without changing neighboring token boundaries or line
comment extent.

### 2.3 Identifiers

The lexical nonterminal `IDENT` is:

```text
[A-Za-z_][A-Za-z0-9_]*
```

The lexical nonterminal `CAMEL_IDENT` is:

```text
[a-z][A-Za-z0-9]*
```

The lexical nonterminal `INTEGER_LITERAL` is:

```text
0|[1-9][0-9]*
```

Leading signs, separators, radix prefixes, exponents, and decimal points are
not part of an `INTEGER_LITERAL`. Static range rules still apply under §12.

Query names, predicate names, imported local names, scalar input names, group
names, group member names, sort control names, page control names, and sort
profile names MUST be `CAMEL_IDENT` values. SQL identifiers inside templates
remain SQLite identifiers and may use snake_case or SQLite quoting.

Names beginning with `__syql` in any casing are reserved. A source declaration,
bind, alias exposed to container syntax, or generated public parameter MUST NOT
use the reserved prefix.

Container keywords are lowercase and case-sensitive. The following spellings
are reserved and MUST NOT be used as a `CAMEL_IDENT` name:

```text
as blob_ref boolean by bytes cover crdt default float from identity import in
integer json max null page predicate query scope sort sql string switch when
```

SQL keywords inside SQL templates retain SQLite's case-insensitive behavior.

### 2.4 Strings and quoted identifiers

The shared lexer MUST recognize and preserve at least the SQLite lexical forms
which SYQL accepts:

- single-quoted SQL strings, with `''` representing one quote;
- double-quoted identifiers, with `""` representing one double quote;
- backtick-quoted identifiers, including SQLite-supported escaping;
- bracketed identifiers from `[` through the matching `]`;
- blob literals such as `X'CAFE'` as SQLite token sequences whose adjacency is
  preserved;
- numeric literals and all SQLite operators supported by the pinned SQLite
  runtime, including multi-character operators.

A colon-like sequence, `@name`, brace, keyword, comment marker, or semicolon
inside a string or quoted identifier has no container meaning.

Import paths use JSON-style double-quoted strings, not SQL strings.

SQLite's legacy double-quoted-string fallback is not part of SYQL. A
double-quoted SQL token is always an identifier and must resolve as one where
SQLite requires resolution; it is never reinterpreted as a string literal.

### 2.5 Binds

A user bind token is `:` immediately followed by a `CAMEL_IDENT`:

```syql
:listId
```

The SQLite parameter forms `?`, `?NNN`, `$name`, and `@name` are forbidden in
SYQL SQL templates. `@` is reserved for SYQL predicate calls and reactive
directives. Compiler-generated binds use the reserved `__syql` namespace and
cannot be authored.

A bind-shaped sequence inside a string, quoted identifier, or comment is not a
bind.

### 2.6 Punctuation and semicolons

Container imports, `page`, and `identity` declarations use a terminating
semicolon as shown by the grammar. SQL statement and predicate templates MUST
NOT contain a semicolon token. A semicolon inside a string or quoted identifier
is ordinary token content.

Braces delimit container blocks. Braces inside SQL strings, quoted identifiers,
or comments do not affect block depth.

### 2.7 SQLite dialect profile

Specification revision 1 targets SQLite 3.46.0 syntax and core semantics. A
generator running a newer SQLite MUST still validate against that profile and
MUST NOT accept syntax introduced after 3.46.0 merely because its host engine
accepts it. A runtime older than 3.46.0 is not a conforming execution target for
revision 1.

Only SQLite core language features and built-in functions available in the
standard 3.46.0 amalgamation are portable SYQL. Compile-option-dependent
modules/functions, loadable extensions, application-defined SQL functions, and
application-defined collations are outside revision 1. The portable collations
are `BINARY`, `NOCASE`, and `RTRIM`. Schema features explicitly modeled and
validated by Syncular remain subject to §9.1.

Every supported client engine MUST be initialized with behavior-affecting
SQLite options compatible with the reference profile. Conformance runs the
same executable query corpus on the reference validator and every shipped
client engine; generation support cannot be inferred from the generator's
SQLite version alone. Moving the floor or admitting a compile-option-dependent
feature requires a specification revision and cross-runtime fixtures.

## 3. Container grammar

The grammar uses ISO-style EBNF:

- `{ X }` means zero or more repetitions;
- `[ X ]` means optional;
- `( X | Y )` means alternatives;
- quoted text is a literal token;
- `SQL_STATEMENT_TEMPLATE`, `SQL_EXPRESSION_TEMPLATE`, and
  `SQL_ORDER_LIST` are token-sequence nonterminals constrained by §§6–11.

```ebnf
file                  = { import-declaration }, { declaration } ;

import-declaration    = "import", "{", import-list, "}",
                        "from", IMPORT_PATH, ";" ;
import-list           = import-item, { ",", import-item }, [ "," ] ;
import-item           = CAMEL_IDENT, [ "as", CAMEL_IDENT ] ;

declaration           = predicate-declaration | query-declaration ;

predicate-declaration = "predicate", CAMEL_IDENT,
                        "(", [ predicate-parameter-list ], ")",
                        "{", SQL_EXPRESSION_TEMPLATE, "}" ;
predicate-parameter-list
                      = predicate-parameter,
                        { ",", predicate-parameter }, [ "," ] ;
predicate-parameter   = CAMEL_IDENT, [ ":", value-type ] ;

query-declaration     = "query", CAMEL_IDENT,
                        "(", [ query-parameter-list ], ")",
                        "{",
                          sql-section,
                          [ sort-section ],
                          [ page-declaration ],
                          [ identity-declaration ],
                        "}" ;

query-parameter-list  = query-parameter,
                        { ",", query-parameter }, [ "," ] ;
query-parameter       = value-parameter | switch-parameter
                      | group-parameter ;

value-parameter       = CAMEL_IDENT, [ "?" ], [ ":", value-type ] ;
switch-parameter      = CAMEL_IDENT, "?", ":", "switch" ;
group-parameter       = CAMEL_IDENT, "?", "(", group-member-list, ")" ;
group-member-list     = group-member, ",", group-member,
                        { ",", group-member }, [ "," ] ;
group-member          = CAMEL_IDENT, [ ":", value-type ] ;

value-type            = base-type, [ "|", "null" ] ;
base-type             = "string" | "integer" | "float" | "boolean"
                      | "json" | "bytes" | "blob_ref" | "crdt" ;

sql-section           = "sql", "{", SQL_STATEMENT_TEMPLATE, "}" ;

sort-section          = "sort", CAMEL_IDENT, "default", CAMEL_IDENT,
                        "{", sort-profile, { sort-profile }, "}" ;
sort-profile          = CAMEL_IDENT, "{", SQL_ORDER_LIST, "}" ;

page-declaration      = "page", CAMEL_IDENT,
                        "default", INTEGER_LITERAL,
                        "max", INTEGER_LITERAL, ";" ;

identity-declaration  = "identity", "by", result-name-list, ";" ;
result-name-list      = IDENT, { ",", IDENT } ;
```

A file MAY contain no declarations, although generation SHOULD warn for a
configured query file that contributes nothing. A file containing predicates
only is a valid import library. A query MUST use the section order shown above;
the formatter does not reorder a syntactically different member order because
that order is invalid.

`IMPORT_PATH` is a JSON string token whose decoded value is constrained by
§4.1. `SQL_STATEMENT_TEMPLATE` is a lossless SQL token sequence with the
embedded nodes allowed by §§6, 8, and 10 and the statement rules in §9.
`SQL_EXPRESSION_TEMPLATE` is the corresponding non-empty SQLite expression
token sequence. `SQL_ORDER_LIST` is defined in §11.2. These template
nonterminals are parsed structurally enough to locate embedded nodes and outer
clauses; they are not raw substrings.

The implementation MUST reject unknown container members and keywords rather
than treating them as SQL or ignoring them.

## 4. Imports and declaration scope

### 4.1 Import resolution

An import path is resolved relative to the importing file, canonicalized, and
MUST remain inside the configured queries root. It MUST identify a `.syql`
file. Absolute paths, URL schemes, package specifiers, glob imports, directory
imports, and paths escaping the queries root are errors.

Import matching is case-sensitive. The imported name MUST resolve to a
`predicate` declaration. Query declarations cannot be imported or called.

```syql
import {
  visibleTodos,
  matchesTitle as titleMatches,
} from "./shared/todos.syql";
```

The name after `as`, or the imported name when no alias is present, enters the
file's predicate scope.

### 4.2 Name uniqueness

Within one file:

- declaration names MUST be unique across queries and predicates;
- imported local names MUST be unique and MUST NOT collide with local
  declarations;
- duplicate import items are errors even when they refer to the same target.

Across the configured queries root, query names MUST be globally unique because
they become generated API names. This uniqueness check includes names produced
by the plain `.sql` frontend in the same generation run. Predicate names are
module-scoped and need not be globally unique.

### 4.3 Import and predicate cycles

The compiler MUST construct the reachable import/declaration graph. Any cycle
containing import edges or predicate-call edges is a static error. The
diagnostic MUST show at least one complete cycle path.

An acyclic graph has no semantic maximum depth. Implementations MAY apply a
documented resource limit to total expanded tokens, but MUST NOT reject a valid
acyclic graph merely because it exceeds an arbitrary predicate depth such as
ten.

### 4.4 Unused declarations and imports

An unused imported local name is a warning. An unused local predicate MAY be a
warning because the file can be imported elsewhere. Unused query parameters
and group members are errors under §7.4.

## 5. Types and abstract input values

### 5.1 Base types

SYQL base types map to QueryIR and host types as follows:

| SYQL | QueryIR | Abstract values |
| --- | --- | --- |
| `string` | `string` | Unicode string |
| `integer` | `integer` | signed 64-bit integer, −2⁶³ through 2⁶³−1 |
| `float` | `float` | finite IEEE-754 binary64 value |
| `boolean` | `boolean` | true or false |
| `json` | `json` | valid JSON value under Syncular's JSON binding contract |
| `bytes` | `bytes` | byte sequence |
| `blob_ref` | `blob_ref` | Syncular blob reference string/value |
| `crdt` | `crdt` | encoded CRDT bytes/value accepted by the client |

`switch` is a control type, not a SQL value type. It cannot be used as a user
bind or predicate parameter.

Integer transport is exact. A target whose ordinary number/JSON representation
cannot preserve every signed 64-bit value MUST use a lossless host type and a
tagged/string bridge representation; conversion through an IEEE-754 double is
not conforming. JavaScript number inputs are accepted as integers only within
the safe-integer range; full-range values use `bigint` or an equivalent checked
representation. Float inputs reject NaN and infinities.

### 5.2 Nullability

`T | null` admits SQL `NULL` as a present value. Plain `T` does not. Column
nullability does not silently make an input nullable; the source annotation
must admit `null` when the public API is expected to accept it.

Examples:

```syql
status: string
status?: string
status: string | null
status?: string | null
```

These represent, respectively:

1. required non-null string;
2. absent or present non-null string;
3. required value which may be null;
4. absent, present null, or present non-null string.

### 5.3 Required and optional scalars

A scalar without `?` is required. A scalar with `?` is optional and becomes a
`when` control.

The abstract runtime value of an optional scalar is:

```text
Absent | Present(value)
```

This state is independent of whether `value` is null. A conforming generated
API MUST preserve that distinction. TypeScript MAY use property absence for
`Absent` when `null` is not admitted. For a nullable optional, and on native
targets where nested optionality is not reliable, the emitter MUST generate an
explicit input enum/wrapper with absent, null, and value cases.

### 5.4 Switches

A switch declaration has the exact form:

```syql
unassigned?: switch
```

A switch is always optional. It has three accepted host inputs—absent, false,
and true—but absent and false both make `when(unassigned)` inactive. True makes
it active. A switch name MUST NOT appear as a user bind.

### 5.5 Named groups

A group is always optional and contains at least two members:

```syql
range?(start: integer, end: integer)
```

Its abstract runtime value is:

```text
Absent | Present({ start: value, end: value })
```

Every member is required when the group is present. A generated API MUST expose
the group as one optional object/struct rather than independent optional
arguments. Untyped bridges MUST reject a partially supplied group before query
execution.

The group name is a `when` control. Group member names are bind names. The group
name itself is not a bind.

### 5.6 Type annotations and inference

Annotations are constraints. When an input or predicate parameter lacks an
annotation, the compiler infers one base type from all checked uses after
predicate expansion. Revision 1 inference recognizes exactly:

- comparison of a bind with a plain physical column;
- a bind in an `IN` list governed by a plain physical column;
- either endpoint of `BETWEEN` governed by a plain physical column;
- a bind used as the right operand, or inside the right expression, of
  `LIKE` as `string`;
- a checked predicate parameter annotation propagated to its actual bind;
- a bind used by `@scope` or `@cover`, governed by its resolved schema scope
  column.

All evidence for one bind MUST resolve to one base type. Conflicting evidence
is an error naming the conflicting sites. If there is no supported evidence,
the source MUST provide an annotation.

An annotation inconsistent with checked column/predicate evidence is an error.
An additional inference shape requires a specification revision and normative
fixtures. A compiler MUST NOT silently accept implementation-specific evidence
which another conforming revision-1 compiler would reject.

Nullability is never inferred into a public input; it is explicit as stated in
§5.2.

## 6. Predicate declarations and hygienic expansion

### 6.1 Predicate body

A predicate body is one SQLite expression template. It may contain ordinary SQL
expression tokens and calls to visible predicates. It MUST NOT contain:

- `when`;
- `@scope` or `@cover`;
- a semicolon;
- a query section or declaration;
- a bind not declared in its own predicate parameter list.

Predicate parameters are required values and cannot be optional, grouped, or
switches. They may be nullable value types.

Column references and SQL literals do not need declaration; closure applies to
bind tokens and predicate names, not ordinary SQL identifiers.

### 6.2 Predicate call grammar

Within an SQL expression template, a predicate call is:

```ebnf
predicate-call = "@", CAMEL_IDENT,
                 "(", [ bind-argument-list ], ")" ;
bind-argument-list = bind-reference,
                     { ",", bind-reference }, [ "," ] ;
bind-reference = ":", CAMEL_IDENT ;
```

The call name MUST resolve to one local or imported predicate. Arity MUST match.
Each actual argument is a bind reference; arbitrary SQL expressions and
identifiers are not predicate arguments.

Inside a predicate body, actual arguments refer to that predicate's parameters.
Inside a query SQL template, they refer to query scalar/group-member binds.

### 6.3 Expansion

Expansion proceeds after import/name resolution and before query type checking:

1. recursively expand called predicates in dependency order;
2. map each formal predicate bind token to its actual bind token;
3. substitute only bind AST/token nodes whose resolved symbol is that formal;
4. wrap the resulting expression in parentheses at the call site;
5. retain source-origin chains for diagnostics and hover.

Expansion MUST NOT replace matching text inside strings, quoted identifiers,
comments, unrelated bind names, or SQL identifiers. Formal `:id` does not match
`:id2`.

### 6.4 Predicate type constraints

Annotated formal parameters constrain actual query binds. Unannotated formal
parameters acquire constraints from the expanded predicate body. Calling the
same predicate with differently typed actual values is valid when each call can
satisfy the predicate's single inferred/annotated formal type; otherwise each
incompatible call is an error.

Compatibility requires the same base type. A non-null actual is compatible
with a nullable formal of that base type. A nullable actual is not compatible
with a non-null formal because an active optional may be `Present(null)`.
No numeric, string, boolean, JSON, or blob coercion is inserted by predicate
expansion.

## 7. Query signatures and bind authority

### 7.1 Name domains

Within one query, these names share one public-input namespace and MUST be
unique:

- scalar input names;
- group names;
- sort control name;
- page control name.

Group member bind names share the bind namespace with scalar input names and
members of every other group. They MUST be globally unique within the query.

Group names MAY NOT equal their own members. Switches do not enter the bind
namespace but still occupy the public-input namespace.

### 7.2 Bind resolution

After predicate expansion, every user bind in the SQL template MUST resolve to
exactly one required scalar, optional scalar, or group member declared by the
query. No bind is implicitly added to the signature.

Every direct query bind and every bind passed to a predicate participates in
this rule. Compiler-generated sort/page/presence binds are not user binds and
use reserved names.

### 7.3 Required-value placement

A required scalar may appear anywhere in the read-only SQL template where a
bound SQLite value is legal, including projections, CTEs, joins, subqueries,
`WHERE`, `HAVING`, and ordinary authored `ORDER BY`/`LIMIT` clauses.

### 7.4 Use completeness

Every declaration MUST be meaningfully used:

- a required scalar must occur as a bind after predicate expansion or in a
  reactive directive;
- an optional scalar must be named by at least one `when`, and each non-switch
  optional scalar named by a `when` must be referenced in that block, directly
  or through a predicate call;
- a switch is used by being named in at least one `when`;
- a group must be named by at least one `when`, and every group member must be
  referenced within a block controlled by that group;
- sort and page controls are used by their sections.

Declaring a value only to satisfy an import/predicate arity while the expanded
predicate does not use it is an error. Predicate declarations are likewise
closed and every formal parameter MUST be used by their fully expanded body.

## 8. Explicit conditional conjuncts

### 8.1 Syntax

The embedded syntax is:

```ebnf
when-conjunct      = "when", "(", control-list, ")",
                     "{", SQL_EXPRESSION_TEMPLATE, "}" ;
control-list       = CAMEL_IDENT, { ",", CAMEL_IDENT }, [ "," ] ;
```

Example:

```syql
where @scope(todos.list_id = :listId)
  and when(status) {
    status = :status
  }
  and when(range, includeArchived) {
    created_at between :start and :end
    and archived_at is not null
  }
```

### 8.2 Placement

A `when` node MUST be the entire expression operand of one top-level conjunct
in the outer read statement's `WHERE` or `HAVING` clause. It may immediately
follow the clause keyword or a top-level `AND` token. It MUST NOT appear:

- under `OR`;
- within parentheses that change the outer conjunct level;
- in a projection, CTE body, join condition, subquery, window expression, or
  sort profile;
- inside another `when`;
- inside a predicate declaration;
- as only part of a larger expression.

The block itself is an arbitrary non-empty SQLite expression template after
predicate expansion. It may contain parentheses, `OR`, subqueries, `CASE`, and
other SQLite expression forms.

These placement rules are syntactic and are evaluated using token/depth
structure from the shared lexer, not keyword substring searches.

### 8.3 Controls and dominance

Every name in a control list MUST resolve to an optional scalar, group, or
switch in the same query. Required scalars and sort/page controls are invalid
conditions. A control name may appear only once in one list.

The block dominates:

- the bind of an optional scalar named in the list;
- every member bind of a group named in the list.

Every optional bind in the block, including optional actual arguments passed
to predicates, MUST be dominated by its controlling scalar or group. Required
binds need no control and may appear in the block.

An optional bind MUST NOT occur anywhere outside a dominating `when` block.

### 8.4 Activation

For an input environment `E`:

- an optional scalar control is active iff its state is `Present`, including
  `Present(null)`;
- a group control is active iff the group state is `Present`;
- a switch control is active iff its value is true;
- `when(a, b, ...)` is active iff every listed control is active.

When active, the block's SQL predicate applies. When inactive, the `when` node
has SQL truth value true. Since the node is a complete top-level conjunct, true
removes its filtering effect.

False and absent switches therefore disable a block. They are not bound as
user SQL values.

### 8.5 Empty and redundant conditions

An empty block is an error. A `when` whose non-switch control is not used in its
block is an error under §7.4. Naming a switch and a value control together is
valid and means both conditions must be active.

The same optional control MAY govern multiple blocks. This does not create
additional public inputs or presence states.

## 9. SQL statement template

### 9.1 Statement class

After replacing predicate calls, reactive directives, and `when` nodes with
valid placeholder expressions, the `sql` section MUST be exactly one SQLite
read statement:

- a `SELECT`; or
- a `WITH` statement whose outer/main verb is `SELECT`.

`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, DDL, writable pragmas, and a `WITH`
whose main verb writes are errors. Named SYQL queries never write; mutations use
Syncular's mutation/outbox API.

The statement MUST read at least one synced IR table so dependency fallback is
well-defined. Views and virtual tables are allowed only if the surrounding
typegen/schema contract explicitly models them; otherwise they are outside
this specification.

### 9.2 Outer-statement structure

The compiler MUST distinguish outer clauses from clauses in CTEs, subqueries,
window definitions, and parenthesized expressions using token/depth structure.
A sort section conflicts only with an outer `ORDER BY`. A page declaration
conflicts only with an outer `LIMIT` or `OFFSET`. Nested `ORDER BY`, `LIMIT`,
and `OFFSET` clauses do not create those conflicts.

Compound outer statements (`UNION`, `INTERSECT`, `EXCEPT`) are valid SQLite
only when all other SYQL rules can be proven. `when`, `@scope`, and `@cover`
refer to the outer compound statement's final `WHERE`/`HAVING` structure and
therefore generally cannot span multiple arms. A compiler MUST reject an
ambiguous placement rather than rewrite one arm heuristically.

### 9.3 SQLite validation

Against DDL synthesized from the Syncular schema, the compiler first prepares
a reference realization with every conditional active, reactive directives
lowered, the default sort selected, and the default page size applied. It then
prepares every executable backend statement and every sort profile composition.
An SQLite rejection is a generation error with the source declaration and the
most specific originating span available.

The revision-1 SQLite 3.46.0 profile in §2.7 is the final authority on SQL
syntax, tables, columns, ambiguity, function availability, and expression
validity. SQLite validation does not replace SYQL's lexical/static checks.

### 9.4 Tables and conservative fallback

The compiler records every synced base table read by the statement, including
reads in subqueries and CTEs. If exact scope dependency is not constructed by a
reactive directive, dependency for that table is table-wide. Missing precision
is never represented as no dependency.

Dependency analysis is per physical table instance before metadata is merged by
physical table. If any instance of a physical table is read without an
applicable reactive directive, that table's merged dependency is table-wide and
overrides narrower bindings from other aliases. This includes table instances
inside subqueries or CTEs which cannot be named by an outer directive.

### 9.5 Determinism

A SYQL query MUST be a deterministic function of its SQLite snapshot and its
declared inputs. It MUST NOT read wall-clock time, randomness, connection-local
state, process/environment state, SQLite version, or mutation counters.
Forbidden shapes include `random()`, `randomblob()`, current date/time keywords,
the `now` date/time modifier, `changes()`, `total_changes()`,
`last_insert_rowid()`, and `sqlite_version()`.

Portable deterministic SQLite functions over row values, declared binds, and
authored literals remain valid. A query needing a clock, seed, locale, or other
external value declares it as a required input so changing that value is
visible to the generated API and query cache key. A window expression or other
shape whose value depends on an unspecified row order is rejected when the
compiler cannot establish deterministic semantics.

Every `LIMIT`/`OFFSET`, including one in a subquery or CTE, must operate over an
order which the compiler can prove total for that statement's row shape.
Choosing an arbitrary member or subset is not deterministic merely because
SQLite accepts the statement.

Revision 1 defines no nested-statement identity proof. Consequently, a nested
`LIMIT` or `OFFSET` is rejected even when it has a local `ORDER BY`. Revision 1
also defines no partition-identity proof for `OVER`; every window expression is
rejected. A future language revision may admit either shape only together with
a normative proof algorithm and conformance vectors.

This restriction is required for reactive caching and invalidation, not merely
for backend tests: state outside the database/input environment has no revision
or dependency event which could make a cached query rerun.

## 10. Constructive reactive predicates

### 10.1 Syntax

Reactive directives are SQL expression nodes:

```ebnf
reactive-directive = scope-directive | cover-directive ;
scope-directive    = "@scope", "(", scope-binding-list, ")" ;
cover-directive    = "@cover", "(", scope-binding-list, ")" ;
scope-binding-list = scope-binding, { ",", scope-binding }, [ "," ] ;
scope-binding      = qualified-column, "=", bind-reference
                   | qualified-column, "in", "(", bind-reference-list, ")" ;
qualified-column   = IDENT, ".", IDENT ;
bind-reference-list
                   = bind-reference, { ",", bind-reference }, [ "," ] ;
```

Container keywords `in`, `@scope`, and `@cover` are lowercase. SQL identifier
resolution remains case-sensitive/case-insensitive according to SQLite and the
schema, but the directive syntax itself is exact.

### 10.2 Placement and table resolution

A reactive directive MUST be an entire top-level conjunct in the outer
statement's `WHERE` clause. It cannot appear in `HAVING`, under `OR`, inside a
`when`, predicate, subquery, CTE body, join condition, or larger expression.

The first component of every qualified column identifies one table name or
outer query table alias. Every binding in one directive MUST resolve to the
same physical table instance. The second component MUST be a scope column
declared for that table in the Syncular schema.

The query must read that table instance. A self-join distinguishes aliases;
using the base table name when only aliases are in scope is an error.

### 10.3 Values and types

Directive values MUST be required scalar binds. Optional scalars, group
members, switches, literals, computed expressions, and predicate calls are not
allowed as scope values.

Each bind type MUST exactly match the schema type of the scope column. Every
`IN` list is non-empty. Duplicate columns or duplicate binds within one binding
are errors.

### 10.4 SQL lowering

Each equality binding lowers to its written equality. Each `IN` binding lowers
to its written `IN` predicate. Multiple bindings lower to a parenthesized `AND`
conjunction in source order.

For example:

```syql
@cover(
  messages.thread_id in (:left, :right),
  messages.room_id = :roomId
)
```

lowers logically to:

```sql
(
  messages.thread_id in (:left, :right)
  and messages.room_id = :roomId
)
```

This emitted SQL is prepared normally. The reactive metadata and SQL predicate
are derived from the same resolved bindings.

### 10.5 `@scope`

`@scope` emits exact dependency bindings for every listed scope column and bind
value. It does not claim window coverage. It may list any non-empty subset of a
table's declared scopes because restricting one scope is sufficient to route
changes carrying that scope key.

If multiple binds are listed with `IN`, each bind contributes one dependency
scope key for the same scope variable.

### 10.6 `@cover`

`@cover` emits the same exact dependencies as `@scope` and additionally emits
one coverage binding:

- the first scope binding is the covered/window dimension;
- an equality yields one unit; an `IN` yields one unit per bind;
- every other scope declared on the physical table MUST appear exactly once in
  the remaining bindings;
- remaining fixed-scope bindings MUST use equality with exactly one bind;
- no extra non-scope column may appear.

Thus a single-scope table needs one binding. A multi-scope table explicitly
fixes all other dimensions. This makes the coverage base and units derivable
without a separate trust annotation.

### 10.7 No implicit reactive inference

Revision 1 does not infer exact dependency or coverage facts from ordinary SQL
predicates. A table read without an applicable `@scope` or `@cover` has a
table-wide dependency and no coverage. The SQL emitted by `@scope` is marked as
originating from that node and MUST NOT be reinterpreted as implicit coverage.

This rule makes reactive output deterministic and keeps coverage intent
visible. A future, formally specified proof algorithm may add inference only
through a specification revision and normative positive/negative vectors.
This rule governs the SYQL frontend; any conservative analysis offered by the
plain `.sql` frontend is a separate source-language contract and does not alter
SYQL meaning.

### 10.8 Reactive metadata meaning

Reactive metadata uses physical table and schema scope names; a query alias is
resolved away after it has identified the correct table instance.

For each `@scope` or `@cover` binding, the dependency fact is the physical
table, scope variable, and runtime value of every referenced bind. An equality
contributes one value and an `IN` contributes all values. Multiple directives
for the same table/scope are unioned. These values are a mathematical set:
duplicates and ordering have no reactive meaning, even if an emitter preserves
source order for deterministic output.

An `@cover` additionally produces:

```text
Coverage {
  table: physical table,
  variable: scope named by the first binding,
  units: runtime values of the first binding,
  fixedScopes: map from every other declared scope to its one runtime value
}
```

`fixedScopes` is serialized in schema declaration order. Coverage units are a
set. Empty runtime coverage is not expressible because every unit comes from a
required bind, although two binds may evaluate to the same unit. Duplicate
runtime values do not enlarge the covered window.

Table-wide fallback is a dependency on the physical table with no scope-key
restriction. It MUST NOT be represented by an empty dependency list. Failure
to construct coverage produces no coverage entry. If any read instance forces
table-wide fallback under §9.4, coverage entries for that physical table are
also omitted; a window for one alias cannot claim answerability for an
unscoped alias of the same table.

## 11. Sort profiles

### 11.1 Semantics

A sort section introduces one optional public control whose values are the
declared profile names. When absent, the default profile is selected. At
runtime, the selected profile contributes its complete `ORDER BY` term list.

```syql
sort sortBy default newest {
  newest { created_at desc, id desc }
  oldest { created_at asc, id asc }
}
```

The generated host type is an enum/string-literal union over `newest` and
`oldest`. An invalid untyped value is rejected; it does not fall back silently
to the default.

### 11.2 Profile syntax and checks

`SQL_ORDER_LIST` is a non-empty SQLite `ORDER BY` term list without the words
`ORDER BY`. It may contain expressions, qualified columns, collations, and
directions supported by the pinned SQLite runtime. It MUST NOT contain:

- a semicolon;
- a user or compiler bind;
- a predicate call, reactive directive, or `when`;
- a `LIMIT`, `OFFSET`, or another outer clause.

Every expression in a profile MUST be deterministic from the row and authored
literals. Subqueries, window/aggregate expressions, and nondeterministic or
environment-dependent functions are forbidden. Deterministic portable scalar
expressions such as `lower(title)` are allowed and checked by SQLite.

Profile names are unique. The default profile name must exist. Every profile is
prepared against the fully lowered query by structurally inserting
`ORDER BY <profile>` at the outer statement's order-clause position (before an
authored outer `LIMIT`/`OFFSET`, when present).

The query SQL template MUST NOT contain an outer `ORDER BY` when a sort section
exists. Nested ordering remains valid under §9.2.

### 11.3 Stable ordering for bounded queries

A query with a `page` declaration or an authored outer `LIMIT`/`OFFSET` MUST
have a deterministic outer order, from either a sort section or an authored
outer `ORDER BY`. The compiler MUST prove that every possible order ends with a
unique tie-breaker compatible with the query's proven identity.

A bounded query for which no identity can be declared or inferred is therefore
invalid.

For a sort section, every profile MUST end in a suffix containing each field of
the proven identity exactly once, in identity declaration/inference order.
Each suffix term is a plain origin-resolved column reference followed only by
`ASC` or `DESC`; it has no expression wrapper, collation, or null-ordering
modifier. The same rule applies to an authored outer `ORDER BY`. A timestamp
alone is not unique merely because it is monotonic in typical data.

Every preceding authored order term must satisfy the same deterministic
expression rule as a sort profile. An order containing `random()`, current
time, environment state, or an unproven function is invalid for a bounded
query.

If the compiler cannot prove stable ordering, generation fails. It does not
warn and emit drift-prone keyset behavior.

## 12. Page declaration

### 12.1 Static constraints

The default and maximum are decimal integer literals satisfying:

```text
1 <= default <= max <= 2147483647
```

The page control name must not collide under §7.1. A query with a page
declaration MUST NOT contain an outer `LIMIT` or `OFFSET`. An authored nested
`LIMIT`/`OFFSET` is not a page-clause conflict, but is rejected by the
revision-1 determinism rule in §9.5.

### 12.2 Public input and validation

The page control is an optional integer public input. When absent, the default
is used. Before calling any client/bridge, generated code MUST reject a supplied
value which is:

- not a number/integer in the target's abstract binding model;
- non-finite;
- fractional;
- less than 1;
- greater than max.

The behavior and diagnostic/error code are consistent on every target. Values
are not silently truncated or clamped.

### 12.3 SQL lowering

The compiler structurally inserts one outer `LIMIT` at SQLite's outer
limit-clause position using an internal bound parameter in the reserved
namespace. The validated effective page size is bound to it. User input never
becomes SQL text.

An implementation MAY inline the compile-time default only when the page input
is absent and doing so cannot create a public/backend distinction; the logical
plan and conformance fixtures still represent one page control.

`OFFSET` is not a SYQL control. A query without a page declaration may author
ordinary SQLite `LIMIT`/`OFFSET` with required binds. A query using `page`
SHOULD author keyset pagination with a named cursor group and stable order.

`page` controls only the bounded outer `LIMIT`; it does not synthesize or prove
an authored keyset predicate. Revision 1 authors SHOULD use one sort profile
per cursor-bearing query, or separate queries for distinct cursor/order shapes.
The stable-order proof prevents tied ordering, but it does not by itself prove
that an arbitrary cursor predicate matches that order.

## 13. Result identity

### 13.1 Source names

`identity by` names result columns as SQLite reports them before target-language
casing. Each name must be projected exactly once and be non-null in the checked
result shape. Target emitters map the proven source fields through the normal
naming map.

### 13.2 Conservative proof

An identity declaration is accepted only if the compiler proves uniqueness for
the outer result. The minimum conforming proof supports:

1. a simple, non-grouped, non-distinct, non-compound single-table query whose
   identity includes that table instance's primary key; and
2. a simple join query whose identity fields include the primary-key origin of
   every outer base-table instance which can multiply result rows.

Every identity field must resolve to an exact physical origin. Computed,
nullable, aggregate, fallback-typed, or ambiguous-origin fields do not prove
identity. Queries with `GROUP BY`, aggregate result cardinality, `DISTINCT`, set
operations, or projection shapes outside the proof are rejected when they
declare identity.

Additional uniqueness proofs for declared unique indexes or stronger join
analysis require a specification revision and normative fixtures. A compiler
MUST NOT accept an identity merely because fields are projected or
type-compatible.

### 13.3 Inference and fallback

When no identity declaration exists, the compiler MUST apply the minimum proofs
in §13.2 and infer the smallest identity whenever their required origin fields
are projected. If the proof does not succeed, QueryIR omits identity and
runtimes reconcile rows safely without a key.

Inference is deterministic. For a simple table it uses primary-key columns in
schema declaration order. For a qualifying join it concatenates the necessary
table-instance primary keys in outer `FROM`/`JOIN` order, with each key in
schema declaration order. A stronger future proof must specify its
deterministic selection rule and conformance vectors.

Runtime duplicate detection remains a defensive fallback, not evidence that an
unchecked identity declaration is acceptable.

## 14. Static analysis order

A conforming compiler performs these logical stages in order, although an
implementation may combine passes when observable diagnostics remain
equivalent:

1. decode UTF-8 and produce the lossless token stream;
2. parse container declarations and SQL template nodes with source spans;
3. resolve imports and detect import/declaration cycles;
4. resolve predicate calls and perform hygienic expansion;
5. build query public-input and bind symbol tables;
6. enforce authoritative declaration/use and `when` dominance;
7. resolve tables, aliases, columns, scope directives, and result names against
   schema IR;
8. collect and solve parameter/predicate type constraints;
9. check query class and outer clause conflicts;
10. build the backend-independent logical query;
11. derive directive/fallback dependencies and coverage, then prove sort
    validity/stability, page constraints, and identity;
12. lower the selected and reference conditional backends;
13. prepare every executable statement/profile against SQLite;
14. build target-neutral QueryIR and apply naming-map collision checks;
15. emit every requested target from that same IR.

An implementation MUST NOT use SQLite preparation before lexical/container
validation as a reason to accept malformed SYQL. Conversely, passing SYQL
static checks does not excuse an SQLite rejection.

## 15. Backend-independent logical semantics

### 15.1 Logical query shape

After static analysis, each query has at least this abstract shape:

```ts
interface SyqlLogicalQuery {
  readonly name: string;
  readonly inputs: readonly LogicalInput[];
  readonly requiredSql: SqlTokenTree;
  readonly conditionals: readonly {
    readonly controls: readonly string[];
    readonly predicate: SqlTokenTree;
  }[];
  readonly dependencies: readonly LogicalDependency[];
  readonly coverage: readonly LogicalCoverage[];
  readonly sort?: {
    readonly control: string;
    readonly defaultProfile: string;
    readonly profiles: Readonly<Record<string, SqlOrderTokenTree>>;
  };
  readonly page?: {
    readonly control: string;
    readonly defaultSize: number;
    readonly maxSize: number;
  };
  readonly identity?: readonly string[];
}
```

The concrete AST/fixture JSON schema SHALL be committed under `spec/syql/` and
is normative alongside this document. Source offsets and trivia may live in a
parallel representation so semantic fixture equality is stable.

### 15.2 Input environment

At execution, a public input environment maps:

- every required scalar to one admitted value;
- every optional scalar to `Absent` or `Present(value)`;
- every group to `Absent` or `Present(member map)`;
- every switch to false/absent or true;
- sort/page controls to absent or one validated value.

The environment is validated before SQL/profile selection or binding. Missing
required values, unknown keys at untyped boundaries, invalid types, partial
groups, invalid sort names, and invalid page sizes are errors.

### 15.3 Query meaning

For a validated environment:

1. include every required SQL predicate/token;
2. for each conditional, apply its predicate iff all controls are active under
   §8.4; otherwise use true;
3. lower resolved reactive directives to their SQL predicates;
4. choose the validated sort profile or authored order;
5. apply the validated effective page size if declared;
6. bind all required and active value binds using the target client's binding
   representation;
7. execute the resulting checked read statement.

Neutralized and enumerated backends are conforming only when they implement this
same meaning for every environment.

## 16. Conditional lowering

### 16.1 Hidden presence namespace

For each distinct optional scalar or group used by conditionals, neutralized
lowering MAY create one internal boolean bind. For switches it MAY create an
internal active boolean bind. Internal names begin with `__syql` and are not
part of the public signature.

An active conditional predicate `P` is represented logically as:

```sql
case when :__syqlActiveN = 0 then 1 else (P) end
```

where the internal bind is `1` exactly when every control is active. This
scheme, rather than `:value IS NULL`, is REQUIRED when nullable optionals are
supported because `Present(null)` is active. The `CASE` form also prevents an
inactive predicate from evaluating an absent value; implementations MUST NOT
replace it with a boolean form whose evaluation behavior can expose the
placeholder bind.

Generated binding code supplies inactive optional value binds with a
SQLite-compatible placeholder value, normally null. The lazy `CASE` arm keeps
the inactive predicate from evaluating that placeholder. The binding must
still satisfy SQLite's parameter count and driver contract.

### 16.2 Enumerated lowering

Enumerated lowering constructs a finite statement/profile selection from
control activation states. Inactive conditionals become true and SHOULD be
removed from top-level conjunctions. If every outer `WHERE` conjunct becomes
true, the generated variant MAY omit the `WHERE` clause.

Groups contribute one activation bit, never one bit per member. A switch bit is
true only for true. Present-null and present-value share the same active bit.

Every enumerated statement is prepared. Statement count limits are compiler
policy, not query validity: when enumeration would exceed policy, `auto` falls
back to neutralization rather than rejecting a semantically valid source.

### 16.3 Backend equivalence

For every query, schema fixture, valid input environment, and sort profile:

```text
bag(rows(neutralized)) == bag(rows(enumerated))
```

Bag equality includes duplicate multiplicity and every row value. If the query
has a compiler-proven total order under §11.3, the returned sequences MUST also
be equal. Without a proven total order, SQLite does not promise tie/unordered
sequence and SYQL does not strengthen that promise. Both backends expose the
same public input validation and errors. Conformance tests execute both even
when normal generation chooses only one.

### 16.4 Selection and target parity

Backend selection is a compiler/manifest option and is absent from SYQL source.
The chosen plan is serialized into QueryIR. TypeScript, Swift, Kotlin, Dart,
and future emitters MUST either implement that plan or fail generation as an
unsupported requested target; they MUST NOT silently substitute a different
backend with materially different planner behavior.

## 17. QueryIR and generated API contract

### 17.1 Frontend neutrality

SYQL and the plain `.sql` frontend continue to feed one query IR. Frontend-only
source locations and logical-control metadata may differ, but result shape,
tables, checked SQL, types, naming, and reactive descriptors use shared IR
types. Downstream clients do not parse SYQL.

A plain `.sql` query emitted as the same reactive `NamedQuery` abstraction MUST
also satisfy §9.5. A future explicitly non-reactive execution helper may define
a broader contract, but it cannot silently share reactive caching/readiness
semantics.

### 17.2 Public parameters

Emitters generate:

- required scalar parameters as required host values, with exact signed 64-bit
  representation for `integer`;
- optional non-null scalars as optional host values;
- nullable optionals with an explicit tri-state representation when needed;
- groups as one generated optional object/struct with required members;
- switches as optional/default-false booleans;
- sort controls as a checked enum/union defaulting to the declared profile;
- page controls as optional integer values validated under §12.

The exact idiomatic spelling is target-specific; the abstract states and error
behavior are not.

### 17.3 Binds

Generated bind order is deterministic. Repeated source binds map to one logical
input and use the driver's supported numbered/named reuse or deterministic
repetition without changing public parameters. Internal binds never appear in
generated public parameter types.

### 17.4 Naming

SQL names remain source truth. Existing configured naming modes and collision
checks apply to result fields, public input names, group members, and generated
control/profile enum names. A collision on any requested target is a generation
error naming the source names and target.

### 17.5 Errors

Untyped runtime validation errors for the same invalid environment SHOULD use
stable cross-platform codes. At minimum generated runtimes distinguish:

- missing required input;
- unknown input;
- invalid input type/nullability;
- partial/invalid group;
- invalid sort profile;
- invalid page size.

Compile-time typing is not a substitute for validation at FFI, JSON, IPC, or
JavaScript boundaries.

## 18. Read typing and result columns

This language specification preserves the shared named-query analyzer's
honest typing boundary:

- a plain physical column reference has the schema's exact semantic type and
  nullability;
- an alias changes the result name, not the physical origin;
- a computed expression uses SQLite metadata and the documented conservative
  fallback unless future syntax supplies a checked result annotation;
- projection naming aliases are applied after SQL correctness and source-name
  resolution;
- naming collisions are errors.

Every SQLite-reported result source name MUST match `IDENT` and be unique before
target naming. A computed expression whose default SQLite name is not an
`IDENT` therefore needs an explicit `AS` alias. SQL quoting may be used to
author an alias such as `"order"`; the decoded result name, not the quote
characters, is checked.

Parameter annotations introduced by SYQL remove the need for SQL header-comment
type annotations inside a SYQL query. `-- param` remains a `.sql` frontend
feature and has no special meaning in `.syql` beyond being an ordinary SQL
comment.

## 19. Formatter contract

### 19.1 Safety requirements

`syncular fmt` MUST parse through the same lexer and AST as generation. It MUST
refuse invalid input. Before writing, it MUST verify semantic round trips
equivalent to:

```text
semanticAst(source) == semanticAst(formatted)
logicalPlan(source) == logicalPlan(formatted)
```

Equality includes imports, declarations, annotations, groups, SQL token values,
predicate calls, conditions, reactive directives, sort profiles, page limits,
and identity. It excludes source offsets and non-semantic whitespace.

The formatter MUST preserve every comment's text and ordering relative to the
surrounding semantic tokens. It MUST preserve exact contents of strings, quoted
identifiers, blob literals, and other atomic SQLite tokens.

If its own equivalence check fails, the formatter MUST report an internal
formatter error and leave the file unchanged.

### 19.2 Canonical container style

The canonical style is:

- LF line endings;
- lowercase container keywords;
- one space around container punctuation where shown in examples;
- one import item per line when an import does not fit the repository line
  width;
- one query/predicate parameter per line when a signature is multiline;
- query sections in grammar order;
- two-space indentation per container/SQL block level;
- one blank line between imports and declarations and between declarations;
- a final newline.

SQL keywords recognized by the pinned SQLite profile are lowercased token-wise
by the canonical formatter. SQL identifier spelling is never case-normalized.
SQL layout is canonicalized only through tokens and MUST satisfy §19.1 and the
normative formatter fixtures.

### 19.3 Idempotence

Formatting is byte-idempotent:

```text
format(format(source)) == format(source)
```

Normative fixtures include every container node and the SQLite lexical edge
cases listed in §23.

## 20. Diagnostics

### 20.1 Required shape

Every compile-time diagnostic MUST include:

- a stable diagnostic code;
- severity;
- source file;
- the narrowest relevant source span;
- a concise primary message;
- related spans for conflicts, imports, cycles, or type evidence when useful;
- a corrective hint when one clear correction exists.

SQLite errors are wrapped with a SYQL diagnostic code and retain SQLite's
message as detail.

### 20.2 Diagnostic categories

The concrete code registry is pinned in conformance fixtures. It MUST cover at
least these categories:

| Category | Examples |
| --- | --- |
| lexical/parse | unterminated quote, unexpected member, bad signature |
| name/import | duplicate name, missing predicate, path escape, cycle |
| bind/signature | undeclared bind, unused input, partial group definition |
| type | no evidence, conflict, annotation mismatch, invalid nullability |
| condition | required control, missing dominance, invalid placement |
| predicate | arity, closed-signature violation, forbidden node |
| reactive | non-scope column, optional unit, missing fixed scope, alias error |
| SQL | write statement, multi-statement, SQLite rejection, outer conflict |
| sort | missing default, invalid term, unstable paged ordering |
| page | invalid static range, conflicting outer limit/offset |
| identity | unprojected, nullable, computed, or unproven field |
| target/naming | collision, unsupported selected backend |
| formatter/internal | failed equivalence assertion, impossible IR state |

Warnings MUST NOT be used for conditions which can change query correctness,
reactive completeness, or runtime safety. Those are errors.

## 21. LSP and editor behavior

A conforming SYQL LSP SHALL use the compiler parser/static analyzer and SHOULD
provide:

- diagnostics on open/change with exact spans;
- definition/references for local and imported predicates;
- hover for inputs, groups, annotations, reactive bindings, sort profiles, and
  the lowered logical/SQL plan;
- document symbols for queries and predicates;
- formatting through the canonical formatter.

The project context includes the manifest, migrations/schema IR, imported
files, naming targets, and compiler backend options. The server MUST invalidate
cached context when any of those change. Failure to load the project context is
a visible diagnostic; the server MUST NOT silently report a clean parser-only
document as fully checked.

TextMate or other presentation grammars are non-normative. They SHOULD be
generated or tested from the normative token corpus and MUST be updated in the
same change as a new syntax node.

## 22. Security properties

A conforming implementation maintains:

### Q1 — values bind

User input values, including page size and hidden presence state, are passed to
SQLite as bound values. Predicate expansion never interpolates a runtime value
into SQL text.

### Q2 — SQL text choices are finite

Sort profiles are authored in source, parsed at generation, and checked against
SQLite. Runtime input selects a profile key from a generated enum/map. Invalid
untyped keys fail rather than being treated as SQL or silently defaulting.

### Q3 — imports remain local

Import resolution cannot access paths outside the configured query root or use
network/package resolution. Import contents are compiler inputs, not runtime
loads.

### Q4 — reads remain read-only

Every executable statement is read-only. A source macro or CTE cannot conceal a
write because the compiler checks the outer/main verb and prepares through the
read-query pipeline.

### Q5 — resource growth is bounded by compiler policy

Backend enumeration and predicate expansion are compile-time operations.
Implementations may impose deterministic token/statement-count limits with
clear diagnostics. `auto` backend selection falls back to neutralization when
enumeration is too large. No user request triggers new SQL compilation or
unbounded variant construction at runtime.

## 23. Normative conformance suite

The repository SHALL contain `spec/syql/manifest.json` and versioned fixture
families. A conforming frontend passes every applicable fixture.

### 23.1 Lexical fixtures

At minimum:

- single strings with doubled quotes and significant repeated whitespace;
- multiline strings accepted by SQLite;
- double-quoted, backtick, and bracket identifiers containing keyword text;
- line comments before clauses and at end-of-file;
- block comments containing braces, binds, `@`, and semicolons;
- blob literals;
- every supported multi-character SQLite operator;
- braces/semicolons/bind text inside atomic tokens;
- unterminated strings, identifiers, and comments.

Fixtures assert token kind, exact token text, span, and canonical formatting.

### 23.2 Grammar and AST fixtures

At minimum:

- imports with aliases/trailing commas;
- predicate libraries and nested acyclic calls;
- every input/type/nullability shape;
- named groups;
- each query section and legal omission;
- all embedded node placements;
- invalid member ordering and unknown members.

Valid fixtures pin semantic AST JSON. Invalid fixtures pin diagnostic code and
primary span.

### 23.3 Static semantic fixtures

At minimum:

- undeclared and unused binds in both directions;
- group member collisions and partial untyped environments;
- required control misuse;
- optional bind outside or under the wrong `when`;
- present-null activation;
- switch absent/false/true;
- predicate hygiene where literal/comment text resembles a bind;
- import/predicate cycles longer than ten nodes;
- annotation inference, conflicts, and missing evidence;
- nested SQL clauses versus outer conflicts.
- deterministic input-driven functions and rejection of time/random/
  connection-state dependencies.

### 23.4 Reactive fixtures

At minimum:

- single-scope `@scope` and `@cover`;
- `IN` units;
- multi-scope coverage with all fixed values;
- missing/duplicate/wrong-table fixed scopes;
- self-join alias resolution;
- optional/type-incompatible units;
- ordinary SQL and missing-directive cases falling back to table-wide/no
  coverage;
- SQL predicate and reactive IR derived from identical bindings.

Execution fixtures MUST demonstrate that a reactive declaration unrelated to
the written restriction cannot be expressed.

### 23.5 Sort, page, and identity fixtures

At minimum:

- composite sort profiles and collations;
- deterministic expressions and nondeterministic-expression rejection;
- invalid profile names from untyped input;
- nested order versus outer order conflict;
- static and runtime page values at every boundary, including `-1`, zero,
  fractions, infinity/NaN where the host exposes them, max, and max+1;
- outer versus nested `LIMIT`/`OFFSET` conflict handling;
- timestamp ties with and without a primary-key suffix;
- simple-table and join identity proof;
- projected-but-nonunique, nullable, computed, grouped, and compound identity
  rejection.

### 23.6 Backend equivalence fixtures

For every combination of optional scalar, nullable optional, group, and switch
activation, execute neutralized and enumerated SQL over seeded data and assert
bag equality; assert sequence equality for fixtures with a proven total order.
Include:

- absent versus present-null;
- false versus true switch;
- atomic group present/absent;
- multiple conditions sharing one control;
- every sort profile;
- default and supplied page size.

The execution matrix uses the SQLite 3.46.0 reference validator plus every
shipped client SQLite engine. It includes accepted core syntax/functions and
negative fixtures for newer or compile-option-dependent features.

### 23.7 Formatter fixtures

Every valid syntax fixture is formatted and asserts:

1. canonical bytes;
2. idempotence;
3. semantic AST equality;
4. logical plan equality;
5. exact atomic SQL token contents.

A formatter regression which deletes a query member or changes a literal is a
release-blocking test failure.

### 23.8 Cross-emitter fixtures

TypeScript, Swift, Kotlin, and Dart fixtures assert equivalent:

- required/optional/nullable public shapes;
- atomic group shape;
- switch behavior;
- sort enums and invalid-key handling;
- page validation;
- selected conditional backend;
- bind arrays and statement selection;
- reactive descriptors and identity.

Integer fixtures include −2⁶³, −2⁵³−1, −2⁵³, 2⁵³, 2⁵³+1, and 2⁶³−1 across
the generated API, bridge, SQLite binding, and result decoding paths.

At least one execution lane per target or its real bridge MUST verify runtime
behavior. Text snapshot parity alone is insufficient for backend selection and
validation behavior.

## 24. Canonical examples

### 24.1 Predicate library

```syql
predicate visibleTodos() {
  archived_at is null and deleted = 0
}

predicate matchesTitle(q: string) {
  title like '%' || :q || '%'
}
```

### 24.2 Optional search and atomic range

```syql
import {
  matchesTitle,
  visibleTodos,
} from "./todo-predicates.syql";

query listTodos(
  listId,
  q?,
  range?(start: integer, end: integer),
) {
  sql {
    select id, title, created_at
    from todos
    where @cover(todos.list_id = :listId)
      and @visibleTodos()
      and when(q) {
        @matchesTitle(:q)
      }
      and when(range) {
        created_at between :start and :end
      }
  }

  sort sortBy default newest {
    newest { created_at desc, id desc }
    oldest { created_at asc, id asc }
  }

  page pageSize default 50 max 200;
  identity by id;
}
```

### 24.3 Switch

```syql
query assignedTodos(
  listId,
  unassignedOnly?: switch,
) {
  sql {
    select id, title, assignee_id
    from todos
    where @scope(todos.list_id = :listId)
      and when(unassignedOnly) {
        assignee_id is null
      }
  }

  identity by id;
}
```

### 24.4 Present null

```syql
query byStatus(
  listId,
  status?: string | null,
) {
  sql {
    select id, status
    from todos
    where @scope(todos.list_id = :listId)
      and when(status) {
        status is :status
      }
  }

  identity by id;
}
```

Absent `status` does not filter. Present-null selects rows whose status is null.
Present `"open"` selects open rows. The neutral backend uses a hidden active
bind and does not use `:status IS NULL` as the guard.

### 24.5 Multi-scope coverage

```syql
query threadMessages(
  roomId,
  threads?(left, right),
) {
  sql {
    select id, room_id, thread_id, body, created_at
    from messages
    where @scope(messages.room_id = :roomId)
      and when(threads) {
        thread_id in (:left, :right)
      }
  }

  sort sortBy default chronological {
    chronological { created_at asc, id asc }
    newest { created_at desc, id desc }
  }

  identity by id;
}
```

This query deliberately uses `@scope`, not `@cover`, because the covered thread
units are optional and coverage units must be required. A screen requiring
coverage for a selected set declares required thread parameters or separate
queries whose required inputs describe the exact window.

```syql
query coveredThreads(
  roomId,
  left,
  right,
) {
  sql {
    select id, room_id, thread_id, body, created_at
    from messages
    where @cover(
      messages.thread_id in (:left, :right),
      messages.room_id = :roomId
    )
  }

  sort sortBy default chronological {
    chronological { created_at asc, id asc }
  }

  identity by id;
}
```

### 24.6 Keyset cursor

```syql
query todoPage(
  listId,
  cursor?(createdAt: integer, id: string),
) {
  sql {
    select id, title, created_at
    from todos
    where @scope(todos.list_id = :listId)
      and when(cursor) {
        created_at < :createdAt
        or (created_at = :createdAt and id < :id)
      }
  }

  sort sortBy default newest {
    newest { created_at desc, id desc }
  }

  page pageSize default 50 max 100;
  identity by id;
}
```

The cursor is absent or contains both fields. The ordering ends in the unique
`id` tie-breaker, so equal timestamps neither skip nor duplicate rows between
pages under the query's ordering semantics.

## 25. Invalid examples

### 25.1 Undeclared bind

```syql
query bad() {
  sql {
    select id from todos where id = :ghost
  }
}
```

`:ghost` is not inferred into the public API; generation fails.

### 25.2 Optional bind without `when`

```syql
query bad(status?) {
  sql {
    select id from todos where status = :status
  }
}
```

The author must write an explicit conditional conjunct.

### 25.3 Partial group in source model

```syql
query bad(range?(start, end)) {
  sql {
    select id from todos
    where when(range) { created_at >= :start }
  }
}
```

The group member `end` is unused, so the declaration is invalid.

### 25.4 Unrelated coverage assertion

There is no syntax equivalent to:

```text
claim todos.list_id comes from listId
while SQL says title = :listId
```

`@cover(todos.list_id = :listId)` necessarily emits the list restriction it
publishes. Writing `title = :listId` separately yields no list coverage proof.

### 25.5 Unstable paged order

```syql
query bad() {
  sql {
    select id, created_at from todos
  }

  sort sortBy default newest {
    newest { created_at desc }
  }

  page pageSize default 50 max 100;
  identity by id;
}
```

The sort omits the proven `id` tie-breaker and is rejected.

## 26. Implementation freedom and extension process

An implementation may choose internal data structures, parser strategy,
diagnostic wording, SQL whitespace rendering, and deterministic backend
heuristics, provided all normative source meanings, errors, fixtures, and
cross-target behaviors hold.

New syntax or semantics require, in one change:

1. an accepted RFC or amendment when the change is user-visible or semantic;
2. an update to this specification;
3. updated EBNF and static/lowering rules;
4. normative valid/invalid/formatter/backend fixtures;
5. all emitter and editor-tool updates;
6. no contradictory legacy design text.

Implementation behavior not described here or pinned by normative fixtures is
not automatically part of the language contract. Once behavior is depended on,
it should be specified rather than preserved accidentally.
