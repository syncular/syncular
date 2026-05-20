# WP-06 Local Read Models

Status: `[x]` accepted for the initial `countBy` read-model contract

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
- Generated TypeScript modules now also export local index metadata and
  explicit derived-schema phase helpers:
  `ensureSyncularAppIndexes(...)`, `ensureSyncularAppReadModelSetup(...)`, and
  `rebuildSyncularAppReadModels(...)`. The default installer behavior is
  unchanged, but app/benchmark adapters no longer need to reassemble index and
  read-model SQL by hand.
- Generated app creation now supports `schemaInstallMode: 'liveSetup'`. This
  prepares base tables, local indexes, and read-model triggers without running
  read-model rebuild SQL, but it fails if app tables already contain data
  without current generated schema metadata.
- Browser E2E scoreboard now accepts `--rust-schema-install-mode`, so install
  strategies can be measured without local harness edits.
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
- The external `offline-sync-bench` Rust adapter was verified locally against a
  generated Syncular schema contract instead of hand-written read-model SQL.
- No hidden runtime cache, default index, or compatibility branch was added.

Correctness gates passed:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
cargo test --manifest-path rust/Cargo.toml -p syncular-codegen
cargo test --manifest-path rust/Cargo.toml -p syncular-todo-app-example generated_local_read_model_sql_rebuilds_and_tracks_changes
bun run --cwd rust/examples/todo-app tsgo
bun test rust/bindings/browser/src/database.test.ts rust/bindings/browser/src/generated-app-conformance.test.ts
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
and avoids the expensive aggregate scan.

After exporting the derived-schema phase helpers, the 100k release browser
artifact gate stayed in the accepted band. Adding the `liveSetup` install mode
also stayed in band with the default `full` installer path:

| Metric | Previous accepted | Phase helpers | `liveSetup` mode |
| --- | ---: | ---: | ---: |
| Rust bootstrap | `147.84ms` | `146.94ms` | `147.50ms` |
| Rust local list p50 | `0.23ms` | `0.21ms` | `0.23ms` |
| Rust local search p50 | `1.51ms` | `1.40ms` | `1.43ms` |
| Rust raw aggregate p50 | `21.98ms` | `24.42ms` | `24.34ms` |
| Rust read-model aggregate p50 | `0.05ms` | `0.05ms` | `0.05ms` |

External app-style local-query gate after wiring the local
`offline-sync-bench` checkout to generated schema-contract SQL:

```bash
cd /Users/bkniffler/GitHub/sync/offline-sync-bench
bun run --cwd /Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser build:wasm:dev
SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis docker compose -f stacks/syncular/docker-compose.yml up --build -d
SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1 SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis bun run bench:run -- --stack syncular --scenario local-query
SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1 SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis bun run bench:run -- --stack syncular-rust --scenario local-query
SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1 SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis bun run bench:run -- --stack syncular --scenario bootstrap
SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS=1 SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist SYNCULAR_BRANCH_ROOT=/Users/bkniffler/conductor/workspaces/syncular/indianapolis bun run bench:run -- --stack syncular-rust --scenario bootstrap
```

Results:

| Metric | TS | Rust |
| --- | ---: | ---: |
| Local list p50 | `0.21ms` | `0.66ms` |
| Local search p50 | `0.09ms` | `0.88ms` |
| Aggregate p50 | `5.94ms` raw | `0.08ms` read model |
| Rust raw aggregate p50 | n/a | `60.88ms` |
| Rust bootstrap | n/a | `1363.56ms` |

Compared with the earlier dev-WASM external Rust sample, list stayed in band
(`0.67ms -> 0.66ms`), search improved (`0.97ms -> 0.88ms`), read-model
aggregate stayed flat (`0.08ms -> 0.08ms`), and raw aggregate was in the same
band (`60.15ms -> 60.88ms`). This is not comparable to the much faster release
WASM external sample; this run intentionally followed the dev-WASM external
gate command.

External bootstrap gate, 500k rows:

| Metric | TS | Rust |
| --- | ---: | ---: |
| Bootstrap | `4070.84ms` | `6240.52ms` |
| Rust derived schema | n/a | `3269.49ms` |
| Rust local apply | n/a | `1772ms` |
| Rust peak memory | n/a | `700.83MB` |

Compared with the previous dev-WASM row-chunk Rust baseline, bootstrap stayed
in band (`6099.68ms -> 6240.52ms`), derived schema stayed in band
(`3213.03ms -> 3269.49ms`), and local apply stayed in band
(`1692ms -> 1772ms`). This confirms the generated schema-contract wiring did
not materially change the expensive bootstrap shape; it removes hand-written
SQL ownership rather than claiming a bootstrap win.

Root `bun run tsgo` was not used as a gate because it currently fails in
unrelated `@syncular/tests-unit` server-pull stream/hash type errors. The
relevant package checks above passed. The external full `bun run typecheck`
currently fails in existing branch-server package/type drift around server
artifact exports; a targeted `tsc` check for `src/adapters/syncular-rust.ts`
passes.

## Next Action

Initial `countBy` read models, generated derived-schema phase helpers, and the
safe `liveSetup` install mode are accepted. Future read-model work should be a
new scoped WP for additional read-model kinds or for changing bootstrap/install
strategy. External app-style adapters should consume the generated
index/read-model contract rather than carrying local SQL fixtures.
