# WP-26 TypeScript Host Bindings And Platform Bridges

Status: `[x]` accepted

## Goal

Catch up the TypeScript-facing host bindings after the Rust-first client
rewrite, while making it explicit that there is no separate JavaScript sync
client product path.

The TypeScript packages should be thin, ergonomic bindings over the canonical
Rust runtime and generated app contracts. They should expose the same Syncular
semantics across browser, React, Tauri, React Native, and Expo without
reimplementing sync, outbox, conflict, blob, CRDT, auth, or lifecycle logic in
JavaScript.

## Scope

- Canonical browser TypeScript host API in `@syncular/client`.
- React hooks and provider surface in `@syncular/react`.
- Platform bridge packages:
  - `@syncular/client-tauri`
  - `@syncular/client-react-native`
  - `@syncular/client-expo`
- Shared bridge contract and testkit fixtures in `@syncular/testkit`.
- Generated TypeScript app client output and docs where host APIs are surfaced.
- Interface-impact tracking for feature work packages that change app-facing
  APIs.

## Non-Scope

- Recreating the removed pure TypeScript sync engine, outbox, JS SQLite store,
  or old React package behavior.
- Preserving legacy JS client APIs as compatibility aliases.
- Defining feature semantics inside TypeScript wrappers. Feature WPs remain the
  source of truth for behavior.
- Implementing Swift/Kotlin/JVM packaging; that remains WP-09.
- Replacing query-builder-first local reads with ORM-style predefined reads.

## Ownership Model

Feature WPs own semantics. WP-26 owns host-binding projection and parity.

Examples:

- WP-22 owns command-history meaning, replay safety, conflict behavior, and
  unsafe-field rejection. WP-26 tracks whether browser TS, React, Tauri, React
  Native, Expo, testkit, and docs expose that canonical command-history shape.
- WP-11 owns offline auth leases and leased mutation authorization semantics.
  WP-26 tracks whether TypeScript host bindings expose `issueAuthLease`,
  `leasedMutations`, lifecycle errors, and bridge contracts consistently.
- WP-21 owns row/field-level live-query precision. WP-26 tracks whether TS and
  platform bridges avoid table-level guessing and expose precise event metadata.

## Acceptance Criteria

- Docs and milestone language consistently say TypeScript host bindings or
  browser TypeScript bindings, not a separate JS client.
- Every feature WP that changes app-facing APIs has an `Interface Impact`
  section or an explicit deferral note.
- The TypeScript host-binding surface has a single semantic shape across
  browser, React, Tauri, React Native, and Expo where the platform can support
  it.
- Platform bridge packages are covered by Syncular-owned testkit harnesses, not
  package-local mocks that can drift from the runtime contract.
- TypeScript bindings do not expose raw synced writes, old JS fallback paths, or
  feature-specific behavior that bypasses the Rust runtime.
- Generated TypeScript clients keep Kysely/query-builder semantics for reads
  and generated mutation/outbox semantics for writes.
- All retained platform-specific limitations are documented as capability
  constraints, not compatibility branches.

## Required Gates

- Browser package tests and typecheck:
  - `bun run rust:browser:test`
  - `bun run rust:browser:tsgo`
- Platform bridge tests and typechecks:
  - `bun test packages/client-tauri/src/index.test.ts packages/client-react-native/src/index.test.ts packages/client-expo/src/index.test.ts rust/bindings/browser/src/bridge-client.test.ts`
  - `bun --cwd packages/client-tauri tsgo`
  - `bun --cwd packages/client-react-native tsgo`
  - `bun --cwd packages/client-expo tsgo`
  - `bun --cwd packages/testkit tsgo`
