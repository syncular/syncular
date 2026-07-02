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
- Explicit browser support tiers: for Chrome, Safari, Firefox, private mode,
  WebViews, and PWAs, Syncular should name whether persistent offline storage
  is supported, unsupported, or development/test-only ephemeral. Silent
  in-memory fallback is not acceptable for production browser apps.
- First-run asset/version compatibility: opening a browser database should
  prove that the served Worker/WASM assets, JS glue, generated client schema
  version, runtime package version, and server protocol/schema contract belong
  together. Stale service-worker/cache/CDN assets should produce typed
  compatibility failures rather than bootstrap timeouts.
- Recovery ownership should be explicit in every lifecycle and health state:
  runtime retry, app auth/scope action, user action, or operator/deploy action.
  The state should also say which operations are valid now and which operations
  are blocked until recovery completes.
- Support bundle provenance: redacted bundles should include enough
  non-secret context to reproduce the environment: app build id if available,
  package/runtime/generated schema versions, browser/runtime feature summary,
  storage backend, deployment preflight result, server endpoint origin,
  request/sync/timeline cursors, and redaction policy version.
- Browser persistence proof should include reopen/restart behavior, not only a
  same-page happy path. Real offline-first confidence needs evidence across
  tab close, page restore, browser restart where possible, storage locks, quota
  pressure, and blocked/denied persistence grants.

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
- Stability policy for codes and helper contracts: once app tests are expected
  to assert error codes, event codes, readiness issue codes, and helper return
  shapes, those codes need a versioning/deprecation promise. Adding new detail
  is fine; renaming or reclassifying a public code should be treated like an
  API break.
- Generated-client ownership boundaries: generated mutations, generated
  read-model helpers, server-owned columns, local-only tables, raw SQL access,
  and advanced runtime escape hatches need crisp docs about who owns each
  write/read path. The starter should not make accidental low-level patterns
  look like the blessed app API.
- Failure-driven docs examples: each major guide should include at least one
  realistic failure or recovery state, not only a happy path. Users should see
  what denied scope, stale generated output, missing browser persistence,
  blob access failure, and realtime recovery look like before they hit them in
  production.
- Reproducible fixture topology: testkit and docs should agree on one small
  domain model for scoped actors, membership, app rows, blobs, and local read
  models. Keeping examples on one topology makes failures comparable across
  starter smokes, browser tests, server route tests, support bundles, and the
  console.
- Documentation information architecture: the first-run docs should be a
  product path, not a reference maze. Low-level pages can exist, but every
  public setup topic should link back to the golden loop: scaffold, generate,
  run, mutate, observe local visibility, go offline, recover, deploy checks,
  and test the same behavior.

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
  diagnostic marker helpers and structured Hono rate-limit details. Rate
  limit envelopes and logs now include actor, operation type, window counts,
  reset, and retry-after data. Server logs, client health, generated
  diagnostics, console events, and testkit assertions still need a shared
  event-code shape for revoked subscriptions, bootstrap timeout, schema
  errors, blob errors, realtime reconnect, realtime event delivery, local
  apply, and deeper scope/subscription-specific throttling context.
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

### Feedback Intake Canonicalization

The pasted integration notes are an external, untracked artifact. This WP is
the tracked canonical copy of everything worth retaining from that feedback.
Future sessions should not need the paste to understand the product pressure:
each accepted point must live as an implementation requirement, an acceptance
bar, a remaining risk, or a resolved anti-solution in this file.

Keep the accepted feedback collapsed into these product contracts:

- Runtime truth contract: UI health, support bundles, Console diagnostics,
  deploy readiness, testkit assertions, and failure artifacts should all
  answer the same questions about persistence, schema compatibility,
  bootstrap, realtime, last failure, recovery owner, and safe next action.
- Freshness and lifecycle contract: bootstrap, explicit pull, autosync,
  realtime wakeup, command acknowledgement, local apply, and local query
  visibility need ordered, app-facing evidence. Manual `sync()` calls are not
  the default stale-read fix.
- Auth, scope, and authority contract: actor, token subject, membership,
  subscription, table, scope, partition, blob reference row, and storage object
  semantics should be visible enough to debug safely, while access remains
  fail-closed and secrets stay redacted.
- Deploy and version contract: generated output, migrations, server schema,
  runtime package versions, served WASM/Worker assets, browser caches, and
  local database schema must have a checkable compatibility story before
  traffic hits an app.
- Negative-path evidence contract: the canonical app/testkit recipe should
  prove denied scope, auth replacement, realtime recovery, offline replay,
  local visibility, blob access, persistence durability, and redacted failure
  artifacts against real app surfaces.
- Import and dependency contract: optional integrations stay behind subpaths
  and peer dependencies, with root import and release matrices proving Bun,
  native-driver, Cloudflare, S3, Sentry, React Native, Tauri, and CRDT/Yjs code
  does not leak into unrelated apps.
- Operations and recovery contract: operator docs and helpers should cover
  schema readiness, upgrade/rollback, backup/restore, blob-store consistency,
  rate-limit tuning, credential rotation, local reset/rebootstrap, sign-out,
  and destructive recovery guardrails.

Do not reinterpret the feedback as permission to add convenient shortcuts:

- No old JavaScript-client compatibility branches.
- No request-startup production migrations.
- No raw synced SQL writes as a public app mutation path.
- No global blob hash or package row as an implicit scoped access grant.
- No "lite" browser database SKU used as a substitute for reducing real core
  cost and publishing honest size/init budgets.
- No package splits whose only purpose is hiding dependencies that should be
  handled through subpaths, peers, and import-side-effect checks.

### 2026-07-01 Pasted Feedback Intake Verdict

The latest pasted Skaldsong feedback is accepted into WP-50 as product pressure,
not as a separate raw backlog. The worthy parts are already represented in the
sections above and should be preserved through implementation in these forms:

- Browser runtime truth: browser health, deployment preflight, support bundles,
  and failure artifacts must expose durable-vs-ephemeral storage, Worker/WASM
  readiness, active subscriptions, last sync error, realtime socket state, and
  whether an in-memory fallback was intentional.
- Bootstrap and freshness truth: initial bootstrap, explicit pull, autosync,
  realtime wakeup, authoritative command acknowledgement, and local read-model
  visibility need distinct state and docs. Manual `sync()` must not become the
  blessed stale-read workaround.
- Auth and scope truth: subscription authorization failures, token/campaign
  scope mismatches, revoked membership, and denied tables need typed errors
  with safe actor/scope/table/subscription detail that tests can assert without
  parsing server prose.
- Realtime proof: tests and support output must show more than an open socket.
  The useful chain is scope joined -> event received -> pull/recovery reason
  -> local apply -> local visibility, with stable request/cursor markers.
- Blob and package authority: global package rows or content hashes are not
  access grants. Shared bytes need scoped metadata rows or an explicit shared
  partition policy, and blob failures must distinguish missing refs, forbidden
  scope, URL/token failure, upload/blob record gaps, and missing storage bytes.
- Deploy and schema readiness: migrations remain operator/deploy work, and CI
  needs machine-readable readiness for expected tables, schema versions,
  generated output freshness, server compatibility, and local/browser open
  failures.
- Deterministic app testing: the canonical recipe should use real auth, real
  server routes, real browser persistence, realtime, scoped actors/tokens,
  campaign or project membership changes, denied access, and redacted failure
  artifacts.
- Public API and log vocabulary: UI-facing helpers, generated wrappers,
  operator checks, testkit assertions, Console rows, logs, metrics, and Sentry
  attributes should share stable codes and safe detail fields, with clear
  audience labels for what is app-facing vs debug/support-only.

### 2026-07-01 Source Feedback Retention Checklist

The pasted Skaldsong notes are all worth retaining as product pressure. Do not
drop a point merely because the current code has a low-level primitive nearby;
each item should land as a public contract, a proof artifact, a docs/runbook
entry, or an explicit anti-solution.

- Browser runtime and persistence: keep first-class docs, preflight, health,
  support-bundle fields, and failure artifacts aligned around durable storage,
  OPFS/SQLite, Worker/WASM assets, browser support tier, fallback reason, and
  proof that production is not accidentally using memory storage.
- Bootstrap and sync semantics: keep one observable state model for initial
  bootstrap, explicit pull, autosync, realtime wakeup, command acknowledgement,
  local apply, and query visibility. Manual `sync()` remains an explicit
  advanced/debug action, not the normal stale-read recipe.
- Auth and permissions: keep subscription denial, revoked scope, token or
  campaign/project mismatch, auth replacement, and permission-denied tests
  structured around typed errors with safe actor, scope, table, subscription,
  and token-context details.
- Realtime: keep the proof chain longer than socket-open. A useful app/test
  artifact shows scope joined, remote event/cursor received, pull or recovery
  triggered, local rows applied, and local visibility observed, with rate-limit
  details that separate app churn from wrong actor setup.
- Blobs and package delivery: keep the authority model explicit. Shared bytes
  can be reused, but scoped metadata rows or an explicit shared-partition
  policy grant access; blob failures should distinguish missing refs, forbidden
  scope/partition, URL/token failure, missing upload/blob rows, and missing
  storage objects.
- Schema and deployment: keep production migrations outside request startup,
  keep `schema check` and server readiness machine-readable, and keep drift
  reasons split across missing schema, stale schema, stale generated output,
  incompatible server/client versions, browser asset skew, and local database
  open failure.
- Testing and DX: keep the canonical recipe real enough to catch integration
  bugs: local server, real browser client, durable persistence, scoped actors,
  explicit auth, realtime, denied access, offline replay, blob access, and
  redacted failure artifacts. Testkit helpers should reduce boilerplate
  without mocking away the authority path.
- API shape and docs: keep lifecycle, health, recovery, generated wrappers,
  operator checks, testkit helpers, debug snapshots, and advanced escape
  hatches labeled by audience. Stable codes and fields need additive evolution
  expectations once app tests are told to assert them.

Use this completion bar for each retained source point:

- There is a public API, generated wrapper, CLI JSON shape, testkit helper, or
  documented operator command that expresses the contract.
- There is at least one focused test, smoke, release check, browser artifact,
  or Console/Fleet ingestion path proving the contract on a realistic path.
- The docs route users through the golden scaffold/generate/run/mutate/observe
  loop before exposing raw internals.
- The implementation does not reintroduce manual-sync freshness fixes,
  request-startup migrations, raw synced SQL writes, implicit global blob
  access, old JavaScript-client compatibility, console-only debugging, or
  fake package/database splits that hide real product cost.

### 2026-07-01 Feedback Addendum

The feedback is worth keeping, but the implementation should avoid turning it
into a pile of unrelated helper APIs. The product answer should be a small set
of stable contracts that connect browser health, schema readiness, lifecycle,
auth/scope, realtime, local visibility, blobs, and support artifacts.

Retain these as implementation requirements:

- Fail-loud browser persistence policy: durable browser mode should refuse
  accidental memory storage unless the app explicitly opts into development or
  test-only fallback behavior. The health/preflight surface should say whether
  storage is durable, why it fell back, and which browser/deploy requirement is
  missing.
- One runtime truth surface, several audiences: UI health, deploy readiness,
  testkit assertions, support bundles, and console diagnostics should be
  different projections of the same event/error taxonomy, not parallel
  vocabularies.
- Ordered lifecycle semantics: document and expose the legal transitions from
  configured -> storage open -> schema ready -> bootstrapping -> locally
  visible -> realtime live -> recovering -> requires-action -> destroyed.
  Each state should say which app operations are valid and which operations are
  advanced escape hatches.
- Realtime proof chain: a "browser is live for campaign/project X" signal must
  include the ordered evidence a test or support report needs: subscription
  id/scope joined, socket state, remote event cursor, pull/recovery reason,
  sync attempt or request id, local apply result, and local visibility point.
- Auth and scope vocabulary: actor id, token subject, token/campaign/project
  scope, membership row, subscription id, table, partition id, and denied scope
  need one shared explanation. Default diagnostics may include safe ids and
  scope shapes, but raw token claims, bearer values, and signed URLs stay
  redacted.
- Scope-change contract over recipes: joining or creating a campaign/project
  can remain app-specific, but once the app has new auth/subscriptions the
  Syncular path should be blessed: replace auth context, reset affected
  bootstrap state, recover realtime/sync, await local visibility, and surface
  typed denied/revoked outcomes.
- Blob authority model: content hashes and global package rows are not access
  grants. The default pattern remains scoped metadata rows over shared bytes;
  shared partitions are an explicit advanced authorization policy.
- Schema readiness layers: keep file-level generated/migration checks,
  live-database readiness, browser runtime asset compatibility, and eventual
  `doctor` orchestration separate until each narrower check is useful by
  itself.
- Canonical negative-path E2E recipe: the copyable app test should eventually
  cover two actors, two browser clients, one campaign/project membership
  change, one denied scope, one offline queued mutation, one realtime wakeup,
  one local visibility wait, one blob access check, and one redacted failure
  artifact.
- Support bundle contract: support exports should combine browser health,
  deployment preflight, schema readiness, lifecycle/timeline events, recent
  diagnostic markers, outbox/conflict/blob summaries, realtime cursors, request
  ids, package/runtime versions, storage metadata, and redaction-policy
  decisions.
- App-facing outbox and conflict state: generated app UI should be able to show
  queued, retrying, rejected, conflicted, superseded, and needs-user-action
  mutations with stable command correlation and recommended actions.
- Production operations depth: after the first upgrade/rollback runbook, the
  next ops docs should add backup/restore drills, blob-store consistency
  checks, rate-limit tuning guidance, credential rotation, log retention, and
  support-window expectations.
- Browser/bundler matrix: the product should name what is proven for Vite,
  Next/SSR, Bun, Node, Cloudflare, Chrome, Safari, Firefox, private mode,
  WebViews, and PWAs, including which cases are unsupported and should fail
  loudly.
- Runtime support policy: when an environment is unsupported or only partially
  supported, the public API should fail with a named capability issue and a
  recommended action. It should not leave apps to infer support from missing
  IndexedDB/OPFS/Worker globals, vague initialization errors, or stalled
  bootstrap.
- Version and asset skew policy: deployment docs and checks should explain how
  to roll JS, WASM, generated client output, server package versions, database
  schema, and browser caches together. The accepted behavior for skew should
  be observable warnings or hard compatibility failures, not undefined local
  database state.
- Evidence budgets: starter and E2E artifacts should keep the key latency and
  durability facts measurable: runtime open time, schema readiness, bootstrap,
  local visibility after authoritative command, realtime wake-to-apply delay,
  offline replay drain, blob fetch, and support-bundle export time.

Do not retain these as solutions:

- Do not make manual `sync()` the documented stale-read fix. Keep freshness
  modeled through bootstrap/readiness, realtime recovery, and local visibility.
- Do not add "lite" browser database builds just to make size charts look
  better. Reduce real core cost where possible and publish honest size/init
  budgets.
- Do not publish or split packages merely to hide optional dependencies. Use
  subpaths, peer dependencies, side-effect checks, and release import matrices.
- Do not use global blob hashes, request-startup migrations, raw synced SQL
  writes, or old JavaScript-client compatibility as convenient DX shortcuts.
- Do not let the Console become the only reliable debugging interface. Every
  console-only insight should map back to a stable app-facing code, support
  bundle field, or testkit assertion.

### 2026-07-01 Additional Retention Prompts

These are the extra edges worth keeping from the review pass. They are not a
new product direction; they are pressure tests for whether the Rust-first
surface is actually comfortable in real apps.

- Public-contract stability tiers: distinguish stable app-facing helpers,
  generated wrapper contracts, deploy/operator contracts, debug/support
  shapes, and experimental diagnostics. Once tests or docs tell users to
  assert a code or field, renames and semantic reclassification need an
  explicit migration note.
- Snippet and recipe verification: code snippets for starter, generated
  client, server adapters, schema checks, auth replacement, blobs, and
  testkit recipes should eventually compile or run against a fixture. Stale
  prose is a DX bug when the import surface is intentionally subpath-heavy.
- Auth replacement race semantics: replacing auth context should define what
  happens to in-flight HTTP sync, websocket messages from the old token,
  queued local commands, old subscription cursors, and diagnostics emitted
  during the transition. The safe default is to ignore or fence old-authority
  evidence rather than merge it silently.
- Request and command correlation discipline: client-generated request ids,
  server request/event ids, outbox ids, generated mutation receipts,
  realtime cursors, pull reasons, and local visibility evidence should remain
  joinable without exposing payloads. This is the bridge between tests,
  support bundles, console rows, and production logs.
- Backpressure and retry visibility: apps need to know when the runtime is
  intentionally delaying sync because of rate limits, offline state, outbox
  pressure, blob upload retries, or realtime reconnect jitter. "Pending" is
  not enough if the app needs to decide between waiting, refreshing auth,
  asking the user, or escalating to an operator.
- Migration execution safety: deploy-time schema setup should be idempotent,
  version-stamped, and safe under concurrent deploys. Docs and checks should
  eventually mention locking/advisory locking expectations, partial-failure
  recovery, and how generated-client compatibility is decided during a rolling
  deploy.
- Dev/prod configuration fences: dangerous conveniences such as memory
  storage fallback, debug payload capture, local token shortcuts, request-log
  verbosity, and destructive local reset actions should be visibly marked as
  dev/test/debug-only or require explicit production confirmation.
- Environment self-reporting: every runtime should be able to describe the
  package version, generated schema version, server schema/protocol contract,
  storage backend, worker/WASM asset source, host runtime, and support tier in
  a redacted form. Users should not reverse-engineer this from stack traces or
  build output.
- Worker and concurrency model: browser docs should explain the single-writer
  database model, worker ownership, tab coordination assumptions, lock
  behavior, shutdown/resume expectations, and what an app may safely do while
  the runtime is opening, recovering, or being destroyed.
- Offline truthfulness: optimistic UI, queued mutations, local read freshness,
  conflict status, and server acknowledgement need a crisp story. Apps should
  be able to show "saved locally", "syncing", "accepted by server",
  "conflicted", and "needs action" without reading outbox internals.
- Security review path: the authority model should be easy to audit from
  docs and tests. For every route or helper that grants access to rows, blob
  refs, snapshot chunks, direct-transfer URLs, or realtime deltas, there
  should be a negative-path test that proves the wrong actor/scope fails with
  a typed reason.
- Support artifact ingestion decision: starter browser failures and
  Cloudflare runtime failures now leave safe JSON artifacts. Decide whether
  Console/Fleet or release rehearsal should ingest those shapes, and keep the
  artifact schema redacted, bounded, and versioned if it becomes public.
  `syncular doctor` remains a narrow schema/ops readiness umbrella, not a
  browser/runtime artifact ingester.
- Docs information scent: first-run docs should route users by task
  ("build a browser app", "add React", "deploy a server", "test scoped auth",
  "inspect a failure") before naming packages. Package and subpath reference
  pages should support the path, not become the path.
- Release confidence from public packages: post-publish smokes should keep
  proving that a blank external project can install the public npm packages,
  import optional subpaths with the right peers, generate code, and run a
  browser/offline smoke without relying on repo-local state or ignored `dist`
  files.
- Cross-environment unsupported states: Safari/private-mode/WebView/PWA/SSR
  failures should use the same capability issue model as Chrome/Vite
  failures. Unsupported should be a named product state, not a surprise
  timeout.
- Data-shape escape hatches: raw Kysely reads, local-only tables, generated
  mutations, app-owned audit tables, blob reference rows, CRDT fields, and
  advanced custom apply hooks should each say what they are for and what they
  cannot guarantee. This prevents users from turning an escape hatch into
  their main sync contract.
- Telemetry naming: diagnostic codes, metric names, support-bundle fields,
  console filters, and Sentry/log attributes should converge on the same
  vocabulary. A production alert for `schema.generated_too_old` should point
  at the same concept as the app health issue, CLI readiness output, and docs.
- Local destructive actions: reset, rebootstrap, cache clear, sign-out wipe,
  conflict discard, and blob-cache eviction should always state data-loss
  consequences, required confirmations, multi-tab blockers, and whether
  unsynced outbox work exists.

### Feedback-Driven Acceptance Matrix

Use this matrix when selecting future slices. A feedback item is only "done"
when the right public surface, docs, and gate exist for the audience that will
hit the problem.

- Browser persistence: must ship as code plus deploy/browser smokes, not docs
  alone. The app should fail loudly or report explicit test/dev fallback when
  OPFS/IndexedDB/WASM/Worker prerequisites are missing or assets are served
  incorrectly.
- Bootstrap and local freshness: must ship as generated/app-facing helpers and
  stable state, not recipes that call `sync()` after every command. Per-view
  readiness should eventually name subscription, scope/table, blocker, and
  recovery owner.
- Auth and permissions: must ship as one blessed scope-change path, typed
  denied/revoked errors, and testkit helpers. String-matching server messages
  is not an acceptable app or test contract.
- Realtime: must prove the whole chain, not only socket connectivity. The
  acceptable artifact links scope joined, event cursor, pull/recovery reason,
  sync attempt/request id, local apply, and local visibility.
- Blobs and base data: must preserve the authority model. Shared bytes are
  allowed, but scoped metadata rows or explicit shared partitions grant access;
  global hashes or package rows must never become implicit cross-scope grants.
- Schema and deploy: must stay operator/deploy-owned. Request-startup
  migrations, hidden bootstrap schema creation, or human-only deployment
  checks are not acceptable production defaults.
- E2E and failure artifacts: happy-path smokes are insufficient. The canonical
  recipe should exercise real auth, real browser persistence, realtime,
  offline replay, denied scope, blob access, and redacted failure artifacts.
- Browser durability: a same-page insert/query proof is not enough. Acceptance
  requires at least one real-browser reopen path, and future matrix work should
  add restart, private-mode, storage-lock, quota-pressure, and PWA/WebView
  variants where the host makes those states observable.
- API audience hygiene: every exposed helper should say whether it is
  UI-facing, generated-app-facing, operator/deploy, testkit/E2E,
  debug/support, or advanced. If the audience is unclear, app code will grow
  accidental escape hatches.
- Version skew: generated output, runtime package, WASM assets, server
  package, schema version, and browser cache state must have a detectable
  compatibility story. Stale or mixed deploys should produce typed readiness
  issues before app code starts making misleading freshness or sync decisions.
- Dependency and package shape: keep optional peers behind subpaths and prove
  side-effect isolation with import matrices. Do not split or publish packages
  merely to make dependency graphs look smaller.
- Operations depth: schema readiness and upgrade order are the first layer.
  A mature product still needs backup/restore drills, blob-store consistency
  checks, rate-limit tuning, credential rotation, rollback guidance, and local
  database recovery procedures.

### DX Completion Smell Tests

Use these as a final filter before calling any feedback-driven slice done.
They are intentionally phrased from the app developer and maintainer
perspective rather than from internal module ownership.

- First-run clarity: can a new app developer explain, after the starter path,
  what is local SQLite state, what is authoritative server state, what
  subscriptions do, how generated mutations sync, and how local reads become
  fresh without learning runtime internals?
- Runtime truth: can UI code, tests, support bundles, and the Console all
  answer the same core questions: durable or ephemeral storage, schema
  compatibility, bootstrap readiness, realtime state, last failure, recovery
  owner, and safe next action?
- Failure specificity: does the failure produce a stable code and safe detail
  fields for the real blocker instead of a generic timeout, bootstrap failure,
  or human-only log message?
- Recovery ownership: does every action-required state say whether the runtime
  will retry, the app should refresh auth/change scope, the user must choose a
  destructive/local action, or an operator must deploy/migrate/rollback?
- Freshness discipline: does the solution avoid teaching app code to call
  manual `sync()` as the normal stale-read fix, and instead use bootstrap,
  realtime recovery, generated visibility helpers, or command timelines?
- Authority discipline: do auth, scope, partition, blob, and package/base data
  examples preserve fail-closed authority boundaries instead of granting access
  through global rows, hashes, or convenient fallback behavior?
- Deployment confidence: can CI or deploy tooling prove generated output,
  migrations, server schema, package/runtime versions, and browser WASM assets
  line up before traffic sees the app?
- Browser confidence: does the proof cover built assets in a real browser and
  at least one reopen/restart-style persistence boundary where the platform
  makes that observable, not only a same-page happy path?
- Optional dependency isolation: can root imports and common starter paths run
  without loading Bun-only, native-driver, Cloudflare-only, S3, Sentry, React
  Native, Tauri, or CRDT/Yjs code until the matching subpath is imported?
- Artifact usefulness: when a smoke or E2E fails, does it leave a redacted
  artifact with the lifecycle phase, health/schema/support details, request or
  sync ids, realtime cursors when available, and enough safe context to
  reproduce the failure?
- Audience hygiene: does each public helper or doc example clearly belong to
  UI-facing app code, generated app wrappers, operator/deploy checks,
  testkit/E2E, debug/support, or an advanced escape hatch?
- Stability promise: if app tests are expected to assert a code, helper shape,
  marker, readiness issue, or artifact field, is it treated as a public
  contract with additive evolution rather than casual renaming?

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
  auth-context helpers generic until product semantics exist, keep
  `schema check` narrow, and add only a narrow `doctor` once schema and ops
  checks have stable contracts.
- A source feedback coverage audit now maps every worthy pasted integration
  point to shipped slices or explicit remaining WP-50 risks, so future sessions
  can continue from contracts and tests rather than re-triaging the raw notes.
- A 2026-07-01 feedback addendum turns the second-pass review into product
  requirements and anti-solutions: fail-loud persistence, one shared runtime
  truth surface, ordered lifecycle semantics, realtime proof chains,
  auth/scope vocabulary, scoped blob authority, schema-readiness layering,
  canonical negative-path E2E, support-bundle contents, outbox/conflict UX,
  production-ops depth, browser/bundler matrix, and explicit things not to do.
- A follow-up feedback acceptance matrix now says which pasted-feedback items
  need code, gates, docs, and public contracts before they can be considered
  done, with explicit acceptance bars for browser persistence, local
  freshness, auth, realtime, blobs, deploy, E2E artifacts, API audience labels,
  optional dependency boundaries, and production operations.
- A later rough-edge expansion captured additional non-happy-path product
  prompts around browser support matrices, SSR/bundler boundaries, runtime
  state-machine semantics, version/asset alignment, negative-path recipes,
  outbox/conflict UX, local database maintenance, redacted support bundles,
  telemetry/SLO mapping, security authority modeling, upgrade/rollback states,
  API audience hygiene, and deterministic timeline artifacts.
