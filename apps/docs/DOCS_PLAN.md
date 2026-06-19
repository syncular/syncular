# Docs restructure plan

From the 2026-06-11 documentation audit (full audit in the session that
produced this file; summary below). Owner verdict: docs are "not great";
restructure + rewrite so users can easily dive into all parts.

## Diagnosis (top problems, ranked)

1. No working end-to-end quickstart — every entry page defers to another.
2. Scopes/auth taught three times (learn/, server/, features/) with no canon.
3. Blobs/CRDT/presence/encryption each documented in 2–3 places.
4. Reference pages are auto-generated stubs without narrative.
5. Conflict resolution split across learn/ and features/ with no reading order.
6. Landing → quickstart trajectory broken ("run the framework tests" ≠ hello world).
7. Client config (15+ tuning options) entirely undocumented.
8. Operations/observability/troubleshooting disconnected; no production checklist.
9. Missing: migrations depth, local read models, undo/redo patterns, auth
   leases, realtime reliability.
10. No error catalog, no protocol docs, no upgrade guide.

## Target information architecture

START HERE (what-is / is-it-for-me / hello-world / pick-your-path /
installation / compare) → CORE CONCEPTS (sync model, scopes, subscriptions,
conflicts, bootstrap, commits, glossary) → BUILD: JAVASCRIPT → BUILD: RUST →
BUILD: SERVER → FEATURES (one canonical page per capability + recipes) →
TEST AND DEPLOY (testing, deployment, observability, scale, console,
troubleshooting tree) → REFERENCE (config reference, HTTP API by feature,
CLI, error codes, protocol, upgrade guide).

Full per-page tree and per-phase details live in the audit output; phases:

- Phase 1 — Foundation: hello-world (uses create-syncular-app), is-it-for-me,
  canonical scopes page, conflict rewrite, nav restructure of start/.
  Delete start/basic-setup, merge start/fresh-apps.
- Phase 2 — Client guides: client-configuration reference (all options),
  quick-start rewrite, generated-client expansion, host-integration preambles,
  JS + Rust troubleshooting pages.
- Phase 3 — Server: split setup-with-hono into linear getting-started +
  per-topic pages (table handlers w/ worked examples, authorization canon,
  bootstrap/snapshots, push/conflicts, realtime, blobs, deployment targets,
  troubleshooting).
- Phase 4 — Features: consolidate conflict/encryption/realtime+presence/
  CRDT/blobs to one canonical page each; expand migrations, read models,
  auth leases, undo/redo, audit; flesh out the four recipes end-to-end.
- Phase 5 — Test & deploy: testing strategy layers, deployment (Docker/CF/
  Fly/VPS), observability (metrics to watch), scale/tuning, console section
  consolidation, symptom→diagnosis troubleshooting tree.
- Phase 6 — Reference: configuration reference (client+server+CLI), HTTP API
  grouped by feature with error shapes, error-code catalog, protocol page,
  upgrade guide.

## Constraints

- Keep `bun run docs:stale-check` green; extend its patterns when retiring
  pages so old paths/names can't resurface.
- Hello-world must use the real current APIs (binary protocol era,
  `@syncular/server/<driver>` subpaths, scoped packages — never umbrella
  imports) and
  reference `create-syncular-app` once it exists.
- Every moved page needs its old URL redirected or the nav updated — check
  how apps/docs handles redirects before deleting paths.

## Status

- 2026-06-11: Audit done, plan recorded. Execution pending (after demo app
  rebuild + create-syncular-app land, since hello-world builds on them).
