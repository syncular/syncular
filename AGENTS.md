# Syncular agent instructions

Local-first sync engine: local SQLite is the read model, writes go through an
outbox, servers converge clients. One TS core and one Rust core implement the
same wire protocol, **conformance-locked** against each other. Docs site:
syncular.dev (built from `apps/docs`, tracks main).

This file is the canonical instruction set for coding agents and applies to
human contributors just as much. `CLAUDE.md` is a gitignored symlink to this
file, created by the root `postinstall` script.

Read before non-trivial work: `docs/SPEC.md` (wire truth), `docs/SYQL.md`
(query-language truth), the relevant package README, and `docs/RELEASE.md`
when changing release behavior. Do not revive removed mechanisms or add a
parallel path without current evidence and a specification change.

## Doctrine (enforced)

- **Spec-first**: wire-behavior changes start in SPEC.md; judgment calls get
  codified back into it.
- **No fallback paths.** Loud, precise errors over silent degradation.
- **No timers in tests.** Deterministic flush/readiness helpers only
  (`flushQuerySchedulers`, chained microtasks); a wall-clock sleep is a bug.
- **Cross-core parity**: behavior observable on the wire or through the
  client surface must match TS and Rust. Semantics changes (e.g. window
  completeness, invalidation granularity) require BOTH cores plus a
  conformance catalog scenario (`packages/conformance/src/catalog/`); a
  TS-only change breaks the rust-conformance CI pairing.
- Commit/push: local commits after verification are fine; **push only on
  the maintainer's explicit instruction**.

## Coding rules

- **No unnecessary code artifacts.** Direct code only: no named helpers,
  wrappers, constants, or files for single-use logic. Inline it unless it is
  reused, explicitly requested, or shared between production code and tests.
- **Less is more.** Rewrite an existing component before adding a parallel
  one. Prefer editing existing files over creating new ones.
- **Bugfix restraint.** For bug fixes, first check whether existing code can
  be simplified, reduced, or localized; add new arguments, plumbing, or
  abstractions only when the root cause shows they are necessary. Tests can
  grow freely.
- **Scan for repeats.** After finding a bug, `rg` for the same pattern
  elsewhere in the repo before fixing a single instance.
- **Clean codebase.** Flag obsolete files for removal.
- **Stable error identities.** Errors carry static codes
  (`sync.outbox_incompatible` style); dynamic values (ids, cursors, raw rows)
  belong in structured error details, never interpolated into the message.
- **No `as any` / `as unknown`.** When something fails to typecheck, fix the
  underlying type.
- **Testable change → test.** Add or extend a `bun:test` file next to the
  change. No `mock.module`; use dependency injection or scoped test doubles.
- **English everywhere**: code, comments, commit messages, docs.
- **Commits are human.** No AI attributions, `Co-Authored-By` trailers, or
  tool names in commit messages.
- **Leave others' work alone.** Never run destructive git commands
  (`revert`, `reset --hard`, forced checkouts) over changes you did not make.
- **No unrequested publishing.** Deploy, release, and publish scripts run only
  on explicit instruction, like pushes.

## Prose rules for docs

Reader-facing text gets the same review as code. These patterns are
generated-prose tells; delete them on sight:

- **No em-dashes.** Use a colon, semicolon, comma, parentheses, or a
  sentence split. List items are "`thing`: description".
- **No rhetorical antithesis.** "X, not Y" and "not X, but Y" become a plain
  statement of the positive fact.
- **No punchlines or aphorisms.** A sentence that restates the previous one
  as a slogan ("That is the whole point", "This is the spine of the system")
  gets deleted.
- **No empty framing.** "The key insight", "It's worth noting", "Crucially",
  "Simply put", and any sentence whose only job is to announce that the next
  one matters.
- **No marketing adjectives.** robust, elegant, seamless, powerful,
  battle-tested, blazing, production-scale. State the measurable property
  instead.
- **No rhetorical questions** answered by the next sentence.

## Layout

- `packages/*` (TS): `core`, `crypto`, `server`, `server-hono`,
  `server-workers`, `web-client` (npm: `@syncular/client`), `react`,
  `typegen` (bin: `syncular`), `tauri` (JS bridge), `crdt-yjs`, `testing`
  (npm: `@syncular/testkit`), `create-app`, `conformance` (private).
- `rust/` is its own cargo workspace: `ssp2`, `client`, `command`, `ffi`
  (C-ABI `libsyncular`), `syncular` (stub crate).
- `bindings/`: `tauri/` (plugin + example; **separate cargo workspace**,
  deliberately outside the main cargo gate), `kotlin/` (Gradle, FFM/JDK21+),
  `flutter/`, `react-native/` (bun workspace member), `swift/` (local-only
  gate, needs macOS). Each has its own `check.sh`.