- A final feedback-retention pass kept the remaining cross-cutting DX
  obligations that are easy to lose during implementation: public code/helper
  stability policy, generated-client ownership boundaries, failure-driven docs
  examples, reproducible fixture topology, and first-run docs that route users
  through the golden app loop before reference pages.
- A canonical feedback-intake pass now records the external Skaldsong feedback
  as tracked WP-50 product contracts: runtime truth, freshness/lifecycle,
  auth/scope authority, deploy/version compatibility, negative-path evidence,
  import/dependency isolation, and operations/recovery, plus explicit
  anti-solutions that should not be revived in later sessions.
- A final checklist pass added DX completion smell tests for first-run mental
  model, runtime truth, failure specificity, recovery ownership, freshness,
  authority, deploy confidence, browser persistence, optional dependencies,
  failure artifacts, audience labels, and public contract stability.
- A final retention pass added the remaining review prompts that are easy to
  lose while implementing locally useful helpers: public stability tiers,
  snippet verification, auth-transition race semantics, request/command
  correlation, retry/backpressure visibility, concurrent migration safety,
  dev/prod fences, runtime self-reporting, worker/concurrency semantics,
  offline truthfulness, security-review negative tests, artifact ingestion,
  docs information scent, public-package release confidence,
  cross-environment unsupported states, data-shape escape hatches, telemetry
  naming, and destructive local-action guardrails.
- A latest pasted-feedback intake verdict now keeps the worthy source notes as
  retained product contracts for browser runtime truth, bootstrap/freshness
  semantics, auth/scope failures, realtime proof, blob/package authority,
  deploy/schema readiness, deterministic app tests, and shared public API/log
  vocabulary.
- A source-feedback retention checklist now says every pasted Skaldsong point
  is worth keeping as product pressure, but must land as a public contract,
  proof artifact, docs/runbook entry, or explicit anti-solution rather than a
  duplicate raw backlog.
- The first failure-artifact ingestion slice adds
  `POST /console/client-diagnostics/browser-preview-failure`, accepting either
  the raw `create-syncular-app` `browser-preview-failure.json` artifact or a
  wrapper with `clientId`/`actorId`/`partitionId`. The route rejects sensitive
  keys with the existing Console diagnostics policy, normalizes safe
  preview/asset metrics, deployment-preflight facts, support-bundle counts,
  lifecycle timing summaries, and timeline counters into a
  `browser.preview_failure` client diagnostic record, and deliberately drops
  the artifact's page `textExcerpt`.
- Cloudflare runtime failure artifacts now feed Console/Fleet through
  `POST /console/client-diagnostics/cloudflare-runtime-failure`, accepting the
  raw `framework-import-smokes` `cloudflare-runtime-failure.json` artifact or
  an identity wrapper. The route rejects sensitive keys, preserves route,
  sync/blob/WebSocket bases, exit status, bounded output excerpt, and safe R2
  timing/byte metrics, and normalizes them into a
  `cloudflare.runtime_failure` client diagnostic record.
- The first browser deployment preflight slice adds
  `getSyncularBrowserDeploymentPreflight(...)` to `@syncular/client`, checking
  Worker/WebAssembly support, secure-context/cross-origin-isolation flags,
  OPFS/IndexedDB durable storage availability, persistent-storage status,
  quota budgets, available free-space budgets, storage usage ratio, quota
  pressure, service-worker availability/control, controller state, redacted
  controller script path, and served WASM runtime asset status/content types
  before a database is opened.
- Browser deployment preflight now carries an explicit support decision:
  `persistent-offline`, `ephemeral-development`, `unsupported`, or `unknown`,
  plus persistence mode, production-readiness, issue codes, and recommended
  actions. This keeps app health UI and release smokes from inferring
  production browser support from scattered capability booleans.
- Browser support policy is now public through
  `getSyncularBrowserSupportMatrix(...)` and
  `getSyncularBrowserSupportPolicy(...)`, naming Chrome/Chromium secure pages
  as supported only after preflight evidence, Firefox/Safari/WebView/PWA as
  preflight-gated `unknown` contexts, private/incognito as development/test
  only, and SSR/build as unsupported for database open.
- Browser support policy can now be evaluated against observed deployment
  preflight evidence with `evaluateSyncularBrowserSupportPolicy(...)`. The
  starter records that expected-vs-observed policy result in its hidden smoke
  marker and `browser-preview-failure.json`, and Console/Fleet preserves the
  redacted policy status when ingesting starter browser artifacts.
- Browser support policy context selection now has a public helper:
  `getSyncularBrowserSupportPolicyContextHint(...)`. Explicit app context wins;
  otherwise the helper only uses hard preflight facts, mapping
  service-worker-controlled pages to `pwa`, ephemeral/development storage to
  `private-browsing`, unsupported storage to the default context with low
  confidence, and ordinary pages to the maintained Chrome/Chromium context
  without Safari/Firefox user-agent guessing. The starter uses the hint before
  evaluating policy so PWA/cache-skew and ephemeral-storage artifacts carry the
  right policy context.
- Browser support policy evaluations now include stable
  `browser_support.*` reason codes. The starter records those codes in its
  hidden smoke marker and `browser-preview-failure.json`, so app diagnostics
  and hosted artifacts can distinguish missing preflight evidence,
  target-host evidence gaps, persistence mismatches, production-readiness gaps,
  development-only contexts, unsupported contexts, and a fully met policy
  without parsing prose.
- Browser support policy evaluations now also carry the selected context's
  required evidence, known risks, and next steps. The starter browser marker,
  failure artifact, smoke self-check, and Console/Fleet ingestion preserve
  that guidance so unsupported or target-host-gated browser failures can tell
  users what evidence to collect without a docs lookup.
- The starter now calls browser deployment preflight before opening
  `createSyncularAppDatabase(...)`, using the generated required runtime
  feature list and its configured IndexedDB storage expectation. The scaffold
  smoke checks Vite can transform the starter preflight client module.
- A first adapter-boundary slice added `bun run imports:check`, a static root
  import graph smoke that proves `@syncular/client` and `@syncular/server`
  roots do not reach optional subpath files or optional peer packages.
- `bun run imports:check` now also dynamically imports the root client/server
  source entrypoints and checks known exports, catching top-level browser,
  native-driver, or optional-peer side effects that static graph walking could
  miss.
- Framework import smokes now build a minimal Next 16 SSR app through webpack,
  a minimal Vite 8 browser app, and a minimal Cloudflare Worker through
  Wrangler dry-run. The Next path imports `@syncular/client` and
  `@syncular/server` roots, aliases workspace package roots to source so stale
  ignored `dist` leftovers cannot affect the result, and verifies those root
  imports stay warning-clean after WASM glue dynamic imports gained webpack
  ignore metadata. The Vite path imports the client root through
  browser-conditioned package exports and verifies the production bundle
  contains the expected Syncular marker, then serves the built preview and can
  execute it in Chrome/CDP to observe the browser root import marker. The
  Cloudflare path imports `@syncular/server/cloudflare`,
  `@syncular/server/d1`, `@syncular/server/sqlite`,
  `@syncular/server/hono`, and the R2 adapter, declares `SYNC_DO`, D1, and R2
  bindings, aliases Syncular subpaths to workspace source so stale ignored
  `dist` output cannot hide local route behavior, verifies Wrangler can bundle
  the Worker without deploy credentials, and proves a local request reaches
  the DO route with those bindings available. The route runs
  `ensureSyncSchema(...)` on D1, verifies the `sync_commits` table exists,
  performs app-table insert/select/delete through Kysely over D1, pushes
  through the Syncular HTTP route, pulls the row back through a binary
  sync-pack plus decoded snapshot chunk, rejects unauthenticated sync and a
  forbidden-scope write with stable envelopes, rejects a wrong-scope snapshot
  chunk download, opens real Syncular realtime reader/writer WebSockets over
  the same `SyncDurableObject` upgrade bridge, pushes a D1 row through the
  writer socket, decodes the reader's binary sync-pack delta for that row,
  drives an R2-backed Syncular blob route upload/complete/download flow,
  rejects a forbidden blob download URL with stable access details, and uses a
  DO-backed WebSocket route to echo a client message through the same upgrade
  bridge as a lower-level transport proof. The local Cloudflare failure
  artifact self-check now also includes a safe `blobMetrics` object for the R2
  route, covering upload initiation, byte upload, upload completion, scoped
  reference push, download URL creation, byte download, partitioned download,
  byte counts, and total route duration without recording hashes, signed URLs,
  direct-transfer tokens, or payload text.
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
- The local recovery plan now has an explicit opt-in sign-out cleanup action.
  `localRecoveryPlan({ includeSignOutAction: true })` offers confirmed
  `prepare-sign-out` cleanup only when the local outbox is empty; it resets
  subscription/bootstrap state, clears synced app rows, and clears cached blob
  bytes. If unsynced work remains, the plan offers sync recovery first instead
  of a destructive wipe.
- Revoked subscription scopes now produce a specific local recovery action
  instead of only a generic lifecycle retry. The plan collects affected
  subscription IDs from diagnostic subscriptions, bootstrap status, and
  `sync.scope_revoked` diagnostic details, then offers a confirmed
  `force-rebootstrap` action after app permissions are checked or refreshed.
- Unrecoverable bootstrap/resource failures now use the same recovery action
  model: `sync.not_found` and `sync.integrity_rejected` on snapshots with
  errored subscriptions produce a targeted, confirmed `force-rebootstrap`
  action for those subscription IDs.
- Destructive local recovery actions can now be blocked by browser deployment
  preflight evidence. Apps can pass `preflight.lifecycle.multiTabMode` and set
  `requireMultiTabCoordinationForDestructiveActions: true`; when the browser
  cannot coordinate tabs or the mode was not passed, destructive actions carry
  a `browser.multi_tab_coordination_required` blocker instead of running.
- `runSyncularLocalRecoveryAction(...)` now accepts optional Web Locks
  coordination, so browser apps can serialize destructive recovery execution
  across tabs after preflight proves coordination. Results include lock name,
  required flag, and lock state; required locks reject with
  `SyncularLocalRecoveryActionLockError` before the client action runs.
  `lock.timeoutMs` now bounds that wait and rejects with
  `SyncularLocalRecoveryActionLockTimeoutError` so recovery UI can report lock
  contention instead of spinning indefinitely behind another tab.
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
- The first runtime timeline slice adds `getSyncularRuntimeTimeline(...)` and
  `SyncularDatabase.runtimeTimeline(...)`, projecting diagnostic snapshots and
  managed lifecycle status into ordered, redacted phase events for runtime,
  lifecycle, bootstrap, sync, auth, realtime, storage, local-apply, outbox,
  conflict, and blob support/test reports.
- The first composed support-bundle slice adds
  `getSyncularSupportBundle(...)` and
  `SyncularDatabase.exportSupportBundle(...)`, combining browser health,
  runtime timeline, schema readiness, optional deployment preflight, section
  failures, local support data, package/runtime versions, sync/trace ids,
  subscription cursors, and diagnostic redaction decisions into one redacted
  incident artifact.
- The first mutation-status slice adds `getSyncularMutationStatus(...)` and
  `SyncularDatabase.mutationStatus(...)`, giving apps one stable projection of
  outbox queued/sending/failed/acked counts, unresolved/resolved conflicts,
  conflict detail rows, last mutation-related error, and recommended actions
  for pending UI, sync retry, auth refresh, diagnostics, or conflict
  resolution.
- The tracked mutation-status slice extends redacted Rust local support
  bundles with outbox commit summaries (`clientCommitId`, status, schema
  version, and `ackedCommitSeq` for acked commits) and lets apps pass generated
  mutation receipts to
  `mutationStatus({ trackCommits: [...] })`. The public result now classifies
  each tracked receipt as queued, syncing, failed, acked, conflicted,
  resolved-conflict, or unknown using local outbox and conflict evidence
  without exposing operations JSON, row payloads, auth lease tokens, or signed
  URLs.
- The first command-timeline slice adds `getSyncularCommandTimeline(...)` and
  `SyncularDatabase.commandTimeline(...)`, composing tracked receipt state,
  redacted runtime timeline events, and optional local-visibility evidence into
  a deterministic support/test artifact. It deliberately reports missing
  evidence for outbox sequence, sync attempt, realtime cursor, pull reason,
  local apply, or local visibility instead of pretending those links exist when
  current diagnostics cannot prove them. Acked redacted outbox summaries now
  satisfy the server commit sequence link through `ackedCommitSeq`; any tracked
  redacted outbox summary also adds synthetic local-apply evidence because it
  proves the command was durably accepted locally.
- The command-timeline evidence slice adds `summary.evidence` beside
  `summary.proof`, so command artifacts expose concrete joined subscription
  ids, request/sync/trace/span ids, server commit sequence, realtime cursor,
  pull reason, local-apply outbox id/commit sequence, and local visibility
  state/source. The starter browser-preview marker, smoke artifact, testkit
  validation, and Console/Fleet ingestion now preserve those fields instead of
  reducing the proof chain to booleans only.
- `waitForSyncularLocalVisibility(...)` now emits redacted terminal evidence
  through `onEvidence`, including visible, timed-out, failed, trigger, table,
  changed-table, source, and local-query error context. Apps can pass the
  latest evidence value directly to `commandTimeline({ localVisibility })` so
  command artifacts record the concrete local read-model visibility point
  instead of a hand-written placeholder.
- Sync attempts now carry a client-generated request id through
  `x-request-id`, diagnostics, runtime timelines, command timelines, and
  support bundles. Hono request-event storage uses the same id when the header
  is present, so command and support artifacts can link browser-side sync
  evidence to server request rows without relying only on trace ids.
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
- `syncular ops check` now gives deploy pipelines a narrow machine-readable
  production-ops gate over the manual runbook evidence: schema readiness,
  latest restore drill, external blob consistency policy/status, credential
  rotation ownership/cadence, and rate-limit review status. `syncular doctor`
  now composes schema readiness and optional/required ops readiness without
  absorbing release-rehearsal-only browser/framework/package gates.
- Console Ops now accepts that deploy evidence through
  `POST /console/ops/readiness`, stores a redacted `ops_readiness` operation
  audit event, exposes the latest report through `GET /console/ops/readiness`,
  and renders a production-readiness panel with per-check status and actionable
  issue codes. The server omits CLI local paths and rejects secret-shaped keys
  before recording the report. Console gateway mode aggregates readiness reads
  across selected instances while deploy writes remain explicitly
  single-instance, and the Ops panel lists per-instance issue drilldown,
  retained readiness trend buckets from `GET /console/ops/readiness/trends`,
  issue-code grouping, and redacted readiness audit history alongside the
  latest report.
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
- 2026-07-01: Added testkit response assertion helpers for stable
  negative-path protocol outcomes:
  `findPushCommit(...)`, `requirePushCommit(...)`,
  `findPushOperationResult(...)`, `requirePushOperationResult(...)`,
  `requirePushErrorCode(...)`, `findPullSubscription(...)`,
  `requirePullSubscription(...)`, and `requireRevokedSubscription(...)`.
  The project-scoped actor fixture test now asserts denied project writes and
  revoked foreign subscriptions through those helpers instead of digging into
  nested arrays or matching server prose.
- 2026-07-01: Added testkit command-proof assertion helpers for command
  timeline `summary.proof` objects:
  `missingCommandProofEvidence(...)`, `hasCommandProofEvidence(...)`,
  `requireCommandProofEvidence(...)`, `requireCompleteCommandProof(...)`, and
  `SYNCULAR_COMMAND_PROOF_EVIDENCE_KEYS`. These helpers let app/E2E tests
  assert complete or partial outbox/request/sync-attempt/server-commit/
  realtime-cursor/pull-reason/local-apply/local-visibility proof chains
  without hand-rolling boolean checks.
- 2026-07-01: Added testkit failure-artifact assertion helpers for the two
  current redacted smoke artifact families:
  `requireBrowserPreviewFailureArtifact(...)`,
  `requireCloudflareRuntimeFailureArtifact(...)`,
  `assertFailureArtifactRedacted(...)`,
  `findFailureArtifactSensitiveField(...)`, and
  `SYNCULAR_FAILURE_ARTIFACT_SENSITIVE_KEYS`. These helpers let app/release
  tests assert bounded browser-preview and Cloudflare runtime failure JSON,
  support-policy count consistency, support-bundle redaction,
  lifecycle-resume/pause evidence, safe blob timing metrics, and rejected
  sensitive keys or known raw secret values before Console/Fleet ingestion.
- 2026-07-01: Added structured Hono rate-limit details for sync route
  diagnostics. The generic limiter now exposes stable count/window/retry
  fields in `sync.rate_limited` responses and log events, while combined sync
  routes add safe `actorId` plus `operationType` details so pull and push
  throttling can be distinguished in tests, logs, and support reports without
  matching prose.
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
- 2026-07-01: Browser health now also exposes lifecycle operation availability
  as part of the same UI-facing truth surface: lifecycle stage, recovery owner,
  blocked-operation count, and fixed operation states for local reads,
  generated mutations, local-visibility waits, explicit sync, auth replacement,
  resume, support-bundle export, and destructive local recovery. The starter
  health line records those fields as hidden marker attributes, public
  error-handling and observability docs route app chrome through the new
  projection, and focused browser-health tests prove happy-path, auth-required,
  revoked-scope, and offline queueing semantics.
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
- 2026-07-01: Added `@syncular/testkit` response assertion helpers for
  stable push-operation and pull-subscription outcomes, including
  `requirePushErrorCode(...)` for denied writes and
  `requireRevokedSubscription(...)` for revoked subscriptions.
- 2026-07-01: Added `@syncular/testkit` command proof assertion helpers for
  `database.commandTimeline(...).summary.proof`, including complete-chain and
  subset assertions with missing evidence key names.
- 2026-07-01: Added `@syncular/testkit` failure artifact assertion helpers
  for `browser-preview-failure.json` and `cloudflare-runtime-failure.json`,
  including redaction/sensitive-key scans and optional forbidden-substring
  checks for app-specific secrets.
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
- 2026-07-01: Extended `getSyncularBrowserHealth(...)` with
  `lifecycle.stage`, `lifecycle.recoveryOwner`, and fixed lifecycle operation
  availability entries. Focused tests cover durable happy path,
  auth-required recovery, revoked-scope blockers, and offline queued mutation
  semantics; the starter health line now exposes the operation projection as
  smoke-readable data attributes.
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
- 2026-07-01: Added an opt-in native sqlite driver matrix to
  `scripts/post-publish-install-smokes.ts` controlled by
  `SYNCULAR_POST_PUBLISH_NATIVE_SQLITE_MATRIX`. It creates a fresh Node
  project, installs the published `@syncular/server` plus `better-sqlite3` and
  `sqlite3`, imports `@syncular/server/better-sqlite3` and
  `@syncular/server/sqlite3`, and runs a tiny in-memory Kysely query through
  both drivers. The default remains off because native module installs are
  platform-sensitive and should be enabled deliberately by release policy.
- 2026-07-01: Resolved that release policy: keep the native sqlite matrix
  opt-in rather than default release-blocking, but require it on a
  native-capable Node runner before stable releases and whenever
  `@syncular/server/better-sqlite3` or `@syncular/server/sqlite3` changes.
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
- 2026-07-01: Added the opt-in `prepare-sign-out` local recovery action,
  blocking sign-out cleanup while unresolved outbox work exists and documenting
  the confirmed flow in package/public observability docs.
- 2026-07-01: Added a revoked-scope local recovery action that turns
  `sync.scope_revoked` subscription evidence into a confirmed
  `force-rebootstrap` action for the affected subscription IDs.
- 2026-07-01: Added an unrecoverable-bootstrap local recovery action that turns
  `sync.not_found` / `sync.integrity_rejected` plus errored subscription
  evidence into a targeted, confirmed `force-rebootstrap` action.
- 2026-07-01: Added opt-in browser multi-tab blockers for destructive local
  recovery actions so apps can require coordinated tabs before sync-state
  reset, sign-out cleanup, cache clear, or forced rebootstrap operations run.
- 2026-07-01: Added optional Web Locks coordination to
  `runSyncularLocalRecoveryAction(...)`. Recovery actions can now serialize
  through an app-specific browser lock, fall back when optional locks are
  unavailable, or fail closed with `SyncularLocalRecoveryActionLockError` when
  the lock is required; action results report the observed coordination state.
- 2026-07-01: Added bounded local recovery Web Lock contention handling.
  Recovery actions can pass `lock.timeoutMs`; if another tab keeps the local
  recovery lock too long, the queued action rejects with
  `SyncularLocalRecoveryActionLockTimeoutError` and the action does not run
  later after the held lock releases. Package README, browser docs, and public
  error-handling docs now show the timeout option.
- 2026-07-01: Added a starter/browser-observable local recovery lock
  contention proof. The generated starter now exposes a hidden local-recovery
  proof marker for the support-bundle recovery action, and the Chrome/CDP
  built-preview smoke can hold the real browser `local-recovery` Web Lock,
  verify the action fails with
  `syncular.local_recovery_web_locks_timeout`, release the lock, rerun the
  same non-destructive action, and require an acquired/completed coordination
  marker. Browser failure artifacts now include that marker so a stuck
  recovery button points at lock contention instead of a generic timeout.
- 2026-06-30: Extended the Hono-backed browser/WASM local-health test so it
  repairs corrupted subscription state and orphaned verified roots through the
  new local recovery plan/action API instead of direct low-level repair calls.
- 2026-06-30: Expanded the public upgrade guide with operator upgrade and
  rollback runbooks, and linked the deployment checklist to that upgrade order.
- 2026-07-01: Extended the `create-syncular-app` scaffold smoke so it builds
  the generated app, serves Vite preview on the allocated port, verifies built
  assets, and optionally runs a Chrome/Chromium CDP browser check against the
  built page.
- 2026-07-01: Added a `starter-browser-preview` Checks workflow job that sets
  up Chrome, exports `CHROME_BIN`, and runs
  `bun --cwd packages/create-syncular-app smoke --require-browser-preview` so
  the built-preview browser smoke is enforced on starter-relevant PRs and all
  pushes.
- 2026-07-01: Added a second-pass feedback addendum that keeps the worthy
  Skaldsong DX points as product requirements while explicitly rejecting
  tempting shortcuts such as manual-sync freshness fixes, lite database
  variants, package splits for dependency optics, implicit global blob access,
  request-startup migrations, raw synced SQL writes, old client compatibility,
  and console-only debugging.
- 2026-07-01: Added a source-feedback retention checklist that keeps every
  pasted Skaldsong feedback theme in WP-50 as either a public contract, proof
  artifact, docs/runbook obligation, or explicit anti-solution, with a
  completion bar for APIs/CLI JSON, tests/smokes/artifacts, golden-path docs,
  and shortcut avoidance.
- 2026-07-01: Added a feedback-driven acceptance matrix for future WP-50
  slices, making the pasted feedback actionable by audience and completion
  standard instead of leaving it as broad DX sentiment.
- 2026-07-01: Added a final feedback guardrail pass for explicit browser
  support tiers, first-run asset/version compatibility, recovery ownership,
  support-bundle provenance, browser reopen/restart persistence evidence,
  version-skew policy, and latency/durability evidence budgets.
- 2026-07-01: Added a final retained-rough-edge pass for public code/helper
  stability policy, generated-client ownership boundaries, failure-driven docs
  examples, reproducible test fixture topology, and first-run docs that keep
  users on the golden scaffold/generate/run/mutate/recover/deploy loop before
  sending them into reference material.
- 2026-07-01: Added DX completion smell tests so future slices have a compact
  final filter for first-run clarity, runtime truth, typed failures, recovery
  ownership, freshness discipline, authority boundaries, deploy/browser
  confidence, optional dependency isolation, redacted artifacts, audience
  hygiene, and public contract stability.
- 2026-07-01: Added `preflight.support` to
  `getSyncularBrowserDeploymentPreflight(...)`, classifying browser/deployment
  support as `persistent-offline`, `ephemeral-development`, `unsupported`, or
  `unknown` with persistence mode, production readiness, issue codes, and
  recommended actions. The starter error, package README, public browser docs,
  and support-bundle tests now use the same support-tier vocabulary.
- 2026-07-01: Extended browser deployment preflight storage diagnostics with
  available bytes, minimum available budget, usage ratio, and
  `quotaPressure`, plus the `browser.storage_pressure_high` warning code. The
  starter hidden preflight marker and `browser-preview-failure.json` self-check
  now preserve those fields so browser artifacts can distinguish low total
  quota, low free space, high usage pressure, and persistence-grant gaps.
- 2026-07-01: Wired browser deployment preflight storage warnings into local
  recovery planning. Persistent-storage grant gaps now record whether
  `navigator.storage.persist()` is requestable, the recovery plan can offer a
  non-destructive persistent-storage request, and quota/pressure warnings map
  to compaction plus confirmed blob-cache clearing actions with the originating
  storage issue codes when the active Rust runtime reports `blobs` support.
- 2026-07-01: Added a generated-app storage recovery proof to the
  `create-syncular-app` browser-preview smoke. The starter builds a synthetic
  storage-warning deployment preflight from the live browser facts, runs it
  through `client.localRecoveryPlan(...)`, then executes request-persistent
  storage with a safe stub navigator, compaction, and, only when offered by a
  blob-capable runtime, confirmed blob-cache clearing through public recovery
  APIs. The hidden marker, built-asset check, Chrome/CDP wait, and failure
  artifact self-check now preserve the offered actions and completion state.
- 2026-07-01: Added service-worker availability/control to browser deployment
  preflight and the starter hidden marker/failure artifact. PWA/service-worker
  pages are still preflight-gated, but cache-skew investigations now retain
  whether the observed page was service-worker controlled.
- 2026-07-01: Extended that PWA/cache-skew context with service-worker
  controller state and a query/hash-redacted controller script path. Starter
  artifacts can now tell whether a failure came from a controlled PWA page and
  which worker script path controlled it without storing the full script URL.
- 2026-07-01: Added policy-level `browser_support.*` reason codes to
  `evaluateSyncularBrowserSupportPolicy(...)` and threaded them into the
  `create-syncular-app` hidden support-policy marker and
  `browser-preview-failure.json` self-check. This separates deployment
  capability issue codes from product-policy verdict reasons in browser
  artifacts.
- 2026-07-01: Threaded browser support-policy guidance through
  `evaluateSyncularBrowserSupportPolicy(...)`, the generated app hidden
  marker, `browser-preview-failure.json`, and Console/Fleet ingestion so
  required evidence, known risks, and next steps survive artifact collection.
