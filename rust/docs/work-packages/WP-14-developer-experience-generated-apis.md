# WP-14 Developer Experience And Generated APIs

Status: `[x]` accepted

## Goal

Make generated Syncular clients feel excellent for app developers while keeping
the Rust runtime as the source of sync correctness.

## Scope

- Clearer generated mutation APIs for create, update, delete, batch, and
  domain-specific operation helpers.
- Typed subscription builders with stable subscription IDs, table names, scope
  values, and generated validation.
- Generated conflict helpers that expose conflict state without pushing repair
  logic into app code.
- Generated diagnostic/debug hooks that connect app code to WP-13 client
  snapshots and event streams.
- Better public error messages with stable codes and remediation hints from
  WP-15.
- Documentation examples that match real app flows, including bootstrap,
  mutations, subscriptions, conflicts, realtime, and local reads.

## Non-Scope

- Replacing query-builder-first local reads with table-specific ORM methods.
- Exposing raw app-table writes as synced write APIs.
- Preserving old JS/client protocol behavior or generated compatibility
  aliases.

## Acceptance Criteria

- Generated APIs make common app flows obvious without hiding mutation/outbox,
  scope, authorization, or conflict semantics.
- Subscription builders produce stable IDs and explicit scope values.
- Generated mutation helpers route through the current Rust-first mutation path.
- Conflict helpers preserve server authority and local intent.
- Browser, Rust, Swift, Kotlin, and JVM generated surfaces stay semantically
  aligned where supported.
- Docs include at least one end-to-end generated client flow that exercises
  typed reads, mutations, subscriptions, diagnostics, and conflicts.

## Required Gates

- Generator checks and generated example/smoke tests.
- Browser worker/package typechecks when generated TypeScript changes.
- Native binding smokes when Swift/Kotlin/JVM generation changes.
- Runtime tests when helper APIs touch mutation, conflict, or subscription
  behavior.

## Accept / Reject Rule

- Retain generated API changes only if they improve app ergonomics without
  adding synced-write escape hatches or weakening server-authoritative sync.
- Reject APIs that make subscriptions look like arbitrary remote SQL queries.
- Reject convenience aliases that preserve old protocol/client behavior unless
  explicitly recorded in `COMPATIBILITY_REGISTER.md`.

## Current Evidence

The Rust-first runtime already supports generated safe mutations, typed local
read surfaces, subscriptions, conflicts, browser worker clients, and native
bindings. The remaining gap is the app-facing shape: generated APIs should make
the correct sync path easy and make incorrect paths hard to reach.

## Next Action

WP-14 is accepted for the current generated-client foundation. Reopen this work
package only when real app integration feedback exposes concrete naming,
discoverability, conflict, blob, or subscription ergonomics gaps.

## Progress

- TypeScript generated app databases now expose generated mutation types on
  `database.mutations`. Inserts accept `New{Table}` and updates accept
  `{Table}Patch` instead of full app rows, so app code no longer has to provide
  server-owned columns such as `server_version`.
- The generated mutation type is a type-level wrapper over the existing
  Rust-first mutation/outbox path; it does not add raw table-write escape
  hatches or change runtime semantics.
- Added browser generated-conformance coverage proving the typed generated
  mutation surface produces the same clean outbox/local-row payloads.
- Swift and Kotlin generated native clients now expose `diagnosticSnapshot()`
  helpers over the runtime `diagnosticSnapshotJson()` host method, so apps can
  inspect WP-13 snapshots without parsing raw JSON strings.
- The generated native diagnostics helper is covered by codegen assertions and
  Swift/Kotlin generated-client smokes; BoltFFI-backed native smoke wrappers
  delegate the host diagnostic method directly.
- Generated Rust, TypeScript, Swift, and Kotlin mutation input/payload types now
  omit CRDT `stateColumn` fields. Rows, query builders, changed-row helpers,
  and table metadata still expose those fields for observation/debugging, but
  app-facing synced writes must use generated CRDT helpers or Yjs envelopes.
- Added a generator regression test proving CRDT state columns remain readable
  while being removed from generated insert/patch mutation surfaces across Rust,
  TypeScript, Swift, and Kotlin.
- Added `reference/GENERATED_CLIENT_API.md` as the concise cross-platform API
  guide for generated Rust, Browser TypeScript, Swift, and Kotlin clients. It
  documents typed query-builder reads, outbox-safe mutations, CRDT helper
  writes, diagnostics, live queries, and row-delta routing in one place.
- Swift and Kotlin generated native row mutations now use table namespaces:
  `client.mutations.tasks.insert/update/delete` for synchronous host calls and
  `client.queuedMutations.tasks.insert/update/delete` for worker-queued UI
  writes. The old direct row helpers are removed from generated output; CRDT
  field helpers remain field-specific.
- Browser React apps now use the Rust-backed ergonomic factory
  `createSyncularReact()`. The old lower-level React surface
  (`createSyncularReact`, `useLiveQuery`, callback-style `useMutation`, and
  direct client hooks) is removed from public docs and tests. The retained hooks
  cover typed Kysely reads, generated/table mutations, connection state, outbox
  and conflict counters, presence, and blobs.
- Non-React browser apps now use the Rust-backed ergonomic factory
  `createSyncularClient()`. It keeps typed Kysely reads and generated/table
  mutations while adding `on(...)`, `getStatus()`, `setSubscriptions(...)`,
  `presence`, and `conflicts` namespaces over the current Rust client events and
  operations.
- Tauri, React Native, and Expo have separate bridge packages that depend on
  `@syncular/client` for shared TypeScript ergonomics. They expose platform
  client factories plus React factories that reuse the same `SyncProvider` and
  hooks with a bridge-backed client instead of the browser Worker/WASM runtime.
- `@syncular/testkit` now includes an in-process client bridge harness with
  SQLite-backed reads/writes plus Tauri and React Native adapter surfaces, so
  platform client packages test against a Syncular-owned host contract instead
  of package-local mocks.
- Generated TypeScript partial updates now keep sync payloads partial while
  materializing complete local SQLite rows for NOT NULL columns, so updates such
  as `{ completed: 1 }` no longer fail local apply when the row has required
  fields like `title`.

## Latest Evidence

- `bun test packages/client/src/react.test.ts packages/client/src/generated-app-conformance.test.ts`
- `bun test packages/client/src/bridge-client.test.ts`
- `bun test packages/client-tauri/src/index.test.ts packages/client-react-native/src/index.test.ts packages/client/src/bridge-client.test.ts`
- `bun run client:test`
- `bun run --cwd packages/testkit tsgo`
- `bun run --cwd packages/client-tauri tsgo`
- `bun run --cwd packages/client-react-native tsgo`
- `bun run --cwd packages/client tsgo`
- `bun run tsgo`
- `bun run docs:build`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-todo-app-example`
- `bun test packages/client/src/generated-app-conformance.test.ts`
- `bun run --cwd packages/client tsgo`
- `bash rust/examples/todo-app/native-smokes/run-local.sh`
