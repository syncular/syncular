# RFC 0004: Console Rework as Operations and Forensics Control Plane

Status: Draft  
Authors: Syncular maintainers  
Created: 2026-02-16  
Discussion: TBD

## Summary

Rework the Syncular console from a mostly static dashboard into a high-signal control plane for operators and developers:

- Reliable connection/auth UX.
- Real-time, correlated sync telemetry.
- Commit/request payload investigation workflows.
- Safe operations controls (prune, compact, notify-data-change, targeted evictions).
- Tenant/partition-aware filtering.

This RFC intentionally allows breaking console API/UI contracts where needed. Syncular is alpha and optimization for operator usefulness takes priority over backward compatibility.

## Motivation

Current console foundations are useful but not operationally sufficient:

- Core metrics contain placeholders or misleading values.
- Live feed plumbing exists but does not receive emitted events.
- Investigation endpoints exist on the backend but are not surfaced in UI workflows.
- Pagination/filter behavior in stream mode is not semantically correct for merged timelines.
- Preferences/config are not fully wired to query behavior.
- Event schema is too shallow for payload/trace-level incident investigation.

The result is a UI that looks like observability but does not yet support fast root-cause workflows.

## Goals

- Make the console the fastest path to answer:
  - "What broke?"
  - "Who is affected?"
  - "What exact payload was processed?"
  - "What should I do now?"
- Support real incident workflows end-to-end without leaving the product for first-pass analysis.
- Provide correctness-first metrics and filtering semantics.
- Add explicit partition/tenant filtering to all key data views.
- Make operations safe with previews, guardrails, and audit events.
- Establish test coverage for critical console behavior.

## Non-Goals

- Full long-term SLO/alerting platform replacement (Datadog/Grafana/Sentry remain complementary).
- Generic BI/reporting.
- Broad role-based access control system redesign in this RFC (we define hooks and boundaries, not full IAM).

## User Workflows to Optimize

1. Incident triage (spike in failed syncs).
2. Payload forensics (conflict/reject/error on specific operation).
3. Client health diagnostics (lagging/offline/realtime disconnect behavior).
4. External import recovery (notify-data-change and re-bootstrap validation).
5. Key management hygiene (rotation/revocation/expiry/last-use analysis).

## Current-State Gaps (Implementation Audit)

### Product/UX

- Connection form cannot actually persist/connect with edited values.
- Disconnect can auto-reconnect due to retained config.
- Stream "all mode" merges two paged datasets incorrectly.
- Multiple preferences are saved but not applied.
- Useful backend details (commit/event detail) are not interactive in UI.
- Live feed is visually present but effectively inert.

### Data/Backend

- Request events table is missing correlation fields required for deep forensics.
- Console reads are not partition-aware by default.
- Time-series/latency endpoints do large in-memory aggregation from raw events.
- Console live event emitter is not integrated into sync route event lifecycle.

### Quality/Docs

- Minimal tests for console routes and no dedicated frontend tests for console workflows.
- Docs examples and naming diverge from current UI/API semantics.

## Proposal

## 1) Product Information Architecture

Replace current mental model ("Command/Stream/Fleet/Ops/Config") with investigation-first surfaces:

- `Overview`
  - True windowed metrics.
  - Realtime health summary.
  - Fast links into active incidents.
- `Investigate`
  - Unified timeline of commits + request events.
  - Faceted filters and saved views.
  - Click-through drawers for payload-level details.
- `Clients`
  - Fleet health, lag cohorts, realtime/polling state, targeted actions.
- `Operations`
  - Prune/compact/notify-data-change/evict with previews and safety rails.
- `Access`
  - API key lifecycle (active, revoked, expiring, last-used) and rotation workflows.
- `Settings`
  - Connection and console preferences that are fully effective.

Compatibility note: old route paths may be kept temporarily with redirects, but the primary navigation model changes.

## 2) Connection and Session Model

### Required behavior

- `Save + Connect` explicit action in connection form.
- `Disconnect` clears active connection state and can optionally clear persisted creds.
- URL `server/token` bootstrap still supported, but with explicit persistence behavior.

### Security improvements

- Remove long-lived token-in-query dependency for console WS.
- Preferred flow:
  - `POST /console/ws-ticket` (short-lived signed ticket).
  - `GET /console/events/live?ticket=...`.
- Keep query token only as transitional fallback behind config flag.

## 3) Investigation Data Model

Extend console event records to support correlation and payload forensics.

### New/extended event fields (proposed)

- `partition_id`
- `request_id`
- `trace_id`
- `span_id`
- `sync_path` (`http-combined`, `ws-push`, future variants)
- `response_status` (existing outcome + normalized category)
- `error_code`
- `subscription_count` (pull)
- `scopes_summary` (small normalized summary)
- `payload_ref` (pointer to optional retained payload snapshot)

