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
- [x] **App-developer test kit**: `@syncular-v2/testing` — `createTestSync
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

- [ ] **yrs native CRDT** — *trigger: any native app renders or edits a
      `crdt` column* (until then native cannot even display crdt text —
      a silent functional hole, not polish). ~1 agent-day; yrs is
      Yjs-wire-compatible, feature-gated, no wire changes.
- [ ] **W2 TTL sugar** (codegen creation-time bucket columns + window
      helpers) — *trigger: first real windowing app's feedback on bucket
      granularity*. W1 already does time-windowing manually.
- [ ] **Presigned blob upload** (direct-to-storage; server exits the
      upload bandwidth path) — *trigger: upload volume at scale*.
      Resumable = provider multipart behind this flow (never our own
      chunk protocol — non-goal).
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

- [ ] **Package naming** — `@syncular-v2/*` are placeholders; rename is
      mechanical (one constants module + workspace-wide find/replace).
- [ ] **Publishing pipeline** — changesets + trusted publishing for the
      final names, carrying the v1 artifact-guard lessons (parse-validate
      everything a pipeline builds; no platform-skipped smokes).
- [ ] **Sunset remainder** — delete `v1/` from disk when ready; execute
      the registry deprecations (incl. the broken-WASM 0.1.x artifacts).
- [ ] **Gate decision + push** — the evidence is in `bench/RESULTS.md`
      and `STATUS.md`; the local commit stack ships when pushed.
- [ ] **File the two bun issues** — the v1 worker-delivery draft
      (`.context/`), and the worker+sqlite native corruption (repro
      documented in ROADMAP block 4; the test retry-once drops out when
      fixed upstream).
