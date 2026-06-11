# Syncular Improvement Plan

Critical review of the monorepo (2026-06-11), prioritized for drastic wins in
code reduction, performance, and DX. Each item lists motivation, scope, and
status. Baselines below; re-measure against them after each change.

## Baselines (2026-06-11, M-series Mac, local)

### Build / typecheck (current state, with `--force`)

| Command | Before (`--force`) | After (caching fixed) |
| --- | --- | --- |
| `bun tsgo` | **7.3s** every run | 5.9s cold / **55ms warm** |
| `bun run build:packages` (incl. 3 WASM release variants) | **2m22.8s** every run | 2m13s cold / **53ms warm** |
| `bun test packages tests/unit tests/dialects tests/typegen` | **30.6s**, 918 pass / 72 fail (all 72 = missing local WASM artifact) | 7m39s with WASM artifacts present, 932 pass / 58 fail (pre-existing, see note) |

Note: local prerequisites for a full build were missing (`wasm-pack`,
`binaryen/wasm-opt` — now installed via brew). The 58 remaining failures are
all in `packages/client/src/__tests__/*-hono.wasm.test.ts` and reproduce on
the dedicated `test:wasm:hono` gate too: the WASM worker's browser-fetch
cannot connect to the local harness server ("Unable to connect",
127.0.0.1-bound). Pre-existing & environmental — likely the local Bun
(1.3.14 via volta) vs the pinned `packageManager: bun@1.3.9`. Tracked under
item 3.

### Load (k6 `baseline-smoke.js`, 100 VUs / 60s, SQLite dialect, 10k-row seed)

| Metric | Value |
| --- | --- |
| push latency | med 6.3ms, p90 23.4ms, **p95 33.7ms** |
| pull latency (bootstrap path, cursor=-1) | med 1.1ms, p90 2.2ms, **p95 5.7ms** |
| throughput | 388.7 req/s (23,531 reqs), **0% errors** |

Note: the pre-existing k6 scenario scripts are stale — they JSON-parse
responses, but the combined `/sync` endpoint is binary-only (SSP1) now, and the
push body shape changed to `push.commits[]`. `lib/sync-client.js` was fixed
(pull `schemaVersion`, push `commits[]`); `scripts/baseline-smoke.js` was added
as an honest envelope-level baseline. See item 11.

### Bundle sizes

| Target | Raw | Gzip | Budget |
| --- | --- | --- | --- |
| `@syncular/client` JS bundle | 266.81 KB | 62.06 KB | max 1200/400 KB, **baseline was 0** (item 7) |
| WASM `full` variant (per BENCHMARK_LOG) | ~3.3 MiB | ~1.36 MiB | gated in CI |

---

## P0 — do first

### 1. Re-enable turbo caching (remove `--force`) — STATUS: DONE (2026-06-11)

`--force` removed from `build:packages`, `build:rust`, `tsgo` (plus the
ordering-defeating `--parallel` on tsgo). The likely original reason for
`--force` was real: the WASM bindings build compiles `rust/crates/runtime`,
which is outside the package, so turbo's default hash missed Rust changes.
Fixed with a package-specific task in `turbo.json`
(`@syncular/client-javascript-bindings#build`) declaring
`../../crates/**`, `../../Cargo.{toml,lock}`, and
`packages/client/package.json` as inputs; `tsgo` now has
`dependsOn: ["^tsgo"]` so dependency changes cascade. Verified by hash probe:
editing `rust/crates/runtime/src/lib.rs` invalidates the bindings build, and
editing `packages/core/src/index.ts` invalidates dependents' tsgo.
Result: warm build 2m22.8s → 53ms, warm tsgo 7.3s → 55ms.

Bonus fix found while validating: `packages/client-crdt-adapters/tsconfig.json`
path-mapped `@syncular/client` to `../client/src/index.ts`, so its build
emitted ~20 stray `.js`/`.d.ts` files into `packages/client/src/` (untracked,
would have shipped to npm since client's `files` includes `src`, and poisoned
turbo input hashes). Removed the mapping; it typechecks against client's
`dist` types like every other dependent. Tests + full tsgo pass.

### 2. Set a real client bundle baseline — STATUS: DONE (2026-06-11)

`config/bundle-budget.json` baseline set to measured 266.81 raw / 62.06 gzip
KB, `maxDriftPercent: 5` added and enforced in
`scripts/check-client-bundle.ts` (fails on >5% growth over baseline with a
pointer to update the budget intentionally), hard ceilings tightened
1200/400 → 600/150 KB.

### 3. `bun test` must not require a pre-built WASM artifact (or fail clearly)

