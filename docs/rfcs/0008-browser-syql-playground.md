# RFC 0008: Browser SYQL playground

- Status: accepted and implemented 2026-07-19
- Authors: Syncular maintainers
- Last updated: 2026-07-19
- Scope: `apps/docs`, the browser-safe `packages/typegen` SYQL surface, and the
  shared SYQL editor grammar
- Related language RFC: [RFC 0004](./0004-syql-language.md)
- Normative language: [`docs/SYQL.md`](../SYQL.md)

## Summary

Add a browser-based SYQL playground to the Syncular documentation site. The
playground presents editable SYQL on the left and the compiler-selected
physical SQL on the right. A small catalog of schema-backed examples lets a
reader switch quickly between typed queries, optional predicates, finite sort
profiles, bounded limits, sync coverage, ranges, and reusable predicates.

The playground uses the same TextMate grammar and language configuration as
the repository's VS Code extension. It uses the real revision-1 parser,
semantic analyzer, schema/SQLite validator, formatter, and lowerer rather than
maintaining a demonstration-only transform.

All compilation runs locally in a Web Worker. An in-memory SQLite WASM database
provides the existing `QueryDb` prepare/description boundary. The published
documentation remains a static asset deployment: no compilation API, user
database, login, server-side execution, or persisted playground state is
introduced.

## Motivation

SYQL is intentionally close to SQLite, but its important behavior becomes
visible only after compilation:

- `when` nodes may be omitted as finite variants or neutralized behind private
  activation binds;
- ranges become two internal binds;
- sort controls become a closed set of checked `ORDER BY` statements;
- limits become validated private binds;
- projection names may be lowered to target-language names;
- reusable predicates expand hygienically;
- query inputs, dependencies, coverage, and row identity are inferred from the
  query and schema; and
- the selected physical plan may contain more than one SQL statement.

The language guide can explain these rules and show isolated source snippets,
but it cannot give a reader a fast answer to “what does this query actually
run?” The command-line `generate --print` path answers that question in a real
project, but it requires a checkout, manifest, migrations, and toolchain. It is
too expensive for exploration and cannot serve as the first contact with the
language.

The repository already has nearly all of the required authorities:

1. the VS Code extension owns a TextMate grammar and language configuration;
2. the docs already load that grammar through Shiki for static examples;
3. typegen exposes source-spanned parser and semantic diagnostics;
4. validation is abstracted behind the small synchronous `QueryDb` interface;
5. the web client already depends on the official SQLite WASM package; and
6. lowering already exposes the selected plan, statements, binds, public
   inputs, dependencies, coverage, and identity.

The missing work is a browser-safe composition boundary and a focused user
interface over those existing pieces.

## Design principles

1. The playground demonstrates the shipped compiler, not an approximation.
2. The VS Code extension, static docs, and browser editor share one SYQL grammar.
3. Schema-aware behavior must be honest: every example carries the schema
   against which it is compiled.
4. The SQL pane represents the complete selected plan, including multiplicity.
5. Heavy editor and compiler assets load only on the playground route.
6. Compilation stays off the main thread and never requires a remote service.
7. Invalid input remains editable and receives stable, source-spanned feedback.
8. The first revision is deliberately small enough to remain understandable.

## Goals

- Provide a dedicated `/playground/` documentation route.
- Make the left pane an accessible, editable SYQL editor.
- Highlight it with the repository's existing SYQL and embedded SQL grammars.
- Compile edits after a short debounce using the real revision-1 compiler.
- Show the selected physical SQL plan and its bind metadata.
- Make generated variants and sort profiles directly selectable.
- Map compiler diagnostics to editor markers and a readable diagnostics strip.
- Offer tolerant, schema-aware completions for SYQL structure, table and column
  names, aliases, and declared inputs.
- Provide representative examples that switch without navigation or reload.
- Expose the example schema in a compact read-only view.
- Keep normal documentation pages free from Monaco, browser Shiki, and SQLite
  WASM bundles.
- Preserve the current static docs deployment and optional subpath build.

## Non-goals