- 2026-07-01: Added
  `getSyncularBrowserSupportPolicyContextHint(...)` and switched the starter
  to use it before policy evaluation. This keeps explicit product context
  authoritative, but lets preflight facts select `pwa` for service-worker
  controlled pages and `private-browsing` for ephemeral/development storage,
  while avoiding user-agent based Safari/Firefox guesses.
- 2026-07-01: Added `packages/client/src/runtime-timeline.ts`, exported
  `getSyncularRuntimeTimeline(...)` from `@syncular/client`, and added
  `SyncularDatabase.runtimeTimeline(...)` as a managed database method. The
  helper builds ordered events from diagnostic snapshots and lifecycle status,
  classifies phases, summarizes state events, redacts or omits diagnostic
  details with the public Console detail policy, and reports stable summary
  fields for sync attempts, affected tables, subscriptions, last error, and
  action-required state.
- 2026-07-01: Updated public observability docs so E2E/support workflows use
  `runtimeTimeline()` before falling back to raw `diagnosticSnapshot()` dumps.
- 2026-07-01: Added `packages/client/src/support-bundle.ts`, exported
  `getSyncularSupportBundle(...)` from `@syncular/client`, and added
  `SyncularDatabase.exportSupportBundle(...)` as the composed incident bundle
  surface over browser health, runtime timeline, schema readiness, optional
  deployment preflight, local support bundle, section errors, runtime/package
  versions, sync/trace ids, subscription cursors, and diagnostic redaction
  decisions.
- 2026-07-01: Updated package README and public observability docs to
  distinguish `exportSupportBundle()` from low-level
  `exportLocalSupportBundle()` and to call out runtime asset URL redaction.
- 2026-07-01: Added `packages/client/src/mutation-status.ts`, exported
  `getSyncularMutationStatus(...)` from `@syncular/client`, and added
  `SyncularDatabase.mutationStatus(...)` as an app-facing status surface over
  outbox queued/sending/failed/acked counts, conflict stats and conflict
  records, mutation-related diagnostics, and UI-safe recommended actions.
- 2026-07-01: Updated package README, JavaScript mutation docs, and
  error-handling docs so app chrome and tests use `mutationStatus()` before
  manually stitching together outbox stats, conflict stats, and diagnostic
  events.
- 2026-07-01: Added redacted local support bundle outbox commit summaries and
  receipt tracking to `mutationStatus({ trackCommits })`, so generated
  mutation receipts can be correlated with queued/sending/failed/acked outbox
  state and conflict records without exposing internal operations payloads.
- 2026-07-01: Added `packages/client/src/command-timeline.ts`, exported
  `getSyncularCommandTimeline(...)` from `@syncular/client`, and added
  `SyncularDatabase.commandTimeline(...)` as a deterministic receipt/command
  artifact over mutation status, runtime timeline events, optional
  local-visibility evidence, and explicit missing-evidence markers.
- 2026-07-01: Extended command timelines with
  `summary.proof`, a stable app/test/support summary over the command evidence
  chain: local outbox persisted, request correlated, sync attempt observed,
  server commit observed, realtime cursor observed, pull reason observed,
  local apply observed, local visibility observed, and whether the proof chain
  is complete. This lets E2E and support tooling assert the core realtime and
  freshness story without reinterpreting event arrays.
- 2026-07-01: Extended redacted local support bundle outbox commit summaries
  with `ackedCommitSeq` for acked commits, and threaded that through mutation
  status plus command timeline receipt events so command artifacts can prove
  server commit sequence without operation payloads or auth material.
- 2026-07-01: Added synthetic command-timeline local-apply evidence whenever a
  tracked command has redacted local outbox evidence, avoiding a misleading
  missing local-apply marker for durable local writes.
- 2026-07-01: Extended redacted local support bundle outbox commit summaries
  with `outboxId`, and threaded that through mutation status plus command
  timeline receipt/local-apply events so command artifacts can prove the local
  durable outbox row link without exposing operations JSON or row payloads.
  The client diagnostic detail policy now treats `outboxId` as a safe support
  identifier alongside `clientCommitId`.
- 2026-07-01: Taught command timelines to treat real `syncPull`/`syncOnce`
  diagnostic `requestType` fields as pull/sync reason evidence, and added the
  same request type to direct Rust-client sync completion/failure diagnostics.
  This removes another misleading missing-evidence marker without inventing a
  cause the runtime did not report.
- 2026-07-01: Promoted realtime event cursors into runtime/command timeline
  evidence. New realtime diagnostics now put `cursor` on the event, and the
  runtime timeline also recovers legacy/detail-only cursor values from safe
  diagnostic details.
- 2026-07-01: Added local visibility terminal evidence through
  `waitForSyncularLocalVisibility(..., { onEvidence })` and documented passing
  that evidence into `commandTimeline({ localVisibility })`, so command
  timelines can include the observed local read-model visibility point with
  trigger/table/source context.
- 2026-07-01: Added client-generated sync request ids to
  `SyncularSyncAttempt`, sent them as `x-request-id`, allowed the header in
  default Hono CORS, and projected request ids into diagnostics, runtime
  timelines, command timelines, and support bundles so browser artifacts match
  server `sync_request_events.request_id`.
- 2026-07-01: Added concrete command-timeline `summary.evidence` values for
  scope join, subscription ids, request/sync/trace/span ids, server commit
  sequence, realtime cursor, pull reason, local apply, and local visibility.
  The generated starter marker and browser-preview smoke artifact now carry
  those fields, `@syncular/testkit` validates them, and Console/Fleet ingests
  them into diagnostic details plus compact transport stats.
- 2026-07-01: Extended browser deployment preflight with lifecycle and
  multi-tab capability checks. The result now reports BroadcastChannel, Web
  Locks, page visibility, `pagehide`, `beforeunload`, resume/shutdown signal
  availability, and a multi-tab mode; apps can opt into failing the preflight
  when multi-tab coordination or page lifecycle resume signals are required.
- 2026-07-01: Added
  `installSyncularBrowserLifecycleResume(...)` to the root client package. The
  helper installs browser-page lifecycle listeners, coalesces
  `visibilitychange`, `pageshow`, and `online` signals, calls the managed
  `resumeFromBackground()` catch-up path, surfaces resume errors to a caller
  hook, and tears listeners down explicitly. The starter now installs it after
  opening the generated database so foreground recovery does not depend on app
  code calling `sync()` manually.
- 2026-07-01: Extended `installSyncularBrowserLifecycleResume(...)` with
  optional Web Locks coordination. Apps can pass `lock` to serialize
  foreground catch-up across tabs; optional locks fall back to uncoordinated
  resume when Web Locks are unavailable, while `lock.required` fails with a
  typed `SyncularBrowserLifecycleResumeLockError`. Resume callbacks now expose
  lock name, required flag, and lock state, and the starter records those
  fields in the hidden lifecycle marker and browser failure artifact.
- 2026-07-01: Added bounded lifecycle Web Lock contention handling. Apps can
  pass `lock.timeoutMs`; if another tab holds the lifecycle resume lock too
  long, the helper aborts the queued lock request, rejects with
  `SyncularBrowserLifecycleResumeLockTimeoutError`, reports
  `lockState: "timed-out"`, and records the configured timeout in the starter
  lifecycle marker and browser failure artifact.
- 2026-07-01: Extended the starter lifecycle helper proof with completion
  callbacks and hidden DOM markers for resume status/count/reason/error. The
  scaffold smoke now proves the production bundle contains the lifecycle
  marker, and the Chrome/CDP browser path dispatches an `online` event and
  waits for the marker to report a completed `resumeFromBackground()` catch-up.
- 2026-07-01: Extended the starter lifecycle proof from online-only to
  restored-page plus online. Focused client tests now assert the `pageshow`
  reason contract, and the Chrome/CDP browser path dispatches a persisted
  `pageshow` event, waits for the lifecycle marker to report a completed
  `pageshow` catch-up, then dispatches `online` and waits for a second
  completed catch-up.
- 2026-07-01: Extended the browser lifecycle helper with an app-facing pause
  callback for hidden-tab `visibilitychange`, `pagehide`, `freeze`, and
  `beforeunload` signals. The starter now records pause count, last pause reason,
  `pagehide.persisted`, shutdown-signal count, and visibility state in its
  hidden lifecycle marker; browser-preview failure artifacts and Console/Fleet
  ingestion preserve the same `lifecyclePause` object. The CDP path now
  dispatches hidden and visible `visibilitychange` events, verifies hidden
  pause evidence, waits for a completed visible-tab catch-up, dispatches a
  persisted `pagehide` before the restored-page `pageshow` proof, and
  dispatches `beforeunload` after the online catch-up proof.
- 2026-07-01: Extended the starter Chrome/CDP lifecycle proof with a concrete
  hidden-tab pause and visible-tab resume cycle. The smoke overrides
  `document.visibilityState` inside the test page, dispatches
  `visibilitychange`, waits for `lifecyclePause.reason` of
  `visibilitychange` with `visibilityState` of `hidden`, restores visible
  state, and waits for `lifecycleResume.reason` of `visibilitychange` before
  continuing through pagehide/pageshow/online/beforeunload.
- 2026-07-01: Extended browser lifecycle coverage with Chrome Page Lifecycle
  `freeze` and browser `resume` events. The root helper now reports `freeze`
  through `onPause(...)`, treats browser `resume` as a foreground catch-up
  reason, and focused client tests cover both event contracts and teardown.
  The starter Chrome/CDP path dispatches `freeze`, verifies pause marker
  evidence, dispatches `resume`, and waits for a completed
  `resumeFromBackground()` marker before the existing `beforeunload` shutdown
  proof.
- 2026-07-01: Extended the starter Chrome/CDP lifecycle proof beyond
  DOM-dispatched page lifecycle events by forcing Chrome's page lifecycle state
  through `Page.setWebLifecycleState` with `frozen` and then `active`. The
  hosted proof showed Chrome surfaces that transition as a BFCache lifecycle
  suspension diagnostic rather than the same app-facing `freeze` event marker,
  so the smoke now counts the Chrome diagnostic and then requires the app's
  `visibilitychange` recovery marker after Chrome reactivates the page. This
  narrows the browser-automation gap while leaving true target-browser
  backgrounding/discard, storage shutdown, and quota/eviction work open.
- 2026-07-01: Added the first starter two-tab runtime proof for Chrome-capable
  runners. The starter can derive a per-tab client id/database file from
  `?syncularClientId=...`; the CDP smoke opens a second tab with a distinct
  client id, creates a task in the first tab, and waits for the second tab to
  observe the task through the normal sync/realtime path.
- 2026-07-01: Extended the starter Chrome/CDP two-tab proof with
  lock-coordinated lifecycle resume evidence. After both generated-app tabs
  are ready, the smoke dispatches `online` in both tabs, waits for each tab's
  lifecycle marker to advance, and asserts that both markers report the
  starter lifecycle Web Lock name with `lockState: "acquired"`. This proves
  the hosted browser path is exercising the same app-facing lock-backed
  foreground resume contract, while leaving true suspension/shutdown and
  database/recovery lock contention for deeper browser matrix work.
- 2026-07-01: Extended the starter Chrome/CDP lifecycle path with
  browser-observed Web Lock contention. The smoke now holds the same starter
  lifecycle Web Lock through `navigator.locks.request(...)`, dispatches
  `online`, waits for the starter marker to report `status: "failed"`,
  `lockState: "timed-out"`, and the configured `10000ms` timeout error, then
  releases the held lock and verifies a follow-up `online` resume completes.
  This moves lifecycle lock contention from helper-only coverage into the
  real-browser path; local execution still awaits a Chrome-capable runner
  because this machine has no Chrome/Chromium binary.
- 2026-07-01: Extended the starter Chrome/CDP path with a same-client
  reload/reopen proof. After two-tab propagation, the smoke navigates the
  second tab back through app startup with the same `syncularClientId` and
  waits for the propagated task to reappear, giving the browser path its first
  generated-app restart-style persistence boundary.
- 2026-07-01: Extended the starter Chrome/CDP path with a same-client
  duplicate-tab open contention proof. With the second tab still active on a
  client/database, the smoke opens a duplicate tab using the same
  `syncularClientId`. The duplicate must either reach ready state and show the
  existing task or settle into an explicit starter-open error instead of
  hanging, and the original tab must remain writable by accepting a fresh task
  after the duplicate attempt.
- 2026-07-01: Added a generated write-pressure proof to the starter
  Chrome/CDP path. The starter exposes a hidden marker that fires four
  generated task mutations concurrently, waits for each row through
  `awaitTaskVisibility(...)`, records requested/visible counts plus duration or
  typed error code, and the browser smoke requires the active tab to render
  every row and the observer tab to receive them through the normal
  sync/realtime path. This narrows the write-contention risk to heavier
  same-database multi-tab write storms and lower-level storage shutdown cases.
- 2026-07-01: Extended the starter Chrome/CDP path with a same-profile
  browser-process restart proof. After the two-tab and reload/reopen checks,
  the smoke stops Chrome, starts a fresh Chrome process with the same profile
  directory and `syncularClientId`, and waits for the propagated task to
  reappear from the browser database after app startup.
- 2026-07-01: Wired `bun run release:rehearsal` to run the
  `create-syncular-app` built-preview smoke by default after fresh-app smokes
  and before framework import smokes. Local rehearsal can skip it with
  `--skip-starter-smoke`; Chrome-capable release runners can add
  `--require-starter-browser-preview` to make the real-browser CDP path
  mandatory.
- 2026-07-01: Hardened the `create-syncular-app` smoke readiness polling with
  a per-attempt fetch abort. A rehearsal-spawned starter run briefly exposed
  that a single hanging fetch could bypass the outer readiness deadline; the
  smoke now bounds each health/page/asset fetch attempt before retrying.
- 2026-07-01: Added `scripts/framework-import-smokes.ts` plus the root
  `framework-import-smokes` script. The smoke builds a minimal Next 16 app
  with webpack, imports `@syncular/client` and `@syncular/server` roots from a
  server-rendered page, aliases workspace package roots to source so ignored
  stale `dist` folders cannot hide source-root SSR problems, and proves the
  build succeeds.
- 2026-07-01: Added webpack ignore metadata to the client WASM glue dynamic
  imports alongside the existing Vite ignore metadata, keeping runtime WASM
  asset loading external and removing the Next production-build warning for
  expression-based dynamic imports.
- 2026-07-01: Extended `framework-import-smokes` with a minimal Vite 8 browser
  production build that imports `@syncular/client` from a TypeScript browser
  entrypoint, follows the package browser condition instead of source aliases,
  and asserts the built JavaScript bundle contains the expected Syncular root
  import marker. The smoke resolver now also understands Bun's
  `node_modules/.bun/<package>@.../node_modules/<package>` dependency layout so
  it can reuse workspace-installed Vite without a network install.
- 2026-07-01: Extended the Vite framework smoke with an optional Chrome/CDP
  browser runtime proof. When Chrome is available, the smoke opens the served
  Vite preview and waits for the browser-executed
  `data-syncular-vite-root-import="ready"` marker; release rehearsal can make
  that path mandatory with `--require-framework-vite-browser-runtime`.
- 2026-07-01: Added a deterministic Vite browser-runtime failure artifact
  self-check to `framework-import-smokes`. The production-preview HTTP proof
  now writes, validates, reads, and removes a synthetic
  `vite-browser-runtime-failure.self-check.json`, while Chrome/CDP failures
  still write the real `vite-browser-runtime-failure.json` artifact.
- 2026-07-01: Extended the Vite framework smoke from bundle inspection to
  production-preview serving proof. After `vite build`, the smoke starts
  `vite preview` on a free localhost port, fetches the built HTML, verifies it
  references the expected bundle, fetches that served JavaScript asset, and
  asserts the Syncular marker is present over HTTP.
- 2026-07-01: Extended `framework-import-smokes` with a minimal Cloudflare
  Durable Object dry-run build through Wrangler. The generated Worker imports
  `@syncular/server/cloudflare`, `@syncular/server/d1`, and the R2 adapter,
  exports a `SyncDurableObject` subclass, declares `SYNC_DO`, D1, and R2
  bindings in `wrangler.jsonc`, routes through `createSyncWorkerWithDO(...)`,
  disables Wrangler telemetry for the local smoke, and asserts the bundled
  Worker contains the expected Syncular marker.
- 2026-07-01: Extended the Cloudflare framework smoke from build-only to
  runtime proof. After the Wrangler dry-run bundle/binding check, the smoke
  starts `wrangler dev --local` on a free localhost port, fetches the
  generated Durable Object route, asserts D1/R2 bindings and adapter factories
  are available, runs `SELECT 1` through D1, performs a put/head/delete cycle
  through R2, checks the expected response text, and tears down the local Worker
  process with bounded interrupt/terminate/kill cleanup so the gate cannot hang
  after a successful request.
- 2026-07-01: Extended the Cloudflare D1 runtime proof from a raw `SELECT 1`
  to Syncular schema and app-table operations. The generated Worker now creates
  a Kysely database over D1, runs `ensureSyncSchema(...)` with the SQLite
  server dialect, verifies the `sync_commits` core table can be queried, and
  creates a tiny app table before insert/select/delete. This narrows the
  remaining D1 risk to full Syncular push/pull/realtime route flows rather
  than basic schema or app-table viability.
- 2026-07-01: Extended the Cloudflare D1 proof from schema/app-table SQL to a
  real Syncular HTTP push/pull route flow. The generated Worker now mounts
  `createSyncServer(...)` with a scoped task handler over D1, the smoke pushes
  an upsert through the public combined sync route, decodes the binary
  sync-pack response, then pulls with a reader client, fetches the advertised
  snapshot chunk, gunzips/decodes the binary table payload, and verifies the
  pushed row. This narrows the remaining D1 risk to realtime-over-DO and
  broader app/negative route cases rather than basic push/pull viability.
- 2026-07-01: Extended the Cloudflare route proof with fail-closed sync and
  blob authorization cases. The generated Worker's Wrangler config now aliases
  the Syncular server/core subpaths to workspace source so stale ignored
  `dist` output cannot hide current local route behavior, the D1 sync smoke
  now asserts unauthenticated sync returns `sync.auth_required`, an
  actor-scoped write to another `user_id` returns a rejected commit with
  `sync.forbidden`, and wrong-scope snapshot chunk access returns
  `sync.forbidden`; the R2 blob smoke now asserts a forbidden actor cannot mint
  a download URL and receives `blob.forbidden` with stable access details.
- 2026-07-01: Extended the Cloudflare WebSocket proof from a low-level Durable
  Object echo to the real Syncular realtime route. After the D1 pull records a
  reader subscription, the smoke opens reader and writer realtime WebSockets
  through local `wrangler dev`, negotiates `binary-sync-pack-v1`, sends a
  WebSocket push through the writer connection, asserts the writer
  `push-response` is applied, decodes the reader's binary sync-pack delta, and
  verifies the pushed D1 row is present.
- 2026-07-01: Extended the Cloudflare R2 proof from raw object IO to the
  Syncular Hono blob route happy path. The generated Worker now mounts
  `createBlobRoutes(...)` with an R2 adapter, blob manager, HMAC token signer,
  and D1-backed blob upload schema; the framework smoke initiates an upload,
  follows the signed worker-proxied upload URL, completes the upload, asks for
  a signed download URL, and verifies the downloaded bytes. This narrows the
  remaining R2 risk to scoped/negative blob route cases and larger app-level
  blob flows rather than basic R2-backed route viability.
- 2026-07-01: Expanded the Cloudflare route proof with a broader negative
  D1/R2 route matrix. The D1 sync smoke now proves a cross-actor pull returns
  an empty `revoked` subscription instead of leaking scoped data, and snapshot
  chunk downloads reject missing scope headers as `sync.invalid_request` before
  wrong-scope requests fail as `sync.forbidden`. The R2 blob smoke now also
  proves unauthenticated upload initiation, invalid upload-init bodies, invalid
  direct-upload tokens, and cross-actor upload completion return stable error
  envelopes before the happy-path upload/complete/download flow continues.
- 2026-07-01: Turned the Cloudflare R2 proof from hardcoded actor allow-list
  access into scoped app-row authorization. The first attempt exposed a real D1
  DX bug: `createScopedBlobAccessDecisionChecker(...)` searched JSON blob
  reference columns with `LIKE '%sha256:...'`, and local D1 rejected the long
  content-hash pattern as too complex. `ScopedBlobReferenceTable` now accepts
  an exact `hashColumn`, the public integration docs recommend that shape for
  D1-backed routes, the unit test covers exact-hash lookup, and the Wrangler
  smoke now proves owner download URL creation stays forbidden until a scoped
  D1 app row references the completed R2 blob.
- 2026-07-01: Extended the Cloudflare R2 scoped app-row proof to a second
  file-version style reference table that uses both `hashColumn` and
  `partitionColumn`. The generated Worker now sync-pushes a row in the wrong
  route partition and proves the owner still receives a missing-reference
  `blob.forbidden`, then sync-pushes the matching partition row, downloads the
  R2-backed bytes, and proves a different actor receives `scope_denied`
  details naming `syncular_framework_file_versions.blob_ref`.
- 2026-07-01: Extended the partitioned Cloudflare R2 reference proof through
  revocation and deletion. After the matching file-version row authorizes an
  R2 download, the smoke sync-pushes the same row with `blob_ref: null` and
  proves the owner is back to a missing-reference `blob.forbidden`, then
  sync-pushes a real delete operation for that row and proves the owner still
  cannot mint a download URL. This covers the common revoke/remove file-version
  flows instead of only proving initial reference creation.
- 2026-07-01: Extended the Cloudflare runtime proof with a DO-backed
  WebSocket echo route. The generated `SyncDurableObject` now receives
  `upgradeWebSocket`, registers `/syncular-framework-import-smoke/ws`, and the
  smoke opens a local `ws://` client, sends a ping, and waits for the echoed
  marker. This proves the local Wrangler + Durable Object WebSocket bridge can
  carry non-Syncular traffic and remains a lower-level transport regression
  guard alongside the real Syncular realtime route proof.
- 2026-07-01: Added a deterministic Cloudflare local-runtime failure artifact
  self-check to `framework-import-smokes`. The `wrangler dev --local`
  DO/D1/R2/WebSocket proof now writes, validates, reads, and removes a
  synthetic `cloudflare-runtime-failure.self-check.json`; real runtime
  failures write `cloudflare-runtime-failure.json` with route, local port,
  process exit, and bounded recent-output context.
- 2026-07-01: Extended the Cloudflare local-runtime failure artifact with safe
  R2 blob route metrics. The artifact now validates nullable non-negative
  timings for upload init, byte upload, upload completion, scoped reference
  push, download URL creation, byte download, partitioned download URL
  creation, partitioned byte download, byte counts, and total route duration,
  while excluding hashes, signed URLs, direct-transfer tokens, and payload
  text.
- 2026-07-01: Promoted the Cloudflare local-runtime denial matrix into a
  redacted `negativePathProof` failure-artifact contract. The
  `framework-import-smokes` self-check, real failure artifact writer,
  `@syncular/testkit` validator, and Console/Fleet ingestion now carry compact
  counts and step summaries for auth-required sync/blob requests,
  forbidden-scope push, revoked-scope pull, invalid blob requests/tokens, and
  blob missing-reference/scope-denied access without storing actors, scopes,
  headers, tokens, hashes, signed URLs, or partition ids.
- 2026-07-01: Made `framework-import-smokes` use a run-specific temporary
  workspace by default so a direct local smoke and a release-rehearsal smoke
  cannot delete each other's generated Next/Vite/Cloudflare app directories.
- 2026-07-01: Wired `bun run release:rehearsal` to run
  `framework-import-smokes` by default after docs/fresh-app checks and before
  publish dry-runs, with `--skip-framework-import-smokes` for local iteration
  when a maintainer is not exercising bundler/package-surface readiness.
- 2026-07-01: Updated the quality-gate guide so package export maps, root
  imports, optional adapter boundaries, and dependency surface changes run both
  `bun run imports:check` and `bun run framework-import-smokes`.
- 2026-07-01: Wired the `create-syncular-app` starter to export a composed
  redacted support-bundle summary after the database opens. The task panel now
  exposes stable support-bundle DOM markers for status, redaction, section
  count, issue count, request-id count, and section-error count. The scaffold
  smoke now proves the production build contains that marker and, when Chrome
  is available, waits for redacted support-bundle DOM evidence alongside the
  existing health/schema readiness checks.
- 2026-07-01: Added hidden starter runtime-timing markers for database open,
  browser-health refresh, schema-readiness check, and support-bundle export.
  The scaffold smoke now proves the production build contains the timing
  marker and the Chrome/CDP failure probe captures those timings in
  `browser-preview-failure.json` when a browser failure artifact is written.
- 2026-07-01: Extended the starter real-browser preview smoke to write a
  redacted `browser-preview-failure.json` artifact when browser readiness times
  out or the page reports health/support-bundle failures. The artifact records
  marker booleans, support-bundle counts, redaction state, issue/request-id
  counts, and a bounded text excerpt so hosted Chrome failures produce
  inspectable support evidence.
- 2026-07-01: Added a deterministic starter smoke self-check for the
  `browser-preview-failure.json` contract. The normal scaffold smoke now
  writes, reads, validates, and removes a synthetic redacted failure artifact
  with safe preview/asset metrics, so non-browser runners prove the artifact
  shape even when Chrome/CDP is skipped.
- 2026-07-01: Extended `browser-preview-failure.json` with a redacted
  `metrics` block: artifact-created elapsed time, built-preview ready time,
  asset-check duration, asset counts/bytes, and support-bundle/lifecycle
  marker booleans. This gives browser failure artifacts a small measurable
  performance/durability context without adding app-facing API surface.
- 2026-07-01: Made the starter browser-preview Checks job preserve the smoke
  work dir in `.context/starter-browser-preview-smoke` and upload
  `browser-preview-failure.json` on job failure, so hosted Chrome readiness
  failures leave downloadable redacted support evidence instead of only logs.
- 2026-07-01: Added a live Chrome support-bundle failure artifact proof after
  the starter browser-preview happy path. The smoke opens a fresh built-preview
  page, waits for the real browser markers to be ready, forces the hidden
  support-bundle marker into a failed/redacted state, verifies that the normal
  page-reported-error path writes
  `browser-preview-failure.support-bundle.json`, and checks that artifact
  preserves deployment-preflight, browser support-policy, support-bundle issue,
  and section-error evidence. The Checks upload glob now captures
  `browser-preview-*.json` so both normal and support-bundle failure artifacts
  are preserved on hosted failures.
