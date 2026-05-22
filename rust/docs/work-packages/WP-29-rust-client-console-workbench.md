# WP-29 Rust Client Console Workbench

Status: `[~] Slice 1 persistence retained; browser smoke still pending`

## Goal

Turn the console from a collection of useful debug pages into a Rust-client
workbench that can explain, with evidence, what happened to a client, a row, a
subscription, a sync attempt, a realtime wakeup, an artifact apply, a blob
upload, or a local repair decision.

The console should answer product questions a developer or operator actually
has while running a Syncular app:

1. Is the fleet healthy right now?
2. What is this client doing locally, and is its runtime state fresh?
3. Why is this row missing, stale, conflicted, revoked, or different locally?
4. What happened during this sync attempt across client, server, realtime, and
   artifact paths?
5. Which recovery action is safe, which action is manual-only, and why?
6. What redacted evidence can be shared with support without exposing app data?

This WP is deliberately Rust-client-first. The console should not be a nostalgic
server admin panel for the old JavaScript client shape, and it should not grow
legacy protocol branches to make old behavior look healthy.

## Fresh Read

The current console has strong raw material:

- `Command`, `Stream`, `Fleet`, `ClientDetails`, `RowInvestigation`, `Ops`,
  `Storage`, and `Config` pages exist as separate tools.
- Server routes expose stats, timeline, commits, row history, clients, handlers,
  operations, request events, payload references, API keys, storage, and the new
  client diagnostics endpoint.
- The Rust client surface already exposes diagnostic snapshots, lifecycle state,
  transport stats, live query diagnostics, local health checks, explicit repair
  commands, reset/rebootstrap commands, command history, and redacted support
  bundles.
- The demo can now publish in-memory diagnostic snapshots for two local clients,
  and the console can show a client detail page with Rust runtime evidence.

The product gap is not a missing page. It is missing correlation and workflow.
Today a developer still has to mentally join several views:

- Fleet health and per-client runtime evidence are separate from Stream events.
- Stream events are searchable, but not shaped as a sync-attempt waterfall.
- Row investigation has good server evidence, but it does not yet bring in
  client-local health, diagnostic snapshots, subscription coverage, and recent
  attempts as one investigation.
- Local repair and support-bundle surfaces exist in the client API, but the
  console does not guide operators from a finding to a safe action.
- Client diagnostics are currently latest/in-memory for the local demo path, not
  a retained, redacted history that can explain regressions after the fact.
- Failure playground coverage is thin. The demo should seed credible healthy and
  broken states so the console can be validated as a real support tool.

The fresh conclusion: the console should become an evidence workbench organized
around investigations, not only a dashboard of server tables.

## Product Principles

- Evidence before action. A recovery button is only shown after the console can
  show the finding, source, freshness, affected scope, and why the action is
  safe or manual-only.
- Stable codes before messages. Tests and support runbooks should key on error,
  diagnostic, health, operation, and event codes instead of human text.
- Deep links everywhere. A support exchange should include a URL to the fleet
  filter, client, sync attempt, row investigation, request event, or operation.
- Freshness is first-class. Every client-local fact shown by the console needs
  reported-at, received-at, age, staleness, and source information.
- Redaction is visible. The UI should show that scope values, params, auth
  headers, row payloads, encryption material, CRDT update bodies, and support
  bundle secrets were not captured.
- Scoped access remains the model. Console convenience cannot weaken server
  authority, scoped subscription semantics, verification, or revocation clearing.
- Dense operator UI. The console is a work surface for repeated investigation,
  not a marketing page or a decorative overview.

## Scope

- Persisted redacted client diagnostic snapshot history:
  - partition, client id, actor id, runtime version, schema version, storage
    mode, lifecycle phase, transport state, queue summaries, recent diagnostic
    codes, recent timing buckets, bootstrap/artifact summary, and freshness;
  - size-bounded details with explicit redaction markers;
  - retention, pruning, and stale-client status;
  - latest snapshot helpers for Fleet and ClientDetails.
- Sync-attempt workbench:
  - group server request events, client diagnostic events, realtime wakeups,
    artifact downloads/applies, local apply results, request ids, trace/span ids,
    and operation outcomes by `syncAttemptId` where available;
  - fall back to time-window proximity only as a labeled investigation hint, not
    as authoritative causality;
  - show the full path as a compact waterfall with duration and outcome.
- Unified row/client investigation:
  - row history, latest server row state, subscription coverage, scope
    eligibility, request events, realtime events, local health findings, and
    client diagnostic snapshots in one flow;
  - links from row to client, attempt, subscription, request event, commit, and
    operation records;
  - no raw app payload capture by default.
