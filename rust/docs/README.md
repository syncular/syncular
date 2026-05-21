# Rust Client Docs

This folder is the source of truth for Rust-first Syncular planning and
delivery.

## Operating Docs

- [`ROADMAP.md`](ROADMAP.md): current status, priority queue, and active work
  package, including the autonomous work loop.
- [`CLIENT_PRODUCT_CONTRACT.md`](CLIENT_PRODUCT_CONTRACT.md): product
  capabilities, invariants, and anti-drift checks.
- [`COMPATIBILITY_REGISTER.md`](COMPATIBILITY_REGISTER.md): retained legacy
  paths, fallbacks, aliases, and removal decisions.
- [`QUALITY_GATES.md`](QUALITY_GATES.md): required test and benchmark commands
  by change type.
- [`BENCHMARK_LOG.md`](BENCHMARK_LOG.md): append-only benchmark evidence for
  retained and rejected performance work.
- [`work-packages/`](work-packages/): scoped implementation batches with
  acceptance criteria, gates, and next actions.

## Reference Docs

- [`reference/RUST_CLIENT_COMPLETION_PLAN.md`](reference/RUST_CLIENT_COMPLETION_PLAN.md)
- [`reference/PERFORMANCE_ARCHITECTURE_PLAN.md`](reference/PERFORMANCE_ARCHITECTURE_PLAN.md)
- [`reference/STANDOUT_SYNC_PLAN.md`](reference/STANDOUT_SYNC_PLAN.md)
- [`reference/BINARY_SNAPSHOT_CHUNK_FORMAT.md`](reference/BINARY_SNAPSHOT_CHUNK_FORMAT.md)
- [`reference/GENERATED_CLIENT_API.md`](reference/GENERATED_CLIENT_API.md)
- [`reference/FEATURE_VARIANTS_DECISION.md`](reference/FEATURE_VARIANTS_DECISION.md)
- [`reference/RUNTIME_LIMITS.md`](reference/RUNTIME_LIMITS.md)
- [`reference/SECURITY_PRIVACY_THREAT_MODEL.md`](reference/SECURITY_PRIVACY_THREAT_MODEL.md)
- [`reference/NATIVE_PACKAGING.md`](reference/NATIVE_PACKAGING.md)
- [`reference/LOCAL_PROJECT_INTEGRATION.md`](reference/LOCAL_PROJECT_INTEGRATION.md)
- [`reference/SERVER_EDGE_INVESTIGATION.md`](reference/SERVER_EDGE_INVESTIGATION.md)

Reference docs preserve architecture decisions and investigation details. They
should not be used as the day-to-day status board. If reference material changes
the execution order, update `ROADMAP.md` and the affected work package in the
same commit.
