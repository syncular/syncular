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

- `[x]` [`WP-39 Docs Source Of Truth And Consistency`](work-packages/WP-39-docs-source-of-truth-and-consistency.md)
  - Accepted. Reference API is now the only generated OpenAPI tree, duplicate
    `/docs/api` pages were removed, stale JSON snapshot wording was replaced,
    app-facing mutation docs stay on insert/update/delete, remaining `upsert`
    examples are explicitly scoped to internal protocol/server/native ABI
    details, Start/Installation now split JavaScript-first and Rust-first
    paths, Reference has a `Packages And Crates` hub, Testing has a decision
    matrix and shipping checklist, and Rust Delivery now has a cautious Native
    Hosts page for Swift/Kotlin/JVM/React Native/Tauri/Electron boundaries.
    Follow-up intro/learn cleanup now keeps the docs root, Start, comparison,
    and Learn pages aligned with the Rust-owned client runtime, generated app
    contract, binary snapshot chunks/artifacts, and Kysely/Diesel host-query
    split.
- `[x]` [`WP-38 Release Automation`](work-packages/WP-38-release-automation.md)
  - Accepted. Rust crates now share npm's release version source and staging
    syntax. The `release` branch publishes `0.1.0-staging.<run>` prereleases
    with npm tag `staging`; `v*` tags/manual stable dispatch publish exact
    stable versions with npm tag `latest`. Cargo crates are stamped and
    published in explicit dependency order, `main` stays checks-only for
    publishing, Rust native checks now dry-run Cargo package publishing, and
    npm publishing now has a real all-package dry-run with workspace-local
    publish helpers. Scheduled nightly/weekly Actions plus their scheduled-run
    history were removed so release automation starts from a clean explicit
    lane.
- `[x]` [`WP-37 Rust Crates Publishing`](work-packages/WP-37-rust-crates-publishing.md)
  - Accepted. Published `syncular`, `syncular-protocol`,
    `syncular-codegen`, `syncular-runtime`, `syncular-testkit`, and
    `syncular-client` `0.1.0` to crates.io. Release defaults no longer include
    demo fixtures, internal crate dependencies are versioned, `syncular` is
    reserved as the canonical crate name, and `syncular-testkit` now packages
    its conformance fixture inside the crate tarball.
- `[x]` [`WP-36 Binding Example Clarity`](work-packages/WP-36-binding-example-clarity.md)
  - Accepted. Feature docs now state that product semantics are binding-neutral
    and binding-specific snippets are examples, not defaults. Presence,
    blobs, offline auth leases, and undo/redo now label TypeScript/browser,
    Rust, and native host examples explicitly. Testing docs now distinguish
    the TypeScript/server/browser `@syncular/testkit` from the Rust/native
    `syncular-testkit` and link between those paths. Docs link/type/build
    gates passed.
- `[x]` [`WP-35 Rust-First Public Docs API Cleanup`](work-packages/WP-35-rust-first-public-docs-api-cleanup.md)
  - Accepted. Public docs that still taught pre-Rust client APIs now use the
    generated app contract, Rust-owned SQLite runtime, generated
    subscriptions, generated mutations, current lifecycle/diagnostics APIs,
    current conflict APIs, and current server version-aware handler flow. The
    focused stale API scans, docs link checker, docs typecheck/build, and
    touched-page browser smoke passed.
- `[x]` [`WP-34 Rust-First Docs Information Architecture`](work-packages/WP-34-rust-first-docs-information-architecture.md)
  - Accepted. Public docs moved from the old
    `Build`/`Rust Client` split to a Rust-first structure:
    `Start`, `Learn`, `Client`, `Server`, `Features`, `Testing`, `Operate`,
    and `Reference`. Binding-specific docs now live under `Client` so browser
    TypeScript, React, React Native/Expo, Tauri/Electron, Rust, Swift,
    Kotlin/Android, and JVM read as host surfaces of one Syncular client rather
    than separate products. The `Server` section now has implementation guides
    for setup, table handlers, scopes/auth, snapshot/pull, apply/push,
    realtime WebSocket, blobs, and external changes, while exact API details
    stay under `Reference`. The `Features` section now has cross-platform
    capability guides for blobs, CRDT fields, field encryption, presence,
    conflict resolution, offline auth leases, undo/redo, local read models,
    audit/history, errors, migrations, and performance patterns. Final
    stale-link, old-client, and redirect-decision scans are clean; no old
    public docs redirects were retained.
- `[x]` [`WP-30 Foundation Cleanup And Complexity Reduction`](work-packages/WP-30-foundation-cleanup-complexity.md)
  - New cross-cutting cleanup WP for polishing, removing unnecessary code,
    deleting stale aliases/backwards-compatibility paths, and reducing
    foundation complexity before more surface is added. Start with the
    compatibility-register closure pass and keep every cleanup slice small,
    gated, and independently revertible. First slice closed the stale realtime
    wake-up-only docs item by updating docs to describe websocket sync-pack
    deltas as the fast path and HTTP pull as recovery/checkpoint. Current slice
    removes the legacy wa-sqlite browser dialect package, TypeScript
    transport-ws package, and unnecessary umbrella aliases
    `syncular/dialect-wa-sqlite`, `syncular/transport-ws`, and
    `syncular/server-dialect-neon`; targeted package/doc gates passed, while
    full `knip` is still blocked by unrelated WP-27+ relay findings. The
    migration legacy source-checksum upgrade branch is also removed; migration
    tracking now only supports generated `sql_trace_v1` checksums or disabled
    checksums. Console WebSocket first-message auth was reclassified as an
    accepted browser platform capability rather than cleanup debt.
    Service-worker `postMessage` wake delivery was also accepted as a tested
    platform fallback, while legacy single-commit wake parsing was removed.
    Database-inline snapshot chunk bodies are now documented as an accepted
    storage mode; missing external chunk bodies fail closed. Public API alias
    cleanup started with low-level browser Rust store type aliases and the old
    `accept-server` conflict-resolution spelling, and the browser conflict
    resolution type now only accepts the canonical runtime values. The old
    JavaScript-hosted browser store bridge and `web-store` feature were removed
    in favor of the Rust-owned SQLite browser runtime. The
    `@syncular/client-expo` alias package was removed so React Native stays the
    single native TypeScript bridge package. Native realtime lifecycle aliases
    were also removed so host bindings expose only the explicit realtime worker
    start/stop methods. Unused browser client event type aliases were removed
    in favor of the canonical runtime event type names, and unused browser
    worker response aliases were removed from the worker protocol surface.
    Browser lifecycle options now use the canonical network status source type
    directly, and testkit sync-response helpers now return the canonical core
    `SyncChange` type. The browser package root no longer exports low-level
    Rust/WASM helper modules, and the unused direct Rust-owned SQLite wrapper
    was deleted; callers get the canonical client/database API and runtime
    artifact helpers. The old transport per-call `onAuthError` callback was
    removed so `authLifecycle` is the single auth refresh contract.
    Runtime/native/browser host JSON CRDT request parsing now accepts only
    generated camelCase fields, and the old websocket timing alias was removed
    so transport stats read the current server field names.
    Browser realtime diagnostics now name binary apply failure directly instead
    of calling HTTP pull recovery a fallback. Rust native/browser transports no
    longer decode JSON row-frame snapshot chunks; runtime clients request
    `binary-table-v1`; explicit server/core JSON row-frame negotiation,
    encoding, inline snapshot, fixture, and row-frame timing paths were removed.
    Unspecified server pulls default to `binary-table-v1` snapshot chunks.
    Unspecified combined sync responses now default to `binary-sync-pack-v1`;
    explicit `json-v1` sync-pack negotiation and the Hono JSON combined
    response branch were removed, so combined sync responses are binary-only.
    The now-redundant `syncPackEncodings` and `snapshotEncodings` request
    fields were also removed from TS/Rust protocol shapes, request builders,
    testkit helpers, and protocol fixtures. Final fresh scan found no active
    old protocol/package names after OpenAPI regeneration; targeted `knip`
    passed for relevant package surfaces, while full `knip` remains blocked
    only by the known out-of-scope relay evaluation unused exports. Follow-up
    docs/generated-banner cleanup now avoids implying app authors maintain a
    root low-level codegen file or select legacy client dialects; the public
    Rust-client docs now show the default generated handoff path. Public Build
    and Runtimes docs now route deleted client/setup/auth/realtime/blob pages to
    the current Rust-client, concepts, recipe, and server-reference pages.
