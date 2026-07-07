# v2 ROADMAP — after feature-done

Successor to REVISE.md (the v1→v2 rebuild plan, completed 2026-07-03) and
TODO.md (the road to feature-done, completed the same day — every buildable
item landed; see git history for the landing notes). The v2 skeleton plus
the full parity ladder is built, conformance-locked across both cores, and
benchmarked. This file plans what comes NEXT.

Standing rules, unchanged: spec-first (behavior lands in SPEC.md with
vectors or conformance scenarios before/with code), judgment calls get
codified back into the spec, no fallback paths (one good path per concern,
support floors not degradation ladders), and every landing keeps `bun run
check`, `bench:ci`, cargo, and the Rust conformance pairing green. Vendor
bytes don't gate size; syncular's own JS does (66 KB raw ceiling, re-derive
on legitimate growth).

## 1. Native bindings block (the one real parity gap)

The Rust core, the C-ABI FFI (`syncular-ffi`), and the shared command
router (`syncular-command`, conformance-locked via the shim) all exist.
This block is assembly on a proven core — packages, not protocol.

- [x] **Tauri** (decided 2026-07-03; landed 2026-07-04 —
      `tauri-plugin-syncular` in bindings/tauri/plugin, its own cargo
      workspace, plus `@syncular/tauri` in packages/tauri; see
      bindings/tauri/README.md): native syncular instance + React
      bridge — NOT JS syncular in the webview (webview OPFS is
      eviction-prone and inconsistent across WKWebView/webkitgtk; the Rust
      core gives a real file DB and native perf). Shape:
      `tauri-plugin-syncular` (Rust, consumes the client crate DIRECTLY —
      no FFI — exposing the `syncular-command` router as Tauri commands +
      invalidate/presence/sync-needed/conflict over Tauri events) plus
      `@syncular/tauri` (JS bridge implementing the same
      `SyncClientLike` interface the react package already normalizes —
      hooks work unchanged, the fourth host of one interface after direct/
      worker/follower). Example upgraded to React (2026-07-04 —
      `example/src/frontend` is now a `@syncular/react` hooks todo list over
      `createTauriSyncClient`, bundled with a dependency-light `Bun.build`; the
      only Tauri-specific line is the client construction). Caveat to document:
      every useSyncQuery run is one IPC round trip — fine at Tauri IPC latency;
      pagination guidance for huge result sets is a docs note.
- [x] **Swift + Kotlin wrappers** (landed 2026-07-04 — `bindings/swift`
      (SwiftPM `SyncularClient`) and `bindings/kotlin` (Kotlin/JVM
      `SyncularClient` via **FFM**, `java.lang.foreign`, JDK 21+ — zero JNI C
      glue; JDK 21+ (FFM) is the one supported path — the JNA fallback note was dropped 2026-07-05 per the no-fallbacks doctrine)): idiomatic thin wrappers
      over the FFI command surface — `command` + typed conveniences
      (mutate/subscribe/sync/query/readRows/presence/…) + a background
      `poll_event` loop delivering events (Swift → main-queue closure/delegate,
      Kotlin → listener). Lifecycle owned in the wrappers: `pause()`/`resume()`
      (stop-poll + disconnectRealtime / reconnect + restart) and a
      close-joins-the-poll-thread guarantee. Packaging: local dev via linker
      paths to the built dylib; release via `Syncular.xcframework` (Xcode) /
      AAR+jniLibs via cargo-ndk — all detected+skipped by build-native.sh.
      Each gets its own isolated `check.sh` running an OFFLINE HERMETIC smoke
      (no server: mutate → readRows shows the optimistic row; `sync()` reports
      `transport.unavailable` on the lean core). Swift runs green on this mac
      (10/10, Swift Testing on CLT); Kotlin compiles+tests in CI on Ubuntu
      (JDK 21) — its check.sh detect-and-skips a JDK-less mac. Reused v1's
      packaging KNOWLEDGE only, never its code. Todo demos added
      (`bindings/{swift,kotlin}/example`): a Swift SwiftUI-window + terminal app
      (window presents on CLT-only, no Xcode) and a Kotlin terminal app, each
      driving the wrapper end-to-end against the quickstart server — proven by a
      real native-transport sync with an independent client reading the row back
      (Swift verified locally, Kotlin via a CI example smoke).
