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
- `bun test packages/syncular/src/cli.test.ts`
- `bun scripts/fresh-app-smokes.ts --skip-rust --work-dir .context/wp50-fresh-app-smoke-local-visibility`
- `git diff --check`

## Sequencing

1. Golden path starter and smoke: first retained slice is done for the
   browser/runtime health surface. Continue growing the starter only when it
   proves a concrete app-facing rough edge.
2. Browser/runtime health contract: first retained slice is done. Future slices
   should add missing setup/runtime error codes as concrete failures appear.
3. Local visibility primitive: first retained slice is done with a
   query/predicate helper and managed database method. Future generated helpers
   can wrap it for command-specific or subscription-specific waits.
4. Add the auth context/scope-change contract, then prove campaign join/change
   flows through realtime and local visibility.
5. Add schema readiness and drift diagnostics before encouraging production
   deployment patterns.
6. Add blob partition/scope guidance and typed blob failure details once the
   canonical app flow has a real blob/package case.
7. Add deterministic E2E/testkit recipes and stable log markers around the
   concrete flows above.
8. Collapse client init and import docs where the starter proves remaining
   friction.
9. Finish with contributor bootstrap/gate cleanup so maintainers can keep the
   path green.

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
- Should auth context replacement live on the generated app client, the core
  database client, or both?
- What is the blessed global/base-data sharing pattern for package releases
  pinned into campaign scopes?
- Which schema readiness checks belong in the `syncular` CLI versus server
  package APIs?

## Next Action

Pick the next implementation slice: add a local visibility primitive and docs
that distinguish bootstrap, explicit pull, autosync, realtime wakeup, local
read-model freshness, and manual `sync()` so app code can wait for local
visibility without using `sync()` as a stale-read escape hatch.
