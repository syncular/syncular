# Named-query architecture

This document describes the implemented architecture for generated read
queries. It is not the SYQL language definition. The normative language is
[`SYQL.md`](SYQL.md), the redesign rationale and acceptance record are
[`RFC 0004`](rfcs/0004-syql-language.md), and the executable contract lives in
[`spec/syql`](../spec/syql/).

## 1. Purpose

Syncular needs a typed read tier which works identically across TypeScript,
Swift, Kotlin, and Dart while keeping SQL as the database language. Named
queries provide:

- generate-time SQLite syntax and schema checking;
- typed inputs and a query-specific projection row;
- deterministic SQL and bind selection;
- exact or conservative reactive dependency metadata;
- optional proven window coverage and row identity;
- stable, target-neutral QueryIR consumed by every emitter.

Writes are deliberately excluded. They continue through `mutate()` and the
outbox so optimistic state, conflict policy, and replication remain explicit.

## 2. Two frontends, one compiler boundary

```text
queries/**/*.sql ── plain SQL analysis ───────────────┐
                                                      │
queries/**/*.syql ─ lexer/parser/modules/semantics ──┼─> AnalyzedQuery
                         │                            │       │
                         └─ validation + lowering ────┘       v
                                                        QueryIR v3
                                                            │
                                   ┌──────────────┬──────────┼──────────┬─────────┐
                                   v              v          v          v         v
                              TypeScript       Swift      Kotlin      Dart      Rust
```

The `.sql` frontend handles fixed reads: one or more named statements, named
`:params`, and optional `-- param` type evidence. Conditional and reactive
language features belong to the `.syql` frontend.

The `.syql` frontend has a lossless lexer, a container AST around SQL token
templates, an explicit module graph, hygienic predicate expansion, static
input/presence semantics, schema-aware validation, and logical-to-physical
lowering.

Both frontends produce `AnalyzedQuery`. Revision-1 queries attach `syql`
metadata containing public inputs, proven identity, and the selected physical
plan. Emitters consume that metadata rather than reverse-engineering optional
semantics from SQLite binds.

Result columns and inferred binds describe the application-facing local
database. For an encrypted column this means its pre-wire `declaredType`, not
the ciphertext `bytes` type recorded in schema IR. A comparison such as
`encrypted_patient_id = :patientId` therefore generates a string bind when the
declared column was `TEXT`; ciphertext conversion remains exclusively at the
Syncular wire boundary.

## 3. QueryIR v3

QueryIR is the deterministic serialization boundary between analysis and code
generation. The normative revision-1 schema is
[`spec/syql/schema/query-ir.schema.json`](../spec/syql/schema/query-ir.schema.json).

Every query records:

- authored and lowered SQL;
- positional SQL and ordered physical binds;
- result columns with language names, types, nullability, fidelity, and proven
  origins where available;
- read tables, dependencies, coverage, and optional row key;
- for SYQL, revision-1 public inputs and the complete selected statement plan.

The physical plan contains no `auto` state. It records either `neutralize` or
`variants`, activation controls in declaration order, logical conditions, and
every SQLite-checked statement with its selectors and bind derivations. A
target emitter implements this plan exactly; it does not choose its own
backend.

The serializer uses fixed key order, two-space JSON indentation, LF, and a
trailing newline. Its hash is part of generated query identity, so a SQL-only
change cannot reuse stale reactive cache state.

## 4. Revision-1 lowering

Conditional meaning exists in the logical plan as explicit `when` nodes.
Lowering may use either of two equivalent strategies:

- `neutralize`: compiler-generated boolean activation binds guard condition
  bodies with lazy `CASE` expressions;
- `variants`: a finite statement table selected by activation bitmask and sort
  profile.

Hidden activation binds preserve absent versus present-null. Optional groups
have one activation bit and generate one optional host value. Default-false
booleans activate on `true`. Page size remains a validated bound value. Sort
choices select only complete checked profiles; no identifier or direction is
interpolated from an untrusted string.

`queryBackend` is an advanced manifest override with `auto` as the default.
The current deterministic heuristic enumerates up to two activation controls
subject to the statement cap; larger plans use neutralization. The public API
and result semantics are identical.

## 5. Reactive proof boundary

Plain SQL analysis infers conservatively from table reads and required
conjunctive scope equalities. Joins, `OR`, grouping, ambiguous aliases, or
unproven identities fall back to table-wide dependencies, no coverage, and/or
unkeyed reconciliation.

SYQL infers exact dependency facts from ordinary required equality/`IN`
predicates over schema scope columns. `sync query` explicitly requests coverage
and is accepted only when one table instance and all its scopes are proven.
Result identity is inferred conservatively from schema keys and the projection.

These facts are correctness inputs to invalidation and readiness. They are
never accepted as unchecked hints.

## 6. Determinism and portability

A revision-1 query is a function of its database snapshot and declared inputs.
Wall-clock, random, connection-local, mutation-counter, and SQLite-version
functions are rejected. External values such as a clock or seed must be
required inputs so they participate in the API and query identity.

Bounded outer results require a proven identity and a total outer order ending
in that identity. Revision 1 has no nested-statement identity proof or window
partition proof, so nested `LIMIT`/`OFFSET` and every `OVER` expression are
rejected. This is intentionally conservative.

The language profile is SQLite 3.46.0. Conformance work must exercise the
portable lexical/function surface and every executable plan against shipped
engines; generator acceptance alone is not sufficient evidence of portability.

SYQL `integer` means exact signed 64-bit. TypeScript uses `bigint` for public
SYQL inputs, Swift uses `Int64`, Kotlin uses `Long`, Dart uses `int`, and Rust
uses `i64`.
Bridges must not route these inputs through an inexact JSON double.

## 7. Generated APIs

All emitters expose the same logical inputs:

- required scalar;
- optional non-null scalar;
- optional nullable scalar with explicit presence;
- optional atomic group with required members;
- boolean defaulting false;
- finite sort profile enum/union;
- bounded optional page size.

Every emitter validates public input shape and page bounds before execution,
selects the QueryIR statement deterministically, derives positional binds, and
uses a stable runtime error code for invalid input. TypeScript emits a
`NamedQuery` descriptor for React's revisioned query store. Rust emits a
framework-neutral `QueryDescriptor`, strict typed `run`, and atomic typed
`snapshot`; a Rust host can combine the descriptor with `ClientChangeBatch`
without restating dependencies or coverage.

## 8. Tool ownership

The lossless lexer/parser and semantic graph are shared by generation,
formatting, and the language server:

- `syncular fmt` regenerates trivia, lowercases recognized SQL keywords, and
  refuses output unless normalized semantic AST and comment order are equal;
- `syncular lsp` recompiles with manifest, migrations, imports, requested
  targets, and watched-file invalidation; it exposes exact diagnostics, hover,
  definition, references, symbols, and formatting;
- the VS Code TextMate grammar is presentation-only and mirrors revision-1
  syntax classes;
- `generate --print` exposes public inputs and the real selected statements and
  binds.

## 9. Change discipline

Changing SYQL syntax or meaning requires one change set to update:

1. `docs/SYQL.md`;
2. relevant JSON Schemas and normative vectors under `spec/syql`;
3. parser/semantic/validator/lowering tests;
4. formatter, LSP, and editor grammar when affected;
5. all five emitters and generated fixtures when the public/physical contract
   changes;
6. this architecture document and user-facing docs.
