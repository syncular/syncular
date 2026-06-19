# Releasing

Versioning is owned by [Changesets](https://github.com/changesets/changesets);
publishing stays on the existing `turbo release` → `syncular-publish` path.

All publishable npm packages (the fixed group in `.changeset/config.json`)
release in lockstep with a single version. Private workspace packages such as
`@syncular/ui` are intentionally excluded from npm publishing. The Rust crates
and a few stamped constants track that same version via
`scripts/sync-versions.ts`.

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
   - `packages/client/src/wasm-bindings/runtime-contract.ts`
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
   `syncular-publish`: tarball junk check, `npm publish --provenance` via npm
   Trusted Publishing, skip if the version already exists) and the Cargo crates,
   and runs post-publish install smokes.

Internal `workspace:*` dependency ranges stay as-is in the repo; `bun pm pack`
(inside `syncular-publish`) resolves them to the exact workspace version at
pack time.

## Publish credentials

- **npm** uses [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/):
  the release workflow has `id-token: write`, runs on GitHub-hosted runners,
  and `syncular-publish` calls `npm publish --provenance`. npm exchanges the
  workflow OIDC identity for a short-lived publish token; there is no
  long-lived `NPM_TOKEN` repo secret.
  **One-time setup:** configure each npm package to trust the
  `syncular/syncular` repository and `.github/workflows/release.yml` workflow
  for `npm publish` (npm package Settings -> Trusted Publisher, or
  `npm trust github <package> --repo syncular/syncular --file release.yml --allow-publish`).
  npm currently requires a package to exist before a trusted publisher can be
  configured, so brand-new package names must be created/reserved before the
  tokenless release workflow can publish their next version.
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

1. Deprecate the old published JavaScript packages that are no longer workspace
   packages after the folded package surface ships:

   ```sh
   npm deprecate @syncular/server-hono \
     "Merged into @syncular/server — import from '@syncular/server/hono' instead."
   npm deprecate @syncular/server-cloudflare \
     "Merged into @syncular/server — import from '@syncular/server/cloudflare' instead."
   npm deprecate @syncular/server-service-worker \
     "Merged into @syncular/server — import from '@syncular/server/service-worker' instead."
   npm deprecate @syncular/server-dialect-sqlite \
     "Merged into @syncular/server — import from '@syncular/server/sqlite' instead."
   npm deprecate @syncular/server-dialect-postgres \
     "Merged into @syncular/server — import from '@syncular/server/postgres' instead."
   npm deprecate @syncular/server-storage-filesystem \
     "Merged into @syncular/server — import from '@syncular/server/filesystem' instead."
   npm deprecate @syncular/server-storage-s3 \
     "Merged into @syncular/server — import from '@syncular/server/s3' instead."
   npm deprecate @syncular/server-plugin-yjs \
     "Merged into @syncular/server — import from '@syncular/server/crdt-yjs' instead."
   npm deprecate @syncular/relay \
     "Merged into @syncular/server — import from '@syncular/server/relay' instead."
   npm deprecate @syncular/transport-http \
     "Merged into @syncular/core — import from '@syncular/core/http' instead."
   npm deprecate @syncular/observability-sentry \
     "Merged into @syncular/client and @syncular/server — import browser telemetry from '@syncular/client/sentry' and Cloudflare telemetry from '@syncular/server/cloudflare/sentry'."
   npm deprecate @syncular/ui \
     "Internalized into @syncular/console and no longer published as a public package."
   ```

2. The 7 old `@syncular/dialect-*` packages already show as deprecated in the
   npm registry as of 2026-06-16. If the message needs to be refreshed, rerun:

   ```sh
   for p in dialect-better-sqlite3 dialect-bun-sqlite dialect-d1 \
            dialect-libsql dialect-neon dialect-pglite dialect-sqlite3; do
     npm deprecate "@syncular/$p" \
       "Merged into @syncular/server — import from '@syncular/server/<name>' instead."
   done
   ```

3. Deprecate the stale CLI package:

   ```sh
   npm deprecate @syncular/cli \
     "Replaced by the 'syncular' package — use 'npx syncular'."
   ```

4. Announce the breaking package-surface changes in the release notes:
   the `@syncular/dialect-*` → `@syncular/server/<driver>` move, the
   `syncular` umbrella package becoming CLI-only, the old client/server
   micro-packages folding into `@syncular/client/*`, `@syncular/server/*`, and
   `@syncular/core/http`, the Sentry adapter folding into
   `@syncular/client/sentry` and `@syncular/server/cloudflare/sentry`, and the
   docs URL moves (redirected).

Before running the stable npm release, confirm trusted publishing is configured
for the actual publishable npm package names:

- `syncular`
- `create-syncular-app`
- `@syncular/client`
- `@syncular/console`
- `@syncular/core`
- `@syncular/migrations`
- `@syncular/server`
- `@syncular/testkit`
- `@syncular/typegen`

Registry check on 2026-06-16: `create-syncular-app` is the only publishable npm
package name in this list that returned 404, so it needs a one-time
credentialed create/reserve publish before npm Trusted Publishing can own its
next publish. The other publishable names already exist at `0.0.6-248`.

Do not create or configure trusted publishing for subpaths such as
`@syncular/client/react`, `@syncular/client/tauri`,
`@syncular/client/react-native`, `@syncular/client/crdt-yjs`,
`@syncular/server/hono`, or `@syncular/server/sqlite`; those are export-map
entries inside the packages above, not registry packages. Brand-new npm package
names must still be created/reserved once before npm Trusted Publishing can own
their next publish.

## CI audit exceptions

`bun run audit` (part of `bun check`) ignores three advisories that come from
dev/build tooling and a peer dependency — none ship in the published
`@syncular/*` libraries:

- `GHSA-w7jw-789q-3m8p` (shell-quote, critical) — transitive via
  `@syncular/client`'s React Native subpath dev tooling (peer/dev only).
- `GHSA-gv7w-rqvm-qjhr` (esbuild, high) and `GHSA-g7r4-m6w7-qqqr` (esbuild, low)
  — transitive via app/build tooling (astro, vite, wrangler, fumadocs-mdx).

Re-evaluate when the upstream chains (`react-native`, `vite`/`astro`/`wrangler`)
ship patched releases, and drop the corresponding `--ignore` from the `audit`
script.
