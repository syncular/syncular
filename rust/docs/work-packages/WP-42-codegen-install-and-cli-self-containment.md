# WP-42 Codegen Install And CLI Self Containment

Status: `[x]` accepted

## Goal

Close the last blank-app codegen setup gap by making the npm `syncular` CLI do
more of the orchestration itself: keep the TypeScript app handoff behind the
single `syncular generate` command, provide a documented installer for the Rust
`syncular-codegen` binary, and let `syncular generate` find or prepare the
matching generator when practical.

## Scope

- Keep app-contract handoff generation behind `syncular generate` while
  preserving the `@syncular/typegen` subprocess needed to load TypeScript app
  modules.
- Add `syncular codegen install` for a Cargo-backed generator install path.
- Resolve `syncular-codegen` from explicit env, repo-local development source,
  cached installs, or `PATH`.
- Allow `syncular generate` to auto-install the matching `syncular-codegen`
  crate when the binary is absent and Cargo is available.
- Update fresh/post-publish smokes and docs to exercise the app-facing path.

## Non-Goals

- Do not add protocol/runtime compatibility branches.
- Do not create platform-specific npm binary packages in this slice.
- Do not change generated app semantics or server/client protocol behavior.

## Evidence

- Baseline: WP-41 accepted `bun run fresh-app-smokes`, focused CLI/codegen
  tests, release package-content checks, and `.githooks/pre-push`.
- `bun test packages/syncular/src/cli.test.ts`
- `bunx biome check packages/syncular/src/cli.ts packages/syncular/src/cli.test.ts scripts/fresh-app-smokes.ts scripts/post-publish-install-smokes.ts`
- `bun --cwd packages/syncular tsgo`
- `bun --cwd packages/syncular build:cli`
- `node packages/syncular/dist/cli.js codegen install --help`
- `bun run docs:stale-check`
- `bun run fresh-app-smokes`
- `bun test packages/client/src/__tests__/variant-core.wasm.test.ts`
- `.githooks/pre-push`

## Decision

Accepted. `syncular generate` now resolves the Rust generator from an explicit
binary, repo-local source when developing Syncular itself, the Syncular tool
cache, `PATH`, or Cargo auto-install. `syncular codegen install` provides the
documented prewarm path, and fresh/post-publish smokes cover the app-facing
installer/resolver workflow.