- Executing a query against application data or displaying result rows.
- Connecting to a user's Syncular deployment, local database, or account.
- Editing migrations, manifests, or neutral schema IR in revision 1.
- A complete browser IDE, project tree, or LSP transport.
- Multi-file imports in revision 1. Local predicates in the same virtual file
  are supported.
- Publishing or replacing the VS Code extension.
- Making Monaco or SQLite WASM a dependency of normal documentation routes.
- Persisting source in a server database, account, cookie, or browser OPFS.
- Defining new SYQL syntax, diagnostic codes, lowering behavior, or QueryIR
  fields.
- Promising that one SYQL query always corresponds to one SQL statement.

## User experience

### Route and layout

The docs navigation adds **SYQL playground** immediately after **SYQL
language**. The page uses the existing docs shell and teletype palette, but the
content area opts into a wide layout instead of the ordinary 47-rem article
column.

On desktop the primary workspace is a two-column split:

```text
+--------------------------------------------------------------------------+
| BASIC  OPTIONAL  SORT + LIMIT  SYNC COVERAGE  PREDICATE        RESET     |
+------------------------------------+-------------------------------------+
| SYQL                               | SQL · VARIANTS · 8 STATEMENTS       |
|                                    | query: listTodos                    |
| query listTodos(...) {             | case: status absent · newest       |
|   select ...                       |                                     |
| }                                  | select ...                          |
|                                    |                                     |
+------------------------------------+-------------------------------------+
| schema: todos · 7 columns · scope list_id | ✓ compiled · 12 ms          |
+--------------------------------------------------------------------------+
```

Below the desktop breakpoint the panes stack vertically. Example choices
remain horizontally scrollable, and each editor retains a useful fixed minimum
height. The page must not require horizontal viewport scrolling on a supported
mobile width.

### Example switching

Revision 1 ships at least these examples:

1. **Basic typed query** — required inputs, projection typing, and row identity.
2. **Optional filters** — optional nullable values, a boolean flag, and an
   inclusive range.
3. **Sort + limit** — finite sort profiles, deterministic tie-breakers, and a
   bounded limit.
4. **Sync coverage** — a scoped `sync query` and the difference between local
   dependencies and download coverage.
5. **Reusable predicate** — a predicate declared in the same source file and
   expanded into a query.

Examples use one small `todos`-oriented schema where practical so switching
does not repeatedly initialize unrelated databases. Each example owns:

```ts
interface PlaygroundExample {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly source: string;
  readonly schemaId: string;
}
```

Schemas are immutable `IrDocument` fixtures keyed by `schemaId`. They are
authored as ordinary TypeScript fixtures and exercised by tests. They are not
handwritten JSON embedded in HTML attributes.

The editor keeps one in-memory draft per example while the page is open.
Switching away and back restores that draft. **Reset** restores only the active
example. Reloading the page restores repository defaults. The selected example
may be represented by `?example=<id>` so documentation can link to a concept;
edited source is not placed in the URL in revision 1.

### SYQL editor

The left pane uses `monaco-editor-core` with `@shikijs/monaco`. The browser
highlighter loads:

- `editors/vscode-syql/syntaxes/syql.tmLanguage.json`;
- the SQL TextMate grammar already used by the docs; and
- `editors/vscode-syql/language-configuration.json` translated into Monaco's
  comment, bracket, auto-closing, and surrounding-pair configuration.

The TextMate file remains the syntax-coloring authority. The playground must
not introduce a separate regex tokenizer or a second handwritten SYQL grammar.

The editor supports ordinary text editing, undo/redo, selection, find, bracket
matching, and automatic indentation supplied by Monaco. A tolerant completion
provider offers declaration and clause snippets, schema tables after `FROM` or
`JOIN`, columns after a table or alias qualifier, and declared query inputs
after `:`. It operates on incomplete text and treats the compiler as the sole
validation authority. Revision 1 does not claim hover, definitions,
references, or full LSP behavior.

The **Format** action calls the existing semantic-preserving `formatSyql`
implementation in the compiler worker. Formatting replaces the active model
as one undoable edit and does not run automatically while typing.

### SQL plan pane

