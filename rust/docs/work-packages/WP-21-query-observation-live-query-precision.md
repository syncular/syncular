# WP-21 Query Observation And Live Query Precision

Status: `[~] started`

## Goal

Improve local read reactivity so apps can observe query results precisely
without app-side table guessing.

## Scope

- Query-level observation for local SQLite reads.
- Dependency tracking for tables, rows, and fields where practical.
- Row/field-level invalidation from sync apply, local mutations, scope clears,
  conflicts, CRDT materialization, and blob metadata updates.
- Browser/native parity for live query event semantics.
- Performance gates for high-churn tables and large local result sets.
- Generated helper integration where it improves ergonomics without replacing
  query-builder-first reads.

## Non-Scope

- Remote sync defined by arbitrary client SQL.
- Hidden read-model caching that changes query semantics.
- Table-specific ORM APIs replacing general query builders.

## Acceptance Criteria

- Apps can subscribe to local query results without manually guessing affected
  tables for common generated-client flows.
- Events are precise enough to avoid broad app-side refreshes for row/field
  changes where the runtime can safely know dependencies.
- Scope revocation, conflicts, CRDT updates, and blob metadata changes notify
  affected queries correctly.
- Browser and native event behavior is semantically aligned.
- Benchmarks prove query observation overhead is bounded for high-churn sync
  apply and realtime lanes.

## Required Gates

- Runtime/native event stream tests.
- Browser worker live-query tests.
- Browser E2E realtime/incremental benchmarks when notification overhead
  changes.
- Generated client smokes if generated query helpers change.

## Accept / Reject Rule

- Retain observation work only if it preserves local SQLite/query-builder
  semantics.
- Reject remote SQL pushdown or hidden caches that conflict with the product
  contract.
- Reject notification shortcuts that make apps refresh whole tables when the
  runtime has precise row/field metadata available.

## Current Evidence

The product contract already says live queries/events must be precise enough to
avoid app-side table guessing. WP-04 also showed realtime notification overhead
is measurable and should stay visible in benchmarks.

First retained slice:

- Added a browser/Hono regression proving a Kysely live query can omit
  explicit `{ tables: [...] }`, infer `tasks` from the compiled query, and
  refresh after a remote row-level sync apply. The emitted live-query event
  carries the affected `changedRows` entry (`table`, `rowId`, `operation`) so
  app code does not need broad table guessing for that path.
- Added optional live-query dependency hints. The browser Kysely dialect now
  infers a row-id hint for simple conjunctive primary-key equality predicates
  and passes it through the worker/raw WASM subscription contract. The
  Rust-owned browser SQLite store uses those hints only when changed-row
  metadata is complete; truncated or table-only changes still rerun the query.
  Disjunctive predicates intentionally do not infer row hints.

## Next Action

Add native parity for row/field dependency hints, then add a focused benchmark
or counter that proves hinted queries skip reruns under unrelated row churn.
