# REVISE.md — v2 architecture plan

Written 2026-07-02 after the post-0.1.3 review; strategy decided with
Benjamin the same day. This supersedes the incremental-refactor draft and is
the successor to `IMPROVEMENT_PLAN.md` (complete). It encodes one thesis and
one strategy decision.

**Thesis.** Syncular's *design* — scope-based authorization, a
server-authoritative commit log with an optimistic outbox, precomputed
snapshot artifacts, hybrid consistency with opt-in CRDT — is validated and
better than the competition's (benchmarks in `rust/docs/BENCHMARK_LOG.md`).
Where the project bleeds effort is *infrastructure entropy*: the
one-Rust-binary-everywhere bridge, an implicit protocol, socket-coupled test
infra, and toolchain taxes on JS users. v2 keeps ~90% of the design and
spends the budget on boring-ness.

**Strategy decision (2026-07-02).** v2 is built in a **clean tree at
`v2/`** in this repo — not by incremental refactor of the live packages.
Rationale: the project is an alpha with ~no installed base, so the real
assets are the *semantics*, the *test scenarios*, and the *benchmark
harness* — all of which transfer to a clean tree, while the baggage
(worker-bridge plumbing, Bun pin, 37-option config surface, socket-coupled
tests) does not. A walking skeleton proves the risky bets in weeks; a
compatible in-place migration would have to be bug-compatible with the full
0.1.x surface from day one. 0.1.3 stays shipped and untouched as the
fallback.

**Destination, one line:** two cores, one written protocol — a TypeScript
core for web (small, debuggable, no cargo in the JS toolchain), the existing
Rust core for native, parity guaranteed by a conformance suite over a spec'd
wire protocol instead of by sharing a binary.

---

## Rules of the v2 tree (non-negotiable)

1. **Spec-first.** The first artifact is `v2/SPEC.md` + golden vectors. The
   POC implements the spec; the spec is never reverse-engineered from the
   POC. This is also the one chance to *simplify the protocol itself* while
   the knowledge is fresh (candidates listed in SPEC.md).
2. **Copy contracts and tests, never implementations.** Port scenario
   definitions (offline replay, convergence, idempotent retry, scope
   revocation), golden semantics, and the benchmark harness. The old tree is
   read-only reference. The moment implementation files get pasted "to save
   time," the baggage walks in with them.
3. **Brutal skeleton scope.** Milestones B1–B6 below. Everything else —
   blobs, CRDT, encryption, auth leases, presence, console, native — is a
   named non-goal until the skeleton passes its gate, then enters one at a
   time against the spec.
4. **A written kill/merge gate** (below), decided on evidence by a date, not
   by drift.
5. **Old tree = maintenance mode** while the skeleton is in flight: Track A
   fixes only (it is what users install today). No feature or structural
   work lands in `packages/` or `rust/`.
