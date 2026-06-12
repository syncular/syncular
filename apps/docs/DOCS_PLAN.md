# Docs restructure plan

From the 2026-06-11 documentation audit (full audit in the session that
produced this file; summary below). Owner verdict: docs are "not great";
restructure + rewrite so users can easily dive into all parts.

## Diagnosis (top problems, ranked)

1. No working end-to-end quickstart — every entry page defers to another.
2. Scopes/auth taught three times (learn/, server/, features/) with no canon.
3. Blobs/CRDT/presence/encryption each documented in 2–3 places.
4. Reference pages are auto-generated stubs without narrative.
5. Conflict resolution split across learn/ and features/ with no reading order.
6. Landing → quickstart trajectory broken ("run the framework tests" ≠ hello world).
7. Client config (15+ tuning options) entirely undocumented.
8. Operations/observability/troubleshooting disconnected; no production checklist.
9. Missing: migrations depth, local read models, undo/redo patterns, auth
   leases, realtime reliability.
10. No error catalog, no protocol docs, no upgrade guide.

## Target information architecture

START HERE (what-is / is-it-for-me / hello-world / pick-your-path /
installation / compare) → CORE CONCEPTS (sync model, scopes, subscriptions,
conflicts, bootstrap, commits, glossary) → BUILD: JAVASCRIPT → BUILD: RUST →
BUILD: SERVER → FEATURES (one canonical page per capability + recipes) →
TEST AND DEPLOY (testing, deployment, observability, scale, console,
troubleshooting tree) → REFERENCE (config reference, HTTP API by feature,
CLI, error codes, protocol, upgrade guide).

Full per-page tree and per-phase details live in the audit output; phases:

- Phase 1 — Foundation: hello-world (uses create-syncular-app), is-it-for-me,
  canonical scopes page, conflict rewrite, nav restructure of start/.
  Delete start/basic-setup, merge start/fresh-apps.
- Phase 2 — Client guides: client-configuration reference (all options),
  quick-start rewrite, generated-client expansion, host-integration preambles,
  JS + Rust troubleshooting pages.
- Phase 3 — Server: split setup-with-hono into linear getting-started +
  per-topic pages (table handlers w/ worked examples, authorization canon,
  bootstrap/snapshots, push/conflicts, realtime, blobs, deployment targets,
  troubleshooting).
- Phase 4 — Features: consolidate conflict/encryption/realtime+presence/
  CRDT/blobs to one canonical page each; expand migrations, read models,
  auth leases, undo/redo, audit; flesh out the four recipes end-to-end.
- Phase 5 — Test & deploy: testing strategy layers, deployment (Docker/CF/
  Fly/VPS), observability (metrics to watch), scale/tuning, console section
  consolidation, symptom→diagnosis troubleshooting tree.
- Phase 6 — Reference: configuration reference (client+server+CLI), HTTP API
  grouped by feature with error shapes, error-code catalog, protocol page,
  upgrade guide.

## Constraints

- Keep `bun run docs:stale-check` green; extend its patterns when retiring
  pages so old paths/names can't resurface.
- Hello-world must use the real current APIs (binary protocol era,
  @syncular/dialects subpaths, scoped packages — never umbrella imports) and
  reference `create-syncular-app` once it exists.
- Every moved page needs its old URL redirected or the nav updated — check
  how apps/docs handles redirects before deleting paths.

## Status

- 2026-06-11: Audit done, plan recorded. Execution pending (after demo app
  rebuild + create-syncular-app land, since hello-world builds on them).
