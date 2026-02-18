# Console Gateway Progress

Status: Completed  
Owner: Codex  
Last Updated: 2026-02-17

## Scope

Implement Phase 1 of multi-instance console federation from RFC 0005.

## Milestones

- [x] Draft RFC (`rfcs/0005-console-gateway-multi-instance-federation.md`)
- [x] Add gateway route factory in `@syncular/server-hono`
- [x] Add instance registry + auth forwarding contract
- [x] Federate read endpoints:
  - [x] `GET /console/instances`
  - [x] `GET /console/stats`
  - [x] `GET /console/stats/timeseries`
  - [x] `GET /console/stats/latency`
  - [x] `GET /console/timeline`
  - [x] `GET /console/clients`
  - [x] `GET /console/commits`
  - [x] `GET /console/events`
  - [x] `GET /console/events/:id`
  - [x] `GET /console/events/:id/payload`
  - [x] `GET /console/operations`
- [x] Add partial-failure metadata in responses
- [x] Add federated ID handling for detail routes (`<instanceId>:<localId>`)
- [x] Add local-ID compatibility on detail routes when one instance is selected (`instanceId=...`)
- [x] Add live stream fan-in route (`GET /console/events/live`)
- [x] Add console instance selection context + top-nav filter
- [x] Propagate `instanceId` through console read hooks and live feed hook
- [x] Add federated IDs/source labels in Stream detail navigation and drilldowns
- [x] Add single-instance gateway passthroughs + guardrails for mutation/config endpoints
- [x] Propagate `instanceId` through console mutation/config hooks
- [x] Add tests for merge/filter/error behavior
- [x] Add websocket-specific tests for live stream fan-in + degradation signaling
- [x] Add docs/examples for gateway mode configuration
- [x] Add gateway health probe endpoint (`GET /console/instances/health`)
- [x] Export gateway APIs from package index
- [x] Run targeted tests

## Notes

- UI integration is active in `apps/console` with instance filtering and federated stream drilldowns.
- Mutation/config endpoints are single-instance passthroughs and require explicit instance selection (`instanceId` or a single-value `instanceIds`).
- Federated read endpoints continue to support merged views with gateway-side instance filters (`instanceId`, `instanceIds`).
- Gateway forwards incoming bearer token by default and supports per-instance token override.
- Gateway `latency` aggregation currently averages downstream percentiles (approximation).
- Live stream fan-in now has dedicated route-level websocket tests using injected downstream socket factories.
- Gateway now provides `/console/instances/health` for pre-flight downstream reachability and auth checks.

## Work Log

- 2026-02-17: Added RFC 0005 and started backend implementation.
- 2026-02-17: Added `createConsoleGatewayRoutes` with merged `instances/stats/timeline/clients/commits` and partial-failure envelopes.
- 2026-02-17: Added merged `events`, `event detail`, `event payload`, and `operations` endpoints with federated IDs.
- 2026-02-17: Added detail-route compatibility for local numeric event IDs when a single instance filter is present.
- 2026-02-17: Added `/console/events/live` fan-in across selected downstream instances.
- 2026-02-17: Added console instance context hook and top-nav instance selector in `apps/console`.
- 2026-02-17: Updated console read hooks/live stream to include `instanceId` filter automatically.
- 2026-02-17: Added merged `/console/stats/timeseries` and `/console/stats/latency` gateway endpoints.
- 2026-02-17: Updated Stream page for federated IDs, source labels, and cross-instance commit drill-through.
- 2026-02-17: Added gateway passthrough routes for non-federated console endpoints (`handlers`, prune/compact/notify, event clear/prune, API keys, client eviction) with explicit single-instance guardrails.
- 2026-02-17: Updated console mutation/config hooks to forward selected `instanceId` so gateway write paths resolve to one downstream instance.
- 2026-02-17: Added gateway tests in `packages/server-hono/src/__tests__/console-gateway-routes.test.ts` (merge, filtering, partial failure, all-downstream-failed behavior).
- 2026-02-17: Added websocket fan-in tests in `packages/server-hono/src/__tests__/console-gateway-live-routes.test.ts` covering event fan-in, auth rejection, no-instance rejection, and per-instance degradation signaling.
- 2026-02-17: Added gateway setup documentation/examples in `apps/docs/content/docs/build/operations.mdx` and operator auth notes in `apps/docs/content/docs/console/connect-and-auth.mdx`.
- 2026-02-17: Added `/console/instances/health` endpoint with per-instance health/status/reason/latency metadata and instance filters.
- 2026-02-17: Added route tests for `/console/instances/health` (partial failure, filter behavior, no-match validation).
- 2026-02-17: Exported gateway APIs via `packages/server-hono/src/console/index.ts`.
- 2026-02-17: Verified with `bun test packages/server-hono/src/__tests__` and package-level type checks.
- 2026-02-17: Ran full repo checks: `bun check:fix`, `bun test`, docs build, and package-level type checks.

## Next

- Optional: Add active websocket stream health metadata per instance in `/console/instances/health` (for realtime readiness, not just HTTP route probes).