- [x] **React Native** (landed 2026-07-04 — `@syncular/react-native` under
      `bindings/react-native`): a TurboModule over the FFI, surfacing the SAME
      `SyncClientLike` JS interface so `@syncular/react` works unchanged in
      RN (RN uses the NATIVE core — Hermes has no OPFS/sqlite-wasm). Ships the
      package correctly structured: `createNativeSyncClient()` (SyncClientLike
      over a NativeModule, `{$bytes:hex}` + command JSON, mirroring the Tauri
      bridge), the codegen-ready `.ts` TurboModule spec, iOS (ObjC++ shim over
      the C ABI + RCTEventEmitter) + Android (Kotlin FFM shim, zero JNI C glue +
      DeviceEventManager) native sources, and podspec/build.gradle. Honest
      scoping: verified via JS-bridge tests with an injected NativeModule double
      (11/11 bun: SyncClientLike parity vs `normalizeClient`, bytes, events,
      lifecycle) + `tsc`; the native shims' manual verification recipe is
      documented. A bare-RN **example todo app** (`bindings/react-native/example`)
      now lands the hooks over the native client — its real `App.tsx` is rendered
      headless against a NativeModule double (2 more bun tests, 13/13 total) as
      the hooks↔module integration proof, with the device build a documented
      one-time overlay + an Android CI lane sketched as a follow-up.
      NitroModules/JSI: measure-first only (re-scoped 2026-07-05 — no
      evidence the TurboModule JSON path is slow; revisit only if an RN app
      profiles a real bottleneck). The C ABI is the stable substrate.
