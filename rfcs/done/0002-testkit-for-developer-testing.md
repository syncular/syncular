# RFC 0002: Syncular Testkit for Developer Testing

Status: Implemented  
Authors: Syncular maintainers  
Created: 2026-02-16  
Completed: 2026-02-16  
Discussion: N/A

## Summary

Introduce a first-class Syncular testkit that standardizes how tests set up server/client fixtures, run sync operations, simulate failures, and assert sync invariants.

The testkit must be designed from current repo reality first, then externalized for users. The immediate objective is to remove duplicated internal harness logic while preserving test fidelity across in-process and real-HTTP test styles.

## Final Decision

Accepted and implemented for core testkit + internal adoption.

Implemented scope:

- Added `@syncular/testkit` with shared fixtures, assertions, and fault-injection utilities.
- Kept the package runner-agnostic (no `bun:test` coupling in exported testkit APIs).
- Consolidated duplicated HTTP server scaffolding into reusable helpers (`createNodeHonoServer`, `createHttpServerFixture`).
- Added reusable project-scoped tasks fixtures/handlers for runtime and integration-style usage.
- Migrated internal test harnesses:
  - perf suite to `@syncular/testkit`
  - integration HTTP harness to `@syncular/testkit`
  - client-react integration test setup to `@syncular/testkit`
  - runtime Node/Deno server scaffolding and relay runtime test to shared testkit primitives

Validation executed during implementation:

- `bun --cwd packages/testkit tsgo`
- `bun --cwd tests/runtime tsgo`
- `bun --cwd tests/runtime test:node`
- `bun --cwd tests/runtime test:deno`
- `bun --cwd tests/runtime test:relay`
- `bun --cwd tests/integration test`
- `bun test packages/client-react/src/__tests__/integration`

## Motivation

Syncular has broad test coverage today, but test infrastructure is fragmented:

- Multiple fixture stacks exist with overlapping responsibilities.
- Similar server/client setup and handlers are re-implemented in several places.
- There are shared utilities that are exported but effectively unused.
- Runtime tests include repeated process/network scaffolding.

This causes maintenance drag and makes it hard to provide a stable, documented testing story to framework users.

## Current Test Landscape (Audit)

The audit found three primary harness ecosystems plus runtime-specific scaffolding.

### 1. In-process shared harness

- `tests/shared/test-setup.ts`
- Used by perf tests via `@syncular/tests-shared/test-setup`.

Characteristics:

- In-process transport via direct `pushCommit`/`pull` calls.
- Dialect matrix support for some client/server combinations.
- Includes reusable seed helpers.

### 2. Real HTTP integration harness

- `tests/integration/harness/create-server.ts`
- `tests/integration/harness/create-client.ts`

Characteristics:

- Uses Hono + node:http bridge.
- Real HTTP transport and auth headers.
- Powers feature/matrix integration scenarios.

### 3. Client-react integration harness

- `packages/client-react/src/__tests__/integration/test-setup.ts`

Characteristics:

- In-process transport and engine-focused lifecycle helpers.
- Largely duplicates fixture logic from `tests/shared/test-setup.ts`.

### 4. Runtime-specific test scaffolding

- `tests/runtime/apps/node/server.ts`
- `tests/runtime/apps/deno/server.ts`
- `tests/runtime/apps/cloudflare/worker.ts`
- `tests/runtime/__tests__/relay.runtime.test.ts`

Characteristics:

- Repeated inline handlers and server bootstrapping helpers.
- Process lifecycle and health-check patterns repeated per runtime.

### 5. Duplication/usage signals observed

- Large fixture files: `tests/shared/test-setup.ts` (584 lines), `packages/client-react/src/__tests__/integration/test-setup.ts` (587 lines).
- Multiple repeated helper patterns in test code:
  - `function createInProcessTransport(...)` appears in both in-process fixture stacks.
  - `function serveHono(...)` appears in 4 files (`tests/integration/harness/create-server.ts`, `tests/runtime/apps/node/server.ts`, `tests/runtime/apps/deno/server.ts`, `tests/runtime/__tests__/relay.runtime.test.ts`).
  - 23 explicit `createTable('tasks')` definitions across `tests/*` and `packages/client-react/src/__tests__/integration/*`.
- Sync-internal assertions are repeated ad hoc:
  - 66 direct references to `sync_outbox_commits` / `sync_conflicts` / `sync_subscription_state` / `sync_commits` in integration + client-react + shared test helpers.
