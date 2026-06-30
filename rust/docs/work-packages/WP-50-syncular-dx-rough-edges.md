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

### Additional DX Risks Worth Tracking

These are not all direct asks from the pasted feedback, but they are the
places where the same integration pain is likely to reappear if the product
surface stays too implicit.

- First-run mental model: users need one clear explanation of what lives in
  the local SQLite database, what is authoritative on the server, what
  subscriptions do, what generated mutations guarantee, and when local reads
  are expected to become fresh. Without that, every other helper becomes
  another thing to memorize.
- Browser deployment preflight: the golden path should eventually include a
  check for Worker/WASM asset serving, MIME types, cross-origin isolation or
  OPFS requirements, durable storage availability, service-worker/PWA
  interactions, and quota/eviction risks. A starter that works in dev but
  silently falls back or breaks after deploy is a product failure.
- Multi-tab and lifecycle behavior: persistent offline databases need explicit
  guidance and tests for two tabs, tab suspension/resume, background refresh,
  storage locks, shutdown, and app restarts. These are common browser states,
  not exotic edge cases.
- Local recovery controls: app-facing APIs should make it clear how to recover
  from a corrupt or incompatible local database, an unrecoverable bootstrap, a
  stuck outbox, revoked scope state, or a user-initiated sign-out. Clear
  storage/rebootstrap/reset operations need typed consequences and guardrails.
- Bundle and WASM cost visibility: do not create fake "lite" databases, but do
  publish the real raw/gzip/init-time budgets for `@syncular/client`, explain
  what dominates the browser payload, and keep a regression gate or analyzer
  artifact so maintainers know when offline-first cost moves.
- Dependency and side-effect isolation: root client/server imports must stay
  boring under common bundlers. Optional adapters such as Bun SQLite, Neon, S3,
  Sentry, Cloudflare, Tauri, React Native, and CRDT/Yjs should be smoke-tested
  for "not imported until their subpath is imported" behavior.
- Data modeling guidance: apps need concrete recipes for scoped tables,
  membership tables, local-only tables, read models, generated mutations,
  indexes, blob reference rows, and CRDT fields. Otherwise users will copy
  whatever happened to work in the starter, even when their data shape differs.
- Upgrade story: generated schema version, runtime package version, server
  schema version, protocol compatibility, and migration ordering need a single
  upgrade checklist. Users should know how to move a deployed app from one
  Syncular release to the next without guessing which generated files or
  server steps must change first.
- Production ops runbook: schema readiness is only one deploy check. Real apps
  also need backup/restore expectations, blob-store consistency checks, rate
  limit tuning, credential rotation, log/event retention, and rollback guidance
  for bad migrations or bad generated clients.
- Performance budgets beyond package size: bootstrap latency, sync-pack apply
  time, local query visibility delay, outbox drain time, realtime reconnect,
  and blob fetch latency should have measurable app-facing budgets. Rough
  performance cannot hide behind "it is eventually consistent".
- Test failure artifacts: deterministic E2E recipes should leave useful
  failure output: health snapshots, schema readiness JSON, recent diagnostic
  markers, server request ids, realtime event cursors, and safe redacted logs.
  A failing app test should point at the broken lifecycle phase.
- Auth provider integration shape: the blessed auth-context replacement path
  should be easy to connect to common token-refresh providers without leaking
  provider-specific code into Syncular core or forcing apps to race old claims
  against new subscriptions.
- Console-to-app continuity: the console can remain the deep workbench, but
  every issue visible in the console should map back to a stable app-facing
  code, recommended action, or testkit assertion. Otherwise the console becomes
  the only reliable way to understand production failures.

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

### Additional Implementation Prompts Worth Capturing

These are the extra rough edges worth keeping in WP-50 even where they were
not stated directly in the pasted feedback. They are the places where a
polished first-run experience can still fall apart once an app reaches real
browsers, SSR/bundlers, offline queues, and production operations.

- Browser support matrix: publish and test the real persistence story for
  Chrome, Safari, Firefox, private/incognito modes, iOS/WebView, and PWA
  contexts. The answer should name which environments support durable
  SQLite/WASM storage, which need feature flags or fallbacks, and which should
  fail loudly instead of pretending to be offline-first.
