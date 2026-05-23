# Rust Client Product Contract

This document describes the product properties the Rust-first Syncular client
must preserve while we build performance, protocol, bindings, and server-side
features. It is intentionally higher level than a work package.

Use this document as an anti-drift check before starting or accepting
architecture work.

## Core Thesis

Syncular is a server-authoritative sync system for apps that want:

- local SQLite reads with typed query-builder ergonomics;
- synced writes through explicit mutation/outbox semantics;
- per-user scoped access to data;
- realtime updates without losing offline correctness;
- auditable and eventually verifiable replication;
- encrypted fields, blobs, and CRDT document fields as first-class sync data;
- native and browser clients built from the same Rust foundation.

The client is not an ORM, not a generic SQLite wrapper, and not a cache that
happens to sync. SQLite is the local replica and query engine; Syncular owns the
replication, mutation, authorization, conflict, encryption, and event semantics.

## Non-Negotiable Invariants

### Scoped Access Is The Data Model

Every user may have a different mix of scopes. A client must only receive,
store, query as synced data, verify, and live-update rows that are eligible for
that client's current subscriptions and authorization state.

Implications:

- Do not optimize assuming a client owns or receives an entire partition.
- Bootstrap, incremental pull, snapshots, realtime deltas, conflicts,
  verification, and read models must work for arbitrary scope sets.
- Revoked scopes must clear local synced rows and derived state.
- Scope shrink must clear revoked rows without deleting rows still covered by a
  retained scope.
- Scope changes are normal runtime events, not edge cases.
- Server-side indexes and fanout should optimize scope membership and
  subscription delivery, not only partition-wide commit scans.
- Prefer stable access boundaries such as `user_id`, `project_id`, `team_id`,
  and `org_id`. Row-level scopes, time-based scopes, or thousands of scope
  values per actor are stress cases that need explicit design and benchmarks.

### Remote Sync Is Handler And Subscription Based

Clients do not define remote sync with arbitrary SQL or query-builder
predicates. Remote sync is shaped by server-defined table handlers and
client-declared subscriptions containing stable IDs, table names, and scope
values.

Implications:

- Query builders are for local reads over the local replica.
- Pull authorization is `requested scopes ∩ allowed scopes`.
- Server table handlers own snapshot shape, push validation, operation apply,
  scope extraction, and emitted changes.
- Subscription IDs must be stable because they own cursor tracking, local data
  ownership, and revocation matching.
- Performance work should optimize handler/subscription/scope delivery, not
  arbitrary client query pushdown.

### The Server Is Authoritative

The server decides which commits, rows, fields, blobs, and CRDT updates a
client is eligible to receive. The client can reject malformed or inconsistent
responses, but it does not invent authority.

Implications:

- Local writes go to the outbox and become durable server commits only after
  sync acceptance.
- Conflict resolution must preserve server authority and local intent.
- Offline mode can queue work, but it cannot pretend unauthorized data is
  valid after revocation.
- Offline auth leases, if added, must be explicit about what they guarantee
  and what they do not.

### Client And Server Schemas Stay Independent

The server schema models domain authority. The client schema models local UX and
query needs. They may overlap, but they are not required to be identical.

Implications:

- Table handlers bridge server rows, client rows, scopes, snapshots, and
  operations.
- Generated client code should come from app migrations plus Syncular metadata,
  but must not force the server schema to match the local schema.
- Scope metadata required for safe local clearing must exist locally or be
  handled by explicit custom apply/clear logic.

### Querying Is Query-Builder First

Reads should feel like typed SQL query building, not table-specific ORM method
calls.

Implications:

- TypeScript uses Kysely semantics over Rust-owned SQLite.
- Rust uses Diesel canonically for typed reads.
- Swift/Kotlin may use generated DSLs or proven native query builders, but
  they should preserve query-builder semantics.
- Generated table-specific helper methods are acceptable for mutations,
  subscriptions, row delta helpers, and field metadata, not for replacing
  general querying with predefined ORM methods.

### Synced Writes Must Go Through Mutations

Raw app-table `INSERT`, `UPDATE`, and `DELETE` cannot be public synced write
APIs because they bypass outbox, base versions, conflict tracking, encryption,
blobs, CRDT persistence, and row/field event metadata.

Implications:

- Low-level bindings may expose schema-agnostic primitives, but generated app
  clients should expose safe mutations.
