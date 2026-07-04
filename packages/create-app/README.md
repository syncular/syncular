# @syncular-v2/create-app

The `create-syncular-v2` scaffolder — the create-app experience for syncular v2.

```sh
bun create syncular-v2 my-app            # prompts for the template
bunx create-syncular-v2 my-app --template web
```

> Naming (`@syncular-v2/*`, bin `create-syncular-v2`, CLI `syncular-v2`) is not
> final — package identity is TODO 6.3. Every user-visible name lives in
> [`src/constants.ts`](./src/constants.ts) so a rename is mechanical: edit the
> constants, regenerate the templates' generated files, done.

## Templates

| Template | Shape |
|---|---|
| `minimal` | Server + a terminal two-client convergence demo (no browser) — migrations + manifest + `generate` wiring. Copy-evolved from `examples/quickstart`. The smallest honest starting point. |
| `web` | Hono server + WebSocket realtime + a single-pane browser todo app whose whole client core runs in a Web Worker on OPFS. Derived from `apps/demo`, slimmed to one pane (no conflict simulator, no blob attachments) — the minimal browser app a real user starts from. |

> **Third-template candidate: `react`.** [`apps/demo-react`](../../apps/demo-react)
> is the ready-made source for a hooks-based template — `@syncular-v2/react`
> (`SyncProvider` + `useTypedQuery` + `useMutation` + `useSyncStatus` +
> `useWindow`) over the same worker + OPFS core, with the Kysely-typed read
> layer wired. Slim it the way `web` slims `apps/demo` (drop the three-list
> seed to one, keep one hook of each kind) and add it here when a React
> template is wanted. Not built yet — noted so the shape is on record.

Each template ships its own `README.md` (run steps, what to edit first),
`.gitignore` (as `gitignore` — see below), a working `tsconfig.json`, and a
smoke test.

## The local-vs-published dependency mechanism

Template `package.json` files use `workspace:*` ranges for every
`@syncular-v2/*` dependency. At scaffold time the scaffolder rewrites those
ranges:

- **`--local`** (or the in-tree test path): keep `workspace:*` verbatim. These
  are the only ranges that resolve when the scaffolded app sits inside this
  repo's workspace.
- **default** (a normal `bunx create-…` run): rewrite to
  `PUBLISHED_DEPENDENCY_RANGE` (`src/constants.ts`). **Today that constant is
  *also* `workspace:*`** because the v2 packages are unpublished and
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
3. runs `syncular-v2 generate --check` — proving the committed
   `syncular.generated.ts` is byte-fresh,
4. links a `node_modules` into the temp dir **offline** (see
   [`test/link-workspace.ts`](./test/link-workspace.ts): `@syncular-v2/*` →
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