- 2026-06-11: **Phase 1 done.** Decisions taken:
  - **Redirects:** apps/docs supports Next.js `redirects()` in
    `next.config.mjs`; retired slugs get permanent redirects there
    (`/start/adoption-paths` and `/start/fresh-apps` →
    `/start/pick-your-path`, `/start/good-fit` → `/start/is-syncular-for-me`,
    `/start/basic-setup` → `/start/installation`). Stale patterns added in
    `scripts/check-docs-stale-patterns.ts` so the old paths can't resurface
    in content.
  - **New pages:** `start/is-syncular-for-me` (decision guide; absorbs
    `good-fit`), `start/pick-your-path` (merges `adoption-paths` +
    `fresh-apps` into fresh/existing/evaluate paths),
    `start/hello-world` (placeholder framing + real minimal end-to-end
    snippet adapted from apps/demo; TODO marker for the
    create-syncular-app one-liner).
  - **Deleted:** `start/basic-setup` (URL convention folded into
    `start/installation`, corrected: `config.baseUrl` points at the sync
    mount itself, e.g. `https://host/api/sync` — matches apps/demo and
    client tests).
  - **Nav:** start/ reordered learner-first (what-is → is-it-for-me →
    hello-world → pick-your-path → installation). `quick-start` kept in nav
    pending its Phase 2 rewrite; `testing-and-confidence` kept under
    Evaluate Fit (pick-your-path's "evaluate first" path links to it).
  - **Scopes canon:** `learn/scopes` is the conceptual canon (now includes
    the client-subscription request side; deep `authenticate()` wiring
    removed in favor of a link). `server/scopes-and-auth` is
    implementation-only and links to the canon.
  - **Conflicts canon:** `learn/conflict-resolution` is the mechanism canon
    (React banner/`useConflictStats` UI moved to
    `features/conflict-resolution`, which keeps the product flow and links
    back).
  - Phase 1 hello-world ships without create-syncular-app (it hasn't landed);
    the page is honest about that and already useful.
- 2026-06-12: **Phase 3 done** (server section). Decisions taken:
  - **New pages:** `server/getting-started` (linear bring-up: install →
    Postgres or sqlite quick path → user-owned tasks handler modeled on
    apps/demo → `createSyncServer` mount → first sync via curl with the
    current combined `POST /` protocol — pull carries `schemaVersion`,
    push carries idempotent `commits[]`), `server/troubleshooting`
    (handler not called, unexpectedly-revoked subscriptions incl. the new
    fail-loud resolveScopes/scope-key errors, snapshot timeouts, stalled
    cursors, 413 byte-limit defaults).
  - **Retired:** `server/setup-with-hono` → redirect to
    `/server/getting-started` in next.config.mjs + stale pattern in
    scripts/check-docs-stale-patterns.ts; all content-tree links rewritten.
    Notable: the old page documented separate `/push` and `/pull` endpoints
    that no longer exist — the docs now describe the combined `POST /` route.
  - **Expanded:** `server/table-handlers` (worked examples: user-owned,
    multi-scope membership, codecs; deletes are hard deletes — soft delete
    documented as an app-level tombstone pattern since create-handler has no
    built-in option; applyOperation result/error-shape table with the real
    codes; fail-loud resolveScopes; write-path scope authorization semantics
    — all declared scope keys required, `'*'` wildcard).
  - **Renamed nav titles, slugs kept:** scopes-and-auth → "Authorization"
    (added requested-vs-resolved scope-key validation, revocation triggers,
    wildcard + scopeCache notes from subscriptions/resolve.ts; fixed a wrong
    `status: 'rejected'` op-result example to the real `error` shape),
    snapshot-pull → "Bootstrap & Snapshots" (chunking/caching mechanics,
    binary-table-v1 chunks, snapshotBinaryColumns guidance — typegen wires it,
    hand-rolled handlers should supply it to skip per-page column inference;
    snapshot artifacts), apply-push → "Push & Conflicts" (batch request/
    response shape with applied/cached/rejected commit statuses, atomic
    rollback on rejection, conflict detection via base_version with the real
    snake_case conflict payload, emitted-changes rules, limits).
  - **meta.json:** Getting Started / Core / Realtime & Blobs / Integration /
    Deployment / Advanced / Troubleshooting; server/index cards regrouped to
    match.
- 2026-06-12: **Phase 2 done** (client guides). Decisions taken:
  - **New pages:** `clients/javascript/client-configuration` (full
    `CreateSyncularDatabaseOptions` + `SyncularClientConfig` reference; all
    defaults verified against `packages/client/src` and
    `rust/crates/runtime/src/core/limits.rs` /
    `rust/crates/runtime/src/web/client.rs`; three worked tuning scenarios)
    and `clients/javascript/troubleshooting` (symptom→cause→fix grounded in
    `@syncular/core` error codes and `packages/client/src/errors.ts` /
    `wasm-runtime.ts`).
  - **Rewritten:** `start/quick-start` now leads with
    `bunx create-syncular-app` and tours the scaffolded layout
    (migrations → syncular.app.ts → generate → server → client), linking to
    hello-world for the manual walkthrough instead of duplicating it. The
    "run the framework tests" framing is gone.
  - **Expanded:** `clients/javascript/generated-client` (generate pipeline:
    typegen handoff → Rust `syncular-codegen` binary with auto-install,
    generated outputs incl. server module / codegen.json / schema.json,
    when to regenerate, three-layer version handling).
  - **Nav:** `clients/javascript` and `clients/rust` meta.json reordered to
    Getting Started / Core APIs / Host Integration / Advanced Features /
    Testing / Troubleshooting; index pages' card sections mirror it. JS index
    gained the one-runtime/host-bridge architecture preamble; Rust index got
    the embed-direct equivalent.
  - **Deferred:** Rust `client-configuration` + `troubleshooting` mirrors —
    the native Rust config surface (`NativeClientConfig`,
    `NativeSyncularClientBuilder`, transport/worker options) differs enough
    from the JS worker surface that grounding it needs its own pass over
    `rust/crates/runtime/src/native/facade.rs`; revisit alongside the
    Phase 6 config reference. The Electron host page already existed, so no
    new host page was needed.
  - **Found in code:** the doc comments on `SyncularPushOptions` in
    `packages/client/src/types.ts` say adaptive batching tops out at 100,
    but the Rust runtime default (`DEFAULT_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT`)
    is 1000 — the new docs follow the Rust ground truth; the TS comment
    should be fixed.
- 2026-06-12: **Phase 6 done** (reference overhaul). Decisions taken:
  - **New pages:** `reference/errors` (canonical catalog of all 63 codes from
    `SYNCULAR_ERROR_DEFINITIONS` in `packages/core/src/error-responses.ts`,
    grouped sync/runtime+worker+storage/console/proxy/blob, with the JSON
    error envelope, the client classification order from
    `packages/client/src/errors.ts`, and a recommendedAction handling table);
    `reference/configuration` (createSyncServer options, all
    `SyncRoutesConfigWithRateLimit` limits + defaults from
    `server-hono/src/routes/shared.ts`, websocket/cors/rate-limit/prune/
    compact, console options, relay options, env vars; links the Phase 2
    client-configuration page instead of duplicating it);
    `reference/protocol` (SSP1 orientation grounded in
    `packages/core/src/sync-packs.ts` + `tests/load/lib/ssp1.js`: envelope,
    wire v14 strictness, push/pull sections, SBT1 row groups, chunk/artifact
    refs incl. the scopes query-param requirement — explicitly not a
    byte-level spec); `reference/upgrade-guide` (alpha pin-versions policy,
    dialect helpers moving to `@syncular/server/<driver>` + CLI-only umbrella
    as shipped breaking changes,
    clientSchemaSupport/requiredSchemaVersion upgrade ordering, points at
    rust/docs/COMPATIBILITY_REGISTER.md as the authoritative removal record).
  - **HTTP API:** the per-endpoint pages under `reference/api/*` are
    generated by `bun --cwd apps/docs generate:openapi` (fumadocs-openapi
    from `packages/server/openapi.json`) and were left untouched;
    `api/meta.json` was already hand-grouped by feature and kept.
    `api/index.mdx` rewritten around cross-cutting semantics: combined
    `POST /sync` (JSON request, always-binary SSP1 response), clientCommitId
    idempotency with applied/cached/rejected statuses, the cursor/bootstrap
    model, snapshot-chunk scope re-authorization, the shared error envelope,
    and feature-grouped endpoint tables linking into the generated pages.
  - **Rewritten:** `reference/server/table-handlers-reference` is now a real
    options reference — every `CreateServerHandlerOptions` field from
    `packages/server/src/handlers/create-handler.ts` with type/default/
    guidance, "what the defaults do" (write-path scope authorization,
    base_version conflict semantics, batch fast path + savepoint hint), and
    the corrected `ServerTableHandler`/context types from `handlers/types.ts`
    (old stub omitted `auth` on ServerContext, `schemaVersion` on snapshot
    ctx, `authLease`, `applyOperationBatch`, `projectChangeForVersion`).
    `reference/packages-crates` accuracy pass: added create-syncular-app,
    `syncular` as CLI-only, @syncular/core, dialects subpaths,
    transport-http, server-service-worker, relay, migrations, console,
    Sentry owner subpaths, typegen.
  - **CLI truth:** `packages/syncular/src/cli.ts` ships exactly `generate`
    and `codegen install`. Retired `reference/cli/create`, `cli/migrate`,
    `cli/console` (documented nonexistent `syncular create|migrate|console`,
    plus doctor/dev/typegen/spaces commands) → redirects in next.config.mjs
    (`create` → /start/quick-start, `migrate` and `console` →
    /reference/cli) + stale patterns for `/reference/cli/(create|migrate)`
    and `syncular (create|migrate|doctor|dev|typegen|login|deploy)`.
    `cli/index` rewritten to the two real commands with a "what the CLI does
    not do" section; `cli/generate` verified accurate and kept.
  - **meta.json:** reference root regrouped to Packages / Configuration
    (configuration + server) / CLI / HTTP API / Errors and Protocol /
    Upgrades; index cards mirror it.
  - **Deferred:** a stale pattern for `/reference/cli/console` and the
    `syncular console` command phrase — `operate/console-integration.mdx`
    (owned by the Phase 5 agent in this round) still documents the
    nonexistent `syncular console` command and links the retired page; the
    redirect covers old URLs. Add the pattern once operate/ lands its
    console rewrite. Rust-side config reference mirror still deferred from
    Phase 2.
  - **Verification:** `bun run docs:stale-check` green (after rephrasing the
    upgrade guide so removed package names don't literally trip their own
    stale patterns); `bun --cwd apps/docs types:check` green; full
    `bun run build` (prepare:openapi + next build) green; internal links on
    all touched pages resolve to existing content files.
- 2026-06-12: **Phase 4 done** (features section). Decisions taken:
  - **Canonical pages, slugs kept:** `features/field-encryption` retitled
    "Encryption" and now covers all three surfaces (field rules +
    `setFieldEncryption`, encrypted CRDT via `sync_crdt_updates`/
    `createEncryptedCrdtSystemHandlers`, blob encryption) plus key-management
    patterns from the runtime `encryptionHelper` methods.
    `features/presence` retitled "Realtime & Presence" and absorbed the
    realtime mechanism story (hello/cursor catch-up, sync-pack deltas vs
    pull-required wake-ups, backoff+jitter reconnect, `pollIntervalMs`
    fallback); clients/* realtime pages stay host-specific. No slug renames,
    so no redirects needed.
  - **Conflicts:** `features/conflict-resolution` keeps the product flow,
    gained the managed `syncular.conflicts` API
    (list/retryKeepLocal/resolve with keep-local|keep-server|dismiss) and a
    testkit-grounded "Testing conflict flows" section
    (`createProjectScopedTasksHandler` + `pushCommit` asserting
    `sync.version_conflict`); mechanism teaching stays in learn/.
  - **Expanded:** crdt-fields (sync modes server-merge vs
    encrypted-update-log, `@syncular/server/crdt-yjs` push plugin,
    `@syncular/client/crdt-yjs`), blobs (route table, S3/filesystem/
    database adapters, full `syncular.blobs` surface, 64MB client / 100MB
    server default limits), offline-auth-leases (lease payload, ES256
    issuing, `POST /auth-leases/issue`, push-time validation),
    undo-redo (`SyncularCommandHistory` + error codes + demo
    `useCommandHistory` pattern), local-read-models (`countByReadModel`
    semantics), audit-and-history (all four `/sync/audit/*` routes +
    redaction-by-default), performance-patterns; error-handling got an
    error-catalog pointer to /reference (slug TBD by Phase 6) and its
    conflict section now defers to the conflicts page; data-modeling only
    got a wrong self-link fixed.
  - **Recipes:** all four rewritten as end-to-end shapes with current-API
    code (contract + `createServerHandler`/`createSyncServer` + generated
    client snippets modeled on apps/demo and create-syncular-app); noted
    that `scope(..., { source: 'projectId' })` is the contract form for
    shared-space scopes since generated subscription args are
    `{ actorId, projectId? }`.
  - **Verification:** docs:stale-check green; `tsc --noEmit` green (one
    transient failure was a `.source/` regeneration race with a parallel
    agent, not a content error); full `next build` green (555 pages);
    scripted link check over features/** found no broken internal links.
- 2026-06-12: **Phase 5 done** (test & deploy / operations). Decisions taken:
  - **testing/strategy** rewritten as the layered L1–L4 guide (handler tests,
    two-client convergence, offline/reconnect, conflicts) with runnable
    snippets verified against the *current* `@syncular/testkit` surface
    (`createHttpServerFixture`, `createProjectScopedTasksHandler`, protocol
    builders + `postSyncCombinedRequest`, `withFaults`) and the real client
    API (`createSyncularAppDatabase`, `client.syncPush/syncPull`,
    `client.diagnosticSnapshot()`); minimum-before-production checklist added;
    Rust testkit pointers (`rust/crates/testkit` modules). testing/index now
    defers the checklist to strategy; testing meta order: index → strategy →
    conformance.
  - **testing/conformance** rewritten around what the gates actually run
    (`rust/scripts/run-conformance-gates.sh` lanes →
    `bun run rust:conformance[:fast|:native]`, `rust/docs/QUALITY_GATES.md`)
    and what that buys users (don't re-test sync mechanics; do test your app
    contract; cross-language consistency is inherited).
  - **operate/deployment** rewritten: built-in `GET <mount>/health` (no DB
    touch — optional custom DB check documented), Docker/compose, Cloudflare
    (defers to /server/cloudflare + @syncular/server/cloudflare constraints),
    Fly.io (modern `[[http_service.checks]]`), self-hosted/VPS with nginx WS
    snippet, backups (incl. SQLite/Litestream + restore semantics).
    **Fixed wrong rate-limit shape**: real config is
    `{ maxRequests, windowMs }` with defaults 120 pull / 60 push per minute
    (old page said `{ windowMs, max }` with different numbers); CORS is
    `routes.cors` on the sync routes (protocol headers auto-allowed), not
    hono/cors; prune/compact under `routes.*` with verified defaults; compact
    silently disabled without `options` — documented.
  - **operate/observability** rewritten around the three real surfaces:
    server telemetry, console request events, client diagnostics
    (`diagnostics` sink, `consoleDiagnostics` → `POST <console>/client-diagnostics`,
    `client.diagnosticSnapshot()`). Metrics table now lists only metrics that
    exist (server push/pull counts+distributions, `sync.conflicts.detected`,
    `sync.sessions.*`, `sync.transport.reconnects`); **cut the fictional
    `sync.client.*` metrics** — there are no client-emitted metrics today.
    Tracing section grounded in routes/shared.ts (`traceparent`/`sentry-trace`
    parsed, in CORS allowlist; client `SyncularSyncAttempt` correlation).
    Fixed broken page structure (orphaned "Related guides" mid-page, vague
    "Demo reference" section — removed).
  - **operate/performance**: fixed stale server defaults
    (`maxPullLimitSnapshotRows` is 50000 not 5000; `maxPullMaxSnapshotPages`
    is 50 not 10); replaced nonexistent `createSyncularClient` snippets;
    added snapshot-artifacts + snapshotBinaryColumns pointers (defer to
    /server/snapshot-pull); added the **load testing** section for the k6
    suite (binary SSP1 reader, scenario table, `bun run test:load:*`,
    BASE_URL for external stacks); prune/compact signatures verified.
  - **operate/troubleshooting** rewritten as the symptom→diagnosis tree
    (stalled sync, missing writes, revoked subscriptions, conflicts, realtime
    drops, slow bootstrap, bootstrap loops, outbox overflow, blobs, schema
    mismatch, auth expiry, high latency) — each with first console check,
    ranked causes, fix links to the Phase 2/3 troubleshooting pages.
    **Removed references to nonexistent `useSyncInspector()` /
    `client.getInspectorSnapshot()`** — the real API is
    `client.diagnosticSnapshot()`.
  - **operate/operations-setup**: added the `createSyncServer({ console })`
    quick path; the manual `createConsoleRoutes` path now shows wiring the
    emitter into sync routes via `consoleLiveEmitter` (without it no request
    events are recorded); added the `/client-diagnostics` endpoints; curl
    examples now carry bearer auth and consistent mounts.
  - **operate/console/***: light pass as planned — pages verified against real
    routes (`/timeline`, `/notify-data-change`, `/events/:id/payload`,
    `/client-diagnostics`, gateway `/instances/health`) and real
    /reference/api slugs; no consolidation needed. Fixed storage.mdx's stale
    `createSyncServer` top-level `handlers`/`authenticate` to the current
    `sync: { handlers, authenticate }` contract.
  - **console-integration**: **removed the `syncular console` CLI path — the
    command does not exist** (packages/syncular CLI ships only `generate` and
    `codegen install`); page now leads with `mountConsoleUi` and the
    `createConsoleStaticResponder` generic responder (both verified exports).
  - **Found for Phase 6 / out of my tree:** `reference/cli/console.mdx`
    documents the nonexistent `syncular console` command and should be retired
    or rewritten; `clients/javascript/testing/*` (quick-start,
    examples-offline-reconnect, likely primitives/lifecycle) still document a
    **removed testkit API** (`createSyncFixture`, `seedServerData`,
    `assertRowExists`, `createHttpClientFixture`, `createScenarioFlow`,
    `assertOutboxEmpty` — none exist in packages/testkit/src) and need a
    Phase 2-style grounding pass.
  - **Verification:** `bun run docs:stale-check` green (260 files);
    `bun --cwd apps/docs types:check` green; full `next build` green; scripted
    link check over operate/** + testing/** found no broken internal links.
- 2026-06-12: **Rust client-configuration + troubleshooting written** (the
  Phase 2 deferral closed). `clients/rust/client-configuration` grounds the
  embed-direct native surface in `rust/crates/runtime/src/native/facade.rs`
  (`NativeClientConfig` 6 fields, `NativeSyncularClientBuilder` 8 switches,
  async open task), `core/limits.rs` (pull 1000/50k/10, push 20→1000 over
  threshold 100 — explicitly *not* per-client tunable on native, unlike JS),
  `transport/mod.rs` (fixed `SyncTransportTimeouts`, ws URL derived from
  `base_url` + `/realtime`, reconnect backoff 1s→30s floor 250ms), and the
  header-map auth model (`SyncAuthHeaders` + `AuthExpired` events — no
  `getHeaders`/`authLifecycle`). `clients/rust/troubleshooting` maps
  symptoms to `ErrorKind` + the shared `sync.*`/`blob.*` codes (catalog
  linked at /reference/errors, not duplicated): auth/transport failures,
  the open-time `Syncular app schema version mismatch` (diesel_sqlite.rs),
  stalled outbox (closed worker / conflicts / 10k unresolved cap), realtime
  reconnect expectations, and SQLite file locking (5s busy timeout). Both
  added to rust meta.json (Getting Started after generated-client;
  Troubleshooting section last) and the Rust index cards. Verification:
  `bun run docs:stale-check` green; `bun --cwd apps/docs types:check` green;
  `bun --cwd apps/docs run build` green.
