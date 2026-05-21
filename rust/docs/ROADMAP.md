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
    before-bootstrap derived-schema install probe was rejected because it
    regressed 500k bootstrap (`1396.01ms -> 1827.83ms`), local apply
    (`208ms -> 1525ms`), and peak memory (`695.97MB -> 761.14MB`). Keep
    bulk-load-then-derived-rebuild as the app harness shape. Generated
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
    (`2.19MB -> 7.62MB`).
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
    package, with the ergonomic `createSyncularReact()` entrypoint at
    `@syncular/client/react` and CRDT adapters at
    `@syncular/client-crdt-adapters`. Docs and package metadata now point at the
    Rust-first client path.
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
    `syncular.codegen.json`. The generator now emits the read-model contract in
    `syncular.schema.json`, Rust SQL constants, and TypeScript schema
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

- Continue the larger bootstrap/performance architecture in
  [`WP-12 Scoped Snapshot Artifacts`](work-packages/WP-12-scoped-snapshot-artifacts.md):
  artifact apply is now fast enough that the remaining useful work is a larger
  bootstrap state model, not more local derived-schema/install micro-probes.
- Reopen [`WP-14 Developer Experience And Generated APIs`](work-packages/WP-14-developer-experience-generated-apis.md)
  only when real integration feedback exposes remaining app-flow doc gaps or
  naming friction.

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
- `[~]` [`WP-08 Testkit And Conformance`](work-packages/WP-08-testkit-conformance.md)
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
    The Rust conformance fixture loader now lives in `syncular-testkit`, and
    runtime protocol and blob transport tests consume it instead of private
    copies. The TypeScript conformance loader now lives next to the shared JSON
    fixture with an exported `SyncScenarioFixture` contract, so browser
    generated-app tests and native Hono smoke setup no longer couple through
    browser test internals or local `unknown` casts. The Rust perf binary now uses
    the same fixture instead of maintaining its own private server copy.
    `bun run rust:conformance:fast` now runs the repeatable fast gate for the
    shared testkit/runtime/generated-app/browser contract subset, including
    runtime CRDT field coverage for convergence, encrypted fields, compaction,
    and duplicate/reordered delivery; heavier browser-Hono and native lanes are
    available through the same runner.
- `[ ]` [`WP-09 Native Bindings And Packaging`](work-packages/WP-09-native-bindings-packaging.md)
- `[x]` [`WP-10 Browser Package And Docs`](work-packages/WP-10-browser-package-docs.md)
  - The release full Rust-owned SQLite WASM size gate is green again after
    retaining the Rust release profile with LTO, one codegen unit, and
    `panic = "abort"`. Current size is `3,363,132` raw bytes / `1,383,031`
    gzip bytes versus the configured `3,460,301` / `1,426,063` budget.
    Local and external artifact guards stayed in band; keep measuring package
    size and performance for every browser/WASM-facing change.
- `[ ]` [`WP-11 Server Edge And Offline Auth`](work-packages/WP-11-server-edge-offline-auth.md)
- `[~]` [`WP-13 Observability And Debuggability`](work-packages/WP-13-observability-debuggability.md)
- `[x]` [`WP-14 Developer Experience And Generated APIs`](work-packages/WP-14-developer-experience-generated-apis.md)
- `[x]` [`WP-15 Error Taxonomy And Recovery Semantics`](work-packages/WP-15-error-taxonomy-recovery-semantics.md)
  - Browser worker error payloads now carry stable public error `code`,
    `category`, `retryable`, and `recommendedAction` fields. The first mapped
    recovery-critical cases are auth-required, schema mismatch, and integrity
    rejection, and worker diagnostics use the same stable codes when
    classified. The browser package now shares the same classifier with the
    direct Rust client sync path through `SyncularV2ClientError`. Core now owns
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
- `[ ]` [`WP-22 Undo/Redo Mutation History`](work-packages/WP-22-undo-redo-mutation-history.md)
- `[ ]` [`WP-23 Time Travel And Audit Inspection`](work-packages/WP-23-time-travel-audit-inspection.md)
- `[ ]` [`WP-24 Blob Hardening And Production Polish`](work-packages/WP-24-blob-hardening-production-polish.md)
- `[ ]` [`WP-25 File Asset Sync`](work-packages/WP-25-file-asset-sync.md)

## Blocked / External

- Windows native/JVM packaging needs a real Windows host or runner.
- Full iOS/macOS/Android lifecycle validation needs real app-shell coverage
  beyond command-line smokes.
- CI jobs are intentionally skipped until GitHub-side work is requested.

## Reference

Detailed background remains in [`reference/`](reference/). If a reference doc
changes the implementation order, update this roadmap and the affected work
package in the same commit.
