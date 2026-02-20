# RFC 0005: Console Gateway for Multi-Instance Federation

Status: Draft  
Authors: Syncular maintainers  
Created: 2026-02-17  
Discussion: TBD

## Summary

Add a console gateway mode that lets one Console session aggregate data from multiple Syncular instances.

Primary target deployment:

- Same operator auth token across instances.
- Same client identities across instances.
- Different instance base URLs (or different path prefixes on one host).

The gateway fans out console read queries to configured instances, merges responses into one normalized stream, and enforces explicit target selection for write operations.

## Motivation

Some deployments run multiple Syncular instances per customer or environment slice (for example feature-oriented sync domains, isolated storage backends, or phased migrations). The current console assumes one backend connection and cannot show a unified operational view.

Operators need:

- one place to triage incidents across feature instances
- one timeline across instance boundaries
- safe operations that avoid accidental multi-instance destructive actions

## Goals

- Allow one Console to query and visualize multiple instances as one federated view.
- Preserve existing console APIs for single-instance use.
- Support shared-token deployments by default.
- Support instances on different hosts or different paths on one host.
- Add explicit source identity to all federated entities.
- Keep mutation operations safe and explicit.

## Non-Goals

- Cross-instance transactional guarantees.
- Cross-instance sequence unification (no global commit sequence rewrite in v1).
- Automatic multi-instance writes for prune/compact/evict/API key changes in v1.
- Replacing instance-local console APIs.

## Terminology

- Instance: one Syncular backend exposing `/console/*`.
- Gateway: process that federates multiple instances for one Console session.
- Source identity: stable `instanceId` attached to federated records.
- Federated view: merged result of multiple instance reads.

## Proposal

### 1. Gateway Deployment Model

Introduce a gateway component as either:

- a dedicated service, or
- a mode of `@syncular/server-hono` mounted as `createConsoleGatewayRoutes(...)`.

The UI connects to exactly one gateway URL/token. The gateway handles downstream fan-out.

### 2. Instance Registry

The gateway is configured with named downstream targets:

- `instanceId` (stable slug)
- `label` (human-readable)
- `baseUrl` (supports host or path variance)
- optional per-instance token override
- enabled/disabled flag

Default auth behavior: if per-instance token is omitted, forward the inbound console bearer token to that instance.

This directly supports the common case:

- same token
- same client IDs
- different base URLs or path prefixes

Example config:

```yaml
instances:
  - instanceId: feature-a
    label: Feature A
    baseUrl: https://api.acme.dev/feature-a
  - instanceId: feature-b
    label: Feature B
    baseUrl: https://api.acme.dev/feature-b
```

### 3. Federated Read Semantics

Federate read endpoints first:

- `GET /console/stats`
- `GET /console/stats/timeseries`
- `GET /console/stats/latency`
- `GET /console/timeline`
- `GET /console/commits`
- `GET /console/clients`
- `GET /console/events`
- `GET /console/events/:id`
- `GET /console/events/:id/payload`
- `GET /console/operations`

All federated rows include `instanceId`.

ID collision strategy:

- Canonical federated id is namespaced as `<instanceId>:<localId>`.
- Local numeric ids (`eventId`, `operationId`) are preserved as `localEventId`, `localOperationId` where needed.

Client/commit identity strategy:

- Expose `instanceId` + local identity together.
- Do not assume `clientId` is globally unique.

### 4. Merge Rules

#### Stats

- Sum additive fields (`commitCount`, `changeCount`, `clientCount`, `activeClientCount`).
- Do not present single global commit cursor as canonical truth.
- Add source-aware fields:
  - `maxCommitSeqByInstance: Record<string, number>`
  - `minCommitSeqByInstance: Record<string, number>`

#### Timeline and Events

- Merge by `timestamp DESC`.
- Stable tie-breaker: `instanceId`, then local id.
- Pagination is applied after merge (gateway-level paging).

#### Clients

- Return one row per `(instanceId, clientId)`.
- Include derived key `federatedClientId = "<instanceId>:<clientId>"`.

#### Commits

- Return one row per `(instanceId, commitSeq)`.
- Include `federatedCommitId = "<instanceId>:<commitSeq>"`.

