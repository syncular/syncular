# Reference: spec & package map

The docs are the guide; [`SPEC.md`](../../SPEC.md) is the reference. Normative
text is never duplicated here — this page points into it and into the package
READMEs.

## SPEC.md by section

| Section | Topic |
|---|---|
| [§0](../../SPEC.md#0-deliberate-simplifications-vs-wire-v14--decisions) | Deliberate simplifications vs v1 (the decisions) |
| [§1](../../SPEC.md#1-transport-bindings-and-envelope) | Transport bindings, the SSP2 envelope, framing, streaming, decode vs validation |
| [§2](../../SPEC.md#2-data-model-and-identity) | Commits, changes, versions, idempotency, the schema IR & row codec |
| [§3](../../SPEC.md#3-scopes-and-authorization) | Scopes: patterns, requested/allowed/effective, revocation, write-path authz |
| [§4](../../SPEC.md#4-subscriptions-cursors-pull) | Subscriptions, cursors, pull, the pruning horizon, the bootstrap state machine |
| §5 | Bootstrap segments, the download endpoint, signed URLs, sqlite images, blobs (§5.9) |
| §6 | Push and commit application, conflicts, atomicity |
| §7 | The client outbox, auth leases (§7.3), the schema-bump flow (§7.4) |
| §8 | Realtime: deltas, wake-ups, presence (§8.6), the WebSocket-native sync loop (§8.7) |
| §10 | The error catalog |
| §11 | Canonical JSON debug rendering |

(Sections without an anchor link above are lower in the same document; use your
browser's find.)

## Packages

| Package | What it is | README |
|---|---|---|
| `@syncular/core` | Protocol codecs, shared types, vectors round-trip | in [SPEC.md](../../SPEC.md) |
| `@syncular/server` | `handleSyncRequest` + storage/auth/segment/blob interfaces, realtime hub, pruning, signed URLs | [README](../../packages/server/README.md) |
| `@syncular/server-hono` | Thin Hono adapter mounting the §1.1 routes | [source](../../packages/server-hono/src/index.ts) |
| `@syncular/server-workers` | Cloudflare Workers entry: fetch handler over D1 storage + R2 segments/blobs | [README](../../packages/server-workers/README.md) |
| `@syncular/client` | The TS client core on sqlite-wasm/OPFS, worker + transports, multi-tab | [README](../../packages/web-client/README.md) |
| `@syncular/react` | React bindings: `SyncProvider` + live queries over fine-grained invalidation | [README](../../packages/react/README.md) |
| `@syncular/crdt-yjs` | The Yjs `crdt`-column merger (server) + `YjsColumn` client helper | [source](../../packages/crdt-yjs/src/index.ts) |
| `@syncular/typegen` | Migrations + manifest → schema IR → TS module, `syncular` CLI | [README](../../packages/typegen/README.md) |
| `create-syncular-app` | Scaffolder: `bun create syncular my-app` (`minimal` / `web` templates) | [README](../../packages/create-app/README.md) |
| `@syncular/conformance` | Implementation-agnostic scenario runner + test doctrine | [README](../../packages/conformance/README.md) |

## Contracts

- **Manifest / IR / SQL subset** — [typegen README](../../packages/typegen/README.md).
- **Ops events catalog** — [server README](../../packages/server/README.md#structured-events-the-ops-seam).
- **Horizon & pruning runbook** — [server README](../../packages/server/README.md#horizon--pruning-operational-guidance).
- **S3/R2 + CDN + signed URLs** — [server README](../../packages/server/README.md#segment-storage-on-s3--r2-s3segmentstore).
- **Postgres storage** — [server README](../../packages/server/README.md#postgres-storage-the-production-database-path).
- **Runtime / deployment matrix (Bun/Node, Cloudflare Workers)** — [server README](../../packages/server/README.md#deployment-matrix-runtime-adapters-todo-42).
- **Admin / console surface** — [server README](../../packages/server/README.md#admin--console-surface-syncularadmin).
- **Load-test suite (scale & stability lanes)** — [load/README.md](../../load/README.md).
- **Native core C ABI (Tauri / React Native paths)** — [FFI README](../../rust/crates/ffi/README.md).

## Design & roadmap docs

- [REVISE.md](../../REVISE.md) — the v2 thesis, the kill/merge gate, and the direction decisions.
- [TODO.md](../../TODO.md) — the road from here to "done."
- [DESIGN-eviction.md](../../DESIGN-eviction.md) — windowed sync / local eviction (roadmap).
- [bench/RESULTS.md](../../bench/RESULTS.md) — the curated performance record.
