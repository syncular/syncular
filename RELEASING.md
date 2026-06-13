# Releasing

Versioning is owned by [Changesets](https://github.com/changesets/changesets);
publishing stays on the existing `turbo release` → `syncular-publish` path.

All publishable packages (`@syncular/*`, `syncular`, `create-syncular-app`)
form one **fixed group** (`.changeset/config.json`) and always release in
lockstep with a single version. The Rust crates and a few stamped constants
track that same version via `scripts/sync-versions.ts`.

## Day to day: record changes

When a PR contains something release-worthy, add a changeset:

```sh
bunx changeset
```

Pick any affected package (the fixed group bumps everything together), choose
the bump level (`major`/`minor`/`patch` — we are pre-1.0, so breaking changes
use `minor`), and describe the change. Commit the generated
`.changeset/*.md` file with the PR.

## Cutting a stable release

1. Make sure main is green (`bun run check`, `bun test`, etc.).
2. Apply the pending changesets:

   ```sh
   bun run version
   ```

   This runs `changeset version` (bumps every package in the fixed group,
   writes per-package `CHANGELOG.md`s, deletes consumed changesets) and then
   `scripts/sync-versions.ts`, which propagates the new version into:
   - the root `package.json` (base version for ephemeral staging/deploy stamps),
   - `rust/bindings/javascript/src/runtime-contract.ts`
     (`SYNCULAR_CLIENT_PACKAGE_VERSION`),
   - `packages/create-syncular-app/src/cli.ts`
     (`FALLBACK_SYNCULAR_VERSION_RANGE`),
   - the Cargo crates (`scripts/stamp-cargo-versions.ts`).

3. Refresh the lockfile and review: `bun install`, then inspect the diff
   (versions, changelogs, Cargo.toml files).
4. Optionally rehearse: `bun run release:rehearsal` (npm + cargo publish
   dry-runs in a clean worktree, fresh-app smokes, docs stale check).
5. Commit (`chore: release vX.Y.Z`), then tag and push:

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

   The tag push triggers `.github/workflows/release.yml` (stable channel). The
   workflow verifies the committed version matches the tag — it does NOT stamp
   anything — then publishes npm packages (`bun run release`, per-package
   `syncular-publish`: tarball junk check, `npm publish --provenance`, skip if
   the version already exists) and the Cargo crates, and runs post-publish
   install smokes.

Internal `workspace:*` dependency ranges stay as-is in the repo; `bun pm pack`
(inside `syncular-publish`) resolves them to the exact workspace version at
pack time.

## Publish credentials

- **npm** authenticates with the `NPM_TOKEN` repo secret and adds an OIDC
  provenance attestation (`id-token: write` + `npm publish --provenance`).
  Provenance alone does not authenticate the publish, so the token is required.
  **One-time setup:** create an npm **granular automation token** with
  read-write/publish access to the `@syncular` scope and the unscoped
  `syncular` + `create-syncular-app` packages, and add it as the repo secret
  `NPM_TOKEN`. (npm Trusted Publishing is tokenless but must be configured per
  package on npmjs.com, which is impractical for a first multi-package release
  where most packages do not exist yet.)
- **crates.io** uses [Trusted Publishing](https://crates.io/docs/trusted-publishing):
  the release workflow's `rust-lang/crates-io-auth-action` step exchanges the
  job's OIDC identity for a short-lived (30 min) token, so there is no
  long-lived `CARGO_REGISTRY_TOKEN` secret. **One-time setup:** add this repo +
  the `release.yml` workflow as a Trusted Publisher for each published crate on
  crates.io (crate Settings → Trusted Publishing) before the first
  trusted-publishing release. The local `bun run release:cargo` path still
  reads `CARGO_REGISTRY_TOKEN` from the environment for manual publishes.

## Staging releases

Pushing the `release` branch (after Checks pass) publishes an ephemeral
prerelease: CI stamps `<root version>-staging.<run>` via
`scripts/stamp-versions.ts` + `scripts/stamp-cargo-versions.ts` (never
committed) and publishes under the `staging` npm dist-tag. The same script
also stamps versions for app deploy builds in `deploy.yml`.

If a longer-lived prerelease train is ever needed, Changesets supports it
natively (`bunx changeset pre enter next` / `pre exit`); we don't use it today.

## One-time follow-ups after the next stable release

The next stable release (recommended: **0.1.0** — the pending changeset is a
`minor`, covering the dialects merge and the umbrella-CLI breaking changes;
`0.1.0` sorts above the last published `0.0.6-248`) must also:

1. Deprecate the 7 old client dialect packages (merged into
   `@syncular/dialects`):

   ```sh
   for p in dialect-better-sqlite3 dialect-bun-sqlite dialect-d1 \
            dialect-libsql dialect-neon dialect-pglite dialect-sqlite3; do
     npm deprecate "@syncular/$p" \
       "Merged into @syncular/dialects — import from '@syncular/dialects/<name>' instead."
   done
   ```

2. Deprecate the stale CLI package:

   ```sh
   npm deprecate @syncular/cli \
     "Replaced by the 'syncular' package — use 'npx syncular'."
   ```

3. Announce the three breaking changes in the release notes: the
   `@syncular/dialect-*` → `@syncular/dialects` rename, the `syncular`
   umbrella package becoming CLI-only, and the docs URL moves (redirected).

Never-published packages (`@syncular/react`,
`@syncular/client-javascript-bindings`, `@syncular/dialects`,
`@syncular/client-crdt-adapters`, `@syncular/client-react-native`,
`@syncular/client-tauri`, `create-syncular-app`) need no special handling —
the release filter already includes them and `syncular-publish` only skips
versions that are already on the registry.
