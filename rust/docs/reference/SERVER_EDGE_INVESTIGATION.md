# Rust Server And Edge Investigation

This captures the current WP-11 decision for server-side Rust work. It is not a
new implementation plan for the client foundation.

## Decision

Do not start a Rust Cloudflare Worker replacement for the existing JS/Hono
server yet.

The current server is more than a protocol endpoint. It owns typed table
handlers, app authorization, scope resolution and caching, push plugin ordering,
snapshot chunking, blob upload/download routing, realtime wakeups, pruning,
compaction, rate limiting, CORS/websocket origin policy, OpenAPI/console
integration, and dialect-specific SQL behavior. Rebuilding that for a WASM
Worker would be a large server product, not a small client-side extension.

Rust is still a good fit for a future dedicated server or edge proxy when we
need one of these product reasons:

- Dedicated native/server deployment where one Rust binary owns SQLite,
  Postgres, realtime fanout, and blob storage adapters.
- An edge proxy that terminates auth/rate limit/realtime and forwards the
  existing protocol to the current JS server.
- A high-throughput sync relay that handles connection fanout or websocket
  push, but does not own app table mutation semantics.

## Current JS Server Responsibilities

These are the parts a Rust server would need to match before it can replace the
JS server.

- Protocol routes:
  - `POST /` for combined push and pull.
  - `GET /snapshot-chunks/:chunkId` for externalized snapshot pages.
  - `GET /realtime` for websocket wakeups and websocket push responses.
  - Blob upload initiation, completion, download URL, and direct body transfer.
- App table semantics:
  - `ServerTableHandler` per app table.
  - `resolveScopes`, `extractScopes`, `snapshot`, and `applyOperation`.
  - `authorize` and app-specific operation validation.
  - Conflict generation from expected/base server versions.
- System table semantics:
  - `sync_commits`, `sync_changes`, table commit indexes, client cursors,
    scope cache, snapshot chunks, blob tables, and encrypted CRDT system tables.
  - Encrypted CRDT update/checkpoint handlers are server-side system table
    handlers, not a client-only feature.
- Operational policy:
  - Rate limits and message limits.
  - CORS and websocket origin policy.
  - Console/audit event capture.
  - Prune and compaction scheduling.
  - Multi-instance realtime broadcaster support.

Relevant source anchors:

- `packages/server-hono/src/routes.ts`
- `packages/server-hono/src/create-server.ts`
- `packages/server/src/sync.ts`
- `packages/server/src/push.ts`
- `packages/server/src/pull.ts`
- `packages/server/src/encrypted-crdt.ts`
- `packages/server/src/plugins/types.ts`
- `packages/core/src/schemas/sync.ts`
- `rust/crates/runtime/src/transport/mod.rs`

## Recommended Future Shapes

### 1. Rust Protocol Kernel

Build only the protocol core first, not an HTTP server:

- Shared Rust types for push, pull, commits, changes, snapshot chunks, blobs,
  realtime messages, and error responses.
- Protocol roundtrip tests that reuse `syncular-testkit` fixtures and the same
  JSON examples used by browser/native conformance.
- No app table SQL yet.

This is useful because it can power a Rust server, a Rust edge proxy, and more
strict protocol tests without committing to deployment shape.

### 2. Rust Edge Proxy

Build when the product need is connection/auth/network offload:

- Terminate auth, rate limits, websocket origin checks, and realtime fanout.
- Forward combined sync and blob requests to the existing JS server.
- Preserve protocol bodies byte-for-byte where possible.
- Do not apply app mutations or resolve scopes in the proxy.

This is the smallest server-side Rust product because it avoids reimplementing
the table handler and dialect model.

### 3. Pure Rust Server

Build only when we want Rust to own app mutation semantics:

- Rust traits equivalent to `ServerTableHandler`.
- Rust storage dialects for sync metadata and app tables.
- Scope resolver and cache traits.
- Push plugin traits with deterministic priority ordering.
- Encrypted CRDT system handlers.
- Snapshot chunk storage traits.
- Blob storage traits.
- Realtime broadcaster traits.
- HTTP integration for Axum, Hono-compatible Worker bindings, or another host.

This should be a separate plan and likely a separate milestone after the Rust
client beta.

## What Not To Do Yet

- Do not port the Hono route layer to Rust/WASM just to run on Cloudflare
  Workers. It will still cross JS host APIs for fetch, websocket, storage, and
  database access, and it would duplicate the current maintained server.
- Do not create Rust push plugins before a Rust server trait model exists. The
  current plugin ABI is TypeScript and Kysely-based.
- Do not split the browser WASM package into variants unless feature separation
  removes measured bytes from the shipped `.wasm`.

## Work Package Recommendation

Keep WP-11 server work blocked until there is a concrete product target. If we
do start it, the first local implementation chunk should be `syncular-protocol`
inside `rust/crates/protocol` with JSON compatibility tests against
`packages/core/src/schemas/sync.ts` examples and `syncular-testkit` protocol
builders.

The follow-up sequence is captured as planned work packages:

1. [`WP-27 Rust Relay Protocol Boundary`](../work-packages/WP-27-rust-relay-protocol-boundary.md)
   proves the shared protocol authority for relay/proxy fixtures.
2. [`WP-28 Relay Production Protocol Validation`](../work-packages/WP-28-relay-production-protocol-validation.md)
   can wire that boundary into the existing TypeScript relay path.
3. [`WP-29 Rust Edge Proxy`](../work-packages/WP-29-rust-edge-proxy.md) stays
   blocked until there is a concrete edge/offload product target.
4. [`WP-30 Rust Realtime Fanout`](../work-packages/WP-30-rust-realtime-fanout.md)
   stays blocked until realtime fanout pressure justifies a Rust component.
5. [`WP-31 Rust Server Trait Model`](../work-packages/WP-31-rust-server-trait-model.md)
   stays blocked until we explicitly decide Rust should own app mutation
   semantics.
