# RFC 0004 — SYQL: an explicit, hygienic, reactive-aware SQL language

- **Status:** Proposed
- **Date:** 2026-07-14
- **Scope:** `packages/typegen`, `editors/vscode-syql`, generated query
  emitters, query IR, demos, conformance fixtures, and query documentation
- **Normative specification:** [`docs/SYQL.md`](../SYQL.md)
- **Compatibility posture:** destructive replacement while Syncular is a
  prototype; no compatibility parser, source-version switch, deprecation
  window, or automatic preservation of the current grammar

## Summary

SYQL should remain SQL-first. It should not become a second relational query
engine, a runtime builder, or a comment-template language. Its job is narrower:
add the pieces SQLite cannot safely express as bound values—typed operation
boundaries, conditional presence, reusable predicates, finite sort choices,
bounded page sizes, and Syncular's reactive scope facts—then lower the result
at generate time to ordinary, fully checked SQLite statements.

The current prototype has the right architecture (two source frontends, one
IR, SQLite validation, cross-platform generation) but the wrong semantic
boundary. It describes itself as a structured container while several language
features depend on raw-text scans and rewrites. That mismatch has produced
concrete correctness failures: SQL literals and comments can be changed during
lowering, formatting can delete declarations, fragment substitution can
rewrite string contents, signatures accept undeclared binds, reactive
assertions can disagree with the SQL they annotate, negative limits bypass the
declared maximum, optional groups are not atomic at the generated API, and the
variants backend is not honored by every emitter.

This RFC replaces the current `.syql` grammar rather than evolving it. The new
language has five core ideas:

1. **Explicit conditions.** Optional values are used inside `when(...)`
   conjuncts; no predicate changes meaning merely because it mentions an
   optional bind.
2. **Hygienic predicates.** Reusable `predicate` declarations and imports are
   expanded by token identity, never by raw string replacement.
3. **Atomic inputs.** Named optional groups generate one optional object/struct,
   and absence is distinct from a present SQL `NULL`.
4. **Constructive reactive facts.** `@scope(...)` and `@cover(...)` emit both
   the SQL restriction and the reactive metadata, so the two cannot drift.
5. **Finite checked controls.** Complete sort profiles and validated page sizes
   replace runtime direction/identifier assembly and SQL-side pseudo-clamping.

The full lexical grammar, EBNF, static semantics, lowering rules, type model,
formatting contract, diagnostics, and conformance requirements are normative in
[`docs/SYQL.md`](../SYQL.md). This RFC records why that design is chosen, how it
replaces the current implementation, and what must be true before it lands.

## 1. Problem statement

### 1.1 The language promises structure but transforms raw text

SYQL's important semantics currently depend on several independent scanners:
finding a `WHERE`, splitting top-level `AND`, discovering binds, replacing
fragment arguments, collapsing whitespace, locating projection clauses, and
formatting the result. Those scanners do not share one lexical model. Some
understand single-quoted strings, some also understand quoted identifiers, and
some rewrite the original text after using a safer blanked copy for discovery.

The result is not merely incomplete syntax highlighting. Valid source can
change meaning:

- whitespace collapse changes `'a  b'` to `'a b'`;
- collapsing a newline after `--` makes the comment consume the remaining SQL;
- fragment parameter renaming rewrites `':x'` inside a literal;
- the formatter tokenizes `"order"` as punctuation and a keyword, changing the
  quoted identifier;
- clause scans confuse legal nested clauses or quoted words with outer query
  structure.

SQLite validating the final statement does not repair a transformation that
already changed valid source into different valid SQL. A language which owns
source rewriting must have one lossless lexical truth.

### 1.2 Implicit optionality is clever at the wrong layer

The current rule—an optional bind in a top-level `WHERE` conjunct makes that
conjunct conditional—is concise, but it creates hidden semantics and forces the
compiler to recognize SQL boolean structure before SQLite sees it. It also
conflates an absent input with SQL `NULL` and makes error boundaries depend on
whether a reference is under `OR`, in a subquery, or outside the first outer
`WHERE` discovered by a scanner.

