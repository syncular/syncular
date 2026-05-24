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
- Bumped the root release version to `0.1.0` so future npm/Cargo prereleases are
  not lower than the already-published Rust `0.1.0` crates.

## Gates

- `bun scripts/stamp-cargo-versions.ts --version 0.1.0-staging.999 --dry-run`
- `bun scripts/stamp-versions.ts --version 0.1.0-staging.999 --dry-run`
- `bun run --cwd config tsgo`
- `bun scripts/publish-cargo-crates.ts --dry-run --allow-dirty`
- `bun scripts/publish-cargo-crates.ts --allow-dirty` verified the
  already-published skip path for the current `0.1.0` crates.
- `git diff --check`
