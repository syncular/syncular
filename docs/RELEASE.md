# Syncular release runbook

Syncular publishes every public npm package and Rust crate in lockstep. The
current release is **0.59.0** (`v0.59.0`). All artifacts use Apache-2.0, except
private examples and test harnesses that are never published.

Per-version release notes live in [`RELEASE-NOTES.md`](RELEASE-NOTES.md), newest first. `scripts/version.ts release-notes` reads the section for the root version from that file.

## Release gates

Use Bun 1.4.4, matching the release workflow. The benchmark resource contract
expects its subprocess memory-counter units.

From the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run build:packages
bun run build:sites
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace
bash bindings/tauri/check.sh
```

Run the binding-specific checks when their toolchains are available:

```sh
bash bindings/react-native/check.sh
bash bindings/swift/check.sh
bash bindings/kotlin/check.sh
bash bindings/flutter/check.sh
```

Run the React Native gate through its package script so Bun loads the binding's
local `bunfig.toml` preload. Running its test paths from the repository root
resolves React Native's Flow source before the off-device mock is installed.

For the release performance contract, run the worker and real native bridge
lanes with strict thresholds:

```sh
SYNCULAR_PERF_GATE=1 SYNCULAR_TAURI_NATIVE_TEST=1 \
  bun test packages/web-client/test/performance.test.ts \
           packages/web-client/test/worker-rpc.test.ts \
           packages/tauri/test/native-bridge.test.ts
```

## Version bump

`package.json` at the repository root is the only authored release-version
source. Change its `version`, update `RELEASE-NOTES.md`, and
leave every managed child version at the committed `0.0.0` placeholder.

The placeholder applies to public and private npm manifests, publishable Cargo
manifests and internal path constraints, the Flutter and VS Code package
manifests, Bun/Cargo lockfile workspace entries, current install snippets, and
the Tauri create-app template. Historical facts such as prior release notes or
minimum-supported versions retain their real numbers.

Validate the authored state with:

```sh
bun install --frozen-lockfile
bun run version:check
```

`scripts/version.ts` also provides `print`, `assert-tag`, and `materialize`.
`materialize` is for disposable release checkouts: it reflects the root
version into package/crate manifests, exact internal constraints, templates,
and lockfiles, then validates the resulting release state. Do not commit its
output.

### The `bun.lock` stamp pitfall

`bun pm pack` materializes `workspace:*` dependency ranges from the lockfile's
workspace `version` stamps, not directly from `package.json`. A plain
`bun install` after a version bump can report “no changes” without rewriting
those stamps. This caused 0.4.0 tarballs to pin sibling packages at 0.3.1 and
create split-brain consumer installs.

The source-placeholder format eliminates that manual pitfall: every workspace
stamp is committed as `0.0.0`, `scripts/version.ts materialize` rewrites the
manifest and lockfile together, and the release workflow still inspects every
packed tarball before publishing it.

## Automated publication

The release is a commit on `main` followed by a version tag:

```sh
VERSION=$(bun scripts/version.ts print)
git tag -a "v$VERSION" -m "Syncular $VERSION"
git push origin main
git push origin "v$VERSION"
```

`.github/workflows/release.yml` verifies the tag against root `package.json`,
materializes all distributable metadata, runs the npm and native gates, builds
packages, validates packed dependency pins, and publishes in dependency order
with trusted OIDC publishing. The npm job fails before publishing when
`RELEASE-NOTES.md` has no `## <version> release notes` section. After both
registries succeed, the workflow publishes that section as the GitHub release
for the tag and marks it latest, and the same tagged checkout builds and deploys the versioned docs/landing page, which includes the public demo at `/demo/`.
Changes to `apps/docs` on `main` also build and deploy the docs/landing site
through `.github/workflows/docs.yml`. The `syncular-demo` worker on demo.syncular.dev only redirects to `https://syncular.dev/demo/` (`apps/demo/redirects/_redirects`); it has no workflow and is redeployed by hand with `bun run deploy` in `apps/demo` when the redirect changes.

The npm publish order is:

1. `@syncular/core`
2. `@syncular/crypto`
3. `@syncular/crdt-yjs`
4. `@syncular/server`
5. `@syncular/server-hono`
6. `@syncular/server-workers`
7. `@syncular/client`
8. `@syncular/react`
9. `@syncular/typegen`
10. `@syncular/tauri`
11. `@syncular/testkit`
12. `create-syncular-app`

`@syncular/conformance` remains private.

The crates.io publish order is:

1. `syncular-ssp2`
2. `syncular-authority`
3. `syncular-client`
4. `syncular-command`
5. `syncular-ffi`
6. `syncular`
7. `tauri-plugin-syncular`

The workflow skips an artifact already published at the release version, so a
partially completed trusted-publishing run is safe to re-run.

## Trusted publishers

Every public npm package and crate must trust GitHub repository
`syncular/syncular`, workflow `release.yml`. The workflow requests
`id-token: write`; no registry token is stored in the repository.

After publication, verify the workflow, the npm package set, the crates.io
package set, and one clean external consumer install before announcing the
release.