- 2026-07-01: Hosted Checks run `28529052910` proved the new
  support-bundle artifact upload path and exposed an over-strict verifier
  assertion: the live artifact contained ready deployment-preflight evidence
  and a concrete `supported-after-preflight` browser policy, but hosted Chrome
  reported the policy as `warning` with
  `browser_support.persistence_mismatch` because persistence evidence was
  unknown. The verifier now accepts `met` or `warning` policy verdicts while
  still rejecting missing, unsupported, not-applicable, or not-met policy
  evidence.
- 2026-07-01: Follow-up hosted Checks run `28529443648` passed the full
  matrix on `56cf1c48`, including `starter-browser-preview`. That hosted
  Chrome lane now proves the starter happy path, browser reload/reopen and
  process-restart persistence, the live support-bundle failure artifact
  verifier, and the full Rust/browser/native packaging matrix together.
- 2026-07-01: Promoted the newer browser-preview deployment-preflight artifact
  fields into Console ingestion schema coverage and route assertions. Console
  now validates and preserves available-byte budgets, quota pressure,
  service-worker availability/control, controller state, redacted controller
  script path, and usage ratio inside the stored `browser.preview_failure`
  diagnostic details instead of relying on passthrough.
- 2026-07-01: Promoted browser-preview lifecycle resume Web Lock details into
  Console ingestion schema coverage and route assertions. Console now
  validates and preserves lifecycle lock name, required flag, acquired/timed
  out state, and timeout budget inside stored `browser.preview_failure`
  diagnostic details.
- 2026-07-01: Added browser-preview lifecycle resume/pause evidence to the
  Console timing summary. Stored `browser.preview_failure` snapshots now carry
  resume count/status/reason, Web Lock name/state/timeout, pause count/reason,
  shutdown count, and pause visibility state in the quick timing row as well
  as the detailed diagnostic payload.
- 2026-07-01: Added deployment-preflight support/storage/PWA facts to the
  Console browser-preview transport summary. Stored `browser.preview_failure`
  snapshots now expose support tier, persistence, quota pressure, available
  bytes, usage ratio, and service-worker controller context in quick list/detail
  summaries as well as the full diagnostic payload.
- 2026-07-01: Surfaced browser-preview summaries in the Console client detail
  runtime panel. Operators can now see built asset counts/bytes,
  deployment-preflight status, support tier, persistence/quota pressure,
  service-worker control, and lifecycle resume/pause/Web Lock evidence without
  opening raw diagnostic JSON.
- 2026-07-01: Promoted browser support-policy verdicts into Console quick
  summaries and the client detail runtime panel. Stored
  `browser.preview_failure` snapshots now expose policy/status/context,
  observed-vs-expected support tier and persistence, first reason code,
  required evidence, known risk, and next step without requiring raw JSON.
- 2026-07-01: Surfaced Cloudflare runtime failure summaries in the same
  Console client detail panel. The panel now shows failed route, sync/blob/
  WebSocket route bases, exit/output context, and R2 blob byte/timing evidence
  from the stored quick fields, while keeping app blob-upload queue cards
  separate from runtime smoke metrics.
- 2026-07-01: Wired release rehearsal to run focused Console failure-artifact
  ingestion tests by default for `browser.preview_failure` and
  `cloudflare.runtime_failure`, with `--skip-console-artifact-ingestion` only
  for local iteration that is not proving release readiness.
- 2026-07-01: Expanded production operations docs beyond the first upgrade
  runbook. Deployment now includes restore-drill steps, blob storage
  consistency sampling, rate-limit tuning, credential rotation cadence, and
  checklist items for restore load, external blob stores, and rotation
  ownership. The upgrade guide now requires those ops drills before a package
  upgrade routes production traffic.
- 2026-07-01: Added `syncular ops check`, a narrow deploy-facing production
  evidence command that validates `syncular.ops.json` with stable issue codes
  and recommended actions for schema readiness, restore drill freshness,
  external blob consistency, credential rotation ownership/cadence, and
  rate-limit review status. Public deployment and CLI docs now show the
  evidence file shape and freshness flags.
- 2026-07-01: Extended `syncular ops check` with log/event-retention and
  support-window evidence, so deploys can fail on stale Console retention
  reviews, missing request-payload snapshot policy, prune windows smaller than
  the promised offline window, and missing compaction full-history sizing.
- 2026-07-01: Added `syncular doctor`, a narrow local readiness umbrella that
  always runs schema readiness and runs ops readiness when `syncular.ops.json`,
  `--ops-config`, or `--require-ops` is present. Missing ops evidence is
  skipped by default for local development apps; browser/CDP, framework,
  Console artifact ingestion, post-publish install, and publish dry-run checks
  remain release-rehearsal gates.
- 2026-07-01: Wired production ops readiness into release rehearsal. The
  rehearsal now runs `syncular ops check` when `syncular.ops.json` or
  `--ops-config` is present, can fail closed with
  `--require-ops-readiness`, and keeps `--skip-ops-readiness` available for
  local-only rehearsals that are not proving release readiness.
- 2026-07-01: Added Console Ops readiness ingestion for
  `syncular ops check --json`: `POST /console/ops/readiness` stores a redacted
  `ops_readiness` operation audit event, `GET /console/ops/readiness` returns
  the latest report, and the Console Ops page renders the latest production
  readiness checks and issue codes. Console gateway mode now aggregates
  readiness reads across selected instances while writes remain targeted to one
  instance.
- 2026-07-01: Added recent readiness history to the Console Ops readiness
  panel by reusing redacted `ops_readiness` operation audit events. Gateway mode
  inherits existing merged operation history, so the panel can show recent
  per-instance readiness records without a second history API.
- 2026-07-01: Added per-instance issue drilldown to the Console Ops readiness
  panel. Fleet aggregates now show each redacted ops-check issue with instance,
  severity, stable code, recommended action, and message instead of only the
  latest report's issue count.
- 2026-07-01: Added recent issue-code grouping to the Console Ops readiness
  panel from the same redacted `ops_readiness` audit history. The trend view
  groups up to the latest 100 readiness records while the raw recent table stays
  compact, so operators can see recurring codes, severity, hit count, affected
  targets, latest seen time, and latest recommended action without adding a
  second history endpoint.
- 2026-07-01: Added `GET /console/ops/readiness/trends` with `24h`, `7d`,
  `30d`, and `90d` ranges, optional `from`/`to` bounds, issue-code
  aggregation, bucket summaries, matched/scanned/truncated counts, generated
  OpenAPI/types/docs, Console gateway aggregation across selected instances,
  and a Console Ops trend panel backed by that retained API instead of the
  operation-audit page window.

## Latest Gates

Latest rerun used repo-pinned Bun `1.3.9` by prefixing `PATH` with a local
`.context/bun-1.3.9` binary.

Most recent subscription-readiness rerun:

- `bun test packages/client/src/subscription-readiness.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bun --cwd packages/create-syncular-app tsgo`
- `bunx biome check packages/client/src/subscription-readiness.ts packages/client/src/subscription-readiness.test.ts packages/client/src/database.ts packages/client/src/index.ts packages/client/src/public-api.test.ts packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts packages/client/README.md apps/docs/content/docs/clients/javascript/browser.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `cargo fmt --all --check` from `rust/`
- `cargo test --manifest-path rust/Cargo.toml -p syncular-codegen typescript_module_supports_multiple_app_tables`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir packages/create-syncular-app/template --check`
- `cargo run --manifest-path rust/Cargo.toml -p syncular-codegen -- --manifest-dir rust/examples/todo-app --check`
- `bun --cwd packages/create-syncular-app smoke`
- `bun run docs:stale-check`
- `bun --cwd apps/docs types:check`
- `bun run bundle:check`

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

Most recent mutation-status tracked-commit rerun:

- `bun test packages/client/src/mutation-status.test.ts packages/client/src/support-bundle.test.ts packages/client/src/local-recovery.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/mutation-status.ts packages/client/src/mutation-status.test.ts packages/client/src/database.ts packages/client/src/types.ts packages/client/src/local-recovery.test.ts packages/client/src/support-bundle.test.ts packages/client/README.md rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `cargo fmt --all --check` from `rust/`
- `cargo test -p syncular-runtime local_support_bundle_is_redacted_and_importable --manifest-path rust/Cargo.toml`
- `bun run docs:stale-check`
- `git diff --check`

Most recent command-timeline rerun:

- `bun test packages/client/src/command-timeline.test.ts packages/client/src/runtime-timeline.test.ts packages/client/src/mutation-status.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/command-timeline.ts packages/client/src/command-timeline.test.ts packages/client/src/console-diagnostics.ts packages/client/src/database.ts packages/client/src/index.ts packages/client/src/public-api.test.ts`
- `bun run docs:stale-check`
- `git diff --check`

Most recent command ack-sequence rerun:

- `cargo fmt --all --check` from `rust/`
- `cargo test -p syncular-runtime --manifest-path rust/Cargo.toml local_support_bundle_is_redacted_and_importable`
- `bun test packages/client/src/command-timeline.test.ts packages/client/src/mutation-status.test.ts packages/client/src/support-bundle.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/types.ts packages/client/src/mutation-status.ts packages/client/src/mutation-status.test.ts packages/client/src/command-timeline.ts packages/client/src/command-timeline.test.ts packages/client/README.md apps/docs/content/docs/operate/observability.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `bun run docs:stale-check`
- `bun --cwd apps/docs types:check`
- `git diff --check`

Most recent command local-apply rerun:

- `bun test packages/client/src/command-timeline.test.ts packages/client/src/mutation-status.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/command-timeline.ts packages/client/src/command-timeline.test.ts apps/docs/content/docs/operate/observability.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `bun run docs:stale-check`
- `bun --cwd apps/docs types:check`
- `git diff --check`

Most recent command outbox-id rerun:

- `cargo fmt --all --check` from `rust/`
- `cargo test -p syncular-runtime --manifest-path rust/Cargo.toml local_support_bundle_is_redacted_and_importable`
- `bun test packages/client/src/command-timeline.test.ts packages/client/src/mutation-status.test.ts packages/client/src/support-bundle.test.ts packages/client/src/console-diagnostics.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/types.ts packages/client/src/mutation-status.ts packages/client/src/mutation-status.test.ts packages/client/src/command-timeline.ts packages/client/src/command-timeline.test.ts packages/client/src/console-diagnostics.ts packages/client/src/console-diagnostics.test.ts packages/client/README.md apps/docs/content/docs/operate/observability.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `bun run docs:stale-check`
- `bun --cwd apps/docs types:check`
- `git diff --check`

Most recent command pull-reason rerun:

- `bun test packages/client/src/command-timeline.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/command-timeline.ts packages/client/src/command-timeline.test.ts packages/client/src/rust-client.ts rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `bun run docs:stale-check`
- `git diff --check`

Most recent command proof-summary rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/command-timeline.test.ts packages/client/src/public-api.test.ts`
  - Passed complete proof-chain assertions for outbox persistence, request id,
    sync attempt, server commit, realtime cursor, pull reason, local apply,
    and local visibility.
  - Passed partial proof assertions for context-only timelines where missing
    evidence remains explicit.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/command-timeline.ts packages/client/src/command-timeline.test.ts packages/client/README.md apps/docs/content/docs/operate/observability.mdx`
  - Passed for the TypeScript files. The repo Biome config ignores Markdown
    and MDX, so use docs typecheck/stale-check, `git diff --check`, and manual
    readback for those pages.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

Most recent realtime cursor evidence rerun:

- `bun test packages/client/src/runtime-timeline.test.ts packages/client/src/command-timeline.test.ts packages/client/src/worker-realtime.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/runtime-timeline.ts packages/client/src/runtime-timeline.test.ts packages/client/src/command-timeline.test.ts packages/client/src/worker-realtime.ts packages/client/src/worker-realtime.test.ts rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `bun run docs:stale-check`
- `git diff --check`

Most recent local-visibility evidence rerun:

- `bun test packages/client/src/local-visibility.test.ts packages/client/src/command-timeline.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/local-visibility.ts packages/client/src/local-visibility.test.ts packages/client/src/command-timeline.ts packages/client/src/command-timeline.test.ts packages/client/README.md apps/docs/content/docs/operate/observability.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `bun run docs:stale-check`
- `bun --cwd apps/docs types:check`
- `git diff --check`

Most recent sync request-id evidence rerun:

- `bun test packages/client/src/__tests__/sync-hono.wasm.test.ts -t "correlates successful pull diagnostics"`
- `bun test packages/client/src/runtime-timeline.test.ts packages/client/src/command-timeline.test.ts packages/client/src/support-bundle.test.ts packages/client/src/console-diagnostics.test.ts packages/client/src/worker-client.test.ts packages/client/src/public-api.test.ts packages/server/src/hono/__tests__/create-server.test.ts`
- `bun --cwd packages/client tsgo`
- `bun --cwd packages/server tsgo`
- `bunx biome check packages/client/src/types.ts packages/client/src/diagnostics.ts packages/client/src/rust-client.ts packages/client/src/worker-entry.ts packages/client/src/worker-client.ts packages/client/src/worker-client.test.ts packages/client/src/runtime-timeline.ts packages/client/src/runtime-timeline.test.ts packages/client/src/command-timeline.ts packages/client/src/command-timeline.test.ts packages/client/src/support-bundle.ts packages/client/src/support-bundle.test.ts packages/client/src/console-diagnostics.ts packages/client/src/console-diagnostics.test.ts packages/client/src/__tests__/sync-hono.wasm.test.ts packages/server/src/hono/routes/shared.ts packages/server/src/hono/__tests__/create-server.test.ts packages/client/README.md apps/docs/content/docs/operate/observability.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `bun run docs:stale-check`
- `bun --cwd apps/docs types:check`
- `git diff --check`

Most recent command evidence propagation rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/command-timeline.test.ts packages/client/src/runtime-timeline.test.ts`
  - Passed `8` tests proving `summary.evidence` alongside existing proof
    booleans and runtime subscription id summary extraction.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/testkit/src/failure-artifacts.test.ts packages/server/src/hono/__tests__/console-routes.test.ts -t "failure artifact|browser preview failure"`
  - Passed `9` focused tests proving the browser-preview artifact schema,
    testkit validation, and Console/Fleet ingestion for command timeline
    evidence values.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/testkit tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
  - Passed the non-Chrome scaffold/build/preview artifact path and confirmed
    the command-timeline marker is present in built assets. Chrome/Chromium was
    not installed locally, so hosted Checks remain the real-browser proof.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/command-timeline.ts packages/client/src/command-timeline.test.ts packages/client/src/runtime-timeline.ts packages/client/src/runtime-timeline.test.ts packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts packages/testkit/src/failure-artifacts.ts packages/testkit/src/failure-artifacts.test.ts packages/server/src/hono/console/schemas.ts packages/server/src/hono/console/routes/shared.ts packages/server/src/hono/__tests__/console-routes.test.ts packages/client/README.md apps/docs/content/docs/operate/observability.mdx apps/docs/content/docs/clients/javascript/testing/primitives.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

Most recent testkit negative-path response assertion rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/testkit/src/sync-response.test.ts packages/testkit/src/scoped-actors.test.ts`
  - Passed unit assertions for push commits, push operation results,
    `requirePushErrorCode(...)`, pull subscriptions, and
    `requireRevokedSubscription(...)`.
  - Passed the real project-scoped Hono fixture for allowed project writes,
    denied project writes as `sync.forbidden`, and revoked foreign
    subscriptions using the new assertion helpers.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/testkit tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/testkit/src/sync-response.ts packages/testkit/src/sync-response.test.ts packages/testkit/src/scoped-actors.test.ts apps/docs/content/docs/clients/javascript/testing/primitives.mdx apps/docs/content/docs/clients/javascript/testing/index.mdx`
  - Passed for the TypeScript files. The repo Biome config ignores the MDX
    docs, so keep `apps/docs types:check`, `docs:stale-check`, `git diff
    --check`, and manual Markdown sanity reads for those pages.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

Most recent testkit command-proof assertion rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/testkit/src/command-proof.test.ts`
  - Passed complete proof assertions for the full command evidence chain.
  - Passed subset assertions for partial E2E/browser support flows.
  - Passed actionable missing-evidence messages and canonical key ordering.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/testkit tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/testkit/src/command-proof.ts packages/testkit/src/command-proof.test.ts packages/testkit/src/index.ts apps/docs/content/docs/clients/javascript/testing/primitives.mdx apps/docs/content/docs/clients/javascript/testing/index.mdx apps/docs/content/docs/operate/observability.mdx`
  - Passed for the TypeScript files. The repo Biome config ignores MDX, so
    keep `apps/docs types:check`, `docs:stale-check`, `git diff --check`, and
    manual Markdown sanity reads for those pages.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

Most recent testkit failure-artifact assertion rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/testkit/src/failure-artifacts.test.ts`
  - Passed canonical browser-preview failure artifact shape/redaction
    assertions, including support-policy count consistency,
    support-bundle redaction, lifecycle resume/pause evidence, and bounded
    page text excerpts.
  - Passed canonical Cloudflare runtime failure artifact shape/redaction
    assertions, including route/exit fields, bounded output excerpts, and
    safe blob timing/byte metrics.
  - Passed sensitive-key and forbidden-substring failure paths.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/testkit tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/testkit/src/failure-artifacts.ts packages/testkit/src/failure-artifacts.test.ts packages/testkit/src/index.ts apps/docs/content/docs/clients/javascript/testing/index.mdx apps/docs/content/docs/clients/javascript/testing/primitives.mdx apps/docs/content/docs/operate/observability.mdx`
  - Passed for the TypeScript files. The repo Biome config ignores MDX, so
    keep `apps/docs types:check`, `docs:stale-check`, `git diff --check`, and
    manual Markdown sanity reads for those pages.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

Most recent lifecycle/multi-tab preflight rerun:

- `bun test packages/client/src/browser-deployment-preflight.test.ts packages/client/src/public-api.test.ts packages/client/src/support-bundle.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/browser-deployment-preflight.ts packages/client/src/browser-deployment-preflight.test.ts packages/client/README.md apps/docs/content/docs/clients/javascript/browser.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `bun run docs:stale-check`
- `bun --cwd apps/docs types:check`
- `git diff --check`

Most recent browser support-tier preflight rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/browser-deployment-preflight.test.ts packages/client/src/support-bundle.test.ts packages/client/src/public-api.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/browser-deployment-preflight.ts packages/client/src/browser-deployment-preflight.test.ts packages/client/src/support-bundle.test.ts packages/create-syncular-app/template/src/client/syncular.ts packages/client/README.md apps/docs/content/docs/clients/javascript/browser.mdx`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available.

Most recent browser support-matrix rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/browser-support-matrix.test.ts packages/client/src/public-api.test.ts`
  - Passed support-policy matrix and evaluation coverage, including the new
    support-policy context hint helper for explicit contexts,
    service-worker-controlled PWA pages, ephemeral/development storage,
    unsupported storage, and no-preflight defaulting.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/browser-support-matrix.ts packages/client/src/browser-support-matrix.test.ts packages/client/src/public-api.test.ts packages/create-syncular-app/template/src/app.tsx packages/client/README.md apps/docs/content/docs/clients/javascript/browser.mdx`
  - Passed for TypeScript files; Markdown/MDX is covered by stale-doc and
    docs typecheck gates below.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-support-context-hint-smoke-2 bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, built asset checks, and
    browser failure artifact shape self-check.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available.
- `git diff --check`

Most recent browser support-policy artifact rerun:

- `gh run list --repo syncular/syncular --workflow checks.yml --limit 10 --json databaseId,displayTitle,headBranch,headSha,status,conclusion,createdAt,updatedAt,event,url`
- `gh run view 28459201533 --repo syncular/syncular --json jobs,conclusion,status,headSha,createdAt,updatedAt,event,workflowName`
- `git show origin/main:.github/workflows/checks.yml | rg -n "starter-browser-preview|browser-preview" -C 2`
  - Confirmed the latest observed `main` Checks run
    `28459201533` for `origin/main` `7f0081b6` did not contain
    `starter-browser-preview`; `git show origin/main:.github/workflows/checks.yml`
    also lacks the job, while branch `HEAD` `c7f32182` contains it.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/browser-support-matrix.test.ts packages/client/src/browser-deployment-preflight.test.ts packages/client/src/public-api.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/core tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run generate:openapi`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, built asset checks,
    browser support-policy marker reason-code checks, and failure-artifact
    self-checks.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/browser-support-matrix.ts packages/client/src/browser-support-matrix.test.ts packages/client/src/public-api.test.ts packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts packages/server/src/hono/console/schemas.ts packages/server/src/hono/__tests__/console-routes.test.ts packages/client/README.md apps/docs/content/docs/clients/javascript/browser.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

Most recent Cloudflare runtime artifact ingestion rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-gateway-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run generate:openapi`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/core tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/server/src/hono/console/schemas.ts packages/server/src/hono/console/routes/shared.ts packages/server/src/hono/console/routes/clients.ts packages/server/src/hono/__tests__/console-routes.test.ts apps/docs/content/docs/operate/console/fleet.mdx apps/docs/content/docs/operate/observability.mdx apps/docs/content/docs/reference/api/index.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent Cloudflare runtime Console UI summary rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console build`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/console/src/pages/ClientDetails.tsx apps/docs/content/docs/operate/console/fleet.mdx apps/docs/content/docs/operate/observability.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`
  - Passed with the Console client detail runtime panel rendering conditional
    Cloudflare runtime route/exit/output summaries and R2 blob byte/timing
    summaries from `transportStats`, `blobUploadStats`, and the latest timing
    row. The production build emitted the existing Vite large-chunk warning
    only.

Most recent generated write-pressure local rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/scripts/smoke.ts packages/create-syncular-app/template/src/app.tsx`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
  - Passed starter TypeScript checks.
  - Biome checked the starter smoke script and template app marker hook.
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, built runtime asset checks,
    browser failure artifact shape self-check, and safe smoke metrics.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners, the CDP path now opens a
    duplicate tab with the same `syncularClientId` while the active same-client
    tab remains open. The duplicate must either become ready and show the
    existing task or report an explicit starter-open error, and the active tab
    must still accept a fresh task after the duplicate attempt. The CDP path
    then triggers the starter's hidden generated write-pressure marker: four
    generated task mutations run concurrently, each must reach
    `awaitTaskVisibility(...)`, all rows must render in the active tab, and the
    observer tab must receive every row through sync/realtime before the
    browser-process restart proof runs. This adds a bounded generated write
    pressure proof while still leaving heavier same-database multi-tab write
    storms as remaining work.
  - Previous hosted Checks run
    <https://github.com/syncular/syncular/actions/runs/28534746069> passed on
    commit `316955f9`, including `starter-browser-preview`, proving the
    duplicate-tab contention path in Chrome plus the full Rust/native package
    matrix before the generated write-pressure extension.
  - Hosted Checks run
    <https://github.com/syncular/syncular/actions/runs/28535566013> passed on
    commit `b04d15f6`, including `starter-browser-preview`, proving the new
    generated write-pressure path in Chrome plus the full Rust/native package
    matrix.

Previous Chrome CDP lifecycle-state proof rerun:

- Hosted Checks run
  <https://github.com/syncular/syncular/actions/runs/28533712104> passed on
  commit `6e547607`, including `starter-browser-preview`. An earlier failed
  hosted artifact showed `Page.setWebLifecycleState({ state: "frozen" })` and
  `Page.setWebLifecycleState({ state: "active" })` do not emit the same
  app-facing `freeze` pause marker; Chrome instead reports the BFCache
  lifecycle suspension diagnostic and the app recovers through a
  `visibilitychange` resume marker. The smoke now requires that diagnostic plus
  recovery marker before continuing through the existing `beforeunload`, Web
  Lock, two-tab, reload, duplicate-tab, restart, and support-bundle artifact
  proofs.

Previous browser lifecycle resume helper rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/browser-lifecycle.test.ts packages/client/src/public-api.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/browser-lifecycle.ts packages/client/src/browser-lifecycle.test.ts packages/client/README.md apps/docs/content/docs/clients/javascript/browser.mdx packages/create-syncular-app/scripts/smoke.ts rust/docs/ROADMAP.md rust/docs/QUALITY_GATES.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`
  - Hosted follow-up `gh workflow run Checks --ref
    bkniffler/wp50-dx-health` / `gh run watch 28532035671 --exit-status`
    passed the full Checks matrix on `36a274b4`, including
    `starter-browser-preview`. That hosted Chrome path is the real-browser
    authority for the dispatched `freeze` pause marker and browser `resume`
    foreground catch-up marker because this local machine has no
    Chrome/Chromium binary.
  - Focused lifecycle tests now pass for browser `resume` catch-up, `freeze`
    pause evidence, and listener teardown for both events.
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks,
    including the lifecycle-resume lock-state, lock-timeout, and
    support-bundle markers in the production JavaScript asset.
  - Passed browser failure artifact shape self-check with lifecycle lock name,
    required flag, lock state, `lifecyclePause.pagehidePersisted`, and
    `lifecyclePause.shutdownSignalCount`.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners the same CDP path now
    dispatches hidden `visibilitychange`, verifies hidden pause evidence,
    dispatches visible `visibilitychange`, waits for a completed visible-tab
    lifecycle marker, dispatches persisted `pagehide`, verifies pause
    evidence, dispatches persisted `pageshow`, waits for a completed
    restored-page lifecycle marker, dispatches `online`, waits for a second
    completed lifecycle marker, dispatches `freeze`, verifies page-lifecycle
    suspension intent evidence, dispatches browser `resume`, waits for a
    completed lifecycle marker, dispatches `beforeunload`, verifies
    shutdown-signal evidence, opens a
    second tab with a distinct client id/database file, dispatches `online` in
    both tabs, verifies both tabs report the starter lifecycle Web Lock as
    acquired, creates a task in the first tab, and waits for the second tab to
    observe it through sync/realtime. The Chrome/CDP path now also navigates
    the second tab through a same-client reload/reopen and waits for the task
    to reappear after app startup, holds the real lifecycle Web Lock and
    verifies timeout/recovery marker evidence, then stops Chrome, starts a
    fresh Chrome process with the same profile directory and client id, and
    waits for the task to survive that browser-process boundary.