Conditionality is important enough to be visible:

```syql
and when(status) {
  status = :status
}
```

The extra word removes an entire class of inference and placement ambiguity.

### 1.3 The generated API does not preserve grouped intent

`from+to?` says the two values form one optional group, but TypeScript and the
native emitters expose two independent optional parameters. A caller can pass
only `from`; neutralization then silently disables the range. The language has
described an invariant without giving host languages a way to enforce it.

Named groups solve this at the type boundary:

```syql
range?(from, to)
```

becomes one optional `range` object/struct with two required members.

### 1.4 Reactive annotations can make correctness claims the SQL does not prove

`depends`, `window`, and `key by` are described as checked declarations. The
current checker verifies names, table membership, projection membership, and
type compatibility, but it cannot prove that the declared scope parameter
actually restricts the named scope column or that an arbitrary projected key
is unique.

A query can currently claim `todos.list_id = listId` for invalidation/coverage
while using `:listId` only against `title`. That narrows invalidation to the
wrong scope and can leave a live view stale or mark incomplete data ready.

The replacement makes the safe path constructive. A directive such as:

```syql
@cover(todos.list_id = :listId)
```

lowers to the SQL predicate and produces the matching dependency and coverage
IR from the same node. Unproven shapes remain table-wide and uncovered.

### 1.5 Dynamic controls are too weak in some places and unsafe in others

The current `orderBy column | column` allowlist is injection-safe, but a
separate free direction cannot express a complete, deterministic ordering.
It cannot encode a primary-key tie-breaker, a collation, a qualified join
column, or a checked expression. The documented keyset example orders only by
a timestamp and can skip rows when timestamps tie.

The current `limit` expression applies only an upper `min`. In SQLite a
negative limit means unlimited, so `max 200` can be bypassed with `-1`.

The replacement uses named, complete sort profiles and validates page size in
generated code before binding:

```syql
sort sortBy default newest {
  newest { created_at desc, id desc }
  title { title collate nocase asc, id asc }
}

page pageSize default 50 max 200;
```

### 1.6 Backend choice currently leaks into source and platform behavior

Neutralization and statement enumeration are semantically equivalent compiler
backends. The current source-level `variants` knob exposes that implementation
choice, while only the TypeScript emitter dispatches enumerated statements;
Swift, Kotlin, and Dart continue to execute neutralized SQL.

Backend choice moves out of ordinary source syntax. The compiler selects a
backend using checked query shape and planner evidence, with an advanced
manifest/compiler override if necessary. Whatever backend is selected is
implemented on every requested target and is invisible to the query API.

### 1.7 There is no normative language definition

The design document promises an EBNF and golden language fixtures but the
current repository has implementation tests rather than a normative grammar.
Important questions—lexical quoting, absent versus null, predicate hygiene,
group provision, conditional dominance, import cycles, clause placement,
backend equivalence, and formatter preservation—are consequently encoded in
implementation detail.

This RFC makes [`docs/SYQL.md`](../SYQL.md) the source of truth. Implementations
and tooling conform to that document, not to whichever scanner landed first.

## 2. Goals and invariants

The replacement is accepted only if all of these hold.

### S1 — SQL remains the expression language

Tables, joins, projections, functions, predicates, CTEs, grouping, and SQLite
operators remain SQLite syntax. SYQL does not own relational semantics or a
query optimizer.

### S2 — transformation is lossless outside explicit language nodes

String literals, quoted identifiers, comments, whitespace inside tokens, and
all ordinary SQL tokens survive parsing, formatting, predicate expansion, and
lowering without semantic change. Every transformation operates on token spans
or AST nodes, never a global raw-text replacement.

### S3 — the query signature is authoritative

Every user bind is declared exactly once by the query or a named group. Every
declared value is used. No undeclared bind is inferred into a generated public
API, and compiler-generated binds occupy a reserved namespace unavailable to
source.

### S4 — optional behavior is explicit