6. **Own toolchain.** `v2/` is its own workspace root: own lockfile, latest
   Bun (no 1.3.9 pin — no WASM worker bridge, so the pin's reason vanishes),
   own biome/tsconfig, excluded from all root gates. CI runs it via
   `.github/workflows/v2.yml` on `v2/**` paths only.
7. **Timebox tripwire.** If the skeleton is not syncing two clients within
   ~2 weeks of agent-time, stop and reassess — that is the second-system
   alarm, and "while we're here, let's redo X properly" is the failure mode
   this rule exists to catch.

---

## Track A — old tree stabilization (parallel, ~2 days, still mandatory)

0.1.x is what people install today; it must stay green and honest while v2
grows. No new features.

1. Fix the testkit barrel regression from `ce9c5724`
   (react-native/tauri tests import `createClientBridgeHarness` from the
   slimmed root barrel; fix `e8500d4b` sits on `bkniffler/wp50-dx-health` —
   reconcile that branch first).
2. Regenerate the todo-app Swift codegen fixture (hardcodes crate 0.1.1 vs
   0.1.3) AND wire fixture regeneration into `bun run version` /
   `scripts/sync-versions.ts` so bumps stop breaking `rust-native`
   (third occurrence).
3. Registry repair (needs npm login): deprecate the uninstallable
   `workspace:*` 0.1.0 artifacts per-version; rewrite the 7 legacy
   `@syncular/dialect-*` deprecation messages (they point at the 404'd
   `@syncular/dialects` — correct target `@syncular/server/<driver>`);
   deprecate `@syncular/ui` and `@syncular/cli`.
4. Give the WASM integration fixtures (`packages/client/src/__tests__`)
   at least one CI job again (coverage exclusion + browser-wasm glob
   currently leave them running nowhere).
5. Vendored SQLite hygiene: prune the never-enabled `sqlite3mc`
   amalgamation (~382k lines), add a re-vendor script, document that
   `[patch.crates-io]` does not reach published-crate consumers.
6. Truth-pass stale plan docs (IMPROVEMENT_PLAN round-2 statuses; the
   `installation.mdx` codegen version pin) and file the Bun worker issue
   from `.context/` (the 1.3.9 pin has no exit without it).
7. Roadmap pruning: archive WP-25, WP-33, WP-13 follow-ups (feedback-gated
   placeholders); WP-49 and WP-32 are re-homed to v2's post-gate ladder.

**Exit:** Checks green on main, docs redeployed, registry clean, version
bumps rehearsed safely.

---

## Track B — the v2 walking skeleton

### B0. Scaffold (done with this commit)
`v2/` workspace root (own lockfile/toolchain, latest Bun), `v2/README.md`
(rules of the tree), `v2/SPEC.md` skeleton, CI workflow on `v2/**`.

### B1. Protocol spec + golden vectors (the constitution)
Normative `v2/SPEC.md`: wire format (envelope, sections, compression
framing, explicit versioning) and semantics (commit/cursor model,
idempotency via `clientCommitId`, scope request∩resolve intersection and
revocation, bootstrap phases + artifact/chunk resolution, `base_version`
conflicts, realtime delta + catch-up, offline-write replay). Extract from
SSP1 (`packages/core/src/sync-packs.ts`, wire v14) and take the listed
simplifications deliberately. Committed golden vectors (binary + JSON
rendering) generated fresh, cross-checked against the old TS encoder where
formats coincide. A dev-only canonical JSON debug rendering is part of the
spec (non-contractual — the lesson of silently-broken tooling).

### B2. Server core: an embeddable protocol library
`handleSyncRequest(bytes, ctx) → bytes` (+ websocket equivalent) with
storage / auth / blob-store as interfaces — framework-free. `resolveScopes`
runs in the host process (the moat: sync lives inside the user's backend
next to their auth). SQLite storage first (dev-speed), Postgres second.
Snapshot segments are the *default* bootstrap path, not opt-in. Hono
adapter as a ~50-line wrapper proves the boundary.

Performance-by-construction (v1 evidence in parentheses):
- **Scope-fanout indexes designed into the storage schema** — a
  commit→scope inverted index from day one (v1's
  `readScopeIndexedCommitSeqsForPull` could scan wide before LIMIT; the
  covering-index fix was never retrofitted).
- **Streaming encode, no full-response buffering**; server memory stays
  flat during large bootstraps (v1 sat at 295–400MB avg) — memory is a
  bench metric, not a hope.
- **Signed-URL segment delivery**: content-addressed segments servable from
  R2/S3/CDN via short-lived signed URLs, direct-proxy as fallback — the
  bootstrap-storm answer; server egress for cold starts approaches zero.
- **Multi-instance fanout** via Postgres LISTEN/NOTIFY spec'd as a
  primitive, not a bolted-on broadcaster interface.

### B3. Web client core: TypeScript on sqlite-wasm
`@sqlite.org/sqlite-wasm` + OPFS. Worker-*optional* by design (main-thread
mode for simple apps; worker mode behind a bridge surface capped at ~10
message types). Outbox, cursor tracking, bootstrap-from-segment, apply,
conflict surfacing. Local SQL (Kysely) is the query API — that promise is
unchanged.

Architectural upgrades over v1:
- **Multi-tab is first-class**: one core per origin via Web Locks leader
  election (SharedWorker where available), other tabs are followers over
  BroadcastChannel — one sync loop, one websocket, one DB, N tabs. (v1's
  OPFS-sahpool exclusivity made multi-tab awkward: per-tab clients and DB
  files. No competitor does this cleanly either.)
- **SQLite-image bootstrap**: importing a prebuilt scoped DB image is near
  file-copy speed in sqlite-wasm — the headline bootstrap path (v1's
  artifact lane already proved 204ms vs 467ms at 100k).
- **Apply-path discipline**: one transaction per pack, prepared statements,
  columnar decode straight into bind params; streaming apply overlaps
  network and SQLite writes (v1 decoded whole packs — 2.07s sequential
  wall at 500k row-chunks).
- **Reconnect coalescing**: catch-up prefers segments over row pulls, with
  jittered wake coalescing (WP-32's ~2s tail at 250+ clients was
  client-side contention; server fanout was 13ms).
- **Perf budgets in CI from day one**: apply-rate (rows/sec), bootstrap
  micro-bench, and bundle size regress loudly in `v2.yml` — the TS-core
  bet lives or dies on these numbers, so they are not discovered at the
  gate.

### B4. Conformance runner + test doctrine
Implementation-agnostic scenario definitions ported from
`packages/testkit` + `rust/crates/testkit` conformance gates, executed
against any (client, server) pairing via a driver interface. **Loopback
in-memory transport for 99% of tests** (deterministic, runtime-agnostic);
fault injection at the transport interface; real-socket tests few and
quarantined. Readiness waits, never sleeps. This doctrine is day-one law in
v2, not a retrofit.

### B5. Codegen: TypeScript, IR-based (minimal slice)
SQL migrations + one manifest → neutral schema IR (JSON) → TS emitter, just
enough for the skeleton's typed client + server codecs. `npx` -runnable
with zero non-JS toolchain. Swift/Kotlin emitters consume the same IR later
(post-gate); design the IR now so hooks (WP-49's apply/read-model
extensions) are designed once.

### B6. POC proof
Two-browser convergence demo (port of the current two-pane demo's essence),
offline-replay with idempotent retry, and a benchmark spot-check on the
offline-sync-bench harness (bootstrap 1k/100k, online propagation) against
the 0.1.3 numbers.

### The gate (kill or merge — written criteria)
Evaluate when B6 lands or at the timebox, whichever first:

- Conformance: all ported skeleton-scope scenarios green on
  (TS client × TS server).
- Perf: 100k bootstrap within ~2× of 0.1.3's 204ms artifact-lane number;
  online propagation p95 in the same order of magnitude.
- Size: web client bundle + sqlite-wasm ≤ ~1MB total (vs 3.3MB WASM today).
- DX: fresh clone → `cd v2 && bun install && bun test` green in one step,
  latest Bun, no cargo.

**Pass →** v2 becomes mainline: the perf rungs land first, then the parity
ladder (ordering revised 2026-07-03, see Direction decisions below):
performance rungs (sqlite-image segments → worker+OPFS mode → signed-URL
client path) → blobs → CRDT fields → auth leases → presence/realtime
hardening → console event stream; each spec'd before built. The Rust core
re-enters as the *native* runtime via the conformance suite, old tree
enters sunset (0.1.x patches only, migration guide, then archive).
Post-parity differentiators (named now, built on demand): **windowed sync /
local eviction** (TTL cold rows out of the local DB while they stay
server-side — none of the benchmarked competitors do partial local
retention well; spec the eviction/cursor semantics EARLY, before the ladder
builds on top) and **fine-grained live-query invalidation** (design-time
rule: live queries invalidate by table/scope-key touched per commit, never
re-run-everything — decided before React bindings exist, not retrofitted).
**Fail →** v2 folds: keep the spec, vectors, conformance runner, and test
doctrine (independently valuable, portable back to the old tree), write up
why, return to the old tree with Phases 1–2 of the original incremental
plan.

---

## Direction decisions (2026-07-03, confirmed by Benjamin)

Decided after the gate data landed, while the skeleton is still cheap to
steer. The theme: **no fallbacks** — one good path per concern, a support
floor instead of a degradation ladder, and no subsystem whose only job is
to paper over a platform we shouldn't target.

1. **WebSocket-native sync loop, no HTTP fallback.** The client has exactly
   one sync loop: sync rounds, deltas and wake-ups as SSP2 bytes over the
   socket. No polling mode, no degraded loop, ever. `POST /sync` remains as
   a second *framing* of the same `handleSyncRequest(bytes)` — for
   push-only producers, curl debugging and server-to-server integration —
   but clients never touch it and it adds zero protocol surface. Segments
   stay on HTTP by design: that is the CDN/signed-URL bulk path, not a
   fallback.
2. **One persistent browser mode: whole core in a worker on OPFS
   (`opfs-sahpool` VFS).** SAHPool needs no COOP/COEP and no
   SharedArrayBuffer and is the fast OPFS variant. The entire client (core
   + socket + SQLite) runs in the worker; the UI thread gets a thin RPC
   (query/mutate/subscribe/status — well under the 10-message cap).
   In-memory sqlite-wasm stays only as an *explicit* ephemeral mode
   (tests/demos/SSR). **Never IndexedDB.** Browsers without OPFS are
   explicitly unsupported (support floor ~2023+), failing loud — not a
   fallback ladder. (Supersedes B3's "main-thread mode for simple apps"
   wording: main-thread = ephemeral only.)
3. **No client-side migration engine.** On a schema bump: keep the outbox
   (already schema-agnostic by design), wipe local tables, re-bootstrap,
   replay. Bootstrap-from-segment is fast enough that the migration
   subsystem is not worth carrying, and every upgrade exercises the
   bootstrap path instead of a rarely-run migration path. The server keeps
   N-version codec support for transition windows (it needs that anyway).
4. **sqlite-image segments are the first post-gate perf rung** — ahead of
   blobs. v1's 204 ms artifact lane won because bootstrap was "attach a
   SQLite file," not "insert 100k rows"; v2's 360 ms rows lane is the
   proof of headroom. Signed-URL client advertising (accept bit 3)
   lands with it: bootstrap storms at ~zero server egress.

Size-gate re-scope, same date: the ≤~1 MB criterion applies to
**syncular's own client JS** (measured 42 KB raw / 13 KB gzip vs v1's
218 KB); stock-SQLite vendor bytes (wasm + glue) are reported for context
but do not gate — the same way Rust binary size doesn't.

---

## Sequencing at a glance

| # | Item | Effort | Depends on |
|---|------|--------|------------|
| A | Old-tree stabilization | ~2 days | — (parallel) |
| B0 | v2 scaffold | done | — |
| B1 | SPEC + vectors | ~1 wk | B0 |
| B2 | TS server core | ~1 wk | B1 |
| B3 | TS web client core | ~1–2 wk | B1 (parallel w/ B2) |
| B4 | Conformance + doctrine | ~3–4 days | B1 (grows with B2/B3) |
| B5 | Codegen minimal slice | ~3–4 days | B1 IR |
| B6 | POC demo + bench | ~2–3 days | B2+B3+B4 |
| — | **Gate decision** | — | B6 or timebox |

Total to gate: roughly 2–4 weeks of agent-time. Tripwire at 2 weeks without
two-client sync.

## Risks

- **Second-system effect** → rules 3 and 7 (scope + tripwire), and the gate
  has a fail path that still banks value.
- **Two-core drift (post-gate)** → conformance-in-CI for every runtime is
  the merge precondition, not an aspiration.
- **Old tree rots while v2 grows** → Track A first, maintenance-mode policy,
  and the gate deadline keeps the split short.
- **Spec becomes shelfware** → vectors + conformance are CI-blocking in v2
  from B1 onward.

## Status log

- 2026-07-02: Strategy decided (clean `v2/` tree over incremental refactor).
  Plan rewritten; B0 scaffold landing with this commit. Next actions:
  Track A item 1–2 (old tree, reconcile `wp50-dx-health` first) and B1
  (spec extraction) in parallel.
- 2026-07-02 (later): Track A complete (first green main + Deploy in a
  month). Old tree subsequently **frozen entirely** per Benjamin — no
  repairs, no patch releases (the broken-WASM 0.1.x artifacts stay as-is;
  fix + changeset sit on main unreleased).
- 2026-07-03: **B1–B6 all complete**, plus the Rust POC Benjamin pulled
  forward from post-gate: a clean-room Rust codec (written from SPEC.md
  alone) passed all golden vectors on its first run, and a clean-room Rust
  client passes the full 35-scenario conformance catalog against the TS
  server — the two-cores-one-written-protocol thesis is *proven*, not
  promised. Cross-implementation audit found and resolved 4 vector-unpinned
  codec divergences (31 vector cases now). Gate self-assessment: all four
  criteria PASS (conformance 319 tests / 35×2 pairings; perf 359–383 ms @
  100k vs 408 ms line; size 42 KB own JS vs 218 KB line after the
  ownership re-scope; DX one-step). Direction decisions above confirmed.
  Remaining work to "done" tracked in `v2/TODO.md`. **Gate decision
  (kill/merge) is Benjamin's call; everything is committed locally,
  unpushed.** Known open spec question: SSG2 segments carry no
  server_version (client rule §5.6 covers it; a version column is the
  alternative — decide before the Rust core implements segments... which
  it now has, conformantly, so a change means new vectors).