- SSR and bundler boundaries: root imports should remain safe in SSR, Next,
  Vite, Bun, Node, and Cloudflare build graphs. Browser-only globals, Workers,
  WASM asset fetches, native drivers, and optional peers should be reached only
  from the relevant runtime/subpath and only when the app opens that surface.
- Runtime state machine: document and expose the observable lifecycle as a
  small state model, not just status snippets. A user should be able to trace
  configured -> storage open -> schema ready -> bootstrapping -> locally
  visible -> realtime connected -> recovering/requires-action -> destroyed,
  including legal transitions and what app code may do in each state.
- Version and asset alignment: the TypeScript package, generated client,
  local schema metadata, server schema/protocol, and served WASM runtime asset
  must be checkable as one compatibility story. Stale CDN assets or a mismatched
  generated client should produce a named issue, not a generic Worker/runtime
  failure.
- Negative-path starter/testkit recipes: keep the starter UI small, but the
  tested golden path should include copyable negative flows: revoked scope,
  expired auth, missing schema, blob denied/missing object, offline queued write,
  realtime reconnect, and local recovery. Happy-path-only smokes will miss the
  rough edges users actually hit.
- Outbox, backpressure, and conflict UX: apps need a stable way to show queued,
  retrying, rejected, conflicted, superseded, and needs-user-action mutations.
  Generated mutations should make command correlation, retry state, and local
  visibility expectations understandable without exposing raw internal tables.
- Local database maintenance: quota pressure, compaction/vacuum, blob-cache
  eviction, OPFS/IndexedDB corruption, sign-out wipe, and incompatible local
  schema recovery should have guarded app-facing operations with typed
  consequences. Recovery should never be a mystery mix of clearing site data
  and hoping bootstrap starts over.
- Support bundle helper: a failing app test or production support report should
  be able to collect a redacted bundle containing browser health, deployment
  preflight, schema readiness, recent diagnostic markers, outbox summary,
  realtime cursors, request ids, package versions, and safe storage metadata.
- Telemetry and SLO mapping: `requiresAction`, diagnostic codes, rate-limit
  events, bootstrap duration, local-visibility delay, outbox age, realtime
  reconnects, and blob failures should map cleanly to metrics/logs/Sentry
  without exposing tokens, signed URLs, or row payloads.
- Security and authority explainer: the docs need one precise model for actor,
  token claims, campaign/project membership, row scope, partition id, blob
  reference row, and storage object. Users should understand why a hash or
  global package row does not grant scoped access by itself.
- Upgrade and rollback state diagram: operator docs should cover old browser
  client + new server, new generated client + old server, local database
  schema too old/new, failed migration, bad generated output, rollback after a
  bad release, and when local reset/rebootstrap is safe.
- API naming and audience hygiene: root helpers, generated wrappers,
  operator/CLI checks, testkit utilities, debug snapshots, and advanced raw
  worker methods should stay consistently named and clearly labeled. If docs
  show an escape hatch, they should say why it is not the default app path.
- Deterministic timeline artifacts: realtime and sync tests should be able to
  print the same ordered facts a human wants: command id, outbox seq, push
  request id, commit seq, realtime event cursor, pull reason, apply result, and
  local query visibility point.

### Source Feedback Coverage Audit

Use this as the trace from the pasted Skaldsong notes to retained or planned
WP-50 work. The point is to keep each integration pain attached to a public
contract, not to preserve the notes as a second backlog.

- Browser persistence guidance is carried as a product requirement, not just a
  docs task. Retained work already exposes browser health and durable/fallback
  storage state; remaining work is the browser deployment preflight for
  Worker/WASM asset serving, MIME types, OPFS/secure-context requirements,
  persistence availability, quota/eviction, and deploy-time failure messages.
- Browser health is partially shipped through `getSyncularBrowserHealth(...)`
  with storage, bootstrap, subscriptions, realtime, last error,
  `requiresAction`, and recommended actions. Still missing are stronger
  realtime proof details such as last remote event cursor, last pull trigger,
  and last local apply.
- Typed runtime/setup failures are accepted as an API-shape requirement.
  Shared taxonomy and health actions now cover the main recovery categories;
  remaining concrete codes should focus on missing runtime assets, wrong asset
  content type, Worker startup failure, OPFS/SAH-pool unavailability,
  unexpected storage fallback, and bootstrap timeout.