### 5. Mutation Semantics

Mutations remain single-instance in v1. Gateway rejects ambiguous writes.

Affected endpoints:

- `POST /console/prune`
- `POST /console/compact`
- `POST /console/notify-data-change`
- `DELETE /console/clients/:id`
- API key create/revoke/rotate endpoints

Rules:

- Request must include explicit `instanceId`.
- If missing and multiple instances are selected, return `400` with actionable error.
- Optional future mode can batch across instances with explicit confirmation, but not in v1.

### 6. Instance Filtering

Add query filter:

- `instanceId` (single)
- `instanceIds` (multi-value)

Filter is gateway-side and applies before merge finalization.

Existing `partitionId` behavior is preserved and forwarded to each selected instance.

### 7. Live Events Fan-In

Gateway opens downstream `/console/events/live` connections and republishes one federated stream:

- each emitted event is tagged with `instanceId`
- replay behavior preserves per-instance ordering, then merges on timestamp
- backpressure and reconnection are handled per downstream connection

If one instance stream fails, gateway marks it degraded but keeps others live.

### 8. Error and Degradation Model

Federated responses include partial-failure metadata:

- `partial: boolean`
- `failedInstances: Array<{ instanceId: string; reason: string }>`

Reads return `200` with partial metadata when at least one instance succeeds.
Reads return error only when all selected instances fail.

### 9. UI Changes (apps/console)

Add source context to connection/config:

- profile of downstream instances (managed by gateway API)
- instance selector in top nav (similar to partition selector)
- source badges in timeline/clients/commits

Safety UX:

- operations pages require selecting one target instance before enabling destructive actions
- confirmation dialogs must show instance label + id

### 10. API Shape Additions

Gateway-only helper endpoints:

- `GET /console/instances` (discover configured targets + health)
- `GET /console/instances/health` (optional detailed probe)

Federated type extensions:

- `instanceId: string` on timeline/event/commit/client/operation rows
- optional federated ids as described above
- partial failure envelope metadata on paginated and stats responses

### 11. Security Model

- Operator authenticates only to gateway.
- Gateway forwards operator token by default.
- Optional per-instance service token overrides are supported for heterogeneous auth.
- Gateway must never expose downstream tokens to browser clients.
- Audit log entries for gateway mutations include both `consoleUserId` and `instanceId`.

## Implementation Plan

### Phase 1: Backend Federation Core

- Add `createConsoleGatewayRoutes` in `packages/server-hono`.
- Implement federated `stats`, `timeline`, `clients`, and `commits`.
- Add instance registry and health checks.

### Phase 2: Live Stream + Partial Failure Contracts

- Federated live event stream with per-instance reconnect.
- Partial-failure response metadata and UI surfacing.
- Detail endpoints (`events/:id`, payload, operations) federated via namespaced ids.

### Phase 3: Console UX Completion

- Instance filter controls in `apps/console`.
- Source tagging across all grids/details.
- Mutation guardrails requiring explicit instance target.

## Alternatives Considered

### A. Browser-side fan-out only

Rejected as primary approach. It creates CORS/auth complexity, leaks topology details to the browser, and makes audit/rate-limit behavior inconsistent.

### B. Force all features into one partitioned instance

Useful when feasible, but not always possible due to topology, scale, migration phases, or operational isolation requirements.

### C. Cross-instance write fan-out from day one

Rejected for v1 safety. High risk of accidental destructive actions across environments/features.

## Open Questions

- Should gateway expose per-instance latency and freshness indicators in all responses?
- Should we support per-instance auth strategy selection beyond bearer forwarding in v1?
- Do we need cursor-based pagination for federated timeline immediately, or is offset acceptable initially?
- Should federated stats include an explicit "global head approximation" field, or avoid it entirely?

## Acceptance Criteria

- Operators can connect one Console to a gateway and see merged timeline/client/commit/stats across at least two instances.
- Shared-token, multi-baseUrl/path deployment works without per-instance token configuration.
- Every federated record shows source `instanceId`.
- Mutations cannot execute without explicit single-instance targeting.
- Partial downstream outages degrade gracefully with visible metadata rather than full console failure.