Optional values affect SQL only through a `when(...)` node which names the
controlling scalar, group, or switch. Required values cannot be used as
conditions. An optional bind outside a dominating `when` is a static error.

### S5 — absence, null, and false are distinct

An optional input has an abstract absent/present state. A present nullable
value may contain SQL `NULL`; it is not treated as absent. A switch applies its
predicate only when true. Lowering may use hidden presence binds, but generated
APIs preserve these semantics on every platform.

### S6 — groups are atomic in source, IR, and generated APIs

A named optional group is absent or present with every member. Partial groups
cannot be constructed through a generated typed API and are rejected at any
untyped bridge.

### S7 — reusable predicates are hygienic and closed

A predicate may reference only its declared parameters and imported/local
predicates. Expansion substitutes bind tokens by identity, parenthesizes the
result, preserves literals/comments, and rejects declaration/import cycles.

### S8 — reactive precision is constructive

Dependency scopes and coverage emitted for SYQL arise from a checked
`@scope`/`@cover` node. Ordinary SQL does not implicitly acquire exact reactive
facts in revision 1. Absence falls back to table-wide invalidation and no
coverage; precision never becomes an implementation-dependent or unchecked
optimization with correctness consequences.

### S9 — runtime SQL choices are finite and checked

Values are bound. Dynamic SQL text can only come from complete author-written
sort profiles or compiler-authored fragments, all prepared at generate time.
There is no runtime identifier or direction interpolation from arbitrary
input.

### S10 — page size is bounded consistently

The generated API supplies the default when absent and rejects non-integral,
non-finite, non-positive, or above-maximum values before execution. Every
platform has the same behavior; SQLite's negative-limit semantics are never
exposed as a bypass.

### S11 — compiler backend is API-invisible and target-neutral

Neutralization and enumerated variants produce the same row bag for every
input, and the same sequence when the language proves a total order. The
selected backend is represented in IR sufficiently for every requested emitter
to execute it. A source query cannot acquire different defined behavior merely
because the consumer uses Swift instead of TypeScript.

### S12 — tooling shares the compiler frontend

Generation, formatting, LSP diagnostics, hover, definition, syntax tooling,
and conformance fixtures consume the same lexical and AST model. Tooling does
not maintain a second partial grammar.

## 3. Proposed language surface

### 3.1 Complete example

```syql
import { visibleTodos } from "./todo-predicates.syql";

predicate matchesTitle(q) {
  title like '%' || :q || '%'
}

query listTodos(
  listId,
  status?,
  range?(from, to),
  q?,
  unassigned?: switch,
) {
  sql {
    select id, title, status, created_at
    from todos
    where @cover(todos.list_id = :listId)
      and @visibleTodos()
      and when(status) {
        status = :status
      }
      and when(range) {
        created_at between :from and :to
      }
      and when(q) {
        @matchesTitle(:q)
      }
      and when(unassigned) {
        assignee_id is null
      }
  }

  sort sortBy default position {
    position { position asc, id asc }
    newest { created_at desc, id desc }
    title { title collate nocase asc, id asc }
  }

  page pageSize default 50 max 200;
  identity by id;
}
```

### 3.2 Explicit `sql` section

Each query contains exactly one `sql { ... }` section. This gives the container
a real grammar boundary instead of asking a parser to infer where raw SQL ends
and query metadata begins. The SQL template is one read-only SQLite statement
without a terminator. It may contain predicate calls, reactive directives, and
explicit `when` conjuncts as defined by the specification.

### 3.3 Query inputs

Required and optional scalar values remain concise:

```syql
query byList(listId, status?, threshold?: float) { ... }
```

General annotations are allowed when inference is unavailable or the author
wants a checked constraint. `switch` is the guard-only boolean control. A
nullable value uses an explicit union:

```syql
query byStatus(status?: string | null) { ... }
```

The abstract input model distinguishes absent, present-null, and
present-non-null. Platform codegen may use a small generated input enum/wrapper
where a native optional alone cannot represent all three states.

Named groups own multiple binds:

```syql
cursor?(createdAt: integer, id: string)
```

