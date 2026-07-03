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
| §7 | The client outbox |
| §8 | Realtime: deltas, wake-ups, the WebSocket-native sync loop (§8.7) |
| §10 | The error catalog |
| §11 | Canonical JSON debug rendering |

(Sections without an anchor link above are lower in the same document; use your
browser's find.)

## Packages

| Package | What it is | README |
|---|---|---|
| `@syncular-v2/core` | Protocol codecs, shared types, vectors round-trip | in [SPEC.md](../../SPEC.md) |
| `@syncular-v2/server` | `handleSyncRequest` + storage/auth/segment/blob interfaces, realtime hub, pruning, signed URLs | [README](../../packages/server/README.md) |
| `@syncular-v2/server-hono` | Thin Hono adapter mounting the §1.1 routes | [source](../../packages/server-hono/src/index.ts) |
| `@syncular-v2/web-client` | The TS client core on sqlite-wasm/OPFS, worker + transports | [source](../../packages/web-client) |
| `@syncular-v2/typegen` | Migrations + manifest → schema IR → TS module | [README](../../packages/typegen/README.md) |
| `@syncular-v2/conformance` | Implementation-agnostic scenario runner + test doctrine | [README](../../packages/conformance/README.md) |

## Contracts

- **Manifest / IR / SQL subset** — [typegen README](../../packages/typegen/README.md).
- **Ops events catalog** — [server README](../../packages/server/README.md#structured-events-the-ops-seam).
- **Horizon & pruning runbook** — [server README](../../packages/server/README.md#horizon--pruning-operational-guidance).
- **S3/R2 + CDN + signed URLs** — [server README](../../packages/server/README.md#segment-storage-on-s3--r2-s3segmentstore).
- **Postgres storage** — [server README](../../packages/server/README.md#postgres-storage-the-production-database-path).

## Design & roadmap docs

- [REVISE.md](../../REVISE.md) — the v2 thesis, the kill/merge gate, and the direction decisions.
- [TODO.md](../../TODO.md) — the road from here to "done."
- [DESIGN-eviction.md](../../DESIGN-eviction.md) — windowed sync / local eviction (roadmap).
- [bench/RESULTS.md](../../bench/RESULTS.md) — the curated performance record.
