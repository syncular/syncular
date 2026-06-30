# WP-50 Syncular DX Rough Edges

Status: `[~]` in progress

## Goal

Make Syncular feel boring for a new app developer and a new contributor:
scaffold a real app, generate code, run it, mutate data, go offline, come back
online, inspect what happened, and test the behavior without needing to learn
the whole Rust-first architecture first.

The current product foundation is strong, but the DX still asks users to hold
too many concepts at once: package subpaths, generated clients, migrations,
server adapters, WASM runtime artifacts, OPFS/browser workers, realtime,
subscriptions, scopes, auth leases, testkit entrypoints, and release/build
quirks. This work package turns those rough edges into a staged cleanup plan.

## Guiding Principle

Prefer one polished golden path over more explanation. Every public concept
should either be exercised by the starter app, discoverable from a short import
decision tree, or hidden behind defaults until the user needs it.

## Scope

- Make `create-syncular-app` the canonical first-run path for a real
  browser/offline-first app.
- Collapse client initialization so common apps do not manually wire runtime
  artifacts, lifecycle wrappers, realtime, or worker details.
- Document package subpaths as intentional product surfaces, not hidden module
  trivia.
- Harden server adapter imports and peer dependency guidance so runtime-specific
  code fails only when that subpath is used.
- Make the codegen lifecycle one obvious loop from migrations/config to typed
  mutations and reads.
- Improve app-facing diagnostics for sync, scopes, auth, bootstrap, runtime,
  and resync failures.
- Promote existing status, diagnostics, and error machinery into a small stable
  app-facing contract instead of leaving apps to assemble their own health
  surfaces from low-level events.
- Add a blessed local-visibility primitive so app code does not use manual
  `sync()` calls as a stale-read workaround after authoritative commands.
- Make auth context replacement, campaign/scope changes, and realtime
  resubscription an explicit runtime contract.
- Make blob partition/scope behavior and global/base-data sharing patterns
  explicit.
- Add deploy-time schema readiness checks and drift diagnostics for CI and
  production rollout.
- Add testkit recipes for real app behavior instead of broad mocking.
- Add stable log/event marker conventions for automated E2E and production log
  scans.
- Add machine-readable readiness output for CI, deploy scripts, and app tests
  so failures can be asserted without scraping human text.
- Clarify which runtime failures recover automatically and which require app or
  operator action.
- Keep diagnostics useful without leaking bearer tokens, signed URLs, secrets,
  or full user payloads.
- Reduce contributor setup traps around Bun, WASM workers, Rust/WASM gates, and
  release smokes.

## Non-Goals

- Do not restore the old JavaScript sync engine or old protocol behavior.
- Do not add compatibility aliases for removed package names or umbrella import
  paths.
- Do not split the browser database into skimmed-down product variants just to
  make package size look better.
- Do not hide synced writes behind raw SQL. Generated mutations and outbox
  semantics remain the only synced write path.
- Do not teach app code to call `sync()` as a generic stale-read escape hatch.
  Freshness should be expressed through bootstrap/readiness, local visibility,
  realtime recovery, or generated helpers.
- Do not make production Workers run schema bootstrap/migrations during normal
  request startup. Schema setup should be an operator/deploy concern.
- Do not build a broad docs rewrite before proving the golden path in an
  executable starter.

## Product Contract Check

- Browser offline persistence remains Rust-owned SQLite/WASM with an
  app-facing TypeScript API.
- Server authority remains handler/subscription based; clients do not subscribe
  by sending arbitrary remote SQL.
- Scoped access remains explicit and fail-closed.
- Generated clients stay the primary typed API for mutations, subscriptions,
  diagnostics, and read-model lifecycle.
- Local read models remain explicit app/codegen intent, not hidden runtime
  caches.
- Realtime remains a fast wake/delta path with HTTP recovery.
- Optional integrations such as React, Tauri, React Native, CRDT/Yjs, Sentry,
  Cloudflare, S3, and database adapters stay behind subpaths with optional peer
  dependencies where possible.

## Existing Surface To Promote

This work package should avoid inventing new concepts when the current runtime
already has the raw pieces. The rough edge is that the pieces are too low-level
or scattered for app code:

- `diagnosticSnapshot()` already exposes runtime, connection, subscriptions,
  bootstrap, recent diagnostics, timings, outbox, conflicts, and blob upload
  state.
- `getStatus()` / lifecycle state already summarize realtime, pending work,
  bootstrap, outbox, conflicts, blob uploads, and last errors.
- `SyncularClientError` and `SYNCULAR_ERROR_DEFINITIONS` already provide typed
  codes, categories, retryability, and recommended actions.
- Browser bootstrap status already tracks subscription and phase readiness.
- Realtime, blob, auth, storage, and sync paths already emit diagnostic events.

The DX goal is to shape these into stable, documented, app-facing helpers with
stronger detail payloads and tests.

## Plan

### 1. Golden Path Starter

Build and continuously test one canonical starter app that uses the published
package shape:

- `create-syncular-app` scaffolds a real browser app, not just loose fixtures.
- The app starts with a local SQLite/WASM client, a server route, generated
  mutations, generated reads, a subscription, offline replay, and realtime
  recovery.
- The default template should be small enough to read, but complete enough to
  answer "how do I actually use this?"
- The starter should run from a clean checkout and from published packages.

Acceptance criteria:

- A new app can be created, generated, typechecked, and run with one documented
  command sequence.
- The generated app proves insert/query/offline/reconnect behavior in an
  executable smoke.
- Docs and README examples point at this starter before any low-level setup.

### 2. Collapsed Client Init

Make common browser client setup boring:

- Default `createSyncularClient(...)` should choose the right runtime artifact
  from generated app metadata whenever possible.
- Realtime should be an option like `realtime: true`, not an extra lifecycle
  concept users must wire manually.
- Worker, OPFS, runtime feature, and bootstrap defaults should be sensible for
  normal offline-first browser apps.
- Browser persistence guidance should explicitly cover OPFS/SQLite
  requirements, COOP/COEP headers where needed, Worker setup, storage fallback
  behavior, and how to verify the app is not accidentally using memory storage.
- The client should expose a small browser/runtime health check with storage
  backend, fallback reason, runtime artifact, bootstrap summary, active
  subscriptions, realtime state, last sync error, and local persistence status.