The group name controls `when(cursor)`; its members are the SQL binds.

### 3.4 Predicates and imports

`predicate` replaces `fragment`. Predicate parameters are required scalar
binds; optionality belongs to the using query's `when` node rather than
propagating implicitly through a macro graph. A file may contain only
predicates and be imported by other files. Imports are explicit, relative,
named, and predicate-only.

This design deliberately removes:

- optional predicate parameters;
- argument-driven signature injection;
- raw-text substitution;
- a depth cap standing in for cycle detection;
- file-only reuse as the permanent module model.

### 3.5 Conditions

A `when` node is an entire top-level `WHERE` or `HAVING` conjunct:

```syql
and when(status, range) {
  status = :status
  and created_at between :from and :to
}
```

All named controls must be active for the predicate to apply. Scalar and group
controls are active when present; switches are active when true. Optional bind
references in the body must be dominated by their scalar/group control.

Keeping `when` at conjunct boundaries preserves simple, auditable lowering and
avoids creating a partial SQLite boolean parser. Authors can put arbitrary
SQLite boolean structure inside the block.

### 3.6 Reactive predicates

`@scope` and `@cover` accept a deliberately restricted set of scope bindings:

```syql
@scope(todos.list_id = :listId)

@cover(todos.list_id in (:left, :right))

@cover(
  messages.thread_id in (:left, :right),
  messages.room_id = :roomId
)
```

Both directives lower to the conjunction of the written SQL restrictions.
`@scope` additionally emits exact dependency scope keys. `@cover` emits those
dependencies plus window coverage: its first binding is the covered dimension
and remaining bindings fix every other scope on the same table instance.

Only required, type-compatible binds are allowed. The compiler resolves table
aliases, checks manifest scope columns, requires complete fixed scopes, and
prepares the lowered predicate. The reactive IR is therefore a consequence of
the same node that limits the result.

### 3.7 Sort profiles

A sort section defines one generated optional enum parameter and a finite map
from profile name to a complete `ORDER BY` term list. Profiles may use columns,
qualified columns, collations, deterministic expressions, and per-term
directions accepted by SQLite. The compiler prepares every profile.

There is no separate runtime `dir`; descending and ascending behavior are
different named profiles. When a query is bounded by `page` or authored
`LIMIT`/`OFFSET`, every sort profile must end in a compiler-proven unique
tie-breaker or generation fails with a stable-order diagnostic.

### 3.8 Page size

`page pageSize default 50 max 200;` creates one optional integer input. It is
not an ordinary user bind and cannot collide with SQL binds. Generated code
uses the default when absent and validates `1 <= pageSize <= 200` before
calling the client. The compiler inserts one bound `LIMIT` using an internal
reserved bind at the parsed outer limit-clause position.

Offset remains ordinary authored SQL on queries which do not use a `page`
section rather than becoming a language feature. Authors express keyset
predicates with atomic cursor groups. Revision 1 does not synthesize or prove
those predicates, so a cursor-bearing query uses one sort profile; distinct
cursor/order shapes use distinct queries.

### 3.9 Identity

`identity by ...;` is optional reconciliation metadata. It is accepted only
when the compiler proves that the named projected, non-null result fields form
a unique identity for the outer query shape under the conservative rules in
the specification. When it is absent, the compiler applies the specification's
deterministic baseline inference. If neither path proves identity, the runtime
uses its safe unkeyed reconciliation path. There is no unchecked identity
assertion.

## 4. Compiler architecture

The frontend becomes a conventional small compiler:

```text
UTF-8 source
    │
lossless lexer ───────────── comments/strings/quoted identifiers retained
    │
container AST + SQL token spans
    │
import graph + hygienic predicate expansion
    │
static semantics (names, types, presence, reactive facts, controls)
    │
logical query plan (conditional conjuncts, sort profiles, page, identity)
    │
backend lowering (neutralized or enumerated, API-invisible)
    │
SQLite prepare/check for every executable statement/profile
    │
platform-neutral QueryIR
    │
TS / Swift / Kotlin / Dart emitters with equivalent behavior
```

