# WP-38 Release Automation

Status: `[x]` accepted

## Goal

Make Rust crate publishing follow the same release rhythm and version syntax as
the npm packages without publishing public crates from every `main` merge.

## Scope

- Keep `main` as checks-only for publishing.
- Publish staging/prerelease versions from the `release` branch after checks
  pass.
- Publish stable versions from `v*` tags or manual stable workflow dispatch.
- Stamp npm package versions and Cargo crate versions from the same resolved
  SemVer value.
- Use npm dist-tags for npm staging, and public SemVer prerelease versions for
  crates.io staging because crates.io has no dist-tag equivalent.

## Release Shape

- `release` branch: `0.1.0-staging.<github.run_number>` with npm tag
  `staging`.
- `v0.1.0` tag or manual stable dispatch: `0.1.0` with npm tag `latest`.
- Cargo crates publish in dependency order:
  `syncular`, `syncular-protocol`, `syncular-codegen`, `syncular-runtime`,
  `syncular-testkit`, `syncular-client`.

## Evidence

- Added `scripts/stamp-cargo-versions.ts` for Cargo manifest/internal dependency
  stamping.
- Extended `scripts/stamp-versions.ts` to support exact `--version` releases
  while preserving suffix stamping.
- Added `scripts/publish-cargo-crates.ts` with explicit publish order,
  dry-run support, dirty-worktree support for stamped CI releases, and
  already-published skipping for repeatable stable reruns.
- Made `syncular-publish` respect `SYNCULAR_NPM_TAG` while keeping `latest` as
  the default, and changed already-published detection to check the exact
  package version so staging reruns can skip cleanly even when `latest` points
  elsewhere.
- Updated `.github/workflows/release.yml` so automatic publishing runs from the
  `release` branch, stable publishing runs from `v*` tags/manual stable
  dispatch, and both npm/Cargo use the same resolved version.
- Added Cargo publish dry-runs to the Rust native checks.
- Added npm publish dry-run support to the shared `syncular-publish` helper and
  a root `release:npm:dry-run` script.
- Passed `SYNCULAR_NPM_TAG` and `SYNCULAR_PUBLISH_DRY_RUN` through Turbo so
  staging releases cannot silently fall back to npm's `latest` tag.
- Changed package release scripts to call the workspace-local
  `syncular-publish` binary directly instead of `bunx syncular-publish`; the
  Rust JavaScript binding now depends on `@syncular/config` so it gets the same
  local publish helper as the TypeScript packages.
- Bumped the root release version to `0.1.0` so future npm/Cargo prereleases are
  not lower than the already-published Rust `0.1.0` crates.
- Removed the scheduled `Weekly Soak` workflow so release readiness is driven
  by explicit checks, branch releases, tags, and manual dispatches instead of
  unattended nightly/weekly lanes.
- Deleted scheduled GitHub Actions run history for the old `Weekly Soak`,
  `Nightly`, and scheduled `Checks` runs, and disabled the remote `Weekly Soak`
  workflow while the source removal is waiting to land on `main`.

## Gates

- `bun scripts/stamp-cargo-versions.ts --version 0.1.0-staging.999 --dry-run`
- `bun scripts/stamp-versions.ts --version 0.1.0-staging.999 --dry-run`
- `bun run --cwd config tsgo`
- `bun scripts/publish-cargo-crates.ts --dry-run --allow-dirty`
- `bun scripts/publish-cargo-crates.ts --allow-dirty` verified the
  already-published skip path for the current `0.1.0` crates.
- `SYNCULAR_PUBLISH_DRY_RUN=1 SYNCULAR_NPM_TAG=staging bunx turbo release
  --filter='./packages/syncular' --concurrency=1`
- `bun run release:npm:dry-run`
- `bun run release:cargo:dry-run`
- `bun install --frozen-lockfile`
- `gh run list --event schedule --limit 20 --json databaseId --jq 'length'`
  returned `0` after scheduled-run cleanup.
- `gh workflow list --all` shows `Checks`, `Deploy`, and `Release` active; the
  removed `Weekly Soak` workflow is disabled remotely until deleted on `main`.
- `git diff --check`