Most recent starter two-tab lifecycle coordination rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/scripts/smoke.ts rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
  - Passed for the TypeScript smoke file. The repo Biome config ignores the
    Markdown planning docs, so keep using `git diff --check` and manual
    Markdown sanity reads for those files.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-two-tab-lifecycle-smoke-2 bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, built asset checks, and the
    browser failure artifact shape self-check.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners the CDP path now opens a
    second generated-app tab, dispatches `online` in both tabs, waits for both
    lifecycle markers to advance, verifies both markers report the starter
    lifecycle Web Lock as acquired, then continues through two-tab
    propagation, same-client reload/reopen, and same-profile browser-process
    restart task visibility.

Most recent starter lifecycle Web Lock contention rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/scripts/smoke.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-browser-preview-smoke-local-lock-contention bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, built asset checks, and the
    deterministic browser failure artifact shape and safe-metrics self-check.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners the CDP path now holds
    the same lifecycle Web Lock used by the starter, dispatches `online`,
    waits for `lockState: "timed-out"` plus the configured `10000ms` timeout
    error, releases the held lock, and verifies a follow-up `online` resume
    completes.

Most recent starter reload/reopen persistence rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/scripts/smoke.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-reload-persistence-smoke-2 bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks.
  - Passed the deterministic browser failure artifact shape and safe-metrics
    self-check.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners, the CDP path now proves
    persisted `pageshow`, `online`, two-tab propagation, and same-client
    reload/reopen plus same-profile browser-process restart task visibility.

Most recent starter browser-preview rerun:

- `bunx biome check packages/create-syncular-app/scripts/smoke.ts`
- `bun --cwd packages/create-syncular-app tsgo`
- `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/checks.yml"); puts "workflow yaml ok"'`
- `bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks.
  - Skipped the real-browser CDP check because no Chrome/Chromium binary was
    available locally.
- `bun --cwd packages/create-syncular-app smoke --require-browser-preview`
  - Failed locally only at the required browser step because no
    Chrome/Chromium binary was available. The new Checks job supplies Chrome
    with `browser-actions/setup-chrome@v2` and exports `CHROME_BIN` from
    `steps.setup-chrome.outputs.chrome-path`.
- `bun run docs:stale-check`
- `git diff --check`

Most recent starter support-bundle artifact rerun:

- `bun --cwd packages/create-syncular-app tsgo`
- `bunx biome check packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/template/src/client/syncular.ts packages/create-syncular-app/template/src/styles.css packages/create-syncular-app/scripts/smoke.ts`
- `bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks,
    including the support-bundle and runtime-timing markers in the production
    JavaScript asset.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available.
- `git diff --check`

Most recent starter browser-failure artifact rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts rust/docs/QUALITY_GATES.md rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-browser-preview-smoke-local bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks,
    including support-bundle, lifecycle, and starter runtime-timing markers.
  - Passed the deterministic browser failure artifact shape and safe-metrics
    self-check.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. The real failure artifact writer runs on
    browser-capable runners when the page reports health/support-bundle
    failures or readiness times out; this rerun also proved configured smoke
    work dirs resolve under the repo root, matching the Checks upload path.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-browser-preview-smoke-local-required bun --cwd packages/create-syncular-app smoke --require-browser-preview`
  - Failed locally only at the required browser step because no
    Chrome/Chromium binary was available, after the same build, preview asset
    checks, starter runtime-timing marker check, and browser failure artifact
    shape/safe-metrics self-check passed.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent starter local recovery lock proof rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, runtime asset checks, and
    deterministic browser failure artifact shape/safe-metrics self-check with
    the new `probe.localRecoveryProof` section.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners, the starter smoke now
    holds the real browser local-recovery Web Lock, verifies the
    non-destructive support-bundle recovery action fails with
    `syncular.local_recovery_web_locks_timeout`, releases the lock, reruns the
    same action, and requires an acquired/completed marker.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --allow-dirty --skip-publish-dry-runs`
  - Passed version and Cargo version stamp dry-runs, docs stale check,
    JavaScript and Rust fresh-app smokes, `create-syncular-app` smoke with the
    new local-recovery proof artifact section, Next/Vite/Cloudflare framework
    smokes, Cloudflare local runtime IO proof, and focused Console ingestion
    tests for browser-preview and Cloudflare runtime failure artifacts.
  - Skipped local Chrome/Chromium execution in starter and Vite browser smokes
    because this machine has no Chrome/Chromium binary. Publish dry-runs were
    intentionally skipped for this local WP-50 iteration gate.
- Hosted Checks run `28530944285` passed on `8cf12ab6`, including
  `starter-browser-preview`. That hosted Chrome path exercises the new
  local-recovery proof branch by holding the real browser recovery Web Lock,
  observing the bounded timeout marker, releasing the lock, and requiring the
  same non-destructive support-bundle recovery action to complete under an
  acquired lock.

Most recent live support-bundle failure artifact rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/scripts/smoke.ts .github/workflows/checks.yml rust/docs/ROADMAP.md rust/docs/QUALITY_GATES.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, runtime asset checks,
    hidden support-bundle/lifecycle/runtime-timing marker checks, and the
    deterministic browser failure artifact shape/safe-metrics self-check.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners, the smoke now opens an
    extra built-preview Chrome target after the happy path, forces the hidden
    support-bundle marker to a failed/redacted state, verifies
    `browser-preview-failure.support-bundle.json`, and fails if the artifact
    omits live deployment-preflight, support-policy, support-bundle issue, or
    section-error evidence.
- Hosted Checks run `28529052910` failed in `starter-browser-preview` after
  uploading `starter-browser-preview-28529052910`. The downloaded
  `browser-preview-failure.support-bundle.json` proved the live artifact path:
  `reason=page-reported-errors`, support bundle `status=failed`,
  `redacted=true`, ready deployment preflight, and browser support policy
  `policy=supported-after-preflight` with `status=warning` /
  `browser_support.persistence_mismatch`. The local verifier has been
  corrected to treat that warning verdict as actionable evidence while still
  failing missing or unsupported policy states.
- Hosted Checks run `28529443648` passed on `56cf1c48`, including
  `starter-browser-preview`. That closes the hosted live
  support-bundle-failure artifact proof for this slice.
- After the verifier correction:
  `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/scripts/smoke.ts`
- After the verifier correction:
  `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- After the verifier correction:
  `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
  - Passed the same local scaffold/build/runtime-asset/artifact self-checks;
    skipped Chrome locally because no Chrome/Chromium binary was available.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent browser-failure Console ingestion rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs generate:openapi`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/server/src/hono/console/schemas.ts packages/server/src/hono/console/routes/clients.ts packages/server/src/hono/console/routes/shared.ts packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`
  - Passed route coverage for raw artifact ingestion, wrapped artifact
    ingestion with client identity, sensitive-field rejection, normalized
    `browser.preview_failure` records, deployment-preflight storage/quota and
    service-worker controller detail preservation, lifecycle Web Lock detail
    preservation, deployment-preflight transport summary preservation,
    browser support-policy transport summary preservation, lifecycle
    timing-summary preservation, safe metrics/timing preservation, and dropping
    the artifact page `textExcerpt`.

Most recent browser-failure Console UI summary rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console build`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --allow-dirty --skip-publish-dry-runs --skip-fresh-app-smokes --skip-docs-stale-check --skip-starter-smoke --skip-framework-import-smokes`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/server/src/hono/console/routes/shared.ts packages/server/src/hono/__tests__/console-routes.test.ts packages/console/src/pages/ClientDetails.tsx apps/docs/content/docs/operate/console/fleet.mdx apps/docs/content/docs/operate/observability.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`
  - Passed with the Console client detail runtime panel rendering conditional
    browser-preview asset, support-policy, deployment-preflight,
    service-worker, and lifecycle summary cards from `transportStats` and the
    latest timing summary. The release-rehearsal focused ingestion path also
    passed with the promoted support-policy quick fields. The production build
    emitted the existing Vite large-chunk warning only.

Most recent starter local-visibility artifact rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-local-visibility-smoke bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks,
    including the local-visibility timing marker in the starter timeline
    asset check.
  - Passed the deterministic browser failure artifact shape and safe-metrics
    self-check with local-visibility timing fields.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners the CDP path now creates
    a generated task in the first tab, waits for the first tab's
    local-visibility timing marker to become `visible`, and then waits for the
    second tab to observe the row through the normal sync/realtime path.

Most recent starter bootstrap/realtime artifact rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-bootstrap-realtime-smoke bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks,
    including bootstrap-ready, realtime-connected, and local-visibility timing
    markers in the starter timeline asset check.
  - Passed the deterministic browser failure artifact shape and safe-metrics
    self-check with bootstrap/realtime timing fields.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners the artifact can now show
    whether bootstrap and realtime were still pending or had first-observed
    elapsed timings before any local-visibility or two-tab timeout.

Most recent starter storage/quota artifact rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/browser-deployment-preflight.ts packages/client/src/browser-deployment-preflight.test.ts packages/client/src/browser-support-matrix.ts packages/client/src/browser-support-matrix.test.ts packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts apps/docs/content/docs/clients/javascript/browser.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/browser-deployment-preflight.test.ts packages/client/src/browser-support-matrix.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks,
    including the deployment-preflight storage/quota marker.
  - Passed the deterministic browser failure artifact shape and safe-metrics
    self-check with deployment-preflight status, support tier, persistence
    mode, persisted flag, quota/usage/available bytes, minimum quota,
    minimum available bytes, usage ratio, quota pressure, service-worker
    availability/control, controller state, redacted controller script path,
    issue count, and recommended-action count.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. On browser-capable runners the failure artifact can
    now distinguish low total quota, low free space, high storage pressure, or
    persistence-grant gaps from service-worker-controlled PWA/cache-skew
    context, including controller state/script path, bootstrap, realtime,
    local-visibility, and support-bundle failures.

Most recent starter storage recovery action-mapping rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/local-recovery.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/local-recovery.ts packages/client/src/local-recovery.test.ts packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-storage-recovery-capability-smoke bun --cwd packages/create-syncular-app smoke`
  - Passed focused local recovery tests, including the regression where a
    known core-only runtime omits `clear-blob-cache` and sign-out skips
    `clearBlobCache`.
  - Passed client and generated app typechecks plus focused Biome check.
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks,
    including the storage recovery proof marker.
  - Passed the deterministic browser failure artifact shape and safe-metrics
    self-check with `storageRecoveryProof.actionKinds`, request-persistence
    support/grant state, compaction completion, and the conditional
    blob-cache clear completion state.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available.
  - Hosted Checks run `28537538486` on commit `bc6dc432` failed the
    `starter-browser-preview` job because the old smoke required
    `clear-blob-cache` in the core starter runtime; the browser failure artifact
    reported `worker.failed` / `blob support is not enabled in this Syncular
    runtime build`. The local recovery plan is now capability-aware: known
    core-only runtime snapshots omit blob-cache clearing, while unknown or
    blob-capable runtimes keep the existing clear action.
  - On browser-capable runners the starter now dispatches
    `syncular-starter-run-storage-recovery-proof` and requires the generated
    app to plan and run request-persistence plus compaction through public local
    recovery APIs; confirmed blob-cache clearing is required only when the
    active plan offers `clear-blob-cache`.

Most recent starter support-timeline artifact rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" SYNCULAR_CSA_SMOKE_WORK_DIR=.context/starter-support-timeline-smoke bun --cwd packages/create-syncular-app smoke`
  - Passed dev server health/page/module/preflight transform checks.
  - Passed Vite production build, preview serving, and built asset checks,
    including support-bundle runtime-timeline marker fields.
  - Passed the deterministic browser failure artifact shape and safe-metrics
    self-check with sync/realtime/local-apply/blob phase counts, cursor count,
    request-id count, sync-attempt-id count, and latest phase codes.
  - Skipped the real-browser CDP check locally because no Chrome/Chromium
    binary was available. The starter now refreshes the support-bundle marker
    on `rowsChanged`, so browser-capable failure artifacts can include the
    latest public timeline evidence after generated mutations instead of only
    the initial page-open snapshot.

Most recent production-ops automation rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun packages/syncular/src/cli.ts ops check --help`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/syncular/src/cli.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/syncular tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/syncular/src/cli.ts packages/syncular/src/cli.test.ts packages/syncular/README.md apps/docs/content/docs/reference/cli/ops-check.mdx apps/docs/content/docs/operate/deployment.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`
  - Passed the expanded ops-check contract for log/event retention and
    support-window evidence, including help output, ready-state JSON, stale
    retention review, missing payload snapshot policy, and prune windows
    smaller than the promised offline window.

Most recent doctor readiness rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/syncular/src/cli.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/syncular tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun packages/syncular/src/cli.ts doctor --manifest-dir packages/create-syncular-app/template --json --pretty`
  - Passed with schema readiness ready and ops readiness skipped because the
    starter template has no production `syncular.ops.json`.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun packages/syncular/src/cli.ts doctor --manifest-dir packages/create-syncular-app/template --require-ops --json`
  - Expected nonzero status: schema readiness stayed ready, while required ops
    readiness failed with stable `ops.*` issue codes for the missing
    production evidence file.

Most recent release-rehearsal ops-readiness rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --allow-dirty --skip-docs-stale-check --skip-fresh-app-smokes --skip-starter-smoke --skip-framework-import-smokes --skip-console-artifact-ingestion --skip-publish-dry-runs --ops-config .context/release-ops-readiness/syncular.ops.json`
  - Passed version stamp dry-runs, Cargo version stamp dry-run, and
    `syncular ops check --json --pretty` against a production evidence fixture
    with schema readiness, restore drill, blob consistency, credential
    rotation, rate limits, log retention, and support-window checks ready.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --allow-dirty --skip-docs-stale-check --skip-fresh-app-smokes --skip-starter-smoke --skip-framework-import-smokes --skip-console-artifact-ingestion --skip-publish-dry-runs --require-ops-readiness`
  - Expected nonzero status: version stamp dry-runs passed, then release
    rehearsal failed closed because no root `syncular.ops.json` was available.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --allow-dirty --skip-docs-stale-check --skip-fresh-app-smokes --skip-starter-smoke --skip-framework-import-smokes --skip-console-artifact-ingestion --skip-publish-dry-runs`
  - Passed version stamp dry-runs and skipped ops readiness with a clear local
    iteration message because no root `syncular.ops.json` was available.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check scripts/release-rehearsal.ts rust/docs/ROADMAP.md rust/docs/QUALITY_GATES.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent ops-readiness Console ingestion rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run generate:openapi`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/core tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/server/src/hono/console/schemas.ts packages/server/src/hono/console/routes/context.ts packages/server/src/hono/console/routes/maintenance.ts packages/server/src/hono/console/gateway.ts packages/server/src/hono/__tests__/console-routes.test.ts packages/server/src/hono/__tests__/console-gateway-routes.test.ts packages/console/src/hooks/useConsoleApi.ts packages/console/src/lib/types.ts packages/console/src/pages/Ops.tsx apps/docs/content/docs/reference/api/index.mdx apps/docs/content/docs/reference/cli/ops-check.mdx apps/docs/content/docs/operate/console/operations.mdx apps/docs/content/docs/operate/deployment.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent ops-readiness Console aggregation rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-gateway-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run generate:openapi`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/core tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/server/src/hono/console/schemas.ts packages/server/src/hono/console/gateway.ts packages/server/src/hono/__tests__/console-gateway-routes.test.ts packages/server/src/hono/__tests__/console-routes.test.ts packages/console/src/hooks/useConsoleApi.ts packages/console/src/lib/types.ts packages/console/src/pages/Ops.tsx apps/docs/content/docs/operate/console/operations.mdx apps/docs/content/docs/reference/cli/ops-check.mdx apps/docs/content/docs/operate/deployment.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent ops-readiness Console history rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-gateway-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/console/src/pages/Ops.tsx apps/docs/content/docs/operate/console/operations.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent ops-readiness issue drilldown rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-gateway-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/console/src/pages/Ops.tsx apps/docs/content/docs/operate/console/operations.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent ops-readiness issue trend rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-gateway-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/console/src/pages/Ops.tsx apps/docs/content/docs/operate/console/operations.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent ops-readiness trends API rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run generate:openapi`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/console-gateway-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/core tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/console tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/server/src/hono/console/schemas.ts packages/server/src/hono/console/routes/maintenance.ts packages/server/src/hono/console/gateway.ts packages/server/src/hono/__tests__/console-routes.test.ts packages/server/src/hono/__tests__/console-gateway-routes.test.ts packages/console/src/hooks/useConsoleApi.ts packages/console/src/lib/types.ts packages/console/src/pages/Ops.tsx apps/docs/content/docs/operate/console/operations.mdx apps/docs/content/docs/reference/api/index.mdx apps/docs/content/docs/reference/api/getConsoleOpsReadinessTrends.mdx rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
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
- `bunx biome check scripts/check-import-boundaries.ts`
- `bun run docs:stale-check`
- `git diff --check`

Most recent browser-deployment-preflight rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/browser-deployment-preflight.test.ts packages/client/src/browser-support-matrix.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/browser-deployment-preflight.ts packages/client/src/browser-deployment-preflight.test.ts packages/client/src/browser-support-matrix.ts packages/client/src/browser-support-matrix.test.ts packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/scripts/smoke.ts apps/docs/content/docs/clients/javascript/browser.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `git diff --check`

Most recent optional-import-matrix rerun:

- `bunx biome check scripts/post-publish-install-smokes.ts`
- `bun scripts/post-publish-install-smokes.ts --help`
- Disposable local `node_modules/@syncular/*` symlink import check covering 27
  optional subpath exports from `@syncular/client` and `@syncular/server`
- `git diff --check`

Most recent native-sqlite-matrix script rerun:

- `bunx biome check scripts/post-publish-install-smokes.ts`
- `bun scripts/post-publish-install-smokes.ts --help`
- `bun run docs:stale-check`
- `git diff --check`

Most recent native-sqlite release-policy docs rerun:

- `bun run docs:stale-check`
- `git diff --check`
- Manual Markdown sanity read of `RELEASING.md`,
  `rust/docs/QUALITY_GATES.md`, and this work package's remaining-risk text.

Most recent framework-import-smoke rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/testkit/src/failure-artifacts.test.ts packages/server/src/hono/__tests__/console-routes.test.ts -t "failure artifact|Cloudflare runtime failure"`
  - Passed canonical browser-preview and Cloudflare runtime failure-artifact
    shape/redaction assertions plus Console/Fleet ingestion for both artifact
    families, including the new Cloudflare runtime `negativePathProof`
    counters and diagnostic detail preservation.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/testkit tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check scripts/framework-import-smokes.ts packages/testkit/src/failure-artifacts.ts packages/testkit/src/failure-artifacts.test.ts packages/server/src/hono/console/schemas.ts packages/server/src/hono/console/routes/shared.ts packages/server/src/hono/__tests__/console-routes.test.ts apps/docs/content/docs/testing/strategy.mdx apps/docs/content/docs/start/testing-and-confidence.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/framework-import-smokes.ts`
  - Passed the Next 16 SSR production build proof.
  - Passed the Vite 8 browser production build proof.
  - Passed the Vite production-preview HTTP proof for the built HTML and
    served JavaScript bundle marker.
  - Passed the deterministic Vite browser-runtime failure artifact shape
    self-check.
  - Skipped the optional Vite Chrome/CDP browser-runtime proof because no
    Chrome/Chromium binary was available on this local machine.
  - Passed the Wrangler dry-run Cloudflare Durable Object + D1 schema/authz +
    Syncular realtime + R2 blob authz + WebSocket bundle/binding proof.
  - Passed the local `wrangler dev --local` runtime fetch/WebSocket proof for
    the generated `createSyncWorkerWithDO(...)` route through the `SYNC_DO`,
    D1, and R2 bindings, including `ensureSyncSchema(...)`, `sync_commits`
    table query, D1 app-table insert/select/delete, Syncular HTTP push/pull
    with binary sync-pack and decoded snapshot chunk, `sync.auth_required`,
    forbidden-scope `sync.forbidden`, wrong-scope snapshot-chunk
    `sync.forbidden`, real Syncular realtime reader/writer WebSockets with
    WebSocket push-response and decoded binary sync-pack delta, R2-backed blob
    route upload/complete/download, forbidden `blob.forbidden` download URL
    details, and Durable Object WebSocket echo.
  - Passed the deterministic Cloudflare local-runtime failure artifact shape
    self-check, including safe `blobMetrics` fields and redacted
    `negativePathProof` counts/step summaries for auth-required sync/blob
    requests, forbidden-scope push, revoked-scope pull, invalid blob
    requests/tokens, and blob missing-reference/scope-denied access.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/framework-import-smokes.ts --require-vite-browser-runtime`
  - Expected nonzero status locally because Chrome/Chromium is unavailable;
    confirms the required Vite browser-runtime path fails loudly after the
    Next build, Vite build, preview HTTP proof, and Vite failure artifact
    self-check instead of accepting a skipped browser proof.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --allow-dirty --skip-publish-dry-runs --skip-fresh-app-smokes --skip-docs-stale-check --skip-starter-smoke`
  - Confirmed release rehearsal still runs the framework smoke by default and
    returns cleanly after the Vite preview HTTP proof, optional local Chrome
    skip, and local Cloudflare Durable Object runtime probe.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --allow-dirty --skip-publish-dry-runs --skip-fresh-app-smokes --skip-docs-stale-check --skip-starter-smoke --require-framework-vite-browser-runtime`
  - Expected nonzero status locally because release rehearsal passes the new
    required Vite browser-runtime flag through to `framework-import-smokes`
    and the local machine has no Chrome/Chromium binary.
- `bun run docs:stale-check`
- `git diff --check`

Most recent release-rehearsal framework-smoke wiring rerun:

- `bunx biome check scripts/release-rehearsal.ts scripts/framework-import-smokes.ts RELEASING.md rust/docs/QUALITY_GATES.md rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `bun scripts/release-rehearsal.ts --allow-dirty --skip-publish-dry-runs --skip-fresh-app-smokes --skip-docs-stale-check --skip-starter-smoke`
  - Ran version stamp dry-runs, then the default framework import smoke.
  - Passed Next, Vite build/preview, and Cloudflare Durable Object + D1
    schema/authz + Syncular realtime + R2 blob authz + WebSocket
    dry-run/runtime IO proofs while skipping optional local Chrome execution.
- `bun scripts/release-rehearsal.ts --allow-dirty --skip-publish-dry-runs --skip-fresh-app-smokes --skip-docs-stale-check --skip-starter-smoke --require-framework-vite-browser-runtime`
  - Expected nonzero status locally because the new required Vite
    browser-runtime flag is passed through and no Chrome/Chromium binary is
    available.
- `bun run docs:stale-check`
- `git diff --check`

Most recent release-rehearsal Console artifact ingestion rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx tsgo --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --types bun --skipLibCheck scripts/release-rehearsal.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --help`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --allow-dirty --skip-publish-dry-runs --skip-fresh-app-smokes --skip-docs-stale-check --skip-starter-smoke --skip-framework-import-smokes`
  - Passed version and Cargo version stamp dry-runs, then ran the default
    focused Console ingestion gate for
    `browser.preview_failure` and `cloudflare.runtime_failure` artifacts:
    `bun test packages/server/src/hono/__tests__/console-routes.test.ts -t "ingests browser preview failure artifacts|ingests Cloudflare runtime failure artifacts"`.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --allow-dirty --skip-publish-dry-runs --skip-fresh-app-smokes --skip-docs-stale-check --skip-starter-smoke --skip-framework-import-smokes --skip-console-artifact-ingestion`
  - Passed version and Cargo version stamp dry-runs and skipped the Console
    artifact ingestion gate for local iteration.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check scripts/release-rehearsal.ts RELEASING.md rust/docs/QUALITY_GATES.md rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md apps/docs/content/docs/reference/cli/doctor.mdx`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

Most recent release-rehearsal local gate rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun scripts/release-rehearsal.ts --skip-publish-dry-runs`
  - Passed version stamp dry-runs, Cargo version stamp dry-run, docs stale
    check, JS browser fresh-app generate/check/schema/runtime smoke, Rust
    fresh-app generate/check/cargo test smoke, create-syncular-app
    built-preview smoke, Next root import production build smoke, Vite root
    import build/preview smoke, Vite browser-runtime artifact self-check,
    Cloudflare Worker dry-run, and Cloudflare DO/D1 schema/sync authz/realtime
    plus R2 blob authz/WebSocket runtime IO smoke.
  - Skipped optional local Chrome/Chromium execution in starter and Vite
    browser smokes because this machine has no Chrome/Chromium binary.
  - Publish dry-runs were intentionally skipped for this local WP-50 coherence
    gate; the release rehearsal script still owns them when run without
    `--skip-publish-dry-runs`.

Most recent framework-import quality-gate docs rerun:

- `bun run docs:stale-check`
- `git diff --check`
- Manual Markdown sanity read of `rust/docs/QUALITY_GATES.md`.

Most recent local-recovery rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/client/src/local-recovery.test.ts packages/client/src/public-api.test.ts`
  - Covers recovery Web Locks serialization, optional-lock fallback, and
    required-lock failure before the client action runs.
  - Covers bounded Web Lock timeout for queued recovery actions, including
    proving the timed-out queued action does not run later after the held lock
    releases and that later recovery can acquire the lock again.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/client tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/client/src/local-recovery.ts packages/client/src/local-recovery.test.ts packages/client/src/public-api.test.ts packages/client/README.md apps/docs/content/docs/features/error-handling.mdx apps/docs/content/docs/clients/javascript/browser.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
  - Passed for the TypeScript files. The repo Biome config ignores Markdown
    and MDX, so keep using `docs:stale-check`, docs typecheck, and manual
    Markdown sanity reads for those files.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

Gate note: run docs generation/type gates serially. A parallel gate attempt
briefly produced an empty `apps/docs/.source/server.ts`, causing
`fumadocs-mdx:collections/server` to fail as "not a module"; rerunning
`bun --cwd apps/docs types:check` alone regenerated the module and passed.

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

Most recent feedback-addendum rerun:

- `git diff --check`
- Manual Markdown sanity read of the inserted addendum and surrounding
  evidence/log sections.

Most recent feedback-acceptance-matrix rerun:

- `git diff --check`
- Manual Markdown sanity read of the inserted matrix, current evidence, roadmap
  summary, and implementation log entries.

Most recent runtime-timeline rerun:

- `bun test packages/client/src/runtime-timeline.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/runtime-timeline.ts packages/client/src/runtime-timeline.test.ts packages/client/src/database.ts packages/client/src/index.ts packages/client/src/public-api.test.ts packages/client/README.md apps/docs/content/docs/operate/observability.mdx`
- `bun --cwd apps/docs types:check`
- `bun run docs:stale-check`
- `git diff --check`

Most recent support-bundle rerun:

- `bun test packages/client/src/support-bundle.test.ts packages/client/src/runtime-timeline.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/support-bundle.ts packages/client/src/support-bundle.test.ts packages/client/src/database.ts packages/client/src/index.ts packages/client/src/public-api.test.ts packages/client/README.md apps/docs/content/docs/operate/observability.mdx`
- `bun --cwd apps/docs types:check`
- `bun run docs:stale-check`
- `git diff --check`

Most recent sync rate-limit details rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/server/src/hono/__tests__/rate-limit.test.ts packages/server/src/hono/__tests__/sync-rate-limit-routing.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/server/src/hono/rate-limit.ts packages/server/src/hono/routes/context.ts packages/server/src/hono/__tests__/rate-limit.test.ts packages/server/src/hono/__tests__/sync-rate-limit-routing.test.ts apps/docs/content/docs/operate/observability.mdx rust/docs/ROADMAP.md rust/docs/work-packages/WP-50-syncular-dx-rough-edges.md`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

Most recent mutation-status rerun:

- `bun test packages/client/src/mutation-status.test.ts packages/client/src/public-api.test.ts`
- `bun --cwd packages/client tsgo`
- `bunx biome check packages/client/src/mutation-status.ts packages/client/src/mutation-status.test.ts packages/client/src/database.ts packages/client/src/index.ts packages/client/src/public-api.test.ts packages/client/README.md apps/docs/content/docs/clients/javascript/mutations.mdx apps/docs/content/docs/features/error-handling.mdx`
- `bun --cwd apps/docs types:check`
- `bun run docs:stale-check`
- `git diff --check`

Most recent browser-health failure-artifact rerun:

- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun test packages/testkit/src/failure-artifacts.test.ts packages/server/src/hono/__tests__/console-routes.test.ts -t "failure artifact|browser preview failure"`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/testkit tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/server tsgo`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bunx biome check packages/create-syncular-app/scripts/smoke.ts packages/testkit/src/failure-artifacts.ts packages/testkit/src/failure-artifacts.test.ts packages/server/src/hono/console/schemas.ts packages/server/src/hono/console/routes/shared.ts packages/server/src/hono/__tests__/console-routes.test.ts`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd packages/create-syncular-app smoke`
  - Passed built-preview asset checks, runtime asset checks, and the
    deterministic `browser-preview-failure.json` self-check with the new
    `browserHealth` probe section.
  - Skipped the real-browser CDP check because no Chrome/Chromium binary was
    available locally.
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun run docs:stale-check`
- `PATH="$PWD/.context/bun-1.3.9/bun-darwin-aarch64:$PATH" bun --cwd apps/docs types:check`
- `git diff --check`

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
    real browser. That CDP path now covers lifecycle pause/resume markers,
    Web Lock acquisition, browser-observed lifecycle and local-recovery Web
    Lock timeout/recovery, two-tab propagation, reload/reopen persistence, and
    same-profile browser-process restart persistence. The Checks workflow now
    enforces that path in a dedicated Chrome-provisioned starter job for
    starter-relevant PRs and all pushes; remaining work is to observe the
    hosted runner and decide whether release rehearsal should also require it.
14. Subscription readiness: first app-facing slice is done with the
    `@syncular/client/subscription-readiness` helper, generated app
    `subscriptionReadiness()` wrappers, and table helpers such as
    `taskSubscriptionReadiness()`. The helper projects diagnostic snapshots into
    redacted ready/waiting/action-required/missing/unknown status with stable
    issue codes for auth-required, revoked, rate-limited, schema, runtime,
    storage, offline, bootstrap-pending, and missing-subscription blockers.
    Generated wrappers inject the resolved generated subscriptions so app code
    does not pass subscription constants, the root `createSyncularDatabase`
    bundle stays under the budget guard, and the starter emits a hidden
    subscription-readiness marker for smoke/failure artifacts.

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
  `syncular doctor --json` now provides the narrow local umbrella over schema
  readiness plus optional/required ops readiness. Browser/CDP, framework,
  Console artifact ingestion, post-publish install, and publish dry-run checks
  stay in release rehearsal.
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
  React Native, Tauri, CRDT/Yjs, Console artifact ingestion, and post-publish
  package installation.
- Generated app clients should not invent campaign/project join helpers around
  `replaceAuthContext(...)` until the app contract has enough product semantics
  to define membership and token refresh safely. The root managed database
  method remains the public contract; app-specific join/create flows belong in
  app code, recipes, or testkit fixtures for now.
- `syncular schema check` remains the narrow deploy/CI readiness command.
  `syncular doctor` is deliberately narrower than release rehearsal: it
  orchestrates schema readiness plus optional/required ops readiness, and does
  not hide browser/CDP, framework, adapter import, Console artifact ingestion,
  package-install, or publish dry-run gates behind a local command that cannot
  prove them.

## Remaining Implementation Risks

- Browser deployment preflight: first helper slice is done for Worker/WASM
  assets, MIME/content types, cross-origin isolation option, OPFS/IndexedDB
  requirements, durable storage availability, fallback behavior, persistence
  grant status, quota budgets, BroadcastChannel, Web Locks, page visibility,
  `pagehide`, `beforeunload`, resume/shutdown signal availability,
  service-worker availability/control, controller state, redacted controller
  script path, and multi-tab mode. It now also reports a single support tier
  and persistence mode so apps can distinguish persistent offline support,
  development-only memory storage, unsupported deployments, and unproven
  checks. Apps can make
  missing tab coordination or page lifecycle resume signals fail the
  preflight. The starter now runs the helper before opening Syncular. The
  scaffold smoke checks the transformed preflight module,
  now builds and serves Vite preview, verifies built assets, and can execute
  the built page through Chrome/Chromium CDP. Checks now has a dedicated
  `starter-browser-preview` job that installs Chrome and requires this path on
  starter-relevant PRs and all pushes. Release rehearsal now runs the starter
  built-preview smoke by default and can require the Chrome/CDP path with
  `--require-starter-browser-preview`. The starter Chrome/CDP path now also
  fills browser origin storage in a fresh profile, applies Chrome's origin
  quota override, and reruns the public deployment preflight helper from the
  app so high quota-pressure warnings are proven from browser-reported usage
  and quota rather than only synthetic preflight fixtures. The same
  post-override CDP usage/quota facts now also feed the starter's public local
  recovery plan proof so `browser.storage_pressure_high` action mapping is
  covered by observed browser quota facts. Current hosted
  observation on
  2026-07-01: latest checked `main` Checks run `28459201533` at
  `origin/main` `7f0081b6` did not contain a `starter-browser-preview` job,
  and `git show origin/main:.github/workflows/checks.yml` also lacks the job,
  while this branch's `HEAD` `c7f32182` contains it. Remaining work is to
  observe the job after this branch is pushed/merged and then decide whether
  that strict release flag should be mandatory for every stable release.
- Adapter import side-effect isolation: the first root import graph smoke now
  proves root client/server imports do not statically reach optional Bun,
  Cloudflare, S3, Sentry, Neon, Tauri, React Native, or CRDT/Yjs subpaths.
  The same local check now dynamically imports the root client/server source
  entrypoints to catch top-level side effects that would break SSR-like build
  graphs before a subpath is actually used.
  The post-publish JavaScript install smoke now owns the first release-time
  optional subpath install/import matrix for Bun-friendly client/server
  subpaths and has an opt-in native sqlite matrix for `better-sqlite3` and
  `sqlite3`. The native-driver policy is now explicit: run that opt-in matrix
  on native-capable Node runners before stable releases or native sqlite
  adapter changes, but do not make platform-sensitive native module installs a
  default release blocker.
- Multi-tab and lifecycle behavior: first preflight slice is done for browser
  tab/lifecycle capabilities and opt-in required coordination checks. The
  first browser-page helper slice is also done:
  `installSyncularBrowserLifecycleResume(...)` coalesces visible-tab,
  restored-page, and online signals into the managed
  `resumeFromBackground()` catch-up path, can serialize that catch-up through
  optional Web Locks, reports hidden-tab `visibilitychange`, `pagehide`, and
  `beforeunload` pause/shutdown signals, and the starter installs it with a
  lifecycle-resume lock. The starter browser smoke now asserts the marker
  exists in production assets and, on Chrome-capable runners, dispatches
  persisted `pagehide`, verifies pause evidence, dispatches persisted
  `pageshow`, waits for a restored-page resume marker, dispatches `online`,
  waits for a second completed resume marker, dispatches `beforeunload`, and
  verifies shutdown-signal evidence. The first Chrome two-tab runtime proof is
  also in place: distinct generated-app tabs use distinct client ids/database
  files, both tabs dispatch `online` and must report the starter lifecycle Web
  Lock as acquired, one tab creates a task, and the second tab must observe it
  through the normal sync/realtime path. The CDP path now also performs a
  same-client reload/reopen after propagation and waits for the task to
  reappear after app startup, opens a duplicate tab with the same
  client/database and requires it to settle as either ready with the existing
  task or an explicit starter-open error while the original tab stays writable,
  then restarts Chrome with the same profile directory and waits for the task to
  survive a fresh browser process.
  The helper now also has an opt-in bounded Web Lock contention path:
  `lock.timeoutMs` aborts a stuck lock request and reports
  `browser.web_locks_timeout` with `lockState: "timed-out"`, and the
  Chrome/CDP starter path now holds the real browser lock, observes that
  timeout marker, releases the lock, and proves the next foreground resume can
  recover. The starter also exposes a hidden local-recovery proof marker, and
  the CDP smoke can hold the real browser local-recovery Web Lock, prove a
  non-destructive support-bundle recovery action times out, release the lock,
  and prove that the same action completes under the acquired lock. The helper
  and starter Chrome/CDP proof now also cover Page Lifecycle `freeze` and
  browser `resume` events through DOM-dispatched events, plus Chrome's
  `Page.setWebLifecycleState("frozen" | "active")` automation hook as BFCache
  suspension diagnostic evidence followed by app `visibilitychange` recovery.
  The Chrome/CDP path now also brings a throwaway browser target to the
  foreground before the synthetic lifecycle proof and requires the starter tab
  to report real browser `document.visibilityState="hidden"` plus
  `visibilitychange` pause evidence, then brings the starter tab back to the
  foreground and requires the normal visible-tab resume marker.
  The starter Chrome/CDP path now also includes a bounded generated
  write-pressure proof: four generated mutations run concurrently in one app
  tab, every row must pass local visibility, and the observer tab must receive
  each row through sync/realtime. The starter now also runs a browser-observed
  storage recovery action-mapping proof from a synthetic storage-warning
  preflight through the public generated app recovery APIs. The recovery plan
  is now runtime-capability-aware, so the core browser runtime proves
  persistent-storage request plus compaction and does not advertise
  blob-cache clearing without `blobs` support. The same-client duplicate-tab
  branch now also has a same-database writer proof: when Chrome can open the
  duplicate tab against the same client id/database, the smoke fires concurrent
  generated writes from both tabs and requires both rows to render in both
  same-client tabs plus the separate observer tab through sync/realtime; if the
  duplicate tab is rejected by browser storage locking, the smoke still requires
  an explicit starter-open error and proves the active tab remains writable.
  The branch now also adds a fresh-profile origin-storage
  eviction/rebootstrap proof: it writes a Cache API/localStorage sentinel,
  proves a generated task reached an observer tab through sync/realtime, closes
  the app targets, clears the app origin through Chrome
  `Storage.clearDataForOrigin`, reloads the same client id, requires the
  sentinel to be gone, and waits for the task to restore from server state.
  The branch now also adds a server-driven Clear-Site-Data storage
  eviction/rebootstrap proof path: the Vite dev/preview template exposes a
  smoke-only same-origin endpoint with `Clear-Site-Data: "storage"`, the
  non-browser scaffold smoke verifies the endpoint/header contract, and the
  Chrome path can request that endpoint, require IndexedDB/localStorage
  sentinel removal without using CDP storage clear, and reload the same client
  id from server state. The branch now also adds a same-origin IndexedDB
  deletion/rebootstrap proof path: the Vite dev/preview template exposes a
  smoke-only same-origin storage-admin page without app runtime side effects,
  the non-browser scaffold smoke verifies the page contract, and the Chrome
  path can delete IndexedDB databases through `indexedDB.deleteDatabase(...)`,
  require Cache API/localStorage sentinels to survive while the IndexedDB
  sentinel disappears, and reload the same client id from server state.
  The branch now also adds a PWA offline cache/reopen persistence proof path:
  the smoke-only service worker caches the built app shell, JS, worker, and
  WASM assets during a controlled online load, the Chrome path forces the page
  offline through CDP network emulation, reloads the same generated-app client
  id with sync startup held manual, and requires the locally inserted task to
  reappear from the persistent browser database under service-worker control.
  Remaining work is richer browser/host eviction and storage-failure
  execution beyond explicit CDP origin clear, Clear-Site-Data storage clear,
  same-origin IndexedDB deletion, PWA offline cache/reopen, same-database
  duplicate-tab writes, storage shutdown, and discarded-tab recovery, plus
  deeper recovery coordination for persistent browser databases beyond real
  target foreground/background activation, dispatched page lifecycle events,
  CDP lifecycle forcing, synthetic storage warning action mapping,
  browser-observed quota-pressure preflight/recovery mapping, quota-exhausted
  write rejection, and lock-serialized foreground resume/recovery actions.
  Local execution of the new browser branches still needs a Chrome-capable
  runner; this machine has no Chrome/Chromium binary.
- Local recovery controls: first plan/action slice is done for support bundles,
  local health repairs, failed outbox/blob retries, compaction, cache clear,
  and guarded sync-state reset, with a focused Hono/WASM proof for corrupted
  subscription state and orphaned verified roots. Sign-out cleanup is now an
  explicit opt-in action that refuses to appear while unresolved outbox work
  exists, then resets sync/bootstrap state, clears synced app rows, and clears
  cached blob bytes under confirmation. Revoked subscription scopes now map to
  confirmed affected-subscription rebootstrap actions. Unrecoverable bootstrap
  resource/integrity failures now map to targeted confirmed rebootstrap actions
  when the snapshot identifies errored subscription IDs. Destructive recovery
  actions now expose opt-in `browser.multi_tab_coordination_required` blockers
  when the app requires coordinated tabs and the browser preflight reports a
  weaker or unknown multi-tab mode. Destructive actions also carry `safety`
  metadata with data-loss consequences and observed outbox state; actions that
  can clear synced rows add `local.unsynced_outbox_work_present` with
  `recommendedAction: drainOutbox` while pending, sending, or failed outbox
  work exists. Storage preflight persistence and quota
  warnings now map to app-facing recovery actions: request persistent browser
  storage when the API is available, compact local storage, or confirmed blob
  cache clearing, with the original storage issue codes preserved on each
  action. The recovery executor itself can now
  serialize actions through optional Web Locks, report lock state, or fail
  closed when a required lock is unavailable; bounded lock timeouts now fail
  with a typed timeout error and tests prove a timed-out queued recovery action
  does not run later. The starter/browser-preview smoke now adds the first
  browser-observed recovery lock proof by timing out and then completing the
  non-destructive support-bundle recovery action under the real browser Web
  Locks API. The root lifecycle helper and starter Chrome/CDP proof now also
  cover Page Lifecycle `freeze` and browser `resume` events through
  DOM-dispatched events, plus Chrome `Page.setWebLifecycleState` frozen/active
  BFCache suspension diagnostic evidence followed by app `visibilitychange`
  recovery. The starter/browser-preview smoke also has a bounded same-client
  duplicate-tab open contention proof: the duplicate tab must either become
  ready with the existing task or report an explicit starter-open error, and the
  active tab must stay writable; when the duplicate same-database tab reaches
  ready, the smoke also fires concurrent generated writes from both
  same-client tabs and requires both rows in both tabs plus the separate
  observer. The same browser path now adds a generated write-pressure proof
  where four generated mutations run concurrently, each row reaches local
  visibility, and an observer tab receives every row through sync/realtime.
  The generated app browser smoke now also proves that a
  synthetic storage-warning deployment preflight produces and can run the
  expected request-persistence, compaction, and confirmed blob-cache clearing
  actions through public local recovery APIs. A fresh-profile Chrome/CDP proof
  now also fills origin storage, applies a browser quota override, requires
  the public app preflight marker to expose `browser.storage_pressure_high`,
  high usage ratio, quota bytes, usage bytes, available bytes, and recommended
  storage actions from live browser quota facts, then passes those same
  observed quota facts into the storage-recovery proof and requires the public
  recovery plan to map them to request-persistence and compaction actions.
  A fresh-profile Chrome/CDP proof now also writes a Cache API/localStorage
  sentinel, proves a generated task reached an observer through sync/realtime,
  clears the app origin through Chrome `Storage.clearDataForOrigin`, reloads
  the same client id, requires the sentinel to be gone, and waits for the task
  to restore from server state. The starter now also has a sync-held shutdown
  replay proof for persistent browser databases: it opens a dedicated client
  with sync startup deliberately held, creates a generated task, waits for
  local visibility and rendered local text, stops Chrome, restarts the same
  profile and client id with sync still held to prove the task restored
  from local browser storage, then reloads with normal sync startup and waits
  for a separate observer client to receive the replay through sync/realtime.
  The current slice adds a renderer-crash replay proof for the same sync-held
  generated-write flow: it opens a dedicated client with sync startup held,
  writes a generated task, waits for local visibility and rendered text, sends
  Chrome CDP `Page.crash` through a short bounded command, verifies the
  renderer is unavailable, reopens the same profile/client id with sync still
  held to prove the task restored from persistent browser storage after abrupt
  renderer loss, then resumes normal sync and waits for a separate observer
  client to receive the replay through sync/realtime. Hosted Checks run
  `28554593391` on commit `84f3bbf1` confirmed this branch in Chrome. The
  current slice adds a targeted sync-transport replay proof behind a smoke-only
  server failpoint: the smoke blocks only one generated-app client's `/sync`
  POSTs, creates a generated task, requires local visibility and rendered text,
  waits for the server failpoint to count a blocked push from that exact
  client, clears the failpoint, dispatches `online`, awaits the public
  `resumeFromBackground()` recovery path until it reports a pushed commit, and
  requires a separate observer client to receive the replay through
  sync/realtime. Hosted Checks run `28555819882` on commit `855c6749` passed
  the full matrix, including `starter-browser-preview`, confirming this branch
  in Chrome.
  The current slice adds an explicit storage-shutdown replay proof for the
  actual generated app client. The hidden template proof closes the client,
  requires `getStatus()` to report a closed connection and closed lifecycle
  phase, then requires a post-close generated mutation to reject with
  `worker.closed`. The browser smoke writes a generated task with sync held,
  runs the shutdown proof, reopens the same profile/client id with sync still
  held to prove the task restored from persistent browser storage, then reloads
  with normal sync startup and waits for a separate observer client to receive
  the replay through sync/realtime. Hosted Checks run `28556559139` on commit
  `c4054d92` passed the full matrix, including `starter-browser-preview`,
  confirming this branch in Chrome.
  The current slice adds an explicit discarded-tab recovery proof for the
  generated app. The smoke writes a generated task with sync held, proves local
  visibility plus rendered text, uses Chrome's internal `chrome://discards`
  provider to discard the hidden starter target, activates the real target to
  force restoration, proves the task still renders from persistent browser
  storage, then resumes normal sync and waits for a separate observer client to
  receive the replay through sync/realtime. Hosted Checks run `28558449113` on
  commit `49d1b4d4` passed the full matrix, including
  `starter-browser-preview`, confirming this branch in Chrome.
  Remaining work is richer browser/host proof: host-driven eviction beyond
  explicit CDP origin clear and Clear-Site-Data storage clear, and lower-level
  storage contention/failure behavior beyond the already-covered duplicate-tab
  generated writes, renderer crash, explicit client shutdown close, and
  discarded-tab recovery branches, plus deeper persistent database recovery
  coordination.
- Browser and bundler matrix: prove durable persistence, loud unsupported
  failures, SSR-safe root imports, and optional-subpath isolation across the
  environments users actually build with: Vite, Next/SSR, Bun, Node,
  Cloudflare, Chrome, Safari, Firefox, private mode, WebViews, and PWAs.
  The public support policy matrix now names the intended browser/host
  decisions: Chrome/Chromium secure pages are supported only after preflight
  evidence, Firefox/Safari/WebView/PWA remain preflight-gated `unknown`
  contexts, private/incognito is development/test only, and SSR/build is
  unsupported for database open. The starter now evaluates observed preflight
  evidence against the Chrome/Chromium support policy and exports the result
  into its built-preview marker and browser failure artifact, and the context
  hint helper now lets starter/browser artifacts switch to `pwa` for
  service-worker controlled pages or `private-browsing` for ephemeral storage
  without guessing Safari/Firefox from a user agent. The matrix is represented
  in smoke evidence instead of docs alone. This branch adds the first real
  Chrome service-worker-controlled PWA classification proof: the starter smoke
  writes a temporary pass-through service worker into the built preview, opens a
  fresh Chrome profile, registers the worker, reloads under controller, and
  requires the app's own deployment-preflight/support-policy markers to report
  `pwa`, `preflight-required`/`warning`, activated controller state, and the
  redacted controller script path. That proves detection and artifact routing
  from real browser state without claiming PWA support is production-ready.
  It also includes a first real Chrome incognito branch with explicit starter
  memory storage, requiring the same public markers to report
  `ephemeral-development`/`ephemeral`, `private-browsing`,
  `development-only`/`met`, and
  `browser_support.development_only_context`. This proves the
  private/development policy path through real Chrome plus the starter runtime
  without claiming durable private-mode persistence across browsers.
  Root source imports are now guarded by static graph checks, dynamic import
  checks, a Next 16 production-build smoke that imports the client/server
  roots from source and verifies the WASM glue dynamic import path is
  warning-clean under webpack, and a Vite 8 browser production-build smoke
  that follows browser-conditioned package exports for the client root and
  serves the built HTML/JavaScript through Vite preview, self-checks the Vite
  browser-runtime failure artifact shape, and has an optional Chrome/CDP
  execution path that observes the browser root import marker.
  The Cloudflare smoke now declares `SYNC_DO`, D1, and R2 bindings, aliases
  the Syncular server/core subpaths to workspace source, bundles
  `@syncular/server/cloudflare`, `@syncular/server/d1`,
  `@syncular/server/sqlite`, `@syncular/server/hono`, and the R2 adapter
  through Wrangler dry-run, and starts the generated Worker with local
  `wrangler dev`, proving a real request reaches the
  `createSyncWorkerWithDO(...)` route through those bindings, runs
  `ensureSyncSchema(...)` against D1, verifies the `sync_commits` table,
  performs D1 app-table insert/select/delete, pushes and pulls through the
  Syncular HTTP route with binary sync-pack plus decoded snapshot chunk,
  rejects unauthenticated sync, proves cross-actor pulls become empty revoked
  subscriptions, rejects a forbidden-scope write, rejects missing-scope and
  wrong-scope snapshot chunk access, opens real Syncular realtime reader/writer
  WebSockets over the Durable Object upgrade bridge, pushes through the writer
  socket, decodes the reader's binary sync-pack delta for the D1 row, drives
  an R2-backed blob route upload/complete/download flow whose download URL is
  authorized only after scoped D1 app rows reference the completed blob via
  exact `hashColumn` lookup, including a second partition-column file-version
  style table, rejects unauthenticated upload initiation, invalid upload-init
  bodies, invalid direct-upload tokens, forbidden upload completion,
  missing-reference owner, wrong-partition, revoked-reference, and
  deleted-reference download URL attempts, and forbidden blob download URLs
  with stable access details, and echoes through a DO-backed WebSocket route.
  The same local runtime proof now self-checks a bounded Cloudflare failure
  artifact so failed DO/D1/R2/WebSocket runs can leave route, exit,
  recent-output context, and safe R2 blob route timing/byte metrics instead of
  logs alone.
  Release rehearsal now runs those framework proofs by default before publish
  dry-runs and can require the Vite browser execution path on Chrome-capable
  runners. Remaining matrix work is deeper browser/framework execution beyond
  the policy matrix and existing proofs, especially richer
  multi-client/browser Syncular realtime over Durable Object WebSocket,
  Safari, Firefox, private mode, WebViews, installed-PWA cache/update
  semantics beyond the offline reopen proof, and installed-PWA update skew.
- Runtime timeline and support bundles: first timeline slice is done for
  ordered, redacted phase events over runtime, lifecycle, bootstrap, sync,
  auth, realtime, storage, local-apply, outbox, conflict, and blob state.
  First composed support-bundle slice is also done for browser health, runtime
  timeline, schema readiness, optional deployment preflight, local support
  data, section errors, package/runtime versions, request/sync/trace ids,
  subscription cursors, and diagnostic redaction policy. The starter now emits
  a compact redacted support-bundle artifact marker, and the scaffold smoke
  asserts the production build contains it plus runtime-timing markers; the
  Chrome/CDP smoke waits for those markers when a browser is available and now
  also forces a hidden support-bundle marker failure after the happy path to
  verify a same-schema live-browser
  `browser-preview-failure.support-bundle.json` artifact. That browser path
  writes a redacted `browser-preview-failure.json` artifact on readiness
  timeout or page-reported health/support-bundle failures, the normal scaffold
  smoke self-checks the artifact shape and safe smoke metrics without Chrome,
  and the Checks job uploads `browser-preview-*.json` on failure from a
  predictable smoke work directory. Console/Fleet can now ingest that starter
  artifact through
  `POST /console/client-diagnostics/browser-preview-failure`, normalizing it
  into a redacted `browser.preview_failure` client diagnostic record without
  storing the artifact page text excerpt, and preserving the browser
  support-policy evaluation alongside deployment-preflight and support-bundle
  summaries. The Console client detail runtime panel now renders those quick
  summaries as asset, browser support-policy, deployment-preflight,
  service-worker, quota, and lifecycle/Web Lock cards so operators do not need
  raw JSON for the first diagnosis. Cloudflare runtime artifacts now feed
  Console/Fleet through
  `POST /console/client-diagnostics/cloudflare-runtime-failure`, preserving
  route, exit, bounded output, and safe blob timing/byte metrics as
  `cloudflare.runtime_failure` diagnostics, and the Console client detail
  runtime panel renders route/exit/output plus R2 blob byte/timing cards from
  those stored quick fields. Release rehearsal now runs focused Console
  ingestion tests for both failure artifact families by default, while
  `doctor` stays limited to local schema/ops readiness. Hosted Checks run
  `28529052910` proved the new support-bundle failure artifact is uploaded and
  contains live redacted browser probe data, then failed only because the
  verifier required a `met` support-policy verdict instead of accepting the
  legitimate hosted Chrome `warning` verdict for unknown persistence evidence.
  Hosted Checks run `28529443648` passed after that verifier correction,
  closing the live hosted support-bundle failure-artifact proof for this slice.
  Remaining work is to decide whether future hosted artifact uploads need
  deeper Console/Fleet orchestration.