The lexer is shared by the parser, formatter, bind scanner, predicate
expander, SQL section locator, LSP, and projection lowering. It recognizes all
SQLite quoting/comment forms accepted by SYQL, including escaped single and
double quotes, backticks, bracketed identifiers, blob literals, and line/block
comments. Unsupported SQLite lexical forms fail before any rewrite.

The compiler does not normalize raw SQL with a global whitespace expression.
It may render generated nodes canonically, but source token text is retained
for ordinary SQL. A final embedding pass removes comments and normalizes
inter-token whitespace through tokens, preserving literal and quoted-token
contents.

Validation targets the portable SQLite profile pinned by the language
specification, not whatever newer SQLite happens to be linked into the
generator. The same executable corpus runs against the web, Node, and bundled
native client engines so a generator-only prepare success is not mistaken for
cross-platform support.

## 5. Backend selection

The logical plan records conditions independently of SQL lowering. Two
backends are permitted:

- **neutralized:** one statement with compiler-generated boolean presence
  binds guarding each conditional conjunct;
- **enumerated:** a finite statement table selected from the abstract
  presence/switch state.

Hidden presence binds, rather than `:value IS NULL`, preserve the distinction
between absent and present-null. Named groups use one presence bit. Switches
use truth, not nullness. Neutralization uses a lazy SQLite `CASE` guard so an
inactive predicate does not evaluate a placeholder for an absent value.

`auto` is the default compiler policy. It may use optional-group count,
statement-count caps, indexes, and `EXPLAIN QUERY PLAN`, but it must be
deterministic for a given schema/query/compiler version. The IR carries enough
information for all emitters to execute the chosen policy. Tests execute both
backends over the same data and inputs even if one is not selected in normal
generation.

No ordinary SYQL token selects a backend. An advanced compiler option may
force one for diagnostics/benchmarks, but generated public signatures and
results remain identical.

## 6. Current failure inventory and required resolution

This table is an acceptance checklist, not historical commentary. Each issue
found in the current implementation remains in scope where the replacement
touches it.

| Current issue | Required resolution in the replacement |
| --- | --- |
| Global whitespace collapse changes literals and line-comment extent | Lossless token stream; token-aware final rendering; literal/comment regression fixtures |
| Fragment renaming changes `:name` text inside strings/comments | Hygienic bind-token substitution in `predicate` expansion |
| Formatter deletes `depends`, `window`, and `key by` | Formatter emits the complete AST and proves parse/semantic equivalence before writing |
| Formatter corrupts quoted identifiers and misses SQLite operators | Shared SQLite-aware lexer; quoted/operator fixture corpus |
| Query bodies accept undeclared binds | Authoritative signature check in static semantics |
| Declared-but-unused checking is one-directional | Bidirectional declaration/use validation, including predicate arguments and group members |
| Optional auto-guard depends on raw `WHERE`/`AND` scans | Explicit top-level `when` nodes; no semantic scan for accidental optional use |
| Optional and SQL `NULL` are conflated | Abstract presence state plus hidden presence binds; explicit `| null` type |
| `from+to?` permits partial host calls | Named group emitted as one optional object/struct; untyped bridges validate atomicity |
| Reactive declarations can be unrelated to predicates | Constructive `@scope`/`@cover` nodes; otherwise table-wide/no-coverage fallback |
| `key by` checks projection but not uniqueness | Conservative identity proof; reject rather than trust |
| Negative page limits bypass max; fractional TS numbers can fail SQLite | Pre-bind finite positive integer validation on every emitter |
| Single-column `orderBy` lacks stable tie-breakers and checked expressions | Complete named sort profiles; paged profiles require unique suffix |
| Source `variants` works only in the TS emitter | Backend removed from source; selected IR behavior implemented by all emitters |
| Reactive/parser changes can miss formatter/TextMate/LSP updates | One AST/lexer package and cross-tool conformance fixture per syntax feature |
| LSP can cache stale schema context, silently degrade after manifest errors, and analyze TS naming even when other targets are configured | Watched project invalidation, explicit project-context diagnostics, and the manifest's actual requested naming targets |
| Design claimed a grammar/vector suite that did not exist | `docs/SYQL.md` plus committed source/AST/lowering/diagnostic vectors |
| Fixed fragment expansion depth rejects valid deep acyclic graphs | Real declaration/import cycle detection with no semantic depth cap |
| Clause-conflict scans see nested `ORDER BY`/`LIMIT` as outer clauses | Token-depth outer-statement analysis from the shared lexer |
| Query examples imply timestamp-only keyset pagination is stable | Docs and fixtures require a unique tie-breaker and atomic cursor group |
| An authored keyset predicate can disagree with a runtime-selected sort profile | Revision 1 documents the proof boundary and keeps cursor-bearing queries to one profile/distinct query shapes; first-class cursor generation is deferred |
| The generator's SQLite version can accept syntax/functions unavailable in a client runtime | Pin a portable SQLite dialect floor and run executable conformance across every shipped engine |
| Native query emitters can route 64-bit integers through JSON doubles | Define exact signed-64-bit `integer` semantics and require lossless host/bridge encodings |
| Time/random/connection-state SQL can change without a database invalidation | Reactive named queries from either frontend are deterministic from the database snapshot plus declared inputs; external state must be passed explicitly |