- Browser Kysely is a read surface for synced tables.
- Local-only scratch tables must be declared through an explicit non-synced
  allowlist such as `localOnlyTables`; they are installed locally but must not
  receive generated synced mutation/outbox metadata.

### Verification Must Match What The Client Is Allowed To See

Auditable replication is a core goal, but scoped access means a client cannot
verify hidden rows or commits it is not eligible to receive.

Implications:

- Client-side verification should validate the delivered subscription stream,
  snapshot chunks, manifests, and roots.
- Partition-wide or global audit chains may exist server-side, but clients
  should not be required to recompute roots over hidden data.
- If we add stronger non-equivocation or transparency later, it needs signed
  roots, witnesses, gossip, or Merkle proofs with semantics that respect
  authorization.
- Performance optimizations must not remove verification before apply/cursor
  advancement.
- Sync history may be pruned or compacted. Long-lived business or compliance
  audit belongs in app-owned audit tables, linked to Syncular commit metadata
  where useful.

### Realtime Is A Wakeup And Delta Path, Not A Second Sync Model

The pre-Rust client used WebSocket as wake-up only. The Rust-first direction
evolves this into a delta fast path, but it must preserve the same
authorization, ordering, verification, conflict, and retry semantics as normal
sync.

Implications:

- WebSocket deltas are the fast path.
- HTTP pull remains the recovery/checkpoint path.
- Reconnect, overflow, auth refresh, and schema mismatch must produce explicit
  resync/recovery behavior.
- Reconnecting workers must run a catch-up sync so writes committed while the
  websocket was down are recovered.
- Cursor-only or overflow HTTP recovery should be jitterable so a client fleet
  does not stampede the recovery endpoint.
- Server-side direct WebSocket sync-pack size caps are explicit configuration.
  When no binary delta is produced, diagnostics must distinguish that from an
  oversized payload so HTTP recovery is not mistaken for the fast path.
- Server handlers normalize driver-returned version columns before realtime
  binary encoding; Postgres `bigint` strings must not break the delta fast path.
- Apps should not manually babysit websocket reconnect loops.

### CRDT Fields Are Generic Runtime Primitives

Syncular owns durable CRDT field storage and sync mechanics, but editor-specific
adapters stay app-layer.

Implications:

- Core APIs operate on `(table, row_id, field)`.
- Syncular owns Yrs/Yjs update merge, materialization, checkpoints,
  compaction, encryption, persistence, worker coalescing, and convergence
  tests.
- Required-base CRDT diffs must fail with explicit `resyncRequired` recovery
  diagnostics instead of applying partial state. Encrypted update-log fields
  carry the required base inside ciphertext and recover through app/update/
  checkpoint subscription bootstrap.
- Apps own TipTap/ProseMirror schemas, editor bridge messages, derived title or
  preview, save policy, selection, undo, and UI state.

### Performance Work Must Preserve Product Semantics

Benchmarks are mandatory, but a benchmark win is not valid if it optimizes a
scenario that contradicts the product model.

Implications:

- Bootstrap benchmarks must include scoped/subscription-shaped access, not only
  full-partition downloads.
- Local apply benchmarks must include metadata needed for outbox, conflicts,
  encryption, blobs, CRDT fields, live queries, and row/field deltas.
- Read-model or index work must be explicit and generated from app intent, not
  hidden default caching.
- A performance change that weakens correctness needs a design decision before
  it can be retained.

## Capability Map

Status legend:

- `Current`: implemented enough to use or test.
- `Build`: planned or incomplete.
- `Guardrail`: semantic rule that future work must preserve.

