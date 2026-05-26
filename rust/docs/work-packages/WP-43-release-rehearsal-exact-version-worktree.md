# WP-43 Release Rehearsal Exact Version Worktree

Status: `[x]` accepted

## Goal

Make local release rehearsal prove the same stamped package metadata that the
real release workflow publishes. `release:rehearsal --version <version>` should
not only dry-run the stamping scripts; npm and Cargo publish dry-runs must read
manifests stamped to that exact version.

## Scope

- Keep the fast dirty-worktree iteration path for docs and fresh-app checks.
- Run full publish dry-runs from a temporary detached git worktree at `HEAD`.
- Stamp npm and Cargo package metadata in that temporary worktree before
  invoking npm/Cargo publish dry-runs.
- Remove the temporary worktree by default, with an explicit option to keep it
  for debugging.

## Non-Goals

- Do not publish packages or crates.
- Do not change GitHub release workflow semantics.
- Do not add compatibility branches or legacy release paths.

## Evidence

- Baseline: WP-42 accepted `syncular generate` installer/resolver changes and
  `.githooks/pre-push`.
- `bun scripts/release-rehearsal.ts --help`
- `bun scripts/release-rehearsal.ts --version 0.1.0-staging.local --allow-dirty --skip-publish-dry-runs --skip-fresh-app-smokes`
- `bun scripts/stamp-versions.ts --version 0.1.0-staging.local --dry-run | rg '@syncular/client-javascript-bindings|runtime contract|@syncular/client →'`
- `bunx biome check scripts/release-rehearsal.ts`
- `bunx tsgo --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --types bun --skipLibCheck scripts/stamp-versions.ts scripts/release-rehearsal.ts`
- `bun run docs:stale-check`
- `bun run release:rehearsal -- --version 0.1.0-staging.local --skip-fresh-app-smokes --skip-docs-stale-check`

## Decision

Accepted. Full release rehearsal now creates a clean detached worktree for the
current `HEAD`, installs dependencies, stamps the requested exact version, and
runs npm/Cargo publish dry-runs from that stamped checkout. The npm stamper now
recognizes all public workspace packages with release scripts, including the
JavaScript/WASM bindings package that invokes the shared publish helper by path,
and stamps the JavaScript runtime contract package metadata alongside package
manifests.
Dirty local iteration remains available only when publish dry-runs are skipped,
so the script cannot accidentally claim a full release rehearsal against
unstamped or uncommitted metadata.
