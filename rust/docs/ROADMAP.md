# Rust Client Roadmap

This is the day-to-day roadmap for the Rust-first Syncular client. Update this
file after every retained work chunk.

Status legend:

- `[ ]` planned
- `[~]` in progress
- `[x]` accepted
- `[!]` blocked or needs decision

## Autonomous Work Loop

Every Rust-first work session should follow this loop unless the user asks for a
read-only review:

1. Record the active work package.
2. Check the change against
   [`CLIENT_PRODUCT_CONTRACT.md`](CLIENT_PRODUCT_CONTRACT.md).
3. If the change adds or preserves a fallback, alias, old protocol path, or
   legacy behavior, update
   [`COMPATIBILITY_REGISTER.md`](COMPATIBILITY_REGISTER.md) first.
4. Run or cite the accepted baseline.
5. Implement one scoped change.
6. Run the required tests.
7. Run the relevant benchmark gate.
8. Compare against the previous accepted result.
9. Keep, revise, or revert.
10. Update [`BENCHMARK_LOG.md`](BENCHMARK_LOG.md) and the work package.
11. Commit separately with the test and benchmark evidence.

## Session Start Checklist

1. Read this roadmap.
2. Read the active WP file.
3. Read the product-contract sections that apply to the WP.
4. Check [`COMPATIBILITY_REGISTER.md`](COMPATIBILITY_REGISTER.md) if the WP
   touches old protocol paths, fallbacks, aliases, or legacy JS behavior.
5. Read the relevant gate commands in [`QUALITY_GATES.md`](QUALITY_GATES.md).
6. If the work can affect performance, run or cite the latest accepted
   baseline before changing code.

## Session End Checklist

1. Run the required gates or state why a gate was not applicable.
2. For performance work, log previous/current/delta/decision in
   [`BENCHMARK_LOG.md`](BENCHMARK_LOG.md).
3. Update the active WP status, latest evidence, and next action.
4. Update [`COMPATIBILITY_REGISTER.md`](COMPATIBILITY_REGISTER.md) if a fallback
   or legacy path was added, retained, removed, or reclassified.
5. Update this roadmap if priority or status changed.
6. Commit the accepted slice. Do not leave retained work uncommitted unless the
   user explicitly asks to pause before commit.

## Accept / Reject Rules

- Correctness fixes may be retained with a measured regression, but the
  regression must be explicit in `BENCHMARK_LOG.md` and followed by a
  performance-recovery next action.
- Performance changes must improve the target metric or be reverted, unless
  they remove meaningful complexity without measurable regression.
- A local benchmark result is not enough if the change is expected to affect
  real app bootstrap, local-query, online-propagation, or reconnect behavior;
  run the external app-style benchmark listed in `QUALITY_GATES.md`.
- Do not optimize for full-partition happy paths when the product contract
  requires scoped/subscription-shaped access.
- Do not retain compatibility branches just because they exist. Prefer deletion
  unless the compatibility register records a current exception.

## Now

- `[!]` [`WP-03 Binary Apply Performance`](work-packages/WP-03-binary-apply-performance.md)
  - Small bind-loop/cache probes, SQLite `json_each()` import, and direct
    `sqlite3_carray_bind` import were rejected. A Rust-backed virtual table
    import was also rejected because callback-per-cell was slower than binding.
    The accepted browser path is binary-table direct payload apply. Further
    client apply micro-probes are stopped; the remaining large-bootstrap work
    needs a scoped artifact design.
- `[~]` [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)
  - New continuation of the WP-03 performance findings. Design and benchmark a
    scoped, content-addressed artifact path without whole-partition assumptions
    or Worker-hot-path SQLite file generation. The shared TS/Rust manifest
    contract, server metadata table/helpers, authenticated artifact route, and
    pull-response artifact reference/eligibility contract are in place. Artifact
    body storage writes have a canonical helper, native/browser transports can
    download and verify artifact bytes, and native Diesel can apply verified
    SQLite artifacts through the generated schema projection path. Server-side
    background/precompute can now create scoped Bun SQLite artifact bodies
    explicitly, outside the pull hot path. Browser owned SQLite can now
    advertise schema-bound artifact support, download verified artifact bodies,
    deserialize them through `sqlite3_deserialize`, and directly import rows
    through an attached in-memory SQLite schema when the pull mode does not
    need per-row transforms. The current artifact body path is gzip-compressed
    end to end and cuts 100k artifact response bytes by about `67%` while
    keeping direct-import wall time flat. Browser direct artifact recovery now
    rejects corrupted artifact downloads before local rows are mutated and
    recovers on the next pull. Browser artifact precompute now follows all
    scoped pages, eliminating the remaining row-chunk apply from the 100k
    artifact benchmark and moving Rust bootstrap to `68.6ms`. At 500k rows,
    compact browser artifacts are `260.82ms` versus `618.95ms` for row chunks;
    artifact bytes are now `4.74MB` after `WITHOUT ROWID` plus gzip level 6,
    down from `6.50MB` before compaction. Browser direct artifact correctness
    now covers corrupted downloads and subscription revocation clearing. The
    high-level Hono server factory can now serve scoped artifacts, and the Bun
    SQLite artifact encoder handles Postgres-style snapshot values. The normal
    external app-style benchmark is unblocked again after binary snapshot
    encoding learned to accept Postgres-style integer strings and `Date`
    timestamp values from database drivers; the latest normal row-chunk Rust
    500k bootstrap is `6099.68ms` versus TS `3855.10ms`, with Rust local apply
    faster (`1692ms` versus `2114.80ms`) but derived schema work still
    expensive (`3213.03ms`). Native direct artifact import via temp-file attach
    was rejected because Diesel
    cannot detach the artifact database cleanly inside the active transaction;
    native stays on verified artifact row projection until a raw SQLite
    deserialize hook or no-row-delta pull mode exists. The browser benchmark
    harness now records the actual Rust pull request limits and artifact
    capability bit, plus server artifact-cache lookup timing. A 100k artifact
    page-size probe was rejected because it fell back to binary chunks and was
    about `2.35x` slower than the 50k direct artifact baseline. The normal
    row-chunk path is now measured externally again. Scoped artifacts now select
    correctly in the external app-style benchmark when precomputed with the
    server's `60k` bundled artifact key: Rust 500k bootstrap improves
    `6099.68ms -> 4844.13ms` and local apply improves `1692ms -> 1379ms`, but
    bytes and peak memory are still worse (`3.29MB -> 3.94MB`,
    `694.38MB -> 750.48MB`). Browser artifact apply now moves fetched artifact
    bytes into SQLite deserialize instead of cloning them. Immediate artifact
    `DETACH` before commit was rejected because SQLite reports the attached DB
    as locked.
