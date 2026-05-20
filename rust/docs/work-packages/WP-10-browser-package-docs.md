# WP-10 Browser Package And Docs

Status: `[~]` needs package-size follow-up

## Goal

Keep the browser package understandable and shippable while documenting the
Rust-first client clearly.

## Scope

- WASM package size measurement.
- Optional feature variants only if measured size wins justify them.
- Browser worker docs.
- Rust client docs section.
- Local project integration instructions.

## Acceptance Criteria

- Package size changes are measured.
- Variant builds are not introduced unless they produce useful shipped-byte
  reductions.
- Docs cover schema generation, Diesel reads, mutations, live queries,
  worker events, CRDT fields, encryption, blobs, and testkit.

## Required Gates

- Browser/WASM build.
- Package size measurement.
- Docs link checks by search where practical.

## Accept / Reject Rule

- Retain package variants only when measured shipped-byte savings justify the
  selection and maintenance complexity.
- Reject compatibility branches or parallel JS-client product paths.
- Docs changes should keep Rust-first docs separate from legacy JS client docs
  unless explicitly describing migration or conceptual continuity.

## Current Evidence

The full Rust/WASM artifact and a smaller core artifact have been measured.
Feature variants remain optional and should be driven by package-size evidence.

The release full Rust-owned SQLite WASM size gate is currently failing:

- Budget: `3,460,301` raw bytes / `1,426,063` gzip bytes.
- Current: `3,491,832` raw bytes / `1,438,491` gzip bytes.
- A detached `c03ed9a1` baseline was already over budget by `20,633` raw bytes
  / `8,468` gzip bytes, so the budget was stale before the latest CRDT recovery
  additions. The retained CRDT recovery work adds about `10,898` raw bytes /
  `3,960` gzip bytes.
- Do not ratchet the budget until WP-10 either reduces size or explicitly
  accepts the current shipped-byte cost with a measured reason.

## Next Action

Investigate package size before the next release-gated browser change. Start
with feature-boundary attribution for CRDT/encryption/blob code paths and remove
unused exported WASM surfaces; only ratchet the budget if the retained features
and measured shipped-byte cost are explicitly accepted.
