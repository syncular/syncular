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

Retained measurement slice:

- Browser Rust sync results now include `syncPackDecodeMs` for realtime
  binary sync-pack frames, and the browser realtime benchmark reports
  `rust_realtime_sync_pack_decode_*` plus
  `rust_realtime_pull_transform_*` metrics.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime web::client --lib`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts`,
  `bun test rust/bindings/browser/src/client.test.ts`,
  `bun test rust/bindings/browser/src/react.test.ts`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Browser dev E2E gates:
  `.context/benchmarks/wp04-realtime-decode-transform-metrics.json` and
  `.context/benchmarks/wp04-realtime-decode-transform-metrics-rerun.json`.
- Current measured split: realtime apply total `158ms`, pull apply `129ms`,
  sync-pack decode `23ms` total / `2ms` p50, and pull transform `0ms`.
  End-to-end realtime p50 on the rerun was `95.34ms`; keep comparing the
  lower-level split metrics as well as live latency because browser/server
  scheduling noise is visible in this lane.

Retained measurement slice:

- Browser Rust realtime diagnostics now split `applyMs` into sync-pack decode,
  integrity verification, commit apply, subscription state persistence, and
  notify timing.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol integrity --lib`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime web::client --lib`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/client.test.ts rust/bindings/browser/src/react.test.ts`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Browser dev E2E gates:
  `.context/benchmarks/wp04-realtime-integrity-state-split.json` and
  `.context/benchmarks/wp04-realtime-integrity-state-split-rerun2.json`.
- Current measured split against the previous decode/transform guard:
  first split `rust_realtime_live_ms=93.93`, `apply_total=164ms`,
  `integrity_verify=104ms`, `commit_apply=23ms`, `subscription_state=8ms`;
  latest rerun `rust_realtime_live_ms=121.39`, `apply_total=237ms`,
  `integrity_verify=159ms`, `commit_apply=37ms`, and
  `subscription_state=5ms`. The latest rerun is noisier, but both runs point to
  integrity verification as the dominant realtime Rust-side cost.
- Decision: retained as measurement infrastructure. This is not a performance
  win; it makes the next real optimization target explicit.

Rejected probe:

- Tried using `serde_json::Map` iteration as a sorted-map fast path inside
  canonical integrity hashing.
- Correctness gates passed, but the benchmark rejected it:
  `.context/benchmarks/wp04-realtime-sorted-map-integrity.json` and
  `.context/benchmarks/wp04-realtime-sorted-map-integrity-rerun.json`.
- Rerun versus the first integrity/state split:
  `rust_realtime_live_ms=93.93 -> 126.06`,
  `rust_realtime_apply_total_ms=164 -> 229`,
  `rust_realtime_pull_apply_total_ms=135 -> 187`,
  `rust_realtime_integrity_verify_total_ms=104 -> 148`, and
  `browser_served_rust_wasm_bytes=7463799 -> 7443592`.
- Decision: rejected and reverted. The byte-size reduction did not justify the
  runtime regression. Avoid more local canonicalization micro-probes unless they
  have a clear benchmark-backed reason.

Retained optimization slice:

- Rust canonical JSON integrity payload writing now appends JSON string escapes
  directly into the existing buffer instead of allocating via
  `serde_json::to_string` for every object key, row string value, and wire
  commit metadata string.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime web::client --lib`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/client.test.ts rust/bindings/browser/src/react.test.ts`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Browser dev E2E gates:
  `.context/benchmarks/wp04-realtime-json-string-writer.json` and
  `.context/benchmarks/wp04-realtime-json-string-writer-rerun.json`.
- Confirmed rerun versus the previous accepted guard:
  `rust_realtime_live_ms=121.39 -> 92.55`,
  `rust_realtime_apply_total_ms=237 -> 128`,
  `rust_realtime_pull_apply_total_ms=201 -> 103`,
  `rust_realtime_integrity_verify_total_ms=159 -> 76`,
  `rust_realtime_integrity_verify_p50_ms=10 -> 5`, and
  `browser_served_rust_wasm_bytes=7463799 -> 7465224`.
- Decision: retained. This is the first material WP-04 integrity recovery win;
  it keeps the same canonical root contract and removes allocation from the hot
  path.

Rejected probe:

- Tried streaming canonical wire commit payloads directly into SHA-256 instead
  of materializing the canonical payload `String` first.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract`, and
  `bun run --cwd rust/bindings/browser build:wasm:dev`.