- `[x]` [`WP-29 Rust Client Console Workbench`](work-packages/WP-29-rust-client-console-workbench.md)
  - Slice 1 persistence is accepted. Console diagnostics now persist normalized,
    size-bounded, sensitive-key-guarded Rust client snapshots in
    `sync_client_diagnostic_snapshots`; latest/list/history routes read from
    storage; Fleet receives diagnostic freshness/health summaries; and
    ClientDetails shows retained snapshot history. Browser smoke on
    `2026-05-23` verified `/fleet` and `/fleet/demo-left` against the demo
    console API: runtime health/freshness, `@syncular/client`, `indexedDb`,
    recent diagnostic codes, snapshot history, and recent timeline evidence
    render without browser warnings/errors or horizontal overflow. A console
    dev/static SVG favicon link was added to prevent favicon `404` noise in
    local smoke runs. Further attempt-correlation, row-investigation, and
    guided repair workflows are deferred to separate future work.
- `[x]` [`WP-31 Rust Client Benchmark Parity And Performance Triage`](work-packages/WP-31-rust-client-benchmark-parity-performance.md)
  - Created from the 2026-05-22 external `offline-sync-bench` Rust-client run.
    The work first fixes benchmark measurement gaps, then adds real Rust-client
    parity for offline replay, large offline queue, and blob flow, and only then
    optimizes proven slow paths. Slice 1 measurement correction is retained in
    the external benchmark adapter: online visibility is now measured before
    writer cleanup; initial realtime diagnostics showed `15/15` online events
    used pull-required recovery; dashboard query plans prove
    temp B-tree aggregation over task rows; permission revocation takes two sync
    attempts and temporarily clears all task rows; reconnect storm now reports
    per-client first-pull timings and shows the `250`-client cliff is first HTTP
    pull latency, not extra sync loops. Slice 2 adds native Rust outbox coverage
    to the external adapter: `offline-replay` now completes `10/10` queued
    writes in `50.17ms`, and `large-offline-queue` completes `1000/1000` queued
    writes in `2169ms` with `50` sync attempts. Remaining caveat: the Bun
    benchmark harness uses Rust memory storage, so process-restart durability
    still needs a browser-worker OPFS/IndexedDB lane. Slice 3 adds native Rust
    blob-flow coverage: a `512KiB` blob uploads in `26.04ms`, metadata reaches a
    second Rust client in `25.58ms`, cache-clear re-download takes `16.61ms`,
    and interrupted queued upload recovery drains successfully after the Rust
    retry backoff. Slice 4 adds bounded `config.push.outboxBatchLimit` for the
    Rust web client, leaving the default at `20`; in the `1000`-write queue
    benchmark, a configured limit of `100` reduced convergence from `2169ms` to
    `1573.21ms` and HTTP requests from `100` to `20`, while larger limits were
    slower. Slice 5 adds an explicit generated `countBy` dashboard read model:
    deep dashboard p50 is now `0.03ms` versus raw SQL p50 `62.36ms` in the same
    run, so the original slow row was a missing read-model/query-shape issue,
    not a general Rust local SQLite/runtime problem. Slice 6 corrects the
    realtime fallback diagnosis and adds payload-byte diagnostics; debug
    telemetry then showed the server was attempting binary websocket packs but
    failing to encode driver string `bigint` versions as safe integers. Slice 7
    normalizes handler version columns before emitted changes/conflict rows
    reach the binary pack encoder. The fixed online run
    `2026-05-22T12-49-11-883Z` applies `15/15` realtime binary sync-packs, needs
    `0` pull recoveries, and improves reader visibility to p50 `8.94ms` / p95
    `16.25ms`. Slice 8 splits blob upload retry timing from sync/outbox retry:
    blob retry recovery improves from `1033.88ms` to `116.36ms` while sync
    commit retry keeps the conservative `1000ms` base. Slice 9 changes Rust web
    subscription scope shrink to clear only revoked scope rows; permission
    change now converges in one sync attempt at `38.95ms`, keeps the retained
    project visible at `500` rows throughout, and halves requests/bytes versus
    the previous two-sync full-clear/reload path. Slice 10 adds worker
    realtime reconnect catch-up, reconnect/recovery jitter knobs, and a
    worker-realtime reconnect benchmark lane. This fixes missed-change
    correctness on websocket reconnect and improves the `125`-client reconnect
    path versus direct HTTP, but the `250`-client external-write storm still
    hits an approximately `2s` cursor-only HTTP recovery cliff. That cliff is
    handed off to WP-32 because it needs server/realtime payload or recovery
    fanout design, not more client retry tuning. Slice 11 makes the default
    Rust web outbox batch adaptive: `100`-write queues keep the old `20`-commit
    path, while due queues over `100` drain in `100`-commit pushes until the
    large queue is exhausted. Same-session large-offline-queue control improved
    `500` writes from `1307.71ms` to `779.54ms` and `1000` writes from
    `2486.82ms` to `1887.19ms`, both with `80%` fewer requests; explicit
    `outboxBatchLimit` remains a fixed override. Slice 12 adds an opt-in
    `SYNCULAR_RUST_DURABLE_REOPEN=1` IndexedDB-compatible reopen probe: offline
    replay keeps `10` pending outbox commits and `10` local title changes across
    close/reopen before draining to `10` acked commits, and the `100`-write
    large queue keeps `100` pending commits and local title changes across the
    same reopen. Slice 13 records a watch-only online binary-pack guard:
    `15/15` reader realtime sync-packs applied through the binary path, with
    `0` pull-required recoveries and p95 visibility `21.73ms`. Slice 14 adds
    explicit blob upload `retryNow` processing for manual or online-triggered
    recovery without lowering the automatic `100ms` blob retry backoff; the
    `blob-flow` retry lane improves from `115.64ms` over `2` queue attempts to
    `13.15ms` over `1` attempt. Slice 15 adds the stronger browser durability
    lane: real Chrome worker, `opfsSahPool`, browser process restarts between
    bootstrap/offline queue/replay, reopened outbox `10/10` pending, final
    outbox `10/10` acked, and no storage fallback. A follow-up Hono websocket
    origin-policy fix keeps configured browser origin rejection strict while
    allowing originless non-browser websocket clients; the rebuilt external
    `syncular-rust` online-propagation run `2026-05-23T04-37-19-197Z`
    completed with `15/15` binary realtime sync-packs and `0` pull-required
    recoveries. A 2026-05-23 recheck raises the adaptive large-outbox cap to
    `1000`, improving `1000` queued writes from `2063.25ms` to `1651.45ms` and
    reducing attempts/requests from `10`/`20` to `1`/`2`; permission-change
    comparisons now split same-client revoke from rebootstrap so Syncular's
    native same-client behavior is not compared against another stack's fresh
    client bootstrap. No additional WP-31 client-side parity slice is currently
    identified; the remaining high-scale queue gap is server conditional apply
    cost, not Rust client outbox overhead.
- `[x]` [`WP-03 Binary Apply Performance`](work-packages/WP-03-binary-apply-performance.md)
  - Small bind-loop/cache probes, SQLite `json_each()` import, and direct
    `sqlite3_carray_bind` import were rejected. A Rust-backed virtual table
    import was also rejected because callback-per-cell was slower than binding.
    The accepted browser path is binary-table direct payload apply. Further
    client apply micro-probes are stopped; the larger large-bootstrap direction
    moved to and was accepted through WP-12 scoped artifacts.