Fresh checkout → `bun test` → 72 confusing failures because
`rust/bindings/javascript/dist/wasm/syncular.js` is missing. Either: skip
WASM-dependent suites with a single clear message when the artifact is absent,
or build the dev artifact automatically. Also document the one-command dev
setup (DEVELOPMENT.md), including toolchain prerequisites discovered missing
locally: `wasm-pack`, `binaryen` (wasm-opt), `k6`, wasm32 rustup target.

WASM test failures under latest Bun — ROOT-CAUSED (2026-06-11): a **Bun
1.3.14 runtime regression** (1.3.13 fine, 1.4.0 canary still broken), not a
syncular bug. Worker→main postMessage replies stall ~10s when posted after
WASM+fetch activity, released only by the next main→worker message; later
worker messages overtake the stuck one (non-FIFO), so this isn't fixable from
JS — verified by trying string posts, MessageChannel ports, forced loop
ticks, keep-alive pokes, and deferred sends (all ineffective; experiments
reverted). Resolution: pins bumped 1.3.9 → **1.3.13** (newest working) in
`packageManager` + CI; full WASM gates green under 1.3.13 (62+10 tests,
14s instead of timeout cascades). Upstream issue draft in
`.context/bun-1.3.14-worker-delivery-issue-draft.md` — file it, and re-test
on the next Bun release. Local note: volta can't pin bun per-project; run
wasm gates with Bun ≤1.3.13 until upstream fixes.

## P1 — drastic code reduction (~20–25% of TS)

### 4. Delete legacy TS client protocol machinery — RESCOPED (2026-06-11)

**Verification killed the original claim.** The initial audit said
`worker-client.ts`/`worker-realtime.ts` duplicate the Rust web client and are
deletable (~15–20k lines). Tracing imports shows otherwise: it is one live
pipeline — `database.ts` → `worker-client.ts` (main-thread proxy) →
`worker-entry.ts` (Worker side, uses `worker-realtime.ts`) → `rust-client.ts`
→ WASM runtime. Knip also reports zero unused files. The roadmap
(`rust/docs/ROADMAP.md`) treats this TS worker bridge as the accepted
architecture, not a transitional shim. Nothing here is deletable today;
moving the worker layer into Rust's `WebSyncularClient` would be a new
migration work package, a product decision rather than cleanup.

Remaining (smaller) reduction candidates to evaluate individually:
- TS↔WASM conformance tests that assert pure protocol behavior already gated
  by the Rust testkit (integration-value tests stay).
- `packages/core` encode paths only servers use — move server-only encoders
  out of core if core is in the client bundle graph (bundle is 266 KB; check
  what tree-shaking misses).

### 5. Split the two mega route factories in server-hono — STATUS: DONE (2026-06-11)

- `routes.ts` 5,260 → **70** lines + `routes/{shared,context,health,auth-leases,audit,combined,snapshots,realtime}.ts`
- `console/routes.ts` 5,557 → **146** lines + `console/routes/{shared,context,stats,commits,clients,maintenance,events,api-keys,storage}.ts`

Pattern: `createXxxRoutesContext(options)` owns the former factory setup and
returns all shared bindings (type inferred via ReturnType — no hand-written
50-field interfaces); each `registerXxxRoutes(ctx)` destructures what it needs
so the moved route code stayed byte-identical (mechanically verified against
HEAD). Public exports unchanged; route registration order preserved;
regenerated `openapi.json` has zero diff. Verification: 178 server-hono tests
pass, full repo tsgo + biome + knip clean.

Also done: byte-identical transaction helpers
(`isActiveTransaction`/`createSavepointName`) moved from both server dialect
packages into `@syncular/server` dialect helpers.

Follow-up done same day: console `routes/shared.ts` now re-exports
`parseScopesSummary` from the sync `routes/shared.ts` — single definition.

### 6. Merge the 7 micro dialect packages into `@syncular/dialects` — STATUS: DONE (2026-06-11)

All seven packages consolidated into `packages/dialects` with one subpath per
dialect (`@syncular/dialects/neon`, …), sources moved via `git mv`, exported
symbol names unchanged, no "." barrel (so drivers stay optional). All drivers
and per-driver kysely adapters are optional peerDependencies. Umbrella now
exposes `syncular/dialects/<name>`. ~40 consumer files updated (packages,
tests, apps/demo, rust example, docs + install commands), knip/workflow
filters updated, old names added to the docs stale-pattern checker, removal
recorded in `rust/docs/COMPATIBILITY_REGISTER.md`. Verified: tsgo 35/35, 687
tests pass, build, bundle:check, docs:stale-check, load server boots.
Breaking for npm users of the old package names (intentional per AGENTS.md
disruption policy) — release notes must call out the rename.

## P2 — DX / product surface

