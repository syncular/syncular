# WP-17 Offline Lifecycle And App State Integration

Status: `[x]` accepted

## Goal

Make offline, online, reconnect, and background-resume behavior ergonomic for
apps without weakening offline correctness or server authority.

## Scope

- App-facing network and sync lifecycle states.
- Queued mutation visibility and outbox progress.
- Optimistic state reconciliation guidance.
- Background resume hooks for browser and native runtimes.
- Mobile app lifecycle hooks for suspend, resume, foreground, and background
  sync policy.
- Battery/network-aware sync policy where supported.
- Integration with WP-05 readiness, WP-13 diagnostics, and WP-15 error codes.

## Non-Scope

- Letting offline mode pretend unauthorized data is valid after revocation.
- Making apps babysit websocket reconnect loops.
- Raw app-table writes as an offline synced write API.

## Acceptance Criteria

- Apps can render clear states for online, offline, connecting, recovering,
  auth-required, degraded, and complete.
- Outbox, conflict, blob upload, and realtime recovery status are observable
  without polling internal tables.
- Background resume performs explicit recovery/checkpoint behavior instead of
  silent best-effort state changes.
- Native and browser lifecycle events are semantically aligned where supported.
- Tests cover offline mutation queueing, reconnect recovery, auth refresh, and
  scope revocation while offline.

## Required Gates

- Runtime/native store tests for outbox, reconnect, and recovery behavior.
- Browser worker/realtime tests for lifecycle events.
- Native binding smokes when lifecycle APIs change.
- Browser E2E reconnect/offline benchmarks when reconnect performance changes.

## Accept / Reject Rule

- Retain only lifecycle APIs that make sync state explicit and keep recovery
  runtime-owned.
- Reject app-facing states that imply incomplete or unauthorized data is valid.
- Reject policies that hide failed pushes, failed pulls, or revocation clearing.

## Current Evidence

The Rust-first roadmap already prioritizes runtime-owned realtime reconnect,
explicit recovery, and adaptive bootstrap readiness. This WP turns those
mechanics into app-state APIs that developers can render and test.

## Interface Impact

Canonical semantics:

- The runtime owns lifecycle state. Host apps render state and request
  lifecycle transitions; they do not babysit sync loops, realtime reconnects,
  or internal retry timers.
- Foreground resume triggers runtime-owned realtime and sync recovery.
- Blob upload/cache/compaction maintenance remains explicit queued work so
  app shells can respect platform background budgets.

TypeScript/browser:

- `getStatus()`, `lifecycleState()`, `resumeFromBackground()`,
  `bootstrapChanged`, `blobUploadsChanged`, and lifecycle events are the
  canonical host-binding surfaces.
- Browser wrappers should expose lifecycle state through events, not
  user-authored polling loops.

React:

- Hooks/providers should derive status from the same event stream and avoid a
  separate polling status model.

Tauri/React Native/Expo:

- Bridge packages should map app-shell foreground/background callbacks to
  runtime lifecycle methods and preserve the native event/error JSON shape.
- Platform-specific background restrictions should be documented as capability
  constraints, not compatibility branches.

Testkit/docs:

- Bridge harnesses should assert lifecycle transitions, event ordering,
  backpressure/overflow recovery, resume behavior, and blob maintenance command
  visibility.

## Next Action

Closed. Next Rust-first work package is
[`WP-18 Production Hardening And Limits`](WP-18-production-hardening-limits.md).

## Progress

- Activated after WP-16 accepted the schema-evolution safety slice.
- Added the first browser lifecycle surface: `lifecycleState()` plus
  `lifecycleChanged` events. The state reports `offline`, `connecting`,
  `syncing`, `recovering`, `authRequired`, `degraded`, `complete`, and
  `closed` phases with realtime, bootstrap, outbox, conflict, diagnostic, and
  pending-request context.
- Worker client tests now prove lifecycle transitions for connecting,
  resync-required recovery, auth-required action, and final complete state.
- Browser/Hono integration now proves a production-shaped flow: generated
  mutations queue while the server is offline, the public lifecycle state shows
  pending outbox and failed sync state, retry backoff is honored, reconnect
  pushes the queued commit, and lifecycle reaches `complete` after the server
  has the row.
- Native runtime events now carry a typed lifecycle snapshot on sync start,
  sync completion, sync/auth failure, local write commits, command failures,
  conflict changes, and event overflow. Generated Swift and Kotlin native event
  models decode the same lifecycle shape, including phase, bootstrap readiness,
  outbox count, conflict count, and recovery/action state.
- Browser worker clients now expose `resumeFromBackground()`. It marks the
  lifecycle as recovering, restarts the remembered realtime worker options,
  refreshes auth headers once, runs `syncOnce`, and clears recovery through the
  normal bootstrap/lifecycle path.
- Native `NativeSyncularClient`, C FFI, and generated Swift/Kotlin/Java
  BoltFFI wrappers now expose `resume_from_background` /
  `resumeFromBackground()`. The runtime resumes the worker if needed, restarts
  realtime, and enqueues a command-correlated sync instead of making host apps
  poke worker/realtime/sync primitives separately.