- `[x]` [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md)
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
    `6099.68ms -> 4845.39ms` and local apply improves `1692ms -> 1392ms`.
    Gzip level 9 reduced external artifact bytes `3.94MB -> 3.53MB`, and the
    browser path now streams artifact fetch/apply one body at a time inside the
    apply transaction, reducing peak memory `758.2MB -> 746.92MB`. Bytes and
    peak memory are still worse than row chunks (`3.29MB`, `694.38MB`).
    Browser artifact apply also moves fetched artifact bytes into SQLite
    deserialize instead of cloning them. Immediate artifact `DETACH` before
    commit was rejected because SQLite reports the attached DB as locked. The
    nullable-column, attached-PRAGMA, larger-bundle, SQLite-owned-buffer, and
    temp-table staging probes were all rejected. Separate-SQLite row streaming
    and segmented artifact apply were also rejected because they reduced memory
    pressure only by regressing wall time heavily. Browser direct artifact pulls
    now cap `maxSnapshotPages` to `2`, bounding attached artifact retention per
    apply transaction without row-copy staging. Same-session local 500k browser
    artifact bootstrap improved `623.48ms -> 595.93ms` and JS heap delta dropped
    `10.40MB -> 2.60MB`; external app-style artifacts now use a `40k`
    precompute row limit and report 500k bootstrap `1334.25ms`, local apply
    `198ms`, and peak memory `707.92MB` with `snapshotChunkCount=0`.
    Latest external evidence shows derived-schema setup is now a larger
    app-harness cost than artifact apply. The external Rust adapter now
    consumes the generated `localDerivedSchema` contract directly, and the
    generated runtime/native/browser contract now carries and consumes
    `localBaseSchema.tableSetupSql` so app-table DDL has the same generated
    source of truth. Post-contract external guards showed generated local-base
    DDL is not the cause of the current slow 500k session because hardcoded DDL
    was similarly slow; keeping local-base metadata off the hot copied
    `AppSchema` value recovered release 500k bootstrap to `1115.31ms` and
    local apply to `211ms`. Keep the previous accepted external baseline until
    a stable release guard is re-established. The before-bootstrap derived-schema
    install probe was rejected because it
    regressed 500k bootstrap (`1396.01ms -> 1827.83ms`), local apply
    (`208ms -> 1525ms`), and peak memory (`695.97MB -> 761.14MB`). Keep
    bulk-load-then-derived-rebuild as the app harness shape. A narrower
    benchmark-only probe that installed only indexes before import was also
    rejected: 500k wall time improved modestly (`1077.21ms -> 1046.78ms` /
    `1052.50ms`), but local apply regressed (`210ms -> 755ms` / `770ms`) and
    peak memory rose (`616.92MB -> 652.39MB` / `645.83MB`). Generated
    `countBy` read-model tables now use `WITHOUT ROWID`, improving the
    external app-style scoped artifact 500k lane from `1430.17ms -> 1382.56ms`
    and derived-schema time from `976.02ms -> 930.41ms` without changing app
    semantics.
    Browser E2E now reports Rust schema install time separately and also
    records generated schema phases. The latest 100k release artifact gate
    reports `rust_schema_install_ms=5.34`, `rust_schema_base_ms=1.64`,
    `rust_schema_derived_ms=3.70`, `rust_schema_read_model_rebuild_ms=0.99`,
    and cached schema install `1.91ms`. A local external-schema probe showed
    500k derived work is index dominated (`1070.57ms` indexes versus
    `38.88ms` read-model rebuild), so the next derived-schema experiments
    should target app-declared index shape/order with external proof. Snapshot
    artifact pages are now protocol-exclusive: a page with artifact refs cannot
    also carry inline rows, chunk refs, or chunk manifests. Generated schema
    metadata now includes structured local-index columns, so future
    derived-schema experiments can reason from generated metadata instead of
    parsing index SQL. Local-index metadata now also carries structured
    `unique` and `partial` booleans. The generator now omits redundant
    generated local indexes when a longer non-unique, non-partial,
    non-expression index covers the shorter index's leading column sequence.
    External app-style scoped artifact 500k bootstrap improved
    `1382.56ms -> 1142.29ms`, derived schema improved
    `930.41ms -> 672.43ms`, and peak memory improved `696.50MB -> 667.59MB`;
    the external local-query lane stayed healthy (list p50 `0.16ms`, search
    p50 `0.22ms`). Browser artifact recovery coverage now includes transient
    artifact download failures as well as corrupted artifact bytes, with
    resource-specific byte-fetch diagnostics. Server artifact lookup now
    selects the largest scoped artifact that fits the current pull capacity.
    The matched 100k artifact guard stayed neutral (`143.14ms -> 144.56ms`),
    and a 25k-precomputed / 50k-client-page probe kept
    `rust_snapshot_chunk_binary_count=0` instead of falling back to row chunks.
    The external 40k artifact guard stayed in band at 500k
    (`1142.29ms -> 1154.34ms`, peak memory `667.59MB -> 662.03MB`), and the
    external 20k artifact robustness probe also kept `snapshotChunkCount=0`.
    Browser artifact benchmark output now reports direct artifact count, bytes,
    fetch, hash, decompress, and apply timings; the 100k guard stayed in band
    at `136.33ms`, and the external 500k guard stayed healthy at `1002.06ms`
    with `snapshotChunkCount=0`. Browser direct artifact pages now checkpoint
    after verified pages with `bootstrapStateAfter`, so a later artifact failure
    resumes from the committed page instead of restarting; the follow-up gate
    stayed healthy at external 500k bootstrap `995.58ms` with
    `snapshotChunkCount=0`, while peak memory moved slightly worse
    (`668.20MB -> 671.13MB`). Artifact checkpoint count/time are now explicit
    browser sync/scoreboard metrics, and the local 100k guard reports one
    checkpoint with neutral wall time. A deferred apply-transaction probe was
    rejected because same-session local 100k artifact wall time stayed flat
    (`136.18ms -> 135.81ms`) while JS heap delta worsened
    (`2.19MB -> 7.62MB`). Browser apply batches now start in a pending state
    and direct artifact bytes are fetched before the first local mutation. This
    is retained as a resource-state improvement: external 500k peak memory
    improved `671.13MB -> 637.55MB`, local apply stayed flat, response bytes
    stayed flat, and `snapshotChunkCount=0`, but external bootstrap regressed
    `995.58ms -> 1107.80ms`. Skipping a duplicate final subscription-state
    write after checkpointed artifact pages recovered part of that regression:
    external bootstrap is now `1062.50ms`, peak memory is `633.50MB`, local
    apply is `208ms`, and `snapshotChunkCount=0`. A follow-up local app-table
    `WITHOUT ROWID` probe improved same-session derived-schema wall time but
    was rejected because peak memory regressed to `655.05MB`. The generated
    schema JSON contract now also carries `localBaseSchema.tableSetupSql`, so
    non-TS adapters and benchmarks can consume generated local table DDL instead
    of hardcoding it. The final index-before-import probe was rejected after it
    modestly improved wall time but regressed local apply and peak memory.
    WP-12 is accepted for the Rust-client foundation; further artifact work is
    deferred until it changes the SQLite/artifact state model rather than
    repeating install-order, page-size, or staging micro-probes.
- `[x]` [`WP-14 Developer Experience And Generated APIs`](work-packages/WP-14-developer-experience-generated-apis.md)
  - First retained TypeScript generated-client slice narrows
    `database.mutations` to generated inputs and patches. App code can now call
    `database.mutations.tasks.insert(NewTask)` without supplying server-owned
    columns such as `server_version`, while runtime execution still goes
    through the existing Rust-first mutation/outbox path. Swift and Kotlin
    generated native clients now also expose `diagnosticSnapshot()` helpers over
    the WP-13 runtime snapshot host method, covered by codegen assertions and
    native smokes. Generated Rust, TypeScript, Swift, and Kotlin mutation
    input/payload types now omit CRDT `stateColumn` fields while keeping those
    fields visible for reads, metadata, and changed-row observation. The new
    `reference/GENERATED_CLIENT_API.md` page captures the cross-platform
    generated-client surface and red lines in one concise guide. Swift and
    Kotlin generated native row mutations now align with Rust/TypeScript table
    namespaces through `mutations` and `queuedMutations`.
- `[x]` [`WP-10 Browser Package And Docs`](work-packages/WP-10-browser-package-docs.md)
  - The legacy pure TypeScript client, React package, client plugin packages,
    demo app, and JS-client integration/runtime/perf suites have been removed.
    The Rust-owned browser binding is now the canonical `@syncular/client`
    package, with ergonomic `createSyncularClient()` and
    `createSyncularReact()` entrypoints, bridge packages for Tauri, React
    Native, and Expo, and CRDT adapters at `@syncular/client-crdt-adapters`.
    Docs and package metadata now point at the Rust-first client path.