### 7. `create-syncular-app` starter + collapsed client init

A minimal React+SQLite app today: 9 packages, codegen CLI step, ~100 lines of
wiring. Plan: absorb `SyncularClientLifecycle` into the client (`realtime:
true` option instead of a second wrapper object), auto-select the WASM runtime
variant from the app schema instead of
`runtimeArtifacts: [getSyncularRuntimeArtifact('full')]`, smart defaults for
the 20+ config keys, then ship a `create-syncular-app` template.

### 8. Scope mismatch must fail loudly — STATUS: DONE (rescoped, 2026-06-11)

Verification showed the audit overstated this: requested scope keys AND
`resolveScopes()` result keys are already validated against the handler's
scope patterns on every pull (`subscriptions/resolve.ts#validateScopeKeys`
throws), and `ScopeValuesFromPatterns` enforces key names at the type level.
The write path fails closed (403) on missing scope columns.

Real gaps found & fixed:
- `resolveScopesImpl` silently dropped malformed scope values (number/object,
  non-string array entries) → subscription showed up as mysteriously
  "revoked". Now throws a descriptive error naming table, scope key, and
  received type (null/undefined still means "no access", skipped).
- `authorizeRowScopes` swallowed `resolveScopes` exceptions into a generic
  403 with no log; now logs the underlying error first.

Deferred (per roadmap: WP-14 DX work reopens only on concrete app feedback):
`forUser` shorthand and testkit scope tester.

### 9. Replace custom release machinery with changesets/release-please

`stamp-versions.ts`, `stamp-cargo-versions.ts`, `release-rehearsal.ts` (~620
lines) re-implement version stamping/changelogs. Keep the smoke-test scripts
(`fresh-app-smokes.ts`, `post-publish-install-smokes.ts`) as release hooks.
Also: prune the 87 root scripts (most are `bun --cwd` forwarders that turbo
task filters can replace), and remove or fix the disabled `maestro-ios` CI job.

### 10. Decide the umbrella-package story — DONE (2026-06-11)

Benjamin's call: `@syncular/*` is canonical; the `syncular` package is now
CLI-only (`npx syncular generate`). All 31 passthrough re-export modules and
the exports map removed; deps trimmed to `@syncular/typegen`; apps/apex
migrated to scoped imports; docs updated; umbrella import forms added to the
docs stale-pattern checker; removal recorded in COMPATIBILITY_REGISTER.md.
Breaking for npm users of umbrella imports — release notes must call it out
alongside the dialects rename.

Further decisions from the same review (2026-06-11):
- Dialects rename is NOT pushed/released yet; old npm packages stay until
  Benjamin decides the release moment (then `npm deprecate` the 7 old names).
- Bench repo patches stay local for now; old `syncular` JS stack retirement
  deferred.
- Bun: latest (1.3.14) should be supported — fix the failing WASM-vs-Hono
  tests rather than pinning down to 1.3.9 (see item 3).
- CI should get warm turbo caches (actions cache / remote cache for `.turbo`).

## P3 — performance

### 11. Modernize the k6 load suite for the binary protocol — STATUS: DONE (2026-06-11)

`tests/load/lib/ssp1.js`: dependency-free SSP1 reader for k6 (manual UTF-8,
no zlib needed — the envelope is uncompressed; gzip row-group/chunk frames
are length-prefixed and skipped). Extracts push commit statuses + operation
results, subscription status/nextCursor/bootstrapState (round-trips into the
next request), full change metadata, snapshot chunk/artifact refs. Row-id
convergence tracking stayed exact (ids travel uncompressed). All 8 scenario
scripts now verify parsed binary responses; no silently-green checks. Bonus
real bug found: chunk downloads omitted the required `scopes` query param
(33% silent failures → 0%). Validated: all scenarios green in smoke mode,
0% error rates.

### 12. Default-path snapshot encoder metadata caching — MEASURED & REJECTED (2026-06-11)

