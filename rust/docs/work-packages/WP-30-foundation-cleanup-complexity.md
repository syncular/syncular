# WP-30 Foundation Cleanup And Complexity Reduction

Status: `[~] package-surface cleanup in progress`

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
- The first package-surface cleanup slice adopted and verified the dirty-tree
  deletions of `packages/dialect-wa-sqlite`, `packages/transport-ws`,
  `packages/syncular/src/dialect-wa-sqlite.ts`,
  `packages/syncular/src/server-dialect-neon.ts`, and
  `packages/syncular/src/transport-ws.ts`.
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

Continue Slice 1: close the remaining compatibility register items one by one.
Next candidates are the temporary JSON protocol/snapshot paths, but those
should only move under WP-02/WP-03/WP-30 if protocol/conformance gates prove the
current Rust-first path no longer needs them.

## Progress

- Created WP-30 and made it the active cleanup track in the roadmap.
- Closed the `Realtime wake-up-only docs` compatibility-register item. Current
  docs now describe WebSocket realtime as a verified sync-pack delta fast path
  with HTTP pull as the recovery/checkpoint path, instead of claiming websocket
  carries no data.
- Gate: `bun run docs:build` passed. `bunx biome check <changed md/mdx>` was
  attempted, but Biome ignores these Markdown/MDX paths in this repo.
- Removed the old browser wa-sqlite dialect package, old TypeScript websocket
  transport package, and umbrella subpaths:
  `syncular/dialect-wa-sqlite`, `syncular/transport-ws`, and
  `syncular/server-dialect-neon`.
- Kept the umbrella root import narrow: `syncular` re-exports
  `@syncular/core`; runtime-specific helpers stay on explicit `syncular/*`
  subpaths instead of broad root re-exports.
- Updated docs, package READMEs, package manifests, lockfile, and package-table
  guidance to point browser users at the Rust-owned `@syncular/client` and
  Neon users at `server-dialect-postgres`.
- Gates:
  - `bun install --lockfile-only`: passed.
  - `bunx biome check <changed ts/json/md/mdx>`: passed for checked TS/JSON
    files; Markdown/MDX paths are ignored by Biome in this repo.
  - `bun --cwd packages/syncular tsgo`: passed.
  - `bun --cwd packages/ui tsgo`: passed.
  - `bun --cwd packages/client tsgo`: passed.
  - `bun --cwd packages/client-tauri tsgo`: passed.
  - `bun --cwd packages/client-react-native tsgo`: passed.
  - `bun --cwd packages/server-hono tsgo`: passed.
  - `bun --cwd packages/client test`: passed, `110` tests.
  - `bun run docs:build`: passed.
  - Targeted `bunx knip --workspace ...`: passed for changed workspaces.
  - Full `bun run knip`: blocked by pre-existing WP-27+ relay unused-export
    findings; this slice did not touch relay work.
  - `rg` cleanup checks found no active references to deleted wa-sqlite /
    transport-ws packages or deleted umbrella subpaths outside this WP and the
    compatibility register.
- Removed the legacy migration source-checksum algorithm and the tracking-table
  upgrade branch that added `checksum_algorithm` with a `legacy_source_v1`
  default. Migration state now only supports generated `sql_trace_v1`
  checksums or disabled checksums.
- Gates:
  - `bunx biome check packages/migrations/src/checksum.ts packages/migrations/src/runner.ts packages/migrations/src/tracking.ts packages/migrations/src/types.ts tests/unit/migrations.test.ts`: passed.
  - `bun --cwd packages/migrations tsgo`: passed.
  - `bun test tests/unit/migrations.test.ts tests/typegen/generate.test.ts`:
    passed, `44` tests.
  - `bunx knip --workspace packages/migrations --workspace packages/typegen`:
    passed.
  - `rg` found no remaining legacy checksum symbols outside this WP and the
    compatibility register.
- Reclassified Console WebSocket first-message auth as an accepted platform
  capability, not old-client compatibility: browser WebSocket cannot set custom
  `Authorization` headers, and putting bearer tokens in query strings would be
  worse. Updated the misleading server route comment from "fallback" to
  explicit browser WebSocket auth behavior.
- Gates:
  - `bunx biome check packages/server-hono/src/console/routes.ts rust/docs/COMPATIBILITY_REGISTER.md rust/docs/work-packages/WP-30-foundation-cleanup-complexity.md rust/docs/ROADMAP.md`: passed for the checked TypeScript file; Markdown paths are ignored by Biome in this repo.
  - `bun --cwd packages/server-hono tsgo`: passed.
  - `bun test packages/server-hono/src/__tests__/console-gateway-live-routes.test.ts packages/server-hono/src/__tests__/console-routes.test.ts`:
    passed, `39` tests.