- Outbox and conflict UX: first app-facing status slice is done for
  queued/sending/failed/acked outbox counts, unresolved/resolved conflicts,
  conflict detail rows, last mutation-related errors, and recommended actions.
  Receipt-level correlation is also done for generated mutation receipts using
  redacted local support bundle outbox commit summaries plus conflict records;
  summaries now include `outboxId` so command timelines can prove the local
  durable outbox row, and acked summaries include `ackedCommitSeq` so command
  timelines can prove server commit sequence from redacted local evidence.
  First command-timeline artifacts are done for receipt state, redacted runtime
  events, local-visibility evidence captured from `awaitLocalVisibility(...)`,
  client-generated request id evidence that matches Hono server request event
  rows, explicit missing-evidence markers, and `summary.proof` booleans for
  the outbox/request/sync-attempt/server-commit/realtime-cursor/pull-reason/
  local-apply/local-visibility chain.
- Upgrade and production ops runbooks: turn schema/package/protocol upgrade
  order, backup/restore, blob-store consistency, rate limits, credential
  rotation, local database recovery, and rollback into copyable operator docs.
  Upgrade/rollback docs are done, and production-ops depth now includes
  restore drills, blob-store consistency checks, rate-limit tuning, and
  credential rotation cadence. The first narrow automation slice is also done:
  `syncular ops check --json` validates a production evidence file for schema
  readiness, restore drill freshness, external blob consistency, credential
  rotation ownership/cadence, rate-limit review status, Console log/event
  retention, request-payload snapshot policy, and offline support-window
  sizing. Console Ops now ingests the same JSON, records a redacted
  `ops_readiness` operation audit event, exposes the latest report over the
  Console API, renders the latest production-readiness panel, and aggregates
  readiness reads across selected Console gateway instances while deploy writes
  remain explicitly single-instance. The panel now also lists per-instance
  redacted issue drilldown, retained readiness trend buckets, issue-code
  grouping, and readiness audit history across the selected gateway scope.
  `GET /console/ops/readiness/trends` now provides longer-range readiness
  visualization beyond the operation-audit page window, including gateway
  aggregation, issue trends, buckets, matched/scanned counts, and truncation
  signaling. `syncular doctor --json` now composes schema readiness plus
  optional/required ops readiness for local/deploy preflight use, and release
  rehearsal now runs the same ops readiness check when `syncular.ops.json` or
  `--ops-config` is present. Stable release rehearsals can require it with
  `--require-ops-readiness`; broader browser/CDP, framework, Console artifact
  ingestion, package-install, and publish dry-run orchestration also stay in
  release rehearsal.
- Performance and failure artifacts: keep package/WASM size, bootstrap
  latency, local visibility delay, sync apply, realtime reconnect, blob fetch
  latency, storage/quota pressure, and redacted E2E failure artifacts
  measurable. The starter browser failure artifact now carries safe
  preview/asset timing and byte metrics plus starter runtime timings for
  database open, browser health refresh, schema readiness, support-bundle
  export, bootstrap readiness, realtime connection, and generated-mutation
  local visibility when the browser probe can run. The starter also emits
  deployment-preflight storage/quota facts so browser failures can separate
  quota, persistence, and support-tier problems from sync lifecycle failures.
  Browser preview artifacts now also carry the expected-vs-observed browser
  support-policy status, reason codes, required evidence, known risks, and
  next steps for the starter's Chrome/Chromium context, which lets
  Console/Fleet distinguish "preflight incomplete" from "support policy not
  met" and surface the missing evidence without user-agent sniffing or prose
  parsing. Console now promotes the compact policy verdict, first reason,
  required evidence, known risk, and next step into quick fields and client
  detail cards for first-pass triage.
  The support-bundle marker now adds redacted runtime timeline counts for
  sync, realtime, local-apply, blob, cursors, request ids, sync-attempt ids,
  and latest phase codes, and refreshes on row changes. The Chrome/CDP path
  waits for the local-visibility marker before proving two-tab propagation.
  The Cloudflare/R2 local runtime artifact now captures direct blob route
  upload/download timings and byte counts for both owner-hash and partitioned
  reference flows. Starter browser artifacts can now feed Console/Fleet as
  redacted `browser.preview_failure` diagnostic records, and Cloudflare
  runtime artifacts can now feed Console/Fleet as redacted
  `cloudflare.runtime_failure` diagnostic records. Console client detail views
  now surface both artifact families from the stored quick fields instead of
  requiring raw JSON inspection for the first triage pass. Release rehearsal
  now owns the focused Console ingestion proof for both artifact families. The
  hosted starter browser-preview job exposed that the extra release
  `wasm-opt --all-features` pass emitted typed function references (`(ref N)`)
  that Bun could compile but hosted Chrome rejected during runtime
  initialization with `WebAssembly.instantiate(): unknown type form: 0 @+202`;
  release WASM packaging now uses explicit browser-safe optimizer feature flags
  instead. The follow-up hosted run then advanced to wasm-bindgen startup and
  failed with `WebAssembly.Table.grow(): failed to grow table by 4`; CI had
  installed Ubuntu's Binaryen 108 package, matching the known old wasm-opt
  externref table bug. Shared setup now installs official Binaryen 130 and the
  release build script rejects `wasm-opt` versions older than 123 before
  producing package artifacts. Hosted run `28517563893` confirmed the Binaryen
  pin (`wasm-opt version 130`) and advanced through app startup/realtime
  connect, but the `starter-browser-preview` smoke then hung until GitHub
  canceled the 20-minute job before the upload-artifact step could run. The
  smoke harness now binds Chrome DevTools to `127.0.0.1`, normalizes
  `localhost` WebSocket URLs to `127.0.0.1`, adds explicit CDP connect/command
  timeouts, logs each real-browser phase, and writes a bounded
  `real-browser-smoke-timeout`/`real-browser-smoke-error` artifact if the CDP
  path stalls. Hosted run `28519417487` then confirmed every non-browser job
  green and confirmed the artifact upload path works; the first
  `Runtime.evaluate` readiness probe timed out after first-page sync/realtime
  connect. The harness now decodes non-string Chrome DevTools WebSocket frames
  (`ArrayBuffer`, typed-array, Blob-like `text()`/`arrayBuffer()` payloads),
  extends CDP command timeout to 30s, and records `readiness-probe-error` when
  the first page probe cannot be read. Hosted run `28520032328` then showed
  the probe could read an initial empty page before timing out during the app
  navigation window, so the harness now creates Chrome targets at
  `about:blank`, attaches/enables CDP first, navigates via `Page.navigate`,
  waits for `Page.loadEventFired`, and only then starts readiness probes.
  Hosted run `28520501695` then showed the built page and static markers were
  present, server-side sync/realtime had started, and every non-browser job was
  green, but the UI stayed on "Opening local database..." until the next CDP
  readiness probe timed out. Hosted run `28522047752` confirmed the remaining
  outstanding CI scope is exactly `starter-browser-preview`: every other job in
  the hosted Checks matrix passed. Its Chrome log reached
  `storage.open.completed` and `auth.setAuthHeaders.completed`, then the next
  `Runtime.evaluate` readiness probe timed out before the ready render
  committed. The starter now opens the durable local database, installs the app
  schema, renders the local-first UI, then registers default subscriptions and
  starts sync in a post-mount frame-yielded background effect instead of
  blocking first paint on bootstrap/network/realtime work. It also records a
  hidden `starterOpen` phase/diagnostic marker, writes early phase changes
  directly to the marker before React can be starved, and mirrors
  `[syncular-starter]` diagnostics into the Chrome/CDP log. Hosted run
  `28522684015` then proved the app reaches `open ready` quickly and only
  wedges before the post-mount `subscriptions` phase, so the starter now gates
  the hook-heavy `TaskPane` behind a lightweight local-DB-ready shell until the
  parent app effect has installed subscriptions and started sync. Hosted run
  `28523189917` then reached `open subscriptions`, `open sync`,
  `sync.syncOnce.completed`, `realtime.startRealtime.completed`, and
  `sync.realtime.connect` before the next CDP readiness probe timed out. The
  starter task list now avoids the live-query registration path during browser
  preview startup: it runs a plain query and refetches on `rowsChanged`, keeping
  the starter's browser proof on the core generated client/sync path while a
  later dedicated test can isolate live-query behavior. Hosted run
  `28523649113` then reached `open taskpane` and `taskpane mounted`, proving the
  remaining hang was after app open, subscription install, sync, realtime, and
  first task-pane mount. The starter now coalesces task-pane diagnostic
  refreshes, yields a browser frame between health, schema-readiness,
  deployment-preflight, and support-bundle collection, records hidden
  `diagnostics-*` phases for Chrome/CDP artifacts, and omits the worker-local
  support-bundle section from the browser-preview bundle while preserving four
  redacted support sections. Hosted run `28524549340` confirmed the old
  DevTools timeout is gone and the page repeatedly reaches `diagnostics-ready`,
  then failed while writing a failure artifact because `onResumeComplete`
  replaced the lifecycle marker state without preserving pause fields, making
  `data-syncular-lifecycle-pause-count` serialize as non-numeric. The starter
  now preserves the pause fields on resume completion and keeps heavyweight
  diagnostics off `lifecycleChanged` so support-bundle collection does not loop
  on diagnostics that themselves emit lifecycle updates. Hosted run
  `28524989381` then reached ready UI and `diagnostics-ready`, but failed the
  `online` lifecycle resume proof with `lifecycle-resume-errors`; the failure
  artifact showed `resumeFromBackground()` throwing
  `recursive use of an object detected which would lead to unsafe aliasing in
  rust` while auth/realtime/sync and diagnostic worker requests could overlap
  the same Rust/WASM client. The browser worker entrypoint now serializes
  non-cancel app requests through a shared operation queue, and realtime
  websocket recovery uses the same queue before running `syncPull()`,
  binary-sync-pack apply, or live-query drain calls. Local client typecheck,
  full client tests (`289` tests), focused worker queue/realtime/lifecycle
  tests, focused Biome, diff check, `create-syncular-app` smoke, repo
  typecheck, repo lint, and root tests (`1208` tests) pass with Bun 1.3.9.
  Hosted run `28525933895` then confirmed the Rust aliasing failure is fixed and
  the smoke now advances through lifecycle, diagnostics, and two-tab
  propagation, but fails the local-visibility proof with `TypeError`. The
  visible task row is already rendered, so the failure is in the proof query:
  `awaitLocalVisibility(...)` passed raw Kysely while the starter uses the same
  destructured `({ selectFrom }) => ...` shape as React live-query examples;
  detached Kysely methods lose their receiver in the browser build. The local
  visibility helper now evaluates callbacks against a bound Kysely proxy,
  preserving direct `db.selectFrom(...)` callers and supporting destructured
  methods. Focused local-visibility tests, client typecheck, full client tests
  (`290` tests), Biome, repo typecheck, repo lint, knip, `create-syncular-app`
  smoke, diff check, and root tests (`1209` tests) pass with Bun 1.3.9; Chrome
  is not installed locally, so the hosted artifact remains the authority for the
  required real-browser path. Hosted Checks run `28526881709` on commit
  `656b5275` passed the full matrix, including `starter-browser-preview`,
  confirming the local-visibility proof, reload persistence, browser process
  restart persistence, and all Rust/native packaging lanes are green. Hosted
  Checks run `28534746069` on commit `316955f9` passed the full matrix,
  including `starter-browser-preview`, confirming the bounded same-client
  duplicate-tab open contention proof between reload/reopen and browser-process
  restart persistence. Hosted Checks run `28538374326` on commit `89616b7f`
  passed the full matrix after the core-runtime blob capability fix, confirming
  the storage recovery action mapping proof in hosted Chrome. This slice now
  extends the same-client duplicate-tab branch so a ready duplicate tab must
  survive concurrent generated writes from both same-database tabs and propagate
  both rows to a separate observer; local `create-syncular-app` typecheck,
  focused Biome, non-Chrome scaffold smoke, docs stale check, and diff check
  passed. Hosted Checks run `28538884038` on commit `8fd1c74d` then passed the
  full matrix, including `starter-browser-preview`, confirming the same-database
  duplicate-tab writer proof in hosted Chrome.
- 2026-07-01: Added the first real-browser service-worker-controlled PWA
  classification branch to the starter smoke. The build smoke now writes a
  temporary pass-through service worker into the starter `dist`, then the
  Chrome/CDP path opens a fresh profile, registers that worker, reloads under
  controller, and requires the starter's own hidden markers to report
  `deploymentPreflight.serviceWorkerControlled=true`, activated controller
  state, controller script path `/__syncular-smoke-pwa-sw.js`, support-policy
  context `pwa`, policy `preflight-required`, status `warning`, and
  `browser_support.target_evidence_required`. This moves PWA/cache-skew
  classification from helper-only coverage into hosted-browser evidence while
  preserving the product stance that PWA remains target-evidence-gated, not
  automatically supported. Local `create-syncular-app` typecheck, focused
  Biome, non-Chrome scaffold smoke, docs stale check, and diff check passed;
  hosted Checks run `28539807017` on commit `23bd4061` then passed the full
  matrix, including `starter-browser-preview`. The Chrome job log reached
  `real-browser smoke: proving service-worker-controlled PWA policy` and then
  `real-browser built-preview preflight smoke passed`, confirming the new
  service-worker-controlled PWA branch in hosted Chrome.
- 2026-07-01: Added a real Chrome incognito memory-storage classification
  branch to the starter smoke. The starter now has an explicit
  `?syncularStorage=memory` smoke mode that keeps the default generated app on
  IndexedDB, but lets the browser support policy prove the private/development
  path from real app markers. The Chrome/CDP branch opens a fresh incognito
  window, loads the starter with memory storage, and requires deployment
  preflight to report `ephemeral-development`/`ephemeral` and browser support
  policy to report `private-browsing`, `development-only`, `met`, and
  `browser_support.development_only_context`. This verifies the support-matrix
  classification without pretending incognito provides durable offline
  persistence. Local `create-syncular-app` typecheck, focused Biome, and
  non-Chrome scaffold smoke passed; hosted Checks run `28540712560` on commit
  `4028723a` then passed the full matrix, including `starter-browser-preview`.
  The Chrome job log reached `real-browser smoke: proving incognito
  memory-storage policy` and then `real-browser built-preview preflight smoke
  passed`, confirming the incognito memory-storage branch in hosted Chrome.
- 2026-07-01: Added a real Chrome quota-pressure preflight proof to the
  starter smoke. The Chrome/CDP branch opens a fresh profile, loads the
  generated app, fills the app origin through the browser Cache API, applies
  Chrome's `Storage.overrideQuotaForOrigin` to make the reported usage ratio
  high, dispatches a starter proof event carrying the post-override CDP
  usage/quota facts, and requires the public
  `getSyncularBrowserDeploymentPreflight(...)` marker to classify those facts
  as `browser.storage_pressure_high`, high quota pressure,
  usage/quota/available byte facts, and storage recommended actions. Hosted
  Checks run `28541786236` showed that Chrome may expose usage before the CDP
  quota override while returning unknown quota facts through the page's later
  `navigator.storage.estimate()` call, so the proof now keeps the
  browser-observed CDP evidence explicit instead of assuming the page estimate
  API stays transparent after override. This turns quota-pressure
  classification into browser-observed evidence while leaving true
  quota-exhausted writes, eviction, and storage-shutdown behavior as remaining
  matrix work. Local `create-syncular-app` typecheck, focused Biome,
  non-Chrome scaffold smoke, smoke-script typecheck, and diff check passed;
  hosted Checks run `28542315687` on `8d2cc113` passed the full matrix,
  including `starter-browser-preview`, proving the fixed quota-pressure branch
  in hosted Chrome.
- 2026-07-01: Extended the starter's storage-recovery proof so the Chrome/CDP
  quota-pressure branch reuses the same post-override browser usage/quota
  facts to build the public deployment preflight passed into
  `client.localRecoveryPlan(...)`. The hidden storage-recovery marker and
  browser failure artifact now preserve source, issue codes, quota pressure,
  quota/usage/available bytes, and usage ratio, and the Chrome branch requires
  `source=browser-observed`, `browser.storage_pressure_high`, high usage ratio,
  and the expected request-persistence plus compaction actions. This moves the
  recovery action mapping beyond synthetic storage-warning fixtures while
  keeping actual quota-exhausted app writes and eviction behavior open. Local
  `create-syncular-app` typecheck, focused Biome, non-Chrome scaffold smoke,
  smoke-script typecheck, docs stale check, and diff check passed; hosted
  Checks run `28543241591` on `37cc4561` passed the full matrix, including
  `starter-browser-preview`. The Chrome job log reached
  `real-browser smoke: proving browser-observed quota recovery actions` and
  then `real-browser built-preview preflight smoke passed`, confirming the new
  observed-quota recovery mapping branch in hosted Chrome.
- 2026-07-01: Added a bounded quota-exhausted generated write proof to the
  starter Chrome/CDP branch. After the real browser quota-pressure setup and
  observed recovery action mapping, the smoke now dispatches a generated
  mutation whose row id is larger than the remaining CDP-reported origin quota
  budget, treats the rejected generated write as the expected proof outcome,
  and records attempted bytes, quota/usage/available bytes, usage ratio,
  write-failed state, duration, and runtime error text/code in the hidden
  starter marker plus `browser-preview-failure.json`. Unexpected success is a
  proof failure with `browser.quota_exhaustion_write_succeeded`, keeping the
  normal generated write-pressure proof as the happy path. Local
  `create-syncular-app` typecheck, smoke-script typecheck, focused Biome, and
  non-Chrome scaffold smoke passed; hosted Checks run `28544353197` on
  `4a0404cc` passed the full matrix, including `starter-browser-preview`. The
  Chrome job log reached `real-browser smoke: proving quota-exhausted generated
  write` and then `real-browser built-preview preflight smoke passed`,
  confirming the quota-exhausted generated write branch in hosted Chrome.
- 2026-07-01: Added a browser-observable command-timeline proof to the
  starter generated task path. After a generated mutation receipt is captured,
  the starter awaits generated `awaitTaskVisibility(...)` with `onEvidence`,
  calls `client.commandTimeline(...)`, and records the proof booleans,
  missing-evidence list, command state, client commit id, local visibility
  trigger/state, and timing in a hidden marker plus
  `browser-preview-failure.json`. The browser smoke now waits for local outbox
  persistence, local-apply evidence, and local-visibility evidence without
  pretending the starter UI has proven every server/realtime proof link. Local
  `create-syncular-app` typecheck, smoke-script typecheck, focused Biome, and
  non-Chrome scaffold smoke passed; hosted Checks run `28545477587` on commit
  `479912a9` passed the full matrix, including `starter-browser-preview`. The
  Chrome job log reached `real-browser smoke: proving two-tab propagation`,
  `real-browser smoke: proving generated write pressure`, and then
  `real-browser built-preview preflight smoke passed`; because the generated
  task path now requires the command-timeline marker before that pass marker,
  this confirms the command-timeline proof gate in hosted Chrome.
- 2026-07-01: Final-tip hosted Checks run `28545829979` on docs commit
  `f217acb4` confirmed `starter-browser-preview` again, but exposed a
  pre-existing `rust-native` command-history flake: rapid undo/redo/hard-delete
  commands could share millisecond timestamps, and
  `latest_command_history(Done)` used random command UUIDs as the final
  tie-breaker. The Diesel SQLite store now orders tied command-history rows by
  SQLite insertion order (`rowid`) instead, and `store_backends.rs` forces a
  same-timestamp/lexicographically inverted-id regression. Local
  `cargo test --manifest-path rust/Cargo.toml --workspace`,
  `cargo check --manifest-path rust/Cargo.toml -p syncular-client
  --no-default-features --features native,crdt-yjs`, the new focused
  regression, full `syncular-todo-app-example --lib`, and a 30-run stress loop
  of the previously flaky command-history test passed. Hosted Checks run
  `28546327052` on commit `09f94e67` then passed the full matrix, including
  `rust-native` and `starter-browser-preview`.
- 2026-07-01: Added the browser-health lifecycle operation projection slice.
  `getSyncularBrowserHealth(...)` now returns lifecycle stage, recovery owner,
  blocked-operation count, and fixed operation availability for local reads,
  generated mutations, local-visibility waits, explicit sync, auth replacement,
  resume, support-bundle export, and destructive local recovery. This makes
  UI/support recovery ownership visible without a second diagnostics
  vocabulary. The starter health marker now includes the projection as data
  attributes. Local gates with Bun `1.3.9` passed:
  `bun test packages/client/src/browser-health.test.ts`,
  `bun --cwd packages/client tsgo`,
  `bun --cwd packages/create-syncular-app tsgo`,
  `bun run docs:stale-check`, `bun --cwd apps/docs types:check`, focused
  Biome check, `bun --cwd packages/create-syncular-app smoke`, and
  `git diff --check`. Chrome was not installed locally, so the starter smoke
  used the non-Chrome path; hosted browser proof remains a follow-up if this
  marker becomes a required browser artifact assertion.
- 2026-07-01: Promoted the browser-health lifecycle projection into the
  starter browser-preview failure artifact contract. Built-preview asset
  checks now require the browser-health marker strings, the failure probe now
  carries `browserHealth` status, lifecycle stage, recovery owner,
  blocked-operation count, and generated-mutation/local-visibility/sync-now
  availability, `@syncular/testkit` validates the section, and Console/Fleet
  ingestion preserves the same fields in diagnostic details plus compact
  transport stats. Local gates with Bun `1.3.9` passed:
  `bun test packages/testkit/src/failure-artifacts.test.ts packages/server/src/hono/__tests__/console-routes.test.ts -t "failure artifact|browser preview failure"`,
  `bun --cwd packages/create-syncular-app tsgo`,
  `bun --cwd packages/testkit tsgo`, `bun --cwd packages/server tsgo`,
  focused Biome check, `bun --cwd packages/create-syncular-app smoke`,
  `bun run docs:stale-check`, `bun --cwd apps/docs types:check`, and
  `git diff --check`. Chrome was not installed locally, so hosted Checks should
  remain the real-browser proof for the marker in built Chrome artifacts.
- 2026-07-01: Added destructive local recovery safety metadata. Every
  destructive action now exposes `action.safety.dataLossConsequences` plus
  `action.safety.outbox`, row-clearing actions add
  `local.unsynced_outbox_work_present` blockers with `drainOutbox` guidance
  while pending/sending/failed outbox work exists, and blob-cache clearing
  remains destructive but is not blocked by unrelated synced-row outbox work.
  The starter storage-recovery marker and browser-preview failure artifact
  shape now carry destructive safety counts, data-loss consequence counts, and
  outbox safety status when storage recovery actions are proven through public
  APIs. Local gates with Bun `1.3.9` passed:
  `bun test packages/client/src/local-recovery.test.ts`,
  `bun --cwd packages/client tsgo`,
  `bun --cwd packages/create-syncular-app tsgo`,
  `bun --cwd packages/create-syncular-app smoke`,
  `bunx biome check` for touched TypeScript and docs files,
  `bun run docs:stale-check`, and `bun --cwd apps/docs types:check`. Chrome
  was not installed locally, so the real-browser marker proof remains hosted.
- 2026-07-02: Added a real browser target activation lifecycle proof to the
  starter Chrome/CDP branch. Before the existing synthetic lifecycle proof
  overrides `document.visibilityState`, the smoke opens a throwaway Chrome
  target, brings it to the foreground, requires the starter tab's real
  `document.visibilityState` to become `hidden`, waits for the public
  lifecycle pause marker to record `visibilitychange` plus hidden visibility,
  then brings the starter tab back to foreground and requires the normal
  `visibilitychange` resume marker. Local gates with Bun `1.3.9` passed:
  `bun --cwd packages/create-syncular-app tsgo`,
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts`,
  `bun --cwd packages/create-syncular-app smoke`,
  `bun run docs:stale-check`, and `git diff --check`. Chrome was not
  installed locally; hosted Checks run `28551532309` on commit `8220c90f`
  passed the full matrix, including `starter-browser-preview`, confirming the
  target activation branch in Chrome.
- 2026-07-02: Added a fresh-profile browser origin-storage
  eviction/rebootstrap proof to the starter Chrome/CDP branch. The smoke opens
  the generated app on a dedicated client id, writes a Cache API/localStorage
  sentinel, creates a generated task, proves the task reached a separate
  observer tab through sync/realtime, closes the app targets, clears the app
  origin through Chrome `Storage.clearDataForOrigin`, reloads the same client
  id, requires the sentinel to be absent, and waits for the task to restore
  from server state. Local gates with Bun `1.3.9` passed:
  `bun --cwd packages/create-syncular-app tsgo`,
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts`, and
  `bun --cwd packages/create-syncular-app smoke`. Chrome was not installed
  locally; hosted Checks run `28552359995` on commit `8bacb017` passed the full
  matrix, including `starter-browser-preview`. The Chrome job log reached
  `real-browser smoke: proving browser storage eviction recovery` and then
  `real-browser built-preview preflight smoke passed`, confirming the
  origin-clear recovery branch in hosted Chrome.
