# WP-13 Observability And Debuggability

Status: `[!]` deferred console drilldowns

## Goal

Make Syncular easy to investigate in real apps by giving developers a
correlated view of client sync attempts, server decisions, realtime delivery,
artifact/bootstrap behavior, local apply, verification, and recovery.

The product promise is that an app developer should be able to answer:

- What did this client ask for?
- What was it authorized to see?
- What did the server send?
- What did the client verify and apply?
- Why did realtime, recovery, scope clearing, or artifact fallback happen?

This must work without attaching a debugger or guessing from app tables.

## Scope

- Stable diagnostic event taxonomy shared by Rust runtime, browser worker,
  native bindings, server routes, and console surfaces.
- End-to-end correlation IDs for push, pull, realtime wakeups, artifact
  downloads, websocket ACKs, and local apply attempts.
- App-facing client diagnostic snapshot/debug bundle with redaction by default.
- Console investigation views for clients, timelines, subscriptions, missing
  rows, recovery events, and sync performance.
- Readiness/health event integration with adaptive bootstrap once WP-05 starts.
- Testkit fault-injection assertions for debuggable failure cases.
- Sentry/OpenTelemetry-friendly adapter shape through the existing
  `@syncular/core` telemetry abstraction.

## Non-Scope

- A second sync protocol or compatibility branch for old JS/client behavior.
- Arbitrary SQL-level tracing as the public synced-write/debug API.
- Persisting app plaintext, secrets, auth tokens, encrypted field plaintext, or
  full row payloads in diagnostic records by default.
- Weakening scoped access, verification, cursor advancement, or recovery rules
  to make the console easier to populate.
- Making app code babysit websocket reconnects or artifact recovery.

## Acceptance Criteria

- Diagnostic events use stable `source` and `code` values so tests and app
  tooling do not parse human-readable messages.
- Every push, pull, realtime binary apply, realtime pull-required wakeup,
  artifact download/apply, and recovery pull can be correlated by
  `syncAttemptId` and, when provided, external `traceId`/`spanId`.
- Browser and native clients expose a redacted diagnostic snapshot containing
  runtime/package/schema versions, storage mode/fallback, active subscriptions,
  local cursors, verified roots, outbox/conflict/blob queue stats, realtime
  state, recent diagnostic events, and recent sync timing buckets.
- Server request events and console timeline entries can link client-side
  attempts to server push/pull decisions without storing sensitive payloads by
  default.
- The console can answer a "why missing?" investigation for
  `clientId + table + rowId` by showing subscription coverage, scope
  eligibility, delivery/apply/revocation evidence where available, and the
  nearest recovery or rejection event.
- Realtime diagnostics distinguish binary fast-path apply, explicit
  pull-required recovery, websocket overflow, reconnect scheduling, ACK success,
  and ACK failure.
- Artifact diagnostics distinguish capability not requested, exact scoped cache
  miss, download failure, digest/length mismatch, verified apply, and row-chunk
  recovery.
- CRDT diagnostics, when WP-07 wires them, distinguish update receive/merge,
  checkpoint use, compaction, state-vector hints, and guarded materialization
  without exposing plaintext.
- Testkit can inject at least corrupted artifact, websocket overflow,
  auth/scope revocation, stale cursor, schema mismatch, and integrity-root
  rejection cases and assert the emitted diagnostic codes.

## Required Gates

- Core telemetry and diagnostic schema tests:
  `bun test packages/core/src/__tests__/telemetry.test.ts`
- Browser worker diagnostic/realtime tests:
  `bun test rust/bindings/browser/src/worker-client.test.ts rust/bindings/browser/src/worker-realtime.test.ts`
- Browser/WASM sync and realtime integration tests when runtime diagnostics or
  payloads change:
  `bun test rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`
- Server request-event and console API tests when persisted/server-side
  investigation fields change:
  `bun test packages/server-hono/src/__tests__/console-routes.test.ts packages/server-hono/src/__tests__/create-server.test.ts`
