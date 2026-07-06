# Spec & package map

The docs are the guide;
[`SPEC.md`](https://github.com/syncular/syncular/blob/main/SPEC.md) is the
reference. Normative text is never duplicated here — this page points into it,
and maps every published package, crate, and binding to where it lives.

## SPEC.md by section

| Section | Topic |
|---|---|
| [§0](https://github.com/syncular/syncular/blob/main/SPEC.md#0-deliberate-simplifications-vs-wire-v14--decisions) | Deliberate simplifications vs v1 (the decisions) |
| [§1](https://github.com/syncular/syncular/blob/main/SPEC.md#1-transport-bindings-and-envelope) | Transport bindings, the SSP2 envelope, framing, streaming, decode vs validation |
| [§2](https://github.com/syncular/syncular/blob/main/SPEC.md#2-data-model-and-identity) | Commits, changes, versions, idempotency, the schema IR & row codec |
| [§3](https://github.com/syncular/syncular/blob/main/SPEC.md#3-scopes-and-authorization) | Scopes: patterns, requested/allowed/effective, revocation, write-path authz |
| [§4](https://github.com/syncular/syncular/blob/main/SPEC.md#4-subscriptions-cursors-pull) | Subscriptions, cursors, pull, the pruning horizon, the bootstrap state machine |
| [§5](https://github.com/syncular/syncular/blob/main/SPEC.md#5-bootstrap-segments) | Bootstrap segments, the download endpoint, signed URLs, sqlite images, blobs (§5.9), CRDT columns (§5.10) |
| [§6](https://github.com/syncular/syncular/blob/main/SPEC.md#6-push-conflicts-results) | Push and commit application, conflicts, atomicity, write-validation hooks (§6.7) |
| [§7](https://github.com/syncular/syncular/blob/main/SPEC.md#7-offline-writes-and-replay) | The client outbox, auth leases (§7.3), the schema-bump flow (§7.4) |
| [§8](https://github.com/syncular/syncular/blob/main/SPEC.md#8-realtime) | Realtime: deltas, wake-ups, presence (§8.6), the WebSocket-native sync loop (§8.7) |
| [§9](https://github.com/syncular/syncular/blob/main/SPEC.md#9-versioning-and-evolution) | Versioning and evolution |
| [§10](https://github.com/syncular/syncular/blob/main/SPEC.md#10-error-catalog) | The error catalog |
| [§11](https://github.com/syncular/syncular/blob/main/SPEC.md#11-canonical-json-debug-rendering) | Canonical JSON debug rendering |

Appendix A holds the golden vectors; Appendix B the conformance scenario
catalog.

## npm packages

All published under the `@syncular/*` scope (plus the unscoped scaffolder):

| Package | What it is | Source |
|---|---|---|
| `@syncular/core` | Protocol codecs, shared types, the golden-vector round-trip | [packages/core](https://github.com/syncular/syncular/tree/main/packages/core) |
| `@syncular/server` | `handleSyncRequest` + storage/auth/segment/blob interfaces, realtime hub, pruning, signed URLs, `SyncularAdmin` | [packages/server](https://github.com/syncular/syncular/tree/main/packages/server) |
| `@syncular/server-hono` | Thin Hono adapter mounting the §1.1 routes + the static admin page | [packages/server-hono](https://github.com/syncular/syncular/tree/main/packages/server-hono) |
| `@syncular/server-workers` | Cloudflare Workers entry: fetch handler over D1 storage + R2 segments/blobs | [packages/server-workers](https://github.com/syncular/syncular/tree/main/packages/server-workers) |
| `@syncular/client` | The TS client core on sqlite-wasm/OPFS, worker + transports, multi-tab | [packages/web-client](https://github.com/syncular/syncular/tree/main/packages/web-client) |
| `@syncular/react` | React bindings: `SyncProvider` + hooks over fine-grained invalidation | [packages/react](https://github.com/syncular/syncular/tree/main/packages/react) |
| `@syncular/kysely` | The typed READ layer: a Kysely dialect over any syncular host, typed by the generated `Database` interface | [packages/kysely](https://github.com/syncular/syncular/tree/main/packages/kysely) |
| `@syncular/crypto` | Client-side E2EE primitives (symmetric + asymmetric) — see [Encryption](/concepts-encryption/) | [packages/crypto](https://github.com/syncular/syncular/tree/main/packages/crypto) |
| `@syncular/crdt-yjs` | The Yjs `crdt`-column merger (server) + `YjsColumn` client helper — see [CRDT columns](/concepts-crdt/) | [packages/crdt-yjs](https://github.com/syncular/syncular/tree/main/packages/crdt-yjs) |
| `@syncular/typegen` | Migrations + manifest → schema IR → generated modules (TS, Swift, Kotlin, Dart) + named queries; ships the `syncular` CLI | [packages/typegen](https://github.com/syncular/syncular/tree/main/packages/typegen) |
| `@syncular/tauri` | `createTauriSyncClient()` — a `SyncClientLike` over Tauri IPC, paired with the `tauri-plugin-syncular` Rust plugin | [packages/tauri](https://github.com/syncular/syncular/tree/main/packages/tauri) |
| `@syncular/testkit` | App-developer test kit: in-memory server + N real clients in one test file | [packages/testing](https://github.com/syncular/syncular/tree/main/packages/testing) |
| `create-syncular-app` | Scaffolder: `bun create syncular-app my-app` (`minimal` / `web` templates) | [packages/create-app](https://github.com/syncular/syncular/tree/main/packages/create-app) |

Two more live in the repo but are not published to npm:
`@syncular/conformance` (the implementation-agnostic scenario runner + test
doctrine, workspace-private) and `@syncular/react-native` (the TurboModule
binding in
[bindings/react-native](https://github.com/syncular/syncular/tree/main/bindings/react-native),
consumed from the repo today — npm publication is a follow-up).

## crates.io crates

The Rust side, published in dependency order:

| Crate | What it is | Source |
|---|---|---|
| `syncular-ssp2` | The SSP2 wire codec, implemented from SPEC.md alone | [rust/crates/ssp2](https://github.com/syncular/syncular/tree/main/rust/crates/ssp2) |
| `syncular-client` | The Rust client core on rusqlite — the native runtime the bindings host | [rust/crates/client](https://github.com/syncular/syncular/tree/main/rust/crates/client) |
| `syncular-command` | The shared JSON command router over the client core — one command surface for the conformance shim, the FFI core, and the Tauri plugin | [rust/crates/command](https://github.com/syncular/syncular/tree/main/rust/crates/command) |
| `syncular-ffi` | The client core packaged as a C-ABI native library (`rust/ffi.h`) — the shipping runtime for iOS/Android/JVM/desktop | [rust/crates/ffi](https://github.com/syncular/syncular/tree/main/rust/crates/ffi) |

The bare `syncular` crate name is a deprecated placeholder that points at
`syncular-client`.

## Bindings outside npm and crates.io

Each is its own isolated build (gated by its `check.sh`), consumed from the
repo checkout rather than a registry:

| Binding | What it is | How you consume it |
|---|---|---|
| [bindings/swift](https://github.com/syncular/syncular/tree/main/bindings/swift) | `SyncularClient` — an idiomatic Swift wrapper over `syncular-ffi` | A separate SwiftPM package (`Package.swift`); add it as a SwiftPM dependency |
| [bindings/kotlin](https://github.com/syncular/syncular/tree/main/bindings/kotlin) | `SyncularClient` — a Kotlin/JVM wrapper over `syncular-ffi` via FFM (JDK 21+, zero runtime deps beyond the stdlib) | A separate Gradle project; depend on it from your Gradle build |
| [bindings/flutter](https://github.com/syncular/syncular/tree/main/bindings/flutter) | `SyncularClient` — a Dart wrapper over `syncular-ffi` via `dart:ffi` | The `syncular` Dart package at `bindings/flutter/syncular`; add it as a pub path dependency |
| [bindings/tauri](https://github.com/syncular/syncular/tree/main/bindings/tauri) | `tauri-plugin-syncular` — the client core running natively in the Tauri host process | A cargo path/git dependency on `bindings/tauri/plugin`, paired with `@syncular/tauri` in the webview |

## Contracts

- **Manifest / IR / SQL subset / named queries** — [typegen README](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md).
- **Ops events catalog** — [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#structured-events-the-ops-seam).
- **Horizon & pruning runbook** — [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#horizon--pruning-operational-guidance).
- **S3/R2 + CDN + signed URLs** — [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#segment-storage-on-s3--r2-s3segmentstore).
- **Postgres storage** — [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#postgres-storage-the-production-database-path).
- **Runtime / deployment matrix (Bun/Node, Cloudflare Workers)** — [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#deployment-matrix-runtime-adapters-todo-42).
- **Admin / console surface** — [server README](https://github.com/syncular/syncular/blob/main/packages/server/README.md#admin--console-surface-syncularadmin).
- **Load-test suite (scale & stability lanes)** — [load/README.md](https://github.com/syncular/syncular/blob/main/load/README.md).
- **Native core C ABI (the five functions every binding wraps)** — [FFI README](https://github.com/syncular/syncular/blob/main/rust/crates/ffi/README.md).
- **Bindings doctrine (what a wrapper must prove)** — [bindings/README.md](https://github.com/syncular/syncular/blob/main/bindings/README.md).

## Design & roadmap docs

- [ROADMAP.md](https://github.com/syncular/syncular/blob/main/ROADMAP.md) — the strategy blocks, the gap register, and the decided non-goals.
- [TODO.md](https://github.com/syncular/syncular/blob/main/TODO.md) — the live working checklist.
- [DESIGN-eviction.md](https://github.com/syncular/syncular/blob/main/DESIGN-eviction.md) — the windowed-sync / local-eviction design.
- [bench/RESULTS.md](https://github.com/syncular/syncular/blob/main/bench/RESULTS.md) — the curated performance record (summarized at [Benchmarks](/benchmarks/)).

## Where to go next

- [Quickstart](/quickstart/) — the whole shape end to end in five minutes.
- [Protocol & conformance](/guide-conformance/) — how the spec is enforced across cores.
- [Migration guide](/migration/) — coming from 0.1.x.
