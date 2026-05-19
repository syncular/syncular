# Compatibility Register

This register tracks backward-compatibility branches, legacy fallbacks, aliases,
and old-client behavior that could pull the Rust-first architecture away from
the current product direction.

Default policy: prefer disruptive cleanup over compatibility. Do not preserve
old Syncular client, protocol, or generated API behavior unless the user
explicitly asks for a migration release or this file records a narrow temporary
exception.

## Rules

- New compatibility behavior must be recorded here before it is retained.
- Every retained fallback needs an owner/work package, reason, risk, and removal
  condition.
- Protocol transitions should have one current path with clear failures.
- Runtime feature detection is allowed only when it is about platform capability
  rather than old Syncular behavior, and it must be observable.
- Test-only legacy fixtures must stay under tests/benchmarks and must not leak
  into generated app APIs or product docs.

## Status Legend

- `Remove`: should be deleted or replaced when touched.
- `Temporary`: allowed only until the listed removal condition is met.
- `Test-only`: allowed in tests/benchmarks, not product runtime.
- `Accepted`: not backward compatibility debt; keep, but do not confuse with
  old-client support.
- `Decision needed`: needs a product call before implementation.
- `Removed`: deleted from the current branch; retained here only as cleanup
  history.

## Current Items

| Item | Status | Where | Why It Exists | Risk | Removal / Decision |
| --- | --- | --- | --- | --- | --- |
| Old JS client as product path | `Remove` | `packages/client`, old JS client docs under `apps/docs/content/docs/reference/client-sdk/javascript`, legacy dialect docs | Pre-Rust client and documentation still exist in the repo | Agents may keep optimizing or preserving JS behavior instead of Rust-first behavior | Do not add new JS-client compatibility. Archive/delete once Rust docs and package path are the only intended product path |
| JS/wa-sqlite host-store benchmark path | `Test-only` | `tests/runtime/apps/browser/entry.ts`, `tests/runtime/scripts/browser-wasm-vs-js-benchmark.ts`, `packages/dialect-wa-sqlite` docs | Gives TS-vs-Rust performance comparison | Benchmark fixture can be mistaken for supported runtime | Keep only as benchmark/control fixture. Do not expose as generated app runtime |
| JavaScript-hosted browser store bridge | `Test-only` | `rust/crates/runtime/src/web/host_store.rs`, `tests/runtime/apps/browser/web-store-host.ts` | Early browser parity and scaffolding | Maintains two storage mental models if treated as product runtime | Keep only under `web-store` tests/fixtures. Product browser path is Rust-owned SQLite |
| Browser OPFS to IndexedDB fallback | `Accepted` | Browser runtime docs/worker behavior | Platform capability fallback when OPFS sync access handles are unavailable | Can hide slower storage mode if not reported | Keep only if diagnostics report selected storage mode and perf gates cover it |
| `json-v1` sync-pack path | `Temporary` | `packages/core/src/sync-packs.ts`, `rust/crates/protocol/src/binary_sync_pack.rs`, protocol fixtures | Existing JSON sync-pack encoding and fixture coverage | Becomes an old-protocol fallback beside binary path | WP-02/WP-03 should decide current Rust-first path. Do not add more JSON fallback logic for Rust clients |
| `json-row-frame-v1` snapshot chunks | `Temporary` | Server snapshot chunk docs/tests, `rust/crates/runtime/src/core/binary_snapshot.rs` | Existing snapshot chunk format and fixture coverage | Rust bootstrap work may optimize old row-frame path instead of binary-table/direct apply | Rust-first bootstrap should prefer `binary-table-v1` or successor. Keep row-frame only until protocol kernel/binary v2 decision |
| Inline JSON snapshot fallback for binary clients | `Remove` | Historical protocol behavior; should not be reintroduced | Previously allowed small inline snapshots | Violates one-current-path protocol discipline | Already removed for binary clients. Do not reintroduce |
| Decoding older binary sync-pack wire versions | `Removed` | `rust/crates/protocol/src/binary_sync_pack.rs` | Current protocol crate test mutates a fixture to an old version and asserts rejection | None for current users; this is intentional disruptive cleanup | Keep rejecting old versions unless the user explicitly asks for a migration release |
| Migration legacy checksum algorithms | `Decision needed` | `packages/migrations/src/checksum.ts`, migration tests | Pre-existing migration tracking compatibility | Keeps old app migration behavior alive despite no-user/disruptive policy | Decide whether migration package keeps legacy checksum support as non-sync-client compatibility, or remove for Rust-first reset |
| Console message-auth handshake fallback | `Decision needed` | `packages/server-hono/src/console/routes.ts` | Console auth convenience/path fallback | Could normalize fallback auth paths outside Rust-first discipline | Decide separately as console/operator compatibility, not client protocol compatibility |
| Service-worker postMessage fallback | `Decision needed` | `packages/server-service-worker/src/index.ts` | Browser/service-worker capability fallback | Could be valid platform fallback or stale bridge | Keep only if documented as environment fallback and covered by runtime tests |
| External chunk storage inline/database fallback | `Decision needed` | Snapshot chunk storage tests and server storage paths | Allows reading chunk bytes from DB/metadata path when external storage path is unavailable | May blur current snapshot storage contract | Keep only if it is explicit storage-adapter behavior, not protocol fallback |
| Offline-auth `lastActor` fallback | `Decision needed` | `plugins/offline-auth/client` | Offline UX continuity | Could imply auth after revocation if not lease-bound | Resolve under WP-11 offline auth lease model |
| Realtime wake-up-only docs | `Remove/update` | Pre-Rust docs under `apps/docs/content/docs/build/realtime.mdx`, concepts docs | Describes old JS runtime behavior | Conflicts with Rust-first websocket delta direction | Update Rust docs to state delta fast path; old docs should be archived or labeled legacy |