The right pane is a read-only SQL-highlighted Monaco model. It displays named
SQL by default because named binds preserve the connection between source and
generated controls. An advanced toggle may show positional SQL and the ordered
bind plan, but named SQL is the primary presentation.

The pane header always identifies:

- the selected query declaration when a source file contains more than one;
- the selected lowering backend (`variants` or `neutralize`);
- the total generated statement count;
- the active sort profile, when present; and
- the activation case, when the variants backend is selected.

The UI must not expose only `activationMask: 3` as the user-facing label. It
derives a readable label from the plan's ordered activation controls, such as
`status present · range absent · newest`. The raw mask may remain in an
advanced metadata view.

When the selected plan contains multiple statements, the user can switch
statements without changing SYQL input. The initial selection is the
compiler's canonical statement: the default sort profile and the all-absent
activation case for variants, or the default sort profile for neutralization.

The plan metadata drawer shows:

- public inputs and inferred types;
- ordered physical binds and bind kinds;
- reactive table/scope dependencies;
- synchronization coverage; and
- proven row identity, when present.

This metadata comes directly from the lowered analysis. The playground does
not recompute or summarize semantic facts from SQL text.

### Diagnostics and invalid edits

Source-spanned `SyqlFrontendError` values become Monaco markers with their
stable SYQL code, concise detail, line, and column. Schema preparation runs
before bind inference so an unknown table, alias, or column cannot be hidden by
a downstream uninferrable-bind error. SQLite reference failures are refined
with the offending source token, table/column context, ambiguity choices, and
a conservative nearest-name suggestion. Non-spanned `TypegenError` values
attach to the whole model unless a more precise span is available.

On a failed compilation:

- the source remains editable;
- the last successful SQL remains visible but is dimmed and labelled **stale**;
- the status strip announces the error count;
- selecting a diagnostic focuses its source location; and
- a later successful compilation clears stale state and obsolete markers.

The worker assigns no diagnostic code that could be confused with a normative
SYQL compiler code. Playground-only restrictions use a `PLAYGROUND` prefix.
For example, an import in revision 1 produces a clear
`PLAYGROUND_IMPORTS_UNAVAILABLE` diagnostic while retaining the import's source
span.

## Architecture

### Static route

`apps/docs/src/pages/playground.astro` renders the shell, toolbar, editor
containers, schema drawer, loading state, and non-JavaScript explanation. The
page client is a route-specific module; none of its editor or compiler imports
are reachable from the shared docs layout.

The existing `Docs.astro` layout gains a narrow additive option for wide
content. The agent-assets build generates a concise `playground.md` companion,
so the interactive route retains the same Markdown alternate and discovery
contract as the rest of the docs. Ordinary Markdown routes retain their
existing output structure.

The Astro client router means the playground can be entered and left without a
full page load. The page module mounts on `astro:page-load` and disposes Monaco
models, editor instances, worker listeners, timers, and the worker itself on
`astro:before-swap`. Re-entering creates a clean in-memory session.

### Browser-safe compiler entry point

The docs app must not import the broad `@syncular/typegen` root into a browser
bundle. That root also exports filesystem, process, Bun SQLite, and codegen
orchestration modules which do not belong in the browser.

Typegen adds a narrow browser-safe subpath, provisionally
`@syncular/typegen/syql-browser`, containing only the portable SYQL composition
surface. It exports a function shaped like:

```ts
interface CompileSyqlSourceOptions {
  readonly file?: string;
  readonly naming?: QueryNamingOptions;
  readonly backend?: QueryBackend;
}

interface CompiledSyqlSource {
  readonly queries: readonly SyqlLoweredQuery[];
}

function compileSyqlSource(
  source: string,
  ir: IrDocument,
  db: QueryDb,
  options?: CompileSyqlSourceOptions,
): CompiledSyqlSource;
```

The function composes the existing parser, semantic analyzer, validator, and
lowerer. It neither initializes SQLite nor owns asynchronous browser APIs.
`QueryDb` remains the portable synchronous seam.

Revision 1 builds a one-file virtual module graph. A file may contain any
number of local predicates and queries. Imports receive the playground-only
diagnostic described above. A later revision can accept a virtual file map and
reuse the ordinary import-graph behavior without changing the compilation
result contract.

