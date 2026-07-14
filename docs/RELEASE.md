# Syncular release runbook

Syncular publishes every public npm package and Rust crate in lockstep. The
current release is **0.6.0** (`v0.6.0`). All artifacts use Apache-2.0, except
private examples and test harnesses that are never published.

## 0.6.0 release notes

0.6.0 ships RFC 0004 and the destructive SYQL revision-1 cutover. Syncular is
still in prototype phase, so this release intentionally provides no parser,
IR, or generated-API compatibility with the old `.syql` language. Regenerate
and rewrite prototype queries before upgrading.

The release includes:

- a normative language specification in [`SYQL.md`](./SYQL.md), executable
  fixture schemas, and lexical, syntax, semantic, lowering, formatter, and
  cross-emitter conformance families;
- a lossless lexer and container AST shared by generation, formatting, LSP,
  and editor tooling;
- authoritative typed query inputs, explicit `when` conditions, atomic named
  groups, hygienic predicates/imports, and distinct absent/null/false states;
- constructive `@scope`/`@cover` reactive facts, conservative table-wide
  fallback, proven identity, finite sort profiles, and bounded page controls;
- deterministic neutralized/enumerated lowering behind one QueryIR v3 plan and
  equivalent TypeScript, Swift, Kotlin, and Dart generated APIs;
- a closed SQLite 3.46.0 language profile which rejects extension functions,
  post-floor functions/arities, implicit clocks, randomness, unproven nested
  bounds, and window expressions;
- migrated repository queries, demos, native examples, docs, VS Code grammar,
  and generated outputs, with all prototype parser and legacy emitter paths
  deleted;
- CI gates that now run every native binding whenever the shared type
  generator changes.

## 0.5.1 release notes

0.5.1 hardens the native host paths after driving the published 0.5.0 Tauri
engine against a persisted database and a live realtime server:

- FFI and Tauri now use one canonical native HTTP/WebSocket transport instead
  of two copies that could drift;
- realtime connects with the persisted database client id, so registrations,
  scoped invalidations, socket sync rounds, and HTTP request identity agree;
- the socket reader uses a short read quantum and explicitly yields outside
  its mutex, preventing a quiet realtime connection from starving sends;
- Tauri reactive `querySnapshot` reads use a dedicated read-only SQLite
  connection and mailbox. Local views no longer queue behind HTTP/WebSocket
  work on the mutable client owner;
- native round tests lock client identity, socket fairness, and framing, while
  a Tauri regression test blocks the network owner and requires the local
  snapshot sidecar to respond independently.

The Diego Tauri PoC, with automatic sync enabled, moved from 54–58 ms warm
mutation-to-React-commit samples to 10–14 ms after warm-up. The remaining time
includes event delivery, React scheduling, reconciliation, and the display
boundary; the local snapshot IPC lane retains its ≤5 ms p95 gate.

## 0.5.0 release notes

0.5.0 ships RFC 0003, the revisioned reactive-view architecture across the
browser, Tauri/Rust, React Native, Swift, Kotlin, Flutter, and FFI surfaces.
The release includes:

- revisioned observation batches and snapshot-consistent named-query reads;
- generated reactive dependencies, coverage, row identity, and table
  descriptors;
- a renderer-independent reactive store with de-duplicated reads, exact
  invalidation, retained resources, and latest-revision-wins publication;
- React resources and mutation helpers that remove application-owned window,
  readiness, and settle-tracking workarounds;
- event-driven browser and native sync wakeups, including persistent-window
  catch-up after a native restart;
- literal Tauri API imports and a required `@tauri-apps/api` peer, fixing the
  browser error where `@tauri-apps/api/core` did not resolve to a valid URL;
- shared conformance vectors, native bridge coverage, and local-data
  performance gates.

RFC 0004 remains **proposed**. Its lossless SYQL lexer/parser groundwork is in
the repository, but the destructive language cutover described by that RFC is
not part of the 0.5.0 contract. Existing generated query inputs remain valid.

## Release gates

From the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run build:packages
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace
bash bindings/tauri/check.sh
```

Run the binding-specific checks when their toolchains are available:

```sh
bun run --cwd bindings/react-native typecheck
bun test bindings/react-native/test
bash bindings/swift/check.sh
bash bindings/kotlin/check.sh
bash bindings/flutter/check.sh
```

For the release performance contract, run the worker and real native bridge
lanes with strict thresholds:

```sh
SYNCULAR_PERF_GATE=1 SYNCULAR_TAURI_NATIVE_TEST=1 \
  bun test packages/web-client/test/performance.test.ts \
           packages/web-client/test/worker-rpc.test.ts \
           packages/tauri/test/native-bridge.test.ts
```

## Version bump

Before tagging, update all of these to exactly the same version:

- every `packages/*/package.json`, including the private conformance package;
- the publishable crates and their internal version constraints under
  `rust/crates/`;
- `bindings/tauri/plugin/Cargo.toml` and its internal crate constraints;
- the corresponding workspace package entries in `bun.lock`;
- `rust/Cargo.lock` and `bindings/tauri/Cargo.lock`;
- versioned install snippets and create-app templates.

Then run `bun install` and both Cargo workspaces to validate their locks.

### The `bun.lock` stamp pitfall

`bun pm pack` materializes `workspace:*` dependency ranges from the lockfile's
workspace `version` stamps, not directly from `package.json`. A plain
`bun install` after a version bump can report “no changes” without rewriting
those stamps. This caused 0.4.0 tarballs to pin sibling packages at 0.3.1 and
create split-brain consumer installs.

Always update the `bun.lock` workspace stamps as part of the version bump.
`scripts/check-lockstep.mjs` enforces the source/lock agreement, and the release
workflow also inspects every packed tarball before publishing it.

## Automated publication

The release is a commit on `main` followed by a version tag:

```sh
git tag -a v0.6.0 -m "Syncular 0.6.0"
git push origin main
git push origin v0.6.0
```

`.github/workflows/release.yml` verifies the tag against package and crate
versions, runs the npm gate, builds packages, validates packed dependency pins,
and publishes in dependency order with trusted OIDC publishing.

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
2. `syncular-client`
3. `syncular-command`
4. `syncular-ffi`
5. `syncular`
6. `tauri-plugin-syncular`

The workflow skips an artifact already published at the release version, so a
partially completed trusted-publishing run is safe to re-run.

## Trusted publishers

Every public npm package and crate must trust GitHub repository
`syncular/syncular`, workflow `release.yml`. The workflow requests
`id-token: write`; no registry token is stored in the repository.

After publication, verify the workflow, the npm package set, the crates.io
package set, and one clean external consumer install before announcing the
release.