- `[x]` [`WP-05 Adaptive Bootstrap`](work-packages/WP-05-adaptive-bootstrap.md)
  - First retained slice restores the pre-Rust staged-bootstrap principle in
    the Rust-first path. Generated subscriptions across Rust/TS/Swift/Kotlin
    now carry local-only `bootstrapPhase`; Rust native/web pull selection only
    starts the lowest pending phase while continuing ready or already
    bootstrapping higher phases. Browser sync results carry per-subscription
    checkpoint metadata, and the TypeScript binding derives the aggregate
    `criticalReady` / `interactiveReady` / `complete` status plus phase
    summaries without adding that aggregate machinery to the WASM binary. The
    browser worker/realtime event bus now emits `bootstrapChanged`. Release
    package size remains under budget (`3.29MiB` raw, `1.36MiB` gzip), and the
    local 100k release artifact guard stayed flat (`147.84ms -> 147.15ms`).
    Generated Rust/TypeScript/Swift/Kotlin app clients now expose ergonomic
    phase maps/helpers, and the browser/local integration docs show the
    app-facing staged-bootstrap flow. Native `SyncCompleted` events now expose
    the aggregate `bootstrap` readiness payload through Rust worker events,
    facade JSON, and generated Swift/Kotlin event decoders. The native-only
    status path is kept behind the `native` feature, so the release browser
    WASM size gate remains under budget.
- `[x]` [`WP-06 Local Read Models`](work-packages/WP-06-local-read-models.md)
  - First retained slice adds explicit `countBy` read models to
    `generated/syncular.codegen.json`. The generator now emits the read-model
    contract in `syncular.schema.json`, Rust SQL constants, and TypeScript schema
    installers that create table/triggers and rebuild only on first install or
    schema-version change. Generated read-model tables are now typed in Kysely
    and Diesel query surfaces while staying out of app-table sync/mutation
    metadata, and TypeScript now exports `syncularGeneratedLocalReadModels` so
    host packages can consume the generated setup/rebuild contract. The
    generated TypeScript installer now also executes setup/rebuild through that
    exported contract instead of duplicated SQL blocks, and
    `syncular.schema.json` carries the generated `setupSql`/`rebuildSql` for
    non-TS tooling. The todo fixture proves rebuild, update, delete invalidation,
    and typed Diesel reads.
    Generated TypeScript clients now also export local index metadata plus
    explicit derived-schema phase helpers for index setup, read-model setup, and
    read-model rebuild, so app adapters can consume the generated contract
    directly instead of reconstructing local schema SQL. A generated
    `liveSetup` install mode and matching benchmark switch were rejected after
    the 500k gate regressed versus the default installer.
    `syncular.schema.json` now also exposes a flattened `localDerivedSchema`
    contract for non-TS adapters.
    Browser scoreboard now measures raw aggregate and read-model aggregate lanes:
    at 100k rows, Rust read-model aggregate p50 is `0.05ms` vs TS `0.53ms`
    while raw aggregate remains visible (`23.00ms` Rust vs `161.09ms` TS). This
    is opt-in app intent, not a hidden runtime cache. The local
    `offline-sync-bench` Rust adapter was also wired to generated
    `syncular.schema.json` SQL instead of hand-written read-model fixtures; the
    dev-WASM external local-query gate stayed in band (`0.67ms -> 0.66ms` list
    p50, `0.97ms -> 0.88ms` search p50, `0.08ms -> 0.08ms` read-model
    aggregate p50), and the external bootstrap gate stayed in the old row-chunk
    band (`6099.68ms -> 6240.52ms` Rust 500k bootstrap). Initial `countBy` read
    models are accepted; new read-model kinds should be tracked as separate
    work.
- `[x]` [`WP-04 Realtime Runtime`](work-packages/WP-04-realtime-runtime.md)
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
    two runs while total apply stayed flat/noisy. A follow-up `itoa`/`ryu`
    numeric formatting probe was rejected because it improved integrity
    verification modestly but regressed end-to-end realtime latency and grew the
    browser WASM bundle. A current release-WASM guard shows realtime integrity
    is no longer the bottleneck: `rust_realtime_apply_total_ms=25`,
    `rust_realtime_integrity_verify_total_ms=6`,
    `rust_realtime_overhead_p50_ms=16.75`, and
    `rust_realtime_http_request_count=0`. Browser worker realtime timer
    globals are now bound before heartbeat/reconnect scheduling, fixing Chrome
    `Illegal invocation` failures in canonical websocket demos while keeping
    runtime-owned reconnect/backoff.

## Next

- No local WP-25 foundation slice remains. Future file-product work should be
  driven by a concrete app surface and stay scoped to
  [`WP-25 File Asset Sync`](work-packages/WP-25-file-asset-sync.md) rather than
  reopening blob protocol behavior.
- Reopen [`WP-14 Developer Experience And Generated APIs`](work-packages/WP-14-developer-experience-generated-apis.md)
  only when WP-26 finds concrete generated-client naming, discoverability,
  conflict, blob, or subscription ergonomics gaps.
- No local [`WP-13 Observability And Debuggability`](work-packages/WP-13-observability-debuggability.md)
  foundation slice remains. Future console/debugging work should be driven by
  concrete app feedback and retain the redacted, server-authoritative
  investigation contract.
- [`WP-32 Realtime Recovery Fanout And External Notification Payloads`](work-packages/WP-32-realtime-recovery-fanout-external-notifications.md)
  remains accepted. Latest high-scale evidence shows the `1000` same-process
  worker harness still has about a `2s` app-visible tail, but the server sends
  binary packs to all clients in `13.40ms`, all clients apply binary packs, and
  no HTTP recovery pulls occur. Treat further `500+` reconnect work as
  worker/event-delivery or benchmark-harness investigation, not a relay/server
  Rust rewrite trigger.
- No local [`WP-33 Unified App Contract And Runtime Extensions`](work-packages/WP-33-unified-app-contract-and-runtime-extensions.md)
  foundation slice remains. Future work should be driven by concrete app
  feedback against the generated app contract, server-handler helpers,
  versioned schema handling, runtime extension boundaries, local-sync-compatible
  clients, or explicit local-only table support.

## Later

- `[x]` [`WP-01 Protocol Integrity`](work-packages/WP-01-protocol-integrity.md)
- `[x]` [`WP-02 Protocol Kernel`](work-packages/WP-02-protocol-kernel.md)
- `[x]` [`WP-05 Adaptive Bootstrap`](work-packages/WP-05-adaptive-bootstrap.md)
- `[x]` [`WP-07 CRDT Fields`](work-packages/WP-07-crdt-fields.md)
  - Generic CRDT compaction now returns before/after diagnostic stats through
    Rust, native JSON, browser WASM, and generated Swift/Kotlin clients. The
    receipt exposes counters and state-vector metadata without embedding the
    full state blob, and encrypted update-log fields include before/after
    stream checkpoint stats. Runtime CRDT tests and browser Hono WASM CRDT
    coverage pass. Native event streams now have bounded timeout reads through
    BoltFFI/generated Swift/Kotlin/Java, and the full native smoke lane passes.
    Encrypted pull integrity is verified on the wire payload before decrypting
    fields, then the verified root is persisted during decrypted local apply.
    Row-change metadata now includes structured `crdtFieldChanges`, native
    remote pulls emit generic `CrdtFieldChanged` events for CRDT-backed field
    changes, and browser/generated TypeScript/Swift/Kotlin/Java surfaces expose
    the same metadata to app bridges. Native Diesel and browser owned-SQLite
    pull builders now attach scope-filtered `crdtStateVectors` hints from
    `sync_crdt_documents`; the server Yjs plugin uses those hints for
    incremental required-base diffs, native/browser recovery emits
    `resyncRequired`, and encrypted update-log CRDTs now carry required-base
    vectors inside ciphertext and recover through app/update/checkpoint
    subscription bootstrap.
