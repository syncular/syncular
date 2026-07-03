# v2 TODO — everything between here and "done"

Deliberately general: each item is a scoped chunk of work whose details get
figured out when tackled, against `SPEC.md` and the conformance catalog.
Order within a section is roughly the intended order. Ground rules that
apply to every item: spec-first (behavior lands in SPEC.md with vectors or
conformance scenarios before/with the code), judgment calls get codified
back into the spec, no fallback paths (REVISE.md Direction decisions,
2026-07-03), and the v2 gate (`bun run check`) plus the Rust pairing stay
green throughout.

"Done" means: a TypeScript-first sync engine at v1 feature parity where it
matters, two conformance-locked cores, no cargo in the JS toolchain, and
the old tree archived.

## 1. Performance rungs (first — before feature parity)

- [x] **sqlite-image segments**: LANDED 2026-07-03 — `mediaType: sqlite`
      end to end. SPEC §5.3 completed to implementable (whole-table
      images, exact `_syncular_segment` metadata columns, one-transaction
      apply, non-deterministic bytes + server-side reuse as the
      bootstrap-storm rule, rows-lane pinning on mid-table resume);
      server builds/stores/reuses images on bun:sqlite behind
      `SegmentStore.find`; TS client imports via the optional
      `ClientDatabase.withSqliteImage` (bun: temp-file ATTACH; wasm:
      `sqlite3_deserialize`) and advertises accept bit 2 when capable;
      Rust client applies via rusqlite; conformance B.10 (4 scenarios,
      both pairings); bench image lane + `imageBootstrapRowsPerSecFloor`
      CI budget. Wire shape unchanged — no vector regeneration (image
      bytes are deliberately not vector-pinned, §5.3).
- [ ] **Worker + OPFS mode** (Direction decision 2): whole client core in a
      worker on `opfs-sahpool`, thin RPC to the UI thread, in-memory as
      explicit-ephemeral only. Persistence lands here; the demo drops its
      in-memory badge.
- [ ] **WebSocket-native sync loop** (Direction decision 1): sync rounds
      over the socket, kill the separate HTTP round-trip from the client
      loop; `POST /sync` stays server-side for producers/tooling. Define
      backpressure/max-in-flight for large pulls over WS in the SPEC.
- [ ] **Signed-URL client path**: client advertises accept bit 3, fetches
      segments from CDN/R2-style URLs; conformance scenario for the
      issue→fetch→verify loop. (Server side already exists.)
- [x] **Perf budgets in CI**: LANDED 2026-07-03 — `bench:ci` mode with
      documented budgets (rows/sec floor 90k, propagation p95 ≤ 20 ms,
      own JS ≤ 60 KB raw, total ≤ 600 KB gzip) as a `bench-budgets` job
      in `v2.yml`; RESULTS.md stays the curated local record.

## 2. Parity ladder (one at a time, spec'd before built)

- [ ] **Blobs / file attachments**: BlobRef-style columns, upload/download
      through the segment-store abstraction, storage backends (filesystem +
      S3/R2), scope-checked delivery, client cache + re-download.
- [ ] **CRDT fields**: opt-in per column (Yjs on TS; the Rust side consumes
      the same wire format). Wire format + merge semantics into SPEC with
      vectors; conformance scenarios for concurrent-edit convergence.