- Generated client checks when generated TypeScript output changes:
  - `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
  - `bun test rust/bindings/browser/src/generated-app-conformance.test.ts`
- Docs/type surfaces when public package docs change:
  - `bun run docs:build`
  - `bun run tsgo`
- Browser/WASM build and size gate when browser runtime or package exports
  change:
  - `bun run rust:browser:build:wasm`

## Accept / Reject Rule

- Retain TypeScript host-binding changes only when they project canonical
  Rust/feature semantics without adding a second sync implementation.
- Reject aliases or compatibility helpers that preserve removed JS-client API
  names unless explicitly requested and recorded in
  `../COMPATIBILITY_REGISTER.md`.
- Reject platform wrappers that silently drop feature semantics such as leased
  auth, command-history conflicts, row/field change metadata, blob validation,
  lifecycle recovery, or stable error taxonomy.
- Reject feature APIs that are only implemented in TypeScript if the runtime
  cannot support the same semantics for native/Rust bindings.

## Current Evidence

Recent retained commits changed the product shape:

- `Remove legacy TypeScript client` deleted the old JS sync engine, React
  package, client plugin packages, old JS docs, and JS-client test suites.
- `Add ergonomic Rust browser client` made `createSyncularClient()` the
  browser TypeScript entrypoint over Rust-owned SQLite.
- `Expose ergonomic Rust React hooks` made React hooks a wrapper over the
  Rust-backed client shape.
- `Add platform bridge client packages` introduced Tauri, React Native, and
  Expo packages as bridge adapters, not separate sync clients.
- `Add client bridge testkit coverage` added a Syncular-owned in-process bridge
  harness for those platform packages.

The remaining risk is documentation and milestone drift: feature work can add
new app-facing methods to one surface while other TypeScript host surfaces lag
or keep old naming assumptions.

## Progress

- Added `Interface Impact` sections to WP-11, WP-17, WP-21, WP-22, WP-23, and
  WP-24 so feature semantics stay owned by feature WPs while WP-26 tracks
  TypeScript/platform projection.
- First retained bridge parity slice:
  - `SyncularClientLike` now exposes `leasedMutations`,
    `resumeFromBackground(...)`, and auth lease methods directly instead of
    requiring app code to reach through lower-level runtime objects.
  - `SyncularBridge`, Tauri, React Native, Expo, and the shared testkit bridge
    harness now project leased mutation commits, auth lease issue/read/list,
    and resume-from-background behavior through the same client shape.
  - Bridge tests now prove regular mutations, leased mutations, precise
    `rowsChanged` payload delivery, auth lease roundtrip, active lease listing,
    and foreground resume across browser bridge, Tauri, React Native, and Expo.
- React leased mutation hooks now mirror normal mutation hooks:
  `useLeasedMutation(...)` and `useLeasedMutations(...)` route through
  `client.leasedMutations` while preserving the existing pending/error/sync
  options. They do not add a separate offline-auth plugin surface.
- React `useSyncQuery(...)` now uses `client.live(...)` when the query is
  compilable and the host client supports query observation. Non-compilable
  queries and bridge clients without live-query support keep the conservative
  `rowsChanged` fallback, but direct Rust browser clients no longer need broad
  table guessing for Kysely query refreshes.
- Bridge live-query decision: Tauri/React Native/Expo should preserve precise
  `rowsChanged.changedRows` metadata today, but should not pretend to have
  query-observer parity by rerunning from table-level events. A future bridge
  live-query API needs a canonical native observed-query registration/event
  stream, or the app should own its refresh policy using row/field metadata.
- Command-history decision: command history stays generated-client owned.
  TypeScript generated clients already wrap `database.mutations` and
  `database.leasedMutations`. Platform bridge packages should expose
  command-history only through generated platform clients once those generated
  mutation wrappers are mature, not as a generic bridge-level JavaScript undo
  stack.
- Docs/package polish slice:
  - Browser package README now describes `@syncular/client` as a TypeScript host
    binding over the Rust client, not a JavaScript sync client.
  - React examples now return a Kysely builder from `useSyncQuery(...)` so the
    hook can use runtime live-query observation.
  - Browser README now shows auth lease issue, leased mutations,
    `resumeFromBackground()`, platform bridge usage, and explicit bridge
    live-query/command-history capability constraints.
  - Tauri, React Native, and Expo bridge packages now have focused READMEs for
    the current Rust-backed host-binding surface.
- Diagnostic bridge parity slice:
  - `SyncularClientLike` now includes `diagnosticSnapshot()` so React and
    platform bridge clients can consume the same redacted runtime snapshot shape
    as the direct Rust browser client.
  - `SyncularBridge`, Tauri, React Native, Expo, and the shared testkit bridge
    harness project diagnostic snapshots through host calls instead of
    rebuilding diagnostic state in TypeScript.
  - The testkit bridge returns a redacted synthetic snapshot suitable for app
    tests that assert support/diagnostic wiring without mocking Syncular
    internals.

Latest evidence:

```bash
bun test packages/client-tauri/src/index.test.ts packages/client-react-native/src/index.test.ts packages/client-expo/src/index.test.ts rust/bindings/browser/src/bridge-client.test.ts
bun test packages/client-react/src/index.test.ts
bun --cwd packages/client-tauri tsgo
bun --cwd packages/client-react-native tsgo
bun --cwd packages/client-expo tsgo
bun --cwd packages/testkit tsgo
bun --cwd packages/client-react tsgo
bun run --cwd rust/bindings/browser tsgo
git diff --check
```

Result: passed. No benchmark gate was run; this slice changes TypeScript host
interfaces/testkit projection only and does not alter Rust/WASM runtime hot
paths.

## Interface Catch-Up Matrix

| Feature WP | Semantic owner | TypeScript/browser impact | React impact | Tauri/RN/Expo bridge impact | Current decision |
| --- | --- | --- | --- | --- | --- |
| WP-05 Adaptive Bootstrap | Runtime/generated subscriptions | `getStatus()`, `bootstrapChanged`, generated phase helpers | Hooks must expose readiness without polling hacks | Bridge status/events must preserve readiness payloads | Mostly done; audit docs/examples |
| WP-07 CRDT Fields | Runtime CRDT primitives | Generic CRDT field APIs, row metadata, Yjs envelope helpers | Keep editor adapters app-layer; expose field events | Bridge events must preserve CRDT field metadata | Track adapter docs and bridge parity |
| WP-11 Offline Auth Leases | Server/Rust auth lease model | `issueAuthLease`, `leasedMutations`, active lease reads | Hooks/examples should show leased vs normal mutations | Bridges need strict leased mutation methods and errors | Browser/bridge/React host surfaces added; docs still need pass |
| WP-13 Observability | Runtime/server diagnostics | Diagnostic snapshots/support bundles | Support hooks should expose stable diagnostics, not raw internals | Bridge diagnostics must match native event/error JSON | Bridge/testkit diagnostic snapshot parity added; console UI remains WP-13-deferred |
| WP-15 Error Taxonomy | Core/server/runtime taxonomy | Stable `code/category/retryable/recommendedAction` in thrown errors/events | Hooks must surface stable error objects | Bridges must preserve error shape | Mostly done; keep in generated docs |
| WP-17 Lifecycle/App State | Runtime lifecycle model | `getStatus`, `on(...)`, `resumeFromBackground`, lifecycle events | Hooks must avoid poll-based status loops | Platform shells need app lifecycle entrypoints | Bridge resume parity added; optional polling remains explicit |
| WP-21 Live Query Precision | Runtime observation | Kysely live query metadata, row/field deltas | Hooks must refresh from row/field events, not broad table guessing | Bridge events need precise changed rows/fields | React live-query path added; bridge observed-query registration deferred |
| WP-22 Undo/Redo Command History | Runtime/generated mutation history | `commandHistory.undoLast/redoLast`, generated mutation wrapping | Hooks should expose command-history state/actions when useful | Bridge packages need a decision: expose or explicitly defer | Generated-client owned; no generic bridge JS undo stack |
| WP-23 Audit/Debug | Server audit/console/testkit | Admin/support APIs and redacted export helpers | Generally docs/support tools, not normal app hooks | Bridge support-bundle export only if needed | Keep scoped to support/debug |
| WP-24 Blob Hardening | Runtime/server blob model | Blob queue/cache/status, large payload limits | Hooks for queue/cache status and stable blob errors | Bridge modules must preserve validation/limits | Planned; use this WP for TS projection |

## First Slice

1. Add `Interface Impact` sections to the feature WPs that already changed
   app-facing APIs but do not clearly track TypeScript host bindings:
   - WP-11 Offline Auth
   - WP-17 Lifecycle/App State
   - WP-21 Live Query Precision
   - WP-22 Undo/Redo
   - WP-23 Audit/Debug
   - WP-24 Blob Hardening
2. Audit current TypeScript package exports against the matrix:
   - `rust/bindings/browser/src/index.ts`
   - `rust/bindings/browser/src/react.ts`
   - `packages/client-tauri/src/index.ts`
   - `packages/client-react-native/src/index.ts`
   - `packages/client-expo/src/index.ts`
   - `packages/testkit/src/client-bridge.ts`
3. Add or update bridge testkit coverage for missing canonical surfaces before
   changing public docs.
4. Update browser/platform docs to say TypeScript host bindings and platform
   bridges, not JS clients.

## Next Action

Closed for the current Rust-first foundation. Future TypeScript host-binding
changes should be driven by the owning feature WP's `Interface Impact` section,
with WP-26 used as the parity checklist if a new browser/React/platform bridge
surface is added.