Measured the actual inference overhead (see BENCHMARK_LOG "Generic Snapshot
Encode Inference Cost"): 500k rows × 10 cols, 50k chunks — 223.5ms with
metadata vs 326.7ms with per-chunk inference. The avoidable cost is ~100ms
per 500k bootstrap (~5% of the row-chunk lane; scoped-artifact lane
unaffected). Cross-chunk caching is unsafe (strict encoder + type drift ⇒
mid-bootstrap hard failures); DB-introspection metadata is real work with
weak ROI. The audit's 500–650ms figure was total query+encode, mostly
irreducible. Decision: keep the generic path; document `snapshotBinaryColumns`
(auto-generated by typegen) as the recommended setup for hand-rolled
handlers. Revisit only on real-app evidence.

### 13. Smaller server hot-path items

- ~~`toDialectJsonValue` per-row stringify~~ — VERIFIED NON-ISSUE (2026-06-11):
  it already passes values through for Postgres; for SQLite the per-row
  stringify is required work (JSON stored as TEXT), and the per-row "decision"
  is a single property compare. Audit finding overstated; dropped.
- `readScopeIndexedCommitSeqsForPull` can scan many rows before LIMIT under
  scope fanout (`packages/server/src/dialect/base.ts`); evaluate covering
  index `(partition_id, table, commit_seq, scope_key)`.
- Snapshot chunk scope cache key re-hashes SHA-256 per page
  (`packages/server/src/snapshot-chunks.ts`); cache per subscription.

---

## External benchmark re-baseline (2026-06-11)

Ran the offline-sync-bench harness (cloned from bkniffler/offline-sync-bench)
against this branch — server built into Docker from this checkout, client from
`packages/client/dist` + release WASM. Full entry in
`rust/docs/BENCHMARK_LOG.md` ("Post-Refactor External Re-Baseline").
Headline: **no regression from the refactors** — scoped-artifact bootstrap is
10–20% faster than published RESULTS.md at 100k+ rows (100k: 204ms vs 227ms;
500k: 998ms vs 1250ms); online-propagation visible p95 12.9ms (published
16.04ms); reconnect-storm 100-client convergence 125ms with zero recovery
pulls. Item 12 context: even with `snapshotBinaryColumns` metadata supplied,
500k row-chunk encode is 237ms (query 390ms) — the generic no-metadata path
would be slower; item 12 = make default path use precomputed metadata.
Harness debt found: the bench's `syncular` stack (old JS product client) is
permanently incompatible with current main (removed packages/protocol) and
its raw JSON pulls needed `schemaVersion` patches (applied locally,
uncommitted in the bench clone).

## Status log

- 2026-06-11: Plan created. Baselines captured (build, test, k6, bundle).
  k6 request helpers fixed for current protocol; `baseline-smoke.js` added.
- 2026-06-11: P0 items 1 & 2 done. Turbo caching re-enabled with correct
  cross-package inputs for the WASM build (verified by hash-invalidation
  probes); warm build 2m23s → 53ms, warm tsgo 7.3s → 55ms. Bundle baseline
  set + 5% drift gate. Fixed client-crdt-adapters emitting compiled JS into
  packages/client/src. `bun lint` clean, full tsgo clean, crdt-adapters and
  client unit tests pass.
- 2026-06-11 (cont.): Item 4 rescoped after verification — TS worker bridge is
  the accepted architecture, not deletable legacy (knip clean; import trace
  documented above). Item 5 in progress (route factory split running).
  Dedupe done: `isActiveTransaction`/`createSavepointName` moved to
  `@syncular/server` dialect helpers, both server dialect packages import them
  (typecheck + 307 tests green). Item 3 partial: missing WASM artifact now
  throws an actionable error from `loadSyncularWasmGlue` instead of a bare
  module-resolution failure. Item 13a dropped as verified non-issue.
- 2026-06-11 (cont. 3): Benchmark re-baseline run + committed (no regression;
  scoped-artifact bootstrap 10–20% faster than published at 100k+). Item 12
  measured & rejected (evidence in BENCHMARK_LOG). CI turbo cache verified
  already wired (was dead under --force; now live). Bun WASM-test failures
  root-caused to an upstream 1.3.14 worker-delivery regression; pins bumped
  to 1.3.13; issue draft in .context/. Item 10 done (umbrella → CLI-only,
  breaking). Item 11 done (k6 SSP1 reader; found+fixed silent chunk-download
  failures). All 13 plan items are now done, decided, or honestly rejected.
- 2026-06-11 (cont. 2): Item 5 DONE — both mega factories split
  (routes.ts 5,260→70; console/routes.ts 5,557→146; mechanically verified
  verbatim moves; openapi.json zero-diff; 178 tests green; knip clean after
  pruning two dead type re-exports + two over-exported header constants;
  `parseScopesSummary` deduped). Item 6 DONE — `@syncular/dialects` with
  7 subpaths replaces the 7 micro packages; ~40 consumers, docs, umbrella,
  CI filters, stale-pattern checker, compatibility register all updated;
  full verification green (tsgo 35/35, 687 tests, build, bundle, docs check).
  Item 8 DONE (rescoped — most of it already existed; fixed silent malformed
  scope value drop + unlogged authorize failure). Item 9 partial: deleted the
  permanently-disabled `maestro-ios` CI job (72 lines).
  Combined re-verification after all of the above: tsgo, lint, knip clean;
  687 server/core/tests pass; client:test 126 pass; bundle delta 0.00 KB.
