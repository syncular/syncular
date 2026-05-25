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
| Browser OPFS to IndexedDB fallback | `Accepted` | Browser runtime docs/worker behavior | Platform capability fallback when OPFS sync access handles are unavailable | Can hide slower storage mode if not reported | Keep only if diagnostics report selected storage mode and perf gates cover it |
| Console WebSocket first-message auth | `Accepted` | `packages/server-hono/src/console/routes.ts`, `packages/console/src/hooks/useLiveEvents.ts` | Browser WebSocket clients cannot send custom `Authorization` headers, and query-token auth would leak bearer tokens into URLs/logs | Can look like an auth fallback if undocumented | Keep as a platform capability; route middleware and tests must make the first-message auth path explicit |
| Service-worker postMessage wake delivery | `Accepted` | `packages/server-service-worker/src/index.ts` | Platform capability fallback when `BroadcastChannel` is unavailable or fails in a service-worker runtime | Can hide less direct wake delivery if untested | Keep as a browser/service-worker capability; tests cover BroadcastChannel delivery and client `postMessage` fallback |
| Database-inline snapshot chunk bodies | `Accepted` | `packages/server/src/snapshot-chunks.ts`, external chunk storage tests | Local/dev storage mode when no external `chunkStorage` adapter is configured | Could be mistaken for a fallback from failed external reads | Keep as explicit storage-adapter behavior. External chunk reads fail closed when the external body is missing |

## Recently Removed

