# WP-40 Fresh App Release DX

Status: `[x]` accepted

## Goal

Make the first developer experience and release confidence explicit:

- prove fresh JavaScript and Rust apps can generate from scratch before publish
- run post-publish install smokes as part of the release workflow
- keep the unified `syncular generate` path as the app-facing JS command
- prevent stale app-facing docs from drifting back to old package names or
  generation commands
- reduce naming friction by matching the React workspace folder to the
  published package name

## Scope

- Add executable fresh-app local smoke fixtures.
- Add a release rehearsal command that composes version stamping, stale-doc
  checks, fresh-app smokes, and publish dry-runs.
- Wire post-publish install smokes into the release job after npm and Cargo
  publish steps.
- Rename `packages/client-react` to `packages/react` while keeping the
  published package name `@syncular/client/react`.
- Harden browser-global test setup for React package tests.
- Add a blank-app API review note for remaining DX friction.

## Gates

- `bun run docs:stale-check`
- `bun test packages/syncular/src/cli.test.ts`
- `bun --cwd packages/react test`
- `bun --cwd packages/react tsgo`
- `bun run fresh-app-smokes`
- `bun run release:rehearsal -- --version 0.1.0-staging.local --allow-dirty --skip-publish-dry-runs`
- `bun run knip`

## Evidence

- `bun run docs:stale-check` passed.
- `bun test packages/syncular/src/cli.test.ts` passed.
- `bun --cwd packages/react test` passed.
- `bun --cwd packages/react tsgo` passed.
- `bun run fresh-app-smokes` passed. It generated a fresh JS app through
  `syncular generate`, generated a fresh Rust app through the Rust-only config
  path, checked both outputs, compiled the Rust app, and opened a
  `syncular-testkit` client.
- `bun run release:rehearsal -- --version 0.1.0-staging.local --allow-dirty --skip-publish-dry-runs`
  passed.
- `bun run release:npm:dry-run` passed after package tarball test-file
  exclusions were applied across publishable npm manifests.
- `bun run release:cargo:dry-run` passed.
- `bun run tsgo` passed.
- `bun run docs:build` passed.
- `bun lint` passed.
- `bun run knip` passed.

## Compatibility

No compatibility branch, protocol fallback, or legacy alias is added. The
workspace folder rename is repo-internal; the published package remains
`@syncular/client/react`.
