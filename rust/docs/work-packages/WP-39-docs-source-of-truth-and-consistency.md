# WP-39 Docs Source Of Truth And Consistency

Status: `[x]` accepted

## Goal

Finish the docs consistency pass after the Rust-first information architecture
rewrite. The docs should have one source of truth for generated API pages,
accurate Rust-first protocol language, parallel JavaScript/Rust getting-started
paths, and clear reference/testing entry points.

## Scope

- Generate OpenAPI docs into the public Reference API tree and remove the
  duplicate hidden `/docs/api/*` tree.
- Remove or qualify stale protocol language in public docs, especially JSON
  snapshot wording and app-facing `upsert` examples.
- Make Start and Installation split JavaScript and Rust setup paths clearly.
- Rework Reference and Testing roots so they act as decision hubs, not thin
  link lists.
- Add native-host visibility without presenting Swift/Kotlin/Java as fully
  documented language clients yet.

## Non-Scope

- Runtime/client API changes.
- Removing the current internal protocol `upsert` representation from code.
- Writing full Swift/Kotlin/Java language guides.
- Changing published package names.

## Required Gates

- `git diff --check`
- Custom internal `/docs` link checker.
- Focused stale docs scans:

```bash
rg -n 'json-row-frame|framed JSON rows|/docs/api/|native-runtime|client-sdk|event-streams|conflicts-live-queries' apps/docs/content/docs -g '*.mdx'
rg -n "\\bupsert\\b|\\bupserts\\b|op:\\s*['\"`]upsert" apps/docs/content/docs -g '*.mdx'
```

The `upsert` scan is a review gate, not a zero-hit gate: remaining hits must be
explicitly scoped to internal server/protocol/native ABI examples, not
app-facing mutation APIs.

- `bun --cwd apps/docs types:check`
- `bun --cwd apps/docs build`
- Local docs HTTP/browser smoke for changed top-level routes.

## Work Batches

### Batch 1: API Source Of Truth

- `[x]` Change OpenAPI generation to write operation pages under
  `content/docs/reference/api`.
- `[x]` Regenerate Reference API pages.
- `[x]` Delete duplicate `content/docs/api`.
- `[x]` Update Reference API navigation for newly generated endpoints.

### Batch 2: Protocol Language Accuracy

- `[x]` Replace stale JSON snapshot wording with binary snapshot/artifact
  wording.
- `[x]` Keep app-facing docs on `insert`, `update`, and `delete`.
- `[x]` Where server internals must mention `upsert`, label it as an internal
  stored row-write operation rather than a recommended app mutation API.

### Batch 3: Start And Installation Paths

- `[x]` Split JavaScript and Rust setup into explicit first-class paths.
- `[x]` Make package/crate/codegen setup parallel enough that Rust does not
  read as an afterthought.

### Batch 4: Reference And Testing Hubs

- `[x]` Rework Reference into a package/crate/server/CLI/API hub.
- `[x]` Rework Testing into a decision matrix across JavaScript testkit, Rust
  testkit, conformance, server-only, and app-specific fixtures.

### Batch 5: Native Host Visibility

- `[x]` Add a concise native-host pointer from Rust Delivery/Runtime docs.
- `[x]` Avoid overclaiming Swift/Kotlin/Java guide completeness.

### Follow-up: Intro And Learn Rust-First Pass

- `[x]` Revisit docs root, Start pages, comparison/evaluation pages, and Learn
  pages for stale JavaScript-first wording.
- `[x]` Replace old client-handler and transport-construction language with
  generated app contract, Rust runtime, and generated client `baseUrl` wording.
- `[x]` Keep bootstrap docs on binary snapshot chunks/scoped artifacts instead
  of inline JSON or generic rows/chunks language.
- `[x]` Reframe Kysely-only claims as host-query-builder claims: Kysely for
  TypeScript, Diesel for Rust, Kysely for server handlers.
- `[x]` Run the same stale-pattern audit across public docs and clean adjacent
  troubleshooting/migration/testing pages that still suggested client handlers,
  old-client compatibility wording, or legacy sample instance names.
- `[x]` Move the public docs site from the redundant `/docs` mount to the
  domain root and rewrite internal links to root-relative routes.

## Accept / Reject Rule

Accept this batch when the docs structure has one generated API tree, the
top-level docs routes render, and stale protocol wording is either removed or
explicitly scoped to internal server/protocol behavior. Rework any docs example
that invents an API not present in the repo.

## Current Evidence

- Review found no broken internal `/docs` links after WP-34/WP-36, and the
  top-level docs routes render in the browser.
- Remaining issues are source-of-truth and accuracy issues:
  - OpenAPI pages are generated into `content/docs/api` while navigation points
    to `content/docs/reference/api`.
  - Some newer endpoints exist only in the duplicate generated tree.
  - Learn docs still describe large snapshots as gzip/framed JSON rows.
  - Several public docs still present `upsert` in app-facing examples instead
    of keeping it scoped to internal server/protocol row-write records.
  - Start/Installation, Reference, and Testing roots are too thin or uneven
    after the Rust-first client split.
- Accepted changes:
  - OpenAPI generation now writes to `content/docs/reference/api`.
  - Duplicate `content/docs/api` was deleted.
  - Reference API navigation now includes snapshot artifacts, audit row/debug
    routes, console row history/investigation, and debug export routes.
  - Stale route/snapshot scan is clean for `/docs/api`,
    `json-row-frame`, framed JSON rows, old Rust route names, and
    `client-sdk`.
  - Remaining `upsert` docs hits are limited to exact internal
    server/protocol/native ABI examples and are marked as internal storage/ABI
    details, not app-facing mutation APIs.
  - Start/Quick Start/Installation now have explicit JavaScript-first and
    Rust-first paths.
  - Reference now uses `Packages And Crates` instead of the old Client SDK
    route.
  - Testing now includes a decision matrix and minimum shipping suite.
  - Rust Delivery now has a `Native Hosts` page that links Swift/Kotlin/JVM,
    React Native, Tauri, and Electron host boundaries without overclaiming
    full language guides.
  - Follow-up intro/learn pass updated the docs root, Start, comparison, and
    Learn pages so they consistently describe the Rust-owned client runtime,
    generated app contract, generated subscriptions/mutations, binary
    snapshot chunks/artifacts, and host-specific query builders.
  - Follow-up public-docs stale-pattern pass also updated Operate
    troubleshooting, Features migrations, Rust testkit stateful-server docs,
    and Operations setup examples so unsupported schema versions fail clearly
    and scoped local clearing is described through the generated app contract
    rather than old client handlers/custom apply hooks.
  - Follow-up gates passed on 2026-05-26:
    - `git diff --check -- apps/docs/content/docs/index.mdx apps/docs/content/docs/start apps/docs/content/docs/learn rust/docs/work-packages/WP-39-docs-source-of-truth-and-consistency.md rust/docs/ROADMAP.md`
    - focused stale docs scans for old client APIs, old protocol wording,
      app-facing `upsert`, client-handler wording, and old transport examples
    - changed-page internal `/docs` link checker: `185` links across `20`
      changed docs files, no missing routes
    - `bun --cwd apps/docs types:check`
    - `bun --cwd apps/docs build` after regenerating the ignored local
      `packages/server-hono/openapi.json` copy used by docs builds
    - local browser smoke on `http://localhost:3210` for `/docs`,
      `/docs/start`, `/docs/start/what-is-syncular`,
      `/docs/start/quick-start`, `/docs/learn`, `/docs/learn/architecture`,
      `/docs/learn/first-sync`, and `/docs/learn/scopes`; no console errors
  - Final public-docs cleanup gates passed on 2026-05-26:
    - `git diff --check -- apps/docs/content/docs rust/docs/work-packages/WP-39-docs-source-of-truth-and-consistency.md`
    - full public-docs stale-pattern scan for old JS/client/protocol wording
      returned no hits; remaining `Client SDKs` wording is only the PowerSync
      product description
    - `upsert` scan reviewed: remaining hits are server/internal
      emitted-change, console/protocol, migration, or native ABI examples
      already labeled as non-app mutation APIs
    - changed-page internal `/docs` link checker: `14` links across `4`
      changed docs files, no missing routes
    - `bun --cwd apps/docs types:check`
    - `bun --cwd apps/docs build`
    - local browser smoke on `http://localhost:3210` for
      `/docs/operate/troubleshooting`, `/docs/features/migrations`,
      `/docs/clients/rust/testing/stateful-server`, and
      `/docs/operate/operations-setup`; no console errors
  - Root docs URL cleanup passed on 2026-05-26:
    - docs app route moved from `/docs/[[...slug]]` to root
      `/[[...slug]]` through a route group; Fumadocs `baseUrl` is now `/`
    - docs content internal links now point at `/start`, `/learn`,
      `/clients`, `/server`, `/features`, `/testing`, `/operate`, and
      `/reference` without a `/docs` prefix
    - raw Markdown and OpenGraph helper routes moved out of their old nested
      docs segments to `/llms.mdx/*` and `/og/*`
    - raw Markdown helper links now use the direct `/llms.mdx/<slug>` route
      because Cloudflare/OpenNext does not reliably strip root `*.mdx` rewrite
      suffixes
    - `bun --cwd apps/docs generate`
    - custom root-relative docs link checker: `730` links across `180` MDX
      files, no missing routes
    - `bun --cwd apps/docs types:check`
    - `bun --cwd apps/docs build`
    - local browser smoke on `http://localhost:3210` for `/`, `/start`,
      `/learn`, `/reference/api`, and `/start/what-is-syncular`; no console
      errors on valid routes
    - local HTTP smoke returned `200` for `/`, `/start`, `/learn`,
      `/reference/api`, `/start/what-is-syncular`, `/llms.mdx/index`,
      `/llms.mdx/start/what-is-syncular`, and
      `/og/start/what-is-syncular/image.png`; `/docs/` resolves to `404`
      after slash normalization
  - Gates passed:
    - `git diff --check`
    - custom internal `/docs` link checker: no broken `/docs` links across
      `179` MDX files
    - `content/docs/api` file count is `0`; `content/docs/reference/api` MDX
      file count is `47`
    - `bun --cwd apps/docs types:check`
    - `bun --cwd apps/docs build`
    - local HTTP smoke returned `200` for changed docs routes and `404` for
      removed `/docs/api/postSync` and `/docs/reference/client-sdk`
    - browser smoke rendered changed top-level routes with no console errors

## Next Action

WP-39 is complete unless further docs inconsistency is reported.
