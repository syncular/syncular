# Syncular release runbook

Syncular publishes every public npm package and Rust crate in lockstep. The
current release is **0.15.15** (`v0.15.15`). All artifacts use Apache-2.0, except
private examples and test harnesses that are never published.

## Unreleased

## 0.15.15 release notes

0.15.15 adds an explicit two-phase security lifecycle for applications that
must inspect server-authoritative device or membership state before opening a
protected local mirror.

The release includes:

- `securityPreflight: true`, `beginSecurityPreflight()`, and
  `activateSecurity()` across the direct TypeScript client, worker and
  multi-tab hosts, normalized React surface, Tauri/Rust bridge, and React
  Native bridge;
- the stable `client.security_preflight_required` error and a deliberately
  narrow preflight surface limited to lifecycle/status inspection, local
  revision, bounded local purge, and shutdown;
- barriers that synchronously stop new protected work, wait for in-flight
  operations and native read sidecars, suppress startup/retry intents, and
  prevent activation from overtaking the preflight drain;
- portable React Native encryption-key activation, matching the browser and
  Tauri hosts, plus one startup intent after successful activation when
  persisted work exists;
- browser follower-to-leader preflight propagation, native Tauri shutdown,
  and best-effort overwriting of native key buffers on replacement or drop;
- direct, worker RPC, multi-tab, mocked bridge, real native bridge, React
  Native, Rust command, and native concurrency regression coverage.

Applications still own the authority decision, secure-store/keychain access,
key enrollment and revocation, and any required bounded purge. Syncular now
provides the race-free host boundary for performing that work before ordinary
queries, mutations, subscriptions, networking, realtime, presence, outbox, or
blob activity can begin.

## 0.15.14 release notes

0.15.14 hardens the boundaries used by generated applications across server
storage, browser ownership, reactive availability, native hosts, and Vite
development.

The release includes:

- durable, privacy-safe relational-constraint rejection across SQLite,
  PostgreSQL, and D1, with whole-commit rollback and idempotent replay;
- strict generated TypeScript boolean result decoding shared by direct,
  worker/follower, Tauri, React Native, and React query paths;
- observable browser leader/follower state, bounded partition failure, safe
  promotion, and explicit isolated-replica ownership;
- one canonical schema-and-leadership availability classifier plus React
  provider/query boundaries that retain safe rows and recover automatically;
- schema-aware Vite HMR resource retention that closes the old database owner
  before constructing a replacement; and
- an end-to-end concurrency-correction guide covering version conflicts,
  domain rejection, durable correction inboxes, and aggregate replacement.

The React query phase union now includes `blocked`. Exhaustive consumers must
handle it separately from `loading`: `isLoading` is false, the typed
`availability.reason` explains the schema or browser-leadership boundary, and
previously safe rows may remain available for deliberate read-only UI.

`SyncProvider.renderBoundary` adds one typed guard for resource startup,
retryable startup errors, migration, schema compatibility, and unreachable
browser leadership. Status snapshots now carry `currentSchemaVersion` on the
TypeScript, Rust, worker, Tauri, and React Native surfaces.

## 0.15.13 release notes

0.15.13 fixes native clients remaining permanently stopped after a server that
lagged behind the app schema catches up.

The Rust client now clears a persisted schema-floor stop during reopen when
the running generated schema already satisfies the recorded required version,
then schedules the normal startup pull to re-negotiate with the server. An
actually incompatible server returns the floor again, while a caught-up server
bootstraps immediately. Unsatisfied floors remain durable and stopped. The
release includes focused reopen regression coverage for both cases.

## 0.15.12 release notes

0.15.12 makes secondary-index replacement a supported schema evolution instead
of forcing applications to preserve obsolete uniqueness constraints forever.

The release includes:

- strict `DROP INDEX name` and `DROP INDEX IF EXISTS name` migration parsing;
- head-schema removal and same-name `CREATE INDEX` replacement with updated
  uniqueness or columns;
