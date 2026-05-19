# WP-04 Realtime Runtime

Status: `[~]` started

## Goal

Make websocket deltas the canonical fast path, with HTTP pull reserved for
recovery/checkpoint paths.

## Scope

- Persistent runtime-owned websocket.
- Reconnect/backoff/auth refresh.
- Verified delta cursor/replay.
- Runtime-owned sync wakeups.
- Overflow/resync events.
- Worker event stream parity across Rust, native facade, browser worker, and
  generated bindings.

## Acceptance Criteria

- Apps do not babysit reconnect loops.
- Slow event subscribers receive explicit overflow/resync semantics.
- Realtime deltas carry enough row/field metadata for precise live-query/app
  updates.
- HTTP fallback count stays visible in benchmarks.

## Required Gates

- Browser E2E incremental/realtime gate.
- Runtime worker event tests.
- Native event stream tests.

## Accept / Reject Rule

- Retain websocket-fast-path work only if it preserves pull recovery,
  authorization, ordering, and explicit overflow/resync semantics.
- Revert changes that make apps babysit reconnects or hide HTTP fallback.

## Current Evidence

Retained first slice:

- Browser worker realtime now treats `requiresPull=true` and `droppedCount > 0`
  as authoritative recovery metadata. Recovery-marked websocket messages run
  HTTP pull instead of applying any websocket-local row payload.
- Correctness gates passed:
  `bun test rust/bindings/browser/src/worker-realtime.test.ts`,
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`,
  and `bun run --cwd rust/bindings/browser tsgo`.
- Browser release E2E gate:
  `bun run --cwd rust/bindings/browser benchmark:browser:e2e -- --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --output=.context/benchmarks/wp04-realtime-requires-pull.json`.
- Result: `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`, `rust_realtime_live_ms=70.19`,
  `rust_realtime_live_p95_ms=71.7`.
- Decision: retained. The normal binary websocket fast path stayed active, and
  recovery-marked payloads no longer bypass pull recovery.

Retained second slice:

- Browser worker realtime now ACKs the websocket cursor that triggered a
  successful recovery pull, even for cursor-only recovery messages where the
  pull result does not report a larger subscription cursor.
- Correctness gates passed:
  `bun test rust/bindings/browser/src/worker-realtime.test.ts` and
  `bun run --cwd rust/bindings/browser tsgo`.
- Browser release E2E gate:
  `bun run --cwd rust/bindings/browser benchmark:browser:e2e -- --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --output=.context/benchmarks/wp04-realtime-recovery-ack.json`.
- Result: previous WP-04 guard `rust_realtime_live_ms=70.19`,
  `rust_realtime_live_p95_ms=71.7`, `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`; current `rust_realtime_live_ms=71.99`,
  `rust_realtime_live_p95_ms=73.25`, `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`.
- Decision: retained. The normal binary websocket fast path stayed active; the
  change only fixes recovery cursor acknowledgement semantics.

Retained third slice:

- Server websocket binary deltas now use the same per-subscription integrity
  shape as HTTP pull instead of the synthetic `__syncular_realtime__` rootless
  subscription. The Hono realtime manager records active subscription metadata
  from pull responses, builds scoped per-owner binary sync-packs with real
  subscription IDs, and advances in-memory verified roots as consecutive
  realtime packs are emitted.
- Browser Rust realtime apply now validates subscription integrity metadata,
  rejects missing/mismatched roots for real subscriptions, persists the verified
  root after apply, and reports changed rows with the real subscription ID.
- Reconnect replay without a prepared verified per-owner pack now uses explicit
  pull recovery instead of replaying an unverified synthetic delta.
- Correctness gates passed:
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun run --cwd packages/server-hono tsgo`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Browser dev E2E gate:
  `bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --wasm-profile=dev --json --output=.context/benchmarks/wp04-realtime-integrity-packs.json`.
- Result: previous WP-04 guard `rust_realtime_live_ms=71.99`,
  `rust_realtime_live_p95_ms=73.25`, `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`, `rust_realtime_binary_bytes=537675`;
  current `rust_realtime_live_ms=107.12`,
  `rust_realtime_live_p95_ms=110.48`, `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`, `rust_realtime_binary_bytes=540300`.
- Decision: retained as a correctness/security fix. The realtime fast path still
  avoids HTTP fallback and preserves binary event count. The measured live-time
  regression is explicit; the next slice should recover integrity-pack overhead
  or move repeated root hashing/metadata work off the hot path.

