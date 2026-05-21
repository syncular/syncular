# WP-20 Local Data Hygiene And Repair

Status: `[~] started`

## Goal

Provide explicit, fail-closed tools for checking, explaining, and repairing
corrupted or stale local replicas.

## Scope

- Verified reset and rebootstrap flows.
- Local integrity checks for schema state, cursors, verified roots, outbox,
  conflicts, blobs, CRDT metadata, and synced rows.
- Orphaned row detection for scoped ownership and revocation clearing.
- Cursor/root repair rules that never trust unverified data.
- Debug-only export/import for support and reproduction with redaction.
- App-facing "repair sync state" API with clear outcomes and diagnostics.

## Non-Scope

- Silent local repair during normal sync.
- Rewriting server sync history.
- Compatibility fallback paths for old client/protocol behavior.
- Repairing unauthorized data after revocation.

## Acceptance Criteria

- Clients can run an explicit local health check and receive stable findings.
- Reset/rebootstrap clears only the correct local synced state and preserves
  app-owned local-only data where explicitly allowed.
- Repair operations are observable through WP-13 diagnostics and WP-15 errors.
- Corrupted local roots, stale cursors, orphaned rows, broken blob refs, and
  CRDT materialization hazards have explicit outcomes.
- Tests prove repair does not advance cursors without verified server data.

## Required Gates

- Runtime/native store tests for health check, reset, and repair flows.
- Browser/WASM tests for worker-owned SQLite repair behavior.
- CRDT/blob tests where metadata repair changes.
- Console or diagnostics tests if repair evidence is exposed to support tools.

## Accept / Reject Rule

- Retain only explicit repair tools with clear user/app intent.
- Reject background repairs that hide corruption or create unverified local
  state.
- Reject repair paths that preserve legacy behavior as fallback without a
  compatibility-register entry.

## Current Evidence

The roadmap already has verified roots, scoped revocation clearing, artifacts,
outbox/conflict metadata, blobs, and CRDT system tables. Those pieces need a
supportable local hygiene story once apps run Syncular in production.

First retained slice:

- Added a stable `LocalHealthReport` / `LocalHealthFinding` schema in the Rust
  runtime.
- Added `local_health_check()` and `local_health_check_json()` on the Rust
  client, plus `localHealthCheckJson()` through the native BoltFFI
  Swift/Kotlin/Java surface.
- Current checks are read-only and cover configured subscription state JSON,
  cursor sentinel validity, table mismatches, verified-root shape, negative root
  commit sequences, roots ahead of cursors, and roots without stored
  subscription state.
- The health report does not echo raw scope JSON or invalid root values.
- Runtime coverage proves a corrupted persisted verified root is reported with
  `repairAction: "forceRebootstrap"` without mutating an existing local app
  row.
- The second retained slice teaches native stores to enumerate persisted
  subscription states and verified roots. The health check now reports orphaned
  subscription state and orphaned verified roots with
  `repairAction: "clearOrphanedState"` without clearing data implicitly.
- The third retained slice adds app-schema, outbox, and conflict findings:
  future/stale local app schema state, outbox commits written by newer
  generated clients, failed outbox commits, and unresolved conflicts. These
  remain report-only and use `manualInspection` where automated repair would be
  unsafe.
- The fourth retained slice adds blob and CRDT findings: invalid blob refs in
  app rows, failed blob uploads, and CRDT document metadata pointing at missing
  app rows. These findings are still read-only and deliberately do not prune or
  rewrite metadata.
- The fifth retained slice adds explicit repair commands for safe cases:
  `clearOrphanedState` deletes only unconfigured subscription/root metadata, and
  `forceRebootstrap` deletes state/root metadata only for explicitly named
  configured subscriptions. Manual-inspection findings remain non-repairable.
  Runtime coverage proves both repairs leave app rows intact and return a clean
  health report afterward.
- The sixth retained slice brings the same health/repair contract to the
  browser-owned SQLite client and TypeScript worker API:
  `localHealthCheck()` returns the canonical `LocalHealthReport` shape, and
  `repairLocalHealth()` exposes explicit `forceRebootstrap` /
  `clearOrphanedState` repairs. The web store now enumerates raw subscription
  state and verified-root records so malformed local metadata is reported
  instead of failing during parsing. Browser health summaries also cover app
  schema state, outbox summaries, unresolved conflicts, blob reference/upload
  counts, and CRDT document/update-log hazards where those features are present.
  WASM coverage proves configured corrupt roots and orphaned subscription/root
  metadata can be repaired without mutating app rows. The shared clock helper is
  now platform-aware so health reports do not call unsupported native time APIs
  in WASM.
- The seventh retained slice adds an explicit reset/rebootstrap API:
  `reset_local_sync_state_json()` for Rust/native hosts and
  `resetLocalSyncState()` for browser worker clients. The reset clears
  subscription sync metadata and verified roots for selected configured
  subscriptions. Optional `clearSyncedRows` deletes only generated app rows with
  a positive server-version column in the selected scopes, preserves local-only
  rows with `server_version = 0`, rejects unknown subscription ids, and fails
  closed when any local outbox commit is not `acked`. Browser worker reset calls
  drain live-query refreshes and update lifecycle state after rows are cleared.
  BoltFFI Swift/Kotlin/Java bindings now expose the same low-level JSON reset
  method. Runtime and WASM coverage prove pending outbox commits block row
  clearing, acked outbox state permits reset, synced rows are removed, local-only
  rows survive, and the follow-up health report is clean.
- The eighth retained slice adds report-only scoped synced-row health checks.
  Local health now counts server-synced generated app rows and reports
  `local.synced_rows_orphaned` when rows with positive server-version values are
  no longer covered by any configured subscription scope. Local-only rows with
  `server_version = 0` are not counted as orphaned synced rows. Diesel, the
  rusqlite fixture, WebMemoryStore, and Rust-owned browser SQLite all share the
  same metadata-driven scope semantics, including array scopes and fail-closed
  unknown/missing required scopes. Runtime and browser tests prove orphaned
  synced rows are detected without mutating those rows.
- The ninth retained slice adds the explicit `clearOrphanedSyncedRows` repair
  action. It refuses `subscriptionIds`, accepts optional generated app
  `tables`, fails closed while any local outbox commit is unresolved, deletes
  only positive-server-version rows outside all current configured scopes, and
  leaves local-only rows intact. Browser repairs run inside the apply batch and
  notify live-query/lifecycle listeners when rows are cleared. Native and
  browser tests prove pending outbox commits block the repair and acked outbox
  state permits deterministic deletion.

Gates:

- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends local_health_check_reports_corrupted_verified_root_without_mutating_rows --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends local_health_check --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_binding_scaffold --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings`
- `CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features web-owned-sqlite --target wasm32-unknown-unknown`
- `bun run build:wasm:dev`
- `bun test src/__tests__/sync-hono.wasm.test.ts -t "reports and safely repairs browser local health findings"`
- `bun test src/__tests__/sync-hono.wasm.test.ts -t "reports browser synced app rows outside configured subscription scopes"`
- `bun test src/__tests__/sync-hono.wasm.test.ts -t "resets browser sync state while preserving local-only app rows"`
- `bun test src/__tests__/sync-hono.wasm.test.ts`
- `bun run test`
- `bun run tsgo`

## Next Action

Add debug-only local support export/import with redaction, then revisit whether
blob/CRDT orphan metadata should get similarly explicit repair commands or stay
manual-inspection only.
