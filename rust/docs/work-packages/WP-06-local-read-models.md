# WP-06 Local Read Models

Status: `[~]` started

## Goal

Support opt-in generated read models for expensive local queries without
turning Syncular into a hidden caching layer.

## Scope

- Generator configuration.
- Read model invalidation and rebuild.
- Migration/install behavior.
- Benchmark proof for selected read models.

## Acceptance Criteria

- Read models are explicit in app schema/config.
- Rebuild and invalidation are deterministic.
- Write amplification is visible and benchmarked.
- Raw query performance regressions are not hidden.

## Required Gates

- Generator tests.
- Browser local-query benchmark.
- External app-style local-query benchmark when relevant.

## Accept / Reject Rule

- Retain only explicit, generated read models declared by app intent.
- Revert hidden caches, default indexes, or projections that improve one
  benchmark while increasing write/apply cost without app opt-in.

## Current Evidence

Aggregate read-model benchmarks showed large wins, while default/example index
experiments regressed bootstrap/apply too much. This WP must prefer explicit
generated projections over implicit cache behavior.

Retained first slice:

- Added explicit `localReadModels` support to `syncular.codegen.json`.
- The first generated read-model kind is `countBy`: source table, output table,
  dimensions, and count column are declared by the app.
- `syncular.schema.json` now carries the local read-model contract so generator
  outputs stay schema-backed.
- Generated Rust migrations now expose `LOCAL_READ_MODELS` SQL constants for
  setup and rebuild.
- Generated TypeScript schema installers create the read-model table/triggers
  and rebuild only when the output table is first installed or the generated
  schema version changes.
- Generated read-model output tables are included in the TypeScript Kysely DB
  interface and Rust Diesel schema, but they are not included in app-table
  sync/mutation metadata.
- The todo example declares `taskCountsByUserCompletion`, and its Rust test
  proves rebuild plus update/delete invalidation and typed Diesel read-model
  queries.
- No hidden runtime cache, default index, or compatibility branch was added.

Correctness gates passed:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-codegen
cargo test --manifest-path rust/Cargo.toml -p syncular-todo-app-example generated_local_read_model_sql_rebuilds_and_tracks_changes
bun run --cwd rust/examples/todo-app tsgo
```

Benchmark gate:

- Not run for this slice because the retained change only adds opt-in generator
  output and fixture coverage. No runtime hot path or external benchmark app
  uses the generated read-model contract yet.

## Next Action

Wire the generated read-model declarations into the browser/external benchmark
app instead of the current hand-written `RUST_LOCAL_DERIVED_SCHEMA_STATEMENTS`,
then run the browser local-query and external local-query/bootstrap gates. The
target evidence is aggregate-query speedup with explicit write amplification
and no hidden raw-query regression.