- Local health and support-bundle console surfaces:
  - display `LocalHealthReport` findings with severity, code, component, message,
    repair action, and redacted detail shape;
  - ingest or open redacted support bundles for offline inspection;
  - compare a support bundle with current server evidence where partition/client
    ids are present and not redacted.
- Safe operations and recovery:
  - separate server operations from client-local repair/reset recommendations;
  - map repair actions to explicit runbooks or opt-in client commands;
  - require confirmations for destructive server operations and for any future
    client repair command path;
  - keep operation audit entries connected to diagnostics and support bundles.
- URL-addressable filters and exports:
  - Stream search tokens, fleet filters, selected event ids, selected client ids,
    selected row ids, selected attempt ids, and time ranges should survive reload;
  - export a redacted investigation bundle containing links, codes, timings,
    freshness, and summaries but no sensitive app data.
- Demo and testkit scenarios:
  - seed healthy, stale, reconnecting, artifact-recovered, scope-revoked,
    corrupted-local-root, pending-outbox, failed-blob-upload, and conflict/manual
    inspection examples;
  - make scenarios resettable and deterministic enough for Playwright and route
    tests.

## Non-Scope

- No compatibility branch for old JavaScript client protocol behavior.
- No arbitrary SQL console for synced writes.
- No raw app payload, encrypted plaintext, auth token, secret scope value,
  support-bundle secret, or CRDT update-body capture by default.
- No console-side authority to decide what a client should be allowed to see.
- No weakening of scoped access, verification, cursor advancement, artifact
  validation, blob integrity, or revocation clearing to make an investigation
  easier.
- No silent local repair. Client-local repair/reset remains explicit,
  fail-closed, and app/user initiated.
- No remote client command channel in the first implementation slice. Start with
  evidence, support bundles, and generated runbooks; add remote execution only
  through a later opt-in control-plane WP if the product need is proven.
- No long-lived fallback from persisted diagnostics to in-memory diagnostics in
  production. The in-memory demo endpoint can stay as a local demo transport, but
  production console behavior should have one retained persisted path.

## Investigation Workflows

### Fleet Triage

The first screen should answer whether the install is healthy:

- client count by lifecycle phase and freshness;
- stale, disconnected, reconnecting, bootstrapping, applying, and failed counts;
- top diagnostic/health codes in the selected time range;
- runtime/package/schema version spread;
- storage mode spread and fallback counts;
- queue pressure for outbox, conflicts, blobs, realtime backlog, and local apply;
- links to filtered client lists and matching stream events.

Fleet rows should be inspectable without losing context. The primary action is a
client drilldown with the current filters preserved in the URL.

### Client Drilldown

The client page should read like an evidence record:

- identity and freshness: partition, client id, actor id, runtime kind, version,
  reported-at, received-at, and stale age;
- lifecycle and transport: current phase, websocket state, reconnect schedule,
  ACK/overflow evidence, HTTP recovery counts, and last errors;
- subscriptions: configured ids, server cursor, local cursor, verified root
  summary, scope summary, and revocation/coverage evidence;
- sync timing: recent push/pull/apply/artifact buckets with p50/p95-like
  summaries where available;
- queues: outbox, conflicts, blob uploads, CRDT metadata hazards, and failed
  operations;
- health: latest findings and recommended repair actions;
- history: previous snapshots and changed fields so regressions are visible.

### Sync Attempt Workbench

An attempt view should show a single correlated path:

- client event start, push/pull/realtime/artifact direction, request event ids,
  trace/span ids, server handler decision, auth/scope summary, response shape,
  artifact/chunk reference, realtime wakeup, local verify/apply, and final
  lifecycle state;
- durations for client prepare, network/server, artifact download, verification,
  local apply, live query refresh, and recovery pull;
- outcome classification: success, rejected, retrying, pull-required,
  artifact-recovered, integrity-rejected, auth-expired, scope-revoked,
  local-health-blocked, or manual-inspection.

The workbench should be explicit when data is missing:

- "no client snapshot retained for this attempt";
- "server event has no syncAttemptId";
- "joined by time-window hint only";
- "support bundle imported after the event, freshness unavailable".

### Row Investigation

The row investigation should become the answer to "why is my UI wrong?":

- current server row state summary and row history;
- whether the selected client had a subscription that should cover the row at
  each relevant time;
- commits and request events that created, changed, revoked, or cleared the row;
- client snapshots and attempts around those commits;
- realtime events and pull-required recovery evidence;
- local health findings that could explain missing/stale data;
- conflict, command-history, blob, and CRDT metadata evidence when relevant.

