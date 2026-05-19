# WP-20 Local Data Hygiene And Repair

Status: `[ ]` planned

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

## Next Action

Define a local health-check result schema and add one runtime test that detects
a corrupted verified root without mutating local rows.