| Capability | Current | Build | Guardrail |
| --- | --- | --- | --- |
| Local SQLite replica | Rust-owned SQLite for native/browser; Diesel-backed Rust SDK; browser-owned SQLite/WASM path | Single-writer/read-executor model polish; explicit SQLite pragma baseline everywhere | SQLite is the local replica, not a raw synced write escape hatch |
| Typed reads | Rust Diesel; browser Kysely path; early Swift/Kotlin DSLs | Better Swift/Kotlin ergonomics; shared query-builder semantics | Do not replace query building with predefined ORM-style table methods |
| Mutations/outbox | Generated safe mutations, queued native worker APIs, conflict base-version machinery, bounded/adaptive Rust web outbox push batching | Cleaner conflict ergonomics and generated mutation coverage across all bindings | Synced writes never bypass mutation/outbox semantics |
| Scoped sync | Dynamic subscriptions, scope revocation clearing, auth/client ownership smokes | Subscription indexes, fanout optimization, stronger conformance | Optimize for arbitrary per-user scope mixes, not whole partitions |
| Bootstrap/snapshots | Binary snapshot chunks, manifests, chunk hash validation | Adaptive readiness states, resumable manifests, direct generated apply | Snapshot completeness and verification must be scoped honestly |
| Incremental sync | Push/pull, binary sync packs, persisted cursors, retry metadata | Binary v2, protocol crate extraction, stronger retry wakeups | Cursor advancement only after valid apply/verification |
| Realtime | WebSocket push path, worker events, row/field deltas started | Persistent runtime-owned websocket, verified deltas, replay, overflow recovery | WebSocket is fast path; HTTP remains recovery/checkpoint |
| Verification/audit | Server commit roots, delivered stream verification, persisted verified roots | Lower-overhead root metadata, protocol kernel, stronger proofs later | Clients verify what they are allowed to receive, not hidden data |
| Live queries/events | Native event stream/callbacks, typed live query helpers, row/field metadata | Query-level observation and broader browser/native parity | Events must be precise enough to avoid app-side table guessing |
| Conflicts | Persistence, keep-local/server-win/dismiss paths, generated base versions | Nicer public conflict API and more cross-binding tests | Conflict resolution is part of sync, not app-side ad hoc repair |
| Blobs | Native blob upload/reference sync/retrieval, queued upload processing, blob-specific retry backoff, cache pruning APIs, browser/native blob upload lifecycle stats | Queued blob worker conformance expansion | Blob refs participate in auth, retry, sync, and encryption semantics |
| E2EE | Field-level encryption config, generated helpers, server envelope behavior | Broader conflict/blob/CRDT encrypted coverage | Server may store envelopes; unauthorized readers must not see plaintext |
| CRDT fields | Generic Yrs-backed field primitive, encrypted update logs, checkpoints, materialization | Stream polish, state-vector hints, compaction diagnostics | No editor framework in core; no accidental blank materialization |
| Testkit | Rust testkit helpers, transports, event waiters, stateful server direction | App-ready stateful server and full conformance matrix | Apps should test real Syncular behavior instead of broad mocking |
| Native bindings | C/BoltFFI generated Swift/Kotlin/Java wrappers, local smokes | Real app lifecycle validation, Windows/Linux packaging coverage | Low-level bindings stay schema-agnostic; generated clients are app-level |
| Browser package | Rust/WASM worker package, Kysely dialect path, package size measurement | Package docs and measured optional variants if needed | Do not keep a parallel JS client product path |
| Observability | Timing buckets, event metadata, benchmark scoreboard | Better app-facing diagnostics and audit console surfaces | Every retained perf change needs measured evidence |

## Anti-Drift Checklist

Before accepting a work package, answer these:

1. Does this preserve per-user scoped access, including arbitrary scope mixes?
2. Does this avoid assuming full partition visibility on the client?
3. Does remote sync still use handler/subscription/scope semantics rather than
   arbitrary client query pushdown?
4. Are client/server schemas allowed to stay independent?
5. Are synced writes still forced through mutation/outbox semantics?
6. Does the query API remain query-builder first for local reads?
7. Does verification match the data the client is eligible to receive?
8. Does realtime preserve the same sync semantics as pull recovery?
9. Are CRDT/editor responsibilities kept on the correct side of the boundary?
10. Are benchmarks measuring the product scenario we actually care about?
11. Is any cache/read model/index explicit app intent rather than hidden magic?
12. If this changes public behavior, is the relevant work package and docs
    updated?

## Current Product Direction

Near-term priority:

1. Keep verified scoped replication, but reduce its overhead.
2. Extract the Rust protocol kernel before growing binary v2.
3. Improve binary direct-to-SQLite apply without weakening mutation, conflict,
   encryption, blob, CRDT, event, or scoped-auth semantics.
4. Make websocket deltas a runtime-owned fast path with explicit recovery.

Deferred until the foundation is stable:

- Pure Rust server rewrite.
- Optional package feature variants beyond measured need.
- Strong transparency/non-equivocation claims beyond scoped integrity roots.
- Editor-specific adapters in Syncular core.
