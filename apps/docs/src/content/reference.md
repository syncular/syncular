# Specifications & packages

This page is for developers who need to find the normative text behind a
behavior, check what a conformance run proves, or locate a published package,
crate, or binding. It indexes the three specifications, the sections of the
protocol specification, the conformance catalog and how it is enforced, and the
source location of every artifact.

::meta{for="Implementers, contributors, and anyone auditing a behavior" time="Reference" first="concepts-subscriptions" spec="0 1 2 3 4 5 6 7 8 9 10 11"}

:::terms
- **SSP2**: The Syncular wire protocol: the envelope, frames, and row codec that every client and server exchange.
- **Golden vector**: A committed byte sequence with its decoded form. A codec passes when it decodes and re-encodes each one byte for byte.
- **Conformance catalog**: The implementation-agnostic list of scenario scripts in `@syncular/conformance`.
- **Driver**: The bytes-in, bytes-out interface the catalog uses to run a client or server. Each core implements one.
- **Pairing**: One client driver and one server driver run against the whole catalog.
:::

## Specifications

Three documents are normative. The repository holds each one; nothing else
defines wire or language behavior.

| Specification | Defines |
|---|---|
| [Syncular protocol specification](https://github.com/syncular/syncular/blob/main/docs/SPEC.md) | Transport, data model, scopes, synchronization, storage-independent behavior, errors, and conformance |
| [SYQL language specification](https://github.com/syncular/syncular/blob/main/docs/SYQL.md) | `.syql` lexical grammar, syntax, types, static semantics, SQLite profile, lowering, generated API contract, tooling, and conformance |
| [Remote operation specification](https://github.com/syncular/syncular/blob/main/docs/REMOTE.md) | Registered authoritative queries, commands, operation value encoding, and live query watches |

The [SYQL language guide](/syql/) covers the authoring model with examples; use
the language specification when you implement tooling or need the exact
normative behavior.

## Protocol & conformance

Syncular has two cores: TypeScript for the web and Rust for native. Both
implement one written protocol, and one shared conformance catalog proves they
agree.

### Protocol specification by section

[`SPEC.md`](https://github.com/syncular/syncular/blob/main/docs/SPEC.md) specifies the wire format (the SSP2 envelope, frames, the row codec,
segments) and the semantics (the commit and cursor model, scope intersection
and revocation, bootstrap phases, conflict detection, realtime). It plus the
golden vectors in `spec/vectors/` contain everything needed to interoperate; an
implementer needs no access to any existing source tree.

| Section | Topic |
|---|---|
| [§0](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#0-design-decisions) | Design decisions, with their rationale |
| [§1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#1-transport-bindings-and-envelope) | Transport bindings, the SSP2 envelope, framing, streaming, decode versus validation |
| [§2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#2-data-model-and-identity) | Commits, changes, versions, idempotency, the schema IR and row codec |
| [§3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#3-scopes-and-authorization) | Scopes: patterns, requested, allowed, and effective scopes, revocation, write-path authorization |
| [§4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#4-subscriptions-cursors-pull) | Subscriptions, cursors, pull, the pruning horizon, the bootstrap state machine, windowed subscriptions (§4.8) |
| [§5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#5-bootstrap-segments) | Bootstrap segments, the download endpoint, signed URLs, sqlite images (§5.3), blobs (§5.9), CRDT columns (§5.10), client-side encryption (§5.11) |
| [§6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#6-push-conflicts-results) | Push and commit application, conflicts, atomicity, write-validation hooks (§6.7), durable server reactions (§6.9), declared references (§6.11) |
| [§7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#7-offline-writes-and-replay) | The client outbox, replay, auth leases (§7.3), the schema-bump flow (§7.4), local observation (§7.5) |
| [§8](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#8-realtime) | Realtime: deltas, wake-ups, presence (§8.6), the WebSocket-native sync loop (§8.7) |
| [§9](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#9-versioning-and-evolution) | Versioning and evolution |
| [§10](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#10-error-catalog) | The error catalog |
| [§11](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#11-canonical-json-debug-rendering) | Canonical JSON debug rendering |

Appendix A lists the golden vectors and Appendix B the conformance scenarios.

Three rules govern protocol changes:

- **Spec-first**: behavior lands in the specification, with vectors or
  conformance scenarios, before or with the code. The specification is never
  reverse-engineered from an implementation.
- **Canonical encoding**: every value has exactly one valid byte sequence, and
  golden vectors verify byte-for-byte round trips. An encoder that produces
  different bytes for the same value is non-conformant.
- **Versioned change**: a change to wire format or semantics bumps the version
  and updates the vectors in the same commit.

### The conformance catalog

`@syncular/conformance` runs every scenario in its catalog against any
(client, server) pairing through the driver interface. `bun run check` runs the
whole catalog on the TypeScript client and TypeScript server, plus the
golden-vector stage. The `rust-conformance` CI job runs the same catalog on the
Rust client against the TypeScript server.

:::figure{title="One catalog, two cores" note="Drivers carry bytes and JSON only" ticks}
<div class="node hot"><span class="t">Scenario catalog</span>One file per area in <code>packages/conformance/src/catalog/</code>, each scenario citing its SPEC sections</div>
<div class="d-down"><small>drives through the driver interface</small></div>
<div class="d-cols-2">
<div class="d-box">
<p class="d-label">Pairing in <code>bun run check</code></p>
<div class="d-stack">
<div class="node ok"><span class="t">Client driver</span>TypeScript client on bun:sqlite</div>
<div class="node ok"><span class="t">Server driver</span>TypeScript server</div>
</div>
</div>
<div class="d-box">
<p class="d-label">Pairing in the <code>rust-conformance</code> CI job</p>
<div class="d-stack">
<div class="node cool"><span class="t">Client driver</span>Rust client behind the <code>conformance-shim</code> binary</div>
<div class="node ok"><span class="t">Server driver</span>TypeScript server</div>
</div>
</div>
</div>
<div class="d-down"><small>both also decode and re-encode</small></div>
<div class="node"><span class="t">Golden vectors</span><code>spec/vectors/</code>, byte for byte</div>

::caption[A scenario that passes on both pairings pins behavior the two cores share. Any pairing can be mixed, so a new core plugs in on either side.]
:::

The catalog covers convergence, offline replay and idempotency, both conflict
shapes, scope grant, revoke, and purge, bootstrap (fresh, resumed, interrupted,
sqlite images, windows), cursor expiry and the horizon, schema floors and
bumps, realtime deltas, wake-ups and presence, auth leases, blobs, CRDT and
encrypted columns, and the error catalog. The files under
[`packages/conformance/src/catalog/`](https://github.com/syncular/syncular/tree/main/packages/conformance/src/catalog) list every scenario; each carries its
`specRefs`, and SPEC Appendix B indexes them. Fine-grained permutations stay in
package-local tests, because the catalog buys breadth across implementations
rather than depth within one.

The [conformance README](https://github.com/syncular/syncular/blob/main/packages/conformance/README.md) is the runner reference and the test doctrine
for the repository. Four rules enforce the catalog:

- **Loopback by default**: scenarios drive the server through its byte-level
  entry points (`handleSyncRequest`, the segment download handler, the
  realtime hub) over an in-memory loopback that neither implementation can
  tell from a network. Almost every test runs without HTTP, sockets, or ports.
- **Fault injection at the transport seam**: the harness drops requests and
  responses, duplicates and reorders deliveries, and truncates bytes. Faults
  are deterministic; the one random value, the truncation offset, comes from a
  generator seeded by the scenario name.
- **Readiness waits, never sleeps**: every wait is an explicit completion
  promise, the server clock is virtual, and a doctrine test greps the package
  for `setTimeout` and `setInterval`.
- **Scenarios are never weakened**: a divergence is marked `knownDiscrepancy`
  with its spec reference. The runner expects the scenario to fail and reports
  `unexpected-pass` when the fix lands, so a stale marker cannot go unnoticed.

### Plugging in a third implementation

A new client or server implements a driver. The reference
[`ts-server` driver](https://github.com/syncular/syncular/blob/main/packages/conformance/src/drivers/ts-server.ts) shows the surface:
`handleSyncRequest(bytes)`, the segment-download handler, the realtime hub
connect, and test hooks that set allowed scopes, advance the virtual clock, and
inject faults. A driver declares `capabilities` such as `signed-urls`, `blobs`,
or `idempotency-fault`; scenarios that need a capability skip drivers without
it.

The path for a third core: implement `SPEC.md`, pass the golden vectors byte
for byte, then pass the catalog through a driver shim. The Rust core followed
this path from the specification alone. New features follow it too: CRDT
columns landed as the column type and merge semantics in
[SPEC §5.10](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#510-crdt-columns--opt-in-collaborative-state), two golden vectors, and convergence
scenarios that both client cores run.

## npm packages

All packages publish under the `@syncular/*` scope, plus the unscoped scaffolder.

| Package | What it is | Source |
|---|---|---|
| `@syncular/core` | Protocol codecs, shared types, the golden-vector round trip | [packages/core](https://github.com/syncular/syncular/tree/main/packages/core) |
| `@syncular/server` | `handleSyncRequest`, runtime-selected SQLite through `@syncular/server/sqlite`, registered queries and commands, durable reaction planning and delivery, storage, auth, segment, and blob interfaces, realtime hubs, pruning, signed URLs, `SyncularAdmin` | [packages/server](https://github.com/syncular/syncular/tree/main/packages/server) |
| `@syncular/server-hono` | Hono adapter that mounts the §1.1 routes and the static admin page | [packages/server-hono](https://github.com/syncular/syncular/tree/main/packages/server-hono) |
| `@syncular/server-workers` | Cloudflare Workers entry: fetch handler over D1 storage and R2 segments and blobs | [packages/server-workers](https://github.com/syncular/syncular/tree/main/packages/server-workers) |
| `@syncular/client` | The TypeScript replica client, the database-less `SyncRemoteClient`, runtime-selected SQLite through `@syncular/client/sqlite`, browser database adapters, worker transports, and multi-tab support | [packages/web-client](https://github.com/syncular/syncular/tree/main/packages/web-client) |
| `@syncular/react` | React bindings: `SyncProvider` and hooks over fine-grained invalidation | [packages/react](https://github.com/syncular/syncular/tree/main/packages/react) |
| `@syncular/crypto` | Client-side encryption primitives, symmetric and asymmetric; see [Encryption](/concepts-encryption/) | [packages/crypto](https://github.com/syncular/syncular/tree/main/packages/crypto) |
| `@syncular/crdt-yjs` | The Yjs `crdt` column merger (server) and the `YjsColumn` client helper; see [CRDT columns](/concepts-crdt/) | [packages/crdt-yjs](https://github.com/syncular/syncular/tree/main/packages/crdt-yjs) |
| `@syncular/typegen` | Migrations and manifest to the neutral schema and query IR, then generated schema modules and typed named queries for TypeScript, Swift, Kotlin, Dart, and Rust; ships the `syncular` CLI ([CLI reference](/tooling-cli/)) | [packages/typegen](https://github.com/syncular/syncular/tree/main/packages/typegen) |
| `@syncular/tauri` | `createTauriSyncClient()`, a `SyncClientLike` over Tauri IPC, paired with the `tauri-plugin-syncular` Rust plugin | [packages/tauri](https://github.com/syncular/syncular/tree/main/packages/tauri) |
| `@syncular/testkit` | App-developer test kit: an in-memory server and N real clients in one test file; see [Testing](/tooling-testing/) | [packages/testing](https://github.com/syncular/syncular/tree/main/packages/testing) |
| `create-syncular-app` | Scaffolder: `bun create syncular-app my-app` with `minimal`, `web`, and `tauri` templates | [packages/create-app](https://github.com/syncular/syncular/tree/main/packages/create-app) |

Two packages live in the repository without an npm release.
`@syncular/conformance` is the scenario runner and is workspace-private.
`@syncular/react-native` is the TurboModule binding in
[bindings/react-native](https://github.com/syncular/syncular/tree/main/bindings/react-native); consume it from the repository checkout.

## Crates

crates.io publishes the Rust side in dependency order:

| Crate | What it is | Source |
|---|---|---|
| `syncular-ssp2` | The SSP2 wire codec, implemented from SPEC.md alone | [rust/crates/ssp2](https://github.com/syncular/syncular/tree/main/rust/crates/ssp2) |
| `syncular-client` | The Rust client core on rusqlite: the native runtime the bindings host and the execution boundary for generated Rust named queries | [rust/crates/client](https://github.com/syncular/syncular/tree/main/rust/crates/client) |
| `syncular-command` | The shared JSON command router over the client core, used by the conformance shim, the FFI core, and the Tauri plugin | [rust/crates/command](https://github.com/syncular/syncular/tree/main/rust/crates/command) |
| `syncular-ffi` | The client core packaged as a C-ABI native library (`rust/ffi.h`): the runtime for iOS, Android, JVM, and desktop | [rust/crates/ffi](https://github.com/syncular/syncular/tree/main/rust/crates/ffi) |

The bare `syncular` crate name is a placeholder that points at
`syncular-client`. The repository also holds `conformance-shim` and `bench`
crates for the conformance run and the benchmarks; neither is published.

## Bindings outside npm and crates.io

Each binding is its own isolated build, gated by its `check.sh`, and you consume
it from the repository checkout:

| Binding | What it is | How you consume it |
|---|---|---|
| [bindings/swift](https://github.com/syncular/syncular/tree/main/bindings/swift) | `SyncularClient`, a Swift wrapper over `syncular-ffi` ([Swift](/platform-swift/)) | A separate SwiftPM package (`Package.swift`); add it as a SwiftPM dependency |
| [bindings/kotlin](https://github.com/syncular/syncular/tree/main/bindings/kotlin) | `SyncularClient`, a Kotlin/JVM wrapper over `syncular-ffi` through FFM (JDK 21 or newer, no runtime dependencies beyond the stdlib) ([Kotlin](/platform-kotlin/)) | A separate Gradle project; depend on it from your Gradle build |
| [bindings/flutter](https://github.com/syncular/syncular/tree/main/bindings/flutter) | `SyncularClient`, a Dart wrapper over `syncular-ffi` through `dart:ffi` ([Flutter](/platform-flutter/)) | The `syncular` Dart package at `bindings/flutter/syncular`; add it as a pub path dependency |
| [bindings/tauri](https://github.com/syncular/syncular/tree/main/bindings/tauri) | `tauri-plugin-syncular`, the client core running natively in the Tauri host process ([Tauri](/platform-tauri/)) | A cargo path or git dependency on `bindings/tauri/plugin`, paired with `@syncular/tauri` in the webview |

## Contracts and repository references

Each operational contract lives next to the code that enforces it.

- **Manifest, schema IR, SQL subset, and named-query format**: the [typegen README](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md).
- **Ops events catalog**: [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#structured-events-the-ops-seam).
- **Horizon and pruning runbook**: [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#horizon--pruning-operational-guidance).
- **S3 and R2 segment storage with CDN and signed URLs**: [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#segment-storage-on-s3--r2-s3segmentstore).
- **Postgres storage**: [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#postgres-storage-the-production-database-path).
- **Runtime and deployment matrix** (Bun, Node, Cloudflare Workers) and the **admin and console surface**: [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#deployment-matrix-runtime-adapters), [admin surface](https://github.com/syncular/syncular/blob/main/packages/server/README.md#admin--console-surface-syncularadmin).
- **Load tests** (scale and stability lanes): [load/README.md](https://github.com/syncular/syncular/blob/main/load/README.md).
- **Native core C ABI**, the five functions every binding wraps: [FFI README](https://github.com/syncular/syncular/blob/main/rust/crates/ffi/README.md).
- **Bindings doctrine**, what a wrapper must prove: [bindings/README.md](https://github.com/syncular/syncular/blob/main/bindings/README.md).
- **Visual tokens** shared by documentation and developer tools: [STYLE.md](https://github.com/syncular/syncular/blob/main/docs/STYLE.md).
- **Performance record**: [bench/RESULTS.md](https://github.com/syncular/syncular/blob/main/bench/RESULTS.md), summarized at [Benchmarks](/benchmarks/).
