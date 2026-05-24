# WP-03 Binary Apply Performance

Status: `[x]` accepted/superseded by WP-12 scoped artifacts

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

No local WP-03 implementation work remains. Stop spending time on browser
client import-path variants. The rejected probes
in the benchmark log show that adapter bypasses, smaller batches, null-mask
precomputation, nullable-column elision, SQLite `json_each()` import, direct
`sqlite3_carray_bind`, and Rust-backed virtual tables do not beat the current
accepted baseline.

The retained larger architecture experiment is tracked and accepted in
[`WP-12 Scoped Snapshot Artifacts`](WP-12-scoped-snapshot-artifacts.md). Any
future apply-path work must be a new explicit architecture slice, not another
WP-03 micro-probe, and it must fit scoped/CF-worker-compatible sync:

- server-generated SQLite snapshot artifacts are only valid as a gated
  experiment for explicitly precomputed scoped artifacts. Do not make them the
  default bootstrap plan unless they can respect arbitrary per-user scope mixes
  without exploding artifact count or requiring a SQLite engine in the CF worker
  hot path.
- a true lower-level SQLite import path must reduce the number of SQLite bind
  calls without replacing them with per-cell virtual-table callbacks.

Start with the external app-style benchmark before and after the change, then
run the local 100k/500k browser gates if the external result is promising.

Current external baseline after restoring the benchmark stack:

- TS 500k bootstrap: `3415.92ms`.
- Rust 500k bootstrap: `2382.23ms`.
- TS 500k local apply: `1901.25ms`.
- Rust 500k local apply: `422ms`.
- TS local list/search p50: `0.08ms` / `0.06ms`.
- Rust local list/search p50: `0.11ms` / `0.16ms`.
- TS aggregate p50: `5.25ms`.
- Rust read-model aggregate p50: `0.01ms`; raw SQL aggregate p50: `7.25ms`.

Rejected larger import-path probe:

- Columnar JSON import through SQLite `json_each()` was tested and reverted.
  The 500k browser gate timed out during worker close after the apply path
  failed to complete normally, so JSON import should not be the next direction.
- Direct `sqlite3_carray_bind` import was tested and reverted. It compiled and
  built, but the browser runtime failed to load the WASM with an unresolved
  `env` module import once `sqlite3_carray_bind` was referenced. The underlying
  issue is that `sqlite-wasm-rs` exposes the header declaration but does not
  compile SQLite with `SQLITE_ENABLE_CARRAY`, so there is no linked
  implementation in the browser artifact.
- A Rust-backed SQLite virtual table import was tested and reverted. It avoided
  per-cell binds but forced per-cell SQLite virtual-table callbacks into Rust,
  regressing 500k chunk apply from the restored `310ms` band to `410ms`.

Feasibility notes:

- `sqlite-wasm-rs` exposes `sqlite3_serialize`, `sqlite3_deserialize`, and the
  SQLite backup APIs, so browser-side artifact import is technically possible.
- `sqlite-wasm-rs` also exposes `sqlite3_carray_bind`, but `CARRAY_TEXT` is
  `char*` based and does not carry byte lengths. That makes it a poor default
  for arbitrary SQLite text values unless we add strict text constraints or a
  custom length-aware import path.
- The external Docker-based app benchmark stack was restored with
  `orbctl stop && orbctl start`; keep using it as the app-style gate.

Next implementation direction:

- Do not spend more time on JSON import, direct `sqlite3_carray_bind`,
  Rust-backed virtual tables, or small bind-loop changes.
- Prototype a lower-level length-aware import path only if it runs closer to
  SQLite storage than virtual-table callbacks and does not require unsupported
  SQLite compile flags in `sqlite-wasm-rs`.
- Treat SQLite snapshot artifacts as a separate gated experiment only for
  explicitly scoped artifacts; do not optimize for full-partition bootstrap.

## Scoped Artifact Feasibility Review

The current server snapshot path is already shaped correctly for scoped binary
chunks:

- chunk cache keys include partition, effective scopes, schema/cache version,
  encoding, compression, and gzip level.
- persisted chunk metadata includes table, as-of commit seq, row cursor, row
  limit, next row cursor, and last-page state.
- chunk bodies can live in external storage while SQL stores only metadata and
  digests.
- browser Rust clients request `binary-table-v1` and fetch/apply chunk refs
  through the authenticated chunk route.

That is enough for reusable scoped row chunks, but not enough to safely switch
to SQLite database artifacts in this WP. A product-correct SQLite artifact must
be keyed by the exact subscription/table/scope/schema/as-of manifest, must not
represent a whole partition unless the actor is truly eligible for the whole
partition, and must preserve revocation clearing, verified manifests, CRDT/blob
metadata, and resume semantics.

Generating SQLite artifacts inside the normal CF Worker/D1 pull hot path is not
the right shape. It would require a SQLite engine and large transient database
state in the Worker request path. The viable design is a precomputed or
background-generated scoped artifact pipeline backed by object storage, with
HTTP pull remaining the recovery/checkpoint path when an artifact is missing,
expired, or not worth building.

Decision:

- WP-03 should not accept more client-side apply micro-probes.
- Keep the current binary-table direct payload apply as the accepted browser
  client path.
- Move the remaining large-bootstrap performance work to a scoped snapshot
  artifact design/build package before changing protocol or runtime code.
