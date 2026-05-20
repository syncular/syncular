# WP-10 Browser Package And Docs

Status: `[x]` package-size gate restored

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

The release full Rust-owned SQLite WASM size gate is green again:

- Budget: `3,460,301` raw bytes / `1,426,063` gzip bytes.
- Current retained profile: `3,363,132` raw bytes / `1,383,031` gzip bytes.
- Headroom: `97,169` raw bytes / `43,032` gzip bytes.
- The retained fix is the Rust workspace release profile:
  `lto = true`, `codegen-units = 1`, and `panic = "abort"`.
- A more aggressive `opt-level = "z"` probe produced a much smaller artifact,
  but was not retained because the LTO/default-optimization profile already
  restored the gate with less runtime risk.
- Local release artifact guardrails stayed in band: 100k bootstrap
  `147.16ms`, 500k bootstrap `623.02ms`. External app-style scoped artifact
  sync/apply stayed flat versus the current derived-schema context:
  `sync_total_ms_500000` `439ms -> 441ms`,
  `local_apply_ms_500000` `208ms -> 207ms`.

## Next Action

No immediate WP-10 package-size follow-up is required. Keep running
`bun run --cwd rust/bindings/browser build:wasm` for every browser/WASM-facing
change, and only ratchet the budget with a measured reason.