- Bootstrap/sync semantics are split into two tracks: docs must explain
  bootstrap, explicit pull, autosync, realtime wakeup, and local read-model
  freshness; APIs should continue replacing manual `sync()` workarounds with
  local visibility helpers. The shipped `awaitLocalVisibility(...)` and
  generated table helpers cover the first app-facing primitive.
- Per-table/per-scope readiness remains a follow-up on top of the shipped
  schema readiness and health helpers. The desired outcome is view-level
  gating that can name whether auth, schema, rate limits, missing rows, blob
  access, or runtime capability blocked a subscription.
- Auth/scope replacement is partially shipped through
  `replaceSyncularAuthContext(...)`, generated database methods, scoped fresh
  app smokes, and Hono/WebSocket/WASM coverage. Remaining work is richer
  denied-subscription detail payloads with safe actor, requested scope,
  token/campaign scope, table, and subscription identifiers.
- Permission-denied testing is partially shipped through project/campaign actor
  helpers, membership fixtures, denied-scope coverage, and stable diagnostic
  marker assertions. Keep extending this through structured error details
  instead of matching server message strings.
- Realtime proof is partially tested but not yet polished as a UI-facing
  signal. Keep the product contract that realtime is a wake path and HTTP
  catchup is authoritative, but expose enough state to prove a browser joined a
  campaign/project, received a wakeup, triggered catchup, and applied local
  rows.
- Rate-limit diagnosis is accepted as diagnostic-taxonomy work. Logs and
  app-facing details should include actor, operation type, retry-after/current
  window, and scope/subscription context so tests can distinguish app churn
  from a wrong actor model.
- Blob partition and package-delivery pain is mostly resolved at the model
  level: shared bytes do not grant access, and campaign/project access is
  granted by scoped metadata rows or an explicit shared-partition policy.
  Continue adding examples for package/base assets that cross scope
  boundaries.
- Missing blob access is partially typed through Hono route details and shared
  error taxonomy. Keep the distinction between missing reference row, forbidden
  partition/scope, signed URL or direct-transfer token failure, missing upload
  record, missing blob row, and missing storage object.
- Schema/deploy readiness is partially shipped through app/runtime readiness,
  `syncular schema check --json`, generated app wrappers, and
  `getSyncularServerSchemaReadiness(...)`. Remaining work is an operator
  runbook that ties schema setup, generated output freshness, package/protocol
  upgrades, rollback, and release ordering together.
- Deterministic E2E is partially served by fresh app smokes and testkit
  helpers. Still needed is a copyable recipe with local Postgres, explicit test
  auth, real server routes, real browser client, realtime enabled, durable
  browser persistence, safe failure artifacts, and no mocked persistence.
- Stable log marker conventions are partially shipped through testkit
  diagnostic marker helpers. Server logs, client health, generated diagnostics,
  console events, and testkit assertions still need a shared event-code shape
  for rate limits, revoked subscriptions, bootstrap timeout, schema errors,
  blob errors, realtime reconnect, realtime event delivery, and local apply.
- API audience labels and privacy boundaries are partially shipped through the
  diagnostic detail policy and observability docs. Continue labeling surfaces
  as UI-facing, operator/deploy, debug/console, testkit/E2E, or advanced, and
  keep bearer tokens, signed URLs, and full payloads out of default diagnostics.
- Local recovery controls are a distinct remaining product surface. Health can
  say who must act, but apps still need guarded operations for sign-out,
  corrupt or incompatible local databases, unrecoverable bootstrap, stuck
  outbox, revoked scope state, and restart/resume flows.
- The pasted feedback does not justify new compatibility branches or old JS
  client behavior. All retained work should stay Rust-first, generated-client
  first, and fail-closed around scoped access.

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
- A later planning pass added a DX risk register for first-run mental model,
  browser deployment preflight, multi-tab lifecycle, local recovery controls,
  bundle/WASM cost visibility, dependency side-effect isolation, data modeling,
  upgrades, production ops, performance budgets, failure artifacts, auth
  provider integration, and console-to-app continuity.
- A follow-up decision pass closed the remaining starter/auth/doctor/adapter
  questions: keep one React+Bun/Hono golden starter until other templates earn
  their own smokes, keep starter debug state minimal, split adapter coverage
  between PR-focused tests and release-rehearsal matrix checks, keep generated
  auth-context helpers generic until product semantics exist, and keep
  `schema check` narrow until a broader `doctor` has multiple checks to
  orchestrate.
