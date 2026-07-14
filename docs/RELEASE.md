# Syncular v2 — 0.2.0 release runbook

All packages/crates below publish at **0.2.0**. License: **Apache-2.0**
(matches v1; `LICENSE` at repo root). Every command was validated with a
dry-run — see the notes at the end for the two items that cannot dry-run
fully clean until their upstreams are live.

Prerequisites:

```sh
# from repo root
bun install
bun run check          # typecheck + lint + test — must be green
bun run build:packages # emits packages/*/dist (ESM .js + .d.ts)
cargo build --manifest-path rust/Cargo.toml
```

---

## 1. npm — `packages/`

Publish set (13). `bun publish` rewrites `workspace:*` → `0.2.0` in the
packed manifest (verified). Build the dist first (`bun run build:packages`).

**Dependency order** (leaves first — required because each package's
`exports.import` points at the *published* dist of its `@syncular/*` deps):

```sh
cd packages/core         && bun publish        # @syncular/core
cd ../crypto             && bun publish        # @syncular/crypto
cd ../server             && bun publish        # @syncular/server
cd ../server-hono        && bun publish        # @syncular/server-hono
cd ../server-workers     && bun publish        # @syncular/server-workers
cd ../crdt-yjs           && bun publish        # @syncular/crdt-yjs
cd ../web-client         && bun publish        # @syncular/client
cd ../react              && bun publish        # @syncular/react
cd ../typegen            && bun publish        # @syncular/typegen  (bin: syncular)
cd ../tauri              && bun publish        # @syncular/tauri
cd ../create-app         && bun publish        # create-syncular-app (bin)
cd ../testing            && bun publish        # @syncular/testkit
```

`@syncular/conformance` stays **private** (not published). The transport-fault
controller's canonical home is `@syncular/testkit/faults`; the private
conformance harness re-exports it (one implementation, publishable dependency
direction), so every publish-set package is install-safe.

`npm publish` equivalents: use `npm publish --access public` in each dir
after `npm version`-materializing the `workspace:*` deps (bun does this at
pack time; npm does not — replace them with `"0.2.0"` first if using npm).

---

## 2. crates.io — `rust/`

Publish set (4), **dependency order**:

```sh
cd rust
cargo publish -p syncular-ssp2      # package renamed from `ssp2`; [lib] name stays `ssp2`
cargo publish -p syncular-client    # (after ssp2 is live on the index)
cargo publish -p syncular-command   # (after client)
cargo publish -p syncular-ffi       # (after command) — [lib] name `syncular` → libsyncular
```

Then the deprecation-substitute stub for the v1 `syncular` crate:

```sh
cargo publish -p syncular           # empty placeholder → points at syncular-client
```

Then the Tauri plugin — it lives in its OWN workspace (`bindings/tauri/`,
kept out of the main cargo gate), so publish it from there, after
`syncular-command` is live on the index (its path deps carry `version`
constraints that resolve against the index at publish time; RFC 0002 §1.2 —
without this crate on crates.io, Tauri adoption requires a repo checkout):

```sh
cd bindings/tauri
cargo publish -p tauri-plugin-syncular   # (after syncular-command)
```

Since 0.3.0 the plugin has a crates.io trusted publisher attached and rides
the `release.yml` crates job with everything above — the manual step exists
for first-publish/recovery situations only.

Not published (`publish = false`): `conformance-shim`, `syncular-bench`.

> Between steps, wait for each crate to appear on the crates.io index before
> publishing the next (cargo verifies the `version = "0.2.0"` path-dep
> constraints against the live index).

---

## 3. npm deprecations (v1 names superseded in 0.2.0)

Run after the 0.2.0 packages are live. Each points at its absorber.

```sh
npm deprecate syncular@"<0.2.0"                     "superseded in 0.2.0 — use @syncular/client"
npm deprecate @syncular/console@"<0.2.0"            "superseded in 0.2.0 — folded into @syncular/server"
npm deprecate @syncular/migrations@"<0.2.0"         "superseded in 0.2.0 — folded into @syncular/typegen"
npm deprecate @syncular/cli@"<0.2.0"                "superseded in 0.2.0 — the CLI ships in @syncular/typegen (bin: syncular)"
npm deprecate @syncular/ui@"<0.2.0"                 "superseded in 0.2.0 — use @syncular/react"
npm deprecate @syncular/dialect-bun-sqlite@"<0.2.0" "superseded in 0.2.0 — folded into @syncular/server"
npm deprecate @syncular/transport-http@"<0.2.0"     "superseded in 0.2.0 — folded into @syncular/client and @syncular/server"
npm deprecate @syncular/transport-ws@"<0.2.0"       "superseded in 0.2.0 — folded into @syncular/client and @syncular/server"
npm deprecate @syncular/client-plugin-blob@"<0.2.0" "superseded in 0.2.0 — folded into @syncular/client"
npm deprecate @syncular/server-dialect-postgres@"<0.2.0" "superseded in 0.2.0 — folded into @syncular/server"
```

