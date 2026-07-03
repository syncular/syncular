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
- [x] **Worker + OPFS mode**: LANDED 2026-07-03 — whole client core in a
      worker on `opfs-sahpool` (Direction decision 2). `./worker` exports
      `startSyncWorker` (constructs SyncClient + transports + database in
      the worker; database-factory indirection for tests); the main
      thread drives it through `SyncClientHandle` over a 6-message
      postMessage RPC (`init`/`call`/`ready`/`result`/`error`/`event`,
      typed from one shared `WorkerApi`). The handle takes the Web Locks
      leader lock BEFORE spawning the worker; a second tab gets a clear
      not-leader state (followers stay TODO 3.2). `openWasmDatabase()` is
      now explicitly ephemeral (always `:memory:`);
      `openPersistentWasmDatabase(name)` is worker-only, no COOP/COEP
      needed, loud error without OPFS, never IndexedDB. §8.4 host loop
      lives in the worker (`autoSync` + jitter). Bun tests run the real
      worker entry in a bun Worker (bun:sqlite injected) against a real
      HTTP+WS server; demo panes run persistent worker cores (`demo-a`/
      `demo-b`, badge "sqlite-wasm (OPFS, worker)") with `?ephemeral` as
      the labeled in-memory mode.
- [x] **WebSocket-native sync loop**: LANDED 2026-07-03 (Direction
      decision 1) — SPEC §8.7: the realtime channel is a second full
      transport binding of the sync handler. Binary WS messages carry a
      1-byte channel tag (0x00 = standalone delta, 0x01 = round
      byte-stream chunk — attribution is stateless, closing the
      delta-vs-response race no interleave rule can); rounds are
      self-delimiting SSP2 byte streams (chunk boundaries arbitrary, END
      is the terminator), one round in flight per connection (pipelining
      MAY drop the connection; reference server closes it), server send
      buffering bounded (§1.4 anti-goal; bulk rides segments on HTTP),
      and the round's subscription list REPLACES the connection's
      registrations at round end — the connect-before-first-pull silent
      no-fanout footgun is structurally dead (connect-then-sync is the
      reference boot order). §4.7/§8.1 replace-ambiguity resolved in
      windowing's favor (omission = unregistration; partial pulls legal
      only for never-synced subs). RealtimeSession drives the SAME
      createSyncResponseStream; TS + Rust clients ride the socket
      whenever connected (transport seam unchanged for loopback/HTTP
      hosts — hosts of the seam, not a fallback pair); conformance B.11
      (4 scenarios, both pairings); demo syncs over the socket (zero
      POST /sync from the browser). No wire-vector changes (the tag is
      transport-binding framing, outside SSP2 messages).
- [x] **Signed-URL client path**: LANDED 2026-07-03 — both clients
      advertise accept bit 3 when their downloader/transport exposes a
      direct URL fetch (TS: `SegmentDownloader.fetchUrl`; Rust:
      `Transport::fetch_url` + `supports_url_fetch`, shim-bridged), and
      §5.4 is pinned hard: a url-carrying descriptor MUST be fetched
      from the URL with NO host credentials (the URL is the entire
      grant), never fetched at/past `urlExpiresAtMs`, and any failure
      (expiry/loss/tamper) invalidates the descriptor — recovery is
      re-pull, never a fall-through to the direct endpoint. Conformance
      B.12 (4 scenarios, both pairings) covers issue→fetch→verify on
      both lanes, expiry, tamper/loss, and bit-3 gating on the native
      HMAC path; delegated presign stays pinned by the packages/server
      S3-stub tests (§5.4 equivalence — client-indistinguishable).
- [x] **Perf budgets in CI**: LANDED 2026-07-03 — `bench:ci` mode with
      documented budgets (rows/sec floor 90k, propagation p95 ≤ 20 ms,
      own JS ≤ 60 KB raw, total ≤ 600 KB gzip) as a `bench-budgets` job
      in `v2.yml`; RESULTS.md stays the curated local record.

## 2. Parity ladder (one at a time, spec'd before built)