Retained fourth slice:

- Removed the browser/public inline JSON websocket apply surface:
  `applyRealtimeChanges`, `applyRealtimeChangesJson`, the Rust
  `apply_realtime_changes` path, and the synthetic
  `__syncular_realtime__` subscription branch.
- Removed server-side bounded JSON websocket delta delivery. The realtime
  manager now sends binary sync-packs to clients that negotiated
  `binary-sync-pack-v1`; clients without an eligible binary frame receive an
  explicit pull-required wakeup.
- Correctness gates passed:
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun run --cwd packages/server-hono tsgo`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Browser dev E2E gate:
  `bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --wasm-profile=dev --json --output=.context/benchmarks/wp04-realtime-no-json-deltas.json`.
- Result: previous WP-04 guard `rust_realtime_live_ms=107.12`,
  `rust_realtime_live_p95_ms=110.48`, `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`, `rust_realtime_binary_bytes=540300`;
  current `rust_realtime_live_ms=99.19`,
  `rust_realtime_live_p95_ms=108.07`, `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`, `rust_realtime_binary_bytes=540300`.
- Decision: retained. It removes obsolete protocol surface and slightly reduces
  measured live-time overhead without weakening verified per-subscription roots.

Retained fifth slice:

- Realtime apply no longer echoes applied commit payloads back through
  `WebSyncResult.subscriptions[].commits`. The worker only needs changed-row
  metadata plus subscription cursors for events/ACKs, so returning the full
  commit rows was duplicate wasm-boundary serialization.
- Empty subscription `snapshotRows` and `commits` are skipped in the serialized
  browser result while TS parsing still defaults them to empty arrays.
- Correctness gates passed:
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Browser dev E2E gate:
  `bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --wasm-profile=dev --json --output=.context/benchmarks/wp04-realtime-slim-result.json`.
- Result: previous WP-04 guard `rust_realtime_live_ms=99.19`,
  `rust_realtime_live_p95_ms=108.07`, `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`, `rust_realtime_binary_bytes=540300`;
  current `rust_realtime_live_ms=88.67`,
  `rust_realtime_live_p95_ms=97.53`, `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`, `rust_realtime_binary_bytes=540300`.
- Decision: retained. This removes duplicate result materialization and is a
  simpler contract for the browser realtime worker.

Retained sixth slice:

- Browser realtime diagnostics now include Rust-side binary apply timings, and
  the browser scoreboard aggregates realtime apply, pull-apply, commit-apply,
  and notify p50/p95/total metrics.
- Browser dev E2E gate:
  `bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --wasm-profile=dev --json --output=.context/benchmarks/wp04-realtime-apply-timings.json`.
- Result: previous WP-04 guard `rust_realtime_live_ms=88.67`,
  `rust_realtime_live_p95_ms=97.53`; current `rust_realtime_live_ms=85.32`,
  `rust_realtime_live_p95_ms=86.52`. New timing metrics show
  `rust_realtime_apply_total_p50_ms=11`,
  `rust_realtime_pull_apply_p50_ms=9`, and
  `rust_realtime_notify_p50_ms=0`.
- Decision: retained as benchmark instrumentation. The next optimization should
  target realtime pull/apply, not notification.

Retained seventh slice:

- Browser SQLite app-row upserts now reuse the existing prepared-statement cache
  instead of preparing/finalizing a multi-row upsert statement per realtime
  batch.
- Browser dev E2E gate:
  `bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --wasm-profile=dev --json --output=.context/benchmarks/wp04-realtime-cached-app-upsert.json`.
- Result: previous WP-04 guard `rust_realtime_live_ms=85.32`,
  `rust_realtime_live_p95_ms=86.52`,
  `rust_realtime_pull_apply_total_ms=138`; current
  `rust_realtime_live_ms=84.31`, `rust_realtime_live_p95_ms=85.16`,
  `rust_realtime_pull_apply_total_ms=134`.
- Decision: retained. The gain is modest, but the code uses the existing
  statement cache and removes one-off prepare/finalize handling.

Retained eighth slice:

- Browser realtime batched upserts now treat emitted upsert row payloads as the
  canonical server row and pass them through unchanged. The hot path no longer
  looks up generated table metadata or rewrites the primary key/server-version
  fields for every realtime change.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts`,
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`, and
  `bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts`.
- Browser dev E2E gate:
  `bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --wasm-profile=dev --json --output=.context/benchmarks/wp04-realtime-canonical-row-pass-through.json`.
- Result: previous WP-04 guard `rust_realtime_live_ms=84.31`,
  `rust_realtime_live_p95_ms=85.16`,
  `rust_realtime_apply_total_ms=160`,
  `rust_realtime_pull_apply_total_ms=134`; current
  `rust_realtime_live_ms=82.27`, `rust_realtime_live_p95_ms=83.61`,
  `rust_realtime_apply_total_ms=155`,
  `rust_realtime_pull_apply_total_ms=131`.
- Decision: retained. This is a small but measurable win, and the code is
  simpler because the Rust client no longer patches canonical server rows.

Rejected probe:

- Tried retaining binary sync-pack row-group payloads as a sidecar on decoded
  commits, then applying clean single-table upsert commits through the existing
  binary snapshot payload writer after integrity verification.
- Browser dev E2E gate:
  `bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --wasm-profile=dev --json --output=.context/benchmarks/wp04-realtime-direct-binary-row-groups.json`.
- Result versus the retained eighth slice:
  `rust_realtime_live_ms=82.27 -> 83.79`,
  `rust_realtime_live_p95_ms=83.61 -> 85.81`,
  `rust_realtime_apply_total_ms=155 -> 162`,
  `rust_realtime_pull_apply_total_ms=131 -> 137`, and
  `browser_served_rust_wasm_bytes=7463118 -> 7470682`.
- Decision: rejected and reverted. Keeping binary row payloads in addition to
  decoded rows adds code/size and did not improve this lane. A future direct
  binary realtime path must avoid the JSON/map materialization itself, not only
  reuse the binary payload after decoding it for integrity.

Rejected probe:

- Tried preallocating `serde_json::Map` rows while decoding binary snapshot
  row groups instead of using iterator `collect()`.
- Browser dev E2E gates:
  `.context/benchmarks/wp04-binary-row-map-prealloc.json` and
  `.context/benchmarks/wp04-binary-row-map-prealloc-rerun.json`.
- Result versus the retained eighth slice was not a performance win:
  realtime p50 rerun `82.27 -> 84.64`, p95 `83.61 -> 87.96`,
  incremental sync-pack decode `9ms -> 10ms`, and realtime apply total
  `155ms -> 157ms`. WASM bytes improved `7463118 -> 7416004`, but not enough
  to justify the runtime regression and noisier code.
- Decision: rejected and reverted.

Rejected probe:

- Tried avoiding per-row table-name cloning in the browser realtime upsert
  batching path, cloning the table only when a new table batch starts.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime web::client --lib`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts`,
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`, and
  `bun test packages/server-hono/src/__tests__/create-server.test.ts packages/server-hono/src/__tests__/ws-connection-manager.test.ts`.
