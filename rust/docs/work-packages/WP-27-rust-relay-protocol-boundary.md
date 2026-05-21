# WP-27 Rust Relay Protocol Boundary

Status: `[ ]` planned

## Goal

Make `syncular-protocol` the shared protocol authority for future relay and
edge work without moving app table semantics, authorization, or local relay
storage into Rust.

## Why

Relay sits between clients and the main server, so protocol drift is especially
risky there. The Rust client already depends on `syncular-protocol` for wire
types, binary codecs, integrity helpers, blob references, snapshot metadata,
and realtime message shapes. This WP proves those same protocol rules are
usable by relay/proxy code before any production relay behavior changes.

## Scope

- Relay/proxy fixture set for combined push/pull, binary sync packs, snapshot
  chunks, scoped snapshot artifacts, blob refs, auth lease provenance, and
  realtime push/presence/sync messages.
- Pure Rust validation/parsing helpers in `syncular-protocol` when current
  APIs are too client-shaped for relay/proxy use.
- Cross-language parity tests where TypeScript-generated fixtures pass Rust
  protocol validation, and Rust canonical examples pass TypeScript schema
  validation.
- Clear failure behavior for unsupported or stale protocol shapes.

## Non-Scope

- No Rust relay server.
- No Rust edge proxy.
- No Rust `ServerTableHandler` equivalent.
- No Rust scope resolver or app authorization.
- No Rust mutation application for relay-local app tables.
- No compatibility branch for old Syncular protocol shapes.

## Acceptance Criteria

- Relay-relevant protocol fixtures are validated by `syncular-protocol`.
- TypeScript schema tests cover Rust-generated canonical examples.
- Rust tests cover TypeScript-generated combined sync, binary sync-pack,
  snapshot artifact, blob, auth lease, and realtime examples.
- Unsupported protocol versions fail clearly instead of falling back.
- The runtime and relay packages do not gain duplicate protocol ownership.

## Required Gates

- `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`
- TypeScript protocol fixture tests in `packages/core`
- Relay tests in `packages/relay` when relay fixtures are touched
- `bun run --cwd packages/core tsgo`

## Accept / Reject Rule

- Retain only protocol-boundary helpers that are storage-free, transport-free,
  and useful to more than one future relay/proxy/server-edge path.
- Reject extraction that only renames TypeScript behavior or introduces a
  second source of protocol truth.
- Reject compatibility aliases or negotiated legacy protocol branches unless
  the compatibility register records a current exception first.

## Current Evidence

- WP-02 accepted `syncular-protocol` as the owner of shared wire structs,
  binary sync-pack and snapshot decoding, integrity helpers, blob validation,
  realtime message shapes, and snapshot chunk/artifact validation.
- WP-11 deferred Rust server/proxy work until a concrete product target exists.
- `packages/relay` is still TypeScript/Kysely/server-handler based.

## Next Action

Create the relay/proxy fixture set and wire the first Rust/TypeScript parity
tests around current combined sync and realtime examples.
