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

## Current Items

| Item | Status | Where | Why It Exists | Risk | Removal / Decision |
| --- | --- | --- | --- | --- | --- |
| Old JS client as product path | `Remove` | `packages/client`, old JS client docs under `apps/docs/content/docs/reference/client-sdk/javascript`, legacy dialect docs | Pre-Rust client and documentation still exist in the repo | Agents may keep optimizing or preserving JS behavior instead of Rust-first behavior | Do not add new JS-client compatibility. Archive/delete once Rust docs and package path are the only intended product path |
| JS/wa-sqlite host-store benchmark path | `Test-only` | `tests/runtime/apps/browser/entry.ts`, `tests/runtime/scripts/browser-wasm-vs-js-benchmark.ts`, `packages/dialect-wa-sqlite` docs | Gives TS-vs-Rust performance comparison | Benchmark fixture can be mistaken for supported runtime | Keep only as benchmark/control fixture. Do not expose as generated app runtime |
| JavaScript-hosted browser store bridge | `Temporary` | `rust/crates/runtime/README.md` references `AsyncWebStore` / JavaScript Promise bridge | Early browser parity and scaffolding | Maintains two storage mental models | Remove or quarantine after Rust-owned browser SQLite coverage fully replaces it |
| Browser OPFS to IndexedDB fallback | `Accepted` | Browser runtime docs/worker behavior | Platform capability fallback when OPFS sync access handles are unavailable | Can hide slower storage mode if not reported | Keep only if diagnostics report selected storage mode and perf gates cover it |
| `apply_local_operation_json` alias | `Remove` | `rust/crates/runtime/README.md` and native facade if still present | Compatibility alias for older generated/native callers | Keeps obsolete generated API surface alive | Remove after current generated clients use canonical mutation/local operation APIs |
| Deprecated `actorScopeColumn` / `projectScopeColumn` config | `Remove` | `rust/crates/codegen/src/main.rs` | Transitional codegen config support | Encourages implicit scope config instead of explicit scopes | Remove once examples/docs only use explicit scope metadata |
| `json-v1` sync-pack path | `Temporary` | `packages/core/src/sync-packs.ts`, `rust/crates/runtime/src/core/binary_sync_pack.rs`, protocol fixtures | Existing JSON sync-pack encoding and fixture coverage | Becomes an old-protocol fallback beside binary path | WP-02/WP-03 should decide current Rust-first path. Do not add more JSON fallback logic for Rust clients |
| `json-row-frame-v1` snapshot chunks | `Temporary` | Server snapshot chunk docs/tests, `rust/crates/runtime/src/core/binary_snapshot.rs` | Existing snapshot chunk format and fixture coverage | Rust bootstrap work may optimize old row-frame path instead of binary-table/direct apply | Rust-first bootstrap should prefer `binary-table-v1` or successor. Keep row-frame only until protocol kernel/binary v2 decision |
| Inline JSON snapshot fallback for binary clients | `Remove` | Historical protocol behavior; should not be reintroduced | Previously allowed small inline snapshots | Violates one-current-path protocol discipline | Already removed for binary clients. Do not reintroduce |
| Decoding older binary sync-pack wire versions | `Decision needed` | `rust/crates/runtime/src/core/binary_sync_pack.rs` tests mention older v10 variants | Fixture/history coverage from protocol evolution | Decoder can become multi-version compatibility branch | Keep fixture coverage only if it protects current codec invariants. Runtime should not negotiate old versions without explicit migration-release decision |
| Migration legacy checksum algorithms | `Decision needed` | `packages/migrations/src/checksum.ts`, migration tests | Pre-existing migration tracking compatibility | Keeps old app migration behavior alive despite no-user/disruptive policy | Decide whether migration package keeps legacy checksum support as non-sync-client compatibility, or remove for Rust-first reset |
| Server Hono deprecated CORS option | `Remove` | `packages/server-hono/src/routes.ts` | Deprecated API shape | Small but real public API compatibility branch | Remove when touching server route config unless explicit migration support is requested |
| Console message-auth handshake fallback | `Decision needed` | `packages/server-hono/src/console/routes.ts` | Console auth convenience/path fallback | Could normalize fallback auth paths outside Rust-first discipline | Decide separately as console/operator compatibility, not client protocol compatibility |
| Service-worker postMessage fallback | `Decision needed` | `packages/server-service-worker/src/index.ts` | Browser/service-worker capability fallback | Could be valid platform fallback or stale bridge | Keep only if documented as environment fallback and covered by runtime tests |
| External chunk storage inline/database fallback | `Decision needed` | Snapshot chunk storage tests and server storage paths | Allows reading chunk bytes from DB/metadata path when external storage path is unavailable | May blur current snapshot storage contract | Keep only if it is explicit storage-adapter behavior, not protocol fallback |
| Offline-auth `lastActor` fallback | `Decision needed` | `plugins/offline-auth/client` | Offline UX continuity | Could imply auth after revocation if not lease-bound | Resolve under WP-11 offline auth lease model |
| Realtime wake-up-only docs | `Remove/update` | Pre-Rust docs under `apps/docs/content/docs/build/realtime.mdx`, concepts docs | Describes old JS runtime behavior | Conflicts with Rust-first websocket delta direction | Update Rust docs to state delta fast path; old docs should be archived or labeled legacy |

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