- server schema-bump reconciliation that rebuilds declared application indexes
  on SQLite, PostgreSQL, and D1 relational projections before advancing the
  schema marker;
- unchanged client safety: application tables and their indexes continue to be
  recreated during the existing wipe/re-bootstrap flow on version changes;
- parser, three-dialect server migration, documentation, typecheck, lint, and
  full-suite regression coverage.

The 0.15.12 release head also restores `SyncClientLike` parity for
`purgeLocalData` on the React Native bridge, including direct bridge and
normalized React-client coverage.

## 0.15.11 release notes

0.15.11 adds the narrow local-storage primitive needed by applications with
server-authoritative device, membership, or encryption-key revocation.
`purgeLocalData({ purgeId, targets })` is available on the direct TypeScript
client, worker/multi-tab handle, normalized React client, Tauri bridge, Rust
client, and shared native command router.

The release includes:

- bounded, non-empty exact selectors over plaintext string schema columns,
  with AND semantics inside a target and OR semantics across targets;
- durable purge-id idempotency: an exact retry is a no-op and a reused id with
  a different canonical plan fails closed;
- one local SQLite transaction covering synced-row deletion, generated FTS
  cleanup, whole-commit outbox rejection, protected optimistic rollback/replay,
  blob-reference reconciliation, outcome journaling, and one revisioned change
  batch;
- privacy-safe counts-only acknowledgements and the stable local rejection code
  `client.local_data_purged`;
- matching TypeScript/Rust behavior plus worker RPC, mocked Tauri, real native
  Tauri, FTS, hidden optimistic delete, sibling rollback, and validation tests;
- explicit documentation that the host must validate the authority directive
  and gate subscriptions before purging, while app-owned files and OS secure-
  store key deletion remain outside Syncular.

There is intentionally no full-table mode and no wire/server-authority change.
The API cannot remotely erase an offline device and does not prevent a still-
active subscription from downloading rows again; those are application control-
plane responsibilities.

## 0.15.10 release notes

0.15.10 closes two generated-application naming/type gaps found by the first
encrypted Patient aggregate. Named-query parameters compared to encrypted
columns now use the decrypted application `declaredType`, just like result rows
and local runtime values; an encrypted local string therefore binds as `string`,
not ciphertext `Uint8Array`. This applies to both plain named-query inference
and the complete SYQL type-evidence pass.

`seedMutations` now resolves camelCase keys by applying the pinned §12
snake-to-camel schema mapping to each physical column. This keeps server seeds
in lockstep with generated row types and every client host, including digit
segments such as `address_line_1 → addressLine1`; the prior reverse-regex
shortcut incorrectly produced `address_line1`.

## 0.15.9 release notes

0.15.9 makes non-null E2EE usable through the same production hosts as the
direct client. `createSyncClientHandle` and `createTauriSyncClient` now accept a
portable `{ keys, keyIdColumns }` keyring. Worker leaders install the provider
inside the worker core; the Tauri bridge forwards byte-exact keys and row-key
selection to the existing Rust encryption command. A non-encrypted string key-id
column can select a different active key per Practice/Facility row, while the
envelope remains self-describing for old-key decryption and rotation.

Client-local FTS5 projections may now include encrypted columns whose declared
application type is `string`. Encryption still occurs only on the wire: the
projection indexes the decrypted value already held in the protected local
mirror, remains absent from server schema/storage, and is removed with the same
transactional purge/reset lifecycle as its owner table. Worker ciphertext and
native/portable key-selection regressions cover the new path.

## 0.15.8 release notes

0.15.8 fixes the application type of encrypted columns projected by generated
named queries. The local mirror is plaintext by contract, but query inference
previously reused the IR's ciphertext `bytes` wire type. Generated TypeScript,
Swift, Kotlin, and Dart rows now use the column's pre-wire `declaredType` and
original nullability, matching runtime values and generated table mutation
types. Schema IR, wire encoding, server storage, and encryption remain
unchanged.

## 0.15.7 release notes