- Console UI tests or a targeted build/typecheck when console pages change:
  `bun run --cwd packages/console tsgo`
- Runtime/native tests when Rust event structures or native bindings change:
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --lib --features native,crdt-yjs,demo-todo-native-fixture transport::tests`
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_facade --features native,crdt-yjs,demo-todo-native-fixture`
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_ffi --features native,crdt-yjs,demo-todo-native-fixture`
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime --test native_binding_scaffold --features native,crdt-yjs,demo-todo-native-fixture,boltffi-bindings`

## Accept / Reject Rule

- Retain observability work only if it makes failures and recovery paths more
  explicit without adding protocol fallbacks, weakening verification, or
  exposing sensitive data by default.
- Reject diagnostic paths that require apps to manage sync recovery manually or
  infer correctness from local app tables.
- Reject payload capture that stores app row data, encrypted plaintext, tokens,
  or secrets unless it is opt-in, redacted, size-bounded, and documented.
- For instrumentation added to hot paths, retain only if benchmark evidence
  shows no meaningful regression or the diagnostic value is explicitly accepted
  with a follow-up performance recovery action in `BENCHMARK_LOG.md`.

## Current Evidence

Existing pieces to build on:

- `@syncular/core` already exposes a vendor-neutral telemetry abstraction with
  logging, tracing, metrics, and exception capture.
- `@syncular/observability-sentry` already adapts Syncular telemetry to Sentry.
- Server dialects persist `sync_request_events` with request, trace, span,
  transport, sync path, duration, outcome, tables, scopes summary, and optional
  payload references.
- The Hono console already has Stream/Ops surfaces, trace search, external
  trace links, request payload snapshots, and federated downstream console
  routing.
- Browser worker clients already expose structured diagnostic events, realtime
  state, transport stats, storage fallback metadata, and sync timing buckets.
- WP-04 realtime work already emits binary apply, pull-required, reconnect,
  ACK, and failure diagnostics with benchmark scoreboard timing.
- WP-12 artifact work already records capability/request-shape evidence and
  artifact cache lookup timing in benchmark reports.

## Suggested Event Codes

Initial stable code families:

- `sync.push.started`
- `sync.push.applied`
- `sync.push.rejected`
- `sync.pull.started`
- `sync.pull.applied`
- `sync.pull.rejected_integrity`
- `sync.scope.revoked`
- `realtime.hello`
- `realtime.binary_applied`
- `realtime.pull_required`
- `realtime.overflow`
- `realtime.reconnect_scheduled`
- `realtime.ack_sent`
- `realtime.ack_failed`
- `artifact.capability_skipped`
- `artifact.cache_miss`
- `artifact.download_failed`
- `artifact.download_verified`
- `artifact.download_rejected`
- `artifact.apply_completed`
- `storage.fallback_selected`
- `auth.refresh_required`
- `crdt.update_merged`
- `crdt.checkpoint_used`
- `crdt.compaction_completed`
- `crdt.materialization_guarded`

## First Slice

Define the stable diagnostic envelope and ring-buffered client diagnostic
snapshot first:

1. Add shared TypeScript/Rust diagnostic envelope types with
   `syncAttemptId`, `traceId`, `spanId`, `clientId`, `subscriptionId`, `table`,
   `rowId`, `cursor`, `source`, `code`, and redacted `details`.
2. Add browser worker/client snapshot APIs that return recent diagnostic
   events, timing buckets, storage mode, subscriptions, cursors, verified roots,
   and realtime state.
3. Thread `syncAttemptId` through browser push/pull/realtime-triggered pull and
   persisted server request events.
4. Add tests proving one successful pull and one realtime pull-required
   recovery can be correlated across client diagnostics and server request
   events.

## Next Action

First-slice correlation work is complete enough for the current runtime/API
surface. Runtime, browser, native, support-bundle, health-check, and testkit
diagnostic helpers are in place.

