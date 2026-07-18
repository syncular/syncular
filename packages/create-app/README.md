# create-syncular-app

The `create-syncular-app` scaffolder — the create-app experience for syncular.

```sh
bun create syncular-app my-app            # prompts for the template
bunx create-syncular-app my-app --template web
```

> Naming (`@syncular/*`, bin `create-syncular-app`, CLI `syncular`) is not
> final — package identity is TODO 6.3. Every user-visible name lives in
> [`src/constants.ts`](./src/constants.ts) so a rename is mechanical: edit the
> constants, regenerate the templates' generated files, done.

## Templates

| Template | Shape |
|---|---|
| `minimal` | Server + a terminal two-client convergence demo (no browser) — migrations + manifest + `generate` wiring. Copy-evolved from `examples/quickstart`. The smallest honest starting point. |
| `web` | Hono server + WebSocket realtime + a single-pane browser todo app whose whole client core runs in a Web Worker on OPFS. Derived from `apps/demo`, slimmed to one pane (no conflict simulator, no blob attachments) — the minimal browser app a real user starts from. |
| `tauri` | One React codebase, web + desktop (RFC 0002 §4.1): the `web` template's server plus a shared React tree behind the `__TAURI_INTERNALS__` engine seam (`src/frontend/engine.ts`) — worker core on OPFS in the browser, native Rust core in a `src-tauri/` host (`tauri-plugin-syncular` from crates.io, `native-transport`). Derived from `bindings/tauri/example` + the [web+desktop guide](../../apps/docs/src/content/guide-web-desktop.md). |

> **Next-template candidate: `react` (web-only).** [`apps/demo-react`](../../apps/demo-react)
> is the ready-made source for a hooks-based web-only template — the `tauri`
> template already carries the hook surface for the two-host story. Slim
> demo-react the way `web` slims `apps/demo` when a web-only React template
> is wanted. Not built yet — noted so the shape is on record.

Each template ships its own `README.md` (run steps, what to edit first),
`.gitignore` (as `gitignore` — see below), a working `tsconfig.json`, and a
smoke test.

## The local-vs-published dependency mechanism

Template `package.json` files use `workspace:*` ranges for every
`@syncular/*` dependency. At scaffold time the scaffolder rewrites those
ranges:

- **`--local`** (or the in-tree test path): keep `workspace:*` verbatim. These
  are the only ranges that resolve when the scaffolded app sits inside this
  repo's workspace.
- **default** (a normal `bunx create-…` run): rewrite to
  `PUBLISHED_DEPENDENCY_RANGE` (`src/constants.ts`). **Today that constant is
  *also* `workspace:*`** because the workspace packages are unpublished and
  version-less (all `private`, no `version` — TODO 6.3), so there is no honest
  semver range yet. The CLI **warns loudly** in this case: a `bun install`
  outside the repo cannot resolve the deps until publishing lands. When the
  packages ship, flip that one constant to `^<version>` (or teach the CLI to
  read the published version) — a single edit.

`.gitignore` ships as `gitignore` (no dot) because npm strips real dotfiles
from published tarballs; the scaffolder renames it on copy.

Placeholder substitution is deliberately dumb and greppable: the only token is
`__PROJECT_NAME__` (in each template's `package.json` and `README.md`),
replaced with the derived package name.

## How the templates are tested (and how the tier splits)

`test/scaffold.test.ts` exercises the TEMPLATES THEMSELVES, not just the
scaffolder logic. For each template it:

1. scaffolds into a temp dir (`--local`),
2. asserts the tree shape + placeholder substitution + package.json rewrite,
3. runs `syncular generate --check` — proving immutable migration history and
   the committed `syncular.generated.ts` are byte-fresh,
4. links a `node_modules` into the temp dir **offline** (see
   [`test/link-workspace.ts`](./test/link-workspace.ts): `@syncular/*` →
   the real package dirs, external deps → the workspace `.bun` hoist store),
   typechecks the template's own files, and runs the app's own `bun test`
   smoke.

Steps 1–4 are the **always-run tier** — offline and fast (~1.5s total), so
they ride the normal `bun run check`. A **full-fidelity tier** behind
`SYNCULAR_TEMPLATE_INSTALL=1` additionally does a real `bun install` per
template before running the smoke; it is opt-in because it needs the network.

The in-tree template `*.test.ts` files are excluded from the root `bun test`
sweep (`--path-ignore-patterns '**/create-app/template/**'` in the root `test`
script) — they can only resolve their deps inside a scaffolded, linked copy,
which the tier test above provides.

The `tauri` template's desktop half (`src-tauri/`) is deliberately outside
both tiers: compiling it needs the Rust toolchain, the Tauri system
libraries, and the crates.io registry. Its compile proof is a local
`cargo check` in a scaffolded app (documented in the template README) plus
the tauri-bindings CI job, which builds the same plugin wiring from the
in-tree path dep — the honest scoping the tauri/RN binding gates already
use. The webview side (engine seam, React tree, `build-frontend.ts`) rides
the always-run tier like any other template file.
