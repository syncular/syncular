# WP-10 Browser Package And Docs

Status: `[ ]` planned

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

## Next Action

After the next runtime/API slice, update the Rust-client docs for the actual
current API and rerun package-size measurement if dependencies changed.