## Recently Removed

| Item | Status | Removed From | Reason |
| --- | --- | --- | --- |
| `apply_local_operation_json` / `enqueue_local_operation_json` aliases | `Removed` | Rust client, native facade, C FFI, BoltFFI bindings, browser runtime low-level APIs, tests/docs | Mutation naming is the canonical low-level write contract. No old generated/native callers are preserved |
| `actorScopeColumn` / `projectScopeColumn` codegen config fields | `Removed` | `rust/crates/codegen/src/main.rs` | Explicit named scopes are the only config model. Codegen now rejects unknown keys instead of carrying deprecated fields |
| Server Hono legacy sync CORS shape | `Removed` | `packages/server-hono/src/routes.ts` | Hono-style `cors: origin` / `cors: { origin }` is the single sync route CORS contract |
| Per-commit pull integrity fields | `Removed` | `SyncCommit` TS/Rust contract and `binary-sync-pack-v1` wire v13 | Pull integrity now lives on subscription-level metadata. The current path does not carry `partitionId`, `previousChainRoot`, `commitDigest`, or `commitChainRoot` on every commit |
| Browser SQLite artifact JSON materialization path | `Removed` | `rust/crates/runtime/src/web/client.rs`, `rust/crates/runtime/src/web/sqlite_wasm_store.rs` | Browser artifacts are now requested only for direct apply modes. Pull modes needing changed rows, returned snapshot rows, field encryption, or encrypted CRDT transforms use snapshot chunks instead of a browser artifact-to-JSON branch |

## Items That Are Not Compatibility Debt

- `v1` in current protocol names such as `binary-sync-pack-v1`,
  `binary-table-v1`, `native-event-stream-json-v1`, encryption envelope v1, or
  Yjs update v1 is a current format/version label, not automatic legacy
  support.
- S3-compatible, SQLite-compatible, or Cloudflare `compatibility_date` wording is
  ecosystem compatibility, not old Syncular protocol compatibility.
- Numeric/default fallbacks in benchmark scripts, load tests, pruning
  `fallbackMaxAgeMs`, or CLI parsing are not backward-compatibility branches.

## Required Review When Touching Compatibility

Before retaining or adding a compatibility path:

1. Is it supporting old Syncular behavior, or is it a platform capability
   fallback?
2. Can we delete it because there are no production users yet?
3. If retained, which WP owns it?
4. What breaks if it is removed?
5. Is the fallback observable in diagnostics/tests?
6. What is the removal condition?
