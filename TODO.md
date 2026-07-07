# TODO — the working feature list

The actionable successor to the completed v2 TODO (see git history) and
the 2026-07-05 gap sweep. Strategy, landing notes, and **non-goals** live
in `ROADMAP.md` (do not resurrect a non-goal without new evidence).

Standing rules, unchanged: spec-first where wire behavior is involved,
judgment calls codified back into SPEC.md, no fallback paths, and every
landing keeps `bun run check`, `bench:ci`, cargo, and the Rust
conformance pairing green. Do not commit or push without Benjamin's
standing arrangements (local commits by the orchestrator after
verification; push is Benjamin's alone).

## 1. Wave 1 — LANDED 2026-07-05 (ef6b9d2d churn, fc78c5d7 index, + S3 blobs)

- [x] **Live-query churn hardening** (replaces per-rowid invalidation):
      result stability in the shared hook machinery (identical result →
      zero re-render; changed result → per-row identity reuse so memo'd
      rows skip), frame-coalesced re-query scheduling (N invalidations
      per frame → 1 re-run), scope-key skip wired through the existing
      `scopeKeys` option. Caps both render and query cost under constant
      sync churn.
- [x] **S3/R2 blob byte storage + orphan-GC sweep**: closes the
      "attachments are SQLite-only" deployment gap. `S3BlobStore` reusing
      the segment SigV4/presign/CAS machinery (blobs are DURABLE — no
      TTL; reference-driven lifecycle), presigned blob *download* behind
      the 5.9.5 row-derived authz, `sweepOrphanBlobs` helper + runbook
      (grace period covers the upload-before-reference window).
- [x] **CREATE INDEX in the migration subset**: apps can't declare
      indexes for their own query load today — the most consequential
      untracked gap once data outgrows toy size. Parser + IR + local DDL
      on both cores (+ the named-query check DB); server-side per the
      storage-layout reality (verify how user tables materialize there).

## 2. Wave 2 (approved, launches as wave 1 lands)

- [x] **Server-side write-validation hooks** (LANDED 2026-07-05): per-table
      `validators` on the server config — a host callback run after decode +
      §3.4 scope authz, INSIDE the commit transaction, per operation; a throw
      rejects the whole commit atomically (§6.4) with a host-defined code the
      client surfaces unchanged (§6.3), proven on both cores. SPEC §6.7 pins
      the semantics: decode → scope authz → validation → write order; CRDT
      columns see the MERGED value (§5.10.3), not the raw update; host codes
      MUST NOT start with `sync.`/`blob.`/`presence.`/`client.` (checked at
      `ValidationRejection` construction — a reserved prefix is a loud server
      bug); a non-`ValidationRejection` throw maps to `sync.constraint_violation`;
      feature off ⇒ zero cost. Reuses `push.rejected` (no new event). The IR
      `extensions` slot stays the noted home for future declarative validation
      metadata — runtime hook only this rung, no codegen wiring. Four
      conformance scenarios (reject-rolls-back-atomically with the host code on
      both cores, accept-applies-and-converges, off-is-unchanged,
      sees-stored-row-on-update) + 11 server unit tests (incl. the load-bearing
      merged-CRDT-value assertion). Gates green.
- [x] **App-developer test kit**: `@syncular/testkit` — `createTestSync
      ({schema})` → in-memory `@…/server` + N real `SyncClient`s on
      bun:sqlite through the loopback seam (no HTTP), per-client
      `goOffline()/goOnline()`, transport faults (the conformance
      `TransportFaults` controller re-exported via a new additive
      `@…/conformance/faults` subpath, never duplicated), a shared virtual
      clock, `syncAll()`, and `dispose()`. React helper `syncWrapper` behind
      `@…/testing/react` (react an optional peer). README doubles as docs.
      App-facing (no driver/pairing machinery). A differentiator almost no
      local-first competitor offers.
- [x] **Node ClientDatabase**: better-sqlite3 adapter behind the existing
      `ClientDatabase` interface, so Electron-main and plain-Node hosts
      have a SQLite backend. `@…/web-client/node` → `openNodeDatabase`,
      better-sqlite3 as an OPTIONAL peer (installs clean without it, errors
      helpfully when missing). bun CANNOT dlopen better-sqlite3
      (oven-sh/bun#4290) so real behavior is proven under Node
      (`web-client verify:node`) against the SAME contract the bun test
      runs on the reference bun:sqlite adapter.
- [x] **Docs site deploy**: `.github/workflows/docs.yml` builds apps/docs
      and publishes dist/ to GitHub Pages (upload-pages-artifact +
      deploy-pages), push-to-main + `apps/docs/**` path-gated. One-time
      Settings→Pages→"GitHub Actions" source setting documented in
      apps/docs/README (NOT auto-enabled); custom-domain / CF-Pages swap
      noted there too.

## 3. Demand-gated — build when the trigger fires

- [x] **yrs native CRDT** (LANDED 2026-07-05, Benjamin's order "make sure yjs
      is working WITH NATIVE"): `yrs` behind the client crate's `crdt-yjs`
      feature (dependency-lean default; on for FFI/Tauri examples). Four router
      commands — `crdtText` (materialize), `crdtInsertText`/`crdtDeleteText`
      (edit → full-state update → baseVersion-less mutate, the §5.10.4
      push-update model), `crdtApplyUpdate` (escape hatch) — so shim, FFI, and
      the Tauri plugin inherit them through the shared `dispatch`. Typed
      conveniences on all five wrappers (Swift/Kotlin/Dart/Tauri-JS/RN-JS).
      Cross-core proof: `crdt/native-authored-convergence` has the RUST core
      (yrs) AUTHOR edits and the TS server merge them (and vice versa) —
      byte-identical convergence both directions; both pairings green. yrs is
      Yjs-wire-compatible, so no wire changes. Docs: `concepts-crdt.md` +
      wrapper READMEs.
- [ ] **W2 TTL sugar** (codegen creation-time bucket columns + window
      helpers) — *trigger: first real windowing app's feedback on bucket
      granularity*. W1 already does time-windowing manually.
- [x] **Presigned blob upload** (direct-to-storage; server exits the
      upload bandwidth path) — *trigger fired by Benjamin 2026-07-05; LANDED*.
      `POST /blobs/{blobId}/upload-grant` (host-authed, size-capped up front)
      mints a single presigned PUT (`S3BlobStore.presignBlobPut` +
      `s3PresignedBlobUploads` / `blobUploadUrls` config); the client PUTs
      direct-to-storage with no host auth, then pushes the referencing row (the
      §5.9.6 existence check verifies via `has`). Capability, not fallback: no
      presign config ⇒ the client streams through the direct `PUT` endpoint.
      Single PUT only — resumable = provider multipart behind this same grant
      (never our own chunk protocol — non-goal, held). Both cores +
      conformance (grant→PUT→reference→fetch). SPEC §5.9.3 pins the grant flow,
      the host-auth-only authz, and the reference-time integrity story.
      **Also landed same round** (Benjamin's blob-story order): presigned
      *download* consumption on both cores (client fetches the §5.9.5 url
      directly, always-issue; failure⇒re-request recovery pinned in §5.9.5),
      and the client-side blob storage model (SQLite `BLOB` bytes + configurable
      `blobCacheMaxBytes` cap with LRU eviction of zero-ref/non-pinned bodies,
      §5.9.7 B1). Gates green; both pairings 86/84.
- [ ] **Named-query `-- returns` override** for computed-expression
      typing — *trigger: first user hits the nullable-affinity fallback
      in anger*.
- [ ] **Conflict-resolution sugar** — `resolveConflict(keep:
      server|local|merged)` codifying the rebase pattern — *trigger:
      first app writing this by hand twice*.
- [ ] **Observability example sink** (OTel-shaped, over the events seam)
      and **auth integration guides** (Clerk/Auth.js worked examples,
      docs-only) — *trigger: first adopter questions; cheap, high
      adoption value*.
- [ ] **Client devtools** (local DB / outbox / rounds / invalidation
      introspection surface + docs) — *trigger: first debugging session
      that hurts*.
- [ ] **FTS5 local search** — needs virtual-table support in a
      "migration subset v2" — *trigger: first search-shaped app*.
- [ ] **Undo/redo docs recipe** (pattern over `mutate()`, NOT core API —
      see non-goals) — *at the next docs pass*.
- [ ] **Safari/Firefox support-floor verification** (human hands) and a
      **scheduled `load:smoke` run** (nightly candidate) — *pre-launch*.
- [ ] **RN Android CI lane** — *blocked on publishing* (`workspace:*`
      unresolvable by npm until packages publish); recipe documented in
      the RN example README.
- [ ] **iOS/Android release artifacts** (xcframework / AAR) — *needs
      full Xcode / cargo-ndk*; build-native.sh detects and skips today.

## 4. Benjamin-gated (decisions, not builds)

- [x] **Package naming** — DONE (2026-07-05, Benjamin's call): every `-v2`
      name killed. Final identity is `@syncular/*` + the unscoped scaffolder
      `create-syncular-app`. The typegen CLI bin is `syncular`; the workspace
      root is `syncular`. Directory names left as-is (churn without benefit).
      Executed through the one constants module + a workspace-wide sed; the
      lockfile and every typegen output were regenerated, not hand-edited.
- [ ] **Publishing pipeline** — changesets + trusted publishing for the
      final names, carrying the v1 artifact-guard lessons (parse-validate
      everything a pipeline builds; no platform-skipped smokes).
      **REUSED v1 npm names** (trusted publishing already exists — no reserve
      needed): `@syncular/core`, `@syncular/server`, `@syncular/client`,
      `@syncular/typegen`, `@syncular/testkit`, `create-syncular-app`.
      **NEW names** (need a one-time reserve before first publish):
      `@syncular/react`, `@syncular/kysely`, `@syncular/crdt-yjs`,
      `@syncular/server-hono`, `@syncular/server-workers`, `@syncular/tauri`,
      `@syncular/react-native`.
- [ ] **Sunset remainder** — `v1/` deleted from disk (2026-07-07, Benjamin's
      call; full history stays in git). Remaining: execute the registry
      deprecations (incl. the broken-WASM 0.1.x artifacts).
- [ ] **Gate decision + push** — the evidence is in `bench/RESULTS.md`;
      the local commit stack ships when pushed.
- [ ] **File the two bun issues** — the v1 worker-delivery draft
      (`.context/`), and the worker+sqlite native corruption (repro
      documented in ROADMAP block 4; the test retry-once drops out when
      fixed upstream).