- Missing browser runtime pieces should map to recognizable error codes/names,
  not only human text such as "bootstrap did not become ready".
- Advanced options remain available, but examples should not lead with them.

Acceptance criteria:

- The starter does not import runtime artifact helpers manually.
- The starter does not construct a separate lifecycle wrapper unless there is a
  real product reason.
- Missing browser capabilities, missing artifacts, or unsupported runtime
  features throw actionable errors with next steps.
- A developer can run one documented health check and see whether persistence,
  bootstrap, subscriptions, and realtime are actually live.

### 3. Import Surface Decision Tree

Make the package surface self-explanatory:

- `@syncular/client` for core browser/offline client.
- `@syncular/client/react` for React bindings.
- `@syncular/client/tauri` and `@syncular/client/react-native` for host
  bridges.
- `@syncular/client/crdt-yjs` for optional Yjs CRDT integration.
- `@syncular/server/*` for server runtimes, database adapters, blob stores,
  CRDT handlers, Cloudflare integration, Hono routes, and Sentry integration.
- `syncular` for CLI commands such as `npx syncular generate`.

Acceptance criteria:

- Public docs include a short "which import do I need?" table.
- Every public subpath has one app-facing example or explicit "advanced"
  label.
- Removed package names and old umbrella imports stay blocked by stale-pattern
  checks.

### 4. Server Adapter Boundaries

Keep the folded server package, but make runtime-specific imports safe:

- Verify Bun-only, Cloudflare-only, Node-only, and adapter-specific modules do
  not execute incompatible runtime imports from unrelated subpaths.
- Document peer dependencies per adapter.
- Make wrong-runtime errors name the subpath, runtime requirement, and install
  or deployment fix.
- Keep storage adapters as `@syncular/server/filesystem` and
  `@syncular/server/s3`, matching the rest of the folded subpath style.

Acceptance criteria:

- Importing `@syncular/server` alone does not load Bun, Cloudflare, S3, Sentry,
  or database-specific code.
- Importing each adapter subpath in its intended runtime succeeds in a focused
  smoke.
- Importing an incompatible adapter fails with a clear error only when that
  adapter is actually used.

### 5. One Codegen Loop

Make generation feel like part of app development instead of a separate system:

- The docs should consistently teach:
  edit migrations/config -> run `npx syncular generate` -> use generated
  mutations/read helpers -> test behavior.
- `syncular generate` should validate the app shape and tell the user exactly
  what to fix when migrations/config/generated outputs disagree.
- Generated examples should avoid server-owned columns in mutation inputs and
  show local-only tables, read models, blobs, CRDT fields, and scopes only when
  introduced.

Acceptance criteria:

- Starter docs never require internal Rust codegen commands for the JavaScript
  path.
- Common config mistakes produce one concise diagnostic with file/path context.
- A `--check` flow catches stale generated files in CI.

### 6. App-Facing Diagnostics

Reduce expert-only debugging:

- Sync failures should explain whether the issue is network, auth, scope,
  migration/schema mismatch, runtime capability, resync-required state, or
  server rejection.
- Scope errors should name table, scope key, expected shape, received shape,
  and whether the result is no access vs invalid config.
- Auth lease expiry should tell the app whether to refresh headers, reissue a
  lease, retry sync, or force bootstrap.
- Bootstrap phase and realtime recovery diagnostics should be exposed in the
  generated/app-facing language before users need the console.
- Permission-denied and subscription authorization failures should be typed and
  include the requested scope, actor, token/campaign scope where available, and
  denied table/subscription id.
- Rate-limit diagnostics should include actor, operation type, current limit
  window, retry-after information, and enough scope/subscription context to
  tell app churn from a wrong test actor model.
- Blob failures should distinguish blob row missing, partition/scope forbidden,
  signed URL or token failure, and underlying storage object missing.
- Schema drift should distinguish missing schema, schema too old, generated
  client too old, and runtime/local database open failure.

Acceptance criteria:

- The starter includes a minimal visible sync/debug state fed by public APIs.
- At least one test per major diagnostic class proves the public error shape.
- The console remains useful for deep inspection, but basic app recovery does
  not require opening it.
- App tests can assert permission denied, revoked subscription, rate limit,
  schema drift, and blob access failures without parsing human messages.

### 7. Testkit Recipes

Make real behavior easy to test:

- Root `@syncular/testkit` stays lightweight.
- `@syncular/testkit/server` gets recipes for Hono route tests, scope tests,
  auth failures, migration mismatch, and blob/storage behavior.
- `@syncular/testkit/client-bridge` gets recipes for offline replay,
  generated mutations, realtime recovery, bootstrap phases, and diagnostics.
- Recipes should be copyable into app tests and use production APIs.

Acceptance criteria:

- Docs show which testkit subpath to import for each testing job.
- Fresh app smoke includes at least one generated mutation/offline replay test.
- Testkit examples do not require always-installed server/client heavy
  dependencies through the root import.

### 8. Contributor Setup Polish

Make local development less fragile:

- Add a single contributor bootstrap command or doc that installs the pinned
  Bun `1.3.9` when local Volta/global Bun differs.
- Clearly separate known Linux/Bun WASM-worker fragility from product failures.
- Group quality gates by task: docs-only, package-only, browser/WASM,
  server-adapter, release, and Rust/native.
- Keep release smokes explicit about what they prove and what they skip.

Acceptance criteria:

- A new contributor can run the docs-only and starter-app gates without knowing
  the full release pipeline.
- The Bun version mismatch is detected before long-running WASM tests.
- Known test-infra fragility is documented near the command that triggers it,
  not buried in release history.

## Skaldsong Integration Feedback Requirements

Skaldsong integration exposed concrete DX failures that should be treated as
acceptance input for the implementation slices below.

### Browser Runtime And Persistence

- Add first-class browser persistence docs: OPFS/SQLite requirements, COOP/COEP
  headers where applicable, Worker setup, fallback modes, and verification that
  a browser is not using an in-memory store.
- Add an official app-facing browser health check. It should report storage
  backend, storage fallback, runtime artifact/features, bootstrap status,
  active subscriptions, last sync error, realtime socket state, and whether
  persistence is durable.