Next: move to the console investigation UI work only when we are ready to add
dedicated diagnostic drilldowns. Until then, treat WP-13 as deferred rather
than active local Rust-client work.

## Progress

- Added TypeScript diagnostic envelope fields for `syncAttemptId`, `traceId`,
  `spanId`, `clientId`, `subscriptionId`, `table`, `rowId`, and `cursor`.
- Added `diagnosticSnapshot()` to the browser client contract.
- Added redacted subscription snapshots that expose scope/param keys and value
  counts but not raw scope values.
- Added ring-buffered recent diagnostics and recent sync timings to the worker
  client and direct Rust browser client.
- Added worker-client snapshot coverage for diagnostics, bootstrap cursor
  state, transport stats, outbox stats, conflict stats, and redaction.
- Added generated browser `syncAttemptId`/W3C trace context propagation through
  `syncPull`, `syncPush`, `syncOnce`, worker diagnostics, direct Rust browser
  client sync diagnostics, and realtime HTTP pull recovery.
- Added `x-syncular-sync-attempt-id` to server CORS defaults so apps can send
  the attempt id alongside `traceparent` when needed.
- Added server coverage proving `traceparent` is persisted to
  `sync_request_events` and browser worker/realtime coverage proving sync
  attempts are attached to sync calls and recovery diagnostics.
- Added native/runtime diagnostic snapshot parity through
  `NativeSyncularClient::diagnostic_snapshot_json`,
  `syncular_native_client_diagnostic_snapshot_json`, and generated
  Swift/Kotlin/Java BoltFFI wrappers.
- Native diagnostic snapshots now include runtime manifest, connection/worker
  state, redacted subscriptions, bootstrap status, outbox/conflict/blob stats,
  observed queries, recent native events, and recent diagnostics without
  exposing raw scope values.
- Added native facade, C FFI, and generated binding scaffold coverage for the
  diagnostic snapshot surface and redaction behavior.
- Added native Rust transport trace propagation for HTTP sync attempts. Native
  HTTP sync now emits `traceparent`, `sentry-trace`, and
  `x-syncular-sync-attempt-id`, derives the attempt id from an existing
  traceparent when supplied, and reuses the active attempt for snapshot chunk
  and artifact fetches.
- Added native transport unit coverage for generated trace context, existing
  traceparent adoption, and stable attempt reuse across sync POST and snapshot
  chunk fetch.
- Worker diagnostic forwarding now preserves `syncAttemptId`, `traceId`,
  `spanId`, client/subscription/table/row/cursor fields, and details.
- Added browser/Hono integration coverage proving a normal sync pull and a
  realtime pull-required HTTP recovery can be correlated from client
  diagnostics to persisted server `sync_request_events` by trace id.
- Added native `recentSyncTimings` diagnostic snapshot entries derived from
  worker sync outcome events. Native timing entries expose event sequence,
  kind, command id, total duration, success, retry scheduling, outbox count, and
  conflict count without inventing unavailable browser-only sub-buckets.
- Added console/API `syncAttemptId` filtering as a first-class alias for the
  persisted request trace id on timeline and request-event routes, including
  federated gateway schemas, generated OpenAPI client types, and Stream search
  token support.
- Added `syncular-testkit` native diagnostic assertion helpers for stable
  native `event.diagnostic.code`, diagnostic detail values, and native
  `event.error.code`, then used them in the native auth-expired and
  schema-mismatch smokes. App suites can now assert observability contracts
  without parsing human-readable messages.
- Deferred: the remaining acceptance gap is dedicated console investigation
  UI/drilldowns. That is a product/UI work item, not a missing Rust runtime,
  native binding, or testkit foundation slice.
- Gate: `cargo test --manifest-path rust/Cargo.toml -p syncular-testkit`
  passed with `33` smoke tests after the diagnostic assertion slice.
