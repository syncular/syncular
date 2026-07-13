# RFC 0002 — Integration feedback: findings from a two-engine app integration

- **Status:** Implemented 2026-07-13. All thirteen items landed, with three
  scope notes: 2.2 was already satisfied at HEAD (the RFC observed the
  published 0.2.1); 1.2 is fully closed — `tauri-plugin-syncular 0.2.1` was
  published to crates.io the same day (plus crate metadata, versioned path
  deps, a RELEASE.md step, and the git/path recipes in the docs); 4.1
  landed as the
  "One codebase, web + desktop" guide, and its deferred half — the
  `--template tauri` scaffold — landed 2026-07-14 once the plugin was on
  crates.io (the scaffold's `src-tauri` depends on the registry release).
  2.1 additionally grew a
  SQL-representation coercion in mutation values (booleans as 0/1, bigint
  integers), because stripping `_sync_*` alone still left `SELECT *` rows
  poisoning the outbox at encode time.
- **Date:** 2026-07-13
- **Scope:** packaging (`exports` maps, crates.io), `packages/react`,
  `packages/web-client`, `packages/typegen`, `bindings/tauri`, docs site,
  `create-app`
- **Source:** a from-scratch integration into an external app (Diego
  `ui-poc`): schema → typegen → Bun server → browser worker engine (OPFS) →
  Tauri v2 native engine, against the published `0.2.1` packages, with the
  repo checkout available for the Rust plugin. Every item below was either
  hit directly during that integration or verified against source afterward.

## Summary

The integration verdict is strong: the quickstart works in five minutes, and
the same React tree ran over the OPFS worker client and the Tauri native
core with one ~60-line engine seam — on the first try. Typegen's
SQLite-as-correctness-authority, the zero-import generated module, and loud
precise errors all held up. The gaps are concentrated at the **edges**:
packaging conditions, docs/release drift, a handful of missing conveniences
that every integrator will re-derive, and undiscoverable flagship stories.
Thirteen items, ordered by impact within four groups. One bug found during
the integration (hidden-document rAF freeze in `packages/react`) was fixed
separately and is referenced, not re-proposed, here.

## 1. Packaging & compatibility

### 1.1 `browser`/`bun` exports conditions ship TypeScript source

`@syncular/client`, `@syncular/react` (and siblings) resolve the `browser`
and `bun` conditions to `./src/index.ts`. Vite-class bundlers transpile
node_modules TS happily; webpack/Next.js/Metro default configs fail with
"Module parse failed" on the first import. It also means consumers compile
syncular source under *their* TS version and tsconfig, and it produces
patch-the-wrong-file confusion (a `dist/` hotfix does nothing under Vite —
observed directly).

**Proposal:** ship compiled JS for the `browser` condition (keep `bun` on
source if desired — bun always transpiles), or document the constraint
prominently ("Vite-class bundlers only") on the web platform page. The
first broken `next dev` is someone's last impression.

### 1.2 Publish `tauri-plugin-syncular` to crates.io

The Tauri docs instruct consuming the plugin as a path dependency from a
repo checkout. That works for this repo's owner and nobody else — a Tauri
developer without the checkout cannot adopt syncular at all. If publishing
the full crate graph (`syncular-client`, `syncular-command`) is heavy, an
interim `git = "…"` dependency recipe in the docs still lowers the bar.

### 1.3 Docs describe HEAD; npm ships 0.2.1

The live site documents `useQuery`/`useRawSql`, the `.syql` DSL, and
camelCase row fields. The published `0.2.1` has `useNamedQuery`/
`useSyncQuery`, plain `.sql` named queries, and snake_case row fields.
Integrating from the docs against npm costs real time (observed: the
`.syql` file was rejected by typegen with a good error; the hook names and
row casing needed d.ts spelunking).

**Proposal:** any one of — version the docs site, gate doc deploys on
releases, or cut the release that makes the docs true. Until 1.0, a "docs
track vNEXT; npm is at vX" banner is the one-hour stopgap.

## 2. API gaps

### 2.1 Partial updates have no good answer (and `SELECT *` poisons upserts)

`MutationInput` is full-row `upsert` | `delete` (wire design, §6.1 — fine).
The app-side consequence: toggling one field means select-explicit-columns
→ spread → flip → re-send. And the obvious first attempt — `SELECT *`,
spread, mutate — fails, because star-selects include the internal
`_sync_version` column and mutate rejects it as an unknown column
(observed directly). Three compounding fixes, each independently cheap:

1. The unknown-column rejection for `_sync_*` names should say so:
   *"internal sync column — did you build values from a `SELECT *` row?"*
2. `query()` (or the row codec) strips `_sync_*` columns from results, so
   star-select rows are mutation-safe.
3. Optionally: a client-side `patch(table, rowId, partial)` convenience
   that reads the current row and emits the merged full-row upsert. The
   wire stays full-row; the footgun disappears.

### 2.2 Export `SyncClientLike` from `@syncular/react`

The host-agnostic client interface is the package's central abstraction —
and it is not exported (only `normalizeClient` is). Building an engine seam
required `SyncProviderProps['client']` gymnastics. One-line fix.

### 2.3 Tauri plugin: runtime header updates

`SyncularConfig.headers` is init-time only (`Vec<(String, String)>` read at
plugin registration; verified in `bindings/tauri/plugin/src/lib.rs`). Real
desktop apps have rotating JWTs. Without a `syncular_set_headers` command
(plus a bridge method on `@syncular/tauri`), every production Tauri app
must tear down and re-register the plugin to refresh auth.

### 2.4 Consider `multiTab: true` as the web default

The docs pitch worker + OPFS as *the* persistent browser mode, but
`createSyncClientHandle` defaults `multiTab` off, so the second tab is a
dead `not_leader` handle. The surprising behavior is currently opt-out and
the expected behavior opt-in. If the follower path is trusted (it is
conformance-covered), flip the default; if it is not yet trusted enough to
be the default, that is worth stating in the docs.

### 2.5 Bless a public seeding recipe

The demo server seeds via raw protocol frames (`encodeRow`, `PUSH_COMMIT`,
`handleSyncRequest`) — internal-shaped and version-coupled (it broke
against 0.2.1's snake_case rows when copied). The public-API alternative
works well: a throwaway in-process `SyncClient` (bun database, HTTP
transport pointed at the same process) that mutates and `syncUntilIdle()`s.
Either document that pattern as *the* seeding recipe, or ship
`seedMutations(config, { partition, actorId }, mutations)` in
`@syncular/server` / `@syncular/testing`. Every test suite and demo needs
this on day one.

## 3. Developer experience

### 3.1 A "Vite" docs page (or a tiny preset)

The working Vite setup is three non-obvious lines —
`optimizeDeps.exclude: ['@sqlite.org/sqlite-wasm']`, `worker.format: 'es'`,
and a dev proxy for `/sync` + `/segments` + `/realtime` (ws) — currently
assembled only by source-diving (the repo demos use `Bun.build`). Given
Vite's market share among the people most likely to try syncular, this
page pays for itself with every adopter. A `@syncular/vite` preset is the
maximal version; the docs page is the sufficient one.

### 3.2 Client-side introspection

The server has an admin console; the client has nothing. Debugging the
integration required hand-exposing the client on `window` to query local
tables, window state, and outbox from the console. A dev-gated
`window.__SYNCULAR__` registry — live clients, outbox depth, subscriptions,
window units + completeness, last sync summary, last invalidation event —
would cut first-integration debugging from tens of minutes to minutes, and
is the seed of a future devtools panel. (RFC 0001 makes the server console
a headline; this is its client-side sibling.)

### 3.3 A troubleshooting page

The integration produced its first entries verbatim:

- **Hidden documents froze live queries** (≤0.2.1): rAF is suspended while
  `document.visibilityState === 'hidden'`, so scheduled re-runs never fired
  in background tabs / occluded webviews / headless embeds. Fixed
  (microtask fallback + `visibilitychange` re-dispatch + stale-rAF guard in
  `packages/react/src/query-churn.ts`), but pre-fix versions are in the
  wild and the symptom ("data is in the local db, UI never updates") is
  maximally confusing.
- `sync.outbox_incompatible`, `client.not_leader`, `_sync_version`
  rejections — what they mean, what to do.
- Wiping OPFS for a clean test
  (`navigator.storage.getDirectory()` → recursive `removeEntry`).
- Connectivity: why `useSyncStatus` has no `online` field (the core does
  not own connectivity — a good decision) plus the recipe every app
  otherwise re-derives (`navigator.onLine` + `onSynced` glue).

## 4. Strategic

### 4.1 Make "one codebase, web + desktop" a discoverable story

The engine seam that fell out of the integration is ~60 lines: detect
`__TAURI_INTERNALS__` (with an env override), dynamic-import either
`createSyncClientHandle` (worker + OPFS) or `createTauriSyncClient`
(native core), hand the result to one `SyncProvider`. The same hooks, the
same components, two radically different hosts. This is the most
compelling demonstration of the `SyncClientLike` design that exists — and
today nobody can discover it. **Proposal:** a `--template tauri` for
`create-syncular-app` and/or a "One codebase, web + Tauri" guide built
around that seam.

### 4.2 Document schema-bump bandwidth expectations on native

Wipe-and-re-bootstrap on version bump is a clean design and the image lane
makes it fast, but a phone with a large windowed dataset re-downloads it
on every schema version, potentially on cellular. The docs should answer
the two questions a production evaluator asks first: is re-bootstrap
limited to the currently windowed-in units (it should be), and what does a
bump cost at N rows on the image lane. If the answers are good — and the
benchmarks suggest they are — saying so out loud is pure upside.

## Priority order (one line each)

| # | Item | Effort | Impact |
| --- | --- | --- | --- |
| 2.2 | Export `SyncClientLike` from react | trivial | unblocks the core abstraction |
| 2.1a | `_sync_*` rejection message hint | trivial | kills a guaranteed first-hour footgun |
| 1.3 | Fix docs/npm drift (banner or release) | small | first-contact trust |
| 3.1 | Vite docs page | small | every web adopter |
| 3.3 | Troubleshooting page | small | compounding support savings |
| 2.5 | Public seeding recipe/helper | small | every test suite |
| 1.1 | Compiled `browser` condition | medium | webpack/Next.js adopters |
| 2.3 | Tauri runtime header updates | medium | production desktop auth |
| 2.4 | `multiTab` default flip (or rationale) | small | second-tab surprise |
| 3.2 | `window.__SYNCULAR__` dev registry | medium | debugging velocity |
| 4.1 | Tauri template + web+desktop guide | medium | flagship demo |
| 1.2 | crates.io publish | medium/heavy | Tauri adoption exists at all |
| 4.2 | Schema-bump cost docs | small | evaluator confidence |

## Non-goals

- No wire or SPEC changes are proposed. 2.1's `patch` is client-side sugar
  over full-row upserts; 2.4 is a default flip over existing conformance-
  covered behavior.
- The hidden-rAF bug fix is referenced as context, not proposed here (it
  landed with its own tests in `packages/react`).