The published package subpath resolves to its compiled `dist` entry. The docs
Vite configuration aliases that subpath to the workspace source during local
site builds so `bun run --cwd apps/docs build` does not depend on a previously
materialized package `dist` directory.

The browser entry point must be covered by a bundle test which fails on any
reachable `node:`, `bun:`, filesystem, process, or CLI import.

### Compiler worker

`apps/docs/src/playground/compiler.worker.ts` owns:

- lazy SQLite WASM initialization;
- one in-memory SQLite database for the active schema;
- the `QueryDb` adapter;
- compilation and formatting requests; and
- serialization of success and diagnostic results.

The main thread sends monotonically numbered requests:

```ts
type PlaygroundWorkerRequest =
  | {
      readonly kind: 'compile';
      readonly requestId: number;
      readonly schemaId: string;
      readonly source: string;
    }
  | {
      readonly kind: 'format';
      readonly requestId: number;
      readonly source: string;
    };
```

The worker echoes `requestId`. The main thread ignores any response older than
the most recently submitted request, preventing a slow schema initialization
or large compilation from replacing newer editor state.

The active database is recreated when `schemaId` changes. The worker executes
`synthesizeDdl(ir)` against an ephemeral `:memory:` database. Its `QueryDb`
adapter prepares each candidate statement and returns result column names,
declared types, and bind parameter count. Every prepared statement is finalized
in `finally`, and the database is closed when replaced. Terminating the worker
releases its final ephemeral database and WASM realm as one resource boundary.

SQLite WASM runs in the worker to keep initialization, parsing, and statement
description away from the main thread. The playground does not use OPFS,
SharedArrayBuffer, or persistent database state.

### Result contract

Worker responses are structured data, never rendered HTML. A successful
compile contains only the information the UI needs:

```ts
interface PlaygroundCompileSuccess {
  readonly kind: 'compiled';
  readonly requestId: number;
  readonly queries: readonly {
    readonly name: string;
    readonly backend: 'variants' | 'neutralize';
    readonly statements: readonly {
      readonly sql: string;
      readonly positionalSql: string;
      readonly sortProfile?: string;
      readonly activationMask?: number;
      readonly activationLabel: string;
      readonly binds: readonly QuerySyqlPlanBind[];
    }[];
    readonly inputs: readonly QuerySyqlPublicInput[];
    readonly dependencies: QueryReactiveMetadata['dependencies'];
    readonly coverage: QueryReactiveMetadata['coverage'];
    readonly identity?: readonly string[];
  }[];
}
```

The adapter may use a repository-local serializable DTO rather than exporting
the complete internal `SyqlLoweredQuery`. Maps, AST nodes, schema objects, and
source text are not echoed unnecessarily across the worker boundary.

### Debouncing and loading

The main thread submits compilation approximately 150 milliseconds after the
last content change. Example selection and Reset compile immediately. Format
is explicit and never races a pending compilation: the formatter response is
applied only if the model version that requested it is still current.

The initial HTML renders instantly with a loading shell. Monaco, browser Shiki,
the worker, and SQLite WASM load only after the playground client mounts. The
first example source remains visible as plain preformatted fallback content
until the editable model is ready.

## Highlighting and theme authority

The grammar file is shared, but Monaco cannot consume the docs site's CSS
variable theme directly as its token theme. The playground defines one
`syncular-dark` Shiki/Monaco theme using the concrete values already established
by `public/style.css`:

- background/panel: `#0a0908`;
- foreground: `#f4efe4`;
- comments: `#756f64`;
- keywords: `#ffb000`;
- strings: `#a9bf6e`;
- constants: `#6fb3c0`; and
- functions/types: `#e3d3a2`.

The theme mapping may be exported from one TypeScript module used by the
playground and its highlighter tests. The grammar and scope names remain the
semantic authority; duplicating concrete palette values for Monaco is an
accepted presentation cost.

The existing Shiki grammar test is extended to load the same shared
registration helper as the playground. It continues to prove that embedded SQL
highlighting resumes correctly after nested SYQL blocks.

## Schema presentation