- Browser dev E2E gate:
  `.context/benchmarks/wp04-realtime-streaming-integrity-hash.json`.
- Result versus the retained string-writer guard:
  `rust_realtime_live_ms=92.55 -> 93.63`,
  `rust_realtime_apply_total_ms=128 -> 154`,
  `rust_realtime_pull_apply_total_ms=103 -> 130`,
  `rust_realtime_integrity_verify_total_ms=76 -> 98`,
  `rust_realtime_integrity_verify_p50_ms=5 -> 7`, and
  `browser_served_rust_wasm_bytes=7465224 -> 7466004`.
- Decision: rejected and reverted. The abstraction is not worth carrying
  without a measurable win.

Retained optimization slice:

- Canonical object writing now checks whether keys are already sorted and uses
  direct map iteration in that case, falling back to key sorting only when
  needed.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Browser dev E2E gates:
  `.context/benchmarks/wp04-realtime-sorted-object-fast-path.json`,
  `.context/benchmarks/wp04-realtime-sorted-object-fast-path-rerun.json`, and
  `.context/benchmarks/wp04-realtime-sorted-object-fast-path-rerun2.json`.
- Confirmed rerun versus the retained string-writer guard:
  `rust_realtime_live_ms=92.55 -> 91.02`,
  `rust_realtime_apply_total_ms=128 -> 126`,
  `rust_realtime_pull_apply_total_ms=103 -> 98`,
  `rust_realtime_integrity_verify_total_ms=76 -> 68`,
  `rust_realtime_overhead_p95_ms=24.18 -> 23.22`, and
  `browser_served_rust_wasm_bytes=7465224 -> 7467598`.
- Decision: retained. The total live metric is mostly flat, but the lower-level
  integrity bucket consistently improves and the fallback keeps canonical
  correctness if object iteration is not sorted.

Retained optimization slice:

- Canonical numbers, wire commit sequences, and row versions now write directly
  into the existing canonical payload buffer instead of allocating temporary
  `to_string()` values.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Browser dev E2E gates:
  `.context/benchmarks/wp04-realtime-direct-number-write.json` and
  `.context/benchmarks/wp04-realtime-direct-number-write-rerun.json`.
- Confirmed rerun versus the retained sorted-object guard:
  `rust_realtime_live_ms=91.02 -> 91.03`,
  `rust_realtime_live_p95_ms=112.80 -> 92.72`,
  `rust_realtime_apply_total_ms=126 -> 122`,
  `rust_realtime_pull_apply_total_ms=98 -> 94`,
  `rust_realtime_commit_apply_total_ms=25 -> 20`, and
  `browser_served_rust_wasm_bytes=7467598 -> 7468173`.
- Decision: retained. This does not materially reduce integrity verification,
  but it reduces total apply/commit overhead with minimal complexity.

Retained optimization slice:

- Canonical object writing now avoids the separate sorted-key pre-scan. It
  writes in map iteration order and only truncates/sorts if it detects
  out-of-order keys, preserving canonical correctness while making the normal
  sorted-map path one pass.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/client.test.ts rust/bindings/browser/src/react.test.ts`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Browser dev E2E gates:
  `.context/benchmarks/wp04-realtime-one-pass-canonical-object.json` and
  `.context/benchmarks/wp04-realtime-one-pass-canonical-object-rerun.json`.
- Result versus the retained direct-number guard:
  `rust_realtime_integrity_verify_total_ms=69 -> 65/66`,
  `rust_realtime_apply_total_ms=122 -> 121/125`,
  `rust_realtime_live_ms=91.03 -> 92.06/88.60`, and
  `browser_served_rust_wasm_bytes=7468173 -> 7468747`.
- Decision: retained as a modest integrity-hot-path improvement. Total apply is
  flat/noisy, but the targeted integrity bucket improves in both runs with a
  small code change.

Rejected probe:

- Tried reserving a heuristic capacity for canonical wire commit digest
  payloads before writing the payload.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract`,
  and `bun run --cwd rust/bindings/browser build:wasm:dev`.
- Browser dev E2E gate:
  `.context/benchmarks/wp04-realtime-commit-digest-capacity-hint.json`.
