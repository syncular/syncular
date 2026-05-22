# WP-32 Realtime Recovery Fanout And External Notification Payloads

Status: `[ ]` planned, depends on WP-04, WP-28, WP-31

## Goal

Remove the Rust worker realtime reconnect-storm cliff caused by cursor-only
external-write wakeups, without moving relay/server app semantics into Rust or
hiding HTTP recovery behind client retry tuning.

## Why

WP-31 fixed worker realtime reconnect correctness and added a benchmark lane for
the product reconnect path. The retained evidence shows the client path is
sound at smaller fleet sizes but still hits a server/recovery shape at larger
fanout:

- Direct HTTP reconnect starts an approximately `2s` cliff between `110` and
  `125` concurrent first pulls.
- Worker realtime improves the `125`-client path to `216.12ms`, but the
  `250`-client lane still lands at `2035.74ms`.
- The benchmark server's external-write path emits cursor-only `server-wakeup`
  frames, not binary sync-pack payloads, so every worker performs an identical
  HTTP recovery pull.
- Sync service CPU stayed low in the earlier direct lane, which points at
  request/fanout/harness behavior rather than local Rust apply cost.

This is now a server/realtime architecture problem. WP-31 should continue with
client-side benchmark parity work; this WP owns the reconnect herd and external
notification payload design.

## Scope

- Reproduce and baseline the `syncular-rust` worker realtime reconnect storm at
  `25`, `125`, and `250` clients using the current external benchmark lane.
- Add enough server/realtime instrumentation to split:
  - external write notification build time;
  - binary payload encode time and bytes;
  - websocket fanout time;
  - HTTP recovery pull request count and p50/p95/p99 latency;
  - duplicate recovery pulls for the same cursor/scope set;
  - server CPU and memory while the storm is active.
- Evaluate payload-rich external notifications:
  - binary sync-pack payloads for external row-change notifications when the
    server can determine active/recent subscriptions safely;
  - explicit recovery frames when payloads are too large, stale, unauthorized,
    or outside the replay window.
- Evaluate server-side recovery fanout:
  - coalesce identical recovery work for many clients at the same cursor;
  - share a recovery artifact or encoded pack when scopes/subscriptions match;
  - preserve per-client authorization and subscription filtering.
- Evaluate whether Rust helps only after the TypeScript/Hono server shape is
  measured:
  - binary protocol encode/validate with bodies kept as bytes;
  - no Rust boundary that requires JSON materialization around hot paths;
  - no Rust table handlers, scope resolution, or mutation apply semantics.

## Non-Scope

- No full relay rewrite in Rust.
- No Rust ownership of server table handlers, Kysely storage, scope resolution,
  conflict generation, or mutation application.
- No compatibility fallback to old websocket or JSON protocol behavior.
- No client-only backoff/jitter tuning presented as a fix for the server herd.
- No benchmark-only cache that bypasses subscription/auth filtering.
- No relaxing payload limits or slow-client policy without explicit overflow
  tests.

## Candidate Designs

1. Binary external notification payloads:
   Build the same binary sync-pack shape used by normal realtime pushes for
   external row changes, then send binary frames to matching websocket
   subscribers. HTTP pull remains recovery for overflow, stale cursor, auth
   refresh, missed sequence, and large payloads.

2. Recovery pack replay window:
   Keep a bounded server-side window of recent encoded recovery packs keyed by
   cursor and subscription shape. Reconnecting clients inside the window receive
   the pack; clients outside it get an explicit pull-required recovery frame.

3. Herd coalescing:
   When many clients require the same recovery pull, compute or fetch the
   recovery data once per compatible scope/subscription group, then fan it out
   or expose a shared artifact while preserving per-client authorization.

4. Protocol-only Rust helper:
   Add a small Rust encode/validate helper only if measurements show the hot
   path is binary protocol work and the boundary can keep payloads as bytes. If
   the boundary requires JSON/object mapping, reject it.

## Acceptance Criteria

- Baseline and candidate runs are recorded against the same external benchmark
  setup and same branch server build.