- `[x]` [`WP-08 Testkit And Conformance`](work-packages/WP-08-testkit-conformance.md)
  - Rust testkit now exposes `AppTestHttpServer`, a disposable HTTP/WebSocket
    wrapper around the stateful `AppTestServer`. Smoke coverage proves HTTP
    pushes write server state, WebSocket listeners receive sync wakeups, and a
    second client pulls the committed row through the production native HTTP
    transport shape. Stateful HTTP conflict coverage now proves version
    conflicts are reported while the same sync can pull the server-winning row.
    Production `RealtimeTransport::push_commit` is now covered against the same
    reusable HTTP fixture, including websocket push response and subscriber
    wakeup. Stateful HTTP/WebSocket request capture now lets app tests assert
    production auth and schema-version headers, and the fixture can now enforce
    required authorization for HTTP sync and WebSocket connections. App-facing
    assertions now cover server rows, missing rows, commit counts, and captured
    auth headers so app tests do not need to inspect fixture internals.
    `AppTestHttpServer` now also has a request wait helper and shared HTTP
    request count/header assertions for app-shell transport tests. Stateful
    scope coverage now proves bootstrap rows, later commits, and deletes are
    filtered through generated app schema scopes. Stateful encrypted-field coverage now proves
    the server stores ciphertext while a second client pulls decrypted
    plaintext. Stateful blob coverage now exercises queued upload, queue drain,
    local cache clear, remote download, and recache through real client APIs.
    Stateful auth and subscription revocation are now reusable fixture controls:
    tests can change/clear the required auth token during a run, revoke a
    subscription with redacted scopes, verify local scoped-row clearing, restore
    the subscription, and bootstrap again through the real client path.
    The Rust conformance fixture loader now lives in `syncular-testkit`, and
    runtime protocol and blob transport tests consume it instead of private
    copies. The TypeScript conformance loader now lives next to the shared JSON
    fixture with an exported `SyncScenarioFixture` contract, so browser
    generated-app tests and native Hono smoke setup no longer couple through
    browser test internals or local `unknown` casts. The Rust testkit now also
    exposes a typed `SyncScenarioFixture`, and representative stateful auth,
    subscription revocation, E2EE, blob, and field-encryption smokes consume it
    instead of hard-coded values or raw JSON path reads. The Rust perf binary now
    uses the same fixture instead of maintaining its own private server copy.
    `bun run rust:conformance:fast` now runs the repeatable fast gate for the
    shared testkit/runtime/generated-app/browser contract subset, including
    runtime CRDT field coverage for convergence, encrypted fields, compaction,
    and duplicate/reordered delivery; heavier browser-Hono and native lanes are
    available through the same runner.
- `[x]` [`WP-09 Native Bindings And Packaging`](work-packages/WP-09-native-bindings-packaging.md)
  - Swift/Kotlin/JVM generated clients, BoltFFI host wrappers, native event
    streams, command-line lifecycle smokes, Hono server sync smokes, and real
    iOS/Android lifecycle app-shell fixtures exist. Root scripts now expose the
    app-shell lifecycle lanes directly (`rust:native:lifecycle:*`) and the
    conformance runner has an explicit `--native-app-shell` mode so these do
    not stay hidden behind reference docs. The Windows JVM packaging lane now
    passes on a real GitHub `windows-latest` runner, after the packaging script
    learned to write Windows-native BoltFFI overlay paths under Git Bash.
    Latest gates passed:
    `bun run rust:native:lifecycle:ios`, `bun run rust:conformance:native`,
    `bun run rust:native:lifecycle:android`,
    `bun run rust:native:package:java:linux`, and GitHub workflow run
    `26260787975` job `rust-windows-jvm-package`.
- `[x]` [`WP-10 Browser Package And Docs`](work-packages/WP-10-browser-package-docs.md)
  - The release full Rust-owned SQLite WASM size gate is green again after
    retaining the Rust release profile with LTO, one codegen unit, and
    `panic = "abort"`. Current size is `3,363,132` raw bytes / `1,383,031`
    gzip bytes versus the configured `3,460,301` / `1,426,063` budget.
    Local and external artifact guards stayed in band; keep measuring package
    size and performance for every browser/WASM-facing change.
- `[x]` [`WP-11 Server Edge And Offline Auth`](work-packages/WP-11-server-edge-offline-auth.md)
  - Pure Rust server and CF Worker rewrite remain deferred. The offline auth
    lease model is now explicit in
    `reference/OFFLINE_AUTH_LEASE_MODEL.md`: signed bounded leases are for
    offline intent capture and audit only, not server acceptance or a bypass of
    current handler authorization. Rust protocol lease structs/constants and
    deterministic ES256 testkit issue/verify helpers exist, with valid,
    expired, and tampered-token smoke coverage. Runtime schema v8 now persists
    `sync_auth_leases` plus outbox auth-lease provenance, exposed through the
    native Diesel store, browser owned SQLite store, native facade, C FFI, and
    BoltFFI wrapper. HTTP/websocket push replay now carries optional
    `authLease` provenance through Rust/browser/server/Hono without bypassing
    current request auth, and server-side lease rejections use stable
    `sync.auth_lease_*` diagnostics that the Rust client preserves as local
    conflict/recovery state. Hono sync routes now expose a current-auth
    `POST /auth-leases/issue` endpoint backed by shared TS auth-lease schemas,
    WebCrypto ES256 signing helpers, scope resolution through the existing
    handler policy, and route coverage for successful issue, auth-required,
    disallowed scope, malformed scope, and expiry diagnostics. Push replay now
    has a generic post-idempotency commit validator hook and Hono auth-lease
    validation rejects leased commits with missing/expired/invalid signed tokens
    before applying operations while still preserving normal commit audit
    metadata. Rust/native/browser replay now persists and sends the signed
    `leaseToken` from `sync_auth_leases` when an outbox commit is marked with
    lease provenance. Server replay now derives row scopes through the table
    handler, verifies signed lease coverage per operation, and re-resolves
    current handler scopes to reject revoked access before writes. Rust
    generated mutations now expose `leased_mutations()` / `commit_leased()`,
    and native Diesel selects an active covering lease transactionally before
    retaining the local row/outbox write. Native JSON, C FFI, BoltFFI, Swift,
    Kotlin, and Java now expose the same strict immediate/queued leased mutation
    entry points. Browser generated/Kysely APIs now expose the matching
    `leasedMutations` surface, with worker/WASM auth-lease storage APIs and
    fail-closed rollback when no covering active lease exists. Browser hosts
    can now call `client.issueAuthLease(...)`, which posts to
    `/auth-leases/issue`, uses normal auth refresh on `401`/`403`, stores the
    signed lease, and is covered by a real Hono leased mutation replay test.
    Rust/native hosts now have the same first-class issue path through
    `HttpSyncTransport::issue_auth_lease`, `SyncularClient::issue_auth_lease`,
    native JSON, C FFI, BoltFFI, Java, and generated Swift/Kotlin typed
    `issueAuthLease(...)` helpers. Local leased mutations now classify a stored
    covering-but-expired lease as `sync.auth_lease_expired` before materializing
    app rows/outbox writes, and browser `activeAuthLeases(...)` now passes wasm
    `i64` timestamps correctly. No local WP-11 implementation slice remains for
    the current Rust-client foundation; future Rust server or edge-proxy work is
    deferred until there is a concrete product target.
- `[x]` [`WP-13 Observability And Debuggability`](work-packages/WP-13-observability-debuggability.md)
  - First-slice client/server correlation remains complete. Testkit now exposes
    native diagnostic/error-code assertions and uses them in auth-expired plus
    schema-mismatch smokes, so app suites can assert stable diagnostic contracts
    without parsing messages. Runtime/browser/native/support-bundle
    observability is complete enough for the current Rust-client foundation.
    The first console row investigation drilldown is now in place with redacted
    audit history, optional client cursor/scope-key coverage, relevant request
    events, request-event subscription-count evidence, stable finding codes,
    generated OpenAPI types/docs, and a console
    `/investigate/row/:table/:rowId` page. Server request events now persist a
    redacted pull response summary with active/revoked/bootstrap subscription,
    commit, change, and snapshot-page counts, allowing row investigation to
    report explicit revoked-subscription evidence without payload snapshots.
    Row investigation also summarizes persisted request-event success and
    rejection evidence for the selected table, including latest response
    status/error code and success/non-success counts. Pull request-event
    summaries now include redacted snapshot transport counts, and row
    investigation surfaces inline/chunk/artifact bootstrap evidence without
    storing row payloads. Console-enabled servers now persist redacted realtime
    websocket lifecycle/recovery events, and row investigation surfaces
    connected, ACK, pull-required, rejected, and error counts for the selected
    client. Console event pruning covers the realtime event table as well.
    WP-13 is accepted for the current foundation; future drilldowns should be
    triggered by concrete app/debugging feedback rather than speculative
    diagnostics.
