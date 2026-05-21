# WP-26 TypeScript Host Bindings And Platform Bridges

Status: `[ ]` planned

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
- React hooks and provider surface in `@syncular/client/react`.
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

## Interface Catch-Up Matrix

| Feature WP | Semantic owner | TypeScript/browser impact | React impact | Tauri/RN/Expo bridge impact | Current decision |
| --- | --- | --- | --- | --- | --- |
| WP-05 Adaptive Bootstrap | Runtime/generated subscriptions | `getStatus()`, `bootstrapChanged`, generated phase helpers | Hooks must expose readiness without polling hacks | Bridge status/events must preserve readiness payloads | Mostly done; audit docs/examples |
| WP-07 CRDT Fields | Runtime CRDT primitives | Generic CRDT field APIs, row metadata, Yjs envelope helpers | Keep editor adapters app-layer; expose field events | Bridge events must preserve CRDT field metadata | Track adapter docs and bridge parity |
| WP-11 Offline Auth Leases | Server/Rust auth lease model | `issueAuthLease`, `leasedMutations`, active lease reads | Hooks/examples should show leased vs normal mutations | Bridges need strict leased mutation methods and errors | Needs interface-impact audit |
| WP-13 Observability | Runtime/server diagnostics | Diagnostic snapshots/support bundles | Support hooks should expose stable diagnostics, not raw internals | Bridge diagnostics must match native event/error JSON | Needs docs/testkit parity check |
| WP-15 Error Taxonomy | Core/server/runtime taxonomy | Stable `code/category/retryable/recommendedAction` in thrown errors/events | Hooks must surface stable error objects | Bridges must preserve error shape | Mostly done; keep in generated docs |
| WP-17 Lifecycle/App State | Runtime lifecycle model | `getStatus`, `on(...)`, `resumeFromBackground`, lifecycle events | Hooks must avoid poll-based status loops | Platform shells need app lifecycle entrypoints | Needs app-shell bridge audit |
| WP-21 Live Query Precision | Runtime observation | Kysely live query metadata, row/field deltas | Hooks must refresh from row/field events, not broad table guessing | Bridge events need precise changed rows/fields | Needs bridge parity test pass |
| WP-22 Undo/Redo Command History | Runtime/generated mutation history | `commandHistory.undoLast/redoLast`, generated mutation wrapping | Hooks should expose command-history state/actions when useful | Bridge packages need a decision: expose or explicitly defer | Needs explicit TS bridge milestone |
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

Start with the interface-impact audit. Do not add new feature behavior in this
WP until the owning feature WP states the canonical semantics and red lines.