## 7. Tooling and conformance

### 7.1 Canonical formatter

`syncular fmt` remains one-style/no-options, but its primary contract is
semantic preservation:

```text
parse(source) == parse(format(source))
plan(source)  == plan(format(source))
```

Equality excludes source offsets and trivia placement but includes every
declaration, input, predicate, reactive binding, sort profile, page constraint,
identity field, and SQL token value. The formatter refuses to write if its own
round-trip assertion fails. It never silently repairs invalid source.

### 7.2 LSP and editor grammar

The LSP consumes the compiler frontend and publishes parser/static/SQLite
diagnostics with exact token spans. It supports imported predicate definition
and references, input/group hover, lowered-plan hover, and sort profile hover.
It watches manifests, migrations, and imported predicate files; a broken
project context is a diagnostic, not silent parser-only degradation.

TextMate highlighting may remain a presentation grammar, but a generated token
corpus checks it against every normative syntax class. It is not considered a
semantic parser.

### 7.3 Normative fixtures

`spec/syql/` is added with manifests for:

- lexical tokens and preserved source values;
- valid source to canonical AST JSON;
- predicate import/expansion graphs;
- static diagnostic code/span vectors;
- logical plans;
- neutralized and enumerated SQL;
- reactive metadata;
- sort/page/identity behavior;
- formatter input/output/idempotence;
- cross-emitter public shape and execution cases.

Every syntax or semantic change updates the specification and vectors in the
same commit. Unit tests may be richer but cannot replace the normative set.

## 8. Destructive replacement plan

There is intentionally no backward compatibility work. The prototype should
pay migration cost once rather than preserve two accidental languages.

| Stage | Work | Gate |
| --- | --- | --- |
| L0 | Accept this RFC and freeze `docs/SYQL.md` plus fixture JSON schemas | grammar/semantics review |
| L1 | Build lossless lexer, container AST, diagnostic spans, import graph, and parser vectors | lexical + AST vectors green |
| L2 | Implement authoritative inputs, named groups, hygienic predicates, and explicit `when` logical plan | static/expansion vectors green |
| L3 | Implement constructive reactive directives, sort profiles, page validation, and identity proof | reactive/control vectors green |
| L4 | Implement neutralized/enumerated lowering and update QueryIR | execution equivalence + SQLite check matrix green |
| L5 | Update TS, Swift, Kotlin, and Dart emitters together | cross-platform API/execution vectors green |
| L6 | Replace formatter, LSP, TextMate grammar, `--print`, and docs | round-trip/editor fixtures green |
| L7 | Rewrite every repository `.syql` file, demo, generated output, and golden; delete v1 parser/types/tests/docs | repository contains no v1 grammar or compatibility path |
| L8 | Run full repository checks, native checks, conformance, and query benchmarks | release gate green |

