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
    snippet adapted from apps/demo; TODO marker for the
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