- [x] **Native transport §8.7 completion** (landed 2026-07-04): the
      native-transport feature now runs rounds **over the socket** in the
      one-loop shape (§8.7), not `POST /sync`. Request goes out `0x01`-tagged;
      the reader thread demuxes by channel tag, reassembling the `0x01`
      response stream to `END` via a new Rust `MessageStreamScanner`
      (`ssp2`, mirroring the TS reference with the exhaustive split-point
      tests) while queuing `0x00` deltas to the inbound lane. One round in
      flight enforced client-side; mid-round drop fails the round; no socket
      → `POST /sync` (the not-connected rule, not a fallback pair). The
      transport-agnostic tag demux + reassembly is `syncular_client::
      RealtimeRound`, shared by the FFI and Tauri native transports (which
      stay byte-for-byte parallel). Proven by the FFI `round_tests` — a
      scripted in-test `tungstenite` server speaking §8.7 bytes built with
      the `ssp2` codec (round-trip, byte-chunked reassembly, delta-during-
      round queuing, mid-round-drop). Also fixed a latent WS handshake bug in
      both native `realtime_connect`s (hand-built request omitted the
      mandatory upgrade headers). The env-gated native-transport *conformance
      lane* was assessed and **declined** as contortions: the native
      transport is encapsulated in the ffi crate (not the shim's deps), and
      the harness's whole design inverts transport to the host — a native
      lane needs a second driver mode + a real per-instance bun server, not a
      small flag. The scripted Rust-local tests prove the §8.7 loop against
      real WebSocket traffic directly instead.
- [x] **Flutter + Dart binding + todo demo** (landed 2026-07-04 —
      `bindings/flutter/syncular` (Dart package) + `bindings/flutter/example`
      (a ~150-line single-file Flutter todo app); see
      `bindings/flutter/README.md`): the last platform with no binding. A
      `dart:ffi` wrapper over the five C functions (hand-written FFI
      typedefs from `rust/ffi.h` — no ffigen), a `SyncularClient` mirroring the
      Swift/Kotlin surface exactly (command + the typed conveniences
      mutate/subscribe/sync/syncUntilIdle/readRows/query/pendingCommitIds/
      conflicts/presence/setPresence/setWindow/windowState/… + connect/
      disconnectRealtime), a `poll_event` loop delivered to a broadcast
      `Stream` (a `Timer.periodic` doing NON-BLOCKING `timeout_ms=0` polls on
      the owning isolate — the honest simple choice for a callback-free FFI, no
      background isolate, never races a command, `close()` cancels the timer
      synchronously), and pause/resume/close. Dylib loading: `DynamicLibrary.
      open` per-platform names + a `libraryPath`/`SYNCULAR_LIBRARY_PATH`
      override (the Kotlin/Swift pattern). The example todo app lists via
      `query`, adds/toggles via `mutate`, auto-syncs on the `sync-needed` event
      + a manual sync button, connecting to the `apps/demo` server (8787).
      Offline-first hermetic tests (`dart test`) mirror the Swift/Kotlin suite
      (mutate → optimistic `version -1` row, query, outbox, `transport.
      unavailable`, close idempotence, pause/resume). Its own `check.sh`
      detect-and-skips a Dart-less machine (SKIPS locally on this mac — no
      dart/flutter installed). CI lane (`flutter-bindings`, Ubuntu,
      path-gated): `cargo build -p syncular-ffi` → `subosito/flutter-action` →
      `dart analyze` + `dart test` with `SYNCULAR_LIBRARY_PATH` at the built
      `.so` — the `dart:ffi` boundary against the REAL Rust core is the strong
      proof; the app BUILD is a documented local `flutter run` (`flutter build
      web` is N/A for `dart:ffi`; `flutter build linux` needs GTK deps — the
      Tauri/RN honest-scoping precedent). Example platform scaffolds are
      `flutter create`-generated and git-ignored; the app code is the
      deliverable.
- [x] **Native schema codegen: Swift/Kotlin/Dart emitters + all demos
      generated with `--check` freshness** (landed 2026-07-04): `@syncular/
      typegen` gained three IR-driven emitters (`src/emit-{swift,kotlin,dart}.
      ts`), opt-in per manifest via `output.{swift,kotlin,dart}` (path string or
      an options object — Kotlin `package`/`objectName`, Swift `enumName`;
      additive within `output`, no `manifestVersion` bump). Each file carries
      the TS emitter's DO-NOT-EDIT + `irHash` header, is gated byte-exactly by
      `generate --check`, and has a determinism golden in the typegen suite
      (`test/golden-native.test.ts`, rides `bun run check`). Honest type mapping
      (integer→Int/Long/int, bytes+crdt→[UInt8]/ByteArray/List<int>, blob_ref/
      json→String; `fromRow` accepts SQLite 0/1 as booleans) documented in the
      typegen README §5. Every demo now consumes REAL generation: Swift + Kotlin
      speak a generated `notes` schema (`SyncularSchema.schema` + typed `Notes`
      rows + subscription helpers replacing the hand-built literals), Flutter a
      generated `todos` schema, and the Tauri + RN examples ship REAL typegen
      output from their own manifests (mirroring `apps/demo-react`) in place of
      the hand-written stand-ins. Each binding `check.sh` runs `generate
      --check` as a freshness gate (bun-gated, so it runs even where the
      platform toolchain is absent). No new CI jobs — the goldens ride the main
      bun gate, the freshness gates ride the existing per-binding jobs.
- [ ] **Native CRDT editing (yrs)**: optional — the server merges, so
      native apps already converge; yrs integration is only needed for
      local collaborative EDITING UX on native. Demand-gated within this
      block.
- [x] **Conformance for bindings** (decided + landed 2026-07-04; doctrine in
      `bindings/README.md`): the stdio shim locks the CORE (the shared
      `syncular-command` router, 68/68), and every binding consumes that SAME
      router — so wrappers are protocol-thin and re-running the catalog per
      wrapper would test the router N more times and marshaling zero more.
      The thin bar: each wrapper ships an OFFLINE HERMETIC smoke against the
      REAL native core (Swift `swift test`, Kotlin `gradle test`) + a parity
      proof where it feeds JS hooks (RN + Tauri bridges accepted by the React
      `normalizeClient`, driving every `SyncClientLike` member — a drift breaks
      the suite). Anything that grows logic beyond marshaling graduates to its
      own pairing lane; today none does.

## 2. Deployment completion

- [x] **Durable Object realtime for Workers** (landed 2026-07-03):
      `SyncularRealtimeHost`/`SyncularRealtimeDO` in server-workers — one DO
      per partition hosting the RealtimeHub, WS hibernation driving the
      existing RealtimeSession (rehydrated from a minimal socket attachment +
      the D1 client record on wake), in-DO commit fan-out, D1 storage; the
      `/realtime` upgrade route + the HTTP-push wake path (the in-platform
      LISTEN/NOTIFY analogue). Hermetic tests drive the real session/hub/D1
      code through the real DO class over a DO double (d1-double doctrine) +
      the reference codec — the conformance bar for a deployment adapter.
      Real-`wrangler dev` smoke is a documented manual recipe, not an
      automated lane: `wrangler` bundles workerd/esbuild/miniflare (>100 MB)
      — disproportionate for one WS round when the double exercises the real
      logic (README "Real-workerd smoke"). Closes the last "supported now
      (HTTP)" asterisk in the deployment matrix.
- [x] **Blobs on Postgres** (landed 2026-07-04): the optional blob storage
      methods (`setBlobRefs`, `listRowsReferencingBlob`,
      `listReferencedBlobIds`) on PostgresServerStorage, plus the
      `sync_blob_refs` table + `(partition, blob_id)` covering index in
      `POSTGRES_DDL` (parity with the SQLite dialect; `migrate()` stays
      idempotent, all `CREATE … IF NOT EXISTS`). The shared `ServerStorage`
      contract's new blob section runs on pglite alongside sqlite/D1, and
      `postgres-explain.test.ts` asserts the by-blob candidate scan is
      index-driven (no `Seq Scan`). A Workers/PG deployment now supports
      blobs end-to-end (push writes refs in-commit; the download handler
      authorizes via the reference index).
- [x] **S3 segment stats** (landed 2026-07-04): `S3SegmentStore.stats()`
      via a LIST-free pointer-object accumulator (fixed key, read-modify-
      write on `put`, ETag `If-Match`/`If-None-Match` CAS retry loop; a HEAD
      dedups idempotent re-puts). Counters are honestly **approximate** —
      surfaced as an additive `approximate: true` marker on
      `SegmentStoreStats`/`BlobStoreStats` that flows through
      `admin.segmentStats()`/`stats()`; the exact in-process stores omit it.
      The s3-stub gained conditional-write (ETag) support. Blob bytes ride
      the in-process stores (no S3 blob store class yet), so there is no S3
      `blobStats()` path today — documented, and the accumulator pattern is
      ready for it. Tests: stub round-trip, idempotent-re-put dedup,
      deterministic CAS-reject (no-lost-update) simulation, admin marker
      carry-through.
- [x] **S3 blob store + orphan GC** (landed 2026-07-05): `S3BlobStore` — the
      blob twin of `S3SegmentStore` (same SigV4, content-addressed keys, same
      approximate stats accumulator) — closing the "attachments are
      SQLite-only" deployment gap. Keys are `{keyPrefix}blob/{partition}/
      sha256/{hex}`, partition-scoped, bytes verbatim so presigned GETs serve
      the content-addressed body. The honest interface difference from
      segments is encoded: **blobs are durable — no `ttlMs`, no `expiresAtMs`,
      no lifecycle-expiration mapping**; reclamation is reference-driven via
      `sweepOrphanBlobs(storage, blobStore, partition, {graceMs})`, the
      ready-made GC helper over `listReferencedBlobIds` (deletes only
      unreferenced-AND-older-than-grace blobs; default 24 h grace protects the
      upload-before-reference race; one `blob.swept` ops event). The sweep is
      the store's only LIST (`ListObjectsV2`, paged, off the hot path).
      Presigned blob **downloads** land too: `blobSignedUrls` +
      `s3PresignedBlobUrls`, issued only after the §5.9.5 row-derived authz
      check, returned additively on `BlobDownloadResult` — client consumption
      (following the URL) stays a later rung; server issuance ships now.
      Presigned **upload** stays gated (§5.9.3 — deferred by design). Tests:
      shared `BlobStore` contract across memory/sqlite/S3, presigned GET
      round-trip + expiry via the stub, sweep semantics (orphan deleted after
      grace, referenced survives, fresh-unreferenced survives grace, multi-page
      pagination), Workers fetch-handler blob round-trip on S3.

## 3. Windowed sync W1 (the differentiator)

Design is DONE (`DESIGN-eviction.md`, 2026-07-03): windows = scope-value
sets; window-scoped subscriptions (window change = sub-set diff, add =
fresh image bootstrap, remove = unsubscribe fused with eviction); zero
wire changes, zero server changes; sequenced AFTER the WS-native loop
(done) as required.

- [x] **W1 implementation** (landed 2026-07-04): window registry in both
      clients (`_syncular_windows` + a `_syncular_window_pending_evict`
      deferred-eviction table), `setWindow(base, units)` / `windowState(base)`
      on the TS `SyncClient` (mirrored on the worker handle + follower
      forwarding, one interface) and the Rust core (+ `syncular-command`
      router commands, so the shim/Tauri/RN bridges reach it unchanged),
      eviction fused with unsubscribe (E1 outbox-pin defers, E2 version dies
      with the row, drained on the next push), re-entry via the image lane,
      Appendix B.18's six conformance scenarios (74/74 both pairings, fresh
      shim), the SPEC edits §8 enumerates (§3.3 eviction note, §4.1
      omission-as-unsubscribe, new §4.8, §8.1 timing note — the §4.7 phasing
      resolution was already landed), the query-completeness oracle
      (`windowState` + the `useWindow` React hook, I3), and a cheap bench
      value-sharding proof (`{A,B}→{B,C}` re-downloads only C — asserted as a
      correctness budget in `bench:ci`). Own-JS budget re-derived 66 → 72 KB
      (the shipped differentiator, +6.1 KB raw / +1.65 KB gzip).
- [ ] **W2 TTL sugar** (codegen creation-time bucket columns) — after W1
      proves out.

## 4. DX polish

- [x] **Kysely typed local queries** (landed 2026-07-04): `@syncular/
      kysely` — a Kysely `SyncularDialect` (reusing Kysely's SQLite compiler/
      adapter/introspector) whose driver runs SELECTs over a host's
      `query(sql, params)` surface, so it works on ALL hosts (direct/worker/
      follower/Tauri/RN), not just the direct client — it never touches
      `ClientDatabase`. READ-ONLY by contract: the driver rejects any
      non-SELECT (and transactions) loudly, pointing at `mutate()` (writes
      MUST go through the outbox, §7.1). Its OWN package (not a web-client
      subpath), so Kysely never enters the core bundle — bundle-entry reaches
      nothing here; own-JS stays 69.10 KB (72 KB ceiling untouched). Typegen
      emits a `Database` interface (table→Row map) additively — all embedded
      generated files regenerated (fixture, demo, quickstart, both create-app
      templates; --check byte-exact). React: `@syncular/react/typed`'s
      `useTypedQuery(qb => …)` compiles the builder, extracts `{tables}` from
      the compiled AST (exact invalidation, no text heuristic), and reuses
      `useSyncQuery`'s machinery — behind a subpath with kysely as OPTIONAL
      peers so plain `useSyncQuery` apps never pull Kysely. Also: the worker
      host now schedules an autoSync round after `mutate`/`setWindow` so local
      writes and window widenings push/bootstrap promptly under `autoSync`
      (the host loop owns rounds, §8.4).
- [x] **Named queries — the cross-platform type-safe query tier** (landed
      2026-07-04): the sqlc/SQLDelight rung, decided with Benjamin as the
      cross-platform type-safe query answer (over per-runtime ORMs that want to
      own the connection, and over a custom cross-runtime DSL that would be a
      per-language maintenance trap). A `.sql` file in `queries/` (one file =
      one query, kebab→camel) transpiles into a typed function on every
      platform — TS/Swift/Kotlin/Dart — killing query↔type drift by
      construction. SELECT-only (the read tier; writes stay `mutate()`),
      rejected loudly otherwise. Type-checked **by SQLite itself**: typegen
      synthesizes the schema DDL from the IR, builds an in-memory bun:sqlite
      DB, and `prepare()`s each query — SQLite validates every reference and
      yields column decltypes. Plain column refs get the EXACT IR type +
      nullability (resolved against the IR); computed expressions fall back to
      a documented honest type (bun:sqlite exposes decltype + paramsCount but
      no origin/param-names/NOT-NULL — the fidelity boundary is documented).
      `:name` params: types inferred from column comparisons, or a
      `-- param :name <type>` header override. Each query bakes in its exact
      FROM/JOIN table set for invalidation. Emitted per-language into its OWN
      file (`*.queries.*`) so schema-only consumers never churn; `--check`
      byte-exact per language. React: `useNamedQuery(query, params)` reuses
      `useSyncQuery`'s machinery with the query's exact `{tables}`. Kysely
      stays the TS dynamic tier; raw `query()` stays the escape hatch —
      the three-tier read story. Dogfooded: demo-react's list read + the
      Swift/Kotlin example TodoStores converted to named queries (demo-react
      keeps a `useTypedQuery` aggregate so the dynamic tier stays visible;
      Swift gate green — generated queries compile in the example).
- [x] **Named-query layout v2** (LANDED 2026-07-04, commit 1f53a6e8 —
      supersedes the earlier mid-discussion sketch that stood here; the final
      design agreed with Benjamin differs from that sketch). The shipped
      model: folders under `queries/` recurse and are pure organization —
      **a query's name is its camelCased path**
      (`billing/invoices/list.sql` → `billingInvoicesList`), so no
      namespacing machinery exists in any language, uniqueness is
      filesystem-given, and names are decoupled from output layout forever
      (output granularity can change later with zero API break — the reason
      no single/per-folder/per-file mode option was added). A
      `-- name: fullName` marker directly above a statement overrides
      verbatim (deliberately the marker form — a bare one-word prose comment
      must never silently rename a query); **multiple statements per file**
      split on top-level `;`, every statement in a multi-statement file
      requiring its own `-- name:` (loud error otherwise); `-- param`
      comments scope per-statement; global name uniqueness enforced at
      generate time with both source locations in the error. Zero churn in
      pre-existing outputs (all 11 manifests stayed --check fresh).
- [x] **CREATE INDEX in the migration subset** (LANDED 2026-07-05): apps can
      now declare local secondary indexes for their own query load —
      `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table (col [, col…])`. The
      parser accepts plain/compound/UNIQUE/IF-NOT-EXISTS; ASC/DESC, expression,
      and partial (`WHERE`) index columns are hard errors (the IR models column
      names only). The IR gains an additive per-table `indexes` field (no
      `irVersion` bump; emitted only when non-empty, so all pre-index manifests
      stayed `--check` fresh). Materialized as real SQLite indexes by the TS
      web-client mirror, the Rust core's base/visible table pair, and typegen's
      named-query type-check DB; recreated across the §7.4.3 schema-bump reset.
      **Server-side is intentionally out of scope**: the server stores rows in a
      generic `sync_rows` table with an opaque payload (no per-user-table SQL
      columns exist there), so the scope inverted-index already covers server
      reads and a user-column index has nothing to attach to.
- [x] **Live-query churn hardening** (LANDED 2026-07-05): under constant
      sync churn a naive live query re-renders and re-queries once per
      invalidation event. The fix is three cheap levers on the shared hook
      machinery (`packages/react/src/query-churn.ts` + `use-sync-query.ts`,
      wired through `useNamedQuery`/`useTypedQuery` pass-through options), NOT
      the per-rowid idea originally sketched here:
      - **Result stability**. After a re-run, reconcile the fresh result
        against the previous one (`reconcileRows`): whole-result deep-equal →
        skip `setRows` entirely (zero re-render, proven by a render-count
        probe; note this also required guarding the `isLoading`/`error` setters
        — React does not reliably bail on a no-op `setState(sameValue)` when
        other setters fire in the same batch). Changed → build the new array
        but REUSE the previous row object at each index whose content is
        unchanged, so `React.memo`'d row components keyed by row identity skip.
        Row-identity mechanism (the honest key): the hook knows no primary key
        — rows are plain JSON-able SQLite objects — so per-row content equality
        IS the identity. Each row is hashed once with a key-sorted JSON
        serialization and matched by index (a live query's ORDER BY makes index
        the stable position). O(n) with one string hash per row; measured
        ~0.2 ms for 1k narrow rows (bounded, well under a frame).
      - **Frame-coalesced re-query scheduling** (`FrameScheduler`). A burst of
        invalidation events between paints collapses to ONE re-run per query
        (rAF when the host has it, microtask fallback for bun/worker — timer
        -free, honoring the no-timers doctrine; a `flush()` gives tests a
        deterministic drain, no sleeps). An event arriving DURING a re-run
        marks dirty and re-runs exactly once after — never lost, never
        concurrent.
      - **Scope-key filtering**. When the hook has an explicit `scopeKeys`
        option AND the event carries scope keys, a disjoint event is skipped;
        a table-floor event (no scope keys, e.g. a segment/reset apply) ALWAYS
        re-runs — under-running is forbidden (the honest granularity rule).
      Tests: `packages/react/test/query-churn.test.ts` (reconcile/scheduler
      units + the 1k-row cost measurement) and `churn.test.tsx` (the four
      hook-level levers, act-hygienic); the I4 counter-proof and worker-handle
      parity paths still pass unchanged.

      *Why not per-rowid* (the ditched idea): a table→rowid dependency can
      refine invalidation for a hot SINGLE-row view, but it structurally
      cannot help a LIST query — any change to the table may enter or leave the
      list's predicate (a new row matching the WHERE, an update crossing an
      ORDER BY/LIMIT boundary), so the query must re-run regardless of which
      rowid changed. Knowing *which rows a predicate now selects* without
      re-running it is incremental view maintenance (IVM), a materialized
      -view engine — the someday-if-ever answer, far heavier than these levers.
      The churn levers cap render AND query cost for the common case (lists
      under steady sync) at the hook layer, where per-rowid could not.
      *Optional future refinement (typegen territory, OUT of scope this
      round):* a generated named query could bake scope-key TEMPLATES where a
      param binds a scope column, so the hook's `scopeKeys` derive from the
      bound params automatically instead of being passed by hand.
- [x] **Stabilize timing-sensitive test flakes under load** (LANDED 2026-07-04,
      building on fe09e277): the multi-tab flake's captured error — "cannot start
      a transaction within a transaction" (bun:sqlite) — was traced to TWO
      distinct causes, one ours and now fixed, one bun's and contained.
      - *Our cause (FIXED — the honest core fix)*: a **cross-operation
        interleaving race** in the client core. Every `db.transaction(fn)` has a
        SYNCHRONOUS `fn`, so a single operation's transaction depth is always
        correct — but the transaction-entering ASYNC operations (`sync`'s
        pull-round `#processResponse`, the realtime **delta** apply, and
        `setWindow`) each span an `await` (a `#downloadSegment`, a `deriveSubId`)
        and were NOT mutually excluded: `sync()` set `#syncing`, but the delta
        path never did, and `setWindow` was unguarded entirely. So a `setWindow`
        widen (or a second delta) could interleave its transactions with a pull's
        segment-apply, and worse, JOIN the pull's in-flight `#applyBatch`
        accumulator (`#batch`) across the await — corrupting invalidation
        batching and, under bun's thread timing, tripping the raw `BEGIN`. Fix:
        an **operation-serialization mutex** on `SyncClient` (`#opChain`, the
        promise-chain shape the worker host's `serializedSync` already used) that
        every transaction-entering async op runs under to completion, so no two
        interleave at an await point. Re-entrancy is honored (`runTransaction`'s
        savepoint nesting handles legitimate nested `db.transaction`; nothing
        serialized calls another serialized op). The `sync()` "one loop owns the
        database" reject-on-concurrent contract is preserved via a synchronous
        `#syncOutstanding` guard checked before the chain would queue. Proven by
        a DETERMINISTIC interleaving test (`test/serialization.test.ts`): a
        bootstrap pull is suspended at a gated segment download while a
        `setWindow` widen is driven; a `ClientDatabase` overlap probe (counts any
        two top-level transactions open at once) plus a bounded-settle assertion
        FAIL before the fix (the interleave wedges both ops) and PASS after —
        demonstrated by temporarily reverting `#serialize`.
      - *bun's cause (CONTAINED — a runtime bug, not ours)*: the RESIDUAL flake is
        a **bun 1.3.14 native crash** — multiple `Worker` OS-threads (proven true
        threads: 4×800 ms spins finish in 803 ms) each opening a `bun:sqlite`
        connection under BroadcastChannel/`fetch` load intermittently
        SEGFAULTS/OOMs the runtime ("panic: Segmentation fault … Bun has crashed.
        This indicates a bug in Bun, not your code."). Reproduced in a ~40-line
        harness with ZERO syncular code (workers + `:memory:` OR file-backed
        sqlite + BroadcastChannel), independent of `:memory:`. No application code
        can prevent a bun segfault. In real browsers each worker owns its OWN OPFS
        sahpool FILE (no shared connection, file-locked) so this cross-thread
        corruption cannot occur in production — it is a bun-test-harness artifact.
      - *Isolation-split decision (KEPT, with rationale)*: `package.json` keeps the
        `test:main` + `test:isolated` split (multi-tab runs in its own `bun test`
        process). Evidence decided it: in a SINGLE shared-process sweep the
        multi-tab test still crashes/fails (other files' worker threads add
        contention); isolated it is far more stable (50/50 clean batches, the odd
        bun segfault ~2–5 % across batches). The split is honest containment for a
        bun runtime bug, NOT a fix for a syncular race — that race is fixed at the
        source above. With the core race gone, the isolated run's ONLY residual
        failures are bun's own segfault/OOM crashes, never our transaction-depth
        error. Gates: `bun run check` green (768 + 8 pass), `bench:ci` green
        (own-JS 69.8 KB), Rust conformance 74/74. Two 20× `bun run test` sweeps:
        `PPPPPPPPPCPPPPPPPPPP` (1 bun segfault) and `PPPPPPPPPPPPPPPPPPPP` (clean).
      - *Containment*: `test:isolated` retries ONCE on failure — the bun bug
        manifests either as a segfault or as a phantom
        "cannot start a transaction within a transaction" (~1-in-20 runs,
        `BEGIN` failing while `inTransaction === false`); the retry note
        prints loudly so a retried run is never mistaken for clean. Remove
        the retry when the bun bug is fixed upstream.
      - *Follow-up (bun-owned)*: file the bun worker-threads + `bun:sqlite`
        segfault upstream; revisit collapsing the isolation split once a bun
        release fixes it. Do NOT chase it in syncular code.
      What ALSO landed earlier (fe09e277, kept):
      - *React suite (test-race)*: `integration.test.tsx` + `parity.test.tsx`
        fired `client.mutate(...)` OUTSIDE `act()`, so the invalidation →
        re-query → `setState` chain it drives landed as floating microtasks
        the assertion raced (that IS the act()-warning the suite emitted).
        Fix: wrap the mutate/`syncUntilIdle` calls in `await act(async …)` so
        React flushes those updates deterministically. The act() warnings are
        gone. Sibling sweep: the three I4/presence negative-assertion
        `setTimeout(r, 5)` "give a stray effect a tick to not fire" sleeps in
        `hooks.test.tsx` were replaced with a deterministic `act`-microtask
        flush (`flushEffects`) — no wall-clock ticks left in the react suite.
      - *Multi-tab fanout (PRODUCTION-race, upgraded from flake to bug fix)*:
        `bootFollower` handed back a follower handle whose `FollowerLink` had
        not yet processed the leader's `announce` (epoch −1). `FollowerLink`
        drops any `event` whose epoch ≠ its own with NO retry, so any
        invalidation the leader fanned out in the hello→announce window was
        silently lost — a real miss a just-opened multi-tab follower could hit,
        not merely a test artifact (proven deterministically:
        an epoch-3 event delivered to an unbound follower is dropped).
        Fix: added `FollowerLink.waitUntilBound()` and made `bootFollower`
        await it before resolving `createSyncClientHandle`, so a follower is
        only handed back once it can receive fanned-out events. Regression
        tests added: a follower is bound-on-return (an immediately-emitted
        event reaches it) and a `waitUntilBound` unit (resolves on announce,
        rejects on bind timeout).
      - *Note (out of territory)*: `packages/typegen/test/golden-native.test.ts`
        shows a separate ~5-fail golden flake under load — a different class,
        left for the typegen agent.
- [x] **demo-react** (landed 2026-07-04 — `apps/demo-react`, port 8788): a
      single-pane hooks todo app on the SAME server as `apps/demo`,
      dogfooding `SyncProvider` + `useTypedQuery` (Kysely-typed) +
      `useMutation` + `useSyncStatus` + `useWindow` (a three-list filter
      dropdown driving `setWindow` — W1 windowing visible: switching lists
      bootstraps the new list and evicts the old). Worker + OPFS core, React
      via workspace deps, Bun.build serving (the demo pattern). Smoke test
      boots the server and asserts the React frontend builds (`/app.js`/
      `/worker.js`, `POST /sync` answers). Noted as create-app's third
      template candidate (not built). Verified live in-browser: typed reads,
      window switch, optimistic write + outbox drain all confirmed.

## 5. Release (gates with Benjamin)

- [x] **6.3 Package naming** (Benjamin, DONE 2026-07-05): every `-v2` name
      killed. Final names are `@syncular/*` + unscoped `create-syncular-app`;
      typegen bin `syncular`; workspace root `syncular`. Was mechanical (one
      constants module in create-app + workspace-wide sed); lockfile and all
      typegen outputs regenerated. Publish ranges still flip one constant.
- [ ] **Publishing pipeline**: changesets + trusted publishing for the v2
      package set, carrying the v1 lessons (binaryen/parse-check class
      guards: any pipeline that builds artifacts parse-validates them;
      post-publish install smokes with no platform skips).
- [ ] **6.4 Sunset actions** (promotion DONE 2026-07-04: v2/ is now the
      repo root; the old tree lives untracked on disk at v1/ — gitignored,
      full history in git — delete it when the sunset completes; remaining:
      archive old packages/ + rust/, execute the registry deprecations
      (incl. the broken-WASM 0.1.x artifacts), publish the migration
      guide (already written: docs/pages/migration.md).
- [ ] **7.1 Gate decision + 7.2 push** (Benjamin): the kill/merge call on
      the evidence in bench/RESULTS.md; the local commit stack ships when
      pushed.


## 6. Gap register (swept 2026-07-05, with Benjamin)

**The live working checklist is `TODO.md` (repo root)** — this section
keeps the strategy framing and the NON-GOALS (authoritative here).
The full does-not-work / would-be-useful sweep. Wave 1 (in flight):
live-query churn hardening (replacing per-rowid — see block 4), CREATE
INDEX in the migration subset. (S3 blob store + GC sweep **landed
2026-07-05** — see block 2.)

**Wave 2 queue (approved):**

- [x] **Server-side write-validation hooks** (LANDED 2026-07-05): per-table
      `validators` host callback, run after decode + §3.4 authz inside the
      commit transaction; a throw rejects the commit atomically with a
      host-defined code (§6.3) the client surfaces unchanged on both cores.
      SPEC §6.7 pins it (order, merged-CRDT-value, reserved host-code
      prefixes). Runtime hook only — the IR extensions slot stays the noted
      home for future declarative metadata, no codegen this rung.
- [ ] **App-developer test kit**: an exported testing package (in-memory
      server, N clients, virtual clock, offline/fault toggles) — mostly
      re-exporting what the conformance harness already has. S-M, a
      differentiator almost no local-first competitor offers.
- [ ] **Node ClientDatabase**: better-sqlite3 adapter behind the existing
      interface — Electron-main / plain-Node hosts have no SQLite backend
      today. S.
- [ ] **Docs site deploy**: 15 pages build; nothing hosts them. S,
      needed by launch.

**Smaller / demand-gated (build when triggered):**

- [ ] Named-query `-- returns` override for computed-expression typing
      (today: nullable-affinity fallback, documented). S.
- [ ] Conflict-resolution sugar: `resolveConflict(keep: server|local|
      merged)` codifying the rebase pattern the conformance tests do by
      hand. S.
- [ ] Reference observability sink (OTel-shaped example over the events
      seam) + auth integration guides (Clerk/Auth.js worked examples —
      docs only). S each, high adoption value.
- [ ] Client devtools: a debug surface (local DB / outbox / rounds /
      invalidation introspection) + docs page. M.
- [ ] FTS5 local search: needs migration-subset support for virtual
      tables — pairs with a future "migration subset v2". M, demand-gated.
- [ ] Safari/Firefox support-floor verification (human hands, pre-launch)
      and a scheduled `load:smoke` run (nightly candidate). S each.

**Non-goals decided 2026-07-05 (do not resurrect without new evidence):**

- **Per-rowid invalidation** — structurally cannot help list queries
      (any table change may enter their predicate; that is IVM territory,
      a someday-if-ever product of its own). Replaced by the churn ladder
      in block 4.
- **Composite primary keys** — single-column text PK is a design
      constraint: row identity threads through idempotency (2.3), blob
      refs (5.9), windowing (4.8), conflict records (6.3); synthetic IDs
      are the local-first norm. The typegen hard error stays.
- **Our own chunked/resumable upload protocol** — S3/R2 native multipart
      IS the resumable protocol; when presigned upload lands, resume =
      provider multipart behind the presign flow. Never build a chunk
      spec. (Presigned upload itself stays gated on scale demand.)
- **Undo/redo core helper** — undo after sync is app-domain (a new
      inverse mutation with business meaning); ships as a docs recipe
      over mutate() at the next docs pass, not core API.
- **RN NitroModules/JSI** — measure-first (see block 1).

## Ordering

Block 1 (native bindings) and Block 2 (deployment completion) are
parallel-friendly and independent. Block 3 (W1) should not start until
its react-oracle dependency (I3) has a consumer story — practically:
after Block 1's Tauri/RN bridges exist, since windowing's UX shows up in
apps. Block 4 rides whenever. Block 5 is Benjamin-gated and can happen at
any point — naming is done (2026-07-05); the remainder (publish, gate,
sunset) is what's left.