- Add stable typed runtime/setup failures for missing WASM artifacts, runtime
  feature mismatch, Worker startup failure, unsupported OPFS/SAH pool,
  unexpected storage fallback, bootstrap timeout, and browser capability
  problems.

### Bootstrap And Sync Semantics

- Document the difference between initial bootstrap, explicit pull, autosync,
  realtime wakeup, local read-model freshness, and manual `sync()`.
- Add a built-in local visibility primitive for the common flow: run an
  authoritative command, then await local visibility for a table/scope/query
  without teaching React or app code to manually pull.
- Extend app-facing bootstrap status with per-table/per-scope readiness and
  error details. A single aggregate `ready=false` is not enough when auth,
  schema, missing rows, rate limits, blob/package fetches, or runtime failures
  can all block readiness.
- Generated helpers should expose readiness by subscription/table/scope so UI
  views can gate themselves without interpreting raw bootstrap internals.

### Auth And Permissions

- Make subscription authorization failures a distinct typed error path with
  requested scope, actor, token or campaign scope where available, denied table,
  and subscription id.
- Add a clear runtime contract for auth context and scope changes. Joining or
  creating a campaign should have a blessed path to replace auth headers,
  update subscriptions, restart affected realtime state, and sync the affected
  scopes.
- Test helpers should make permission-denied assertions structured and stable.
  App tests should not parse loose server messages to prove revoked or denied
  access.

### Realtime

- Add an app-facing signal that proves "this browser is subscribed and
  receiving remote changes for campaign X": realtime connected, scope joined,
  last event cursor, last pull-trigger reason, and last local row apply.
- Provide a deterministic local dev/test WebSocket story with stable log events
  for connection opened, scope/campaign joined, event received, pull triggered,
  affected scopes, and local rows updated.
- Improve rate-limit feedback in logs and error details with actor, operation
  type, current window, retry-after, and relevant scope/subscription context.

### Blobs And Package Delivery

- Blob references need enough partition/scope context for the runtime to fetch
  through the correct authority boundary.
- Add official guidance for global/base data shared into campaign scopes:
  copied rows, shared partitions, scoped blob refs, or another blessed pattern.
- Missing blob access should be typed and distinguish blob row missing,
  partition/scope permission failure, signed URL or token failure, and
  underlying storage object missing.

### Schema And Deployment

- Document production posture clearly: schema bootstrap and migrations are
  operator/deploy steps, not request-startup work in Workers.
- Add a fast schema-readiness command/API for CI and deploys. It should verify
  expected Syncular tables, server schema version, migration state, and
  generated client compatibility.
- Split drift diagnostics into schema missing, schema too old, generated client
  too old, incompatible generated output, and runtime cannot open local
  database.

### Testing And Log Markers

- Add an official deterministic E2E recipe: local Postgres, explicit test auth,
  real server, real browser client, realtime enabled, durable browser
  persistence, and no mocked persistence.
- Add testkit helpers for scoped actors, tokens, campaign membership, denied
  membership, and auth context changes while still exercising real permission
  checks.
- Define a Syncular log marker convention with stable event codes for rate
  limits, revoked subscriptions, bootstrap timeout, schema errors, blob errors,
  realtime reconnect, realtime event delivery, and local apply.

### Public API Shape

- Prefer typed return values and error codes over message matching in every
  app-facing path.
- Expose a small stable lifecycle surface for UI code: configured, storage
  open, schema ready, bootstrapped, realtime connected, last error,
  requires-action, destroy, and restart/resume.
- Mark APIs as UI-facing, operator/deploy, debug/console, testkit, or advanced
  escape hatch in docs. This should prevent app code from growing accidental
  refresh/sync/reset behavior.

### Additional Worth Carrying Forward

- Treat `requiresAction` as a first-class app-facing state. Auth expiry,
  revoked scope, schema drift, unsupported browser storage, unrecoverable blob
  access, and runtime open failures should say whether the runtime will retry,
  whether the app should refresh auth or change scope, or whether an operator
  must run a deploy/schema step.
- Make schema readiness machine-readable. The deploy/CI surface should support
  JSON output with issue codes, affected files/tables/adapters, expected
  versions, observed versions, and recommended action.
- Keep generated-client/runtime compatibility checks in one obvious contract:
  generated app schema version, runtime package/protocol version, local stored
  schema version, server required/latest schema version, and generated output
  freshness should be explainable from one command or helper.
- The starter and testkit should include a copyable "two browsers, one scoped
  project/campaign, one auth change, one denied scope" scenario. This is the
  fastest way to prove realtime, scoped auth, local visibility, diagnostics,
  and durable browser persistence together.
- App-facing health, server logs, generated diagnostics, testkit assertions,
  and console events should share stable event/error codes. The console can add
  detail, but it should not be the only place where the meaning of a failure is
  understandable.
- Keep package/import ergonomics in the DX plan. Optional server adapters,
  Sentry, S3, Cloudflare, CRDT/Yjs, Tauri, and React Native must stay behind
  subpaths so the root client/server imports do not pull unrelated runtime
  dependencies into normal browser apps.
- Document the privacy boundary for diagnostics. Safe fields such as table,
  scope key shape, actor id, subscription id, request id, schema version,
  adapter name, and storage backend are useful; raw tokens, signed URLs, and
  full row payloads need redaction or opt-in debug handling.
- Prefer examples that prove durable behavior. Docs and smokes should avoid
  examples that accidentally pass with memory storage, mocked persistence,
  mocked auth, or manual `sync()` calls masking lifecycle gaps.
- Keep global/base-data sharing as a product decision, not just blob plumbing.
  Package-release rows, shared blobs, and campaign/project-scoped access need
  one blessed modeling pattern before apps build their own ad hoc partition
  bridges.

### Feedback Triage

Treat the pasted integration notes as more than documentation requests. Most
items point at missing public contracts, not missing prose.

Priority 0:

- Browser truth surface: app code must be able to ask whether storage is
  durable, schema is compatible, bootstrap is ready, realtime is connected, and
  the last failure is recoverable without reading console logs.
- Scope/auth flow: replacing auth, changing campaign/project scope, restarting
  affected subscriptions, and proving local visibility must be one blessed
  runtime path with typed denied/revoked-scope failures.
- Deploy safety: schema bootstrap, migrations, generated output freshness, and
  server/client schema compatibility must be checkable before traffic through
  machine-readable commands/APIs.