- Browser/Hono auth coverage now proves `resumeFromBackground()` refreshes a
  stale token on 401, retries once with fresh headers, emits `recovering`, and
  reaches `complete` after recovery.
- Browser/Hono scope-revocation coverage now proves the lifecycle stream
  carries `sync.scope_revoked` while revoked scoped rows are cleared locally.
- Swift, Kotlin, iOS, and Android lifecycle smokes now call
  `resumeFromBackground()` as the foreground recovery API instead of using
  lower-level sync pokes in the app-shell examples.
- Browser lifecycle state now includes `blobUploads` and emits
  `blobUploadsChanged` when queued blob storage or upload processing changes
  the queue. Failed blob uploads move lifecycle to `degraded` with
  `requiresAction`, and diagnostic snapshots include blob upload queue stats.
- Native worker events now include `BlobUploadsChanged` after queued blob file
  storage and due blob upload retry processing. The native lifecycle payload
  carries `blobUploads`, and generated Swift/Kotlin/Android event models decode
  the same field.
- Policy decision: `resumeFromBackground()` remains the recovery hook for
  realtime and sync. Blob uploads, blob cache maintenance, and storage
  compaction stay explicit queued operations so app shells can honor platform
  background execution budgets, battery state, and network policy without the
  runtime silently spending that budget.
- Native runtime, C FFI, BoltFFI, Swift, Kotlin, and Java bindings now expose
  `enqueueProcessBlobUploadQueue()` / `enqueue_process_blob_upload_queue` as
  the nonblocking blob upload attempt API. Swift, Kotlin, iOS, and Android
  lifecycle smokes now model a host maintenance policy: restricted background
  state does not enqueue upload/compaction work, while foreground policy
  explicitly queues blob upload processing and storage compaction.
- Browser lifecycle management now treats known browser offline state and
  retryable `sync.offline` failures as normal lifecycle conditions during
  startup. Managed clients can start while offline, retry sync when the browser
  comes online, and keep realtime startup best-effort instead of surfacing
  offline as a fatal app error. The local demo now renders `Offline`, suppresses
  retryable offline error banners, keeps local mutations queued, and triggers a
  sync when online returns.
- Browser worker lifecycle state now uses browser network status when available
  and only reports the `syncing` phase for actual sync/push/pull requests.
  Local SQLite reads, live-query drains, diagnostic snapshots, and command-state
  reads no longer make app status flicker as though network sync is running.
- `autoSyncAfterMutation` now gates itself on browser network state, keeps an
  offline mutation queued instead of calling `syncOnce()` while offline, and
  schedules the queued sync when the browser comes back online.
- Sync auth-header refresh no longer restarts active realtime sockets during
  ordinary sync attempts. Explicit auth-header updates and foreground resume
  still restart realtime when the host requested that transition.
- React hooks now expose `useSyncStatus()` so React apps can render the same
  managed `getStatus()`/`lifecycleChanged` stream without building a separate
  polling status model.
- The local demo no longer calls `syncOnce()` or starts realtime manually after
  app mutations. It opens the generated Rust app database, starts the Syncular
  lifecycle controller, renders lifecycle state, and lets framework-managed
  mutation auto-sync/reconnect handle local writes, undo/redo, offline queueing,
  and online recovery.
- The local demo now treats degraded local state as a review state instead of a
  fatal app error, and its console diagnostic publisher no longer subscribes to
  `lifecycleChanged` because diagnostic snapshots issue worker requests that
  themselves produce lifecycle transitions. Demo diagnostics are deduped by
  stable snapshot content, and the demo IndexedDB file prefix was bumped to
  avoid carrying failed/conflict state from earlier local experiments.
- Console diagnostic publishing is now managed by `@syncular/client` through
  `consoleDiagnostics`, so apps opt in with a console URL/token or disable it
  with `false`. The managed publisher is offline-aware, avoids lifecycle
  self-recursion, dedupes unchanged snapshots, and compacts bulky diagnostic
  arrays/details before posting so the console server's 64 KiB record limit is
  respected.
- The app-facing browser API and generated TypeScript output no longer use
  `V2` names. Public callers now use `createSyncularDatabase`,
  `SyncularDatabase`, `CreateSyncularDatabaseOptions`, `SyncularRuntimeClient`,
  and unversioned runtime constants/helpers. The Rust wasm-bindgen helper
  exports and WASM artifact filenames were rebuilt with unversioned names so
  the demo and generated clients use the same surface.

## Latest Evidence

