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
- Generated TypeScript modules now export
  `syncularGeneratedLocalReadModels`, including setup and rebuild SQL, so host
  packages can consume the generated contract instead of carrying hand-written
  derived-schema fixtures.
- Generated read-model output tables are included in the TypeScript Kysely DB
  interface and Rust Diesel schema, but they are not included in app-table
  sync/mutation metadata.
- The todo example declares `taskCountsByUserCompletion`, and its Rust test
  proves rebuild plus update/delete invalidation and typed Diesel read-model
  queries.
- Browser local-query scoreboard now emits raw aggregate and generated
  read-model aggregate lanes for both TS and Rust.
- The generated TypeScript installer now executes read-model setup/rebuild from
  `syncularGeneratedLocalReadModels`, so the exported contract is the installer
  source of truth instead of duplicated generated SQL.
- `syncular.schema.json` now carries each local read model's generated
  `setupSql` and `rebuildSql`, making the SQLite read-model contract available
  to non-TS host tooling without duplicating SQL generation.
- No hidden runtime cache, default index, or compatibility branch was added.

Correctness gates passed:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-codegen
cargo test --manifest-path rust/Cargo.toml -p syncular-todo-app-example generated_local_read_model_sql_rebuilds_and_tracks_changes
bun run --cwd rust/examples/todo-app tsgo
bun run --cwd tests/runtime tsgo
bun run --cwd tests/perf tsgo
```

Benchmark gate:

```bash
bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=1000 --query-iterations=5 --wasm-profile=release --json --output=.context/benchmarks/wp06-read-model-scoreboard-1k.json
bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=100000 --query-iterations=25 --wasm-profile=release --output=.context/benchmarks/wp06-read-model-scoreboard-100k.json
bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=100000 --query-iterations=25 --wasm-profile=release --output=.context/benchmarks/wp06-read-model-installer-contract-100k.json
bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=100000 --query-iterations=25 --wasm-profile=release --output=.context/benchmarks/wp06-schema-json-read-model-sql-100k.json
```

100k local-query results:

| Metric | TS | Rust | Rust/TS |
| --- | ---: | ---: | ---: |
| Bootstrap | `828.69ms` | `221.41ms` | `0.27x` |
| Local list p50 | `0.55ms` | `0.23ms` | `0.42x` |
| Local search p50 | `3.98ms` | `1.51ms` | `0.38x` |
| Raw aggregate p50 | `161.09ms` | `23.00ms` | `0.14x` |
| Read-model aggregate p50 | `0.53ms` | `0.05ms` | `0.09x` |

After switching the installer to consume `syncularGeneratedLocalReadModels`, the
100k browser gate stayed neutral-to-better versus the previous WP-06 browser
run:

| Metric | Previous Rust | Contract-backed installer |
| --- | ---: | ---: |
| Bootstrap | `221.41ms` | `209.01ms` |
| Raw aggregate p50 | `23.00ms` | `22.91ms` |
| Read-model aggregate p50 | `0.05ms` | `0.05ms` |

After adding read-model SQL to `syncular.schema.json`, the 100k browser gate was
again neutral-to-better versus the contract-backed installer run:

| Metric | Previous Rust | Schema SQL contract |
| --- | ---: | ---: |
| Bootstrap | `209.01ms` | `207.08ms` |
| Raw aggregate p50 | `22.91ms` | `21.98ms` |
| Read-model aggregate p50 | `0.05ms` | `0.04ms` |

The browser benchmark proves the declared read model is visible to typed Kysely
and avoids the expensive aggregate scan. It does not yet prove external app
adoption because the external benchmark still carries a hand-written local
derived-schema fixture.

Root `bun run tsgo` was not used as a gate because it currently fails in
unrelated `@syncular/tests-unit` server-pull stream/hash type errors. The
relevant package checks above passed.

## Next Action

Wire the generated read-model declarations into the external benchmark app
instead of the current hand-written `RUST_LOCAL_DERIVED_SCHEMA_STATEMENTS`, then
run the external local-query/bootstrap gates. The target evidence is
aggregate-query speedup with explicit write amplification and no hidden
raw-query regression.
