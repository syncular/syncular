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
- The generated contract must keep enough versioned client-schema history for
  the server to explicitly accept, transform, or reject older clients.
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
  client-row contract for notes"; it does not require a server database table
  named `notes`.
- The existing `createServerHandler` is a good same-shape/default-table helper,
  but it is currently typed around `TableName extends keyof ServerDB &
  keyof ClientDB`. Divergent server/client shapes need a generated/custom
  handler integration layer that treats the handler table as the
  client/protocol table id and leaves server database access to custom handler
  code.
- Different server/client shapes are first-class. Custom server handlers own
  translation from authoritative server rows to client replica rows and from
  client mutation payloads to server writes.
- Versioned schema handling is first-class. Server handlers can branch on the
  client's schema version using generated per-version row, mutation, scope, and
  binary snapshot metadata. Unsupported old versions should fail with a stable
  upgrade-required error that apps can turn into a "please update" screen.
- Backend-less apps are first-class. The same app contract should support
  local-only or local-sync-compatible clients without requiring a deployed
  Syncular server, while keeping the path open to add a backend later.
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

export const notesHandler = createAppServerHandler({
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

`createAppServerHandler` here is intentionally not the same as today's
same-shape `createServerHandler` convenience helper. The generated helper should
wire client/protocol table identity, generated scope metadata, validation,
binary snapshot metadata, and schema-version helpers while leaving server
queries and writes fully app-owned.

Older client schema versions should be handled from generated schema snapshots,
not from hand-written guesses:

```ts
export const notesHandler = createAppServerHandler({
  table: app.tables.notes,
  minClientSchemaVersion: 5,

  async applyOperation(ctx, op) {
    switch (ctx.schemaVersion) {
      case 5: {
        const mutation = app.tables.notes.v5.parseMutation(op);
        return applyNotesV5(ctx, mutation);
      }
      case 6: {
        const mutation = app.tables.notes.v6.parseMutation(op);
        return applyNotesV6(ctx, mutation);
      }
      case app.currentSchemaVersion: {
        const mutation = app.tables.notes.current.parseMutation(op);
        return applyNotesCurrent(ctx, mutation);
      }
      default:
        return app.rejectUnsupportedClientSchema(ctx, {
          minSupported: 5,
          current: app.currentSchemaVersion,
        });
    }
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

Apps without a backend should be able to use the same contract in a local mode:

```ts
export const app = defineSyncularClient({
  mode: 'local-sync-compatible',
  migrations: clientMigrations,
  tables: {
    notes: syncedTable({
      table: 'notes',
      primaryKey: 'id',
      serverVersion: 'server_version',
    }),
  },
});
```

In this mode the generated clients still get local SQLite setup, typed
query-builder reads, safe mutation APIs, row/field events, CRDT/blob/encryption
local behavior where available, and export/import/testkit support. They do not
need server handlers, auth, remote subscriptions, or hosted sync routes until
the app opts into remote sync.

The contract should distinguish two local cases:

- `local-sync-compatible`: mutations use the same outbox/safe-write semantics
  and can be synced later when a backend is added.
- `local-only`: tables or data that are explicitly never synced and may allow a
  different write/read policy.

## Scope

- Design the generated app contract boundary between static sync metadata,
  server handler behavior, and runtime extensions.
- Design the versioned generated schema boundary for older clients: row types,
  mutation payloads, scope metadata, binary snapshot columns/encoders,
  conflict server rows, blob/encryption/CRDT field metadata, and snapshot/pull
  transforms per supported schema version.
- Replace direct app-author editing of low-level `syncular.codegen.json` with a
  higher-level authoring surface or generated intermediate.
- Keep `syncular.codegen.json` only as a generated/intermediate/escape-hatch
  format if still useful.
- Generate explicit runtime artifacts that bundlers and native compilers can
  include without implicit filesystem reads.
- Preserve separate server and client schema shapes.
- Preserve `createServerHandler` imperative control for snapshots,
  `applyOperation`, authorization, scope resolution, and custom transforms.
- Add a generated/custom handler integration path for divergent server/client
  schemas where the handler table is the client/protocol table id, not
  necessarily a key in `ServerDB`.
- Generate validation helpers so server handlers can assert emitted rows and
  mutation payloads match the generated client contract.
- Generate version-aware validation/parse helpers for server handlers, so
  `ctx.schemaVersion` can select an actual generated historical schema.
- Generate a stable unsupported-client-schema error path that classifies as an
  upgrade-required lifecycle state on clients.
- Define backend-less app modes, including local-sync-compatible and local-only
  semantics.
- Generate client/runtime surfaces that work without a server for local
  SQLite, typed reads, safe mutations, events, CRDT/blob/encryption local
  behavior where supported, and export/import/testkit flows.
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
- Treating local-only raw writes as equivalent to sync-compatible mutations.
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
- Mark which current server APIs are same-shape defaults and which APIs already
  support divergent server/client shapes through raw `ServerTableHandler`.
- Document the accepted boundary in this WP and in product docs.

### Batch 2: Versioned Client Schema Contract

- Generate or retain historical schema snapshots for supported client
  versions.
- Expose per-version row and mutation payload types in TypeScript and Rust, and
  enough metadata for Swift/Kotlin/JVM generated clients to classify upgrade
  requirements.
- Generate per-version scope metadata and binary snapshot metadata so snapshot,
  pull, conflicts, revocation, and binary artifacts can target the requesting
  client schema.
- Add an explicit support policy: minimum supported client schema version,
  current schema version, and stable rejection for versions that cannot be
  handled.

### Batch 3: Runtime Artifact Shape

- Make generated TypeScript artifacts explicitly import or inline migrations.
- Make generated Rust/native migration artifacts self-contained for app
  packages.
- Ensure Cloudflare Worker and browser package examples do not rely on path
  strings for runtime migration inclusion.

### Batch 4: Higher-Level App Contract Authoring

- Add a developer-facing app contract authoring surface that emits the same
  `syncular.schema.json` as the current generator.
- Keep client replica metadata first-class:
  table names, primary keys, server versions, scopes, subscriptions, blob
  columns, encrypted fields, CRDT fields, local read models, local indexes, and
  schema version.
- Preserve Rust-first projects by allowing direct `syncular.schema.json`
  authoring/import if they do not want TypeScript authoring.
- Add explicit app modes for remote-sync, local-sync-compatible, and local-only
  use cases without duplicating the client contract.

### Batch 5: Server Handler Integration

- Keep today's `createServerHandler` as the default same-shape helper.
- Add a generated/custom server handler helper for `table: app.tables.notes`
  that does not require the protocol table to be a server database table.
- Keep `snapshot`, `applyOperation`, `resolveScopes`, `authorize`, and custom
  transforms app-owned.
- Add generated validation/type helpers for handler-emitted client rows and
  received mutation payloads.
- Support different server/client shapes through custom handler code, not a
  required mapping DSL.
- Add typed schema-version branching helpers so server code can handle old
  client payloads and snapshots intentionally.

### Batch 6: Runtime Extension Registry

- Define a clean extension/config boundary for auth lifecycle, diagnostics,
  network status, field encryption keys, encrypted CRDT config, blob policy,
  CRDT projection adapters, lifecycle events, rows-changed events, live
  queries, presence, and background behavior.
- Keep extension APIs platform-appropriate:
  closures/events in Rust and TypeScript, structured config plus event streams
  through FFI/native bindings.
- Ensure every extension with storage/wire semantics is backed by static
  generated contract metadata.

### Batch 7: Backend-Less App Flow

- Generate and document a no-server app path.
- Ensure TypeScript, Rust, Swift, Kotlin/JVM where applicable can open a local
  client, run migrations, read with typed query builders, write through safe
  mutation APIs, and receive row/field events without sync routes.
- Prove local-sync-compatible mode can later attach remote config without
  changing generated mutation semantics.
- Keep true local-only tables explicit so they cannot be mistaken for synced
  replica tables.

### Batch 8: Cross-Platform Generation And Conformance

- Verify the generated contract produces equivalent semantics for TypeScript,
  Rust, Swift, Kotlin, JVM, browser, and native bindings.
- Add conformance tests proving server/client shape divergence still works.
- Add conformance tests proving an older generated client can push, pull,
  receive conflicts, and bootstrap through version-specific server handling.
- Add conformance tests proving unsupported old client schema versions fail
  with an upgrade-required stable error and leave local state unchanged.
- Add tests proving migrations are included in bundled TS output and compiled
  native/Rust output.

## Acceptance Criteria

- App authors can define the client replica contract once and generate all
  platform clients from it.
- Server handlers retain imperative behavior and can use generated table
  references without requiring matching server table names.
- Client/server schema divergence is covered by tests and docs.
- Older supported client schema versions can be handled from generated
  per-version schema types/metadata instead of hand-written structural guesses.
- Unsupported client schema versions are rejected with a stable
  upgrade-required error and no local mutation side effects.
- Apps can be created without a backend and still get local schema install,
  typed reads, safe mutations, events, and later remote-sync compatibility when
  declared.
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
- Server/Hono schema-version compatibility tests covering supported and
  unsupported older client schema versions.
- Local/no-backend generated-client smokes for TypeScript and Rust at minimum.
- Native local/no-backend smokes when native generated surfaces change.
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
- Reject divergent-schema APIs that require the client/protocol table to also
  be a server database table.
- Reject schema-version handling that branches only on numbers without
  generated per-version payload/scope/snapshot metadata.
- Reject backend-less flows that bypass outbox/safe mutation semantics while
  claiming future sync compatibility.
- Reject implicit local-only writes on synced tables.
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
- Current `createServerHandler` is a useful same-shape/default helper, but its
  generic table constraint assumes the handler table is present in both
  `ServerDB` and `ClientDB`.
- Current lower-level `ServerTableHandler` and `createServerHandlerCollection`
  already use string table ids and can support generated client/protocol table
  identities if a helper supplies the right metadata.
- Current apply-operation contexts already expose `ctx.schemaVersion`, but
  codegen does not yet expose per-version client schema types/metadata for
  type-safe older-client handling.
- Current runtime/client surfaces already expose dynamic hooks for diagnostics,
  events, auth lifecycle, network status, encryption config, CRDT adapters,
  blobs, presence, and live queries.
- Current Rust/browser runtime pieces can already open local SQLite, install
  app schema, apply generated mutations, and emit row/event metadata; WP-33
  needs to shape this into a documented backend-less app mode instead of an
  implicit test/demo capability.

## Next Action

Start with Batch 1. Produce a short contract-boundary inventory before changing
code, explicitly noting the current `createServerHandler` same-shape constraint
and the lower-level `ServerTableHandler` path. Then design the smallest
versioned-schema contract slice that lets one old client schema version be
handled or rejected with generated metadata.