The row page should not make the user choose between "server truth" and "client
truth". It should show what each side can prove, and label every gap.

### Operations And Recovery

Operations should be grouped by risk and authority:

- server maintenance: prune events, compact storage, notify data change, API key
  rotation/revoke, storage object deletion, and audits;
- client-local recovery recommendations: force rebootstrap, clear orphaned
  state, clear orphaned synced rows, reset selected subscriptions, export support
  bundle, manual inspection;
- scenario/debug operations in demo only.

Client repair actions should be suggested from health findings, not exposed as a
general button set. If a finding is `manualInspection`, the console should say
that no automated repair is safe and link to the evidence.

## Data Model And API Shape

The first production shape should add persisted console tables or dialect-backed
helpers for client diagnostics without changing the sync protocol:

- `sync_client_diagnostic_snapshots`
  - `partition_id`
  - `client_id`
  - `actor_id`
  - `runtime_kind`
  - `runtime_version`
  - `schema_version`
  - `reported_at`
  - `received_at`
  - `lifecycle_phase`
  - `connection_state`
  - `freshness_state`
  - `health_max_severity`
  - `diagnostic_codes_summary`
  - `queue_summary`
  - `timing_summary`
  - `redaction_summary`
  - `snapshot_json`
- `sync_client_health_reports`
  - optional normalized latest finding rows for filtering and fleet summaries;
  - keep raw details redacted and size-bounded.
- `sync_client_support_bundles`
  - optional imported bundle metadata and validation summary;
  - store bundle bodies only when explicitly uploaded and size-bounded;
  - default path may be inspect-only without persistence.
- `sync_attempt_summary`
  - initially a derived API view over request events and client snapshots;
  - only make it a table if route performance or retention requirements prove
    that materialization is needed.

API additions should be typed and redacted:

- `POST /console/client-diagnostics`
  - promote from demo in-memory ingestion to persisted ingestion where the
    configured console storage supports it;
  - reject oversized snapshots and unredacted bundle-like fields.
- `GET /console/client-diagnostics`
  - return latest plus freshness and health summaries;
  - support filters for client id, actor id, runtime version, lifecycle phase,
    health severity, diagnostic code, and stale age.
- `GET /console/client-diagnostics/:clientId/history`
  - page retained snapshots and changed-field summaries.
- `GET /console/attempts`
  - group attempts by time range, client id, outcome, syncAttemptId, trace id,
    request id, table, and diagnostic code.
- `GET /console/attempts/:syncAttemptId`
  - return joined evidence and explicit missing-data markers.
- `POST /console/support-bundles/inspect`
  - validate and summarize a redacted support bundle without mutating state.

## Implementation Slices

### Slice 0: Baseline Inventory And Scenario Design

- Record the current console surfaces and route capabilities in this WP.
- Choose deterministic demo failure scenarios and expected console evidence.
- Add a short scenario matrix to the demo docs or test fixture comments.
- No behavior change required.

### Slice 1: Persisted Diagnostic Snapshot History

- Add dialect/server helpers for retained, redacted client diagnostic snapshots.
- Keep the current demo publishing path, but store snapshots through the same
  console ingestion API used by production.
- Add stale-age and health-severity summaries to Fleet.
- Make ClientDetails read latest/history from the persisted source.
- Add retention/prune behavior and route tests.

### Slice 2: Attempt Correlation Workbench

- Add URL-driven Stream filters and attempt drilldown routes.
- Group server request events, client diagnostics, realtime evidence, and
  artifact evidence by `syncAttemptId`.
- Show missing-correlation markers instead of guessing.
- Add Playwright coverage for a successful attempt and one recovery attempt.

### Slice 3: Local Health And Support Bundles

- Surface latest health findings in ClientDetails and Fleet filters.
- Add support-bundle inspection/import UI for redacted bundles.
- Link health findings to repair guidance and relevant evidence.
- Prove representative secrets remain redacted in route and UI tests.

### Slice 4: Unified Row Investigation

- Fold client diagnostic/health/attempt evidence into RowInvestigation.
- Add row-to-client and client-to-row deep links.
- Connect command history, conflict, blob, and CRDT metadata summaries when
  available.
- Keep raw row payload exposure opt-in and outside the default path.

### Slice 5: Safe Recovery Workbench

- Split server operations from client-local recommended actions.
- Generate explicit repair/reset runbooks from `LocalHealthFinding.repairAction`.
- Keep destructive actions confirmation-gated and audit logged.
- Defer remote repair execution unless a later opt-in control-plane WP proves the
  product need and safety model.