- `[~]` [`WP-04 Realtime Runtime`](work-packages/WP-04-realtime-runtime.md)
  - Make websocket deltas the canonical fast path with verified replay,
    overflow recovery, and runtime-owned reconnect/backoff. First retained
    slice makes `requiresPull=true`/`droppedCount>0` authoritative in the
    browser worker so recovery-marked websocket messages always use HTTP pull
    instead of local row-payload apply. The browser realtime gate stayed on the
    binary fast path with `rust_realtime_http_request_count=0` and `15` binary websocket
    events. Cursor-only recovery pulls now ACK the triggering websocket cursor
    after successful recovery so the server can clear in-flight state even when
    the pull result has no larger subscription cursor. Websocket binary deltas
    now carry real subscription IDs plus pull-compatible integrity roots, and
    browser Rust realtime apply verifies/persists those roots before local row
    changes are reported. The obsolete inline JSON websocket delta path has
    been removed from the browser worker, Rust wasm API, and server manager;
    current realtime delivery is binary sync-pack or explicit pull-required
    wakeup. Realtime apply results no longer echo applied commit rows back over
    the wasm boundary. The browser scoreboard now reports Rust-side realtime
    apply timing breakdowns; current evidence points at pull/apply work rather
    than notification. Browser SQLite app-row upserts now reuse the existing
    prepared-statement cache for realtime batches, realtime commit apply no
    longer rewrites canonical server row payloads before batching them into
    SQLite, and the benchmark now reports a derived Rust/browser realtime
    overhead lane plus sync-pack decode/transform timing in addition to
    end-to-end live latency. The latest retained instrumentation splits
    realtime apply into integrity verification, commit apply, subscription
    state persistence, and notify timing; current evidence says canonical
    integrity verification is the real Rust-side realtime hotspot, not
    subscription-state SQLite writes. A sorted-map canonicalization probe was
    rejected and reverted after benchmark regression. The first retained
    integrity recovery replaced per-string canonical JSON allocations with an
    in-place string writer, cutting realtime integrity verification
    `159ms -> 76ms` and total realtime apply `237ms -> 128ms` on the local
    browser guard. A guarded sorted-object fast path then reduced integrity
    verification further to `68ms` while keeping canonical fallback behavior.
    Direct numeric writes trimmed total realtime apply further to `122ms`.
    One-pass canonical object writing now avoids the sorted-key pre-scan on the
    normal sorted-map path, moving integrity verification to `65/66ms` across
    two runs while total apply stayed flat/noisy.

## Next

- Continue [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)
  by reducing scoped artifact bytes and peak memory while preserving direct
  SQLite import and `snapshotChunkCount=0` in the external app-style benchmark.
  The next retained change must compare against
  `.results/2026-05-19T20-35-44-641Z/syncular-rust/bootstrap.json` externally
  and `.context/benchmarks/wp12-owned-artifact-bytes-500k-rerun.json` locally.

## Later

- `[x]` [`WP-01 Protocol Integrity`](work-packages/WP-01-protocol-integrity.md)
- `[x]` [`WP-02 Protocol Kernel`](work-packages/WP-02-protocol-kernel.md)
- `[ ]` [`WP-05 Adaptive Bootstrap`](work-packages/WP-05-adaptive-bootstrap.md)
- `[ ]` [`WP-06 Local Read Models`](work-packages/WP-06-local-read-models.md)
- `[ ]` [`WP-07 CRDT Fields`](work-packages/WP-07-crdt-fields.md)
- `[ ]` [`WP-08 Testkit And Conformance`](work-packages/WP-08-testkit-conformance.md)
- `[ ]` [`WP-09 Native Bindings And Packaging`](work-packages/WP-09-native-bindings-packaging.md)
- `[ ]` [`WP-10 Browser Package And Docs`](work-packages/WP-10-browser-package-docs.md)
- `[ ]` [`WP-11 Server Edge And Offline Auth`](work-packages/WP-11-server-edge-offline-auth.md)
- `[ ]` [`WP-13 Observability And Debuggability`](work-packages/WP-13-observability-debuggability.md)

## Blocked / External

- Windows native/JVM packaging needs a real Windows host or runner.
- Full iOS/macOS/Android lifecycle validation needs real app-shell coverage
  beyond command-line smokes.
- CI jobs are intentionally skipped until GitHub-side work is requested.

## Reference

Detailed background remains in [`reference/`](reference/). If a reference doc
changes the implementation order, update this roadmap and the affected work
package in the same commit.