- `bun --cwd rust/bindings/javascript build:wasm:dev`
- `bun --cwd rust/bindings/javascript tsgo`
- `bun --cwd packages/client tsgo`
- `bun --cwd apps/demo tsgo`
- `bun --cwd packages/client-react tsgo`
- `bun test packages/client/src/console-diagnostics.test.ts packages/client/src/public-api.test.ts packages/client/src/generated-runtime.test.ts`
- `bun test packages/client/src/client.test.ts packages/client/src/errors.test.ts`
- `bun test packages/client-react/src/index.test.ts`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
- `bunx biome check apps/demo/src/app.tsx apps/demo/src/client/syncular.ts apps/docs/content/docs/build/error-handling.mdx apps/docs/content/docs/build/migrations.mdx apps/docs/content/docs/operate/performance.mdx config/bundle-budget.json packages/client/src packages/client/scripts/generate-bridge.ts packages/client-react/src packages/client-crdt-adapters/src packages/client-tauri/src/index.ts packages/client-react-native/src/index.ts packages/testkit/src/client-bridge.ts rust/bindings/javascript/src/runtime-contract.ts rust/bindings/javascript/scripts/build-syncular-wasm.ts rust/bindings/javascript/scripts/size-syncular-wasm.ts rust/bindings/javascript/scripts/write-syncular-wasm-catalog.ts rust/examples/todo-app/generated/typescript/syncular.generated.ts`
- `git diff --check`
- Search for stale versioned public/runtime names returned no matches outside
  lockfile/favicon noise.
- Playwright demo smoke: after rebuilding dev WASM, both demo clients rendered
  `Ready`; managed diagnostics posted for both clients with `202` responses and
  about 6.2 KiB request bodies. Diagnostic runtime URLs now report
  `syncular.js` and `syncular_bg.wasm`.
- `bun test packages/client/src/console-diagnostics.test.ts`
- `bun --cwd packages/client tsgo`
- `bun --cwd apps/demo tsgo`
- `bunx biome check packages/client/src/console-diagnostics.ts packages/client/src/console-diagnostics.test.ts packages/client/src/database.ts packages/client/src/index.ts packages/client/src/types.ts apps/demo/src/client/syncular.ts`
- Playwright demo smoke: reload at `http://127.0.0.1:5173/` posted compact
  managed diagnostics for `demo-left` and `demo-right`; both responses were
  `202`, request bodies were about 6.2 KiB, bulky `changedRows` detail was not
  sent, no console errors were emitted, and both clients rendered `Ready`.
- `bun --cwd apps/demo tsgo`
- `bunx biome check apps/demo/src/app.tsx apps/demo/src/client/syncular.ts apps/demo/src/styles.css`
- Playwright demo smoke: reload produced two initial console diagnostic posts
  for the two clients and no continuing request loop over six seconds; offline
  mutation showed `Offline` without an error banner and synced to Client B after
  returning online.
- `bun --cwd packages/client test`
- `bun --cwd packages/client tsgo`
- `bun --cwd packages/client-react test`
- `bun --cwd packages/client-react tsgo`
- `bun --cwd apps/demo tsgo`
- `bun --cwd apps/demo build`
- Playwright demo smoke: idle status stayed `Ready|Ready`; Client A mutation
  synced to Client B without demo sync calls; browser offline showed `Offline`
  with no `.error-line`; an offline queued mutation synced to both clients after
  returning online.
- `bun test rust/bindings/browser/src/worker-client.test.ts -t "lifecycle"`
- `bun test rust/bindings/browser/src/worker-client.test.ts -t "resumes from background"`
- `bun test rust/bindings/browser/src/worker-client.test.ts -t "blob upload queue stats"`
- `bun test rust/bindings/browser/src/worker-client.test.ts`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade native_facade_enqueues_compaction_and_blob_cache_work_on_worker`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_binding_scaffold`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
- `boltffi generate all`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_ffi`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`
- `bun run rust:conformance:native`
- `bun test rust/bindings/browser/src/worker-client.test.ts rust/bindings/browser/src/client.test.ts`
- `bun test rust/bindings/browser/src/worker-client.test.ts rust/bindings/browser/src/generated-app-conformance.test.ts`
- `bun test rust/bindings/browser/src/__tests__/auth-hono.wasm.test.ts`
- `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts -t "clears scoped local rows"`
- `bun run --cwd rust/bindings/browser tsgo`
- `bun test rust/bindings/browser/src/public-api.test.ts rust/bindings/browser/src/react.test.ts`
- `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts -t "lifecycle state"`
- `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture --test native_facade`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_facade`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_ffi`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings --test native_binding_scaffold`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends --features native,crdt-yjs,demo-todo-native-fixture`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --no-default-features --features native,crdt-yjs`
- `cargo check --manifest-path rust/Cargo.toml -p syncular-runtime --features native,crdt-yjs,boltffi-bindings`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
- `bun run rust:conformance:native`
- `git diff --check`
- `bun test packages/client/src/client.test.ts packages/client/src/errors.test.ts`
- `bun --cwd packages/client tsgo`
- `bun --cwd apps/demo tsgo`
- `bun test packages/client/src/__tests__/sync-hono.wasm.test.ts -t "reports lifecycle state through offline queued mutation and reconnect recovery"`