### Slice 6: Demo, Testkit, And Documentation

- Seed healthy and failure states in `apps/demo`.
- Add testkit helpers for corrupted local roots, stale snapshots, scope
  revocation, artifact recovery, pending outbox, failed blob upload, and manual
  inspection findings.
- Document the console investigation flow as a support workflow, not as protocol
  compatibility guidance.

## Acceptance Criteria

- Fleet can identify unhealthy, stale, reconnecting, bootstrapping, applying,
  and failed clients with stable diagnostic/health codes.
- ClientDetails shows latest and historical redacted Rust-client snapshots with
  reported-at, received-at, age, source, runtime version, lifecycle, transport,
  subscriptions, queue summaries, health findings, and timing evidence.
- Stream and the attempt workbench can open a URL for a `syncAttemptId` and show
  client evidence, server request events, realtime/artifact evidence, timings,
  outcome, and explicit missing-data markers.
- Row investigation answers "why missing/stale/conflicted/revoked?" by joining
  row history, subscription/scope eligibility, client snapshots, attempts,
  realtime events, local health findings, and relevant queue/conflict/blob/CRDT
  summaries.
- Support-bundle inspection rejects unredacted bundles and never mutates live
  state.
- Repair guidance is generated from health findings and preserves the WP-20
  explicit/fail-closed repair contract.
- Console filters and selected entities are URL-addressable and reload-safe.
- Demo scenarios cover at least one healthy client, one stale client, one
  realtime recovery, one artifact recovery, one local-health finding, one pending
  outbox blocker, and one manual-inspection case.
- Tests assert stable codes and redaction behavior; no test parses
  human-readable diagnostic messages as the source of truth.

## Required Gates

- Server/console route coverage when persisted diagnostics, attempts, support
  bundle inspection, or operation APIs change:
  - `bun test packages/server-hono/src/__tests__/console-routes.test.ts packages/server-hono/src/__tests__/create-server.test.ts`
- TypeScript gates for changed surfaces:
  - `bun --cwd packages/server-hono tsgo`
  - `bun --cwd packages/console tsgo`
  - `bun --cwd packages/ui tsgo`
  - `bun --cwd apps/demo tsgo`
- Client/WASM gates when diagnostic, health, support-bundle, reset, or
  live-query payloads change:
  - `bun test packages/client/src/__tests__/sync-hono.wasm.test.ts packages/client/src/__tests__/realtime-hono.wasm.test.ts`
- Runtime/native gates when Rust diagnostic or support-bundle structures change:
  - `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test store_backends --features native,crdt-yjs,demo-todo-native-fixture`
  - `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_facade --features native,crdt-yjs,demo-todo-native-fixture`
- Conformance/testkit gate when generated client contracts, fixtures, or failure
  scenarios change:
  - `bun run rust:conformance:fast`
- Browser verification for console UX slices:
  - open `/fleet`, one `/fleet/:clientId`, `/stream`, one attempt route, and one
    row investigation route;
  - assert no browser console errors or warnings unrelated to the known React dev
    tools hint/HMR noise;
  - verify filters survive reload and deep links.
- Performance-sensitive instrumentation:
  - run the relevant external app-style benchmark from `QUALITY_GATES.md` when a
    slice adds instrumentation to hot sync, realtime, artifact, local apply,
    live-query, or support-bundle paths;
  - record before/after evidence in `BENCHMARK_LOG.md` if the path is
    performance-sensitive.

## Accept / Reject Rule

- Retain only work that makes investigation more evidence-based without adding
  protocol fallbacks, legacy JS-client branches, or guessed causality.
- Reject any diagnostic or support path that stores sensitive payloads by
  default or obscures what was redacted.
- Reject UI affordances that imply the console can authorize data, advance
  cursors, repair local state, or rewrite server history without the underlying
  explicit API and audit evidence.
- Reject attempt joins that silently infer causality from timing alone. Time-window
  joins are allowed only as labeled hints.
- Reject repair actions that bypass WP-20 fail-closed local hygiene rules.
- Reject hot-path instrumentation unless its cost is measured and accepted.

## Current Evidence

- WP-13 established the observability product contract: stable diagnostic codes,
  correlation ids, redacted snapshots, console investigation views, and no
  payload capture by default.
- WP-20 added local health checks, explicit repair/reset APIs, scoped synced-row
  hygiene, and redacted support bundle export/import for Rust/native/browser
  clients.
- WP-23 added time-travel/audit inspection foundations that can support row and
  operation investigations.
- WP-24 and WP-12 added blob/artifact evidence that should be visible in attempts
  and row investigations.
