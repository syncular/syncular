# WP-28 Relay Production Protocol Validation

Status: `[ ]` planned, depends on WP-27

## Goal

Use the Rust protocol boundary in the existing TypeScript relay path to validate
relay-facing protocol traffic before forwarding or serving it, while keeping
relay app semantics in the current TypeScript/Kysely server model.

## Why

WP-27 proves the Rust protocol boundary in tests. This WP is the first
production-facing use of that boundary: relay can reject malformed binary
sync-packs, snapshot artifact references, blob metadata, auth lease provenance,
and realtime frames with the same rules used by Rust clients.

## Scope

- Add an internal relay protocol-validation layer that calls the Rust protocol
  validator through the smallest practical boundary.
- Validate upstream responses from the main server before relay-local apply.
- Validate local-client requests before relay forwarding or local relay server
  handling when validation can be done without consuming app semantics.
- Emit relay diagnostics for protocol validation failures.
- Keep protocol-body forwarding byte-for-byte where the relay is operating as a
  proxy rather than a semantic server.

## Non-Scope

- No relay rewrite in Rust.
- No replacement for `ForwardEngine`, `PullEngine`, `SequenceMapper`, or relay
  Kysely storage.
- No Rust table handlers, scope resolution, conflict generation, or mutation
  application.
- No fallback from failed Rust validation to legacy TypeScript protocol
  acceptance.

## Acceptance Criteria

- Relay can validate current combined sync and realtime protocol fixtures
  through the Rust boundary.
- Relay rejects malformed binary sync-pack, snapshot artifact, blob, and
  realtime fixtures with stable diagnostics.
- Valid relay flows remain behaviorally unchanged in the existing relay tests.
- Validation failures are observable in logs/events without leaking row payloads
  or secret material.
- Any runtime cost is measured on the relay tests or a targeted relay
  benchmark before the validation path is retained.

## Required Gates

- WP-27 gates.
- `bun test packages/relay`
- `bun run --cwd packages/relay tsgo`
- Server/Hono realtime tests if relay websocket handling is touched.
- Targeted relay validation benchmark if validation is placed on a hot path.

## Accept / Reject Rule

- Retain only if validation strengthens relay correctness without changing app
  authorization or mutation semantics.
- Reject if the boundary forces JSON materialization on a binary hot path
  without a measured reason.
- Reject if production relay behavior gains a compatibility fallback around the
  current protocol.

## Current Evidence

- Relay currently imports protocol and server types from TypeScript packages.
- Server-edge docs recommend starting with the protocol boundary before any
  Rust edge/proxy product.

## Next Action

After WP-27, choose the lowest-risk call boundary for relay validation and add
one production relay validation path behind normal tests.
