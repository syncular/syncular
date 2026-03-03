# Syncular Streamline Tracker

## Status
- Created: 2026-03-03
- Last updated: 2026-03-03
- Current phase: Backlog candidates complete
- Passes completed: 15

## Completed Passes
- Pass 1: Unify push pipeline (HTTP + WS)
- Pass 2: OpenAPI-driven console API client
- Pass 2A: Remove console type duplication
- Pass 2B: Live events path simplification
- Pass 2C: Console mutation scaffolding dedup
- Pass 2D: Console query core consolidation
- Pass 3: Shared handler utilities
- Pass 3A: Shared codec resolver dedup
- Pass 4: Shared JSON/dialect helpers
- Pass 5: React hook core dedup (`useSyncQuery` / `useQuery`)
- Pass 6: Shared SQLite dialect skeleton
- Pass 7: Remove compatibility aliases (alpha cleanup)
- Pass 8: Dist artifact policy verification
- Backlog: Shared URL normalization utility
- Backlog: Console route descriptor consolidation

## Remaining TODOs
- No open streamline passes in this batch.
- Optional future backlog:
  - Additional server-hono console endpoint consolidation beyond route descriptors.
  - Further transport/client URL utility adoption only if new duplication appears.

## Validation Snapshot
- `bun --cwd packages/core tsgo`
- `bun --cwd packages/client tsgo`
- `bun --cwd packages/server tsgo`
- `bun --cwd packages/server-hono tsgo`
- `bun --cwd packages/transport-http tsgo`
- `bun test packages/server-hono/src/__tests__/console-routes.test.ts`
- `bun test packages/server-hono/src/__tests__/console-gateway-routes.test.ts packages/server-hono/src/__tests__/console-gateway-live-routes.test.ts`
- `bun test packages/transport-http/src/__tests__/transport-options.test.ts`
- `bun test packages/client/src/client.test.ts`
