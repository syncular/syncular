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

## 1. In flight (wave 1, launched 2026-07-05)

- [ ] **Live-query churn hardening** (replaces per-rowid invalidation):
      result stability in the shared hook machinery (identical result →
      zero re-render; changed result → per-row identity reuse so memo'd
      rows skip), frame-coalesced re-query scheduling (N invalidations
      per frame → 1 re-run), scope-key skip wired through the existing
      `scopeKeys` option. Caps both render and query cost under constant
      sync churn.
- [ ] **S3/R2 blob byte storage + orphan-GC sweep**: closes the
      "attachments are SQLite-only" deployment gap. `S3BlobStore` reusing
      the segment SigV4/presign/CAS machinery (blobs are DURABLE — no
      TTL; reference-driven lifecycle), presigned blob *download* behind
      the 5.9.5 row-derived authz, `sweepOrphanBlobs` helper + runbook
      (grace period covers the upload-before-reference window).
- [ ] **CREATE INDEX in the migration subset**: apps can't declare
      indexes for their own query load today — the most consequential
      untracked gap once data outgrows toy size. Parser + IR + local DDL
      on both cores (+ the named-query check DB); server-side per the
      storage-layout reality (verify how user tables materialize there).

## 2. Wave 2 (approved, launches as wave 1 lands)

- [ ] **Server-side write-validation hooks**: per-table validate on push
      for business rules beyond scopes ("title ≤ 200 chars"), rejecting
      with a host-defined code; the IR `extensions` slot was reserved for
      exactly this. Spec-first (§6 gains the hook semantics).
- [ ] **App-developer test kit**: an exported `@…/testing` package —
      in-memory server, N clients, virtual clock, offline/fault toggles —
      mostly re-exporting what the conformance harness already has.
      A differentiator almost no local-first competitor offers.
- [ ] **Node ClientDatabase**: better-sqlite3 adapter behind the existing
      `ClientDatabase` interface, so Electron-main and plain-Node hosts
      have a SQLite backend.
- [ ] **Docs site deploy**: the 15 pages build locally; nothing hosts
      them. Needed by launch.

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