- [x] **Blobs / file attachments**: LANDED 2026-07-03 — the first
      parity-ladder rung, spec-first. SPEC §5.9 pins it end to end: a new
      `blob_ref` column type (§2.4 tag 7) carrying a canonical BlobRef JSON
      doc (`blobId` = sha256 content address, `byteLength`, optional
      `mediaType`/`name`) — codec-shaped identically to `json`, so SSG2 /
      commits / push carry it with ZERO new codec branch and NO
      vector regeneration. Blobs are durable content-addressed objects in a
      `BlobStore` (memory + sqlite + the S3 backend reused from segments),
      NOT in the pull stream. Upload `PUT <mount>/blobs/{blobId}` verifies
      the content address (reject `blob.hash_mismatch`), download
      `GET <mount>/blobs/{blobId}` re-authorizes on EVERY request against
      the rows that reference the blob (§5.9.5 authz rule — a blobId is
      never a capability; `blob.forbidden` when no referencing row is held),
      backed by a commit→blob reference index (§5.9.4, additive to storage).
      A push referencing an absent blob fails loud with `blob.not_found`
      (§6.6). Client cache is content-addressed + refcounted by live rows
      (DESIGN-eviction B1–B4): upload-before-push keyed off the outbox,
      revocation deletes now-unauthorized bodies (evicted ≠ revoked), cache
      hit avoids re-download. Four new `blob.*` codes (§10.2, no longer
      reserved). Both clients (TS `uploadBlob`/`fetchBlob` on SyncClient +
      worker RPC; Rust via a `Transport` blob extension + shim), typegen
      (`BLOB_REF` → `blob_ref` through manifest→IR→emitter; irVersion NOT
      bumped — additive enum value, structure unchanged). Conformance B.13
      (4 scenarios: upload→reference→push→other-client-fetch + cache-hit;
      push-missing-blob-fails-loud; cross-scope-fetch-denied;
      revocation-purges-cache-refs — both pairings, 52×2). Demo: attach a
      file to a todo (📎 per row, worker + ephemeral cores, `/blobs`
      endpoints).
- [x] **CRDT fields**: LANDED 2026-07-03 — the second parity-ladder rung,
      spec-first. SPEC §5.10 pins it end to end: a new `crdt` column type
      (§2.4 tag 8) carrying opaque server-merged bytes, codec-shaped
      identically to `bytes` (rides the `bytes` machinery — ZERO new codec
      branch, existing vectors byte-identical). The hybrid-consistency pillar
      is the pinned §6.2 interaction (§5.10.3): `crdt` columns are EXCLUDED
      from `baseVersion` conflict detection and MERGE (stored ⊕ incoming) on
      every clean apply; `baseVersion` still governs the row's non-crdt
      columns and its single `server_version`. Crdt-only edits push
      baseVersion-less (LWW mode) so they never conflict however stale;
      a non-crdt conflict rolls back atomically (no half-merge) with the
      merged crdt state surfaced in the conflict `serverRow`. Idempotent
      replay is doubly safe (idempotency-key `cached` + merger idempotency).
      Update-vs-state DECISION: clients push UPDATES, server merges
      (smaller wire, thin/portable client) — §5.10.4. Merger pluggability
      (§5.10.2): the server core takes a `CrdtMerger` registry
      (crdtType → merge); core/server stay Yjs-free — the reference
      `yjs-doc` merger + the `YjsColumn` client helper ship in a new
      `@syncular-v2/crdt-yjs` package (Yjs enters the tree ONLY there).
      Rust client round-trips crdt bytes byte-for-byte (merging is
      server-side; native `yrs` integration noted as a follow-up, §5.10.5).
      One new code `sync.crdt_merge_failed` (§10.2). Typegen: `CRDT` SQL
      keyword → crdt column with `crdtType` `yjs-doc` through
      manifest→IR→emitter (TS emits `Uint8Array`; irVersion NOT bumped —
      additive). Two NEW golden vectors (`segment/crdt-column`,
      `response/commit-crdt-merge`); existing vectors untouched. Conformance
      B.14 (3 scenarios: concurrent-convergence-both-orders +
      no-conflict-on-crdt; conflict-with-merged-crdt; offline-replay-
      idempotent — both pairings, Rust pushes TS-generated fixture Yjs
      bytes). Demo: SKIPPED this rung (a collaborative note field would need
      worker-RPC + Y.Doc wiring across the OPFS worker boundary — not
      trivially cheap; deferred to avoid bloating the diff).
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
- [ ] **Ops posture**: events seam + pruning guidance LANDED 2026-07-03 —
      `SyncularServerEvents` on the server config (12 typed JSON-able
      events across request/push/pull/segment/realtime/prune/resolver;
      fire-and-forget, zero-cost when unset, ctx-clock timing),
      `consoleJsonEvents()` reference sink, demo wiring behind
      `SYNCULAR_DEMO_EVENTS=1`, horizon/pruning runbook in
      packages/server/README.md. Still open: load-test suite ported to
      v2 lanes.

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
- [x] Segment compression posture: DECIDED + LANDED 2026-07-03 — SPEC
      §5.8. Direct endpoint compresses BOTH formats per Accept-Encoding
      (zstd preferred, gzip fallback; hono adapter via the zero-dep
      `encodeSegmentBody` helper) on measured data at 100k rows: rows
      6.2×/8 ms zstd (7.7×/42 ms gzip), sqlite images 3.4×/14 ms zstd
      (51 ms gzip), decompress ≤ 8 ms — the image lane keeps its
      latency win. Signed-URL/S3 objects stay uncompressed at rest
      (content address = stored bytes; edge compression is deployment,
      MUST NOT double-compress); inline/WS segments ride §1.3 transport
      compression unchanged. Ids still hash uncompressed bytes (§5.1);
      clients rely on native fetch decoding — zero new client code.
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