The cutover commit may be staged internally, but the mergeable end state does
not contain both parsers. Unversioned `.syql` means the grammar in
`docs/SYQL.md`; old source is simply invalid.

An internal one-off rewrite script is allowed to accelerate repository
conversion, but it is not a shipped migration feature and does not weaken the
new parser's rules.

## 9. Explicitly rejected approaches

- **A new relational DSL.** Replacing SQL projections, joins, grouping, and
  expressions recreates a query engine, loses SQLite fluency, and expands the
  project far beyond typed local reads.
- **Keep implicit auto-guards with a better SQL parser.** A parser could make
  the old rule safer, but optional behavior would still be invisible and null
  semantics surprising. Explicit `when` is a better language contract.
- **Jinja/comment templating.** Text inclusion has weak scope, poor tooling,
  and no safe identifier/value distinction.
- **Runtime query builders.** They are platform-specific, move checking out of
  generation, and make static invalidation/coverage facts harder.
- **Unchecked reactive annotations.** Dependency and coverage metadata affect
  correctness, not only speed. A trust-me hint is unacceptable on that path.
- **Independent optional group members.** Runtime neutralization cannot make a
  misleading host API atomic. The generated type must express the invariant.
- **Column allowlist plus arbitrary direction as the final sort model.** It is
  safe against injection but insufficient for deterministic pagination and
  real query ordering.
- **SQL-side clamping alone.** SQLite's coercion and negative-limit behavior are
  not the public validation contract. Validate before execution.
- **Source-level variants.** Backend selection is not query meaning and must
  not create platform divergence.
- **Two parsers during a deprecation period.** The repository is in prototype
  phase; preserving v1 would multiply tests/tooling and fossilize mistakes.

## 10. Non-goals

- No SSP wire-protocol change.
- No write/mutation language; writes continue through the mutation/outbox API.
- No runtime arbitrary identifier, expression, or raw SQL interpolation.
- No automatic incremental view maintenance.
- No general theorem prover for SQL containment or uniqueness. Conservative
  proof and safe fallback are sufficient.
- No requirement that all SQLite syntax receive exact parameter/result type
  inference. Annotations and the `.sql` frontend remain escape hatches.
- No built-in offset pagination feature.
- No first-class keyset cursor-predicate generation or containment proof;
  `page` is a bounded outer limit, not a pagination protocol.
- No promise that imported predicates are separately executable runtime
  objects; they disappear during generation.

## 11. Decisions required for acceptance

1. **The current `.syql` grammar is deleted, not versioned or deprecated.**
2. **`docs/SYQL.md` becomes the normative language definition.**
3. **Optional behavior is explicit through top-level `when` conjuncts.**
4. **Named groups generate one atomic optional host value.**
5. **`predicate` plus explicit imports replaces file-scoped fragments and
   optional propagation.**
6. **`@scope` and `@cover` generate the only exact SYQL reactive facts; absent
   directives fall back table-wide/uncovered.**
7. **Complete sort profiles replace `orderBy` plus free direction.**
8. **Page sizes are validated before binding on every target.**
9. **Identity is compiler-proven or omitted.**
10. **Conditional backend selection leaves source and public APIs unchanged and
    is implemented consistently by every emitter.**
11. **One lossless lexer/AST is shared across generation, formatting, and LSP.**
12. **The replacement does not land until normative vectors and the full
    cross-platform cutover are green.**
13. **Revision 1 pins a portable SQLite 3.46.0 profile validated on every
    shipped execution engine.**
14. **`integer` is exact signed 64-bit end to end; JSON-double bridges are not
    conforming.**
15. **Reactive named queries are deterministic from the database snapshot plus
    declared inputs; time, randomness, and connection state are not implicit
    dependencies.**
16. **`page` is a bounded limit, not a cursor protocol; revision 1 leaves
    cursor predicate generation/proof out of scope.**