Priority 1:

- Blob/package partition model: choose and document the intended global/base
  data sharing pattern before app teams invent their own package-blob bridges.
- Deterministic app E2E: provide a copyable real-server, real-browser,
  durable-storage, scoped-auth, realtime-enabled recipe that proves the same
  lifecycle users rely on in production.
- Diagnostic code taxonomy: server logs, app health, generated helpers,
  testkit assertions, and console events should share stable event/error codes.

Priority 2:

- Package/import ergonomics: keep optional adapters behind subpaths, and make
  the "which import do I need?" path obvious enough that dependency size does
  not become a product surprise.
- Contributor setup: pinned Bun, known WASM-worker fragility, and task-specific
  gates should be discoverable before maintainers run the wrong long gate.

Product decisions to force:

- Is global/base data copied into scoped rows, referenced through scoped blob
  refs, exposed through shared partitions, or modeled as a first-class scope?
- Does `requiresAction` belong in the root lifecycle/health API, generated app
  helpers, or both?
- Which diagnostic fields are always safe, which are redacted by default, and
  which require explicit debug opt-in?
- Which APIs are UI-facing, operator/deploy-facing, debug/console-only,
  testkit-only, or advanced escape hatches?

Acceptance guardrails:

- A completed item should usually ship with a typed helper/error shape and a
  focused test or smoke, not only a docs paragraph.
- App tests should assert stable codes and detail fields, not human messages.
- Freshness fixes should not teach app code to call manual `sync()` as the
  normal answer to stale reads.
- Browser persistence examples should fail loudly if they are accidentally
  using memory storage.
- Blob, auth, schema, and realtime failures should say who can recover them:
  runtime retry, app auth/scope action, user action, or operator/deploy action.

## Required Gates

For planning/doc-only edits:

- `git diff --check`
- Manual Markdown sanity read, because the repo's Biome config ignores these
  Markdown planning files.

For implementation slices, add the relevant gates from
[`QUALITY_GATES.md`](../QUALITY_GATES.md), plus at least:

- `bun run docs:stale-check`
- `bun run fresh-app-smokes`
- `bun test packages/syncular/src/cli.test.ts`
- `bun --cwd packages/client tsgo`
- `bun --cwd packages/server tsgo` when server exports change
- `bun --cwd packages/testkit tsgo` when testkit recipes or exports change
- Focused browser client tests for lifecycle, diagnostics, bootstrap, auth
  context replacement, local visibility, or blob behavior when those surfaces
  change.
- Focused server/Hono tests for rate-limit details, subscription auth failure
  details, schema readiness, blob access details, or realtime log markers when
  those surfaces change.
- `bun scripts/post-publish-install-smokes.ts --help` when release smoke
  behavior changes

Browser/WASM, server-adapter, native-binding, or performance-sensitive changes
must run the matching quality gates and record before/after evidence in
[`BENCHMARK_LOG.md`](../BENCHMARK_LOG.md) when size, bootstrap, local-query,
online propagation, or reconnect behavior can change.

## Current Evidence

- `WP-40` accepted fresh app and release DX foundations.
- `WP-41` accepted codegen init and warning polish.
- `WP-46` and `WP-47` added fresh local and post-publish JavaScript runtime
  smokes.
- `WP-49` hardened key browser client API gaps and recorded the generated
  apply/read-model extension contract.
- Release `0.1.3` proved the current published package set works through npm
  and crates.io, but the release recovery also showed that dependency shape,
  testkit root imports, post-publish smokes, and Bun/WASM behavior can still
  surprise maintainers.
- Skaldsong integration feedback identified concrete app-facing rough edges in
  browser persistence, bootstrap/sync semantics, auth/scope changes, realtime
  proof signals, blob partition/scope behavior, production schema readiness,
  deterministic E2E recipes, stable log markers, and UI-facing lifecycle APIs.
- A 2026-06-30 doc-only pass folded the integration feedback into concrete
  implementation guardrails: `requiresAction` semantics, JSON readiness output,
  generated/runtime compatibility, two-browser scoped scenarios, shared
  event/error codes, diagnostics redaction, optional dependency boundaries, and
  a first-class global/base-data decision.
- A follow-up triage pass ranked the feedback into browser truth/scope-auth/
  deploy-safety P0s, blob/E2E/diagnostic-taxonomy P1s, and import/contributor
  polish P2s, with guardrails that completed items should ship as typed
  contracts with tests rather than vague docs-only guidance.
- 2026-06-30 first implementation slice added
  `getSyncularBrowserHealth(...)` to `@syncular/client`, summarizing existing
  diagnostic/status data into an app-facing health contract: overall state,
  storage durability/fallback, runtime artifact, bootstrap, subscriptions,
  realtime state, last error, and recent structured errors.
- The `create-syncular-app` template now renders a minimal runtime health line
  from that helper, and the fresh JavaScript app smoke asserts the helper from
  a generated app using public imports.
- The `create-syncular-app` smoke now allocates free sync/Vite ports instead of
  assuming fixed ports, so the scaffold smoke cannot accidentally pass against
  or fail because of another local server.
- 2026-06-30 second implementation slice added
  `waitForSyncularLocalVisibility(...)` plus
  `SyncularDatabase.awaitLocalVisibility(...)`, giving apps a public
  query/predicate-based wait primitive for local read-model visibility after
  authoritative commands, realtime wakeups, bootstrap updates, or matching
  row-change events.
- Local visibility timeouts now use the typed
  `sync.local_visibility_timeout` error code with timeout and table details, so
  app tests do not need to parse stale-read timeout text.
- 2026-06-30 third implementation slice added
  `replaceSyncularAuthContext(...)` plus
  `SyncularDatabase.replaceAuthContext(...)`, giving apps one public operation
  for replacing explicit auth headers or provider-owned auth context, swapping
  subscriptions, resetting affected bootstrap state, running the appropriate
  recovery sync/realtime path, and optionally awaiting local visibility.
- The auth-context helper deliberately uses `sync()` after explicit headers so
  a configured `getHeaders` provider cannot overwrite caller-provided
  replacement headers, and uses `resumeFromBackground()` when headers remain
  provider-owned so dynamic auth refresh and realtime restart stay together.
