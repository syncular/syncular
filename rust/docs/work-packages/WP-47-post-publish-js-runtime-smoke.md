# WP-47 Post-Publish JS Runtime Smoke

Status: `[x]` accepted

## Goal

Make the post-publish JavaScript install smoke prove that a fresh external app
can execute the generated browser runtime path from npm-installed packages, not
only install packages and inspect generated files.

## Scope

- Keep installing the published `syncular`, `@syncular/client`,
  `@syncular/react`, `@syncular/typegen`, and `@syncular/testkit` packages from
  the configured npm registry.
- Generate the fresh app with `syncular generate` and `syncular generate
  --check`.
- Run a generated client runtime smoke that opens the Rust-owned SQLite core
  runtime in local-sync-compatible mode.
- Insert through generated mutations and query through Kysely.
- Keep the existing standalone package API smoke for typegen, React helpers,
  runtime URL exports, and the JS testkit request builders.

## Non-Goals

- Do not add protocol compatibility branches, runtime fallbacks, or legacy JS
  client behavior.
- Do not change generated app API names.
- Do not replace the local workspace fresh-app smoke.

## Acceptance Criteria

- The post-publish JS smoke fails if the generated client cannot be imported
  from the published package install.
- The smoke fails if the generated runtime database cannot open with the
  packaged core runtime artifact.
- The smoke fails if generated mutations cannot insert a synced task row or if
  Kysely cannot query the row back.
- Existing install, generate, `--check`, and package API assertions remain.

## Required Gates

- `bunx biome check scripts/post-publish-install-smokes.ts rust/docs/ROADMAP.md rust/docs/work-packages/README.md rust/docs/work-packages/WP-47-post-publish-js-runtime-smoke.md`
- `bunx tsgo --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --types bun --skipLibCheck scripts/post-publish-install-smokes.ts`
- `bun scripts/post-publish-install-smokes.ts --help`
- Published JS smoke against a real registry version, or a stated blocker.
- `bun run docs:stale-check`
- `.githooks/pre-push`

## Evidence

- Baseline: WP-46 accepted the same generated runtime proof for the local
  workspace fresh JS app smoke.
- `bunx biome check scripts/post-publish-install-smokes.ts rust/docs/ROADMAP.md rust/docs/work-packages/README.md rust/docs/work-packages/WP-47-post-publish-js-runtime-smoke.md`
- `bunx tsgo --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --types bun --skipLibCheck scripts/post-publish-install-smokes.ts`
- `bun scripts/post-publish-install-smokes.ts --help`
- `bun scripts/post-publish-install-smokes.ts --version 0.0.6-248 --crate-version 0.1.0 --skip-rust --work-dir .context/post-publish-js-runtime-smoke`
  blocked during npm install because `@syncular/react@0.0.6-248` is not
  published on npm. The current registry versions are `syncular`,
  `@syncular/client`, `@syncular/typegen`, and `@syncular/testkit`
  `0.0.6-248`; `syncular-codegen` is `0.1.0` on crates.io.
- `bun run docs:stale-check`
- `.githooks/pre-push`

## Decision

Accepted. The post-publish JavaScript smoke now includes generated browser
runtime execution: open the packaged Rust-owned SQLite core runtime, insert a
task through generated mutations, query it through Kysely, and keep React helper
imports in the install proof. The real public-registry run is blocked before
that step until the next coordinated npm publish includes `@syncular/react`.