- A source feedback coverage audit now maps every worthy pasted integration
  point to shipped slices or explicit remaining WP-50 risks, so future sessions
  can continue from contracts and tests rather than re-triaging the raw notes.
- A later rough-edge expansion captured additional non-happy-path product
  prompts around browser support matrices, SSR/bundler boundaries, runtime
  state-machine semantics, version/asset alignment, negative-path recipes,
  outbox/conflict UX, local database maintenance, redacted support bundles,
  telemetry/SLO mapping, security authority modeling, upgrade/rollback states,
  API audience hygiene, and deterministic timeline artifacts.
- The first browser deployment preflight slice adds
  `getSyncularBrowserDeploymentPreflight(...)` to `@syncular/client`, checking
  Worker/WebAssembly support, secure-context/cross-origin-isolation flags,
  OPFS/IndexedDB durable storage availability, persistent-storage status,
  quota budgets, and served WASM runtime asset status/content types before a
  database is opened.
- The starter now calls browser deployment preflight before opening
  `createSyncularAppDatabase(...)`, using the generated required runtime
  feature list and its configured IndexedDB storage expectation. The scaffold
  smoke checks Vite can transform the starter preflight client module.
- A first adapter-boundary slice added `bun run imports:check`, a static root
  import graph smoke that proves `@syncular/client` and `@syncular/server`
  roots do not reach optional subpath files or optional peer packages.
- The post-publish JavaScript install smoke now runs a release-time optional
  subpath import matrix by default. It installs `@syncular/client`,
  `@syncular/server`, and the Bun-friendly optional peers in a fresh npm
  project, then imports the folded client/server subpaths for React, Sentry,
  Tauri, React Native, CRDT/Yjs, Hono, Cloudflare, Bun SQLite, D1, LibSQL, Neon,
  PGlite, Postgres, SQLite, filesystem, S3, service-worker, relay, and snapshot
  artifact helpers.
- A first local recovery slice adds `getSyncularLocalRecoveryPlan(...)`,
  `runSyncularLocalRecoveryAction(...)`, and managed database methods
  `localRecoveryPlan()`, `runLocalRecoveryAction(...)`, and
  `exportLocalSupportBundle()`. The plan classifies local health findings,
  lifecycle action-required state, failed outbox/blob upload state, storage
  maintenance, reset requests, and redacted support-bundle export into typed
  actions, with confirmation required before destructive repairs or resets.
- The browser/Hono/WASM local-health test now exercises that plan/action API
  against the real Worker runtime for corrupted subscription state and
  orphaned verified roots, including the confirmation guardrail and successful
  `force-rebootstrap` / `clear-orphaned-state` repairs.
- The upgrade guide now has an operator runbook for exact version sets,
  generated output checks, deploy-time schema setup, live server schema
  readiness, server/client rollout order, browser deployment preflight,
  recovery monitoring, support-window tightening, and rollback cases for
  code-only, forward-compatible schema, destructive schema, database restore,
  bad browser/runtime assets, and local client recovery.
- The `create-syncular-app` scaffold smoke now builds the generated app, serves
  Vite preview, verifies built preview assets, and includes an opt-in
  Chrome/Chromium DevTools Protocol check that opens the built page and waits
  for Syncular browser health/schema lines. Local evidence proved the build and
  preview asset path; the real-browser portion skipped because this machine
  has no Chrome/Chromium binary, and can be enforced on a browser-capable
  runner with `SYNCULAR_CSA_BROWSER_PREVIEW_SMOKE=required`.
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
- 2026-06-30 fifteenth implementation slice made diagnostic privacy and API
  audience labels explicit: the browser Console diagnostics publisher now
  exports a stable detail-key policy and classifier, public observability docs
  explain safe/summarized/redacted/omitted detail handling, and the docs label
  UI-facing, operator/deploy, debug/console, testkit/E2E, and advanced
  diagnostic surfaces.

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
- 2026-06-30: Added a broader DX risk register covering browser deploy
  preflights, multi-tab/lifecycle behavior, local recovery controls, bundle and
  WASM cost visibility, dependency side-effect isolation, data modeling,
  upgrades, production ops, performance budgets, failure artifacts, auth
  provider integration, and console-to-app continuity.