- Fault/retry behavior is often tested via custom monkey-patching:
  - Example: `packages/client-react/src/__tests__/integration/push-flow.test.ts` overrides `transport.sync` inline.
- Shared exports currently unused in repo tests:
  - `tests/shared/assertions.ts`
  - `tests/shared/error-transport.ts`
  - `tests/shared/scenario-builder.ts`
- `@syncular/tests-shared/test-setup` is currently consumed by perf tests only.

## Goals

- Unify fixture creation around one maintained API.
- Support both in-process and real-HTTP sync test styles.
- Make conflict/scope/offline/retry tests easy and deterministic.
- Reuse one assertion and fault-injection layer across packages.
- Adopt internally first, then expose as public developer API.

## Non-Goals

- Building a custom general-purpose test runner.
- Replacing Bun test, Vitest, or Playwright.
- Covering all runtime-process orchestration in v1.
- Abstracting every low-level server/client primitive behind the testkit.

## Design Principles

- Internal-first: dogfood by migrating existing repository tests before external marketing.
- Low magic: explicit fixtures and hooks; avoid hiding table/handler semantics.
- Transport parity: identical scenario code should run against in-process or HTTP mode.
- Determinism: built-in controls for failure, latency, and ordering.
- Layered API: simple defaults, optional low-level escape hatches.

## Usefulness Bar

The testkit is only worth shipping if it clears all of the following:

- Replaces at least the three current fixture stacks (shared, integration HTTP, client-react integration) instead of becoming a fourth.
- Supports both one-shot sync APIs (`syncPullOnce`/`syncPushOnce` style) and engine-driven tests (`SyncEngine`) from the same fixture core.
- Makes retry/offline testing deterministic without manual transport monkey-patching.
- Provides assertions/wait helpers that reduce repeated direct SQL checks for sync internals.
- Avoids a high-magic DSL that can diverge from real Syncular behavior.

## Proposal

### 1. Package Layout

Create a package family with clear boundaries:

- `@syncular/testkit` (core)
  - fixtures (server/client), scenario operations, assertions, fault controls
  - no browser/wrangler dependencies
- `@syncular/testkit/runtime` (phase 2+)
  - runtime process adapters (Playwright, Cloudflare wrangler, etc.)

In repository transition terms, `tests/shared` becomes the seed for `@syncular/testkit`, not a parallel forever path.

### 2. Core Fixture Model

Provide two fixture modes in one API:

- `transportMode: 'inprocess'`
  - direct server function invocation for fast deterministic tests
- `transportMode: 'http'`
  - real HTTP server + transport for endpoint/auth/CORS integration coverage

Core fixture constructors:

- `createServerFixture(options)`
- `createClientFixture(server, options)`
- `createSyncFixture(options)` convenience wrapper

`createSyncFixture` should be the primary entry point and return:

- `server` fixture (`db`, `handlers`, `destroy`)
- `createClient(opts)` factory so multi-client scenarios stay concise
- `destroyAll()` to clean server + all created clients

Each created client fixture returns:

- `db`
- `handlers`
- `transport`
- `mode: 'raw' | 'engine'`
- raw operations: `enqueue()`, `push()`, `pull()`, `syncOnce()`
- engine operations (when `mode: 'engine'`): `startEngine()`, `stopEngine()`, `syncEngine()`, `refreshOutboxStats()`
- `destroy()`

### 3. Schema + Handler Inputs

The testkit should require explicit schema/handler definitions rather than hiding them.

Proposed options shape:

```ts
createSyncFixture({
  transportMode: 'inprocess' | 'http',
  serverDialect: 'sqlite' | 'pglite',
  clientDialect: 'bun-sqlite' | 'pglite' | 'sqlite3' | 'libsql',
  schema: {
    createServerTables: async (db) => {},
    createClientTables: async (db) => {},
  },
  handlers: {
    server: [/* ServerTableHandler */],
    client: [/* ClientTableHandler */],
  },
  auth: {
    actorHeader: 'x-actor-id',
  },
});
```

This keeps the API flexible enough for tasks/projects/e2ee/proxy scenarios already in the repo.

### 4. Client Scenario Operations

Expose high-signal operations that map to current test usage:

- `client.enqueue({ operations, schemaVersion })`
- `client.push()`
- `client.pull({ subscriptions, ... })`
- `client.syncOnce({ subscriptions, ... })`
- `client.startEngine()` / `client.stopEngine()` / `client.syncEngine()`

All operations return typed results including push/pull status details used by current scenarios.

