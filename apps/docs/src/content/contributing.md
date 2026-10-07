# Contributing

This page is for developers who send Syncular a bug report, a protocol
question, or a pull request. It lists the steps from a change to a merged pull
request, the Rust cache policy that the build scripts apply, and the authoring
reference for the docs site. Syncular is developed on
[GitHub](https://github.com/syncular/syncular).

::meta{for="Contributors and docs authors" time="10 minutes"}

:::terms
- **The gate**: `bun run check`: typecheck, lint and format, unused-code check, and tests. The pre-push hook and CI run it.
- **Catalog scenario**: A conformance scenario in `packages/conformance/src/catalog/` that both cores must pass.
- **Directive**: A `:::name` block or `::name` line in docs markdown that the build turns into a component.
:::

::::steps
:::step{title="Read the working agreement" time="5 min"}
Read [`AGENTS.md`](https://github.com/syncular/syncular/blob/main/AGENTS.md).
It is the working agreement for maintainers, human contributors, and coding
agents, and it holds the coding rules and the prose rules for docs.

::checkpoint[You know where the repository states its doctrine: spec-first, no fallback paths, no timers in tests, and cross-core parity.]
:::

:::step{title="Specify wire changes first" time="varies"}
Start a wire-behavior change in
[`docs/SPEC.md`](https://github.com/syncular/syncular/blob/main/docs/SPEC.md).
A semantics change needs both cores and a conformance catalog scenario; a
change in one core alone fails the `rust-conformance` CI pairing (see
[Protocol & conformance](/reference/#protocol--conformance)).

::checkpoint[The specification names the behavior before the code does.]
:::

:::step{title="Change the code, its tests, and its docs" time="varies"}
Keep the contribution focused. Add or extend a `bun:test` file next to the
change. A change that alters what users see or do updates the page in
`apps/docs/src/content/`, and feature-level work adds an entry to
`apps/docs/src/changelog.mjs`, newest first, linking to the docs page that
covers it. Review every changed line and be prepared to explain the choices in it.

::checkpoint[Every behavior change has a test and a docs update in the same diff.]
:::

:::step{title="Run the gate" time="varies"}
```sh title="terminal"
bun run check
```

::checkpoint[The command exits with code 0. The multi-tab test lane can segfault in a Bun worker with SQLite; rerun once, which the repository expects.]
:::

:::step{title="Open the pull request"}
Describe the change and its reason. If a model drafted or rewrote anything
still in the pull request, say so in the description (see
[LLM assistance](#llm-assistance)).

::checkpoint[CI runs the gate and any path-gated binding jobs for the files you changed.]
:::
::::

## Local Rust build caches

Run `bun run rust test` or `bun run rust clippy --all-targets -- -D warnings`
for the Rust core. These commands prune caches before invoking Cargo.
`bun run check:code`, native packaging, FFI smoke tests and the binding check
scripts also run cleanup. Direct `cargo` commands do not run this hook.

Cleanup requires Python 3 on macOS/Linux. It removes hashed Cargo
intermediates and incremental caches unused for 14 days. Above 8 GiB per
target folder, it removes older entries unused for at least 24 hours first.
It retains fresh artifacts, final binaries and exported native packages.
A Cargo profile lock held by another build skips cleanup for that target
folder. Windows builds retain their caches without automatic pruning.

Preview with `bun run rust:clean --dry-run`. Set `RUST_CACHE_MAX_GIB`,
`RUST_CACHE_MAX_AGE_DAYS` or `RUST_CACHE_MIN_AGE_HOURS` to change the policy.
A custom `CARGO_TARGET_DIR` must be absolute. The size limit is a pruning
target: recent and final outputs can exceed it until they become eligible.

## Docs authoring

Docs pages are plain markdown in `apps/docs/src/content/`, one file per page,
with no frontmatter. `src/nav.ts` sets each page's type (concept, how-to, or
reference), its sidebar position, and the advanced badge. Content components
are `:::` directives and two fenced-block languages, handled at build time by
`src/markdown-components.ts`. An unknown directive or a malformed component
fails the build with a `docs.*` error code.

Directives nest by fence length: the outer fence takes more colons than any
fence inside it. A `::::steps` block holding a step with a callout inside is
`:::::steps`, `::::step`, `:::rule`.

### Page structure

Each page has exactly one type, set in `nav.ts`: a concept page explains a
model, a how-to page walks one procedure in a `steps` block, and a reference
page lists exact facts. The opening paragraph says who the page is for and what
the reader gets, then the meta strip and the terms list follow. A page defines
each term at first use or links to the page that does. Advanced material goes in
a clearly marked final section, or the page carries the advanced flag. The page
ends when its content ends: no summary and no hand-written "Where to go next"
list, because the previous and next links come from the order in `nav.ts`.

Moving or deleting a page needs a `redirects` entry in `nav.ts` for the old
slug. `apps/docs/test/internal-links.test.ts` fails on a link to a missing page
or heading, and the prose rules in `AGENTS.md` apply to docs as they apply to
code.

### Page meta strip

Place it after the lede paragraph. Every field is optional. `first` takes one
or more page slugs from `nav.ts`, separated by spaces; `spec` takes one or more
SPEC.md section numbers (`4`, `5.3`) and links them. An unknown field, page, or
section fails the build with `docs.meta_unknown_field`, `docs.meta_unknown_page`,
or `docs.meta_unknown_spec_section`.

```md
::meta{for="App developers on any SDK" time="8 minutes" first="quickstart" spec="4 7"}
```

SDK overview pages add the facts row: `runs`, `package`, and `threading`. Text
fields render `` `code` `` spans. The strip shows fields in a fixed order:
for, runs, package, threading, time, read first, spec.

```md
::meta{for="Web app developers" runs="TypeScript core in a Web Worker" package="`@syncular/client`" threading="Core in the worker" time="4 minutes"}
```

### Callouts

Four types: `note` (context), `tip` (a useful consequence), `rule` (an
invariant the reader must keep), `warning` (a way to lose data or fail).
`title` replaces the default label.

````md
:::warning{title="Use a file path"}
An in-memory database loses the outbox on restart.
:::
````

### Steps

How-to pages put their procedure in one `steps` block. Each step needs a
`title`, which also becomes an `h3` in the contents rail; `time` is optional.
End a step with a `checkpoint` that says what the reader sees when it worked.

````md
::::steps
:::step{title="Start the server" time="1 min"}
```sh title="terminal 1"
bun run server
```

::checkpoint[The terminal prints the server URL.]
:::
::::
````

### Figures

A figure frames hand-authored HTML, or a plain fenced block for ASCII
diagrams, and requires a `title`. Figures number themselves in page order and
take at most one caption. `note` adds a right-aligned
label; `ticks` adds the amber corner marks (use it for the page's lead figure).
`::caption[…]` goes last and takes inline markdown.

````md
:::figure{title="What one write does" note="One transaction" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Your app</span>mutate(…)</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Next round</span>Pushed in order</div>
</div>

::caption[Queries see the row at once; the next round sends it.]
:::
````

The diagram vocabulary, all styled in `src/docs.css`:

| Class | Draws |
|---|---|
| `node` | A box; add `t` on a first `span` for its small uppercase label. Variants: `hot` (amber), `ok` (green), `cool` (cyan), `bad` (red). |
| `d-row` + `d-arrow` | Boxes left to right with arrows; stacks with downward arrows on phones. |
| `d-cols-2`, `d-cols-3` | Side-by-side columns; `d-cols-3` stacks on phones. |
| `d-stack` | Boxes top to bottom. |
| `d-box`, `d-label` | A grouping frame and its uppercase heading. |
| `d-down` (`ok`, `up`) | A dashed vertical connector with a label and a `<small>` note. |
| `chip` (`amber`, `ok`, `bad`, `cool`) | A small inline tag, such as a commit or an outcome. |

Keep figure text short and in the same voice as the page. A figure needs a
caption only when the diagram alone leaves a question open.

### Code blocks

Every fenced block gets a frame and a copy button. `title="…"` names the file
or terminal. Highlighting is Shiki at build time.

````md
```ts title="src/server.ts"
await ensureSyncServerReady(config);
```
````

### SDK code tabs

Put one sample per SDK in a `tabs` block and mark each with `sdk=<id>`, an id
from `nav.ts` (`web`, `react`, `swift`, `kotlin`, `flutter`, `react-native`,
`tauri`, `rust`). The block opens on the reader's chosen SDK. Without a sample
for it, the block opens on the SDK it shares code with and says so. The order
comes from `sampleFallback` in `nav.ts`: Browser tries React, React tries
Browser, React Native tries React then Browser, and Tauri tries Browser.
Clicking a tab switches that block only. A block that is not per SDK gives each
fence `label="…"` and does not follow the SDK choice. A `tabs` block holds only
fenced code; each fence needs `sdk` or `label`, and ids cannot repeat.

````md
:::tabs
```ts sdk=web title="src/sync.ts"
client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });
```
```swift sdk=swift title="Sync.swift"
try client.subscribe(id: "todos", table: "todos", scopes: ["list_id": ["groceries"]])
```
:::
````

### Expected output and file trees

An `output` block shows what the reader sees, with the label "Expected output"
unless you give it a `title`.

````md
```output
✓ converged
```

```tree title="my-app/"
syncular.json        # tables, scopes, subscriptions
src/
  server.ts          # the server
```
````

In a `tree` block, indent two spaces per level, end directories with `/`, and
add a note after ` # `.

### Terms on this page

One list of the terms the page defines, each written `- **Term**: definition`;
any other shape fails with `docs.terms_not_a_list` or `docs.terms_item_shape`.
Place it after the meta strip. On wide screens it moves into the right rail;
on phones it is a collapsed block under the lede.

```md
:::terms
- **Cursor**: The last commit a subscription has applied.
- **Outbox**: The local queue of commits waiting to be sent.
:::
```

### Advanced pages and sections

Mark a page `advanced: true` in `nav.ts`, or a whole group. The sidebar shows
an ADV badge and the page header an "Advanced" label; the markdown stays
unchanged.

Mark a section inside a page by starting its heading with `Advanced:`. The
heading renders with an ADV badge, and its anchor keeps the plain slug
(`#advanced-wire-the-realtime-hub`). Put advanced sections last on the page.

```md
## Advanced: wire the realtime hub
```

### Page scripts

Every page runs under the Astro client router: `PageMeta` mounts it, so a
link between any two pages swaps the body in one frame without a reload and
`ClientRouter` evaluates a bundled `<script>` once per full load. A script
that needs a fresh start on each page view wraps its setup in `pageScript`
from `src/page-lifecycle.ts`. `pageScript` runs the setup after every page
load and runs the teardown the setup returns before the next swap, so
animation frames, timers, observers, and `window` listeners stop with the
page that started them. Register document-level listeners once at module
level. Give an `is:inline` script `data-astro-rerun` and wrap it in a
function, because the router re-runs it on every swap.

Add `data-astro-reload` to a same-origin link whose target is not an HTML
page (`.md`, `.txt`, `.xml`) so the browser loads it directly.

## LLM assistance

Use models for whatever helps: tests, reproductions, benchmarks, tooling, docs,
production code. If a model drafted or rewrote something that is still in your
pull request, say so in the description. Routine completion and spelling fixes
need no note.

Read your own diff, run `bun run check`, and be ready to explain your changes
and how they fit the protocol. Pull requests, issues, and comments pasted
straight out of a model are closed without comment.

Syncular is built the same way. The [LLMs page](/llms/) lists the machine-readable
docs entry points, and the post
[Why a Second Implementation Is the Best Check on LLM-Written Code](/blog/two-cores-check-llm-code/)
describes the checks that make model-written production code safe to merge.
