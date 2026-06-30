# WP-49 Client API Hardening

Status: `[x]` accepted

## Goal

Close the highest-risk gaps found while comparing the Rust-first browser client
against the previous JavaScript client: awaited sync semantics, long-running
worker request policy, explicit live-query dependency control, and a concrete
design for generated apply/read-model extension points.

## Scope

- Make `SyncularClientLifecycle.sync()` resolve concurrent callers from the
  follow-up cycle they requested, not from the already-running cycle.
- Split browser worker request timeout policy by operation class so ordinary
  requests can still time out while sync, bootstrap, blob transfer, and storage
  maintenance are not capped by the short default.
- Let live queries pass explicit dependency hints for aliases/raw SQL while
  validating that hinted tables are part of the observed query dependency set
  and, when known, the generated app schema.
- Document the generated apply/read-model extension-point design needed for
  non-isomorphic server/client schemas, explicit projections, scope-aware local
  clearing, and deterministic conformance tests.

## Non-Goals

- Do not restore the deleted JavaScript sync engine or old protocol behavior.
- Do not add negotiated compatibility branches for legacy clients.
- Do not expose raw app-table writes as a synced mutation API.
- Do not add hidden caches. Local read models must stay explicit app/codegen
  intent.
- Do not implement the full generator extension contract in this slice; this
  package records the design and acceptance criteria for that follow-up.

## Product Contract Check

- Scoped access remains the data model: dependency hints must narrow reruns but
  must not let a query observe a table outside its declared dependencies.
- Remote sync remains handler/subscription based: local query dependency hints
  do not become remote SQL subscriptions.
- Server authority is unchanged: worker timeout policy cannot turn a stalled
  request into accepted local state.
- Client and server schemas stay independent: generated apply/projection hooks
  are the intended bridge, not a requirement that server rows match local rows.
- Query-builder-first reads remain canonical; generated helpers are for
  mutations, subscriptions, codecs, diagnostics, and read-model lifecycle.
- Synced writes still go through generated mutations/outbox APIs.
- Realtime remains a fast wake/delta path with HTTP recovery; live-query hints
  only control local rerun precision.

## Generated Apply / Read-Model Design

The Rust-first client is correct to own SQLite, but the generator still needs a
first-class extension contract for apps whose server schema and local UX schema
are not identical. The design should add explicit generated metadata and hooks,
not loose runtime plugins.

1. Projection metadata
   - Each synced table should declare the client row shape separately from the
     server authority row shape.
   - Generated server handlers should keep `projectChangeForVersion` and
     snapshot projection as the canonical server-to-client path.
   - Generated clients should expose the client table shape only; server-only
     fields must not leak into Kysely/Diesel client schemas.

2. Apply hooks
   - Generated table config should allow a typed `applyRemoteRow` hook for
     tables that need custom local projection, redaction, denormalization, or
     multi-table local writes.
   - The hook must run inside the runtime apply transaction and return the
     exact local rows/tables touched so live queries and read models can be
     invalidated deterministically.
   - Hook output must be validated against generated local schema metadata.

3. Scope clearing hooks
   - If scope metadata is not stored directly on the local synced row, the
     generator must require an explicit `clearRevokedScope` hook.
   - Scope shrink must delete or update only rows no longer covered by any
     retained scope.
   - The hook must be testable with overlapping scopes so it cannot pass by
     deleting a whole table.

4. Read-model lifecycle
   - Local read models stay declared in `generated/syncular.codegen.json`; no
     hidden cache creation.
   - Generated setup/rebuild SQL should remain deterministic and versioned.
   - Incremental read-model maintenance can use SQLite triggers for simple
     models and generated apply hooks for models that cross table/projection
     boundaries.

5. Conformance tests
   - Add a fixture where server rows contain extra authority fields and client
     rows contain a projected local shape.
   - Add a fixture where revoked scope metadata lives outside the projected
     client row and requires explicit clear logic.
   - Prove browser TypeScript, Rust/Diesel, and native JSON bindings see the
     same projected client schema and clearing behavior.

## Acceptance Criteria

- `database.sync()` callers queued behind an in-flight sync wait for exactly one
  follow-up cycle, including failure cases.
- Worker request timeout policy keeps the old numeric all-request override but
  defaults object-based policy to no short timeout for sync/bootstrap/blob/
  storage-maintenance requests.
- Live-query aliases and raw compiled SQL have a safe explicit dependency-hint
  path, and hints cannot reference tables outside the observed dependencies.
- The generated apply/read-model design above is captured as the follow-up
  contract for non-isomorphic schemas and scope clearing.
- Focused TypeScript tests, package typecheck, and touched-file formatting pass.
- No compatibility-register entry is needed because this slice does not add a
  legacy protocol branch, fallback, alias, or old JS behavior.

## Required Gates

- `bun test packages/client/src/client.test.ts packages/client/src/worker-client.test.ts packages/client/src/database.test.ts`
- `bun run --cwd packages/client tsgo`
- `bunx biome check packages/client/src/client.ts packages/client/src/client.test.ts packages/client/src/types.ts packages/client/src/worker-client.ts packages/client/src/worker-client.test.ts packages/client/src/database.ts packages/client/src/database.test.ts rust/docs/ROADMAP.md rust/docs/work-packages/README.md rust/docs/work-packages/WP-49-client-api-hardening.md`
- `bun run rust:codegen:check` before implementing the generator extension
  follow-up.
- Browser/WASM gates from `QUALITY_GATES.md` if the worker protocol, generated
  bridge, WASM runtime, or generated code output changes.

## Current Evidence

- Baseline review: the Rust-first client has stronger persistence, mutation,
  offline, scope, blob, CRDT, and native-binding foundations than the previous
  JavaScript client, but it exposed four practical gaps: manual sync promises
  could resolve too early, one 30s worker timeout was too blunt for bootstrap,
  live-query precision needed an explicit hint escape hatch, and generated
  apply/read-model extension points need a real contract for non-isomorphic
  schemas.
- `bunx biome check packages/client/src/client.ts packages/client/src/client.test.ts packages/client/src/types.ts packages/client/src/worker-client.ts packages/client/src/worker-client.test.ts packages/client/src/database.ts packages/client/src/database.test.ts rust/docs/ROADMAP.md rust/docs/work-packages/README.md rust/docs/work-packages/WP-49-client-api-hardening.md`
  passed locally on 2026-06-30 after formatting the touched TypeScript files.
- `PATH="/tmp/syncular-bun-1.3.9-install/bin:$PATH" bun run --cwd packages/client tsgo`
  passed locally on 2026-06-30 with repo-pinned Bun 1.3.9.
- `PATH="/tmp/syncular-bun-1.3.9-install/bin:$PATH" bun test packages/client/src/client.test.ts packages/client/src/worker-client.test.ts packages/client/src/database.test.ts`
  passed locally on 2026-06-30 with repo-pinned Bun 1.3.9: 71 pass, 0 fail.

## Implementation Log

- 2026-06-30: Added queued sync waiters so concurrent `sync()` callers are
  resolved or rejected by the requested follow-up cycle.
- 2026-06-30: Added worker timeout classes with object policy defaults that
  leave sync/bootstrap, blob, and storage maintenance uncapped while preserving
  numeric all-request behavior.
- 2026-06-30: Added live-query `dependencyHints` options, observed-table
  validation, and tests for aliases, raw compiled SQL, and invalid hints.
- 2026-06-30: Captured the generated apply/read-model design and follow-up
  conformance requirements in this work package.

## Next Action

Open a separate generator-focused work package for the apply/read-model
extension contract instead of expanding this accepted browser-client hardening
slice.
