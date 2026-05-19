# WP-02 Protocol Kernel

Status: `[~]` in progress

## Goal

Make `rust/crates/protocol` the real home for shared Rust protocol types,
canonical encoding, hashing, binary codecs, and fixtures before binary v2 grows
the protocol surface again.

## Scope

- Pull/push request and response structs.
- Commit/change records.
- Snapshot chunk metadata and binary chunk decoding.
- Binary sync-pack metadata.
- Blob references.
- Realtime messages.
- Verification metadata.
- Cross-language protocol fixtures.

## Acceptance Criteria

- Runtime imports protocol types/codecs from `syncular-protocol` instead of
  owning duplicate protocol logic.
- TypeScript fixture generation and Rust fixture tests cover JSON and binary
  protocol paths.
- New protocol work has one Rust entry point.
- No old protocol fallback branches are introduced.

## Required Gates

- Protocol / wire format gate.
- TypeScript package typecheck for touched packages.
- WASM check if browser protocol code is touched.

## Accept / Reject Rule

- Retain extraction only when runtime code actually depends on the protocol
  crate and fixture coverage proves TypeScript/Rust compatibility.
- Reject moves that only rename files without reducing duplicated protocol
  ownership.

## Next Action

Inventory protocol-owned structs/codecs still living in runtime/server
packages, then move the smallest complete slice: combined pull/push
request/response structs plus binary sync-pack metadata.
