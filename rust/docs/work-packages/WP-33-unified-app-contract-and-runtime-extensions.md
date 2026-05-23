# WP-33 Unified App Contract And Runtime Extensions

Status: `[ ]` planned

## Goal

Restore the pre-Rust Syncular ergonomics where client, server, scopes,
migrations, and generated typings are easy to reason about from one app
contract, without forcing the server database shape to match the client replica
shape and without turning server behavior into a declarative mapping DSL.

The generated contract should describe the client replica and sync semantics.
Server handlers and runtime extensions should remain explicit app code.

## Problem

The Rust-first path currently has good mechanical pieces, but app authors must
coordinate several surfaces manually:

- SQL migrations for the local replica.
- `syncular.codegen.json` metadata for tables, scopes, blobs, CRDT fields,
  encryption, generated outputs, and subscriptions.
- Server handlers that define `snapshot`, `applyOperation`, `resolveScopes`,
  and custom server-shape translation.
- Runtime options and extension points such as auth refresh, encryption keys,
  diagnostics, events, CRDT projections, blob policy, network status, and
  lifecycle behavior.

That split creates drift risk. It also makes the Rust-first client feel less
cohesive than the earlier TypeScript system, where migrations/scopes/handlers
were closer to one typed authoring model.

## Core Decisions

- The stable center is a language-neutral generated `syncular.schema.json`.
- A TypeScript authoring DSL may exist, but it is not the cross-platform
  runtime API.
- Build-time config may reference paths. Runtime artifacts must not depend on
  path strings for migrations or metadata.
- Generated TypeScript runtime artifacts should explicitly import or inline
  migrations so bundlers such as Cloudflare Workers include them.
- Generated Rust/native artifacts should embed migration SQL through generated
  string literals or `include_str!`; app packages should not need loose `.sql`
  files at runtime.
- The contract describes the client replica shape: local tables, columns,
  scopes, migrations, mutations, subscriptions, blob/encryption/CRDT metadata,
  local read models, and event metadata.
- Server behavior remains imperative through `createServerHandler({ table:
  app.tables.notes, snapshot, applyOperation, resolveScopes, ... })`.
- `app.tables.notes` means "this handler emits and accepts the generated
  client-row contract for notes"; it does not require a server table named
  `notes`.
- Different server/client shapes are first-class. Custom server handlers own
  translation from authoritative server rows to client replica rows and from
  client mutation payloads to server writes.
- Runtime hooks/plugins are installed after generation. They are not embedded
  as executable behavior in the schema contract.
- Extensions with storage/wire semantics, such as encrypted fields or CRDT
  fields, must have static declarations in the generated contract even when the
  runtime supplies keys, adapters, or event handlers later.

## Proposed Authoring Shape

The exact API is still open, but the desired split is:

```ts
// syncular.client.ts or syncular.app.ts, build/dev-time authoring.
import { clientMigrations } from './client.migrations';

export const app = defineSyncularClient({
  migrations: clientMigrations,
  tables: {
    notes: syncedTable({
      table: 'notes',
      primaryKey: 'id',
      serverVersion: 'server_version',
      scopes: [
        { name: 'user_id', column: 'owner_user_id', source: 'actorId' },
      ],
      crdt: {
        content: yjsText({ stateColumn: 'content_yjs_state' }),
      },
    }),
  },
});
```

Codegen consumes that and emits:

- `syncular.schema.json`
- generated TypeScript client/server references
- generated Rust Diesel schema, app metadata, mutations, subscriptions, and
  embedded migrations
- generated Swift/Kotlin/JVM client contracts
- generated conformance fixtures/snapshots

Server behavior remains app-owned:

```ts
import { app } from './generated/syncular.app';

export const notesHandler = createServerHandler({
  table: app.tables.notes,

  async resolveScopes(ctx) {
    return { user_id: [ctx.actorId] };
  },

  async snapshot(ctx) {
    const rows = await ctx.db
      .selectFrom('documents')
      .select([
        'id',
        'title',
        'content as body',
        'owner_id as owner_user_id',
        'version as server_version',
      ])
      .where('owner_id', '=', ctx.actorId)
      .execute();

    return { rows, nextCursor: null };
  },

  async applyOperation(ctx, op) {
    // App-owned translation from generated client mutation shape to
    // authoritative server writes.
  },
});
```

Runtime extensions are configured after generation:

```ts
const client = await createSyncularClient({
  app,
  config: { baseUrl, clientId, actorId },
  authLifecycle,
  extensions: [
    fieldEncryption({ getKey: async ({ scope }) => keyring.keyFor(scope) }),
    crdtDocuments({ flushDelayMs: 16 }),
  ],
  events: {
    rowsChanged(event) {
      // App bridge/read-model/editor integration.
    },
  },
});
```

Native/Rust uses generated native artifacts instead of importing the TypeScript
authoring file:

```rust
let client = SyncularClient::builder(generated::syncular::APP_SCHEMA)
    .base_url(base_url)
    .client_id(client_id)
    .actor_id(actor_id)
    .build()?;
```

## Scope

- Design the generated app contract boundary between static sync metadata,
  server handler behavior, and runtime extensions.
- Replace direct app-author editing of low-level `syncular.codegen.json` with a
  higher-level authoring surface or generated intermediate.
- Keep `syncular.codegen.json` only as a generated/intermediate/escape-hatch
  format if still useful.
- Generate explicit runtime artifacts that bundlers and native compilers can
  include without implicit filesystem reads.
- Preserve separate server and client schema shapes.
- Preserve `createServerHandler` imperative control for snapshots,
  `applyOperation`, authorization, scope resolution, and custom transforms.