Every example displays a read-only schema summary because transformed SQL and
validation cannot be understood honestly without it. The collapsed summary
names the active tables, column count, and scope columns. Expanding it shows:

- table names and primary keys;
- column names, types, and nullability;
- declared scopes; and
- relevant indexes or FTS projections when an example requires them.

The schema view renders from `IrDocument`, not a second descriptive model. It
does not expose internal extensions whose values have no teaching value.

An editable schema pane is deferred. Introducing it requires a separate choice
between migration SQL, manifest fragments, and raw IR; revision 1 does not make
that product decision implicitly.

## Accessibility

- Both editor containers have visible labels independent of placeholder text.
- The source editor is first in focus order; the read-only SQL model is still
  keyboard scrollable and selectable.
- Example choices use native buttons with `aria-pressed` or a native tablist
  implementation with complete keyboard behavior.
- Compile status uses a polite live region and does not announce every
  keystroke while compilation is pending.
- Diagnostics are available both as editor markers and as ordinary selectable
  text outside the editor.
- Color is not the only indicator for success, stale output, error state, or
  the active example.
- The split view does not require pointer dragging; revision 1 may use a fixed
  responsive split instead of a resizable separator.
- Motion obeys the existing `prefers-reduced-motion` behavior.

## Performance and resource bounds

The playground is intentionally heavier than an article page, so route
isolation is a contract rather than an optimization suggestion.

- Monaco, `@shikijs/monaco`, browser Shiki, SQLite JavaScript, and the WASM
  binary appear only in playground chunks.
- Compilation runs only in the worker.
- At most one active worker and one active in-memory schema database exist per
  mounted playground.
- Source is capped at 64 KiB in revision 1. The editor remains usable above the
  limit, but compilation returns a playground diagnostic until the source is
  reduced.
- Lowering retains the compiler's existing 256-statement enumeration limit.
- Stale worker results are discarded by request ID.
- Example schemas remain small teaching fixtures, not benchmark schemas.

The built site records the route's compressed JavaScript and WASM sizes in a
smoke test or build report. This RFC does not set a byte budget before the first
implementation measurement, but it forbids accidental inclusion in shared
docs chunks.

### Initial production measurement

The 2026-07-19 production build produced the following route-local assets.
Gzip figures are measured with the platform `gzip -n` command and are recorded
as the baseline rather than a release budget.

| asset | raw bytes | gzip bytes |
| --- | ---: | ---: |
| playground client (Monaco + Shiki) | 3,839,033 | 983,856 |
| SYQL compiler worker | 303,359 | 91,076 |
| Monaco editor worker | 279,949 | 85,657 |
| SQLite WASM | 864,752 | 401,052 |

Only `/playground/` references the playground client. The worker and WASM URLs
are reachable from that client/worker graph and do not appear in ordinary docs
HTML. The optional subpath build rebases root-absolute Vite asset URLs inside
JavaScript as well as HTML and CSS.

## Security and privacy

All source and schema processing occurs locally. The docs Worker receives only
the ordinary static asset requests needed to load the page and its chunks.
There is no compile endpoint and no request containing authored SYQL.

The in-memory database contains schema DDL only. The playground never executes
the generated query against user-provided rows, attaches external databases,
opens OPFS, or accepts arbitrary SQLite extensions. SQLite preparation remains
subject to the compiler's read-only and portable-function validation.

The UI renders compiler output and diagnostic messages as text model values,
not `innerHTML`. Example descriptions are repository-authored static content.

Revision 1 does not store drafts in local storage, analytics events, cookies,
or a remote service. If anonymous usage metrics are added later, they require a
separate privacy decision and may not include source, SQL, binds, schema, or
diagnostic text.

## Static deployment and subpaths

The route remains compatible with the docs app's static Astro output and
Cloudflare Workers static-assets deployment. The compiler worker is created
with an import-relative URL so Vite fingerprints and relocates it with the
site's other assets.

SQLite WASM asset location must be verified in both builds:

```sh
bun run --cwd apps/docs build
DOCS_BASE=/syncular/ bun run --cwd apps/docs build
```