| Item | Status | Removed From | Reason |
| --- | --- | --- | --- |
| Websocket JSON inline deltas | `Removed` | `packages/server-hono/src/ws.ts`, browser worker realtime contract/tests | Rust-first realtime protocol is binary sync-pack deltas or explicit pull-required wakeups. JSON row deltas were old product-protocol surface and bypassed the verified sync-pack contract |
| Inline JSON snapshot fallback for binary clients | `Removed` | Historical binary-client snapshot protocol behavior | Binary clients should receive snapshot chunk refs/artifacts or fail clearly. Inline JSON snapshots for binary clients were removed and must not be reintroduced |
| Decoding older binary sync-pack wire versions | `Removed` | `rust/crates/protocol/src/binary_sync_pack.rs` | Current protocol crate test mutates a fixture to an old version and asserts rejection. Keep rejecting old versions unless the user explicitly asks for a migration release |
| Synthetic `__syncular_realtime__` delta apply | `Removed` | `rust/crates/runtime/src/web/client.rs`, browser Rust wasm API, browser worker inline realtime tests | Realtime binary packs now use real per-subscription IDs and verified roots. Rootless synthetic applies were removed instead of carried as a fallback |
| `apply_local_operation_json` / `enqueue_local_operation_json` aliases | `Removed` | Rust client, native facade, C FFI, BoltFFI bindings, browser runtime low-level APIs, tests/docs | Mutation naming is the canonical low-level write contract. No old generated/native callers are preserved |
| `actorScopeColumn` / `projectScopeColumn` codegen config fields | `Removed` | `rust/crates/codegen/src/main.rs` | Explicit named scopes are the only config model. Codegen now rejects unknown keys instead of carrying deprecated fields |
| Server Hono legacy sync CORS shape | `Removed` | `packages/server-hono/src/routes.ts` | Hono-style `cors: origin` / `cors: { origin }` is the single sync route CORS contract |
| Per-commit pull integrity fields | `Removed` | `SyncCommit` TS/Rust contract and `binary-sync-pack-v1` wire v13 | Pull integrity now lives on subscription-level metadata. The current path does not carry `partitionId`, `previousChainRoot`, `commitDigest`, or `commitChainRoot` on every commit |
| Browser SQLite artifact JSON materialization path | `Removed` | `rust/crates/runtime/src/web/client.rs`, `rust/crates/runtime/src/web/sqlite_wasm_store.rs` | Browser artifacts are now requested only for direct apply modes. Pull modes needing changed rows, returned snapshot rows, field encryption, or encrypted CRDT transforms use snapshot chunks instead of a browser artifact-to-JSON branch |
| Uncompressed SQLite artifact runtime selection | `Removed` | Rust native/browser artifact capability requests and server pull artifact selection | Current scoped SQLite artifact bodies are gzip-compressed. Runtime transports decode after verifying compressed bytes, and non-gzip artifact refs fail clearly on the current path |
| Old JS client product packages | `Removed` | `packages/client`, legacy React client implementation, client plugin packages, old JS client docs, demo app, legacy JS integration/runtime/perf suites | `@syncular/client` is now the Rust-owned browser package with TypeScript bindings and `@syncular/react` |
| Browser TypeScript constructor aliases | `Removed` | `@syncular/client` public exports and generated app TypeScript output | Generated apps and browser callers now import unversioned `createSyncularDatabase` / `SyncularDatabase` and `createSyncularClient` directly instead of old Rust/`V2` constructor aliases |
| JS/wa-sqlite host-store benchmark path | `Removed` | `tests/runtime/apps/browser/entry.ts`, `tests/runtime/scripts/browser-wasm-vs-js-benchmark.ts`, `tests/perf` | The TS client benchmark depended on the deleted product runtime and was removed with the legacy client |
| Offline-auth `lastActor` fallback | `Removed` | `plugins/offline-auth/client` | The old client plugin package was deleted with the TS client surface. Reintroduce only as a Rust lifecycle/auth feature with explicit lease semantics |
| Realtime wake-up-only docs | `Removed` | `README.md`, `apps/docs/content/docs/**`, package READMEs | Rust-first realtime docs now describe websocket sync-pack deltas as the fast path and HTTP pull as recovery/checkpoint, instead of claiming websocket only wakes HTTP pull |
| `@syncular/dialect-wa-sqlite` browser package and `syncular/dialect-wa-sqlite` subpath | `Removed` | `packages/dialect-wa-sqlite`, `packages/syncular/src/dialect-wa-sqlite.ts`, package manifests, docs | Browser client direction is Rust-owned SQLite through `@syncular/client`; the old wa-sqlite dialect package is no longer a product path |
| `@syncular/transport-ws` package and `syncular/transport-ws` subpath | `Removed` | `packages/transport-ws`, `packages/syncular/src/transport-ws.ts`, package manifests, docs | Realtime is now owned by the Rust/runtime and server websocket contract. The old separate TypeScript transport package is removed instead of carried as a compatibility surface |
| Old client plugin package surfaces | `Removed` | `@syncular/client-plugin-blob`, `@syncular/client-plugin-encryption`, `@syncular/client-plugin-yjs`, `@syncular/client-plugin-offline-auth`, `@syncular/client-plugin-offline-auth-react` | Client plugins are not separate product packages in the Rust-first client. Blob, encryption, CRDT/Yjs, and offline-auth behavior are owned by the Rust runtime/client APIs, with app/editor glue living above those APIs. |
| Old native SQLite client dialect packages | `Removed` | `packages/dialect-electron-sqlite`, `packages/dialect-react-native-nitro-sqlite`, `packages/dialect-expo-sqlite`, `tests/expo-app`, `syncular/dialect-electron-sqlite`, `syncular/dialect-react-native-nitro-sqlite`, `syncular/dialect-expo-sqlite` | Native/Electron/React Native apps should use Rust-owned host runtimes and bridge packages instead of JavaScript-owned SQLite dialect adapters. The old Expo SQLite dialect and Expo test app were removed with the rest of the JS-owned native SQLite dialect surface. |
| `syncular/server-dialect-neon` umbrella alias | `Removed` | `packages/syncular/src/server-dialect-neon.ts`, `packages/syncular/package.json`, docs | Neon support is exposed through `@syncular/server-dialect-postgres` / `syncular/server-dialect-postgres`; the extra alias only preserved an unnecessary old import path |
| Migration legacy source checksum algorithm | `Removed` | `packages/migrations/src/checksum.ts`, `packages/migrations/src/tracking.ts`, migration tests | Migration tracking now only accepts generated SQL-trace checksums or disabled checksums. Old tracking-table upgrade support was removed under the disruptive Rust-first cleanup policy |
| Service-worker legacy single-commit wake parsing | `Removed` | `packages/server-service-worker/src/index.ts`, service-worker tests | Wake resolution now reads current batched `push.commits` request/response shapes only. Legacy single `push.operations` / `push.status` handling was removed instead of carried as an old protocol branch |
| Browser low-level Rust store wrapper | `Removed` | `packages/client/src/rust-store.ts` | Removed the direct Rust-owned SQLite wrapper from the browser package. The supported browser path is the managed worker/client API; low-level wasm store handles are not public product surface |
| `accept-server` conflict-resolution alias | `Removed` | `packages/client/src/types.ts`, `rust/crates/runtime/src/core/client.rs` | `keep-server` is the canonical conflict-resolution spelling. The old `accept-server` spelling was removed instead of kept as a compatibility alias |
| Arbitrary conflict-resolution strings | `Removed` | `packages/client/src/types.ts` | The browser TypeScript API now accepts only `keep-local`, `keep-server`, and `dismiss`, matching the runtime contract instead of preserving an open-ended string escape hatch |
| JavaScript-hosted browser store bridge | `Removed` | `rust/crates/runtime/src/web/host_store.rs`, `rust/crates/runtime/src/web/wasm.rs`, `web-store` Cargo features | Product browser runtime is Rust-owned SQLite. The old wasm `SyncularWasmClient` host-store bridge was removed instead of retained as test-only scaffolding |
| `@syncular/client-expo` alias package | `Removed` | `packages/client-expo` | Expo-only aliases over `@syncular/client-react-native` were removed. React Native is the canonical TypeScript bridge package for native hosts |
| Native realtime `start` / `stop` aliases | `Removed` | `NativeSyncularClient`, C FFI, BoltFFI Swift/Kotlin/Java bindings | Native hosts now use explicit `start_realtime_worker` / `stop_realtime_worker` names so lifecycle control is not confused with sync-worker startup or full client shutdown |
| Browser client event type aliases | `Removed` | `packages/client/src/client.ts` | Removed unused `SyncularClientEventType` / `SyncularClientEventMap` aliases from the managed client layer; callers should use the canonical runtime event types directly |
| Browser worker response type aliases | `Removed` | `packages/client/src/worker-protocol.ts` | Removed unused worker runtime-info / transport-stats response aliases; callers should use the canonical runtime info and transport stats types |
| Browser lifecycle network type alias | `Removed` | `packages/client/src/client.ts` | Removed the managed-client network-status alias; lifecycle options now use the canonical `SyncularNetworkStatusSource` type directly |
| Testkit sync change type alias | `Removed` | `packages/testkit/src/sync-response.ts` | Removed `SyncChangeRecord`; testkit helpers now return the canonical `SyncChange` type from `@syncular/core` |
| Browser root Rust helper exports | `Removed` | `packages/client/src/index.ts` | The package root exports the canonical browser client/database API and runtime artifact helpers only. Low-level Rust/WASM helper modules remain internal relative imports instead of public root surface |
| Transport per-call `onAuthError` callback | `Removed` | `SyncTransportOptions`, `@syncular/transport-http` retry resolver/tests | `authLifecycle` is the single auth refresh contract. The legacy per-call callback was removed instead of taking precedence over the current lifecycle API |
| Host JSON CRDT snake_case aliases | `Removed` | `rust/crates/runtime/src/core`, `rust/crates/runtime/src/native`, `rust/crates/runtime/src/web` | Native/browser host CRDT request JSON now accepts the generated camelCase shape only (`rowId`, `nextText`, `minUncheckpointedUpdates`, `serverPayload`, `stateColumn`, `containerKey`, `rowIdField`) instead of carrying duplicate snake_case aliases |
| Old websocket bootstrap timing field alias | `Removed` | `rust/crates/runtime/src/transport/web.rs` | Runtime timing parsing now reads the current server `binaryEncodeMs` field directly instead of also accepting the old `snapshotBinaryEncodeMs` spelling |
| Realtime binary fallback diagnostic wording | `Removed` | `packages/client/src/worker-realtime.ts`, realtime browser tests | Binary sync-pack apply failure is now reported as `realtime.binary_apply_failed` followed by HTTP pull recovery, not as a generic fallback branch |
| Rust runtime JSON row-frame chunk decode | `Removed` | `rust/crates/runtime/src/transport/mod.rs`, `rust/crates/runtime/src/transport/web.rs`, runtime protocol re-exports | Rust/native/browser clients request `binary-table-v1` chunks only; runtime transports now reject JSON row-frame chunks instead of carrying a permissive old snapshot decode path |
| Server default JSON row-frame chunks | `Removed` | `packages/core/src/snapshot-chunks.ts`, pull/chunk-storage tests | Unspecified server pull requests now default to `binary-table-v1` snapshot chunks. Tests decode chunks from the advertised ref encoding instead of assuming JSON row frames |
| Explicit `json-row-frame-v1` snapshot chunks | `Removed` | `packages/core/src/snapshot-chunks.ts`, `packages/server/src/pull.ts`, Rust protocol validation, protocol fixtures, server tests | Snapshot chunks are now binary-only. The server no longer carries JSON row-frame negotiation, encoding, inline snapshot, fixture, or row-frame timing paths |
| Server default JSON sync-pack responses | `Removed` | `packages/core/src/sync-packs.ts`, Hono sync route tests | Unspecified combined sync requests were moved to `binary-sync-pack-v1` before the explicit JSON sync-pack path was removed entirely |
| Explicit `json-v1` sync-pack negotiation | `Removed` | `packages/core/src/sync-packs.ts`, `packages/server-hono/src/routes.ts`, Rust protocol validation, protocol fixtures | Combined sync responses are binary sync-packs only. JSON HTTP error envelopes remain separate error responses, not a sync-pack encoding |
| Sync-pack request encoding negotiation fields | `Removed` | `SyncCombinedRequest`, `SyncPullRequest`, testkit builders, Rust request builders, protocol fixtures | Binary sync-packs are the only combined response path, so request-time `syncPackEncodings` knobs were no-op compatibility surface |
| Snapshot request encoding negotiation field | `Removed` | `SyncPullRequest`, server pull path, Rust request builders, protocol fixtures | Snapshot chunks are binary-only, so request-time `snapshotEncodings` was removed instead of kept as a misleading selector |
| Generated TypeScript app-table metadata aliases | `Removed` | Generated TypeScript client/server outputs and conformance imports | Generated app metadata now uses the single public `syncularGeneratedApp` object. Separate exported table-map/list constants were removed so generated app code follows the current `app.tables.<table>` / `app.tableNames` shape instead of preserving extra public metadata aliases |

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
