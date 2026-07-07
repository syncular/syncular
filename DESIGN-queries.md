# DESIGN — The query surface: two frontends, one IR, SQL underneath

Status: **shipped — Q0–Q5 complete** (2026-07-07). Q1 (guards, sql tag,
hook renames, Kysely removal), Q2 (naming map + camel emission + mutate
two-casing), Q3 (`.syql` frontend + neutralization + `--print`), Q4
(variants backend + `syncular fmt` + VS Code grammar), Q5 (`syncular lsp` +
`queryBackend` heuristic) are all implemented per §11. Decided:
extension `.syql`, camel-case emission, no fragments in the `.sql` tier,
multiple queries per `.syql` file, no `offset` knob, lowercase-keyword `fmt`
canon, pinned naming-map algorithm, two-casing `mutate` normalization (§12).
Q1 (core read guards, `sql` tag, hook renames, Kysely removal) implementable
now — it is independent of the `.syql` grammar. Supersedes the
ad-hoc named-query annotations (`-- name:` et al.) as the plan of record for
the typed read tier. Folds in four already-sense-checked decisions from the
same discussion thread: Kysely removal, hook renames, core read guards, and
the untyped `sql` tag escape hatch (§9). Nothing here changes the wire
protocol; this is entirely a codegen/DX surface.

Problem, one line: reads need **reusable filters, optional filters, safe
dynamic knobs (orderBy/limit), and typed idiomatic signatures on every
platform** — without a runtime query builder (TS-only, rejected) and without
growing a templating language inside SQL comments (dbt-Jinja failure mode).

Recommendation summary (one line per design question, argued below):

