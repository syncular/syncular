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
      worker/follower). Caveat to document: every useSyncQuery run is one
      IPC round trip — fine at Tauri IPC latency; pagination guidance for huge
      result sets is a docs note.
- [ ] **Swift + Kotlin wrappers**: idiomatic thin wrappers over the FFI
      command surface (it was designed for them — JSON commands, opaque
      handle, poll_event). Packaging: xcframework (needs full Xcode; the
      build script already detects/skips) and AAR/jniLibs via cargo-ndk;
      lifecycle handling (background/foreground sync, connectivity) lives
      in the wrappers, not the core. Reuse v1's packaging KNOWLEDGE, never
      its code.
- [ ] **React Native**: JSI/TurboModule (NitroModules candidate) over the
      FFI, surfacing the SAME `SyncClientLike` JS interface so
      `@syncular-v2/react` works unchanged in RN (decided: RN uses the
      NATIVE core — Hermes has no OPFS/sqlite-wasm).
- [ ] **Native transport §8.7 completion**: the native-transport feature's
      first cut sends rounds over `POST /sync` (conformant) with the
      socket carrying wake-ups/presence; finish round-over-socket framing
      (tag 0x01 chunk streams) so native matches the web client's
      one-loop shape.
- [ ] **Native CRDT editing (yrs)**: optional — the server merges, so
      native apps already converge; yrs integration is only needed for
      local collaborative EDITING UX on native. Demand-gated within this
      block.
- [ ] **Conformance for bindings**: the existing stdio shim locks the
      core; add a thin pairing lane per binding only where the binding
      adds logic (the Tauri bridge and RN module are protocol-thin — a
      smoke per platform beats a full catalog run; decide per binding).

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

- [ ] **W1 implementation**: window registry in both clients, eviction
      fused with unsubscribe (outbox-pinned rows excepted), re-entry via
      the image lane, the six Appendix-B scenarios from the design doc,
      the one-line §4.7/§8.1 SPEC edits it calls for, and the query-
      completeness oracle wired into the react bindings (I3).
- [ ] **W2 TTL sugar** (codegen creation-time bucket columns) — after W1
      proves out.

## 4. DX polish

- [ ] **Kysely typed local queries**: `useSyncQuery`/client query API are
      string-agnostic by design — add a typed layer generated from the
      schema IR (typegen emits table types already; a kysely dialect over
      ClientDatabase). No API break.
- [ ] **Per-rowid invalidation refinement**: today's granularity is
      table + scope-key (honest to the wire); a table→rowid dependency
      option for hot single-row views was left room for in the design.
      Demand-gated.
- [ ] **demo-react**: a hooks-based example app (also the scaffolder's
      third template candidate).

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
