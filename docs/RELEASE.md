# Syncular release runbook

Syncular publishes every public npm package and Rust crate in lockstep. The
current release is **0.11.0** (`v0.11.0`). All artifacts use Apache-2.0, except
private examples and test harnesses that are never published.

## 0.11.0 release notes

0.11.0 makes failed multi-operation commits recoverable as atomic aggregates
after their outbox entry has drained.

The release includes:

- the complete schema-agnostic local operation envelope on conflict and
  rejection outcomes, alongside the terminating operation result;
- protected SQLite persistence in the same transaction that records the final
  outcome and drains the outbox, including additive migration of 0.10 client
  databases;
- matching TypeScript and Rust/native APIs plus direct, restart, worker,
  Tauri, and React Native compatibility;
- an explicit privacy boundary: failed sibling values remain local-only in the
  protected client database, never enter protocol frames, ordinary app
  preferences, or telemetry, and follow existing outcome retention rules.

## 0.10.0 release notes

0.10.0 adds a transaction-scoped whole-commit validation seam for
server-authoritative aggregate invariants.

The release includes:

- one optional `commitValidator` over every decoded, authorized,
  post-CRDT-merge operation after sibling writes are staged;
- read-only `getRow` and bounded scope-indexed `scanRows` APIs that observe the
  final candidate state inside the same storage transaction;
- per-partition serialization before any operation read/write on SQLite and
  PostgreSQL, with fail-closed external-serialization requirements for D1;
- `CommitValidationRejection` for stable host codes, operation attribution,
  bounded correction details, atomic rollback, and duplicate-safe durable
  idempotent replay finalized under the same serialization lock;
- matching HTTP/WebSocket test-kit coverage, TypeScript/Rust client
  conformance, storage contracts, host documentation, and normative SPEC §6.8.

## 0.9.0 release notes

0.9.0 makes offline correction UI precise without putting application edit
intent or arbitrary server diagnostics on the wire.

The release includes:

- bounded, privacy-safe `RejectionDetails` for deliberate write-validator
  failures: field paths, stable reason/action tokens, and explicitly approved
  non-sensitive references;
- an additive `PUSH_RESULT_DETAILS` companion frame on `0x1B`, preserving
  compatibility with older clients and older servers while keeping the legacy
  `PUSH_RESULT` record unchanged;
- idempotent server persistence and durable TypeScript/Rust client persistence
  of structured details, including restart recovery;
- local-only `changedFields` intent for `patch` operations, retained through
  conflicts, rejections, final-outcome journaling, and restart without entering
  `PUSH_COMMIT` or becoming server-trusted data;
- matching TypeScript/Rust conformance scenarios, strict companion-frame
  validation, WebSocket/HTTP validator parity, and app-facing test-kit coverage;
- expanded conflict, validator, correction, and multi-client test guidance,
  plus corrected published `@syncular/testkit` installation instructions.

## 0.8.0 release notes

0.8.0 makes final client commit outcomes durable. Applications no longer need
to infer whether a missing outbox item applied or failed, or mirror conflict
state into preferences to survive a restart.

The release includes:

- an atomic local final-outcome journal: the outcome insert and outbox drain
  share one SQLite transaction in both TypeScript and Rust clients;
- `applied`, `cached`, `conflict`, and `rejected` history with per-operation
  results, stable error metadata, and the losing operation plus current server
  row/version for conflict recovery;
- restart restoration of active failures, explicit one-way resolution states,
  and replacement-commit linkage for keep-local/custom-merge workflows;
- configurable retention which never silently purges unresolved failures;
- direct, worker/follower, React, Tauri, and React Native API/event parity,
  including the reactive `useCommitOutcomes()` hook;
- cross-host tests covering restart survival, worker RPC, React invalidation,
  native persistence, Tauri/React Native bridges, and the complete Rust
  conformance catalog.

## 0.7.0 release notes

0.7.0 completes the breaking SQL-first SYQL cutover that landed after the
0.6.0 tag. Prototype `.syql` files must be migrated before upgrading: queries
now contain SQL directly, ordinary predicates replace `@cover(...)`,
`sync query` explicitly claims synchronization coverage, and result identity
is inferred instead of declared with `identity by`.

The release includes:

- the finalized revision-1 SYQL grammar, compiler, formatter, LSP, docs,
  examples, and cross-language emitters built around one checked QueryIR;
- inferred scope dependencies, explicit `sync query` coverage, conservative
  table-wide fallback, inferred identity, finite sort profiles, and bounded
  limit controls;
- an opt-in, explicitly aliased `_sync_version` named-query projection with an
  exact, non-null integer type, allowing applications to pass the observed
  server version into optimistic-concurrency mutations without raw SQL or
  handwritten result types;
- root-authoritative release versioning that materializes package and crate
  versions only in disposable release checkouts and validates packed internal
  dependency pins before publication;
- docs/demo builds on normal `main` changes while production deployment remains
  attached to the trusted release workflow.

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
- inferred scope dependencies, explicit `sync query` coverage, conservative
  table-wide fallback, inferred identity, finite sort profiles, and bounded
  limit controls;
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
source. Change its `version`, update the historical release notes above, and
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
with trusted OIDC publishing. After both registries succeed, the same tagged
checkout builds and deploys the versioned docs/landing page and public demo.
Normal `main` pushes build those sites in CI but never deploy production.

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
