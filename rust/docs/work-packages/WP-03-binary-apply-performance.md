# WP-03 Binary Apply Performance

Status: `[~]` in progress

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

Stop spending time on small bind-loop/cache tweaks. The rejected probes in the
benchmark log show that adapter bypasses, smaller batches, null-mask
precomputation, and nullable-column elision do not beat the current accepted
baseline.

Next retained attempt should be a larger architecture experiment:

- server-generated SQLite snapshot artifact or attach/import path, or
- a true generated SQLite import path that reduces the number of SQLite bind
  calls rather than just changing how the current bind loop is reached.

Start with the external app-style benchmark before and after the change, then
run the local 100k/500k browser gates if the external result is promising.