- [ ] **Auth leases** (v1's `sync.auth_lease_*` family): spec the lease
      lifecycle, reserve→specify the error codes (§10.3 already reserves
      them), server enforcement + client refresh behavior.
- [ ] **Presence + realtime hardening**: presence events (§8.6 reserved),
      reconnect storms, wake coalescing under fanout load, oversize-delta
      policies at scale.
- [ ] **Console / event stream**: admin surface over the server core
      (inspection of commits, scopes, clients, horizon). Decide how much of
      v1's console UI survives vs a leaner event-stream + queries approach.

## 3. Client platform surface

- [ ] **React bindings + live queries**: `useSyncQuery`-class hooks with
      **fine-grained invalidation designed in from day one** (table/scope-key
      per commit — never re-run-everything; REVISE post-parity note is now a
      design-time rule). Kysely as the typed local query layer.
- [ ] **Multi-tab followers**: leader election via Web Locks exists as a
      seam; build the follower path (BroadcastChannel proxy to the leader's
      worker) — one socket, one DB, N tabs.
- [ ] **Schema-bump flow** (Direction decision 3): wipe-and-rebootstrap on
      `requiredSchemaVersion`, outbox preserved and replayed; no client
      migration engine. Needs a conformance scenario and a demo/docs story.
- [ ] **Native packaging of the Rust client**: the POC crate becomes the
      shipping native core — FFI surface, iOS/Android/JVM/desktop
      packaging, lifecycle handling. Reuse v1's packaging *knowledge*, not
      its code. Conformance via the existing driver shim (or a WIT/component
      shim if the subprocess model gets in the way — Wasmtime option noted
      2026-07-03).
- [ ] **Tauri / React Native**: bindings over the native core; decide
      whether RN uses the native core or the TS core per platform reality.

## 4. Server breadth

- [ ] **Postgres storage**: implement the storage interface (the inverted
      scope index MUST survive contact with Postgres — covering indexes,
      no scan-before-LIMIT), LISTEN/NOTIFY multi-instance fanout as the
      primitive, and a dedicated bench lane the day it lands (v1's
      production wound was exactly here).
- [ ] **Runtime adapters**: keep the core runtime-neutral; decide the
      supported set beyond Hono/Bun (Cloudflare Workers + D1/DO is the
      likely ask) and what explicitly does NOT get an adapter. Relay:
      decide if it returns at all.
- [ ] **Segment store backends**: S3/R2 for production segment storage +
      the CDN delivery story end-to-end.
- [ ] **Ops posture**: structured server events/metrics hooks (what v1's
      Sentry adapter did, as a neutral interface), horizon/pruning
      scheduling guidance, load-test suite ported to v2 lanes.

## 5. Protocol/spec debts (small, decide-and-pin)

- [x] SSG2 `server_version` column: DECIDED + LANDED 2026-07-03 — added.
      Every SSG2 row record carries `serverVersion` (i64, ≥ 1) ahead of
      the row bytes (SPEC §5.2); sqlite images carry `_syncular_version`
      (§5.3); the §5.6 no-synthesis rule is replaced by full §6.2
      participation. Vectors regenerated, both codecs, both clients,
      conformance scenario B.9. (Unblocks item 1.1.)
- [x] Windowed sync / eviction: DESIGNED 2026-07-03 — `DESIGN-eviction.md`.
      Windows = scope-value sets (no second mechanism); window-scoped
      subscriptions (window change = sub-set diff, re-entry = image
      re-bootstrap); eviction fused with unsubscribe, outbox-pinned rows
      excepted. W1 ships with ZERO wire/server changes, sequenced after
      the WS-native loop. Blob (B1–B4) + invalidation (I1–I4) constraints
      enumerated for items 2.1/3.1. Two SPEC notes to resolve at W1:
      §4.7-phasing vs §8.1-replace ambiguity (one-line edit, resolve in
      windowing's favor); §8.1 fixed registration covered by WS loop.
      Implementation itself stays post-parity.
- [ ] Segment compression posture: zstd/CDN-encoding for segment bytes at
      rest/transfer (ids hash uncompressed bytes — already spec'd; pick
      the shipped default).
- [ ] E2EE: explicitly re-scope (v1 had it; decide where it lives in v2's
      ladder or whether it waits for demand).

## 6. Product & release

- [ ] **Docs site**: v2 docs from the spec outward (the spec is the
      reference; docs are the guide). Quickstart ≤ 5 minutes to two synced
      clients.
- [ ] **Scaffolding**: `create-syncular-app` equivalent for v2; typegen CLI
      polish (`syncular-v2 generate` → final naming).
- [ ] **Package identity + release pipeline**: naming/versioning for the
      v2 packages (@syncular/* 0.2? clean break?), changesets + trusted
      publishing wired for the v2 set, the binaryen/parse-check lessons
      carried over into any pipeline that builds artifacts.
- [ ] **Migration guide + old-tree sunset**: 0.1.x → v2 guide, v2 folders
      promoted to mainline (v2/ → repo root), old packages/rust archived,
      registry deprecations executed (including the broken-WASM 0.1.x
      artifacts — still pending from the freeze).

## 7. Process gates

- [ ] **Kill/merge gate decision** (Benjamin) — data in `bench/RESULTS.md`;
      all four criteria PASS as of 2026-07-03.
- [ ] **Push** the local commit stack (Benjamin's call, per standing rule).
- [x] **Rust pairing in CI**: LANDED 2026-07-03 — `rust-conformance` job
      in `v2.yml` (fmt + clippy -D warnings + cargo test + shim build +
      the full pairing under SYNCULAR_RUST_CONFORMANCE=1). CI-blocking
      once pushed; default `bun run check` stays cargo-free.
