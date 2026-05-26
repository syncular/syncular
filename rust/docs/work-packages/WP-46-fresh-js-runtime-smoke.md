# WP-46 Fresh JS Runtime Smoke

Status: `[x]` accepted

## Goal

Make the local fresh JavaScript app smoke prove the blank-app runtime path, not
only code generation.

## Scope

- Link the local workspace packages and runtime dependencies into the temporary
  fresh JS app fixture.
- Generate the JS app through `syncular generate` and `syncular generate
  --check`.
- Open the generated browser database with the Rust-owned SQLite core runtime
  in local-sync-compatible mode.
- Insert through generated mutations and query through Kysely.
- Keep `@syncular/react` in the fresh-app proof by importing its generated
  provider/hooks factory.

## Non-Goals

- Do not add runtime fallback behavior, protocol compatibility, or server sync
  behavior.
- Do not change generated app API names in this slice.
- Do not replace post-publish install smokes.

## Evidence

- Baseline: `bun scripts/fresh-app-smokes.ts --skip-rust --keep --work-dir .context/fresh-app-probe`
  passed before this change, but only checked generated JS files.
- Probe: the generated fresh JS app opened a local Rust-owned SQLite core
  runtime, inserted a task through generated mutations, queried it through
  Kysely, and imported `@syncular/react` helpers.
- `bun scripts/fresh-app-smokes.ts --skip-rust --work-dir .context/fresh-js-runtime-smoke`
- `bunx biome check scripts/fresh-app-smokes.ts rust/docs/ROADMAP.md rust/docs/work-packages/README.md rust/docs/work-packages/WP-46-fresh-js-runtime-smoke.md`
- `bunx tsgo --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --types bun --skipLibCheck scripts/fresh-app-smokes.ts`
- `bun run fresh-app-smokes`
- `bun run docs:stale-check`
- `.githooks/pre-push`

## Decision

Accepted. The local fresh JavaScript fixture now proves the blank-app runtime
path by opening the generated browser client, inserting through generated
mutations, querying through Kysely, and importing React helpers before the Rust
fresh-app smoke runs.