### Payload retention strategy

- Store lightweight snapshots by default (bounded size).
- Large payloads offloaded to blob storage via `payload_ref`.
- Configurable retention policy:
  - duration-based
  - count-based
  - optional sampling

## 4) Unified Timeline Semantics

Create a single backend timeline endpoint for correct paging/filtering:

- `GET /console/timeline`
  - Server-side merged/sorted items (commit + request-event records).
  - Cursor-based or stable offset paging.
  - Shared filter model (`partition`, `actor`, `client`, `table`, `outcome`, `time range`, `request_id`, `trace_id`).

This replaces client-side page merge behavior from separate commits/events lists in "all" mode.

## 5) Payload Investigation UX

### Commit detail panel

- Full change list with:
  - row id, op, row version, scopes
  - JSON viewer for `rowJson`
  - change diff view for upserts

### Request event detail panel

- Request metadata + latency breakdown.
- Error code/message and normalized failure reason.
- Linked commit (if present).
- Linked trace (Sentry/OpenTelemetry deep-link).
- Linked payload snapshot (if retained).

### Drill-in interactions

- Every timeline row is clickable.
- Deep-linkable URLs:
  - `/investigate/commit/:seq`
  - `/investigate/event/:id`

## 6) Metrics and Observability Integration

### Correctness-first metrics

- Remove hardcoded values (`error rate`, `success rate`, `OPS/S`).
- Compute windowed KPIs from event windows, not lifetime totals.
- Align all range toggles to query inputs.

### Correlation with external observability

- If Sentry/OpenTelemetry is configured:
  - attach `trace_id/span_id` in event records
  - provide outbound deep-links in detail panels
- Keep console useful even without external backend.

### Aggregation strategy

- Introduce aggregated metrics tables/materialized views for high-volume deployments.
- Keep raw event fallback for local/dev mode.

## 7) Realtime Event Pipeline

### Required

- Wire sync route lifecycle to console event emitter for:
  - `push`
  - `pull`
  - `commit`
  - `client_update`
- Ensure consistent event envelopes and versioned schema.

### Delivery model

- Reconnect/backoff support in client.
- Heartbeat + liveness indicator.
- Optional server-side ring buffer replay on reconnect (small recent window).

## 8) Partition/Tenant-Aware Console

All key list/detail endpoints accept explicit partition filter:

- `partitionId` optional but first-class.
- UI always shows active partition context.
- In multi-partition deployments, default to explicit partition selection (not implicit global view).

For single-tenant local/demo use, defaults remain simple.

## 9) Operations Controls Rework

### Prune/Compact

- Keep existing preview-first pattern.
- Add:
  - expected impact estimates
  - partition scope selector
  - operation audit row and timestamp

### Notify Data Change

- Promote from hidden backend endpoint to first-class UI action.
- Require table selection and explicit confirmation.
- Show result details (`commitSeq`, `deletedChunks`, affected tables).

### Client Eviction

- Support:
  - single client
  - filtered bulk eviction (with strict confirmation)

## 10) API Keys UX + Controls

Expose existing backend key metadata and add missing controls:

- visible columns: type, prefix, actor, created, expires, last used, revoked state.
- create flow includes optional `expiresInDays`.
- filters: active/revoked/expiring soon/type.
- bulk revoke and staged rotate support (where safe).

## 11) Documentation and Naming Cleanup

Update docs to match implemented UI and endpoint contracts:

- Console tab/page naming.
- Investigation flows and deep-link paths.
- API examples (`validateApiKey` signatures and returned fields).
- Demo docs (built-in console route vs standalone assumptions).

## Implementation Plan

## Phase 0: Foundations and Safety (1 sprint)

- Finalize RFC and schema contract changes.
- Add feature flags for transitional behavior:
  - legacy WS token query auth
  - legacy stream route mode
- Add migration scaffolding for console event schema/table changes.

Deliverables:

- finalized OpenAPI delta draft
- DB migration plan for Postgres + SQLite dialects
- test plan approved

## Phase 1: Correctness Fixes (1 sprint)

- Fix connection UX and state machine.
- Remove hardcoded KPI placeholders.
- Wire preferences to real query behavior.
- Fix stream pagination semantics via unified timeline backend endpoint.

Deliverables:

- functional Save/Connect/Disconnect behavior
- accurate Overview KPIs
- timeline endpoint + UI adoption

## Phase 2: Investigation Core (1-2 sprints)