The optional subpath build must load the editor worker and WASM without a
root-domain assumption. If the SQLite package's bundler entry cannot satisfy
that requirement through Vite, the docs build copies its exact runtime files
to a fingerprinted asset directory and supplies an explicit `locateFile`
function. A hardcoded production origin is not accepted.

## Compatibility

- No protocol, schema IR, QueryIR, manifest, or generated-target version
  changes are required.
- No existing docs route or Markdown content changes meaning.
- The typegen browser subpath is additive and does not change the package root.
- Successful CLI, formatter, and generated outputs remain byte-identical; the
  LSP shares the more precise compiler diagnostic detail and span.
- The shared TextMate grammar remains compatible with the local VS Code
  extension.
- Browser support follows the docs site's current evergreen-browser target and
  WebAssembly support. OPFS and cross-origin isolation are not required.

## Verification

### Typegen

- A valid single-file program compiles through the browser entry point.
- Multiple local predicates and query declarations compile deterministically.
- Imports produce the precise playground restriction diagnostic.
- Every shipped example produces the expected backend, statement count, SQL,
  inputs, binds, dependencies, coverage, and identity.
- Invalid syntax, semantics, schema references, sort profiles, limits, and
  coverage claims retain their stable compiler codes and source spans.
- Unknown tables, aliases, columns, and ambiguous columns outrank downstream
  bind inference and produce actionable schema-aware details.
- Formatting is semantic-preserving and idempotent through the browser entry.
- A browser bundle test proves that the subpath reaches no Node/Bun module.

### SQLite WASM adapter

- Unknown tables and columns fail during prepare.
- Result column names, declared types, and parameter counts match the Bun
  `QueryDb` adapter for the example corpus.
- Named, positional, range, activation, sort, limit, and FTS-related prepare
  cases finalize their statements and do not leak handles.
- Replacing a schema closes the previous in-memory database.

### Editor and highlighting

- The browser registration uses the repository SYQL grammar and embedded SQL.
- Nested `when` blocks do not swallow highlighting of later sort or limit
  clauses.
- Compiler diagnostics map to the correct Monaco line and column.
- Completion tests cover top-level declarations, tables, aliases, columns,
  input binds, group members, snippets, and trivia masking.
- Old markers clear after a successful edit.
- Format is one undoable model edit and ignores stale formatter responses.

### User interface

- All examples switch, retain independent drafts, and reset independently.
- The default example can be selected through the query string.
- Multiple queries, variants, and sort profiles are selectable.
- The shown statement and bind metadata always belong to the same selection.
- Failed compilation labels the previous output stale.
- Copy copies the visible SQL representation only.
- Desktop and mobile layouts remain usable with keyboard-only navigation.
- Entering and leaving through Astro client navigation disposes and remounts
  all playground resources cleanly.

### Build and deployment

- The ordinary docs build succeeds from a clean checkout without prebuilt
  typegen output.
- The optional subpath build loads every editor, worker, and WASM asset.
- Non-playground pages do not request or preload Monaco, browser Shiki, SQLite
  JavaScript, the compiler worker, or SQLite WASM.
- The Cloudflare static-assets worker requires no new dynamic route or binding.

## Implementation plan

### Phase A — portable compiler boundary

- [x] Add the browser-safe SYQL entry point and package subpath.
- [x] Build the one-file virtual module graph without importing `node:path`.
- [x] Compose parse, semantics, validation, lowering, and formatting.
- [x] Define the serializable playground result and diagnostic DTOs.
- [x] Add the browser dependency-boundary test.
- [x] Add cross-adapter compiler fixtures for every initial example.

Exit criterion: the example corpus compiles against a test `QueryDb` through a
browser-bundleable entry point with no docs UI.

### Phase B — worker and SQLite WASM

- [x] Add the compiler worker and request-ID protocol.
- [x] Implement the ephemeral SQLite WASM `QueryDb` adapter.
- [x] Cache the active schema and release it on replacement/worker termination.
- [x] Exercise compile, format, error, stale-response, and resource lifetime
  through compiler tests and browser smoke coverage.
- [x] Prove ordinary and subpath asset loading.

Exit criterion: a browser worker compiles and formats every example using real
SQLite schema validation.