- 2026-06-11: **Phase 1 done.** Decisions taken:
  - **Redirects:** apps/docs supports Next.js `redirects()` in
    `next.config.mjs`; retired slugs get permanent redirects there
    (`/start/adoption-paths` and `/start/fresh-apps` →
    `/start/pick-your-path`, `/start/good-fit` → `/start/is-syncular-for-me`,
    `/start/basic-setup` → `/start/installation`). Stale patterns added in
    `scripts/check-docs-stale-patterns.ts` so the old paths can't resurface
    in content.
  - **New pages:** `start/is-syncular-for-me` (decision guide; absorbs
    `good-fit`), `start/pick-your-path` (merges `adoption-paths` +
    `fresh-apps` into fresh/existing/evaluate paths),
    `start/hello-world` (placeholder framing + real minimal end-to-end
    snippet adapted from apps/demo; work item marker for the
    create-syncular-app one-liner).
  - **Deleted:** `start/basic-setup` (URL convention folded into
    `start/installation`, corrected: `config.baseUrl` points at the sync
    mount itself, e.g. `https://host/api/sync` — matches apps/demo and
    client tests).
  - **Nav:** start/ reordered learner-first (what-is → is-it-for-me →
    hello-world → pick-your-path → installation). `quick-start` kept in nav
    pending its Phase 2 rewrite; `testing-and-confidence` kept under
    Evaluate Fit (pick-your-path's "evaluate first" path links to it).
  - **Scopes canon:** `learn/scopes` is the conceptual canon (now includes
    the client-subscription request side; deep `authenticate()` wiring
    removed in favor of a link). `server/scopes-and-auth` is
    implementation-only and links to the canon.
  - **Conflicts canon:** `learn/conflict-resolution` is the mechanism canon
    (React banner/`useConflictStats` UI moved to
    `features/conflict-resolution`, which keeps the product flow and links
    back).
  - Phase 1 hello-world ships without create-syncular-app (it hasn't landed);
    the page is honest about that and already useful.
- 2026-06-12: **Phase 3 done** (server section). Decisions taken:
  - **New pages:** `server/getting-started` (linear bring-up: install →
    Postgres or sqlite quick path → user-owned tasks handler modeled on
    apps/demo → `createSyncServer` mount → first sync via curl with the
    current combined `POST /` protocol — pull carries `schemaVersion`,
    push carries idempotent `commits[]`), `server/troubleshooting`
    (handler not called, unexpectedly-revoked subscriptions incl. the new
    fail-loud resolveScopes/scope-key errors, snapshot timeouts, stalled
    cursors, 413 byte-limit defaults).
  - **Retired:** `server/setup-with-hono` → redirect to
    `/server/getting-started` in next.config.mjs + stale pattern in
    scripts/check-docs-stale-patterns.ts; all content-tree links rewritten.
    Notable: the old page documented separate `/push` and `/pull` endpoints
    that no longer exist — the docs now describe the combined `POST /` route.
  - **Expanded:** `server/table-handlers` (worked examples: user-owned,
    multi-scope membership, codecs; deletes are hard deletes — soft delete
    documented as an app-level tombstone pattern since create-handler has no
    built-in option; applyOperation result/error-shape table with the real
    codes; fail-loud resolveScopes; write-path scope authorization semantics
    — all declared scope keys required, `'*'` wildcard).
  - **Renamed nav titles, slugs kept:** scopes-and-auth → "Authorization"
    (added requested-vs-resolved scope-key validation, revocation triggers,
    wildcard + scopeCache notes from subscriptions/resolve.ts; fixed a wrong
    `status: 'rejected'` op-result example to the real `error` shape),
    snapshot-pull → "Bootstrap & Snapshots" (chunking/caching mechanics,
    binary-table-v1 chunks, snapshotBinaryColumns guidance — typegen wires it,
    hand-rolled handlers should supply it to skip per-page column inference;
    snapshot artifacts), apply-push → "Push & Conflicts" (batch request/
    response shape with applied/cached/rejected commit statuses, atomic
    rollback on rejection, conflict detection via base_version with the real
    snake_case conflict payload, emitted-changes rules, limits).
  - **meta.json:** Getting Started / Core / Realtime & Blobs / Integration /
    Deployment / Advanced / Troubleshooting; server/index cards regrouped to
    match.
- 2026-06-12: **Phase 2 done** (client guides). Decisions taken:
  - **New pages:** `clients/javascript/client-configuration` (full
    `CreateSyncularDatabaseOptions` + `SyncularClientConfig` reference; all
    defaults verified against `packages/client/src` and
    `rust/crates/runtime/src/core/limits.rs` /
    `rust/crates/runtime/src/web/client.rs`; three worked tuning scenarios)
    and `clients/javascript/troubleshooting` (symptom→cause→fix grounded in
    `@syncular/core` error codes and `packages/client/src/errors.ts` /
    `wasm-runtime.ts`).
  - **Rewritten:** `start/quick-start` now leads with
    `bunx create-syncular-app` and tours the scaffolded layout
    (migrations → syncular.app.ts → generate → server → client), linking to
    hello-world for the manual walkthrough instead of duplicating it. The
    "run the framework tests" framing is gone.
  - **Expanded:** `clients/javascript/generated-client` (generate pipeline:
    typegen handoff → Rust `syncular-codegen` binary with auto-install,
    generated outputs incl. server module / codegen.json / schema.json,
    when to regenerate, three-layer version handling).
  - **Nav:** `clients/javascript` and `clients/rust` meta.json reordered to
    Getting Started / Core APIs / Host Integration / Advanced Features /
    Testing / Troubleshooting; index pages' card sections mirror it. JS index
    gained the one-runtime/host-bridge architecture preamble; Rust index got
    the embed-direct equivalent.
  - **Deferred:** Rust `client-configuration` + `troubleshooting` mirrors —
    the native Rust config surface (`NativeClientConfig`,
    `NativeSyncularClientBuilder`, transport/worker options) differs enough
    from the JS worker surface that grounding it needs its own pass over
    `rust/crates/runtime/src/native/facade.rs`; revisit alongside the
    Phase 6 config reference. The Electron host page already existed, so no
    new host page was needed.
  - **Found in code:** the doc comments on `SyncularPushOptions` in
    `packages/client/src/types.ts` say adaptive batching tops out at 100,
    but the Rust runtime default (`DEFAULT_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT`)
    is 1000 — the new docs follow the Rust ground truth; the TS comment
    should be fixed.
