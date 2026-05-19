# WP-03 Binary Apply Performance

Status: `[ ]` planned

## Goal

Make Rust bootstrap/apply performance win by avoiding generic row decoding and
generic SQLite apply work.

## Current Problem

Binary snapshot decode is no longer the main cost. The remaining hotspot is
local apply into SQLite/WASM and raw aggregate query execution.

## Scope

- Generated table-specific snapshot apply.
- Fixed prepared statements and lower-overhead bind/step loops.
- CRDT table apply strategy.
- Bootstrap memory pressure.
- Server-generated binary chunks in final wire format.

## Acceptance Criteria

- 500k bootstrap/local apply improves against the accepted Rust baseline.
- No hidden app indexes are added to force a benchmark win.
- Generated/direct apply proves a structural improvement before widening
  beyond fixture tables.
- Regressions are reverted unless required for correctness.

## Required Gates

- Browser E2E 100k, 500k, and incremental guardrails.
- External app-style bootstrap/local-query benchmark.
- Runtime/native store tests for changed apply semantics.

## Accept / Reject Rule

- Retain only if local apply, bootstrap, or memory improves against the
  accepted Rust baseline without breaking scoped semantics.
- Revert benchmark-only wins that rely on hidden indexes, skipped metadata, or
  full-partition assumptions.

## Next Action

Continue direct generated apply where it removes row-map/value allocation or
reduces SQLite bind/step overhead, then measure before retaining.