### Phase C — playground interface

- [x] Add the wide `/playground/` Astro route and navigation entry.
- [x] Register Monaco with the shared SYQL grammar, SQL grammar, language
  configuration, and Syncular theme.
- [x] Implement examples, per-example drafts, Reset, Format, and Copy SQL.
- [x] Implement query, statement, sort-profile, and activation-case selection.
- [x] Render schema, inputs, binds, dependencies, coverage, and identity.
- [x] Map diagnostics to Monaco and the accessible diagnostics strip.
- [x] Add schema-aware Monaco completions for structures, tables, columns,
  aliases, and inputs.
- [x] Implement loading, stale, empty, success, and failure states.
- [x] Implement responsive and keyboard behavior.

Exit criterion: a reader can edit every example and understand the complete
selected physical plan without opening developer tools.

### Phase D — verification and documentation

- [x] Extend the shared grammar/highlighting tests.
- [x] Add desktop and mobile browser smoke coverage.
- [x] Verify Astro client-navigation mount/disposal behavior.
- [x] Record route-only bundle composition and confirm no shared-chunk leak.
- [x] Link the SYQL language guide to the playground and its relevant examples.
- [x] Add the route to sitemap and agent-discovery output where appropriate.
- [x] Verify clean, subpath, and production-shaped static builds.

Exit criterion: tests, accessibility checks, clean builds, and route isolation
are green, and the language guide has a direct path into the playground.

## Rejected alternatives

### A server-side compilation endpoint

This would avoid shipping SQLite WASM but introduces availability, abuse,
rate-limiting, privacy, deployment, and version-skew concerns for a feature
that can run entirely in the browser. It would also make the static docs Worker
stateful for no language requirement.

### A handwritten SYQL-to-SQL demonstration transform

A simplified transform would drift from validation, predicate expansion,
backend selection, naming, bind planning, and future language changes. Showing
plausible but non-executable SQL is worse than showing no transform.

### Reusing only the VS Code extension package

The extension manifest is editor packaging, not a browser editor runtime. The
reusable authorities are its TextMate grammar and language configuration. The
browser should consume those through a supported Monaco/TextMate bridge.

### A textarea with a highlighted overlay

An overlay is smaller, but synchronizing proportional selection, IME input,
scrolling, wrapping, diagnostics, undo, and accessibility is substantial
editor work. Monaco is accepted because it supplies those behaviors and can be
isolated to one route. If measured bundle cost proves unacceptable, a later
implementation may choose another editor only if it still consumes the shared
TextMate grammar and meets the same interaction contract.

### Showing only one “representative” SQL statement

This hides the defining fact that optional conditions and sort profiles may
produce multiple checked statements. The playground must teach the selected
plan honestly and make each physical statement inspectable.

### Inferring a schema from the query

Type, nullability, primary-key identity, scope coverage, and column validity
cannot be inferred honestly from a query alone. Examples therefore carry an
explicit schema fixture.

### Making raw IR editable in revision 1

IR is a generated internal contract, not the primary authoring experience.
Exposing it first would teach the wrong workflow. An editable migration and
manifest environment can be designed separately after the query playground is
useful.

### Running the full LSP in the page

The LSP would add project files, document lifecycle, imports, navigation, and
transport complexity beyond the core edit/compile goal. Revision 1 maps direct
compiler diagnostics and uses the formatter without advertising IDE parity.

## Acceptance criteria

This implementation adopts the following product decisions:

1. the playground is a route in the existing docs app rather than a separate
   application;
2. Monaco plus Shiki is an acceptable route-local dependency;
3. compilation happens locally in a worker with ephemeral SQLite WASM;
4. examples own read-only schema IR fixtures;
5. the right pane represents every statement in the selected physical plan;
6. revision 1 supports one virtual source file and local predicates but not
   imports; and
7. revision 1 compiles but does not execute queries against sample rows.

The implementation satisfies these criteria: phases A through D are checked,
every shipped example is covered by compiler and browser tests, normal docs
routes remain free of playground assets, and both root and subpath static
builds load the editor worker and SQLite WASM successfully.