- Implement commit/event detail drawers.
- Add correlation fields (`request_id`, `trace_id`, etc.).
- Add payload snapshot references and viewer.
- Enable deep links from timeline rows.

Deliverables:

- first-class payload forensics workflow
- trace-linked diagnostics path

## Phase 3: Realtime + Operations (1 sprint)

- Wire console live emitter from sync route lifecycle.
- Promote notify-data-change to UI.
- Extend operations controls with scope, previews, and audit rows.

Deliverables:

- live feed with real events
- operations panel usable during incidents

## Phase 4: Scale + Hardening (1 sprint)

- Aggregated metrics path for high-volume environments.
- Partition-aware defaults across API/UI.
- finalize docs and examples.
- reliability and load testing on timeline/metrics endpoints.

Deliverables:

- production-grade performance posture
- docs and API references aligned

## Testing Strategy

## Backend

- Add dedicated console route tests:
  - timeline paging correctness
  - filter semantics
  - partition isolation
  - notify-data-change behavior
  - WS ticket auth and fallback behavior
- Add emitter integration tests ensuring live events are published from sync lifecycle.
- Add migration tests for Postgres/SQLite console schema updates.

## Frontend

- Add component + integration tests for:
  - connection lifecycle
  - timeline filters + paging
  - detail panel rendering for commits/events
  - operations confirmation flows

## E2E / Runtime

- Add demo-driven scenario tests:
  - induced push failure -> investigate -> payload/trace navigation
  - external data change notify -> client wakeup -> observable result
  - key rotate/revoke lifecycle

## Rollout and Migration

- Alpha reset policy (current): environments may be reset between releases, and preserving legacy console data is not required.
- Keep additive/idempotent schema evolution paths (`ALTER ... IF NOT EXISTS`) to avoid breakage from stale local/staging databases.
- Keep migration tests lightweight during alpha:
  - one upgrade smoke test per dialect for console schema (`ensureConsoleSchema`) and critical added columns
  - no broad historical backfill matrix until persistent production environments exist
- Cut over UI to new endpoints once parity checks pass.
- Remove legacy code paths after one release cycle.

Because this is alpha, breaking console route/UI contracts is acceptable with clear release notes and docs updates.

## Implementation Update (2026-02-16)

Partition-aware baseline has now been implemented for the rework:

- Console API supports optional `partitionId` filtering across key read paths:
  - `/console/stats`
  - `/console/stats/timeseries`
  - `/console/stats/latency`
  - `/console/timeline`
  - `/console/commits`
  - `/console/clients`
  - `/console/events`
  - `/console/operations`
- Detail/forensics endpoints accept partition guards to enforce scoped lookups:
  - `/console/commits/:seq`
  - `/console/events/:id`
  - `/console/events/:id/payload`
- Client eviction now supports partition-scoped deletion:
  - `DELETE /console/clients/:id?partitionId=...`
- Live stream replay and delivery now support partition filtering via `partitionId`.
- Console UI has a persistent global partition context control (top navigation), and key views are wired to it (Command, Stream, Fleet, Ops).
- Backend tests now cover partition isolation and partition-scoped detail/eviction behavior.
- Metrics scalability baseline is implemented:
  - configurable aggregation strategy (`raw`, `aggregated`, `auto`) for stats routes
  - DB-level timeseries aggregation path on Postgres/SQLite
  - DB-level latency percentile aggregation path on Postgres
  - raw-event fallback retained for local/dev and unsupported paths

## Risks

- Event schema growth can increase write volume and storage.
- Payload retention can create sensitive-data exposure risk if not bounded/redacted.
- Cross-dialect feature parity may slow rollout if migrations diverge.
- Unified timeline endpoint can become a hotspot without indexing and pagination discipline.

## Mitigations

- Configurable retention and payload capture policies.
- Redaction hooks before payload persistence.
- Explicit index design and query plans per dialect.
- Feature-flagged rollout and back-pressure controls.

## Open Questions

- Should payload snapshots be opt-in per endpoint/environment by default?
- Should timeline paging be cursor-only (recommended) or support offset for compatibility?
- What minimum RBAC model is required for destructive operations in the first release?
- Do we standardize on Sentry link format only, or generic trace provider adapters in v1?

## Acceptance Criteria

- Console connection UX is deterministic and fully functional.
- Live feed shows actual emitted sync events (not just heartbeats).
- Operators can investigate a failed event down to payload and linked commit in <60 seconds.
- Overview metrics are computed, windowed, and not hardcoded.
- Timeline paging/filter semantics are correct and test-covered.
- Notify-data-change is available and safe from the UI.
- Partition-aware filtering is available across key investigation and operations views.
- Docs and OpenAPI examples reflect the shipped behavior.
