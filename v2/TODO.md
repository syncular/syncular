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
- [x] **Auth leases** (v1's `sync.auth_lease_*` family): LANDED 2026-07-03 —
      the third parity-ladder rung, spec-first. SPEC §7.3 pins the lease
      **lifecycle** (issuance/refresh/expiry/revocation) end to end. A lease
      is a server-issued, host-signed, time-bounded grant recording the
      actor's resolved scopes at issuance
      (`{leaseId, actorId, allowedScopes, issuedAtMs, expiresAtMs}`) —
      **opaque to the client** (non-goals: client crypto verification,
      cross-device transfer, per-scope TTLs). Wire carriage: a NEW response
      frame `LEASE` (0x19, immediately after RESP_HEADER; §9 new-data =
      new-frame, never a RESP_HEADER field), carrying only
      `leaseId`/`expiresAtMs` — a feature-off client skips it by length.
      Enforcement seam: `resolveScopes` stays source-of-truth; the host opts
      a request into lease authorization by returning a new `RESOLVER_OUTAGE`
      sentinel (a signal, distinct from a throw which still fail-loud
      revokes) — the server then authorizes the round against the stored
      lease's `allowedScopes` for its validity window (the lease IS the
      authorization, not a fallback path). Server: an optional `LeaseStore`
      (memory + sqlite, the blob-store pattern) behind a `leases: {ttlMs}`
      config (absent = off, zero cost); sliding refresh on every authorized
      round (stable `leaseId`); `lease.issued`/`lease.revoked` events.
      Codes: TWO kept with real producers — `sync.auth_lease_required`
      (outage without a valid lease) and `sync.auth_lease_revoked` (revoked
      handle); the OTHER FIVE of v1's seven PRUNED per the no-producer rule
      (§10.3: `invalid`/`scope_mismatch` — no client token / no per-op
      grants; `schema_mismatch` — the schema floor covers it; `missing` —
      folded into `required`; `business_rejected` — no plugin surface),
      staying reserved. Both clients persist the opaque lease and expose
      `leaseState` (`leaseId`/`expiresAtMs`/`errorCode`, `leaseRemainingMs`)
      — the schemaFloor mirror; lease codes are stop-and-surface, never a
      silent retry, and NEVER purge local data (§7.3.4, distinct from §3.3).
      One new golden vector (`response/lease-issued`); existing vectors
      byte-identical. Conformance B.15 (4 scenarios: issued/refreshed;
      outage-served-then-expired; revocation-invalidates-sync-not-data;
      feature-off-emits-nothing — both pairings, 59×Rust / 61×TS).
