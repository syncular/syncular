# Audit Fix Progress

Date: 2026-03-06

Scope:
- Snapshot chunk authorization hardening
- Realtime/client identity scoping hardening
- Partition-aware pruning
- Pull query/index scalability improvements
- Snapshot/bootstrap memory pressure reduction
- Targeted regression coverage

Status:
- [completed] Create work log and map fixes
- [completed] Require scoped auth for snapshot chunk downloads and always send scopes from transports
- [completed] Namespace realtime scope state by authenticated owner instead of bare client ID
- [completed] Reject client ID reuse across actors for cursor tracking
- [completed] Make pruning partition-aware
- [completed] Improve Postgres scope filtering/index usage
- [completed] Add byte-budget limits for bootstrap chunk generation
- [completed] Run targeted tests

Notes:
- This file is updated as fixes land.
- Targeted verification completed:
  - `bun test packages/server/src/prune.test.ts`
  - `bun test packages/server-dialect-postgres/src/index.test.ts`
  - `bun test packages/server-hono/src/__tests__/pull-chunk-storage.test.ts`
  - `bun test packages/server-hono/src/__tests__/sync-maintenance.test.ts`
  - `bun test packages/server-hono/src/__tests__/console-routes.test.ts`
  - `bun test packages/server-hono/src/__tests__/ws-connection-manager.test.ts packages/transport-http/src/__tests__/transport-options.test.ts packages/server-hono/src/__tests__/pull-chunk-storage.test.ts`
- A broader `bun test` run was started and reached the later integration/load suites without functional failures before being interrupted. The suite also emitted existing perf-regression reports, but they were informational rather than test failures.