- 2026-06-30: Added a source feedback coverage audit that maps the pasted
  Skaldsong notes to retained slices and remaining WP-50 risks, including
  browser persistence, health, setup errors, bootstrap/sync semantics, auth,
  realtime, rate limits, blobs, schema/deploy readiness, E2E, log markers,
  audience labels, privacy, and local recovery controls.
- 2026-06-30: Added `packages/client/src/browser-deployment-preflight.ts` and
  exported `getSyncularBrowserDeploymentPreflight(...)` from `@syncular/client`
  as a non-mutating browser deploy check for runtime assets, MIME/content
  types, Worker/WebAssembly support, secure context, optional
  cross-origin-isolation, OPFS/IndexedDB persistence, storage persistence, and
  quota.
- 2026-06-30: Added focused browser-deployment-preflight tests for ready
  deploys, explicit OPFS blockers, default OPFS fallback warnings, bad or
  missing runtime assets, and browser capability blockers.
- 2026-06-30: Wired the `create-syncular-app` starter's `openAppClient()` to
  run `getSyncularBrowserDeploymentPreflight(...)` before opening the managed
  database, and extended the scaffold smoke to check Vite transforms the
  preflight client module.
- 2026-06-30: Generated TypeScript app databases now expose
  `schemaReadiness()` with the generated schema version injected and
  table-scoped local-visibility helpers such as `awaitTaskVisibility(...)` with
  table metadata injected.
- 2026-06-30: Updated the starter app and fresh JavaScript smoke to use the
  generated readiness/visibility helpers instead of passing
  `syncularGeneratedSchemaVersion` or raw `tables` options from app code.
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
- 2026-06-30: Exported `SYNCULAR_DIAGNOSTIC_DETAIL_POLICY` and
  `classifySyncularDiagnosticDetailKey(...)` from `@syncular/client`, reusing
  the Console diagnostics redaction/compaction policy instead of leaving it as
  private implementation detail.
- 2026-06-30: Added focused Console diagnostics and public API tests covering
  safe, summarized, redacted, and omitted diagnostic detail key decisions.
- 2026-06-30: Updated public observability docs with diagnostic privacy rules
  and API audience labels for UI-facing health, operator/deploy readiness,
  debug/console snapshots, testkit markers, and advanced raw diagnostic sinks.
- 2026-06-30: Added generated TypeScript app database wrappers for
  `schemaReadiness()` and per-table local visibility helpers, regenerated the
  starter/todo TypeScript outputs, and updated the JavaScript docs, package
  README, starter README, and smoke script to use the app-shaped helper path.
- 2026-06-30: Resolved the remaining product-contract open questions into
  starter/template, debug-state, adapter-matrix, generated auth-context, and
  `doctor`/schema-check decisions, then replaced the open-question list with
  concrete remaining implementation risks.
- 2026-06-30: Added `scripts/check-import-boundaries.ts` plus the root
  `imports:check` script to statically walk the `@syncular/client` and
  `@syncular/server` root import graphs and fail if they reach optional
  adapter subpaths or optional peer packages.
- 2026-06-30: Extended `scripts/post-publish-install-smokes.ts` with a
  JavaScript optional subpath import matrix controlled by
  `SYNCULAR_POST_PUBLISH_OPTIONAL_IMPORT_MATRIX`. The matrix creates a fresh
  npm project, installs the published client/server packages plus
  Bun-friendly optional peers, and imports the folded client/server subpaths
  for React, Sentry, Tauri, React Native, CRDT/Yjs, Hono, Cloudflare, Bun
  SQLite, D1, LibSQL, Neon, PGlite, Postgres, SQLite, filesystem, S3,
  service-worker, relay, and snapshot artifact helpers.
- 2026-06-30: Expanded the rough-edge register with additional implementation
  prompts for browser support and SSR/bundler matrices, lifecycle state-machine
  semantics, version/asset compatibility, negative-path recipes,
  outbox/conflict UX, local database maintenance, redacted support bundles,
  telemetry/SLO mapping, security authority modeling, upgrade/rollback states,
  API audience hygiene, and deterministic sync/realtime timeline artifacts.
- 2026-06-30: Added `packages/client/src/local-recovery.ts` and exported
  `getSyncularLocalRecoveryPlan(...)`,
  `runSyncularLocalRecoveryAction(...)`, and
  `SyncularLocalRecoveryError` from `@syncular/client`.
- 2026-06-30: Added managed database recovery methods:
  `localRecoveryPlan(...)`, `runLocalRecoveryAction(...)`, and
  `exportLocalSupportBundle()`.