0.15.7 completes safe table retirement at client startup. After a schema bump,
the TypeScript and Rust clients now remove persisted subscription registrations
whose table no longer exists, together with their window bookkeeping. A stale
registration can no longer poison every subsequent pull with
`sync.unknown_table`; registrations for tables still present remain durable and
re-bootstrap normally.

## 0.15.6 release notes

0.15.6 fixes TypeScript client startup when a schema bump adds an indexed
column. The client now creates protected bookkeeping first, reads the persisted
schema marker, performs the wipe/recreate reset, and only then materializes the
new application indexes and FTS projections. Same-version opens remain
self-healing for missing local tables or indexes.

## 0.15.5 release notes

0.15.5 makes transient browser storage ownership failures recoverable without
risking a healthy offline database, and tightens the documentation of the
existing SYQL revision-1 language.

The release includes:

- stable client-local `client.storage_busy` and
  `client.storage_unavailable` errors for OPFS startup, with ownership
  collisions marked retryable instead of being misclassified as terminal
  `sync.invalid_request` failures;
- a real follow-up SAH-pool initialization attempt after sqlite-wasm has cached
  a failed VFS promise, while preserving the existing no-fallback persistence
  boundary;
- `SyncClientResource.retry()` and a retry action on
  `SyncProvider.renderError`, allowing an error → pending → ready transition
  without replacing the provider or deleting local data;
- worker-RPC coverage proving retry metadata survives the boundary and failed
  startup releases leadership for a later attempt, plus React retry and
  deduplication tests;
- web, React, Vite/HMR, and troubleshooting guidance covering the one-owner
  OPFS invariant, resource preservation, and safe bounded/manual recovery;
- editorial SYQL specification, RFC, design, release-note, and docs-site
  cleanup that describes revision 1 as the current canonical language rather
  than defining it through removed prototype forms.

## 0.15.4 release notes

0.15.4 aligns native application queries and encrypted Tauri schemas with the
public Syncular client contract.

The release includes:

- `_sync_version` support in Rust/native `query` and atomic query-snapshot
  reads, with identifier-aware lowering to the private physical version column
  while preserving string literals and comments;
- an opt-in `e2ee` feature on `tauri-plugin-syncular` that forwards encryption
  support to the native client and shared command router, so applications with
  encrypted schema columns can complete native bootstraps;
- native query and file-backed sidecar regression coverage for the public row
  version projection.

## 0.15.3 release notes

0.15.3 completes RFC 0005 reactive metadata in the SYQL revision-1 frontend.
A declared local FTS projection is now folded into its synced owner table
before dependencies are emitted. Queries no longer expose a non-synced virtual
table as an invalidation dependency, while scope evidence from an explicitly
joined owner table remains exact.

## 0.15.2 release notes

0.15.2 completes the bounded named-query contract for the client-local FTS5
surface. Typegen now treats a projected `_syncular_source_id` from a
schema-declared FTS projection as an exact, non-null identity field. An FTS
join can therefore prove its composite identity and total-order suffix while
ordinary virtual tables, missing identity projections, and unstable bounded
queries remain rejected.

## 0.15.1 release notes

0.15.1 fixes the SYQL portable-profile gate for the FTS5 query contract added
in 0.15.0. Named queries that reference a schema-declared FTS projection may
now use the deterministic `bm25`, `highlight`, and `snippet` auxiliary
functions promised by RFC 0005. Those functions remain rejected when no
declared FTS projection is present, and arbitrary extension functions remain
outside the portable SQLite profile.

## 0.15.0 release notes

0.15.0 adds production-grade client-local FTS5 search projections for
offline-first applications, implemented in lockstep by the TypeScript and Rust
client cores.

The release includes:

- narrow migration-subset v2 syntax for
  `CREATE VIRTUAL TABLE … USING fts5`, with a required synced-table owner,
  local string columns, deterministic built-in tokenizers, and hard
  errors for arbitrary modules or options;