The API must keep one-shot and engine flows explicit, since both are heavily used in the current repository tests.

### 5. Assertions Module

Replace ad hoc repeated SQL checks with a stable assertion API:

- `expectOutbox.pending(client, n)`
- `expectOutbox.empty(client)`
- `expectConflicts.count(client, n)`
- `expectRows.ids(client, 'tasks', ['t1', 't2'])`
- `expectServer.commits(server, n)`
- `expectSubscription.status(client, subId, 'active' | 'revoked')`
- `waitFor.outboxEmpty(client, { timeoutMs })`
- `waitFor.ackedCommits(client, n, { timeoutMs })`

Assertions must include failure context (clientId, actorId, recent cursor info).

### 6. Fault Injection Module

Productize failure controls currently present but unused in shared utilities:

- `withFaults(client.transport, options)`
  - `failAfter`
  - `failOnPush/failOnPull`
  - `retriable/non-retriable`
  - `latencyMs`
  - `flaky`

Also include request recording:

- `withRecording(client.transport)` to capture push/pull/chunk requests for assertions.

This should become the default way to test retry/offline behavior and replace manual `transport.sync` overrides.

### 7. Runtime Adapter Scope (Deferred)

Runtime adapters are valuable, but not in core v1.

Defer to phase 2+:

- Node/Deno server process helpers
- Playwright browser harness helpers
- Wrangler lifecycle helpers for Cloudflare/D1 tests

### 8. CLI Scaffolding Scope (Deferred)

`syncular test:init` is useful but should be deferred until core APIs stabilize via internal adoption.

Rationale:

- Current CLI command model would need incremental extension.
- Scaffolding before API stabilization creates churn for generated templates.

### 9. Explicitly Out of Scope for Core v1

- A fluent scenario DSL (`scenario().client('a').push().expect...`) as a first-class API.
- Canned domain handlers (tasks/projects) in core package exports.

Rationale:

- The existing `tests/shared/scenario-builder.ts` is currently unused and re-implements sync semantics manually.
- Core value is fixture correctness and deterministic primitives, not a custom test language.

## Implementation Results

### Completed

- Core `@syncular/testkit` package created and wired into the workspace.
- Shared fixture API implemented for server/client setup and sync operations.
- Assertion + fault-injection utilities exported and reusable from one place.
- Existing integration and client-react harness duplication replaced with testkit usage.
- Runtime duplication reduced by reusing shared Node/Hono bridge + project-scoped tasks primitives.

### Deferred Follow-ups

- Cloudflare worker runtime test app still keeps inline handler definitions due to wrangler/runtime import constraints.
- Public docs examples for external users should be expanded now that internal APIs are stable.
- CLI scaffolding (`syncular test:init`) remains intentionally deferred.

## Measured Outcomes

- Large duplicated runtime and harness blocks were replaced by shared testkit primitives.
- Integration, runtime (node/deno/relay), and client-react integration suites pass on migrated paths.
- Testkit APIs are reusable across suites without binding to a specific test runner.

## Alternatives Considered

### A. Keep current harnesses and only improve docs

Rejected. It preserves long-term maintenance duplication and drift.

### B. Expose `tests/shared` directly as public package without refactor

Rejected. Current shared exports include dead/unused APIs and uneven quality.

### C. Build runtime adapters first

Rejected. Core fixture unification yields higher immediate ROI and is prerequisite to stable adapters.

## Risks

- Over-abstraction could hide important sync semantics.
- API churn if externalized before internal migration completion.
- Runtime adapter complexity can balloon if included too early.

Mitigations:

- Keep low-level escape hatches (`db`, `transport`, raw server/client APIs).
- Gate release by internal migration milestones.
- Strictly phase runtime adapters after core stabilization.

## Follow-up Decisions

- Whether runtime helpers should remain in `@syncular/testkit` core or split into a dedicated `@syncular/testkit/runtime` package.
- Whether assertions should remain bundled in core exports or move to a lighter split module.
- Which dialect combinations should be treated as first-class defaults vs explicit caller configuration.

## Acceptance Criteria

- [x] Internal duplicate harness logic is consolidated into shared `@syncular/testkit` primitives.
- [x] Integration and client-react integration suites use testkit APIs for setup and core sync operations.
- [x] Shared assertions and fault-injection utilities are available from `@syncular/testkit`.
- [x] Runtime node/deno/relay tests reuse shared runtime-safe testkit helpers.
- [x] Testkit remains test-runner-agnostic (no `bun:test` requirement in testkit exports).