- `apps/docs`, `apps/demo*`, `examples/quickstart`, `bench/`, `load/`.

## Dev loop

```sh
bun install
bun run check        # typecheck + oxlint/oxfmt + knip + tests. THE gate (pre-push hook runs it)
```

- Tests are split: `test:main` plus an isolated multi-tab lane (documented
  bun worker+sqlite segfault, see the root package.json note; retry once is
  expected, do not "fix" it).
- Rust: `cargo test` / `clippy -D warnings` in `rust/`; the tauri plugin
  builds in `bindings/tauri/` separately.
- Lint/format: oxlint (`.oxlintrc.json`) + oxfmt (`.oxfmtrc.json`); knip
  guards unused files/deps/exports (`knip.json`). `bun run lint:fix` before
  committing; generated files (`*.generated.ts`, `*.queries.ts`) are excluded
  from all three.
- React package tests: bun:test + RTL over happy-dom (`--preload
  ./test/setup.ts`), `FakeClient` for hook semantics, `loopback.ts` +
  `handle-shape.ts` for the promise-path parity lane. Typegen has golden
  tests (`test/fixtures/`; the `basic` fixture covers all six column types).

### The repo is dist-free (this bites)

`packages/*/dist` is gitignored and only exists after `bun run
build:packages`. Published exports point `browser`/`import` at `dist/`, but
the **`bun` condition points at `src/*.ts`**, so everything in-repo resolves
through it. Consequences:

- Any tsconfig typechecking against `@syncular/*` inside the repo needs
  `"customConditions": ["bun"]` (see `bindings/react-native/tsconfig.json`).
- Bun.build sites pin `conditions: ['bun']`.
- When hot-patching an installed copy in a CONSUMER app: Vite serves whatever
  the `browser` condition points at, so patch that file, and never delete
  `node_modules/.vite` under a running dev server (it serves a mixed bundle;
  restart instead).

## CI (`.github/workflows/ci.yml`)

Jobs are **path-gated**: binding gates (tauri, swift-kotlin+RN, flutter) only
do real work when `bindings/` or the FFI core (`rust/`) changed. So touching
the Rust core arms all of them, and latent failures surface on YOUR commit.
Known environmental requirements already encoded (don't regress them):

- kotlin: `junit-platform-launcher` as `testRuntimeOnly` (wrapper-less
  setup-gradle provisions Gradle 9, which stopped injecting it).
- tauri: `example/dist` must exist before anything compiles the example,
  because `tauri::generate_context!` hard-fails on a missing `frontendDist`.
- flutter: `dart analyze` is fatal on ANALYZER diagnostics too
  (`unused_element` etc. are not covered by the generated-file `type=lint`
  ignore; the dart emitter emits row helpers conditionally for this reason).

## Releases

Trusted publishing, no local tokens: **bump every version in lockstep**
(14 `packages/*/package.json` + 5 `rust/crates/*/Cargo.toml` + the plugin,
including the path-dep `version =` constraints), refresh lockfiles
(`bun install`, `cargo check` in `rust/` AND `bindings/tauri/`), `bun run
check`, commit, tag `v<version>`, push the tag → `release.yml` publishes npm
(OIDC + provenance) and crates.io (dependency order: ssp2 → client → command
→ ffi → syncular → tauri-plugin-syncular). Both publish jobs **skip
already-published versions**, so a partial-failure re-run (or a validation
`workflow_dispatch`) publishes exactly what's missing. The crates job
installs Tauri's GTK/WebKit apt deps for the plugin's verify build. Runbook:
`docs/RELEASE.md`. The docs banner reads the released version off
`packages/core` at build time.

## Contributions

External PRs are held to the same doctrine as maintainer work. AI assistance
is welcome for tests, reproductions, benchmarks, docs, and production code.
Review, understand, and iterate on everything you submit; you must be able
to defend every line. Production code gets the strictest review. Low-effort
machine-generated PRs, issues, and comments are closed without comment. The reader-facing version of this policy lives in
`README.md`, `apps/docs/src/content/contributing.md`, and
`apps/docs/src/content/llms.md`; keep them in agreement.

## Consumer-side reference (maintainer-local)

A real two-engine integration (web worker+OPFS and Tauri native behind one
`SyncClientLike` seam) lives in the Diego monorepo at `../mono/ui-poc`; it
is the fastest place to smoke-test a change against a living app
(`bun run server` + `bun run dev` there; see its README). The
path only exists on maintainer machines; skip this section if it is absent.
