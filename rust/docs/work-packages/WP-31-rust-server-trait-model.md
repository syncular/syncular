# WP-31 Rust Server Trait Model

Status: `[!]` blocked until Rust edge/relay evidence justifies a server product

## Goal

Design a pure Rust server trait model only if we decide Rust should own app
mutation semantics, sync metadata storage, and server-side system handlers.

## Why

A pure Rust server is a different product from a protocol boundary, relay
validator, edge proxy, or realtime fanout component. It must replace the
current TypeScript server's table-handler, authorization, scope, dialect,
plugin, blob, CRDT, snapshot, realtime, and operational-policy behavior. This
WP keeps that future visible without allowing partial server rewrites to leak
into nearer relay/edge work.

## Scope

- Rust traits equivalent to the current server table-handler model:
  authorization, scope resolution, scope extraction, snapshots, and operation
  application.
- Sync metadata storage traits for commits, changes, cursors, scope cache,
  snapshot chunks, artifacts, blob metadata, and encrypted CRDT system tables.
- Push plugin trait model with deterministic ordering.
- Blob storage and snapshot chunk/artifact storage traits.
- Realtime broadcaster trait model.
- Dialect strategy for SQLite and Postgres before any host framework is chosen.
- Conformance plan against the existing TypeScript server behavior.

## Non-Scope

- No implementation until this WP is explicitly unblocked.
- No Cloudflare Worker port of the Hono route layer.
- No Rust push plugins before the trait/ABI model exists.
- No weakening of handler/subscription/scope semantics.
- No client-side assumptions that every user sees whole partitions.

## Acceptance Criteria

- The trait model can express current `ServerTableHandler` behavior without
  forcing client/server schema identity.
- The model covers system handlers for encrypted CRDT updates/checkpoints,
  blobs, snapshots, artifacts, conflicts, and pruning.
- A conformance matrix maps existing TypeScript server tests to Rust server
  equivalents.
- The implementation plan identifies which current JS/Hono responsibilities
  stay outside the Rust server and why.
- The work remains blocked unless there is an explicit product milestone for a
  Rust server.

## Required Gates

- No implementation gates while blocked.
- When unblocked: server conformance tests, protocol fixture tests, push/pull
  integration tests, blob tests, encrypted CRDT tests, realtime tests, and
  scoped performance benchmarks.

## Accept / Reject Rule

- Retain only as a design WP until the product decision says Rust owns server
  app semantics.
- Reject any partial implementation that duplicates JS server behavior without
  a replacement plan and conformance matrix.
- Reject any design that optimizes for full-partition visibility instead of
  handler/subscription/scope semantics.

## Current Evidence

- Server-edge investigation says a pure Rust server should be a separate plan
  after the Rust client beta and only when Rust should own app mutation
  semantics.
- Current server responsibilities include table handlers, authorization, scope
  resolution and caching, push plugins, snapshot chunking, blobs, realtime,
  pruning, compaction, rate limits, CORS/websocket origin policy,
  OpenAPI/console integration, and dialect-specific SQL behavior.

## Next Action

Keep blocked. Revisit only after WP-27 through WP-30 produce evidence that a
Rust server product is needed rather than a protocol boundary, relay validator,
edge proxy, or realtime fanout component.
