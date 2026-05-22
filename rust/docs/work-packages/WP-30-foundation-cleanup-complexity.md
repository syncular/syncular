# WP-30 Foundation Cleanup And Complexity Reduction

Status: `[~] audit and first cleanup slices ready`

## Goal

Reduce Rust-first Syncular complexity before more product surface is added.
This work package is for polishing, deleting unnecessary code, removing aliases
and backwards-compatibility paths, shrinking package/code surface, and
refactoring only where it makes the foundation easier to reason about.

The point is not cosmetic churn. The point is to keep the Rust-first
architecture sharp: one current protocol path where possible, one current
browser/native client direction, explicit platform fallbacks only when they are
real capability differences, and fewer layers that future work has to keep
alive.

## Scope

- Remove old client/package/protocol compatibility branches unless the
  compatibility register records a current exception.
- Remove stale aliases, transitional names, unused exports, dead packages, old
  docs, and generated compatibility shims.
- Refactor duplicated bridge/client/helper code when it reduces actual
  maintenance cost without hiding runtime semantics.
- Revisit current package layout and exports after the Rust-first rewrite,
  especially umbrella packages and deleted legacy dialect/transport packages.
- Keep `COMPATIBILITY_REGISTER.md` accurate: every retained fallback must have a
  reason and removal condition; every removed fallback should move to recently
  removed history if it mattered.
- Use `knip`, Biome, package typechecks, Rust checks, and targeted tests as
  deletion gates.
- Track package size and benchmark impact for browser/WASM/runtime-facing
  cleanup.

## Non-Scope

- No feature work hidden as cleanup.
- No public API compatibility release for old JavaScript Syncular clients.
- No protocol negotiation branch to preserve deleted behavior.
- No broad refactor that changes sync, mutation/outbox, scope, verification,
  encryption, blob, CRDT, lifecycle, or repair semantics without a feature WP.
- No cleanup that touches WP-27+ relay/server work unless the user explicitly
  asks for that scope.
- No deleting generated app examples just because they are large; generated
  fixtures stay when they are conformance evidence.

## Acceptance Criteria

- The active compatibility register has no stale `Remove` or `Temporary` item
  without an explicit next action.
- Removed packages and exports are no longer referenced by docs, package
  manifests, tests, generated output, or examples.
- Public Rust-first package entrypoints are intentional and documented; umbrella
  exports do not reintroduce deleted JS-client paths.
- `knip` has either no relevant dead-code findings or the remaining findings
  are documented as intentional.
- Browser/WASM-facing cleanup records size evidence and keeps the size gate
  green.
- Runtime/protocol cleanup keeps conformance and protocol gates green.
- Each retained cleanup commit is small enough to revert independently.

## Required Gates

Pick the smallest gate that proves each slice:

- Dead exports/package cleanup:
  - `bun run knip`
  - `bunx biome check <changed files>`
  - package-specific `tsgo`
- Browser package or WASM cleanup:
  - `bun run client:test`
  - `bun run client:tsgo`
  - `bun run javascript-bindings:build:wasm`
  - `bun run javascript-bindings:size`
- Runtime/protocol cleanup:
  - `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol`
  - `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test protocol_contract --features native,crdt-yjs,demo-todo-native-fixture`
  - `bun run rust:conformance:fast`
- Package export/docs cleanup:
  - affected package `tsgo`
  - `bun run docs:build` when docs navigation/content changes
- Native binding cleanup:
  - `bun run rust:conformance:native`
  - targeted native packaging command if packaging files change

## Accept / Reject Rule

- Retain cleanup only when it removes real maintenance burden, clarifies the
  public surface, shrinks package/WASM size, or reduces duplicated logic without
  measurable correctness or performance regression.
- Revert cleanup that makes app-facing APIs less clear, weakens runtime
  diagnostics, hides platform capability fallbacks, or causes broad unrelated
  churn.
- Treat every compatibility removal as disruptive by default; do not add
  compatibility aliases to soften the deletion unless the user explicitly asks.
- If a cleanup touches a hot path, record before/after performance or size
  evidence in `BENCHMARK_LOG.md`.

## Current Evidence

Initial audit inputs:

- `COMPATIBILITY_REGISTER.md` still has active cleanup candidates:
  - `json-v1` sync-pack path (`Temporary`);
  - `json-row-frame-v1` snapshot chunks (`Temporary`);
  - migration legacy checksum algorithms (`Decision needed`);
  - console message-auth handshake fallback (`Decision needed`);
  - service-worker `postMessage` fallback (`Decision needed`);
  - external chunk storage inline/database fallback (`Decision needed`);
  - realtime wake-up-only docs (`Remove/update`).
- The working tree already contains cleanup-looking changes around
  `packages/dialect-wa-sqlite`, `packages/transport-ws`,
  `packages/syncular/src/dialect-wa-sqlite.ts`,
  `packages/syncular/src/server-dialect-neon.ts`, and
  `packages/syncular/src/transport-ws.ts`. Treat these as an active local
  workstream from another session unless deliberately adopted and verified.
- `rg` shows many `SyncularV2*` names remain. These are not automatically
  compatibility debt because the current runtime still uses v2 naming in public
  protocol/package contracts. Rename only if a scoped API decision says the
  churn is worth it.
- Accepted platform fallbacks, such as browser OPFS to IndexedDB, are not
  cleanup targets unless diagnostics or gates prove they are hidden or
  duplicative.
- Reference docs contain historical planning material. Archive or prune only
  when the current roadmap and product contract no longer need the history.

## Work Slices

1. Compatibility register closure pass.
   - For each active `Remove`, `Temporary`, or `Decision needed` item, decide:
     remove now, keep as platform capability, keep as test-only fixture, or
     split to a feature WP.
   - Update the register before deleting code.

2. Package surface cleanup.
   - Verify the legacy dialect/transport package removals already present in
     the dirty tree.
   - Remove stale package references from manifests, docs, exports, tests, and
     lockfiles only with targeted gates.

3. Public API alias cleanup.
   - Audit `@syncular/client`, `@syncular/react`, generated TypeScript, native
     bindings, and umbrella `syncular` exports for transitional aliases.
   - Keep canonical Rust-first names; delete old names instead of preserving
     compatibility shims.

4. Protocol/debug fallback cleanup.
   - Separate test/debug encodings from product runtime paths.
   - Remove or quarantine JSON protocol/snapshot paths only when protocol gates
     and conformance prove the current Rust-first path is complete.

5. Documentation and reference pruning.
   - Ensure docs describe current Rust-first behavior.
   - Move stale historical plans out of the active path or mark them clearly as
     reference history.

6. Complexity metrics and recurring gates.
   - Add a repeatable cleanup audit command set if useful: `knip`, targeted
     `rg` queries, package size, and conformance gates.
   - Record accepted deletions and size/perf deltas in `BENCHMARK_LOG.md` when
     runtime/browser-facing.

## Next Action

Start with Slice 1: close the compatibility register items one by one. The
first code slice should be small and obvious, preferably the already-marked
`Remove/update` realtime wake-up-only docs or the legacy package removals
already visible in the dirty worktree, after confirming ownership and gates.