- `[x]` [`WP-14 Developer Experience And Generated APIs`](work-packages/WP-14-developer-experience-generated-apis.md)
- `[x]` [`WP-15 Error Taxonomy And Recovery Semantics`](work-packages/WP-15-error-taxonomy-recovery-semantics.md)
  - Browser worker error payloads now carry stable public error `code`,
    `category`, `retryable`, and `recommendedAction` fields. The first mapped
    recovery-critical cases are auth-required, schema mismatch, and integrity
    rejection, and worker diagnostics use the same stable codes when
    classified. The browser package now shares the same classifier with the
    direct Rust client sync path through `SyncularClientError`. Core now owns
    the public error response taxonomy, and Hono sync/blob/rate-limit/auth
    routes emit stable JSON error envelopes that the browser classifier can
    consume from Rust transport failures. The native runtime now uses a shared
    Rust classifier for server envelopes, auth/forbidden transport failures,
    schema mismatches, integrity rejection, storage failures, and runtime
    failures; native error JSON and diagnostics carry the same
    `code/category/retryable/recommendedAction` shape. HTTP 403 is treated as
    `sync.forbidden`, not auth expiry. Generated Swift/Kotlin native app
    clients and the Java event parser now expose the native error object as a
    typed `event.error` shape. Console gateway routes now return stable
    `console.*` envelopes for auth, forbidden origin, invalid selection,
    not-found, downstream unavailable, and invalid downstream response cases.
    Hono request validation now uses Syncular-owned validators so sync, blob,
    and console validation failures return stable envelopes before route
    handlers run. Relay server-role `/pull` and `/push` routes now return the
    same stable sync envelopes for auth, invalid request, and operation-limit
    failures instead of uppercase string-only errors. Server-Hono proxy
    websocket pre-upgrade failures now return stable `proxy.*` envelopes for
    forbidden origin, missing auth, and connection-limit rejection. Direct
    console routes now use the shared error-envelope schema and stable
    `console.*` / `blob.*` codes for schema-unavailable, auth, not-found,
    invalid-request, and blob-storage configuration failures. Cloudflare
    scope-cache Durable Object and server-service-worker default handler
    failures now return stable envelope JSON instead of plaintext adapter
    errors. Public per-operation push result codes now use the stable taxonomy
    across the TS server, encrypted CRDT handler, testkit fixtures, Rust
    runtime/testkit expectations, browser worker tests, demo handlers, docs, and
    shared conformance fixtures instead of legacy uppercase strings. Browser
    worker public errors now use `worker.*` taxonomy codes with structured
    category/retry/recovery metadata instead of underscore/local codes, and the
    Rust runtime classifier recognizes the expanded shared taxonomy. Core now
    generates a checked-in error taxonomy fixture, with TS and Rust tests
    guarding against drift between `SYNCULAR_ERROR_DEFINITIONS` and the Rust
    classifier. Blob upload completion now carries stable manager-level error
    codes through to Hono routes, so forbidden completion no longer depends on a
    brittle message sentinel. Scope revocation and offline transport failures
    now have stable taxonomy entries, and browser worker/direct sync diagnostics
    emit `sync.scope_revoked` with revoked subscription ids when a pull clears
    local scoped data. Console websocket auth/no-instance errors and console
    route `onError` now emit stable `console.*` envelopes, demo app validation
    examples use readable messages with stable Syncular codes, and blob upload
    body validation uses stable `blob.*` tags internally. WP-15 is accepted for
    current Rust-first public surfaces; remaining uppercase strings are
    downstream/test fixtures or old JS-client cleanup debt already tracked in
    the compatibility register.
- `[x]` [`WP-16 Schema Evolution And Migration Safety`](work-packages/WP-16-schema-evolution-migration-safety.md)
  - First retained testkit slice lets `AppTestServer` / `AppTestHttpServer`
    simulate `requiredSchemaVersion` and `latestSchemaVersion`. The rolling
    deploy smoke proves a client can bootstrap existing rows, then reject a
    future required server schema with `sync.schema_mismatch` while leaving the
    local synced replica unchanged. Native fixture coverage now proves the same
    classification and fail-closed behavior through public native events.
    Browser Hono/WASM coverage now proves the public worker error/diagnostic
    surface rejects future required schemas without mutating worker-owned
    SQLite. Native Diesel now persists app schema state, rejects future local
    schema versions, and exposes the state through the native facade, C FFI,
    and Swift/Kotlin/Java BoltFFI wrappers. Generated app migrations are now
    app-owned only across Rust, Swift, Kotlin, and TypeScript outputs; stores
    install Syncular runtime system tables themselves, and browser generated
    clients can replay older local app schema versions before validating and
    stamping the current version.
- `[x]` [`WP-17 Offline Lifecycle And App State Integration`](work-packages/WP-17-offline-lifecycle-app-state.md)
  - Browser worker clients now expose `lifecycleState()` and
    `lifecycleChanged` with stable phases for offline, connecting, syncing,
    recovering, auth-required, degraded, complete, and closed UI states. The
    first worker-client test covers connecting, resync-required recovery,
    auth-required action, and final complete transitions. Browser/Hono
    integration now covers offline generated mutations, pending outbox
    lifecycle state, retry backoff, reconnect push recovery, and final
    complete state. Native runtime events now carry typed lifecycle snapshots
    through Rust and generated Swift/Kotlin event models. Browser and native
    runtimes now expose explicit background-resume hooks: browser
    `resumeFromBackground()` restarts remembered realtime and syncs through the
    lifecycle stream, while native `resume_from_background` resumes the worker,
    restarts realtime, and enqueues a command-correlated sync through C FFI and
    generated Swift/Kotlin/Java BoltFFI wrappers. Hono/browser tests now cover
    foreground resume auth refresh and lifecycle-visible scope revocation, and
    native Swift/Kotlin/iOS/Android lifecycle smokes use `resumeFromBackground`
    as the app-shell foreground recovery API. Browser lifecycle now carries
    `blobUploads` and emits `blobUploadsChanged`; native worker events emit
    `BlobUploadsChanged` with matching lifecycle payloads, and generated
    Swift/Kotlin event models decode them. The policy decision is that
    foreground resume owns sync/realtime recovery, while blob uploads, blob
    cache maintenance, and storage compaction remain explicit queued work driven
    by host battery/network/background-budget policy. Native low-level bindings
    now expose queued blob upload processing, and Swift/Kotlin/iOS/Android
    lifecycle smokes model restricted background policy versus foreground
    maintenance policy. Accepted after full native facade/FFI/binding gates and
    `bun run rust:conformance:native`.
- `[x]` [`WP-18 Production Hardening And Limits`](work-packages/WP-18-production-hardening-limits.md)
  - Started with a limit inventory and the first explicit native/Rust runtime
    limit surface. Worker queue/event capacities, native recent-event limits,
    read statement cache capacity, pull request sizing, outbox push batch
    sizing, CRDT queue/log defaults, and Yjs coalescing are now centralized and
    exposed in native runtime manifests plus diagnostic snapshots.
    Rust/native/browser subscription setters now enforce bounded subscription
    counts, scope keys, scope values, and params with stable
    `runtime.limit_exceeded` errors. Mutation entry points now reject oversized
    low-level operation JSON, local-row JSON, batch JSON, typed mutation
    batches, and serialized outbox operation JSON with the same error family.
    Blob and CRDT/Yjs entry points now reject oversized payloads through the
    same stable limit errors, and native diagnostic snapshots redact oversized
    recent-event payloads instead of retaining full app data. Snapshot
    chunk/artifact transports now validate declared, compressed, and
    decompressed payload sizes, while native websocket text frames and browser
    realtime sync-pack bytes have explicit runtime limits. The shared TS/Rust
    error taxonomy now includes `runtime.limit_exceeded`, and Hono sync routes
    bound combined request JSON, JSON/binary sync responses, snapshot chunk
    downloads, and scoped snapshot artifact downloads with that same stable
    envelope. Retry/blob queue constants for sync retries, stale send/upload
    timeouts, blob retry counts, blob batch processing, and SQLite busy timeout
    are also visible in native manifests and diagnostics. Console request
    events now expose request/response limit pressure, including a dedicated
    `sync` event type for pre-parse combined failures; oversized pull responses
    no longer record cursor/subscription/success side effects. Native
    Diesel, browser-owned SQLite, and web-memory local writes now reject new
    commits once pending/sending/failed outbox pressure reaches
    `maxUnresolvedOutboxCommits`; acked commits do not count against the cap.
    Console stats now expose partition-aware snapshot chunk/artifact cache
    pressure counters, and the command dashboard surfaces total/expired
    snapshot cache pressure as KPIs. Accepted after native, browser-owned
    SQLite, server, console, transport type, and documentation gates.
