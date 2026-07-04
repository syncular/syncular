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
      `tauri-plugin-syncular` in v2/bindings/tauri/plugin, its own cargo
      workspace, plus `@syncular-v2/tauri` in v2/packages/tauri; see
      v2/bindings/tauri/README.md): native syncular instance + React
      bridge — NOT JS syncular in the webview (webview OPFS is
      eviction-prone and inconsistent across WKWebView/webkitgtk; the Rust
      core gives a real file DB and native perf). Shape:
      `tauri-plugin-syncular` (Rust, consumes the client crate DIRECTLY —
      no FFI — exposing the `syncular-command` router as Tauri commands +
      invalidate/presence/sync-needed/conflict over Tauri events) plus
      `@syncular-v2/tauri` (JS bridge implementing the same
      `SyncClientLike` interface the react package already normalizes —
      hooks work unchanged, the fourth host of one interface after direct/
      worker/follower). Example upgraded to React (2026-07-04 —
      `example/src/frontend` is now a `@syncular-v2/react` hooks todo list over
      `createTauriSyncClient`, bundled with a dependency-light `Bun.build`; the
      only Tauri-specific line is the client construction). Caveat to document:
      every useSyncQuery run is one IPC round trip — fine at Tauri IPC latency;
      pagination guidance for huge result sets is a docs note.
- [x] **Swift + Kotlin wrappers** (landed 2026-07-04 — `bindings/swift`
      (SwiftPM `SyncularClient`) and `bindings/kotlin` (Kotlin/JVM
      `SyncularClient` via **FFM**, `java.lang.foreign`, JDK 21+ — zero JNI C
      glue; JNA documented as the JDK<21 fallback)): idiomatic thin wrappers
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
- [x] **React Native** (landed 2026-07-04 — `@syncular-v2/react-native` under
      `bindings/react-native`): a TurboModule over the FFI, surfacing the SAME
      `SyncClientLike` JS interface so `@syncular-v2/react` works unchanged in
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
      NitroModules/JSI is the follow-up for latency; the C ABI is the stable
      substrate.
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
      generated with `--check` freshness** (landed 2026-07-04): `@syncular-v2/
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

- [x] **Kysely typed local queries** (landed 2026-07-04): `@syncular-v2/
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
      templates; --check byte-exact). React: `@syncular-v2/react/typed`'s
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
- [ ] **Per-rowid invalidation refinement**: today's granularity is
      table + scope-key (honest to the wire); a table→rowid dependency
      option for hot single-row views was left room for in the design.
      Demand-gated.
- [x] **Stabilize timing-sensitive test flakes under load** (landed 2026-07-04):
      both offenders root-caused and fixed; 20/20 green under synthetic load
      (16–20 CPU-starving procs on 10 cores, load avg 8–28).
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

- [ ] **6.3 Package naming** (Benjamin): pick final names; the rename is
      mechanical (one constants module in create-app; workspace-wide
      find/replace of @syncular-v2; publish ranges flip one constant).
- [ ] **Publishing pipeline**: changesets + trusted publishing for the v2
      package set, carrying the v1 lessons (binaryen/parse-check class
      guards: any pipeline that builds artifacts parse-validates them;
      post-publish install smokes with no platform skips).
- [ ] **6.4 Sunset actions** (Benjamin): promote v2/ toward repo root,
      archive old packages/ + rust/, execute the registry deprecations
      (incl. the broken-WASM 0.1.x artifacts), publish the migration
      guide (already written: docs/pages/migration.md).
- [ ] **7.1 Gate decision + 7.2 push** (Benjamin): the kill/merge call on
      the evidence in bench/RESULTS.md; the local commit stack ships when
      pushed.

## Ordering

Block 1 (native bindings) and Block 2 (deployment completion) are
parallel-friendly and independent. Block 3 (W1) should not start until
its react-oracle dependency (I3) has a consumer story — practically:
after Block 1's Tauri/RN bridges exist, since windowing's UX shows up in
apps. Block 4 rides whenever. Block 5 is Benjamin-gated and can happen at
any point — naming earlier is cheaper (fewer docs to re-grep).
