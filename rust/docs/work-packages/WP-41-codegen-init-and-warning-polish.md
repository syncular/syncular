# WP-41 Codegen Init And Warning Polish

Status: `[x]` accepted

## Goal

Reduce the remaining blank-app friction from WP-40 by giving Rust-only apps a
one-command starter path for `generated/syncular.codegen.json`, keeping the
unified `syncular generate` wrapper useful when that config is absent, and
removing generated Rust warning noise for simple schemas.

## Scope

- Add `syncular-codegen init` and `syncular-codegen init --check`.
- Infer starter synced-table config from migrations for tables with one primary
  key and a `server_version`/`serverVersion` column.
- Mark other app tables as local-only in the generated starter config.
- Teach the `syncular generate` wrapper to initialize missing Rust-only config
  before generation.
- Switch fresh-app and post-publish Rust smokes to exercise the init command.
- Suppress unused-helper/import warning noise in generated Rust facades.

## Non-Goals

- Do not add legacy protocol aliases, compatibility branches, or fallback
  runtime behavior.
- Do not infer advanced blob, CRDT, encryption, soft-delete, or historical
  schema metadata; those remain explicit app config.
- Do not solve npm distribution of the Rust `syncular-codegen` binary in this
  slice.

## Evidence

- Baseline: WP-40 accepted `bun run fresh-app-smokes`,
  `bun run release:cargo:package-check`, `bun run docs:stale-check`, and the
  focused codegen/package gates.
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
- `bun test packages/syncular/src/cli.test.ts`
- `bunx biome check packages/syncular/src/cli.ts packages/syncular/src/cli.test.ts scripts/fresh-app-smokes.ts scripts/post-publish-install-smokes.ts`
- `bun run fresh-app-smokes`
- `bun run docs:stale-check`
- `bun run rust:fmt`
- `bun run release:cargo:package-check`
- `.githooks/pre-push`

## Decision

Accepted. Rust-only blank apps can initialize a starter codegen config from
migrations, `syncular generate` can initialize missing Rust-only config before
generation, fresh/post-publish smokes exercise the path, and the blank Rust
app smoke now compiles without generated-code warning noise.