- Generate validation helpers so server handlers can assert emitted rows and
  mutation payloads match the generated client contract.
- Generate or expose typed plugin/extension configuration surfaces where static
  contract data is required, especially encryption, CRDT fields, blobs, and
  live row/field metadata.
- Update docs to explain the three layers:
  generated contract, server behavior, runtime extensions.

## Non-Scope

- Replacing custom server handlers with a declarative ORM/mapping DSL.
- Forcing server and client migrations to be the same.
- Making TypeScript authoring files required at runtime for Rust, Swift,
  Kotlin, JVM, or browser packages.
- Reintroducing the old JavaScript client as a parallel product path.
- Allowing raw app-table synced writes.
- Hiding explicit app intent behind automatic caches or implicit read models.
- Preserving compatibility with old config/protocol shapes unless explicitly
  recorded in `COMPATIBILITY_REGISTER.md`.

## Work Batches

### Batch 1: Contract Design And Drift Audit

- Inventory all current generated metadata and hand-written metadata:
  `syncular.codegen.json`, `syncular.schema.json`, generated TS/Rust/Swift/
  Kotlin outputs, server handler table metadata, CRDT/blob/encryption config,
  local read models, and conformance fixtures.
- Mark which fields are static contract, generated intermediate, server
  behavior, or runtime extension.
- Document the accepted boundary in this WP and in product docs.

### Batch 2: Runtime Artifact Shape

- Make generated TypeScript artifacts explicitly import or inline migrations.
- Make generated Rust/native migration artifacts self-contained for app
  packages.
- Ensure Cloudflare Worker and browser package examples do not rely on path
  strings for runtime migration inclusion.

### Batch 3: Higher-Level App Contract Authoring

- Add a developer-facing app contract authoring surface that emits the same
  `syncular.schema.json` as the current generator.
- Keep client replica metadata first-class:
  table names, primary keys, server versions, scopes, subscriptions, blob
  columns, encrypted fields, CRDT fields, local read models, local indexes, and
  schema version.
- Preserve Rust-first projects by allowing direct `syncular.schema.json`
  authoring/import if they do not want TypeScript authoring.

### Batch 4: Server Handler Integration

- Make `createServerHandler({ table: app.tables.notes, ... })` the canonical
  generated-handler style.
- Keep `snapshot`, `applyOperation`, `resolveScopes`, `authorize`, and custom
  transforms app-owned.
- Add generated validation/type helpers for handler-emitted client rows and
  received mutation payloads.
- Support different server/client shapes through custom handler code, not a
  required mapping DSL.

### Batch 5: Runtime Extension Registry

- Define a clean extension/config boundary for auth lifecycle, diagnostics,
  network status, field encryption keys, encrypted CRDT config, blob policy,
  CRDT projection adapters, lifecycle events, rows-changed events, live
  queries, presence, and background behavior.
- Keep extension APIs platform-appropriate:
  closures/events in Rust and TypeScript, structured config plus event streams
  through FFI/native bindings.
- Ensure every extension with storage/wire semantics is backed by static
  generated contract metadata.

### Batch 6: Cross-Platform Generation And Conformance

- Verify the generated contract produces equivalent semantics for TypeScript,
  Rust, Swift, Kotlin, JVM, browser, and native bindings.
- Add conformance tests proving server/client shape divergence still works.
- Add tests proving migrations are included in bundled TS output and compiled
  native/Rust output.

## Acceptance Criteria

- App authors can define the client replica contract once and generate all
  platform clients from it.
- Server handlers retain imperative behavior and can use generated table
  references without requiring matching server table names.
- Client/server schema divergence is covered by tests and docs.
- Generated runtime artifacts do not depend on implicit migration path strings.
- Runtime extension points remain dynamic and app-owned, but static protocol/
  storage implications are declared in the app contract.
- Existing Rust, browser TypeScript, Swift, Kotlin, JVM, and testkit generated
  outputs continue to pass conformance.
- The docs clearly distinguish generated contract, server behavior, and runtime
  extensions.

## Required Gates

- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-todo-app-example`
- `bun test packages/client/src/generated-app-conformance.test.ts`
- `bun run --cwd packages/client tsgo`
- `bun run --cwd packages/server tsgo`
- `bun run rust:conformance:fast`
- Native Swift/Kotlin/JVM smoke gates when generated native output changes.
- Docs type/build gates when docs are updated.
- Browser package size gate if generated browser runtime/package exports change.

## Accept / Reject Rule

- Accept changes that reduce schema/config drift while preserving explicit
  server authority and query-builder-first client reads.
- Reject changes that turn server behavior into a required mapping DSL.
- Reject generated APIs that imply remote sync is arbitrary SQL/query pushdown.
- Reject runtime artifacts that require implicit filesystem reads after
  bundling or app packaging.
- Reject extension APIs that hide storage/wire semantics outside the generated
  contract.

## Current Evidence

- Current Rust codegen already emits `syncular.schema.json`, generated Rust
  app metadata, Diesel schema, migrations, TypeScript, Swift, and Kotlin
  outputs.
- Current app examples still use low-level `syncular.codegen.json` as an
  author-edited contract.
- Current server handlers already support imperative `snapshot` and
  `applyOperation` behavior, plus server push/pull plugins.
- Current runtime/client surfaces already expose dynamic hooks for diagnostics,
  events, auth lifecycle, network status, encryption config, CRDT adapters,
  blobs, presence, and live queries.

## Next Action

Start with Batch 1. Produce a short contract-boundary inventory before changing
code, then implement the smallest migration-inclusion/runtime-artifact slice
that removes one real drift/bundling risk.