- Commit `51643470` added the first console Rust-client diagnostics slice:
  - `POST /console/client-diagnostics` and
    `GET /console/client-diagnostics`;
  - demo publishing for `demo-left` and `demo-right`;
  - Fleet inspect links and `/fleet/:clientId` ClientDetails;
  - tests for diagnostics ingestion/listing and demo wiring;
  - Playwright verification that `/fleet/demo-left` renders Rust runtime
    diagnostics without browser console warnings or errors.
- Slice 1 now has a retained persisted diagnostic-history foundation:
  - SQLite and Postgres console schema creation includes
    `sync_client_diagnostic_snapshots` with partition/client/latest, received-at,
    and health/freshness indexes;
  - `POST /console/client-diagnostics` writes normalized, size-bounded,
    sensitive-key-guarded redacted records to the console table instead of an
    in-memory map;
  - `GET /console/client-diagnostics` returns latest snapshots from storage,
    `GET /console/client-diagnostics/:clientId/history` pages retained history,
    and `GET /console/clients` includes diagnostic freshness, health severity,
    and received-at summaries for Fleet;
  - ClientDetails now reads retained history and shows freshness, health, code
    summaries, and snapshot history without adding any repair controls.
- Gates passed for the retained Slice 1 foundation:
  - `bun test packages/server-hono/src/__tests__/console-routes.test.ts`
  - `bun test packages/server-hono/src/__tests__/console-routes.test.ts packages/server-hono/src/__tests__/create-server.test.ts`
  - `bun test packages/server-dialect-sqlite/src/index.test.ts`
  - `bun test packages/server-hono/src/__tests__/openapi.test.ts packages/console/src/__tests__/api.test.ts`
  - `bun --cwd packages/server-hono tsgo`
  - `bun --cwd packages/console tsgo`
  - `bun --cwd packages/ui tsgo`
  - `bun --cwd apps/demo tsgo`
  - `bun --cwd packages/server-dialect-sqlite tsgo`
  - `bun --cwd packages/server-dialect-postgres tsgo`
  - `bunx biome check` on the touched server, dialect, console, and UI files
  - `git diff --check`
- Browser smoke is the remaining local verification gap for this slice. An
  isolated demo was started on `5174/4102`, but the in-app browser profile was
  already locked by another process and standalone Playwright is not installed
  in this workspace, so `/fleet` and `/fleet/:clientId` still need a browser
  smoke before Slice 1 is marked accepted.
- Remaining evidence gaps:
  - browser UX verification for the retained history UI is still pending;
  - Stream filters are not URL-first and attempts are not a first-class unit;
  - RowInvestigation does not yet include client-local health/support evidence;
  - local repair/reset/support-bundle APIs are not presented as a guided console
    workflow;
  - demo/testkit failure scenarios are not broad enough to validate the console
    as an operator tool.

## Next Action

Finish Slice 1 by running the browser smoke once an isolated browser is
available: open `/fleet`, one `/fleet/:clientId`, and confirm retained runtime
history renders without console errors or layout overlap.

After that, move to Slice 2 only if Slice 1 browser evidence is accepted:
attempt correlation should add explicit missing-data markers rather than
guessing causality from time windows.

Do not begin remote client repair execution in this slice. The console first
needs durable evidence and stable links before it should grow higher-risk
operations.

## Open Decisions

- Production transport: should browser/native apps post diagnostic snapshots
  directly to the existing app server console endpoint, or should diagnostics be
  pushed through a separate support/observability ingestion path?
- Support bundle persistence: should imported bundles be inspect-only by default,
  or should the console store explicit uploaded bundles with retention and
  redaction proofs?
- Attempt materialization: is a derived API over request events and client
  snapshots fast enough, or do larger installs need a retained
  `sync_attempt_summary` table?
- Multi-instance deployments: should the console aggregate diagnostics per app
  instance, per partition, or through a central collector?
- Remote client operations: is there a future opt-in control plane for executing
  local repair/reset commands, or are runbooks and support bundles the safer
  permanent product shape?

## Related Work Packages

- WP-12 Scoped Snapshot Artifacts
- WP-13 Observability And Debuggability
- WP-15 Error Taxonomy And Recovery Semantics
- WP-17 Offline Lifecycle And App State Integration
- WP-20 Local Data Hygiene And Repair
- WP-21 Query Observation And Live Query Precision
- WP-22 Undo/Redo Mutation History
- WP-23 Time Travel And Audit Inspection
- WP-24 Blob Hardening And Production Polish
- WP-26 TypeScript Host Bindings And Platform Bridges
