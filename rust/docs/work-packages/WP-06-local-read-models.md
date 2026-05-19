# WP-06 Local Read Models

Status: `[ ]` planned

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

## Next Action

Design the minimal generator config for one opt-in read model and prove its
invalidations plus query benchmark before adding broader read-model support.
