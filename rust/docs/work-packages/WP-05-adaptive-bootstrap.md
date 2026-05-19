# WP-05 Adaptive Bootstrap

Status: `[ ]` planned

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

## Next Action

Define the stable readiness event shape first, then wire one browser/native
bootstrap test that distinguishes `criticalReady`, `interactiveReady`, and
`complete`.