- 2026-06-30 fourth implementation slice extended the fresh generated
  JavaScript app smoke from user-only scope to user+campaign scope and proved a
  generated app can replace auth context/subscriptions, reset bootstrap, then
  use local visibility for a campaign-scoped row without a manual `sync()` call.
- 2026-06-30 fifth implementation slice added a real Hono/WebSocket/WASM
  managed-database proof: project scope changes use
  `replaceAuthContext(...)`, realtime delivers the new project row, local
  visibility observes it, and a denied project scope surfaces
  `sync.scope_revoked` diagnostics.
- 2026-06-30 sixth implementation slice added
  `getSyncularSchemaReadiness(...)` plus
  `SyncularDatabase.schemaReadiness(...)`, giving apps a structured readiness
  result for generated/runtime/local/server schema drift: missing local schema,
  stale local schema, generated client too old, runtime app schema stale, stale
  server schema, newer server requirements, advisory newer server schemas, and
  runtime/schema-state open failures.
- The `create-syncular-app` template now renders schema readiness from the
  generated app schema version, and the fresh JavaScript app smoke asserts the
  same readiness result from a clean generated app.
- 2026-06-30 seventh implementation slice added
  `syncular schema check`, a deploy/CI-facing readiness command that inspects
  the generated codegen config, migration folders, generated TypeScript client
  output, and generated TypeScript server output, then returns machine-readable
  status, schema versions, table names, file paths, and stable issue codes.
- The fresh JavaScript app smoke now runs `syncular schema check --json` after
  `syncular generate --check`, so newly generated apps prove the operator
  readiness loop as part of the golden path.
- 2026-06-30 eighth implementation slice added
  `getSyncularServerSchemaReadiness(...)` to `@syncular/server`, giving deploy
  and server startup code a non-mutating readiness helper over live database
  introspection, expected Syncular core tables, expected app tables, and server
  required/latest schema versions.
- Public deployment docs now steer production schema setup toward release or
  operator steps before traffic, with `syncular schema check --json` and
  `getSyncularServerSchemaReadiness(...)` as readiness checks.
- 2026-06-30 ninth implementation slice added
  `createScopedBlobAccessDecisionChecker(...)`, allowed Hono blob routes to
  consume boolean or structured access decisions, and exposed typed blob route
  details for missing scoped references, scope-denied references, missing blob
  records, missing upload records, signed URL failures, invalid direct-transfer
  tokens, and missing storage objects.
- Public blob docs now state that a `BlobRef` is not an authority grant, that
  campaign/project clients need scoped metadata rows or an explicit shared
  partition policy for global/base assets, and that app tests should assert
  stable `details.failureKind` / `details.accessReason` values.
- 2026-06-30 tenth implementation slice added testkit support for
  membership-aware project/campaign actors and stable diagnostic marker
  assertions. The bundled project-scoped tasks handler can now take explicit
  `projectsByActor` membership so tests can prove allowed writes,
  `sync.forbidden` writes, and revoked foreign subscriptions without
  app-specific auth scaffolding.
- The testkit `postSyncCombinedRequest(...)` helper now accepts the current
  binary sync-pack response format as well as JSON, so docs examples using the
  real combined route are executable again.
- 2026-06-30 eleventh implementation slice collapsed the first public
  import/setup docs around the starter-proven path: the JavaScript landing page
  now has a "which import do I need?" table, Fresh JavaScript apps point at
  `create-syncular-app` first, server/package reference pages call out optional
  subpath peers, and high-traffic examples use the canonical
  `src/generated/syncular.generated.ts` output.
- The docs stale-pattern check now blocks the old `syncular.browser` generated
  filename in app-facing docs and package README/reference files.
- 2026-06-30 twelfth implementation slice cleaned up contributor bootstrap and
  gate guidance: the root README now leads app evaluation with
  `create-syncular-app`, tells maintainers to use Bun `1.3.9`, explains the
  generic Linux `bun test` WASM-worker exclusion, and no longer describes
  `syncular` as an import umbrella.
- `rust/docs/QUALITY_GATES.md` now starts with local Bun pin guidance, explicit
  docs-only gates, and a Browser/WASM warning that Bun `1.3.13` and `1.3.14`
  both failed the full Linux Worker/WASM suite. The older contradictory Bun
  notes in `IMPROVEMENT_PLAN.md` were corrected.
- 2026-06-30 thirteenth implementation slice made browser health recovery
  semantics first-class: `getSyncularBrowserHealth(...)` now exposes
  `requiresAction` plus shared-taxonomy `recommendedActions`, so UI code can
  distinguish runtime retry from app auth/scope action without parsing recent
  diagnostic messages.
- Public error-handling docs and the starter README now show browser health as
  the app-facing place to route stable recovery actions such as refreshing auth,
  checking permissions, regenerating/upgrading schema, or recreating a failed
  runtime.
- 2026-06-30 fourteenth implementation slice resolved the default global/base
  blob sharing pattern: shared object bytes are fine, but campaign/project
  access is granted by scoped metadata rows in the requested partition/scope.
  `createScopedBlobAccessDecisionChecker(...)` now supports
  `partitionColumn` for reference tables that store rows from multiple route
  partitions, and focused tests prove a global/base hash does not authorize a
  campaign download until the campaign has its own scoped reference row.

## Implementation Log

- 2026-06-30: Added `packages/client/src/browser-health.ts` and exported it
  from `@syncular/client`.
- 2026-06-30: Added focused browser-health tests covering durable storage,
  non-durable fallback, revoked subscriptions, and structured last/recent
  errors.
- 2026-06-30: Wired the starter React app to show storage durability,
  subscription readiness, and realtime state through
  `getSyncularBrowserHealth(...)`.
- 2026-06-30: Updated `scripts/fresh-app-smokes.ts` so the generated JS app
  imports and asserts the health helper, and fixed the smoke's external
  dependency symlinks to use package-local installed dependency paths.
- 2026-06-30: Updated `packages/create-syncular-app/scripts/smoke.ts` to
  allocate free ports for the sync server and Vite before booting the scaffold.
- 2026-06-30: Added `packages/client/src/local-visibility.ts` and exported it
  from `@syncular/client`.
- 2026-06-30: Added `SyncularDatabase.awaitLocalVisibility(...)` as the managed
  database method over the standalone helper.