- Browser dev E2E gates:
  `.context/benchmarks/wp04-realtime-table-clone-elision.json` and
  `.context/benchmarks/wp04-realtime-table-clone-elision-rerun.json`.
- Result versus the retained overhead guard was not a win: rerun realtime p50
  `82.05 -> 100.03`, overhead p50 `22.63 -> 23.91`,
  realtime apply total `160ms -> 165ms`, and pull-apply total `133ms -> 137ms`.
  WASM bytes improved slightly `7463118 -> 7462690`, but not enough to justify
  keeping the change.
- Decision: rejected and reverted.

Retained measurement slice:

- Browser realtime benchmark now emits `rust_realtime_overhead_*` samples,
  computed per iteration as live-query propagation latency minus the TS push
  duration. This keeps server/push noise visible when evaluating Rust/browser
  realtime changes.
- Browser dev E2E gate:
  `bun tests/runtime/scripts/browser-e2e-scoreboard.ts --rows=10000 --incremental-rows=1000 --realtime-iterations=3 --query-iterations=0 --wasm-profile=dev --json --output=.context/benchmarks/wp04-realtime-overhead-metric.json`.
- Current guard values: `rust_realtime_live_ms=82.05`,
  `rust_realtime_live_p95_ms=83.99`,
  `rust_realtime_overhead_p50_ms=22.63`,
  `rust_realtime_overhead_p95_ms=23.99`,
  `rust_realtime_http_request_count=0`, and
  `browser_served_rust_wasm_bytes=7463118`.

## Next Action

Continue recovering realtime integrity overhead without weakening the verified
per-subscription root contract. Next candidates should be measured against
`.context/benchmarks/wp04-realtime-overhead-metric.json`.