- `[x]` [`WP-19 Security And Privacy Review`](work-packages/WP-19-security-privacy-review.md)
  - Threat model is drafted. The first cross-surface Hono auth-boundary test now
    proves one unauthorized actor/scope mismatch is denied across pull, scoped
    snapshot artifact download, and realtime wakeups. Next security slices
    should extend that shape to encrypted CRDT fields/updates, console
    partition/detail access, and diagnostic/debug-bundle redaction. Blob route
    coverage now also proves forbidden actors cannot mint signed download URLs
    for existing completed blobs. Encrypted CRDT coverage now proves pending
    server-bound outbox operations carry ciphertext without plaintext text or
    raw Yjs update/state fields. Native diagnostic snapshot coverage now also
    proves host auth headers are not serialized. Default scoped server writes
    now enforce `resolveScopes(ctx)` in the built-in handler, with tests proving
    forbidden inserts/updates/deletes do not mutate app rows, emit changes, add
    routing indexes, or leak forbidden row contents; write scope resolution
    failures now fail closed as forbidden pushes. Encrypted CRDT system
    updates/checkpoints now share the same scope authorization helper and reject
    forbidden append pushes without persisting system rows or emitted changes.
    Opt-in console request payload snapshots now redact common token, password,
    and secret fields before persistence. Native Diesel storage coverage now
    proves revoked scopes clear matching encrypted CRDT update/checkpoint rows
    while preserving other scopes.
- `[x]` [`WP-20 Local Data Hygiene And Repair`](work-packages/WP-20-local-data-hygiene-repair.md)
  - First retained slice adds a stable Rust `LocalHealthReport` /
    `LocalHealthFinding` schema plus `local_health_check_json()` on the Rust
    client and native Swift/Kotlin/Java BoltFFI surface. The initial check is
    read-only and reports configured subscription-state JSON/cursor hazards and
    malformed verified roots with explicit `forceRebootstrap` repair actions
    while avoiding raw scope/root value leakage. Runtime coverage proves a
    corrupted persisted verified root is reported without mutating an existing
    local app row. Native stores now also enumerate persisted subscription
    states and verified roots, so health checks report orphaned subscription
    state/root metadata with explicit `clearOrphanedState` repair actions
    without clearing data implicitly. Health checks now also report app-schema
    state mismatches, outbox commits written by newer generated clients, failed
    outbox commits, and unresolved conflicts without attempting unsafe automatic
    repair. Blob/CRDT findings now cover invalid blob refs, failed blob
    uploads, and CRDT document metadata pointing at missing app rows without
    pruning or rewriting metadata. Safe repair commands now cover
    `clearOrphanedState` and explicit `forceRebootstrap`; manual-inspection
    hazards remain non-repairable. Runtime coverage proves those repairs do not
    mutate app rows and produce a clean follow-up health report. Browser-owned
    SQLite now exposes the same `localHealthCheck()` / `repairLocalHealth()`
    contract through the Rust WASM client and worker API, including raw metadata
    enumeration, app-schema/outbox/conflict/blob/CRDT summaries, and a WASM
    regression test for corrupt configured roots plus orphaned local state. The
    shared clock helper is platform-aware so browser health reports do not hit
    unsupported native time APIs. Explicit reset/rebootstrap APIs now clear
    selected configured subscription sync metadata/verified roots and can
    optionally clear only synced generated app rows with positive
    server-version values. Reset rejects unknown subscriptions, preserves
    local-only rows, fails closed while unresolved outbox commits exist, updates
    browser live-query/lifecycle state after row clearing, and is exposed across
    Rust, browser worker, and native Swift/Kotlin/Java BoltFFI surfaces. Local
    health now also reports orphaned synced app rows: positive-server-version
    rows outside every configured subscription scope are counted and surfaced as
    `local.synced_rows_orphaned` without mutating data. Scope matching is
    metadata-driven across Diesel, the rusqlite fixture, WebMemoryStore, and
    Rust-owned browser SQLite, including array scopes and fail-closed invalid
    scope keys. The explicit `clearOrphanedSyncedRows` repair now refuses
    `subscriptionIds`, accepts optional generated app `tables`, fails closed
    with unresolved local outbox commits, deletes only positive-server-version
    rows outside configured scopes, preserves local-only rows, and notifies
    browser live-query/lifecycle listeners after row-clearing repairs. Redacted
    local support bundles now export/import through Rust/native/browser
    surfaces for support inspection without raw scopes, params, roots, row
    data, auth material, or CRDT payloads; imports validate and summarize only,
    and refuse unredacted bundles. Blob and CRDT metadata hazards intentionally
    remain `manualInspection`: automatic cleanup would risk rewriting app data
    or deleting pending local CRDT/blob work. Existing explicit compaction
    remains the policy surface for aged failed blob uploads and acknowledged
    CRDT logs.
- `[x]` [`WP-21 Query Observation And Live Query Precision`](work-packages/WP-21-query-observation-live-query-precision.md)
  - First retained slice adds a browser/Hono regression proving Kysely live
    queries can infer generated app-table dependencies and refresh from
    row-level sync apply metadata without the app passing broad table-only
    dependencies. Browser live-query registration now also carries optional
    row-id dependency hints for simple primary-key equality predicates, and the
    Rust-owned browser SQLite invalidator uses those hints only when
    changed-row metadata is complete. Native observed queries now accept the
    same row/field dependency-hint shape and suppress `QueriesChanged` only
    when complete changed-row metadata proves the query cannot be affected. A
    Hono/WASM regression plus live-query diagnostics counters now prove hinted
    primary-key queries skip actual reruns for unrelated row churn, with the
    browser realtime guardrail still neutral. Scope-revocation coverage now
    proves table-only scoped clearing reruns hinted live queries and emits the
    empty result. CRDT materialization coverage now proves a hinted query reruns
    for a matching CRDT field write and carries CRDT field metadata. Blob
    metadata coverage now proves a synced BlobRef column update refreshes a
    hinted query with `changedFields` containing `image`. Conflict coverage now
    proves conflict metadata creation/resolution does not spuriously rerun
    app-row live queries when the app row itself is unchanged. Accepted. Richer
    automatic field-level inference from query-builder ASTs remains a deferred
    ergonomics/performance follow-up; runtime behavior is conservative without
    it.
- `[x]` [`WP-22 Undo/Redo Mutation History`](work-packages/WP-22-undo-redo-mutation-history.md)
  - Browser TypeScript generated clients now expose `database.commandHistory`
    and wrap generated regular/leased mutations with command-history capture.
    Command groups persist before/after row snapshots in local SQLite and
    undo/redo replays snapshots through the normal mutation/outbox path. The
    generated-client proof covers update, insert, hard delete, soft delete, and
    grouped multi-row commits; verifies three ordinary mutation intents for
    `update -> undo -> redo`; and verifies stale-row undo fails with
    `sync.command_history_conflict`. Blob, encrypted, and CRDT-backed field
    changes now fail replay with `sync.command_history_unsafe_field` until safe
    inverse semantics are designed. Native/Rust now has the shared runtime
    `sync_command_history` table, Diesel storage methods, a
    `SyncularCommandHistoryExecutor` trait, generated `commit_with_history` /
    `commit_leased_with_history`, and generated `command_history().undo_last()`
    / `redo_last()` helpers. Example-app tests prove Rust undo/redo emits
    normal outbox commits, stale undo fails before writing a replay commit,
    grouped insert undo/redo works, hard-delete replay works, and soft-delete
    replay restores/toggles the generated soft-delete column. Rust also proves
    undo-generated commits persist server conflicts through the normal sync
    path, and unsafe blob/encrypted/CRDT-backed field replay is rejected before
    a compensating commit is written. Native Diesel tracked commits now record
    the command history row inside the same SQLite transaction as the local
    mutation/outbox write. Leased undo now fails closed after auth lease
    revocation without changing the row, without writing a replay commit, and
    while keeping the command undoable. Swift/Kotlin command-history wrappers
    are deferred until those generated mutation APIs are mature enough to avoid
    baking a second app-facing shape.
- `[x]` [`WP-23 Time Travel And Audit Inspection`](work-packages/WP-23-time-travel-audit-inspection.md)
  - First server API slice is in place. `GET /audit/rows/:table/:rowId` uses
    dialect-level scoped row-history reads, supports commit-range pagination,
    returns redacted field/scope summaries instead of raw payloads, and fails
    unauthorized scope reads as `sync.not_found` without leaking hidden content.
    SQLite and Postgres dialects implement the new reader. Console now exposes a
    redacted partition-scoped row-history endpoint that links entries to request
    event ids, request ids, and trace ids for timeline navigation. Next: richer
    commit-diff categories. Row-history responses now carry shared redaction
    metadata for app rows, deletes, blob refs, encrypted field envelopes, and
    encrypted CRDT update/checkpoint evidence. Sync audit commit detail is now
    scoped to the authenticated actor's visible row scopes and returns redacted
    summaries rather than raw row payloads; console commit detail uses the same
    redaction classifier. Testkit now exports audit redaction/leak assertions
    and redacted-debug-export assertions for app-side tests.
    `GET /audit/debug/export` now exposes a size-bounded authenticated-actor
    support bundle containing only visible redacted commit changes and the
    actor's own request-event diagnostics when available. OpenAPI/transport
    types and the console Stream view now use the redacted change summary
    shape.