- 2026-06-30: Added focused local-visibility tests for immediate resolution,
  matching table events, unrelated table filtering, executable Kysely query
  objects, typed timeout errors, and abort cleanup.
- 2026-06-30: Added the `sync.local_visibility_timeout` core error definition.
- 2026-06-30: Added `packages/client/src/auth-context.ts` and exported it from
  `@syncular/client`.
- 2026-06-30: Added `SyncularDatabase.replaceAuthContext(...)` as the managed
  database method over the standalone helper.
- 2026-06-30: Added focused auth-context tests covering explicit replacement
  headers, provider-owned headers through resume recovery, affected
  subscription bootstrap reset, sync skipping, and optional local visibility.
- 2026-06-30: Updated `scripts/fresh-app-smokes.ts` so the generated
  JavaScript app includes a campaign/project scope, switches from
  `campaign-a` to `campaign-b` through `database.replaceAuthContext(...)`, and
  waits for the new campaign row with `database.awaitLocalVisibility(...)`.
- 2026-06-30: Updated
  `packages/client/src/__tests__/realtime-hono.wasm.test.ts` with an opt-in
  project-scope Hono realtime harness path and a managed-database scope-change
  test covering realtime delivery, local visibility, and denied-scope
  diagnostics.
- 2026-06-30: Folded Skaldsong integration feedback into this work package as
  concrete DX acceptance input and added implementation guardrails for
  machine-readable readiness, generated/runtime compatibility, shared
  diagnostic codes, redaction, optional dependency boundaries, and
  global/base-data modeling.
- 2026-06-30: Added feedback triage priorities, forced product decisions, and
  acceptance guardrails so future slices handle the pasted feedback as public
  contracts with tests instead of docs-only cleanup.
- 2026-06-30: Added `packages/client/src/schema-readiness.ts` and exported it
  from `@syncular/client`.
- 2026-06-30: Added `SyncularDatabase.schemaReadiness(...)` as the managed
  database method over the standalone readiness helper.
- 2026-06-30: Added focused schema-readiness tests covering ready state,
  missing local schema, stale local schema, generated-client drift, stale
  server schema, newer server requirements, advisory newer server schemas, and
  runtime/schema-state open failures.
- 2026-06-30: Updated the bridge client with a structured `unknown` schema
  readiness result when a host bridge does not expose schema readiness.
- 2026-06-30: Wired the starter React app to show schema readiness from the
  generated app schema version, and updated the fresh JavaScript app smoke to
  assert the generated app readiness result.
- 2026-06-30: Added `syncular schema check` with `--json`/`--pretty`,
  `--manifest-dir`, `--config`, `--migrations-dir`, `--generated-client`, and
  `--generated-server` options.
- 2026-06-30: Added focused CLI tests covering schema-check parsing, ready
  output, and stale generated output with stable issue code
  `schema.generated_output_stale`.
- 2026-06-30: Updated the fresh JavaScript app smoke to run
  `syncular schema check --json` on the generated project.
- 2026-06-30: Updated the starter README to include
  `database.schemaReadiness(...)` and `syncular schema check --json` in the
  app-facing generate/check loop.
- 2026-06-30: Added `packages/server/src/schema-readiness.ts` and exported
  `getSyncularServerSchemaReadiness(...)` from `@syncular/server`.
- 2026-06-30: Added focused server readiness tests covering missing Syncular
  core tables, missing app tables, ready live database state after
  `ensureSyncSchema(...)`, stale server schema versions, and newer server
  requirements.
- 2026-06-30: Updated deployment/server docs so production schema setup is a
  deploy/operator step before traffic rather than normal request startup.
- 2026-06-30: Added
  `createScopedBlobAccessDecisionChecker(...)` to return the same scoped blob
  access decision that `createScopedBlobAccessChecker(...)` used internally.
- 2026-06-30: Updated Hono blob routes so `canAccessBlob` can return either a
  boolean or a structured decision, and `blob.forbidden` responses expose safe
  access details: `accessReason`, `accessStage`, `partitionId`,
  `referenceTable`, and `referenceColumn`.
- 2026-06-30: Added `blob.signing_failed` to the shared error taxonomy,
  regenerated the Rust taxonomy fixture, and updated the Rust runtime
  classifier for both `blob.signing_failed` and the previously-added
  `sync.local_visibility_timeout`.
- 2026-06-30: Added typed blob route details for missing upload/blob records,
  invalid direct-transfer tokens, signed URL creation failures, and underlying
  storage-object misses.
- 2026-06-30: Updated public blob docs and error reference with
  partition/scope guidance, global/base-data sharing guidance, and stable blob
  failure detail fields.
- 2026-06-30: Added `createProjectScopedTestActor(...)`,
  `createProjectScopedActorHeaders(...)`, and `createProjectMembership(...)`
  to `@syncular/testkit`.
- 2026-06-30: Extended `createProjectScopedTasksHandler(...)` with
  `projectIds` and `projectsByActor` so tests can model campaign/project
  membership and denied scopes deterministically.
- 2026-06-30: Added `SYNCULAR_DX_MARKER_CODES`,
  `findDiagnosticMarker(...)`, `hasDiagnosticMarker(...)`, and
  `requireDiagnosticMarker(...)` to `@syncular/testkit` for stable diagnostic
  and log-marker assertions.
- 2026-06-30: Updated `postSyncCombinedRequest(...)` /
  `readSyncCombinedResponse(...)` to decode binary sync-pack combined
  responses in addition to JSON responses.
- 2026-06-30: Updated testkit docs and the production testing checklist with
  explicit membership, denied-scope, and diagnostic-marker expectations.
- 2026-06-30: Added a JavaScript client import decision table covering the
  generated app module, `@syncular/client`, React, React Native, Tauri, Yjs,
  Sentry, and CLI commands.
- 2026-06-30: Updated Fresh JavaScript app docs to lead with
  `create-syncular-app`, then show manual installs for existing apps.
- 2026-06-30: Canonicalized public generated TypeScript examples on
  `src/generated/syncular.generated.ts` across JavaScript docs, client/runtime
  READMEs, and the Rust local-project integration reference.
- 2026-06-30: Expanded server/package reference docs so optional server/client
  integrations are described as subpaths with peers installed only when those
  subpaths are used.