- Reclassified service-worker client `postMessage` wake delivery as an accepted
  browser/service-worker platform fallback when `BroadcastChannel` is
  unavailable or fails. Added explicit tests for both BroadcastChannel delivery
  and client `postMessage` delivery.
- Removed service-worker wake parsing for legacy single-commit
  `push.operations` / `push.status` shapes; wake resolution now follows the
  current batched `push.commits` request/response shape only.
- Gates:
  - `bunx biome check packages/server-service-worker/src/index.ts packages/server-service-worker/src/index.test.ts`: passed.
  - `bun --cwd packages/server-service-worker tsgo`: passed.
  - `bun test packages/server-service-worker/src/index.test.ts`: passed, `10`
    tests.
- Reclassified database-inline snapshot chunk bodies as an accepted explicit
  storage mode, not an external-storage fallback. External chunk reads already
  fail closed when the external body is missing; tests now describe that
  contract directly instead of calling it an inline fallback.
- Gates:
  - `bunx biome check tests/unit/external-chunk-storage-integration.test.ts rust/docs/COMPATIBILITY_REGISTER.md rust/docs/work-packages/WP-30-foundation-cleanup-complexity.md rust/docs/ROADMAP.md`: passed for the checked TypeScript file; Markdown paths are ignored by Biome in this repo.
  - `bun --cwd packages/server tsgo && bun --cwd packages/server-hono tsgo`:
    passed.
  - `bun test tests/unit/external-chunk-storage-integration.test.ts packages/server-hono/src/__tests__/pull-chunk-storage.test.ts`:
    passed, `17` tests.
- Moved stale already-removed protocol rows (`Inline JSON snapshot fallback for
  binary clients`, older binary sync-pack wire decoding) out of Current Items
  and into Recently Removed so the register's active section only contains live
  decisions.
- Removed the unused `SyncularRustOwnedSqliteClientConfig` browser low-level
  store alias and renamed the low-level executor/live-query helper types to the
  canonical `SyncularRustOwned*` naming.
- Gates:
  - `bunx biome check packages/client/src/rust-store.ts`: passed.
  - `bun --cwd packages/client tsgo`: passed.
  - `bun --cwd packages/client test`: passed, `110` tests.
- Removed the old `accept-server` conflict-resolution spelling from the
  TypeScript public type and Rust serde alias. `keep-server` is the canonical
  value.
- Tightened the browser conflict-resolution type to the three runtime-supported
  values: `keep-local`, `keep-server`, and `dismiss`.
- Removed the old JavaScript-hosted browser store bridge (`web-store`,
  `WebHostStore`, and `SyncularWasmClient`). Browser WASM now exposes only the
  Rust-owned SQLite runtime surface.
- Removed native realtime lifecycle `start` / `stop` aliases from the Rust
  native facade, C FFI, and BoltFFI Swift/Kotlin/Java bindings. Host code now
  uses the explicit `start_realtime_worker` / `stop_realtime_worker` API.
- Removed unused browser client event type aliases
  (`SyncularClientEventType`, `SyncularClientEventMap`) so callers use the
  canonical `SyncularV2ClientEventType` / `SyncularV2ClientEventMap` names.
- Removed unused browser worker response type aliases
  (`SyncularV2WorkerRuntimeInfoResponse`,
  `SyncularV2WorkerTransportStatsResponse`) so the worker protocol exports only
  concrete message shapes plus canonical runtime data types.
- Gates:
  - `bunx biome check packages/client/src/client.ts`: passed.
  - `bunx biome check packages/client/src/worker-protocol.ts`: passed.
  - `bun --cwd packages/client tsgo`: passed.
  - `bun --cwd packages/client test`: passed, `110` tests.
- Native alias gates:
  - `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_facade`:
    passed, `38` tests.
  - `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_header`:
    passed, `2` tests.
  - `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_binding_scaffold --features native,boltffi-bindings,crdt-yjs,demo-todo-native-fixture`:
    passed, `4` tests.
  - `bun run rust:conformance:native`: passed, covering Swift/Kotlin generated
    clients, BoltFFI host wrappers, lifecycle smokes, JVM native packaging, and
    native server sync.
- While running the broad runtime gate, fixed stale Rust classifier mappings for
  auth-lease server errors so the runtime matches the shared core error taxonomy
  fixture.
- While running the broad runtime gate, updated the checked-in C header for
  native FFI exports that already existed in Rust but were missing from the
  header artifact.
- While running the broad runtime gate, tightened the native facade lifecycle
  test to tolerate startup diagnostic events before the initial sync-completed
  event.
- Removed the `@syncular/client-expo` alias package. Apps should use the
  canonical `@syncular/client-react-native` bridge rather than package aliases.
