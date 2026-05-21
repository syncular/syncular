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
- Added native parity for observed-query dependency hints. Native
  `register_query_json` now accepts `dependencyHints` with table, row-id, and
  field metadata. `RowsChanged` still always emits, while `QueriesChanged`
  skips hinted observers only when row/field metadata proves the changed row
  cannot affect the query; table-only or incomplete row metadata keeps the
  conservative notify behavior.
- Added browser live-query diagnostics counters and a Hono/WASM regression that
  proves inferred primary-key hints skip actual reruns under unrelated row
  churn. The diagnostic shape reports per-query `rerunCount`,
  `skippedRerunCount`, and `emittedEventCount`; it does not expose hinted row
  ids.
- Extended scope-revocation coverage: a primary-key hinted browser live query
  now stays subscribed while the server revokes the subscription scope. The
  test proves table-only scoped clearing still reruns and emits the empty query
  result instead of incorrectly trusting row-id hints.
- Extended CRDT materialization coverage: a primary-key hinted browser live
  query now observes a local CRDT text-field write, reruns once for the matching
  row, emits the materialized `title` and `title_yjs_state`, and carries CRDT
  field metadata in `changedRows`.
- Extended blob metadata coverage: a hinted browser live query now stays open
  across a synced BlobRef column update and proves the remote pull emits a
  query refresh with `changedFields` containing `image`.

Native gates:

```bash
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime \
  --test native_facade native_facade_filters_query_observers_with_row_field_hints \
  --features native,crdt-yjs,demo-todo-native-fixture
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime \
  --test native_facade \
  --features native,crdt-yjs,demo-todo-native-fixture
cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features native,crdt-yjs
```

Result: passed. No browser benchmark was rerun for this native-only slice; the
browser guardrail baseline remains
`.context/benchmarks/wp21-live-query-hints-current.json`.

Browser skip-rerun gates:

```bash
bun run tsgo
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
  cargo check --manifest-path rust/Cargo.toml -p syncular-runtime \
  --no-default-features --features web-owned-sqlite \
  --target wasm32-unknown-unknown
bun run --cwd rust/bindings/browser build:wasm:dev
bun test --cwd rust/bindings/browser \
  src/__tests__/sync-hono.wasm.test.ts -t "skips hinted live-query reruns"
bun test --cwd rust/bindings/browser src/database.test.ts -t "live query"
bun test --cwd rust/bindings/browser src/worker-client.test.ts -t "live"
bun run --cwd rust/bindings/browser test
bun test --cwd rust/bindings/browser src/__tests__/sync-hono.wasm.test.ts
bun tests/runtime/scripts/browser-e2e-scoreboard.ts \
  --rows=10000 --incremental-rows=1000 --realtime-iterations=3 \
  --query-iterations=0 \
  --output=.context/benchmarks/wp21-live-query-diagnostics-current.json
```

Result: passed. The guardrail stayed neutral against
`.context/benchmarks/wp21-live-query-hints-current.json`: notify p95 stayed
`1ms`, realtime live p95 moved `127.41ms -> 127.93ms`, and served Rust WASM
bytes moved `2,372,720 -> 2,374,522`.

Scope-revocation gate:

```bash
bun run --cwd rust/bindings/browser tsgo
bun test --cwd rust/bindings/browser \
  src/__tests__/sync-hono.wasm.test.ts -t "clears scoped local rows"
```

Result: passed. No benchmark was rerun for this test-only coverage slice.

CRDT materialization gate:

```bash
bun run --cwd rust/bindings/browser tsgo
bun test --cwd rust/bindings/browser \
  src/__tests__/sync-hono.wasm.test.ts -t "refreshes hinted live queries after CRDT"
```

Result: passed. No benchmark was rerun for this test-only coverage slice.

Blob metadata gate:

```bash
bun run --cwd rust/bindings/browser tsgo
bun test --cwd rust/bindings/browser \
  src/__tests__/sync-hono.wasm.test.ts -t "syncs generated BlobRef"
```

Result: passed. No benchmark was rerun for this test-only coverage slice.

## Next Action

Extend precision coverage to conflict creation and resolution.