- Result versus the retained one-pass object rerun:
  `rust_realtime_live_ms=88.60 -> 89.93`,
  `rust_realtime_apply_total_ms=125 -> 125`,
  `rust_realtime_pull_apply_total_ms=95 -> 93`,
  `rust_realtime_integrity_verify_total_ms=66 -> 65`, and
  `browser_served_rust_wasm_bytes=7468747 -> 7469547`.
- Decision: rejected and reverted. The tiny integrity movement did not justify
  a magic capacity heuristic, live latency regressed, and WASM grew.

Rejected probe:

- Tried replacing `write!`/temporary numeric formatting in canonical payloads
  with direct `itoa`/`ryu` writers for JSON numbers, row versions, and commit
  sequences.
- Correctness gates passed:
  `cargo fmt --manifest-path rust/Cargo.toml --all`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-protocol --lib`,
  `cargo test --manifest-path rust/Cargo.toml -p syncular-runtime canonical_commit_integrity --test protocol_contract`,
  `bun run --cwd rust/bindings/browser build:wasm:dev`,
  `bun test rust/bindings/browser/src/worker-realtime.test.ts rust/bindings/browser/src/client.test.ts rust/bindings/browser/src/react.test.ts`, and
  `bun test rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts`.
- Fresh pre-change guard:
  `.context/benchmarks/wp04-realtime-prechange-2026-05-19.json`.
- Browser dev E2E candidate gates:
  `.context/benchmarks/wp04-realtime-number-format-itoa-ryu.json` and
  `.context/benchmarks/wp04-realtime-number-format-itoa-ryu-rerun.json`.
- Rerun versus the fresh pre-change guard:
  `rust_realtime_live_ms=90.69 -> 93.63`,
  `rust_realtime_live_p95_ms=92.95 -> 94.70`,
  `rust_realtime_overhead_p50_ms=23.33 -> 22.98`,
  `rust_realtime_overhead_p95_ms=23.40 -> 24.32`,
  `rust_realtime_apply_total_ms=132 -> 123`,
  `rust_realtime_integrity_verify_total_ms=68 -> 63`, and
  `browser_served_rust_wasm_bytes=7470941 -> 7503209`.
- Decision: rejected and reverted. The integrity bucket improved modestly, but
  end-to-end realtime latency and p95 overhead regressed across both candidate
  runs, and the added dependencies grew the WASM bundle by about `32KiB`.

Retained browser timer binding fix:

- Browser worker realtime now binds default `setTimeout`/`clearTimeout`
  globals before storing them on the controller. Chrome requires the browser
  timer functions to be called with the global receiver, and unbound heartbeat
  scheduling raised `Illegal invocation` after websocket connect.
- The split-view demo exercises canonical Hono websocket realtime with two
  generated Rust browser clients. Adding a todo in Client A updated Client B
  over websocket with both panes remaining `Ready` and no app errors.
- Correctness gates passed:
  `bun test --cwd rust/bindings/browser src/worker-realtime.test.ts`,
  `bun run --cwd rust/bindings/browser tsgo`,
  `bun run --cwd apps/demo tsgo`,
  `bun --cwd apps/demo build`, and `bun run tsgo`.
- Decision: retained as a browser correctness fix. It does not add fallback
  behavior or move reconnect ownership out of the runtime.

Release measurement checkpoint:

- Current accepted WP-04 state was measured with release WASM:
  `.context/benchmarks/wp04-realtime-release-current-2026-05-19.json`.
- Result:
  `rust_realtime_live_ms=86.54`,
  `rust_realtime_live_p95_ms=88.81`,
  `rust_realtime_overhead_p50_ms=16.75`,
  `rust_realtime_overhead_p95_ms=17.65`,
  `rust_realtime_http_request_count=0`,
  `rust_realtime_binary_events=15`,
  `rust_realtime_apply_total_ms=25`,
  `rust_realtime_sync_pack_decode_total_ms=6`,
  `rust_realtime_integrity_verify_total_ms=6`,
  `rust_realtime_commit_apply_total_ms=6`, and
  `browser_served_rust_wasm_bytes=3445771`.
- Decision: use this as the release-mode guard for future WP-04 work. The
  dev-WASM integrity bucket was useful for finding obvious waste, but release
  mode no longer shows integrity verification as a meaningful bottleneck.

## Next Action

Pause WP-04 micro-optimizations unless a release-mode benchmark shows a real
regression. Future realtime protocol changes should compare against
`.context/benchmarks/wp04-realtime-release-current-2026-05-19.json` and keep
`rust_realtime_http_request_count=0` for the normal websocket fast path.