- 2026-06-30: Added focused local-recovery tests covering healthy plans,
  grouped local health repair actions, confirmation guardrails, failed
  outbox/blob retry actions, explicit reset/maintenance opt-ins, and
  redacted support-bundle export.
- 2026-06-30: Updated the package README and public error-handling docs so app
  code reaches for `localRecoveryPlan()` before destructive local repair or
  reset operations.
- 2026-06-30: Extended the Hono-backed browser/WASM local-health test so it
  repairs corrupted subscription state and orphaned verified roots through the
  new local recovery plan/action API instead of direct low-level repair calls.
- 2026-06-30: Expanded the public upgrade guide with operator upgrade and
  rollback runbooks, and linked the deployment checklist to that upgrade order.
- 2026-07-01: Extended the `create-syncular-app` scaffold smoke so it builds
  the generated app, serves Vite preview on the allocated port, verifies built
  assets, and optionally runs a Chrome/Chromium CDP browser check against the
  built page.

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
- `bun test packages/client/src/console-diagnostics.test.ts packages/client/src/public-api.test.ts`
- `bunx biome check packages/client/src/console-diagnostics.ts packages/client/src/console-diagnostics.test.ts packages/client/src/public-api.test.ts apps/docs/content/docs/operate/observability.mdx`
- `bun --cwd packages/client tsgo`
- `git diff --check`

Most recent generated-helper rerun:

