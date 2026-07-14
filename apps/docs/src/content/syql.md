# SYQL language

SYQL revision 1 is Syncular's compile-time language for checked, reactive
SQLite reads. A `.syql` file describes a public query operation while keeping
SQLite as the relational and expression language. Typegen validates the query
against your generated schema and emits the same contract for TypeScript,
Swift, Kotlin, and Dart.

This page is the authoring guide. The
[SYQL language specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md)
is normative and defines the exact grammar, static semantics, lowering rules,
SQLite profile, diagnostics, and conformance requirements. Revision 1 was
accepted by
[RFC 0004](https://github.com/syncular/syncular/blob/main/docs/rfcs/0004-syql-language.md).

## When to use SYQL

Use a plain `.sql` named query when fixed SQLite with named parameters is
enough. Use `.syql` when the query needs one or more of these:

- optional filters with explicit presence semantics;
- an atomic optional input made of several values;
- reusable, imported predicates;
- precise reactive scope or coverage facts;
- a finite choice of complete sort orders;
- a bounded page size;
- checked row identity for keyed reconciliation.

SYQL has no runtime parser. It lowers at generation time to ordinary prepared
SQLite statements and QueryIR.

## Complete example

```syql
import { matchesTitle } from "./todo-predicates.syql";

query listTodos(
  listId,
  status?: string | null,
  range?(start: integer, end: integer),
  q?: string,
  unassigned?: switch,
) {
  sql {
    select id, title, status, created_at
    from todos
    where @cover(todos.list_id = :listId)
      and when(status) {
        status is :status
      }
      and when(range) {
        created_at between :start and :end
      }
      and when(q) {
        @matchesTitle(:q)
      }
      and when(unassigned) {
        assignee_id is null
      }
  }

  sort sortBy default newest {
    newest { created_at desc, id desc }
    oldest { created_at asc, id asc }
    title { title collate nocase asc, id asc }
  }

  page pageSize default 50 max 200;
  identity by id;
}
```

The query signature is the public API authority. The `sql` block is required;
`sort`, `page`, and `identity` follow it in that order when present. SQL values
always enter executable statements as binds—runtime input cannot become an
identifier, operator, keyword, or arbitrary SQL fragment.

## Inputs and presence

SYQL distinguishes input presence from SQL nullability:

| Declaration | Meaning |
|---|---|
| `listId` | Required scalar; type inferred from checked SQL evidence |
| `q?: string` | Optional, non-null scalar |
| `status?: string \| null` | Optional nullable scalar: absent, present null, and present value are distinct |
| `range?(start: integer, end: integer)` | One optional object/struct whose members are both required when present |
| `unassigned?: switch` | Guard-only boolean control; false means absent and true means active |

Every optional value used by SQL must be dominated by an explicit `when`
conjunct:

```syql
and when(status) {
  status is :status
}
```

If `status` is absent, the whole conjunct is inactive. If it is present with
SQL null, the predicate remains active and matches null statuses. Merely
mentioning an optional bind never makes a predicate conditional.

TypeScript represents optional nullable values with `SyqlPresent<T>` and the
`syqlPresent(value)` helper. Native emitters generate equivalent presence
types. SYQL `integer` is an exact signed 64-bit value: TypeScript uses
`bigint`, Swift `Int64`, Kotlin `Long`, and Dart `int`.

## Reusable predicates and imports

A predicate library is another `.syql` module:

```syql
predicate matchesTitle(needle: string) {
  title like '%' || :needle || '%'
}
```

Import named predicates explicitly and call them with `@`:

```syql
import { matchesTitle } from "./todo-predicates.syql";

and when(q) {
  @matchesTitle(:q)
}
```

Expansion is hygienic: arguments are resolved by token identity, not raw text
replacement. Imports must stay inside the manifest root, declarations have
closed signatures, and missing names, arity mismatches, unused parameters, and
complete import or predicate cycles are generation errors.

## Reactive scope and coverage

`@scope` and `@cover` are constructive SQL predicates rather than unchecked
metadata:

```syql
@scope(todos.list_id = :listId)
@cover(todos.list_id in (:left, :right))
```

Both emit the written SQL restriction and derive matching invalidation keys
from the same syntax node. `@cover` additionally proves that the requested
local window is complete, so it must bind every declared scope dimension for
that table instance using required inputs.

When the compiler cannot prove a precise restriction, it falls back safely to
table-wide dependency and no coverage. It never narrows invalidation from an
unverified assertion.

## Sort, page, and identity

A sort profile is a complete, author-written `ORDER BY` list. Runtime callers
select a profile name; they cannot supply a direction or identifier:

```syql
sort sortBy default newest {
  newest { created_at desc, id desc }
  oldest { created_at asc, id asc }
}
```

For bounded queries, every profile must end in a proven unique identity suffix
so equal leading values cannot make the result unstable.

```syql
page pageSize default 50 max 200;
identity by id;
```

`page` creates one optional, validated public input. Every emitter rejects
non-integral, non-positive, or over-maximum values before querying. `identity`
must name projected, non-null fields that the compiler can prove unique for
the outer result. Omit it when keyed identity cannot be proved.

## SQLite and determinism

Revision 1 targets the portable SQLite 3.46.0 core profile. Typegen rejects
unknown, extension-provided, compile-option-dependent, or post-profile
functions even when its host SQLite happens to provide them. Portable
collations are `BINARY`, `NOCASE`, and `RTRIM`.

Queries are read-only and snapshot-deterministic. Randomness, implicit clocks,
connection-local state, and SQLite-version inspection are rejected. External
state must arrive as an explicit required input. Revision 1 also rejects window
expressions and nested `LIMIT`/`OFFSET` because it does not define a local
total-order proof for those shapes.

Every concrete statement selected by conditional lowering is prepared against
the generated schema before code is emitted.

## Generated contract

All targets consume the same QueryIR and expose the same logical operation.
For example, TypeScript calls the query above as:

```ts
import { listTodos, syqlPresent } from './syncular.queries';

const rows = await listTodos(client, {
  listId: 'demo',
  status: syqlPresent(null),
  range: { start: 100n, end: 500n },
  sortBy: 'newest',
  pageSize: 25,
});
```

The compiler may implement optional behavior with one neutralized statement or
a finite statement matrix. That physical choice is not source syntax and does
not change the public API or results.

See [Named queries](/tooling-queries/) for output configuration and generated
TypeScript, React, Swift, Kotlin, and Dart call sites.

## Tooling

- `syncular generate --print <name>` prints public inputs, selected backend,
  statement selectors, checked SQL, and physical binds.
- `syncular fmt [files...]` formats revision-1 source canonically. Add
  `--check` in CI.
- `syncular lsp` runs the schema- and project-aware language server with
  diagnostics, hover, symbols, formatting, and imported-predicate navigation.
- `editors/vscode-syql` provides TextMate highlighting and the LSP client.
- [`spec/syql`](https://github.com/syncular/syncular/tree/main/spec/syql)
  contains the normative lexer, parser, semantic, lowering, formatter, and
  cross-emitter fixtures.

## Where to go next

- [Named queries and generated outputs](/tooling-queries/)
- [Schema and typegen](/guide-schema/)
- [SYQL language specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md)
- [RFC 0004](https://github.com/syncular/syncular/blob/main/docs/rfcs/0004-syql-language.md)