(Adjust the version range if a name should be deprecated at all versions:
use `@syncular/foo@"*"` to cover every published version.)

## 4. crates.io deprecations

crates.io has **no per-crate deprecate command**. The v1 `syncular-runtime`
crate (superseded by `syncular-client`) therefore cannot be marked
deprecated from the CLI — its README should be updated in place, or the
crate yanked per-version with `cargo yank`, at Benjamin's discretion. The v1
`syncular` crate is handled by publishing the 0.2.0 stub above (step 2).

---

## Dry-run status (validated 2026-07-06)

- npm: `bun publish --dry-run` **clean for all 13** publish-set packages.
  `bun pm pack` confirmed `workspace:*` → `0.2.0` rewrite in deps, devDeps,
  and peerDeps. `@syncular/core` tarball dist smoke-imported under plain
  `node` (55 symbols) OUTSIDE the repo.
- crates: `cargo publish --dry-run -p syncular-ssp2 --allow-dirty` **clean**
  (packaged + verified + compiled). `cargo package -p syncular` (stub)
  **clean**. `syncular-client` / `syncular-command` / `syncular-ffi` cannot
  full-`cargo package`/dry-run until their upstream 0.2.0 crates are on the
  index (their path deps carry `version = "0.2.0"`); they build + test green
  (`cargo build`, `cargo test`) and `cargo package --list` succeeds. This is
  the normal dependency-order publish flow — publish upstream first.

## Runtime caveats (by design, not bugs)

- `@syncular/server` and `@syncular/typegen` statically re-export/import
  `bun:sqlite` from their root entry, so `import`ing them under **plain
  Node** throws `ERR_MODULE_NOT_FOUND: bun:sqlite`. They are meant for Bun
  (or Workers/edge builds that tree-shake the SQLite modules). Browser and
  Workers consumers use the tree-shaken subpaths; `@syncular/client`'s root
  is browser-safe (SQLite backends live behind `./bun` `./node` `./wasm`).
- `packages/*/dist` is git-ignored (build artifact) — rebuild with
  `bun run build:packages` before publishing; do not commit it.

## After the first local publish: trusted publishing (one-time setup)

Both registries only attach trusted publishers to EXISTING packages/crates
— hence the local first publish above, then:

1. **npmjs.com** — for each of the 13 published packages: package page →
   Settings → *Trusted publisher* → GitHub Actions → owner `syncular`,
   repository `syncular`, workflow `release.yml` (no environment). Once
   set, revoke any legacy automation tokens.
2. **crates.io** — for each of `syncular-ssp2`, `syncular-client`,
   `syncular-command`, `syncular-ffi`, `syncular`: crate page → Settings →
   *Trusted Publishing* → add GitHub `syncular/syncular`, workflow
   `release.yml`.
3. From then on a release is: bump versions (packages + crates in
   lockstep, **including the bun.lock workspace `version` stamps — see
   below**), commit, tag `v<version>`, push the tag —
   `.github/workflows/release.yml` runs the check suite, builds dists, and
   publishes both registries in dependency order via OIDC (npm with
   `--provenance`; crates via `rust-lang/crates-io-auth-action`). No
   tokens are stored in CI.

## The bun.lock stamp pitfall (shipped broken in 0.4.0)

`bun pm pack` materializes `workspace:*` dependency ranges from the
LOCKFILE's workspace `version` stamps, not from package.json — and
`bun install` after a version bump reports "no changes" WITHOUT rewriting
those stamps. The 0.4.0 tarballs therefore pinned their `@syncular/*`
siblings at 0.3.1: consumers got split-brain installs (react@0.4.0 over a
nested client@0.3.1; server-hono crashed importing a 0.4-only export from
a nested server@0.3.1).

Release bumps must therefore ALSO update the `"version"` stamps on the
workspace entries in `bun.lock` (plain sed, then `bun install` to
validate). Two guards enforce it: `scripts/check-lockstep.mjs` fails
`bun run check` on stale stamps, and the release workflow re-verifies each
packed tarball's `@syncular/*` pins against the release version before
`npm publish`.