| # | Question | Recommendation |
|---|---|---|
| 1 | How many query-file formats | **Two frontends, one IR**: a minimal `.sql` frontend (sqlc-style, zero learning) and the `.syql` DSL. Both parse to the same `QueryIR`; everything downstream is frontend-agnostic |
| 2 | Where composition happens | **Generate time, always.** Every feature must: resolve at generate time, produce SQLite-checkable SQL, emit identically on all codegen targets, keep the invalidation table set static |
| 3 | `.sql` frontend scope | Deliberately minimal: `:params` + `-- name:` only. No fragments, no conditionals, no knobs (decided). It is the "any SQL tool understands this file" tier and the compatibility floor |
| 4 | DSL shape | `.syql`: functional container (GraphQL-style signatures, SQLDelight-style inference), **SQL expressions inside**, multiple queries/fragments per file (decided). Not a new query language — the skeleton is structured, the predicates are SQL |
| 5 | Conditional filters | **Auto-guarded conjuncts**: a WHERE conjunct that mentions an optional param applies only when that param is provided. Explicit `if (…) { … }` for guards whose param is not in the predicate. No `IS NULL OR` boilerplate in the DSL tier |
| 6 | Knobs | `orderBy` = allowlist (identifiers can't be bound); `limit` = bound param with codegen clamp. **No `offset` knob** — pagination is keyset, and keyset is just ordinary auto-guarded optional params (§6) |
| 7 | Casing | SQL stays snake_case; **emitters own casing** (camelCase in TS/Swift/Kotlin/Dart, snake in Rust). IR carries SQL-truth names + a collision-checked naming map; TS gets zero-cost camel results via `AS`-aliasing at lowering; `mutate` normalizes keys through the schema naming map |
| 8 | Conditional compilation | Two interchangeable backends behind one semantic: `(:p IS NULL OR …)` neutralization (default) and 2^N variant enumeration (opt-in / auto above a planner-relevant threshold). API-invisible |
| 9 | Fragments | First-class `.syql` declarations with their own params (optional params propagate into the using query's signature, GraphQL-fragment style). Splice + re-check; never a runtime concept; never in `.sql` |
| 10 | Injection stance | Values only ever bind; identifiers only enter via codegen allowlists; `client.query` gains the read-only verb allowlist + single-statement enforcement **in core** (moved out of the deleted Kysely layer) |
| 11 | Tooling | Owned as a product surface: `syncular fmt`, `generate --print <name>`, VS Code TextMate grammar with embedded `source.sql` regions, LSP staged after. Grammar + golden fixtures are spec'd like the wire vectors |

---

## 1. Architecture: two frontends, one IR

```
queries/*.sql        queries/*.syql
     │                     │
  sql frontend        syql frontend         (parsers; zero deps, hand-rolled)
     └────────┬────────────┘
          QueryIR                            (name, params, fragments applied,
     ┌────────┴────────┐                      knobs, conditional groups,
     │  expand + lower │                      naming map)
     └────────┬────────┘                     (fragment splice, guard lowering,
        plain SQL (1..n statements per query) projection aliasing, variants)
     ┌────────┴────────┐
     │  SQLite check   │                     (prepare against real schema:
     └────────┬────────┘                      types, columns, projection)
        checked QueryIR + inferred types + table set
     ┌────────┴────────┐
     │   emitters      │                     (TS / Swift / Kotlin / Dart …)
     └─────────────────┘
```

The forcing function is deliberate (and is the reason to ship both
frontends rather than one): **nothing below `QueryIR` may know which file
format a query came from.** The conformance test for the frontends is the
same trick the protocol uses for the two cores — golden fixtures where
equivalent inputs in both formats must produce byte-identical IR JSON.

`QueryIR` extends the existing typegen IR (`ir.ts` / `query.ts`), roughly:

```ts
interface QueryIrUnit {
  name: string;
  params: { sqlName: string; type: SqlType /* inferred */;
            optional: boolean; group?: string /* from+to pairing */ }[];
  sql: string;                        // lowered, static — or:
  variants?: { when: string[]; sql: string }[]; // variant backend (§7)
  tables: string[];                   // static invalidation set
  columns: { sqlName: string; type: SqlType }[]; // checked projection
  orderBy?: { allowed: string[]; default: string };
  limit?: { max?: number; default?: number };
}
```

Names in the IR are always **SQL-truth** (snake_case as authored); casing
is an emitter concern (§5). Everything after the IR already exists (SQLite
checking, per-language emitters, `tables` descriptors for live-query
invalidation) — this design adds frontends and the lowering stage, not a
new pipeline.

## 2. The `.sql` frontend — the compatibility floor

Exactly what ships today, minus ambition: UTF-8 `.sql` files, one or more
statements, `-- name: identifier` labels, `:param` binds. Checked by
SQLite, typed signatures inferred, done. **No fragments, no conditionals,
no knobs, ever** (decided). Its contract is: every SQL editor, formatter,
LLM, and `sqlite3` shell on earth understands this file with zero context.
Users who never open `.syql` still get typed cross-platform queries; users
who need one weird query the DSL can't express can always drop to it.

This tier is also the migration story: existing `queries/*.sql` files keep
working unchanged.

## 3. The `.syql` DSL — container, not query language

Design position (from the survey of sqlc, SQLDelight, GraphQL, Prisma,
PRQL/EdgeQL, dbt, Malloy): keep **SQL as the expression language**, steal
the **container** from GraphQL (named operations, declared variables,
optionality, fragments) and **inference** from SQLDelight (param and row
types come from the real schema — signatures declare only what SQL cannot
express: existence, optionality, grouping, knobs). A `.syql` file holds any
number of `query` and `fragment` declarations (decided).

Reference sketch (grammar to be spec'd per §10):

```text
fragment visibleIn(listId) {
  list_id = :listId and archived_at is null and deleted = 0
}

fragment search(q?) {
  title like '%' || :q || '%'
}

query listTodos(listId, status?, from+to?, unassigned?: flag)
  orderBy position | created_at | title default position
  limit max 200 default 50
{
  select id, title, done, created_at
  from todos
  where @visibleIn(:listId)
    and @search(:q)
    and status = :status
    and created_at between :from and :to
    and if (:unassigned) { assignee_id is null }
}
```

Notes:

- The body is SQL-shaped and every predicate is a real SQL expression —
  copy-paste fluency and SQLite checkability survive. Only the skeleton
  (signature, knob clauses, `@fragment` refs, `if` guards) is DSL.
- `@search(:q)` declares an optional param in the *fragment*; using the
  fragment adds `q?` to `listTodos`' generated signature (GraphQL-fragment
  variable propagation). This is the reuse story: define "searchable" once,
  every query that spreads it gets the optional param and the guard.
- `: flag` is the one param type annotation that exists — a boolean guard
  param that never binds into SQL (it has no `:unassigned` in any
  predicate). Everything else is inferred.

## 4. Conditionals — the design question this doc exists for

Constraint recap: "conditional" may never mean runtime SQL assembly. It
means: the finite set of possible statements is enumerated, lowered, and
SQLite-checked at generate time (§7). The question is purely *syntax* — how
does the author express "this filter applies only when its param is given"?

**Rejected — R1, comment-guard prefix in .sql** (`@when(:x) AND …`): scoping
is line-break-implied and the macro rewrites text into something that reads
differently than written. Killed in review; it's what pushed the advanced
tier out of `.sql` files entirely.

**Rejected — R2, WYSIWYG `IS NULL OR` + header annotation**: correct and
maximally boring, and it remains *valid* in both tiers (it's just SQL). But
as the primary interface it's verbose, the `from+to` form is genuinely easy
to fumble, and the user-facing point of the DSL tier is to be better than
this.

**Option A — explicit guards with delimiters:**

```text
where @visibleIn(:listId)
  and if (:status)    { status = :status }
  and if (:from, :to) { created_at between :from and :to }
```

Pro: nothing implicit; the braces bound the guarded predicate; multi-param
guards are visible. Con: ceremony on every optional filter — and the guard
param list duplicates information already present in the signature (`?`)
and in the predicate (which params it mentions).

**Option B — auto-guarded conjuncts (recommended):**

> A top-level `AND` conjunct of a `where` clause that mentions one or more
> **optional** params applies only when all of them are provided.

```text
query listTodos(listId, status?, from+to?)
{
  …
  where @visibleIn(:listId)
    and status = :status                        -- applies iff status given
    and created_at between :from and :to        -- applies iff both given
}
```

The signature's `?` is the *entire* conditional syntax. This is precise —
unlike the rejected comment-tier idea, the DSL parses the WHERE expression
into an AST, so "top-level conjunct containing `:status`" is an exact,
teachable boundary, not a textual heuristic. It also composes with
fragments for free (`@search(:q)` is a conjunct; `q` is optional; done).

Two rules keep B honest:

- **B1 — placement validator.** An optional param appearing anywhere other
  than a top-level conjunct (nested under `OR`, inside a subquery, in the
  projection) is a generate-time **error** telling the author to write an
  explicit `if` guard or make the param required. No silent weird
  semantics.
- **B2 — explicit `if` remains** for the case auto-guarding cannot express:
  a guard whose param does not appear in the predicate
  (`if (:unassigned) { assignee_id is null }`). So Option A's syntax ships
  too, as the fallback — B is sugar over A, A is the primitive, and the
  lowering is identical.

**Option C — pipeline/builder syntax** (PRQL-style `filter`, structured
where-blocks): rejected. It abandons SQL-expression fluency for the whole
body and is the first step of the "new query language" cliff (years of
parser/semantics work, breaks copy-from-anywhere, unfamiliar to LLMs).

Recommendation: **B with A as its primitive** (`if` for the flag case,
auto-guard for the 90% case), R2 always available underneath as plain SQL.

## 5. Names and casing (decided)

SQL is snake_case country and stays that way: schema, `.sql` files, and
`.syql` bodies are authored against real column names. **Casing is an
emitter concern** — the IR carries only SQL-truth names plus a derived
naming map, and each emitter renders its language's convention:

- **TS / Swift / Kotlin / Dart**: `created_at` → `createdAt` in generated
  row types, query params, and function signatures.
- **Rust** (when the emitter lands): snake_case is already idiomatic —
  identity mapping.

Mechanics:

- **Derivation + collision check.** `snake_case → camelCase` is mechanical;
  the generator errors (not warns) when two SQL names map to one language
  name (`created_at` + `createdAt` in one projection) or when a mapped name
  collides with a language keyword. Deterministic, no annotations.
- **Query results, zero-cost.** Lowering rewrites projections with aliases
  (`select created_at as createdAt`) so drivers return language-facing keys
  with no runtime mapping loop; the rewrite is visible in
  `generate --print`. Author-written `AS` aliases are respected as the
  SQL-truth name and convention-mapped like any column. Native emitters
  construct typed structs by column anyway, so aliasing costs nothing
  there either.
- **Writes.** `client.mutate` values are keyed by generated row types, so
  the generated `schema` object carries the (bijective, collision-checked)
  naming map and `mutate` normalizes keys through it — camel or snake both
  accepted, one map lookup per key. Small, contained change in
  `@syncular/client` + schema IR.
- **Raw tier is raw.** `client.query` / `useRawSql` return whatever SQLite
  returns — no magic. If you write snake, you get snake; alias in SQL if
  you want camel.
- **Opt-out.** Manifest `"naming": "camel" | "preserve"` (default
  `camel`), for codebases that want SQL-truth names everywhere.

## 6. Knobs: orderBy, limit — and why offset gets nothing

- `orderBy a | b | c default a` — the only genuine identifier problem
  (column names cannot bind). Lowered as a codegen-baked map: the generated
  function takes `orderBy?: 'a'|'b'|'c'` (an enum on native targets) +
  `dir?: 'asc'|'desc'`; user input selects *from* the allowlist and never
  becomes SQL text. Each allowed column is SQLite-checked at generate time.
- `limit max 200 default 50` — limits are **values**: they bind as ordinary
  params. The clause only adds the clamp (enforced in the generated
  function) and the default. No allowlist machinery.
- **`offset`: no knob (decided).** Three reasons. (1) It needs no feature —
  `OFFSET :o` is a plain bound value, expressible today in either tier.
  (2) Offset pagination over *live* local queries is a correctness trap,
  not a perf one: synced writes shift rows under the reader, so pages
  drift and duplicate between invalidations. (3) The right pattern —
  keyset pagination — already falls out of §4 with zero new syntax:

  ```text
  query todosPage(listId, before?)
    limit max 100 default 50
  {
    select id, title, created_at from todos
    where @visibleIn(:listId)
      and created_at < :before        -- auto-guarded: first page omits it
    order by created_at desc
  }
  ```

  First call: no `before`, newest page. Next call: pass the last row's
  `createdAt`. Stable under live updates, index-friendly, and it is just an
  optional param. This gets documented as *the* pagination recipe; `offset`
  can be revisited only with concrete evidence it's missed.
- Knobs are declared per-query; a fragment cannot carry knobs (keeps
  fragments purely predicative — revisit only with evidence).

## 7. Lowering conditionals: two backends, one semantic

- **Default — neutralization**: each guarded conjunct lowers to
  `(:p IS NULL OR (conjunct))` (all guard params disjoined for groups). One
  static statement, one prepared statement, static table set. On local
  SQLite at local-first data sizes, the planner cost of the `OR :p IS NULL`
  form is noise.
- **Opt-in / auto — variant enumeration**: lower to one statement per
  combination of provided optional groups (2^N, N = optional *groups*, not
  params), dispatch in the generated function by null-ness. Perfect index
  use, still fully generate-time-checked (every variant is prepared against
  the schema). Guard: warn at N > 4, error at N > 8 (16/256 statements) —
  a query with nine independent optional filters is a design smell, not a
  codegen challenge.

The two backends are semantically identical by construction and covered by
the same golden fixtures; switching is a per-query flag (or a future
heuristic), never an API change. This is the concrete payoff of composing
at generate time.

## 8. Injection posture (restated as invariants)

- **I1** — values only ever reach SQLite as bound parameters. True today in
  every driver (bun:sqlite, sqlite-wasm `bind`, better-sqlite3, rusqlite);
  the DSL adds no interpolation path.
- **I2** — identifiers only enter SQL via generate-time allowlists
  (`orderBy`), the generate-time naming map (§5 aliasing), or literal
  author-written SQL. There is no runtime identifier API in the typed tier.
- **I3** — `client.query()` (the raw tier) gains, **in core**, the
  read-only verb allowlist (`select/with/explain/pragma/values`) and
  single-statement enforcement (sqlite-wasm `exec` happily runs
  `SELECT …; DROP …` today; bun/better-sqlite3 don't — unify on the strict
  behavior). These guards currently live in `@syncular/kysely`, i.e. the
  package being deleted; they move before it dies.
- **I4** — the TS `sql` tagged-template helper (escape hatch tier) is
  values→params + `ident(value, allowlist)` + loud `raw()`. It is
  permanently untyped plumbing; it never grows fragments, types, or any
  feature that overlaps the DSL. One DSL, not two half-DSLs.

## 9. Folded-in decisions from the same thread

These ship in the same milestone because they are one coherent story
("the v0.3 query surface"):

- **Kysely removal**: `@syncular/kysely` deprecated + deleted from the
  tree; `useTypedQuery` and the typegen Kysely `Database` emitter go with
  it. Reasons of record: TS-only (breaks the ×5 story), weaker checking
  than generate-time SQLite, the only third-party dep in the read path.
- **Hook renames**: `useNamedQuery` → **`useQuery`** (the way),
  `useSyncQuery` → **`useRawSql<T>`** (the escape hatch). "Sync" as an
  adjective was noise (everything is synced) and misread as "synchronous".
  `useSyncStatus`/`SyncProvider` keep their names (sync is the noun there).
- **Docs**: `tooling-kysely` page dies; `tooling-queries` becomes the
  `.syql` page; migration page gains an honest "removed in 0.3" note.

## 10. Tooling (owned surface, staged)

1. `syncular generate --print <name>` — dump the lowered, checked SQL (and
   variants, and injected aliases) for any query. Ships with the DSL;
   "what does this actually run" must always be one command away.
2. `syncular fmt` — canonical formatter for `.syql` (one style, no
   options), built on the same parser. `.sql` files are left to the
   ecosystem's formatters on purpose.
3. VS Code extension — TextMate grammar with embedded `source.sql` regions
   for bodies/predicates (explicit block structure makes this easy);
   diagnostics by running `generate --check` on save. LSP (go-to-fragment,
   hover-expanded-SQL, signature hints) staged after the format stabilizes.
4. Grammar spec + golden fixtures (parse → IR JSON → lowered SQL) live in
   the repo like `spec/vectors/` — a format change requires updated
   fixtures in the same commit.

## 11. Staging

| Stage | Contents | Gate |
|---|---|---|
| Q0 | Direction decision recorded; grammar spec (EBNF) + fixture format authored | review of this doc |
| Q1 | Core guards in `client.query` (I3); `sql` tag helper (I4); hook renames; Kysely removal | existing tests + new guard tests |
| Q2 | `QueryIR` + lowering pipeline extracted in typegen; naming map + camel emission + `mutate` key normalization (§5); `.sql` frontend re-based onto it | golden IR fixtures green; casing collision tests |
| Q3 | `.syql` frontend: parser, fragments, auto-guarded conditionals (B1 validator, `if` primitive), knobs; neutralization backend; `--print` | dual-frontend equivalence fixtures; demo apps ported |
| Q4 | Variant-enumeration backend; `syncular fmt`; VS Code grammar | fixture parity across backends |
| Q5 | LSP; heuristic backend selection | usage evidence |

## 12. Q0 decisions (were open questions)

- **`fmt` canon: lowercase SQL keywords.** Matches the DSL skeleton
  keywords (`query`, `fragment`, `if`), reads calmer in a code context, and
  is where modern SQL formatters have converged. `fmt` lowercases keywords,
  preserves identifier casing (SQL-truth), one space after commas, one
  clause per line in the WHERE. No options.
- **Naming-map algorithm (`snake → camel`), pinned:**
  1. Split off and preserve any leading run of `_` as a prefix, and any
     trailing run of `_` as a suffix (they carry intent — privacy markers,
     disambiguation).
  2. Split the middle on `_`; drop empty segments from doubled underscores.
  3. First segment verbatim; each later segment gets its first character
     upper-cased, rest verbatim. **No acronym awareness** (`id_url` →
     `idUrl`, not `idURL`; `api_key` → `apiKey`) — mechanical and
     predictable beats clever.
  4. Re-attach prefix/suffix. Examples: `created_at`→`createdAt`,
     `col_2`→`col2`, `user_id`→`userId`, `_internal`→`_internal`,
     `__foo_bar`→`__fooBar`, `row_`→`row_`.
  - **Collisions and hazards are generate-time errors**, not warnings: two
    SQL names mapping to one (`col_2` + `col2`), a mapped name hitting a
    target-language keyword, or a **leading underscore on the Dart target**
    (Dart treats `_name` as library-private — a real cross-language trap).
    The error names both columns/targets and points at the manifest
    `"naming": "preserve"` opt-out or an explicit `AS` alias.
- **`mutate` key normalization accepts exactly two casings**: the canonical
  camelCase (generated row-type keys) and the SQL-truth snake_case. Both are
  a single bijective-map lookup; anything else is an error (no fuzzy
  matching, no per-key case-insensitive scan). Predictable and O(1).