- `cargo fmt --all --check` from `rust/`
- `cargo test -p syncular-codegen --manifest-path rust/Cargo.toml typescript_module_supports_multiple_app_tables`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir packages/create-syncular-app/template --check`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
- `bun --cwd packages/client tsgo`
- `bun --cwd packages/create-syncular-app tsgo`
- `bun --cwd apps/docs types:check`
- `bunx biome check apps/docs/content/docs/clients/javascript/generated-client.mdx apps/docs/content/docs/clients/javascript/index.mdx packages/client/README.md packages/create-syncular-app/template/README.md packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/template/src/client/syncular.ts scripts/fresh-app-smokes.ts`
- `bun run docs:stale-check`
- `bun test packages/syncular/src/cli.test.ts`
- `bun --cwd packages/create-syncular-app smoke`
- `bun scripts/fresh-app-smokes.ts --skip-rust --work-dir .context/wp50-fresh-app-smoke-generated-helpers-rerun`
- `git diff --check`

Most recent adapter-boundary rerun:

- `bun run imports:check`

Most recent browser-deployment-preflight rerun:

- `bun test packages/client/src/browser-deployment-preflight.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bun --cwd packages/create-syncular-app tsgo`
- `bun run imports:check`
- `bunx biome check packages/client/src/browser-deployment-preflight.ts packages/client/src/browser-deployment-preflight.test.ts packages/client/src/index.ts packages/client/src/public-api.test.ts packages/create-syncular-app/template/src/client/syncular.ts packages/create-syncular-app/scripts/smoke.ts`
- `bun --cwd packages/create-syncular-app smoke`
- `bun --cwd apps/docs types:check`
- `bun run docs:stale-check`
- `git diff --check`

Most recent optional-import-matrix rerun:

- `bunx biome check scripts/post-publish-install-smokes.ts`
- `bun scripts/post-publish-install-smokes.ts --help`
- Disposable local `node_modules/@syncular/*` symlink import check covering 27
  optional subpath exports from `@syncular/client` and `@syncular/server`
- `git diff --check`

Most recent local-recovery rerun:

- `bun test packages/client/src/local-recovery.test.ts packages/client/src/public-api.test.ts`
- `bun test packages/client/src/__tests__/sync-hono.wasm.test.ts -t "reports and safely repairs browser local health findings"`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/local-recovery.ts packages/client/src/local-recovery.test.ts packages/client/src/database.ts packages/client/src/index.ts packages/client/src/public-api.test.ts apps/docs/content/docs/features/error-handling.mdx packages/client/README.md`
- `bunx biome check packages/client/src/__tests__/sync-hono.wasm.test.ts packages/client/src/local-recovery.ts packages/client/src/local-recovery.test.ts`
- `bun run docs:stale-check`
- `bun --cwd apps/docs types:check`
- `git diff --check`

Most recent upgrade-runbook rerun:

- `bun --cwd apps/docs types:check`
- `bun run docs:stale-check`
- `git diff --check`

Most recent starter built-preview rerun:

- `bunx biome check packages/create-syncular-app/scripts/smoke.ts packages/create-syncular-app/template/scripts/dev.ts`
- `bun --cwd packages/create-syncular-app tsgo`
- `bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks.
  - Skipped the real-browser CDP check because no Chrome/Chromium binary was
    available locally; set `SYNCULAR_CSA_BROWSER_PREVIEW_SMOKE=required` on a
    browser-capable runner to make that part mandatory.

## Sequencing

1. Golden path starter and smoke: first retained slice is done for the
   browser/runtime health surface. Continue growing the starter only when it
   proves a concrete app-facing rough edge.
2. Browser/runtime health contract: first retained slices are done. The helper
   now exposes durability/bootstrap/realtime/subscription status plus
   `requiresAction` and taxonomy-backed recommended actions. Future slices
   should add missing setup/runtime error codes as concrete failures appear.
   A browser deployment preflight helper now covers setup checks that should
   run before opening the database or starting the Worker.
3. Local visibility primitive: first retained slice is done with a
   query/predicate helper and managed database method. Generated TypeScript app
   databases now also expose table-scoped wrappers such as
   `awaitTaskVisibility(...)`, so common app waits do not pass raw table lists.
   Future generated helpers can still add command-specific or
   subscription-specific waits when a starter flow proves a narrower API.
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
   and server required/latest schema versions. Generated TypeScript app
   databases now wrap `schemaReadiness()` with the baked generated schema
   version so app code does not pass version constants for the normal check.
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
10. Diagnostic privacy and API audience labels: first slice is done with an
    exported client-side detail policy/classifier, Console diagnostics tests,
    public API coverage, and observability docs that separate UI-facing,
    operator/deploy, debug/console, testkit/E2E, and advanced raw diagnostic
    surfaces.
11. Local recovery controls: first app-facing slice is done with a recovery
    plan/action API over existing local health, support-bundle, lifecycle,
    failed outbox, failed blob upload, compaction, cache clear, repair, and
    reset primitives. Destructive actions require confirmation text and reset
    actions are opt-in so normal UI recovery does not accidentally clear local
    data. A focused browser/Hono/WASM test now proves the plan/action API over
    the real Worker runtime for local health repairs.
12. Upgrade and rollback runbooks: first operator docs slice is done. The
    public upgrade guide now gives a step-by-step production upgrade order,
    rollback cases by data/schema risk, and local client recovery guidance; the
    deployment checklist links to that runbook.
13. Browser deployment preflight built-preview coverage: first scaffold slice
    is done for production build and preview asset serving, and the smoke now
    has an opt-in Chrome/Chromium CDP path for executing the built page in a
    real browser. A browser-capable CI runner still needs to enforce that
    optional path.

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
- Diagnostic detail keys are safe-by-default. Browser Console diagnostics
  expose a public policy that classifies details as safe, summarized, redacted,
  or omitted; raw diagnostic sinks remain an advanced/local-debug surface that
  must be redacted before forwarding to external services.
- Generated TypeScript app databases should wrap root primitives when the app
  schema can remove boilerplate without inventing product semantics. The
  generator now injects `syncularGeneratedSchemaVersion` for
  `schemaReadiness()` and app table lists for helpers such as
  `awaitTaskVisibility(...)`; the root helpers remain available for advanced
  ungenerated or multi-table waits.
- Schema readiness is layered: `syncular schema check --json` owns file-level
  CI/deploy checks for app contract, migrations, and generated output, while
  `getSyncularServerSchemaReadiness(...)` owns live database/server readiness.
  A future `doctor` command can orchestrate these narrower checks if the
  product needs a broader umbrella.
- The first canonical starter stays React + Bun/Hono by default for this WP.
  That is not a claim that Syncular is React- or Bun-only; it is the one
  executable golden path with the strongest current smoke coverage. Additional
  framework-neutral, Node, or Cloudflare templates should be added only when
  they get their own scaffold smoke and do not weaken the default path.
- The starter should show only minimal app-facing debug state: browser health,
  schema readiness, sync/status badge, query errors, and queued outbox count.
  It should not become a console demo. Deeper diagnostics belong in
  observability docs, testkit assertions, and the console/workbench.
- Adapter coverage is layered. PR gates should run the starter smoke, docs
  stale-pattern checks, package typechecks, and focused adapter tests for files
  touched in the PR. Release rehearsal should own the broader import/install
  matrix for Bun, Node, Cloudflare, database adapters, blob stores, Sentry,
  React Native, Tauri, CRDT/Yjs, and post-publish package installation.
- Generated app clients should not invent campaign/project join helpers around
  `replaceAuthContext(...)` until the app contract has enough product semantics
  to define membership and token refresh safely. The root managed database
  method remains the public contract; app-specific join/create flows belong in
  app code, recipes, or testkit fixtures for now.
- `syncular schema check` remains the narrow deploy/CI readiness command.
  Do not add a broad `syncular doctor` until there are several independently
  useful checks to orchestrate, such as schema readiness, browser deployment
  preflight, adapter import isolation, package version alignment, and runtime
  asset serving.

## Remaining Implementation Risks

- Browser deployment preflight: first helper slice is done for Worker/WASM
  assets, MIME/content types, cross-origin isolation option, OPFS/IndexedDB
  requirements, durable storage availability, fallback behavior, persistence
  grant status, and quota budgets. The starter now runs the helper before
  opening Syncular. The scaffold smoke checks the transformed preflight module,
  now builds and serves Vite preview, verifies built assets, and can execute
  the built page through Chrome/Chromium CDP when a browser is available.
  Remaining work is to provision a browser-capable CI/release runner and make
  `SYNCULAR_CSA_BROWSER_PREVIEW_SMOKE=required` there so this path is enforced
  automatically.
- Adapter import side-effect isolation: the first root import graph smoke now
  proves root client/server imports do not statically reach optional Bun,
  Cloudflare, S3, Sentry, Neon, Tauri, React Native, or CRDT/Yjs subpaths.
  The post-publish JavaScript install smoke now owns the first release-time
  optional subpath install/import matrix for Bun-friendly client/server
  subpaths. Remaining work is a separate native-driver/platform matrix for
  `better-sqlite3` and `sqlite3`, if release policy decides those native
  drivers should be installed on every release runner.
- Multi-tab and lifecycle behavior: document and test two tabs, tab
  suspension/resume, storage locks, shutdown, and app restarts for persistent
  browser databases.
- Local recovery controls: first plan/action slice is done for support bundles,
  local health repairs, failed outbox/blob retries, compaction, cache clear,
  and guarded sync-state reset, with a focused Hono/WASM proof for corrupted
  subscription state and orphaned verified roots. Remaining work is to add
  product-specific sign-out/wipe guidance, cover unrecoverable bootstrap and
  revoked-scope UI through the same action model, and decide whether multi-tab
  recovery needs additional lock/coordination actions.
- Browser and bundler matrix: prove durable persistence, loud unsupported
  failures, SSR-safe root imports, and optional-subpath isolation across the
  environments users actually build with: Vite, Next/SSR, Bun, Node,
  Cloudflare, Chrome, Safari, Firefox, private mode, WebViews, and PWAs.
- Runtime timeline and support bundles: expose enough ordered state to explain
  configured/storage/schema/bootstrap/realtime/local-apply transitions, and add
  a redacted support-bundle helper for app tests and production incidents.
- Outbox and conflict UX: make queued/retrying/rejected/conflicted mutations,
  command correlation, retry state, and local visibility expectations stable
  enough for generated app UI and tests.
- Upgrade and production ops runbooks: turn schema/package/protocol upgrade
  order, backup/restore, blob-store consistency, rate limits, credential
  rotation, local database recovery, and rollback into copyable operator docs.
  The first upgrade/rollback slice is done; remaining production-ops depth is
  blob-store consistency checks, rate-limit tuning, credential rotation
  cadence, and richer backup/restore drills.
- Performance and failure artifacts: keep package/WASM size, bootstrap
  latency, local visibility delay, sync apply, realtime reconnect, blob fetch
  latency, storage/quota pressure, and redacted E2E failure artifacts
  measurable.

## Next Action

Pick the next implementation slice from the remaining risks. Strong candidates
are browser-capable CI enforcement for the built-preview smoke, multi-tab
lifecycle coverage, or runtime timeline/support-bundle artifacts, because those
remain broad DX holes after the first local recovery browser proof, upgrade
runbook, and built-preview asset smoke.