- 2026-06-30: Extended `docs:stale-check` to reject the old
  `syncular.browser` generated filename in scanned docs and package references.
- 2026-06-30: Updated the root README with the app-first scaffold path,
  contributor Bun `1.3.9` bootstrap, Linux WASM-worker test caveat, and the
  current CLI-only `syncular` package story.
- 2026-06-30: Added local runtime and docs-only gate guidance to
  `rust/docs/QUALITY_GATES.md`, including the pinned-Bun requirement and the
  dedicated Browser/WASM gate caveat.
- 2026-06-30: Corrected stale `IMPROVEMENT_PLAN.md` notes that still said the
  repo should support Bun `1.3.14` or stay bumped to `1.3.13`; the plan now
  consistently says the pin remains `1.3.9` until the full Linux Worker/WASM
  suite is green.
- 2026-06-30: Extended `docs:stale-check` to scan the root README and reject
  old `syncular` import-umbrella wording.
- 2026-06-30: Added `requiresAction` and `recommendedActions` to
  `getSyncularBrowserHealth(...)`, derived from lifecycle state, revoked
  subscriptions, last/recent structured errors, and the shared
  `SYNCULAR_ERROR_DEFINITIONS` taxonomy.
- 2026-06-30: Added focused browser-health coverage for the stable no-action
  case, revoked-scope permission recovery, and auth-required refresh recovery.
- 2026-06-30: Updated public error-handling docs and the starter README so apps
  treat browser health as the stable place to route recovery UI instead of
  interpreting low-level status objects or diagnostic text.
- 2026-06-30: Added `partitionColumn` to
  `ScopedBlobReferenceTable` / `createScopedBlobAccessDecisionChecker(...)` so
  blob reference lookup can be constrained to the requested Syncular route
  partition when one reference table stores multiple partitions.
- 2026-06-30: Added focused blob access coverage proving a global/base row in
  another partition does not grant campaign/project blob access, while a scoped
  metadata row in the requested partition does.
- 2026-06-30: Updated blob feature, server, and recipe docs to make scoped
  metadata rows over shared bytes the default pattern for package/base assets,
  with shared partitions called out as an explicit advanced authorization
  policy.

## Latest Gates

Latest rerun used repo-pinned Bun `1.3.9` by prefixing `PATH` with a local
`.context/bun-1.3.9` binary.

- `bun test packages/client/src/browser-health.test.ts packages/client/src/local-visibility.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bun --cwd packages/core tsgo`
- `bunx biome check packages/create-syncular-app/scripts/smoke.ts scripts/fresh-app-smokes.ts packages/client/src/browser-health.ts packages/client/src/browser-health.test.ts packages/client/src/index.ts packages/client/src/public-api.test.ts packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/template/src/styles.css packages/create-syncular-app/template/README.md`
- `bun --cwd packages/create-syncular-app tsgo`
- `bun test packages/create-syncular-app/src/cli.test.ts`
- `bun scripts/fresh-app-smokes.ts --skip-rust --work-dir .context/wp50-fresh-app-smoke`
- `bun --cwd packages/create-syncular-app smoke`
- `bun run docs:stale-check`
- `bunx biome check packages/client/src/local-visibility.ts packages/client/src/local-visibility.test.ts packages/client/src/database.ts packages/client/src/index.ts packages/client/src/public-api.test.ts packages/core/src/error-responses.ts`
- `bun test packages/client/src/auth-context.test.ts packages/client/src/public-api.test.ts`
- `bunx biome check packages/client/src/auth-context.ts packages/client/src/auth-context.test.ts packages/client/src/database.ts packages/client/src/index.ts packages/client/src/public-api.test.ts`
- `bun test packages/syncular/src/cli.test.ts`
- `bun test packages/client/src/__tests__/realtime-hono.wasm.test.ts -t "replaces managed auth context"`
- `bun scripts/fresh-app-smokes.ts --skip-rust --work-dir .context/wp50-fresh-app-smoke-local-visibility`
- `bun scripts/fresh-app-smokes.ts --skip-rust --work-dir .context/wp50-fresh-app-smoke-auth-context`
- `bun scripts/fresh-app-smokes.ts --skip-rust --work-dir .context/wp50-fresh-app-smoke-campaign-scope`
- `bun test packages/client/src/schema-readiness.test.ts packages/client/src/public-api.test.ts packages/client/src/bridge-client.test.ts`
- `bunx biome check packages/client/src/schema-readiness.ts packages/client/src/schema-readiness.test.ts packages/client/src/database.ts packages/client/src/client.ts packages/client/src/bridge-client.ts packages/client/src/bridge-client.test.ts packages/client/src/index.ts packages/client/src/public-api.test.ts packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/template/src/client/syncular.ts scripts/fresh-app-smokes.ts`
- `bun --cwd packages/create-syncular-app tsgo`
- `bun test packages/create-syncular-app/src/cli.test.ts`
- `bun scripts/fresh-app-smokes.ts --skip-rust --work-dir .context/wp50-fresh-app-smoke-schema-readiness`
- `bunx biome check packages/syncular/src/cli.ts packages/syncular/src/cli.test.ts scripts/fresh-app-smokes.ts`
- `bun test packages/syncular/src/cli.test.ts`
- `bun --cwd packages/syncular tsgo`
- `bun packages/syncular/src/cli.ts schema check --manifest-dir packages/create-syncular-app/template --json --pretty`
- `bun scripts/fresh-app-smokes.ts --skip-rust --work-dir .context/wp50-fresh-app-smoke-schema-check`
- `bunx biome check packages/server/src/schema-readiness.ts packages/server/src/schema-readiness.test.ts packages/server/src/index.ts`
- `bun test packages/server/src/schema-readiness.test.ts`
- `bun --cwd packages/server tsgo`
- `bun test packages/server/src/blobs/access.test.ts packages/server/src/hono/__tests__/blob-routes.test.ts packages/core/src/__tests__/error-responses.test.ts`
- `bunx biome check packages/server/src/blobs/access.ts packages/server/src/blobs/access.test.ts packages/server/src/blobs/manager.ts packages/server/src/hono/blobs.ts packages/server/src/hono/errors.ts packages/server/src/hono/index.ts packages/server/src/hono/__tests__/blob-routes.test.ts packages/core/src/error-responses.ts packages/core/src/__tests__/error-responses.test.ts`
- `bun --cwd packages/core tsgo`
- `bun --cwd apps/docs types:check`
- `cargo fmt --all --check` from `rust/`
- `cargo test -p syncular-runtime error_taxonomy --manifest-path rust/Cargo.toml`
- `bun test packages/testkit/src/scoped-actors.test.ts packages/testkit/src/diagnostic-markers.test.ts packages/testkit/src/sync-builders.test.ts`
- `bunx biome check packages/testkit/src/scoped-actors.ts packages/testkit/src/scoped-actors.test.ts packages/testkit/src/diagnostic-markers.ts packages/testkit/src/diagnostic-markers.test.ts packages/testkit/src/project-scoped-tasks.ts packages/testkit/src/sync-http.ts packages/testkit/src/sync-parse.ts packages/testkit/src/index.ts`
- `bun --cwd packages/testkit tsgo`
- `bunx biome check scripts/check-docs-stale-patterns.ts`
- `bun test packages/client/src/browser-health.test.ts packages/client/src/public-api.test.ts`
- `bunx biome check packages/client/src/browser-health.ts packages/client/src/browser-health.test.ts apps/docs/content/docs/features/error-handling.mdx packages/create-syncular-app/template/README.md`
- `bun --cwd packages/client tsgo`
- `bun --cwd apps/docs types:check`
- `bun test packages/server/src/blobs/access.test.ts packages/server/src/hono/__tests__/blob-routes.test.ts`
- `bunx biome check packages/server/src/blobs/access.ts packages/server/src/blobs/access.test.ts apps/docs/content/docs/features/blobs.mdx apps/docs/content/docs/server/blobs.mdx apps/docs/content/docs/features/recipes/blobs-and-media.mdx`
- `bun --cwd packages/server tsgo`
- `git diff --check`