- 2026-07-02: Added a sync-held shutdown replay proof to the starter
  Chrome/CDP branch. The template now has an explicit
  `syncularSyncStartup=manual` smoke mode that leaves default app behavior
  unchanged, mounts the task pane without starting sync, and lets the smoke
  create a generated task that reaches local visibility before Chrome is
  stopped. The proof restarts the same profile and client id with sync still
  held, requires the task to render from the persistent browser
  database, then reloads with normal sync startup and waits for a separate
  observer client to receive the replay through sync/realtime. Local gates with
  Bun `1.3.9` passed:
  `bun --cwd packages/create-syncular-app tsgo`,
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts packages/create-syncular-app/template/src/app.tsx packages/create-syncular-app/template/src/client/syncular.ts`,
  and `bun --cwd packages/create-syncular-app smoke`. Chrome was not installed
  locally; hosted Checks run `28553329494` on commit `58870d5c` passed the full
  matrix, including `starter-browser-preview`. The Chrome job log reached
  `real-browser smoke: proving shutdown replay recovery`,
  `real-browser smoke: proving browser storage eviction recovery`, and then
  `real-browser built-preview preflight smoke passed`, confirming the new
  shutdown replay branch in hosted Chrome.
- 2026-07-02: Added a sync-held renderer-crash replay proof to the starter
  Chrome/CDP branch. The renderer-crash proof uses the same manual-sync startup
  mode as the shutdown replay proof, writes a generated task, waits for local
  visibility and rendered local text, sends Chrome CDP `Page.crash` through a
  short bounded command, verifies the renderer is unavailable, opens the same
  profile and client id with sync still held to prove the task restored from
  local browser storage, then resumes normal sync and waits for a separate
  observer client to receive the replay through sync/realtime. An attempted
  stronger variant that globally forced Chrome offline before the generated
  write was dropped because hosted Chrome proved it blocks the starter runtime
  lifecycle before the local mutation path starts; targeted sync-transport
  failure remains outstanding. Local gates with Bun `1.3.9` passed:
  `bun --cwd packages/create-syncular-app tsgo`,
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts`, and
  `bun --cwd packages/create-syncular-app smoke`. Chrome was not installed
  locally; hosted Checks run `28554593391` on commit `84f3bbf1` passed the full
  matrix, including `starter-browser-preview`. The Chrome job log reached
  `real-browser smoke: proving shutdown replay recovery`,
  `real-browser smoke: proving renderer-crash replay recovery`,
  `real-browser smoke: proving browser storage eviction recovery`, and then
  `real-browser built-preview preflight smoke passed`, confirming the new
  renderer-crash replay branch in hosted Chrome.
- 2026-07-02: Added a targeted sync-transport replay proof to the starter
  Chrome/CDP branch. The template sync server now exposes a smoke-only
  `SYNCULAR_STARTER_SMOKE_FAILPOINTS=1` failpoint that can block one client's
  `/sync` POSTs and count blocked push attempts without putting the whole
  browser offline. The browser smoke opens a dedicated client, enables that
  failpoint for the client id, creates a generated task, waits for local
  visibility plus rendered text, requires the server failpoint to count a
  blocked push from that exact client, clears the failpoint, dispatches
  `online`, awaits the public `resumeFromBackground()` recovery path until it
  reports a pushed commit, and waits for a separate observer client to receive
  the replay through sync/realtime. An intermediate hosted run
  `28555521871` failed with `sync-transport-replay-propagation-timeout`,
  showing that a single immediate resume can race the one-second outbox retry
  backoff after a transport error; the proof now loops through the public
  resume API until replay actually pushes. This replaces the discarded global
  Chrome-offline attempt with targeted transport evidence for the generated
  write/outbox path. Local gates with Bun `1.3.9` passed:
  `bun --cwd packages/create-syncular-app tsgo`,
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts packages/create-syncular-app/template/src/app.tsx`,
  `bun --cwd packages/create-syncular-app smoke`,
  `bun run docs:stale-check`, and `git diff --check`. Chrome was not installed
  locally, so hosted Checks run `28555819882` on commit `855c6749` confirmed
  the branch in hosted Chrome and passed the full matrix.
- 2026-07-02: Added an explicit browser storage-shutdown replay proof to the
  starter Chrome/CDP branch. The template exposes a hidden
  `syncular-starter-run-storage-shutdown-proof` event that closes the actual
  generated app client, requires `getStatus()` to report a closed connection and
  `closed` lifecycle phase, and requires a post-close generated mutation to
  reject with `worker.closed`. The browser smoke writes a generated task with
  sync startup held, waits for local visibility plus rendered text, runs the
  shutdown proof, reopens the same Chrome profile/client id with sync still held
  to prove the task restored from persistent browser storage, then reloads with
  normal sync startup and waits for a separate observer client to receive the
  replay through sync/realtime. Local gates with Bun `1.3.9` passed:
  `bun --cwd packages/create-syncular-app tsgo`,
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts packages/create-syncular-app/template/src/app.tsx`,
  `bun --cwd packages/create-syncular-app smoke`, and `git diff --check`.
  Chrome was not installed locally, so hosted Checks run `28556559139` on commit
  `c4054d92` confirmed the branch in hosted Chrome and passed the full matrix.
- 2026-07-02: Added a real discarded-tab recovery proof to the starter
  Chrome/CDP branch. The proof opens a dedicated generated-app client with
  sync startup held, writes a generated task, waits for local visibility and
  rendered text, opens Chrome's internal `chrome://discards` page, enables
  internal debug pages through the Chrome profile `Local State` pref, discards
  the hidden starter target through the discards provider, activates the real
  target to force restoration, proves the task still renders from persistent
  browser storage, then resumes normal sync and waits for a separate observer
  client to receive the replay through sync/realtime. Hosted iterations first
  exposed `chrome://discards` import failures, disabled internal debug pages,
  and brittle `loadingState`/internal-row reload assumptions; the retained
  proof now uses the internal page only to prove discard happened, and uses the
  real starter target plus app-visible data to prove recovery. Local gates with
  Bun `1.3.9` passed: `bun --cwd packages/create-syncular-app tsgo`,
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts`,
  `bun --cwd packages/create-syncular-app smoke`, full pre-push static checks
  plus `bun test packages tests/unit tests/dialects tests/typegen && bun run
  client:test`, and `git diff --check`. Chrome was not installed locally, so
  hosted Checks run `28558449113` on commit `49d1b4d4` confirmed the branch in
  hosted Chrome and passed the full matrix.
- 2026-07-02: Added a database-storage-only eviction/rebootstrap proof to the
  starter Chrome/CDP branch. The proof opens a dedicated generated-app client,
  writes Cache API, localStorage, and IndexedDB sentinels, creates a generated
  task, proves the task reached a separate observer tab through sync/realtime,
  closes the app targets, clears only Chrome `indexeddb,file_systems` storage
  for the origin, reopens the same client id, requires Cache/localStorage to
  survive while the IndexedDB sentinel is gone, and waits for the task to
  restore from server state. The existing all-origin clear proof now also
  verifies the IndexedDB sentinel is removed, so the two branches distinguish
  database-storage eviction from full origin data loss. Local gates with Bun
  `1.3.9` passed: `bun --cwd packages/create-syncular-app tsgo`,
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts`,
  `bun --cwd packages/create-syncular-app smoke`, full pre-push gate, and
  `git diff --check`. Chrome was not installed locally, so hosted Checks run
  `28559198325` on commit `9f63634a` confirmed the branch in hosted Chrome and
  passed the full matrix.
- 2026-07-02: Tightened the lower-level OPFS install/open failure fallback path
  in `@syncular/client`. Default browser storage now falls back from
  `opfsSahPool` to `indexedDb` only for OPFS/SAH VFS install failures or sync
  access-handle capability failures, emits the `storage.fallback` diagnostic
  with the original reason, and keeps explicit OPFS requests plus unrelated
  OPFS-looking open errors as loud failures instead of silently changing
  storage. Local gates with Bun `1.3.9` passed:
  `bun test packages/client/src/worker-client.test.ts`,
  `bun --cwd packages/client tsgo`,
  `bunx biome check packages/client/src/worker-client.ts packages/client/src/worker-client.test.ts`,
  and `git diff --check`.
- 2026-07-02: Promoted storage fallback from a worker diagnostic into
  app-facing browser health and support-bundle summaries. Browser health now
  exposes `persistence.issueCodes` plus `fallbackSeverity`, so OPFS -> IndexedDB
  fallback remains a durable mode with `browser.storage_fallback` while
  fallback to memory also reports `browser.storage_ephemeral`; generated
  mutations remain available for durable fallback, and support bundles include
  these persistence issue codes without scraping the fallback reason text.
  Local gates with Bun `1.3.9` passed:
  `bun test packages/client/src/browser-health.test.ts packages/client/src/support-bundle.test.ts`
  and `bun --cwd packages/client tsgo`.
- 2026-07-02: Added the lower-level fallback-failure classification slice in
  `@syncular/client`. If default OPFS open fails with an allowed capability
  error and the IndexedDB retry also fails, `createSyncularWorkerClient(...)`
  now rejects with one `storage.failed` error whose details preserve both the
  original `opfsFailure` and the `fallbackFailure`, instead of dropping the
  OPFS context behind the final IndexedDB error. The successful fallback path
  still emits `storage.fallback` and returns durable IndexedDB as before. Local
  gates with Bun `1.3.9` passed:
  `bun test packages/client/src/worker-client.test.ts -t "storage"` and
  `bun test packages/client/src/worker-client.test.ts`.
- 2026-07-02: Added a server-driven Clear-Site-Data storage
  eviction/rebootstrap proof path to the generated starter smoke. The
  scaffolded Vite dev/preview server now exposes a smoke-only same-origin
  `Clear-Site-Data: "storage"` endpoint under
  `SYNCULAR_STARTER_SMOKE_FAILPOINTS=1`; the non-browser smoke verifies the
  header contract, and the Chrome branch requests that endpoint after a synced
  generated task reaches an observer, requires IndexedDB/localStorage sentinels
  to disappear without using CDP storage clear, then reloads the same client id
  and waits for the task to restore from server state. Local gates with Bun
  `1.3.9` passed:
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts packages/create-syncular-app/template/vite.config.ts`,
  `bun --cwd packages/create-syncular-app tsgo`, and
  `bun --cwd packages/create-syncular-app smoke`. Chrome was not installed
  locally, so hosted Checks run `28561229781` on commit `6d5ac13b` confirmed
  the branch in hosted Chrome and passed the full matrix.
- 2026-07-02: Added a same-origin IndexedDB deletion/rebootstrap proof to the
  generated starter smoke. The scaffolded Vite dev/preview server now exposes a
  smoke-only same-origin storage-admin page under
  `SYNCULAR_STARTER_SMOKE_FAILPOINTS=1` without mounting the generated app or
  sending `Clear-Site-Data`; the non-browser smoke verifies that route is
  `no-store` HTML with a ready marker. The Chrome branch writes Cache API,
  localStorage, and IndexedDB sentinels, creates a generated task, proves it
  reached an observer through sync/realtime, closes the app targets, opens the
  storage-admin page, deletes IndexedDB databases through
  `indexedDB.deleteDatabase(...)`, requires the starter database plus sentinel
  database to be deleted while Cache API/localStorage sentinels survive, then
  reloads the same client id and waits for the task to restore from server
  state. Local gates with Bun `1.3.9` passed:
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts packages/create-syncular-app/template/vite.config.ts`,
  `bun --cwd packages/create-syncular-app tsgo`, and
  `bun --cwd packages/create-syncular-app smoke`. Chrome was not installed
  locally, so hosted Checks run `28561926866` on commit `7869834b` confirmed
  the branch in Chrome and passed the full matrix.
- 2026-07-02: Added a PWA offline cache/reopen persistence proof to the
  generated starter smoke. The smoke-only service worker now caches same-origin
  navigation, JS, worker, and WASM assets on a controlled online load. The
  Chrome branch registers that worker, warms the cache, creates a generated
  task, verifies local visibility/command-timeline evidence, forces
  `navigator.onLine=false` through CDP network emulation, reloads the same
  client id with `syncularSyncStartup=manual`, and requires the task to
  reappear from the persistent browser database while the page remains
  service-worker controlled and classified under the PWA support policy. Local
  gates with Bun `1.3.9` passed:
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts` and
  `bun --cwd packages/create-syncular-app tsgo`, and
  `bun --cwd packages/create-syncular-app smoke`. Chrome is not installed
  locally, so hosted `starter-browser-preview` confirmation is still required
  for the new browser branch.
- 2026-07-02: Hosted Checks run `28562746749` on commit `9485734e` failed only
  in `starter-browser-preview` and exposed that the first PWA offline cache
  proof was too broad: it accepted any cached `.js`/`.wasm`, then the offline
  reload failed to fetch `/syncular/wasm-core/syncular.js` and
  `/syncular/wasm-core/syncular_bg.wasm`. The follow-up smoke change now keeps
  those runtime asset paths in one shared list, explicitly warms them from the
  service-worker-controlled page before forcing offline mode, and requires exact
  cache entries for both runtime assets before the offline reload proof can pass.
  Local gates with Bun `1.3.9` passed:
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts`,
  `bun --cwd packages/create-syncular-app tsgo`, and
  `bun --cwd packages/create-syncular-app smoke`. Chrome is not installed
  locally, so hosted confirmation for the corrected PWA offline branch is still
  required.
- 2026-07-02: Hosted Checks run `28563036328` on commit `e9f20ca5` again failed
  only in `starter-browser-preview` with the same offline runtime-asset fetches.
  That narrowed the issue past exact cache key presence and into browser cache
  matching semantics for the later script/WASM requests. The smoke worker now
  matches cached fallback assets with `ignoreSearch` plus `ignoreVary`, and the
  runtime warm step writes `/syncular/wasm-core/syncular.js` and
  `/syncular/wasm-core/syncular_bg.wasm` into the smoke cache under canonical
  default `Request` keys before forcing offline mode. Hosted confirmation for
  that stricter fallback is still pending.
- 2026-07-02: Hosted Checks run `28563286189` on commit `89901ec5` still failed
  only in `starter-browser-preview`: hosted Chrome recorded expected
  `net::ERR_INTERNET_DISCONNECTED` diagnostics for the exact runtime asset
  paths after the offline reload. The follow-up added smoke-only service-worker
  telemetry, a diagnostic probe path that can still read the page after CDP
  browser request diagnostics, and a narrower offline diagnostic allowlist for
  only the recovery navigation/runtime asset URLs, backed by required
  service-worker Cache API hit evidence. Hosted Checks run `28564187460` on
  commit `1bdbe3b2` then failed only in `starter-browser-preview` with the app
  preflight reporting `browser.runtime_asset_unreachable`; the artifact proved
  the page was service-worker controlled, but offline preflight asset probes
  used `HEAD`, and the smoke worker had only handled `GET`. The current
  follow-up handles `GET` and `HEAD`, matches cached runtime assets with
  `ignoreMethod`, and returns header-only cached responses for offline `HEAD`
  probes. Local Bun `1.3.9` gates passed: `bunx biome check
  packages/create-syncular-app/scripts/smoke.ts`, `bun --cwd
  packages/create-syncular-app tsgo`, and `bun --cwd packages/create-syncular-app
  smoke`. Chrome is not installed locally, so hosted confirmation for the HEAD
  preflight fallback is still required. Hosted Checks run `28564524682` on
  commit `48f7f916` failed only in `starter-browser-preview` before the offline
  reload branch: the controlled PWA page's online preflight issued `HEAD`
  runtime-asset probes, and the smoke worker tried to `cache.put(...)` those
  `HEAD` requests, which the Cache API rejects. The current follow-up keeps
  online `HEAD` probes network-pass-through and only writes successful `GET`
  runtime responses to the smoke cache; offline `HEAD` probes still match the
  warmed `GET` entries with `ignoreMethod`.
- 2026-07-02: Hosted Checks run `28564720341` on commit `9796ee5e` advanced
  past PWA policy/readiness and into the offline reload proof. The page stayed
  service-worker controlled, kept the PWA support-policy evidence, and rendered
  the offline-created task after reopening, but smoke telemetry timed out with
  zero runtime cache-hit events because the service worker still fetched the
  runtime assets from the preview server with network `200` responses under
  CDP page-target offline emulation. The follow-up now stops the preview server
  for only the PWA offline proof, keeps the same offline/navigation/cache-hit
  assertions, and restarts the preview server in cleanup before subsequent
  browser smoke branches. Local Bun `1.3.9` gates passed:
  `bunx biome check packages/create-syncular-app/scripts/smoke.ts`,
  `bun --cwd packages/create-syncular-app tsgo`, and
  `bun --cwd packages/create-syncular-app smoke`. Chrome is not installed
  locally, so hosted confirmation for the explicit server-down offline proof is
  still required.
- 2026-07-02: Hosted Checks run `28565138186` on commit `c9475577` still
  failed only in `starter-browser-preview`: the explicit preview-server stop
  worked, but the already-open PWA page logged expected realtime WebSocket and
  sync connection-refused diagnostics before the offline reload proof could
  read `navigator.onLine`. The current follow-up registers those
  server-intentionally-down diagnostics before stopping the preview server while
  leaving the service-worker navigation/runtime cache-hit telemetry gate
  unchanged. Local Bun `1.3.9` focused Biome, create-syncular-app typecheck,
  docs stale check, diff check, and non-Chrome scaffold smoke passed.
- 2026-07-02: Hosted Checks run `28565395806` on commit `46689179` passed the
  full matrix, including `starter-browser-preview`. That confirms the explicit
  preview-server-down PWA offline proof in hosted Chrome: the same generated-app
  client id reopens under service-worker control, renders the offline-created
  task from persistent browser storage, and requires service-worker
  navigation/runtime Cache API hit telemetry while only allowlisting the
  intentional server-down diagnostics for that proof.
- 2026-07-02: Added a separate PWA online runtime cache-refresh proof to the
  generated starter smoke. In a fresh Chrome profile, the branch registers the
  smoke-only service worker, verifies the generated app is controlled under the
  PWA support-policy evidence, writes a deliberately stale
  `/syncular/wasm-core/syncular.js` response into the smoke Cache API entry,
  warms the runtime assets online with `cache: "reload"`, and requires the
  cached entry to lose the stale marker/header before the offline reopen branch
  runs. Local Bun `1.3.9` focused Biome, create-syncular-app typecheck,
  non-Chrome scaffold smoke, and diff check passed. Hosted Checks run
  `28566130045` on commit `d33643c0` passed the full matrix, including
  `starter-browser-preview`, confirming the real-browser cache-refresh branch
  in hosted Chrome.
- 2026-07-02: Added a PWA service-worker update activation proof to the
  generated starter smoke. The proof writes a unique initial version into the
  smoke-only built service worker, registers it in a fresh Chrome profile,
  verifies the controlled page can read that controller version over
  `postMessage`, rewrites the same built worker file to a new version, calls
  `registration.update()`, and requires the controlled page to observe the new
  service-worker controller version. The branch restores the default smoke
  worker afterward so later PWA proofs keep their normal file shape. Local Bun
  `1.3.9` focused Biome, create-syncular-app typecheck, non-Chrome scaffold
  smoke, and diff check passed. Hosted Checks run `28566859795` on commit
  `0d211bbe` passed the full matrix, including `starter-browser-preview`,
  confirming the real-browser service-worker update activation branch in
  hosted Chrome.

## Next Action

Pick the next implementation slice from the remaining risks. The immediate
starter browser-preview blocker is cleared, same-client duplicate-tab open
contention, generated write pressure, and storage recovery action mapping are
covered in hosted Chrome, and the same-database duplicate-tab writer branch is
now also confirmed in hosted Chrome. The service-worker-controlled PWA
classification proof is also covered in hosted Chrome: it verifies real
controller evidence and support-policy `pwa`/`warning` classification without
claiming installed-PWA offline/cache-update support. The incognito
memory-storage support-policy branch is now confirmed in hosted Chrome and
verifies explicit ephemeral/development storage classification without claiming
private-mode durable persistence. The current slice adds a browser-observed
quota-pressure preflight branch, now fixed to pass post-override CDP usage/quota
facts into the app preflight proof and confirmed in hosted Chrome. The current
slice extends those browser-observed quota facts into storage recovery action
mapping, now confirmed in hosted Chrome. The quota-exhausted generated write
rejection proof is also confirmed in hosted Chrome. The generated
command-timeline proof marker is also confirmed in hosted Chrome through Checks
run `28545477587`. Browser health now has a typed lifecycle operation
projection for app chrome/support output and the same fields are carried in the
browser-preview failure artifact, testkit assertions, and Console/Fleet
ingestion. Command timeline proof artifacts now also carry the concrete
joined-scope, request/sync, realtime cursor, pull reason, local apply, and
local-visibility evidence through starter smoke, testkit assertions, and
Console/Fleet ingestion. Cloudflare runtime failure artifacts now also carry
redacted negative-path proof for auth-required, forbidden/revoked scope,
invalid blob request/token, and blob access-denial outcomes. Destructive local
recovery actions now expose data-loss/outbox safety metadata and block
row-clearing actions while unsynced outbox work exists. Real browser target
activation background/foreground coverage below the generated task proof is now
confirmed in hosted Chrome. Explicit origin-storage eviction/rebootstrap
recovery is also confirmed in hosted Chrome through Checks run `28552359995`.
The sync-held shutdown replay proof now covers a generated write surviving
browser process stop/restart and replaying after normal sync resumes; hosted
Checks run `28553329494` confirmed that branch in Chrome. The current slice
adds renderer-crash replay recovery for the same sync-held generated-write
flow; hosted Checks run `28554593391` confirmed that branch in Chrome.
The current slice adds targeted sync-transport replay behind a smoke-only
server failpoint; hosted Checks run `28555819882` confirmed that branch in
Chrome. The current slice adds explicit storage-shutdown replay by closing the
generated app client, verifying closed lifecycle/status plus `worker.closed`
post-close rejection, reopening the same persistent browser database with sync
held, and then replaying to an observer after normal sync resumes; hosted Checks
run `28556559139` confirmed that branch in Chrome. The current slice adds
discarded-tab recovery through Chrome's internal discards provider plus real
target activation/restoration; hosted Checks run `28558449113` confirmed that
branch in Chrome. The current slice adds database-storage-only eviction proof
by clearing Chrome `indexeddb,file_systems` storage while proving Cache API and
localStorage sentinels survive; hosted Checks run `28559198325` confirmed that
branch in Chrome. The current slice tightens lower-level OPFS capability
fallback so default storage degrades to IndexedDB only for OPFS/SAH install or
sync access-handle failures while explicit OPFS and unrelated OPFS-looking open
errors fail loudly, and app-facing browser health/support bundles now preserve
that fallback as `browser.storage_fallback` without classifying durable
IndexedDB fallback as memory-only storage. The fallback-also-fails path now
rejects as `storage.failed` with both OPFS and IndexedDB failure details
preserved. The current slice adds a server-driven Clear-Site-Data storage
eviction/rebootstrap branch: a smoke-only Vite dev/preview endpoint returns
`Clear-Site-Data: "storage"`, the non-browser scaffold smoke verifies the
header contract, and the Chrome path clears IndexedDB/localStorage sentinels
through that response header before rehydrating the same client id from server
state; hosted Checks run `28561229781` confirmed that branch in Chrome. The
latest slice adds a same-origin IndexedDB deletion branch: a smoke-only
storage-admin page gives the browser a same-origin execution context without
mounting the generated app, the non-browser scaffold smoke verifies the route,
and the Chrome path deletes IndexedDB databases through
`indexedDB.deleteDatabase(...)` before rehydrating the same client id from
server state; hosted Checks run `28561926866` on commit `7869834b` confirmed
that branch in Chrome and passed the full matrix. The PWA offline cache/reopen
persistence branch is now also confirmed in hosted Chrome: the smoke-only
service worker caches the built app/runtime assets on a controlled online load,
the proof warms the exact Syncular WASM bridge assets, stops the preview server
during only the offline proof, reloads the same generated-app client id with
sync startup held manual, and requires the locally inserted task to reappear
from persistent browser storage under service-worker control. Intermediate
hosted runs caught the sharp edges: exact runtime asset warming, cached
fallback matching, `HEAD` preflight handling, avoiding Cache API writes for
non-`GET` requests, service-worker process network behavior under CDP offline
emulation, and expected server-down sync/realtime diagnostics. Hosted Checks
run `28565395806` on commit `46689179` passed the full matrix, including
`starter-browser-preview`, and confirmed real service-worker navigation/runtime
Cache API hit telemetry. The PWA online runtime cache-refresh branch is now
also confirmed in hosted Chrome: hosted Checks run `28566130045` on commit
`d33643c0` passed the full matrix after poisoning the smoke Cache API entry
for the Syncular WASM glue with a stale marker, warming the runtime assets
online with `cache: "reload"`, and requiring the cached response to be
replaced by the live asset. The PWA service-worker update activation branch is
also confirmed in hosted Chrome: hosted Checks run `28566859795` on commit
`0d211bbe` passed the full matrix after rewriting the smoke worker and
requiring `registration.update()` to deliver the updated controller version.
The latest runtime/version-alignment slice adds typed mixed-deploy diagnostics
to schema readiness: `getSyncularSchemaReadiness(...)` accepts expected
runtime identity, compares package name/version, worker protocol, optional
Rust crate/schema metadata, required Rust runtime features, and worker/WASM
asset URLs against the opened runtime, and reports stable `runtime.*` issue
codes with redacted asset URL details. Generated app `schemaReadiness()` now
injects the expected Syncular package constants, worker protocol, selected
runtime artifact URLs, and generated required Rust features automatically, so
stale JS/WASM/service-worker/CDN deploys can fail as named readiness issues
instead of generic worker/runtime open errors. Local pinned-Bun focused
schema-readiness tests, full client unit tests, client/create-app typechecks,
Biome, and codegen output checks passed.
Remaining lifecycle/storage work is host/browser eviction beyond explicit CDP
origin/database clears/Clear-Site-Data/same-origin IndexedDB deletion,
installed-PWA cache/update semantics beyond the smoke-only PWA offline,
cache-refresh, and service-worker update proofs, and storage coordination/
failure behavior below the already-covered OPFS fallback and
fallback-failure classification.
Production ops readiness is now part of release rehearsal when evidence is
present or required. Strong follow-ups after that remain host-driven eviction
and deeper storage-failure browser proof, lower-level storage
contention/failure behavior beyond the already-covered OPFS install fallback,
fallback-failure classification, duplicate-tab generated writes, renderer
crash, explicit shutdown close, discarded-tab recovery, database-storage
eviction, Clear-Site-Data storage eviction, and same-origin IndexedDB deletion
branches, and
browser/bundler matrix execution, especially Safari, Firefox, real private-mode
durable-persistence semantics, WebViews, installed-PWA cache/update semantics,
and PWA cache-update semantics beyond these smoke-only runtime cache-refresh
and service-worker update activation proofs.