- `ftsIndexes` in the neutral IR and every generated TypeScript, Swift,
  Kotlin, and Dart schema value, while index-free generated output remains
  byte-stable;
- contentful local FTS tables keyed by a private stable application-primary-key
  identity, avoiding SQLite `rowid` and `INSERT OR REPLACE` hazards;
- transactional insert/update/delete maintenance, first-create bulk indexing,
  schema-reset recreation, and a bulk native overlay rebuild path;
- named-query `MATCH` parameter typing plus owner-table dependency and scope
  metadata, with SQLite `bm25`, `highlight`, and `snippet` available as normal
  computed expressions;
- an explicit no-fallback boundary: clients without FTS5 fail local schema
  creation instead of silently omitting search or substituting an unbounded
  `LIKE` scan;
- a table-reference scanner correction so an unaliased `FROM` can no longer
  consume the following `JOIN` keyword during named-query analysis.

There is no wire or server-storage change. Existing applications without
`ftsIndexes` remain compatible and retain their previous generated bytes.

## 0.14.0 release notes

0.14.0 makes application-row upserts safe in the presence of secondary
unique indexes on SQLite-family clients and servers.

The release includes:

- primary-key-targeted `ON CONFLICT ... DO UPDATE` writes for the TypeScript
  SQLite client, SQLite-image bootstrap path, Rust client, SQLite server, and
  D1 server;
- removal of application-row `INSERT OR REPLACE` behavior that could delete
  an existing row when a different row collided with a secondary unique
  index;
- atomic failure semantics matching PostgreSQL: the colliding write fails and
  the previously stored row remains intact;
- direct regression coverage for ordinary client apply, SQLite-image apply,
  native apply, SQLite server storage, and D1 storage.

No wire or schema change is required. Existing databases and generated code
remain compatible; applications using unique indexes should upgrade every
SQLite-family client and server runtime together.

## 0.13.0 release notes

0.13.0 makes TypeScript optimistic rollback truthful immediately after a
server rejection, including when no server row is delivered in the pull half.

The release includes:

- protected per-commit before-images captured atomically with every TypeScript
  outbox append and retained across process restarts;
- immediate restoration of rejected updates, inserts, deletes, and atomic
  sibling operations, followed by FIFO replay of later pending edits;
- rebased before-images for downstream commits touching the same rows, so a
  later rejection still restores the correct confirmed base;
- an explicit privacy boundary: rollback images never enter protocol frames,
  public pending/outcome envelopes, preferences, telemetry, or generic
  diagnostics;
- additive local-schema migration and restart/aggregate regression coverage,
  matching the Rust client's existing durable base-plus-overlay behavior.

Upgrade note: pending TypeScript outbox entries created before 0.13.0 do not
contain reconstructible before-images. They retain the prior fail-closed
rollback behavior and converge on the next server delivery or re-bootstrap;
every mutation recorded after the upgrade uses immediate durable restoration.

## 0.12.0 release notes

0.12.0 adds safe table retirement to SQL migration type generation and the
relational server schema-bump path.

The release includes:

- strict `DROP TABLE name` and `DROP TABLE IF EXISTS name` parsing, with
  unknown tables, trailing clauses, and dropped-name reuse rejected;
- head-schema generation that permits historically created, subsequently
  retired tables to be omitted from the manifest and generated APIs;
- SQLite, PostgreSQL, and D1 schema bumps that remove retired relational
  current-row tables and their live scope-index entries;
- an explicit retention boundary: append-only commit history remains governed
  by ordinary retention, so schema retirement is not an erasure API;
- generator, manifest, and three-dialect server migration coverage plus
  updated schema documentation.

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

0.6.0 ships RFC 0004 and SYQL revision 1: a SQL-first language for typed,
reactive reads and explicit synchronization coverage.

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
- aligned repository queries, demos, native examples, docs, VS Code grammar,
  and generated outputs around the same language definition;
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
Changes to `apps/docs` on `main` also build and deploy the docs/landing site
through `.github/workflows/docs.yml`. The public demo deploys from release tags.

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
