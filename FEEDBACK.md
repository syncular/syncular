# Feedback Backlog

Source: full-project review across `core`, `server`, `server-hono`, `client`, `transport-http`, `transport-ws`, and `ui`.

## How To Use This

- Treat each item as a backlog ticket.
- Mark it done by checking the box.
- Keep acceptance criteria in each ticket.

## P1 (Fix First)

- [x] **P1-1: Enforce presence scope authorization**
  - Problem: WS presence join/update accepts arbitrary `scopeKey` values from clients and can leak presence snapshots for unauthorized scopes.
  - Code refs: `packages/server-hono/src/routes.ts:890`, `packages/server-hono/src/routes.ts:900`, `packages/server-hono/src/ws.ts:291`
  - Acceptance:
    - Presence join/update is allowed only for client-authorized scope keys.
    - Unauthorized scope key attempts are rejected/ignored and logged.
    - Tests added for both allowed and denied cases.

- [x] **P1-2: Wire `chunkStorage` into pull path**
  - Problem: route options expose external chunk storage, but `/pull` currently does not pass it into `pull(...)`.
  - Code refs: `packages/server-hono/src/routes.ts:172`, `packages/server-hono/src/routes.ts:410`, `packages/server/src/pull.ts:98`
  - Acceptance:
    - `/pull` passes `chunkStorage` when configured.
    - Snapshot chunk bodies are not inlined in DB when external storage is enabled.
    - Integration test verifies route-level behavior (not only unit utility behavior).

- [x] **P1-3: Isolate rate limit stores per limiter config/route**
  - Problem: pull and push share one global rate-limit store and first-created window config can leak across limiters.
  - Code refs: `packages/server-hono/src/rate-limit.ts:167`, `packages/server-hono/src/rate-limit.ts:173`, `packages/server-hono/src/routes.ts:299`, `packages/server-hono/src/routes.ts:303`
  - Acceptance:
    - Pull and push counters are isolated.
    - Different windows/configurations do not interfere.
    - Tests prove independent limits.

- [x] **P1-4: Implement `SyncTransportOptions` in HTTP transport**
  - Problem: `signal` and `onAuthError` are defined in `SyncTransportOptions` but ignored by transport implementation.
  - Code refs: `packages/core/src/types.ts:77`, `packages/transport-http/src/index.ts:223`, `packages/transport-http/src/index.ts:241`, `packages/transport-http/src/index.ts:259`
  - Acceptance:
    - Requests support abort via `signal`.
    - 401/403 path supports `onAuthError` retry semantics.
    - Behavior is documented and tested.

- [x] **P1-5: Remove insecure default console token behavior**
  - Problem: `createSyncServer` defaults console token to `demo-token` when console is enabled.
  - Code refs: `packages/server-hono/src/create-server.ts:185`, `packages/server-hono/src/create-server.ts:181`
  - Acceptance:
    - No predictable default token in production paths.
    - Either explicit token required or console disabled by default.
    - Upgrade/migration note added to docs.

## P2 (Fix Next)

- [x] **P2-1: Scope prune/compact debounce state**
  - Problem: maintenance debounce (`last*At`, `*InFlight`) is module-global, not per DB/tenant.
  - Code refs: `packages/server/src/prune.ts:156`, `packages/server/src/compaction.ts:30`
  - Acceptance:
    - Debounce/in-flight tracking keyed by DB instance and/or tenant key.
    - One tenant cannot starve maintenance for another.

- [x] **P2-2: Forward websocket limit options in `createSyncServer`**
  - Problem: limit settings are supported in routes but dropped by server factory.
  - Code refs: `packages/server-hono/src/create-server.ts:166`, `packages/server-hono/src/create-server.ts:173`, `packages/server-hono/src/routes.ts:805`
  - Acceptance:
    - `maxConnectionsTotal` and `maxConnectionsPerClient` pass through from factory to routes.
    - Tests cover configured limits.

- [x] **P2-3: Align API docs/behavior for `tables` auto-handler mode**
  - Problem: public API suggests `tables` mode works, but implementation throws not implemented.
  - Code refs: `packages/server-hono/src/create-server.ts:45`, `packages/server-hono/src/create-server.ts:150`
  - Acceptance:
    - Either implement it, or remove it from public API/docs/types.
    - No “advertised but unsupported” path remains.

- [x] **P2-4: Honor shape dependencies during bootstrap**
  - Problem: `dependsOn` metadata exists, but pull bootstrap uses only `[sub.shape]`.
  - Code refs: `packages/server/src/shapes/registry.ts:43`, `packages/server/src/pull.ts:159`
  - Acceptance:
    - Bootstrap ordering uses dependency graph when relevant.
    - Tests validate parent-before-child bootstrap behavior.

- [x] **P2-5: Reduce sync blocking from `gzipSync` in pull**
  - Problem: synchronous gzip in request path can hurt tail latency at scale.
  - Code refs: `packages/server/src/pull.ts:254`
  - Acceptance:
    - Compression path is non-blocking or explicitly offloaded.
    - Throughput/latency benchmark shows no regressions.

## P3 (Cleanups)

- [x] **P3-1: Avoid mutating scope arrays in cache key generation**
  - Problem: `scopesToCacheKey` sorts arrays in place.
  - Code refs: `packages/server/src/pull.ts:42`
  - Acceptance:
    - No in-place mutation of caller-provided scope values.
    - Unit test covers immutability expectation.

## Suggested Work Order

1. `P1-1` presence auth
2. `P1-2` chunk storage wiring
3. `P1-3` rate limit isolation
4. `P1-4` transport options contract
5. `P1-5` console token hardening
6. P2 and P3 items