## Sequencing

1. Golden path starter and smoke: first retained slice is done for the
   browser/runtime health surface. Continue growing the starter only when it
   proves a concrete app-facing rough edge.
2. Browser/runtime health contract: first retained slices are done. The helper
   now exposes durability/bootstrap/realtime/subscription status plus
   `requiresAction` and taxonomy-backed recommended actions. Future slices
   should add missing setup/runtime error codes as concrete failures appear.
3. Local visibility primitive: first retained slice is done with a
   query/predicate helper and managed database method. Future generated helpers
   can wrap it for command-specific or subscription-specific waits.
4. Auth context/scope-change contract: first retained slice is done with a
   replacement helper and managed database method, and the fresh generated app
   smoke plus the Hono/WebSocket/WASM managed-database test now prove
   campaign/project scope switches, realtime delivery, local visibility, and
   denied-scope diagnostics.
5. Schema readiness and drift diagnostics: first app-facing slice is done with
   a structured helper, managed database method, starter line, and fresh app
   smoke coverage. The first deploy/operator slice is also done with
   `syncular schema check --json` over config, migrations, and generated
   client/server output. The first live server/database slice is done with
   `getSyncularServerSchemaReadiness(...)` over introspected installed tables
   and server required/latest schema versions.
6. Blob partition/scope guidance and typed blob failure details: first slice is
   done with a decision-returning scoped access checker, route-level structured
   details, shared error taxonomy coverage, and public docs for global/base
   assets crossing campaign/project scopes. Follow-up slice resolved the
   default global/base sharing pattern as scoped metadata rows over shared
   bytes, and added `partitionColumn` so reference lookup can be constrained to
   the requested route partition when a table stores multiple partitions.
7. Deterministic E2E/testkit recipes and stable log markers: first slice is
   done with membership-aware project/campaign actor helpers, stable diagnostic
   marker assertions, a project-scoped fixture that can deny non-member writes
   and subscriptions, and a fixed binary sync-pack-aware combined request
   helper.
8. Collapse client init and import docs where the starter proves remaining
   friction: first docs slice is done with a JavaScript import decision table,
   starter-first Fresh JavaScript guidance, optional subpath peer guidance, and
   a stale-pattern guard for the old generated filename.
9. Finish with contributor bootstrap/gate cleanup so maintainers can keep the
   path green: first docs/guard slice is done with root README setup guidance,
   pinned-Bun gate guidance, Linux WASM-worker caveats, corrected Bun narrative
   in the improvement plan, and stale-check coverage for root README package
   surface drift.

## Resolved Decisions

- `requiresAction` starts in the root browser health helper, because it is a
  runtime/lifecycle recovery fact that every browser app can consume. Generated
  clients may add product-specific UI helpers later, but they should wrap the
  same health contract rather than inventing a second action taxonomy.
- Global/base blob data uses scoped metadata rows over shared object bytes by
  default. A package/base asset may reuse the same content-addressed body, but
  each campaign/project partition that can fetch it needs a scoped reference
  row. Global partitions and shared partitions remain explicit advanced auth
  policies, not implicit fallback paths for hashes that exist elsewhere.

## Open Questions

- Should the first canonical starter target React by default, or a framework
  neutral browser app with React as an adjacent template?
- Should `create-syncular-app` include a local Hono/Bun server by default, or
  offer Bun, Node, and Cloudflare choices from the start?
- How much sync/debug state should the starter display before it becomes a demo
  instead of a minimal app?
- Which adapter matrix is worth smoke-testing in CI on every PR versus only in
  release rehearsal?
- Should generated clients wrap local visibility per mutation/read model, or
  keep the root query/predicate helper as the only public primitive until a
  starter flow proves a narrower API?
- Should generated clients wrap `replaceAuthContext(...)` with app-specific
  campaign/project join helpers, or should the root database method remain the
  only public contract until a starter flow proves the narrower API?
- Which schema readiness checks belong in the `syncular` CLI versus server
  package APIs?
- Should deploy readiness live as `syncular doctor`, `syncular schema check`,
  or a layered pair where `doctor` calls narrower checks?
- Which diagnostic fields are always safe to emit, which are redacted by
  default, and which require an explicit debug opt-in?

## Next Action

Pick the next implementation slice: audit the remaining product-contract
decisions from the open questions, especially diagnostic redaction/default-safe
fields and API audience labels for UI, operator/deploy, debug/console, testkit,
and advanced escape-hatch surfaces.