- The `250`-client worker realtime reconnect lane either improves materially
  from the accepted `2035.74ms` p95/convergence result, or the candidate is
  rejected with timing evidence.
- Realtime diagnostics distinguish binary payload apply, replay-window apply,
  pull-required recovery, payload-too-large, stale cursor, auth refresh, and
  binary apply failure.
- HTTP recovery requests drop when a binary/replay/fanout candidate is retained;
  duplicate recovery pulls for the same cursor/scope shape are measured.
- Correctness tests prove no unauthorized rows are sent through payload-rich
  notifications or shared recovery artifacts.
- Slow-client and payload-overflow tests prove the server falls back to explicit
  recovery without unbounded buffering.
- WP-28 remains respected: app semantics stay TypeScript/Kysely-owned unless a
  separate measured decision changes ownership.

## Required Gates

- Server/Hono websocket tests covering:
  - binary external notifications;
  - reconnect catch-up/replay behavior;
  - overflow and stale-cursor recovery;
  - auth/scope filtering.
- `bun --cwd packages/client test src/worker-realtime.test.ts`
- `bun --cwd packages/client build`
- Relevant server/Hono `tsgo` and tests for files touched.
- External benchmark gates from `/Users/bkniffler/GitHub/sync/offline-sync-bench`:

```sh
SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/packages/client/dist \
SYNCULAR_RUST_RECONNECT_MODE=worker-realtime \
SYNCULAR_RUST_RECONNECT_CLIENT_COUNTS=25,125,250 \
  bun run bench:run -- --stack syncular-rust --scenario reconnect-storm
```

Run `online-propagation` as a regression guard for any binary realtime payload
change:

```sh
SYNCULAR_RUST_CLIENT_DIST=/Users/bkniffler/conductor/workspaces/syncular/indianapolis/packages/client/dist \
  bun run bench:run -- --stack syncular-rust --scenario online-propagation
```

## Accept / Reject Rule

- Retain a candidate only if it improves the reconnect herd metric or removes
  duplicate server work without weakening scoped auth, overflow, reconnect, or
  slow-client semantics.
- Reject candidates that only shift latency into client retries or hide
  pull-required recovery from diagnostics.
- Reject Rust integration if it adds JSON materialization, large package/startup
  cost, or duplicate app semantics around an otherwise TypeScript-owned server
  path.
- Prefer explicit recovery frames over silent fallbacks.

## Current Evidence

- WP-31 external run `2026-05-22T13-17-27-970Z`:
  - HTTP direct `110` clients: convergence `257.72ms`, first `syncOnce` p95
    `238.78ms`, requests `110`;
  - HTTP direct `125` clients: convergence `2030.60ms`, first `syncOnce` p95
    `2012.99ms`, requests `125`.
- WP-31 external run `2026-05-22T13-26-23-521Z`:
  - worker realtime `125` clients: convergence `216.12ms`, visible p95
    `214.28ms`, requests `250`, reconnect catch-up pulls `125`.
- WP-31 external run `2026-05-22T13-38-54-572Z`:
  - worker realtime `250` clients: convergence `2035.74ms`, visible p95
    `2034.99ms`, requests `484`, reconnect catch-up pulls `250`.
- WP-31 interpretation:
  - worker reconnect catch-up is a retained correctness fix;
  - the external-write benchmark path emits cursor-only `server-wakeup`
    realtime frames;
  - the remaining `250`-client cliff should target binary payloads for external
    notifications or server/relay-side recovery fanout.
- WP-28 remains the relay/server Rust guardrail:
  - protocol validation stays in fixtures/dev tooling only for now;
  - relay app semantics remain TypeScript/Kysely-owned;
  - new Rust relay/server production work needs concrete load evidence and a
    scoped binary/protocol target.

## Next Action

Start with measurement, not implementation:

1. Re-run the accepted WP-31 worker realtime reconnect baseline on the current
   branch server.
2. Add server/realtime timing buckets for cursor-only external notifications
   and recovery pulls.
3. Prototype the smallest TypeScript/Hono binary external-notification or
   coalesced-recovery candidate.
4. Keep or reject based on `25`/`125`/`250` external benchmark evidence.