- [x] **Presence + realtime hardening**: LANDED 2026-07-03 — the last
      parity-ladder rung, spec-first. SPEC §8.6 promoted from reserved-stub to
      full normative text pinning presence end to end: **ephemeral,
      scope-keyed** (a client publishes a small host-shaped JSON *object* to a
      scope key it holds; never persisted, never in the log/pull/delta, lost on
      disconnect ⇒ leave). **Wire**: the reserved `presence` JSON event in both
      directions (§8.1 tolerate-unknown — a feature-off peer ignores it by event
      name, so NO wire-version bump; binary `0x20`–`0x2F` stay reserved). C→S
      `{scopeKey, doc|null}` (null = leave); S→C fanout `{scopeKey,
      kind:join|update|leave, actorId, clientId, doc, timestamp}` — a closed
      three-kind set, doc-present-iff-not-leave. **Identity = (actorId,
      clientId)** exposed only to scope-mates. **Authz rides the same
      registration** (§8.6.3): publish/receive require the key in the
      connection's effective scopes — no separate grant; an unheld-key publish
      is rejected loudly to the publisher with `presence.forbidden`, an over-cap
      doc with `presence.too_large` (default 16 KiB), both carried in a
      publisher-directed `presence` event's `error` field (client-runtime codes,
      NOT §10 wire codes — fail loud in-band, never a silent drop). Snapshot on
      register = a burst of joins (no distinct kind); a registration change
      (§8.7 round end / reconnect / §3.3 revoke) re-derives the grant (leave lost
      keys, snapshot gained keys). Server: a hub-level in-memory `PresenceRegistry`
      (per partition+scopeKey → connection docs), fanout to scope-mates only,
      leave-on-disconnect, an optional MAY-throttle latest-wins rate cap
      (`presenceMinIntervalMs`, off by default — observable: newest doc at a
      bounded rate, never stale/lost/errored); presence stays below the ops-event
      floor (catalog untouched). Both clients: `setPresence(scopeKey, doc|null)`
      + `presence(scopeKey)` peer list (TS `SyncClient` + `onPresence` callback +
      worker RPC `presence` method/event across the OPFS boundary; Rust
      `set_presence`/`presence` + `ControlMessage::Presence`/`PresenceKind` +
      shim `setPresence`/`presence` commands). Two new golden vectors
      (`realtime/presence-publish`, `realtime/presence-fanout`) + two invalid
      (unknown kind, scalar doc); existing vectors byte-identical. Conformance
      B.16 presence (4 scenarios: lifecycle incl. disconnect-implies-leave +
      snapshot; cross-scope privacy probe + forbidden; feature-off silence;
      survives-a-socket-round) and B.17 reconnect-storm (~20 sessions churn +
      converge, deterministic, no timers, no load harness) — both pairings,
      68×TS / 68×Rust. Part B hardening: §8.2/§8.3/§8.4 audited (wake coalescing,
      cursor-contiguity, jittered reconnect, oversize-`delta-too-large` all
      already pinned with a scenario); the small gaps closed were the presence
      rate cap (spec'd MAY-throttle) and the N-session reconnect-storm scenario.
      Gates: `bun run check` (583 pass), `bench:ci` all budgets green (own JS
      59.7/60.0 KB), Rust fmt/clippy/test clean, fresh shim + Rust pairing 68/68.
- [x] **Console / event stream**: LANDED 2026-07-03 — the leaner
      event-stream + queries approach won decisively (REVISE boring-ness +
      dependency-light rule): v1's full React console app is NOT ported.
      Adds ZERO wire protocol (SPEC.md untouched — this is host surface,
      documented in packages/server/README.md). A `SyncularAdmin` module in
      packages/server: a read-only, partition-scoped, JSON-able query surface
      over `ServerStorage` + an in-memory event ring — `listClients`
      (cursor/last-seen/subscriptions/active flag), `listCommits` (metadata,
      no payloads, table filter, resumable), `inspectRow` (version + scopes,
      payload not decoded), `scopeActivity` (recent commits per scope key via
      the §3.1 index), `horizonStatus` (horizon + retention floor + prune
      recommendation, §4.6 math), `segmentStats`/`blobStats`/`stats`. Backed
      by ADDITIVE optional storage methods (`listClientRecords`/
      `listCommitMetadata`/`scopeActivity`/`getRowScopes`) with BOTH Sqlite
      AND Postgres implementations (trivial SQL reuse; the shared
      `ServerStorage` contract exercises them on both backends) plus optional
      `SegmentStore.stats`/`BlobStore.stats` (memory+sqlite; `S3SegmentStore`
      omits `stats()` — a LIST would defeat its GET/HEAD-only design, flagged
      follow-up). `RingBufferEvents` (bounded, `query({type?,sinceMs?,limit})`)
      + `composeEvents(...sinks)` give the event stream with no infra
      dependency; a missing admin storage method fails LOUD (never a
      silently-empty console). HTTP: `createSyncularAdminRoutes(admin,{authorize})`
      in server-hono — a mountable Hono sub-app with a REQUIRED auth seam
      (the factory THROWS without a guard; no default-open admin, every
      endpoint incl. the page 401s on a falsy guard). JSON endpoints mirror
      the surface + `GET /admin/events` (ring query; SSE deliberately skipped
      — the ring is pull-only, polling is the right rung, noted follow-up).
      `GET /admin` serves a SINGLE static HTML page (zero framework, no build
      step, ~300 lines: fetch the JSON, render tables, 2 s auto-refresh) —
      the v2 answer to v1's console: 5% of the code, the 80% operator value.
      Demo mounts it behind `SYNCULAR_DEMO_ADMIN=1` (optional token guard).
      Tests: 26 (query surface via loopback) + 8 ring/compose + 14 admin
      routes (mount refusal, 401, page smoke, every endpoint) + the storage
      contract admin section on both backends. Gates: `bun run check`
      typecheck + my-territory lint clean; `bench:ci` all budgets green
      (admin unset in bench, zero regression); Rust pairing untouched (no
      SPEC/wire/conformance/rust edits). Docs-site console section is a
      flagged follow-up (apps/docs owned by the concurrent schema-bump round).

## 3. Client platform surface

- [ ] **React bindings + live queries**: `useSyncQuery`-class hooks with
      **fine-grained invalidation designed in from day one** (table/scope-key
      per commit — never re-run-everything; REVISE post-parity note is now a
      design-time rule). Kysely as the typed local query layer.
- [ ] **Multi-tab followers**: leader election via Web Locks exists as a
      seam; build the follower path (BroadcastChannel proxy to the leader's
      worker) — one socket, one DB, N tabs.
- [x] **Schema-bump flow** (Direction decision 3): LANDED 2026-07-03 —
      wipe-and-rebootstrap, outbox preserved and replayed; no client
      migration engine. SPEC §7.4 pins the client contract: a persisted
      **local schema-version marker** (`_syncular_meta`, §7.4.1); TWO
      triggers converging on one flow (§7.4.2) — boot-time generated-version
      change (marker ≠ generated schema) and the server `requiredSchemaVersion`
      floor (§1.6), where the floor STOPS and the app-update recreate fires the
      boot trigger (a live-round floor never resets — resetting while still
      generating old payloads only re-floors). The reset (§7.4.3) is a
      whole-database local reset EXCEPT outbox + clientId + leaseState:
      drop/recreate every synced table from the new schema, reset subscription
      sync-state keeping registrations, clear the floor stop state, rewrite the
      marker LAST (crash-idempotent). Outbox replays on top, encode-at-send
      under the new codec (§0); a commit referencing a dropped column can't
      re-encode and surfaces as a rejection with client-local
      `sync.outbox_incompatible` (§7.4.4, §10.3 — never a wire code) without
      wedging the queue. An `upgrading` client state (§7.4.5, the schemaFloor/
      leaseState mirror) + worker `upgrading` event signal the reset and its
      completion. Both clients (TS `SyncClient.upgrading` + boot detection in
      `start()`; Rust `recreate_with_schema` — the Rust core has no persistent
      restart, so recreation IS the boot). Driver interface gained additive
      `recreateWithSchema`/`upgrading` (+ `ScenarioContext.recreateClient`,
      `serverSchema` so seeds land at the server version). Conformance
      `schema-bump/*` (4 scenarios: local-bump wipe-rebootstrap-replay;
      floor-triggered convergence; dropped-column `sync.outbox_incompatible`;
      image-lane re-bootstrap — both pairings, 65×TS / 63×Rust). Docs
      guide-schema gains the full upgrade story. No wire-vector changes (the
      flow is entirely client-local; the marker and `upgrading` never cross the
      wire).
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
- [x] **Runtime adapters**: LANDED 2026-07-03 — the deployment matrix is
      pinned in packages/server/README.md. **Supported now**: Bun/Node via
      `@syncular-v2/server-hono` (HTTP + WS realtime, all storages);
      **Cloudflare Workers** via the new `@syncular-v2/server-workers`
      (`createWorkersFetchHandler` reusing the Workers-native hono routing —
      HTTP binding only) over the new `D1ServerStorage` (D1) + R2-as-S3
      segments/blobs. Workers **realtime is a designed-but-deferred Durable
      Object follow-up** (one DO per partition-shard hosting the RealtimeHub,
      WS hibernation, storage via D1, in-DO fan-out — the session/hub/storage
      pieces already exist and are runtime-neutral, so it's mechanical; shape
      sketched in both READMEs). **Explicitly NOT adapted**: raw Deno/edge-misc
      — policy: the core is runtime-neutral TS, adapters are shipped only where
      the conformance catalog runs (Bun/Node fully; Workers HTTP via the
      fetch-handler round-trips). **Relay does NOT return** (rationale in the
      README): v1's relay bridged self-hosted servers to managed realtime
      because v1 realtime was a separate subsystem; v2 realtime is the second
      binding of the same handler (§8.7), multi-instance is LISTEN/NOTIFY, and
      Workers is the DO design — every relay job is covered by a core binding or
      in-DB fanout. **Runtime-neutrality fixes** (core): SigV4 + all hashing
      moved to Web Crypto (was `node:crypto`, now async — the presign seam
      already accepted a Promise); base64/base64url moved to `btoa`/`atob`
      (was `Buffer`) in `signed-url`/`s3-segment-store`/the shared dialect; the
      sqlite-image builder is injected via `SyncServerConfig.sqliteImageBuilder`
      (Bun default via dynamic import so `bun:sqlite` is never a static dep of
      the pull path; Workers omits it → rows lane, a §5.3 support floor); the
      four Bun-only SQLite stores (`SqliteServerStorage`/`SqliteSegmentStore`/
      `SqliteBlobStore`/`SqliteLeaseStore`) split into their own modules so the
      neutral `segment-store`/`blob-store`/`lease-store` carry only interfaces +
      Memory stores. Enforced by `test/runtime-neutrality.test.ts` — a static
      import-graph scan from the neutral entries asserting no `bun:`/`node:`
      import and no `Bun.`/`Buffer` global in the reachable core.
      **`D1ServerStorage`**: executor-seam storage over the D1
      `prepare/bind/all/batch` API, sharing the SQLite DDL + value codecs with
      `SqliteServerStorage` via a new `sqlite-dialect.ts` (the sync/async split
      makes sharing *execution* ugly, so the two classes are a clean parallel
      implementation against the storage contract, sharing only the SQL text +
      codecs — decided + justified in the dialect header). D1 has no interactive
      transaction: reads autocommit, writes buffer + flush as one atomic
      `db.batch()` at commit (§6.4), with a read-your-own-writes overlay.
      Hermetic tests: a bun:sqlite-backed **D1 double** (documented fidelity
      limits: sync-under-the-hood, no replica lag, BLOB→ArrayBuffer normalized,
      no EXPLAIN lane) runs the full shared storage contract (45/45).
      **`packages/server-workers`**: the Workers entry + a `wrangler.toml`
      example + README; tests invoke the fetch handler directly with `Request`
      objects over the D1 double + memory stores — full push/pull/segment/blob
      round-trips through the Workers entry, bytes built with the reference
      codec (loopback over fetch), 5/5. Conformance ts-server-on-D1 driver
      variant SKIPPED (stretch): the driver's `SqliteServerStorage`/raw-SQL
      coupling would need conformance edits (out of territory); the
      fetch-handler round-trips are the bar. Gates green (below).
- [ ] **Segment store backends**: S3/R2 for production segment storage +
      the CDN delivery story end-to-end.
- [x] **Ops posture**: LANDED 2026-07-03 — events seam + pruning guidance
      (`SyncularServerEvents` on the server config, 12 typed JSON-able
      events across request/push/pull/segment/realtime/prune/resolver;
      fire-and-forget, zero-cost when unset, ctx-clock timing),
      `consoleJsonEvents()` reference sink, demo wiring behind
      `SYNCULAR_DEMO_EVENTS=1`, horizon/pruning runbook in
      packages/server/README.md — AND the **load-test suite ported to v2
      lanes** (`v2/load`, bun-only, zero new runtime deps; NOT in CI by
      default). A bun-native harness spawns ONE real server process (hono
      HTTP + WS on localhost, `bun:sqlite` default, `SYNCULAR_PG_URL` for
      Postgres) and N lightweight protocol-level virtual clients — encoded
      SSP2 rounds over the real wire via the reference codec, no full
      SyncClient per VU (the k6-VU equivalent at ~100× less overhead).
      Five scenarios port v1's k6 intent onto v2's stack: `push-pull`
      (steady mixed load, ops/s), `bootstrap-storm` (THE scale scenario —
      M clients bootstrap one seeded dataset at once; asserts §5.3 segment
      built-once/reused-M **via the events seam**), `reconnect-storm`
      (drop+reconnect over the §8.7 socket, catch-up timing),
      `maintenance-churn` (pushes racing prune cycles), `mixed-soak` (all
      interleaved, minutes-long, RSS watched). Each: config +
      pass/fail thresholds (p95 latencies, zero-protocol-error budget, RSS
      ceiling), machine-readable JSON + human summary line. Metrics with no
      external stack: client-side round histograms, server-side counters
      over `SyncularServerEvents` (durations, segment reuse, prune counts)
      polled from an internal `/__load/metrics` endpoint, RSS sampling.
      `bun run load <scenario>` + `--vus/--duration/--dataset`, `bun run
      load:smoke` (~30s all-scenario sweep). `load/README.md` documents
      scenarios/thresholds/derivations, the PG lane, and that this is
      stability/scale verification — NOT a benchmark (`bench/` owns
      comparative numbers). Kept OUT of the default `bun test` sweep (the
      smoke sweep is ~30s, over the ~10s CI budget; root `test` path-ignores
      `load/**`); only sub-second pure-logic unit tests run. Verified: all
      five smoke profiles green + a bootstrap-storm full profile (50 VU /
      100k) locally.

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
- [x] E2EE: RE-SCOPED 2026-07-03 — **waits for demand; not on the parity
      ladder.** v1 shipped it with little usage evidence, and v2's design
      keeps the door open without carrying the code: payloads are opaque
      bytes through the codec, so client-side encryption can arrive later
      as a column-level concern with zero wire changes. Constraints
      recorded so nothing forecloses it: scope columns MUST stay
      plaintext (server-side scope extraction, §3.1); `crdt` columns are
      incompatible with E2EE as designed (the server merges, §5.10) —
      E2EE'd collaborative text would need client-side merge, a
      different architecture; blobs are trivially E2EE-able client-side
      (opaque bytes, content address over ciphertext). Revisit when a
      real deployment asks.

## 6. Product & release

- [ ] **Docs site**: v2 docs from the spec outward (the spec is the
      reference; docs are the guide). Quickstart ≤ 5 minutes to two synced
      clients.
- [x] **Scaffolding**: LANDED 2026-07-03 — `@syncular-v2/create-app` (bin
      `create-syncular-v2`): `bun create syncular-v2 my-app` / `bunx
      create-syncular-v2 my-app`, prompts/flags for project name + template.
      TWO templates as real directories with dumb `__PROJECT_NAME__`
      substitution: `minimal` (server + terminal two-client convergence demo,
      copy-evolved from examples/quickstart) and `web` (Hono + WS + single-pane
      OPFS-worker browser todo app, slimmed from apps/demo — no conflict
      simulator, no blobs). Each template ships its own README, `.gitignore`
      (as `gitignore`; renamed on scaffold), `tsconfig.json`, and a smoke test.
      The templates THEMSELVES are tested in the v2 sweep (scaffold→
      generate --check→typecheck→app smoke, offline via a workspace-linked
      node_modules; full `bun install` tier behind SYNCULAR_TEMPLATE_INSTALL=1).
      All naming lives in one constants module (`src/constants.ts`) — TODO 6.3
      rename is mechanical. Local-vs-published deps: templates carry
      `workspace:*`, kept for `--local`/in-tree, else rewritten to
      PUBLISHED_DEPENDENCY_RANGE (still `workspace:*` today — packages
      unpublished, CLI warns loudly; one constant to flip on publish, TODO 6.3).
      Typegen CLI polish: `syncular-v2 init` (starter manifest+migration into an
      existing project), helpful missing-manifest/-migrations errors pointing at
      the docs + `init`, and `--watch` (Bun recursive fs.watch, debounced, skips
      its own output writes). Generate CONTRACT + README freshness rules intact.
      Docs: quickstart leads with `bun create …` (manual path kept as the
      explainer), landing page gains a scaffolder DX bullet.
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
