# WP-05 Adaptive Bootstrap

Status: `[~]` started

## Goal

Expose meaningful readiness phases so apps can become usable before full sync
completion.

## Scope

- `criticalReady`, `interactiveReady`, `complete`, and failure states.
- Background resume semantics.
- Worker/native/browser events.
- App-facing docs.

## Acceptance Criteria

- Apps can wait for a small critical dataset without blocking on all data.
- Bootstrap progress is observable without table guessing.
- Full completion and partial readiness are distinct states.

## Required Gates

- Runtime bootstrap tests.
- Browser worker event tests.
- Native binding event tests where touched.

## Accept / Reject Rule

- Retain only if readiness states improve app startup semantics without
  allowing queries to treat incomplete scopes as complete data.
- Revert readiness shortcuts that hide subscription errors, revocation, or
  failed snapshot chunks.

## Current Evidence

Pre-Rust client docs already supported staged bootstrap with
`bootstrapPhase`. The Rust-first runtime needs the same product capability with
native/browser events and worker-owned progress metadata.

Retained first slice:

- `SubscriptionSpec` now carries local-only `bootstrapPhase` across Rust,
  TypeScript, Swift, and Kotlin generated subscription specs.
- Rust native/web pull selection now matches the pre-Rust staged-bootstrap
  rule: only the lowest pending phase starts cold, while ready or currently
  bootstrapping higher phases continue to participate.
- Browser sync results expose per-subscription checkpoint metadata
  (`bootstrapPhase`, `bootstrapState`, `ready`, `phase`, `progressPercent`).
- The browser TypeScript binding builds the aggregate app-facing readiness
  contract (`criticalReady`, `interactiveReady`, `complete`, active phase,
  phase summaries, and pending/ready subscription ids) from generated
  subscriptions plus the latest Rust results. Keeping the aggregate in TS avoids
  growing the Rust WASM artifact.
- Browser worker/realtime now emits `bootstrapChanged` events through the
  normal client event bus.

Correctness gates passed:

```bash
cargo test --manifest-path rust/Cargo.toml -p syncular-runtime bootstrap_phase_tests::staged_pull_selection_matches_subscription_readiness
cargo test --manifest-path rust/Cargo.toml -p syncular-codegen generated_outputs_are_current
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown
cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture
bun run --cwd rust/bindings/browser tsgo
bun test rust/bindings/browser/src/worker-client.test.ts rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/client.test.ts rust/bindings/browser/src/react.test.ts
bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "surfaces server client-id ownership conflicts|SQLite snapshot artifact|corrupted SQLite snapshot artifact|artifact rows when a subscription is revoked"
```

Release WASM package gate passed after moving aggregate readiness calculation
out of Rust:

- raw `3.29 MiB` / budget `3.30 MiB` (`9.7 KiB` headroom)
- gzip `1.36 MiB` / budget `1.36 MiB` (`2.4 KiB` headroom)

Benchmark guard:

- local release 100k scoped artifact bootstrap:
  `147.15ms` vs prior accepted same-shape guard `147.84ms`.
- report:
  `.context/benchmarks/wp05-bootstrap-readiness-100k-artifacts.json`.

## Next Action

Add app-facing docs for staged bootstrap and decide whether native Rust/FFI
should expose an aggregate bootstrap status helper or continue exposing only
phase-aware subscription configuration plus worker events.
