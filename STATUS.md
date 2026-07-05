# v2 STATUS — 2026-07-04

A point-in-time summary of where syncular v2 stands: what's done, the live
design decisions, and what's open. The plan of record is `ROADMAP.md`;
this is the "catch me up" digest.

## Big picture

v2 is **feature-complete and then some**. The full v1→v2 rebuild (REVISE.md),
the road-to-feature-done (TODO.md), and most of the after-feature-done
ROADMAP are landed and conformance-locked across both cores. Everything is
committed locally on `main`; **nothing is pushed** (Benjamin's standing rule —
57 commits ahead of `origin/main`). Package naming is settled (2026-07-05:
every `-v2` name killed, final names are `@syncular/*` + `create-syncular-app`).
The kill/merge gate, sunset, and the push remain Benjamin-gated and not yet done.

Numbers: ~764 bun tests, 74 conformance scenarios on BOTH (TS client × TS
server) and (Rust client × TS server), all bench budgets green, six platform
demos, generation on all five language targets.

## What's done (headline)

- **Core sync engine** at v1 parity + hardened: scopes, commit log,
  optimistic outbox, conflicts, idempotency, bootstrap, pruning, realtime.
- **Two conformance-locked cores**: TS (web, worker+OPFS) and Rust (native),
  one written protocol (SPEC.md, SSP2), proven byte-compatible by golden
  vectors + a shared conformance catalog.
- **Parity ladder**: blobs, CRDT, auth leases, presence, console — all landed.
- **Perf**: sqlite-image bootstrap ~30 ms @100k (6.6× v1's artifact lane),
  WS-native sync loop, signed-URL/CDN segments, CI perf budgets.
- **Client platform**: React bindings + fine-grained invalidation, multi-tab
  followers, schema-bump wipe-and-rebootstrap, windowed sync W1.
- **Bindings + demos on six platforms** — React web, Tauri+React, React
  Native, Swift, Kotlin, Flutter — each a todo app over one `SyncClientLike`
  interface (TS hosts) / one FFI command surface (native). See `DEMOS.md`.
- **Server breadth**: SQLite, Postgres (EXPLAIN-guarded), D1/Workers +
  Durable-Object realtime, S3/R2 segments **and blobs** (durable, no-TTL;
  reference-driven orphan GC via `sweepOrphanBlobs`) + LIST-free stats,
  ops events, admin console, load-test suite.
- **Codegen on all five targets** (TS/Swift/Kotlin/Dart) — schema types +
  the named-query tier — with `--check` freshness gates.
- **Docs**: 14-page site + migration guide + runnable quickstart +
  create-app scaffolder.

## Live design decisions & discussions

### Type-safe queries (decided)
Three-tier read story, chosen deliberately:
1. **Named queries** — `.sql` → typed functions on all five targets, the
   drift-killer (the type is derived from the query's projection, checked by
   SQLite itself at generate time). Landed as a flat v1.
2. **Kysely** — the TS dynamic/composed-filter tier (read-only dialect over
   the `query()` surface, works on every host).
3. **Raw `query()`** — the escape hatch everywhere.
Rejected: per-runtime ORMs (want to own the connection we own) and a custom
cross-runtime DSL (per-language maintenance trap).

### Named-query layout redesign (DECIDED, awaiting 3 confirms before build)
The flat v1 doesn't scale to hundreds of queries. New model, agreed with
Benjamin:
- **file-per-.sql** output; **namespace = folder path, name = filename**;
- **override via a `-- a.b.theFunction` name directive** (absolute); the
  directive also **delimits multiple queries in one file**;
- namespace is a real language construct (nested object/enum/package).
Three open confirms before I build: directive grammar (dotted-path-comment
vs. marker prefix), absolute-vs-append namespace override, and output
location (co-located vs. per-language mirrored root — I lean mirrored-root).
Full detail in ROADMAP block 4.

### Standing architectural rules (from REVISE, still in force)
Spec-first; codify judgment calls back into SPEC; **no fallback paths** (one
good path per concern, support floors not degradation ladders); size gate is
OUR JS only (vendor SQLite bytes don't gate); every landing keeps bun check +
bench:ci + cargo + the Rust pairing green.

## Open / not done

- **Test flake (real, open)**: multi-tab tests pass 10/10 alone but the
  62-file suite flakes ~1-in-6 — a cross-file interaction in bun's shared
  process (global BroadcastChannel/lock state), NOT a logic bug. A partial
  fix landed (commit fe09e277 — a genuine follower-bind production bug + react
  act() wrapping) but did NOT resolve the suite flake. Remaining fix:
  process-isolate the global-primitive tests, or find the specific leak.
  Must fix before CI becomes the merge authority.
- **Named-query layout redesign**: designed, awaiting Benjamin's 3 confirms.
- **Demand-gated** (built on request): native CRDT editing (yrs), windowed
  sync W2 (TTL sugar), per-rowid invalidation refinement.
- **Benjamin-gated release items**: package naming (6.3 — DONE 2026-07-05,
  final names `@syncular/*` + `create-syncular-app`),
  publishing pipeline (with the v1 artifact-guard lessons), sunset actions
  (promotion done 2026-07-04; archive/registry deprecations remain), the kill/merge gate
  decision, and **the push** (57 commits local).

## Git state

`main`, 57 commits ahead of `origin/main`, working tree clean. The old tree
(`packages/`, `rust/` at repo root) stays FROZEN per Benjamin — do not repair.