- `[x]` [`WP-24 Blob Hardening And Production Polish`](work-packages/WP-24-blob-hardening-production-polish.md)
  - Accepted for the Rust-first foundation. `@syncular/server` now
    exports `createScopedBlobAccessChecker(...)`, an opt-in `canAccessBlob`
    helper that grants blob download access only when the hash is referenced by
    a configured blob column on a row visible through the table handler's
    current scope policy. The helper emits stable allow/deny/missing-reference
    decisions for diagnostics, and Hono blob route tests prove the helper
    authorizes visible row references while denying the same hash across actor
    scopes. Rust native and Rust-owned browser SQLite now support encrypted
    blob bodies: blob refs are content-addressed by ciphertext, cache/outbox
    and server bodies carry ciphertext, upload queues preserve `encrypted` and
    `keyId`, and host retrieval decrypts only after ciphertext hash/size
    validation. The browser and native APIs expose `setBlobEncryption` /
    `set_blob_encryption_json`, with native and Hono/WASM tests proving
    encrypted upload/download roundtrips. Browser upload completion events now
    preserve encrypted `BlobRef` metadata when reconstructed from the Rust-owned
    SQLite outbox, including failure events. Browser package blob calls now
    enforce explicit `blobLimits.maxPayloadBytes` before high-level
    `Blob`/`File` conversion, worker posting, or direct WASM calls, and emit
    `blob.too_large` diagnostics with safe size/ref metadata. Browser worker
    and direct WASM clients now also emit blob cache hit/miss, cache prune/clear,
    upload queue, per-row upload completion/failure, and download failure
    diagnostics when diagnostics are subscribed. Native facade direct and queued
    blob file/cache operations now emit the same stable blob diagnostic codes
    through the native event stream. Native HTTP blob transport now has
    corrupted-download conformance coverage proving invalid bodies are rejected
    and not cached. Hono blob routes now have explicit `blob.too_large`
    coverage for upload initiation and direct upload `Content-Length`
    enforcement.
- `[x]` [`WP-25 File Asset Sync`](work-packages/WP-25-file-asset-sync.md)
  - First retained slice adds `syncular-testkit::file_assets`, a reference
    scoped file metadata schema with `files` and `file_versions` tables,
    `file_versions.blob_ref` as the only blob column, mutation builders for
    file/folder/version lifecycle basics, and a two-client stateful scenario
    proving metadata sync, blob retrieval through the referenced `BlobRef`, and
    revocation clearing. Hono blob routes now also prove the same row-backed
    file-version authorization shape: hash knowledge stays forbidden until a
    visible `file_versions.blob_ref` row exists, and cross-actor access remains
    denied. Browser/WASM coverage now proves a reference `file_versions`
    app-schema row syncs a typed `BlobRef` through Hono and clears locally on
    subscription revocation. Testkit file asset conformance now also covers
    rename, move, trash, restore, delete-vs-update, version conflict
    persistence, concurrent version edits, missing blob bodies, and corrupted
    blob integrity failures. Native file-path blob conformance now proves the
    reference metadata shape works for platform-native large-file flows without
    putting bytes in app rows. Decision: keep the file asset schema as a
    testkit/reference app schema, not a framework codegen template, until a
    real app proves reusable file-product semantics beyond normal migrations
    and `generated/syncular.codegen.json`.
- `[x]` [`WP-26 TypeScript Host Bindings And Platform Bridges`](work-packages/WP-26-typescript-host-bindings-platform-bridges.md)
  - Accepted for the current Rust-first foundation. Feature WPs now carry
    explicit TypeScript/platform `Interface Impact` sections. Browser, React,
    Tauri, React Native, Expo, and testkit host surfaces expose leased
    mutations, auth leases, lifecycle resume, row/field event metadata, and
    diagnostic snapshots without reviving a JavaScript sync client.
- `[x]` [`WP-33 Unified App Contract And Runtime Extensions`](work-packages/WP-33-unified-app-contract-and-runtime-extensions.md)
  - Accepted for the current Rust-first foundation. The typed app contract now
    drives the generated handoff, Rust codegen consumes the checked
    `generated/syncular.codegen.json` artifact, generated server/client app
    references share the same app-table shape, divergent server/client handler
    examples are tested, versioned client-schema projection is available for
    old clients, runtime storage/wire extensions validate against generated
    metadata, local-sync-compatible clients work without a server, and
    `localOnlyTables` lets app migrations carry explicit non-synced local
    tables without generating outbox/sync metadata for them. Follow-up doc
    hygiene aligned older WP references with the current
    `generated/syncular.codegen.json` handoff so docs no longer imply app
    authors should maintain a root low-level codegen file.

## Planned Server / Relay Rust Work

- `[x]` [`WP-27 Rust Relay Protocol Boundary`](work-packages/WP-27-rust-relay-protocol-boundary.md)
  - `syncular-protocol` now has storage-free relay/proxy validation helpers and
    cross-language fixtures for combined sync, binary sync packs, snapshot
    chunks/artifacts, blob refs, auth lease provenance, realtime JSON messages,
    and binary realtime frames. TypeScript schema/codec tests and Rust protocol
    tests validate the same fixtures without changing relay runtime behavior.
- `[x]` [`WP-28 Relay Rust Evaluation And Protocol Validation`](work-packages/WP-28-relay-production-protocol-validation.md)
  - Retained evaluation now has both a repeatable protocol-boundary baseline
    over the WP-27 fixture and an in-memory relay app-path baseline. Current
    local p95s: combined response parse+schema `16.42us`, binary sync-pack
    decode+schema `22.58us`, schema-backed fixture validation `47.46us`, local
    relay push `701.46us`, forward once `108.63us`, main pull/apply `379.96us`,
    local incremental pull `305.67us`, and realtime wakeup to 100 mock
    connections `33.92us`. Final decision: keep Rust protocol checks in
    fixtures/dev tooling only. No Rust relay production path or follow-up Rust
    relay/server component WP is retained from this evidence; relay app
    semantics stay TypeScript/Kysely-owned unless a future product decision and
    new measurements say otherwise.
- `[x]` [`WP-32 Realtime Recovery Fanout And External Notification Payloads`](work-packages/WP-32-realtime-recovery-fanout-external-notifications.md)
  - Created from WP-31 reconnect-storm evidence, not from WP-28 protocol
    validation. Slice 1 retained TypeScript/Hono binary sync-pack construction
    for known external row-change commits and capped reconnect jitter at the
    configured maximum. Same-machine reconnect runs now apply binary external
    packs at `25/25` and `125/125`, dropping those lanes to `39.91ms` and
    `89.14ms` convergence with one reconnect pull per client; online propagation
    stays on `15/15` binary applies with p95 `12.28ms`. The `250`-client lane
    originally still showed an approximately `2s` tail, but slice 2 persisted
    realtime subscription/root state in `sync_client_cursors`, hydrated that
    state on websocket reconnect, gated reconnect catch-up on
    `hello.requiresSync`, and fixed the benchmark observer so row-change
    visibility is not measured through 250 queued worker SQL readbacks.
    Corrected final evidence applies binary packs at every scale with zero HTTP
    reconnect pulls: run `2026-05-22T16-25-35-103Z` reports `25` clients
    `34.17ms`, `125` clients `67.69ms`, and `250` clients `360.30ms`
    convergence, while a single `250` rerun `2026-05-22T16-23-57-672Z` reports
    `158.18ms`. Online propagation guard `2026-05-22T16-28-24-669Z` stays on
    `15/15` binary applies with p95 `16.97ms`. Rust remains out of the server
    app path; the measured work was subscription recovery and benchmark
    observation, not protocol encode/validate.

## Blocked / External

- Full iOS/macOS/Android lifecycle validation needs real app-shell coverage
  beyond command-line smokes.
- CI jobs are intentionally skipped until GitHub-side work is requested.

## Reference

Detailed background remains in [`reference/`](reference/). If a reference doc
changes the implementation order, update this roadmap and the affected work
package in the same commit.
