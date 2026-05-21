# WP-10 Browser Package And Docs

Status: `[x]` browser fallback cleanup retained; size and perf full artifacts shipped

## Goal

Keep the browser package understandable and shippable while documenting the
Rust-first client clearly.

## Scope

- WASM package size measurement.
- Full browser artifact remains the default package shape; optional feature
  variants only if measured size wins justify them.
- Full browser optimization-profile artifacts can ship together when the
  default stays obvious and artifact selection remains explicit.
- Browser-only fallback removal when platform primitives are now required.
- Browser realtime ownership boundary.
- Browser worker docs.
- Rust client docs section.
- Local project integration instructions.

## Acceptance Criteria

- Package size changes are measured.
- Variant builds are not introduced unless they produce useful shipped-byte
  reductions.
- The size-optimized full artifact is the default compatible full artifact.
- The performance-optimized full artifact is available explicitly as
  `full-perf`.
- Browser snapshot gzip decompression uses `DecompressionStream` as the single
  browser path, with clear capability errors instead of Rust gzip fallback.
- Browser WebSocket lifecycle is owned by the TypeScript Worker controller;
  Rust owns realtime frame decode/apply and native WebSocket support.
- Docs cover schema generation, Diesel reads, mutations, live queries,
  worker events, CRDT fields, encryption, blobs, and testkit.

## Required Gates

- Browser/WASM build.
- Package size measurement.
- Docs link checks by search where practical.

## Accept / Reject Rule

- Retain package variants only when measured shipped-byte savings justify the
  selection and maintenance complexity.
- Retain stronger compression profiles only after size wins are paired with
  acceptable runtime benchmark evidence.
- Reject compatibility branches or parallel JS-client product paths.
- Reject browser fallback paths for modern platform APIs unless the product
  explicitly needs old-browser support.
- Docs changes should keep Rust-first docs separate from legacy JS client docs
  unless explicitly describing migration or conceptual continuity.

## Current Evidence

2026-05-21 legacy-client removal retained:

- `@syncular/client` is now the Rust-owned browser package with TypeScript
  bindings. The previous pure TypeScript `packages/client` product runtime,
  separate `packages/client-react`, old client plugin packages, old JS client
  docs, demo app, and JS-client integration/runtime/perf suites were deleted.
- `@syncular/client/react` is the remaining first-party React entrypoint, and
  `@syncular/client-crdt-adapters` replaces the old client-side CRDT adapter
  package name.
- The Rust todo example is now a Bun workspace package so generated TypeScript
  conformance imports resolve their declared dependencies directly.
- Legacy benchmark scripts that depended on the deleted JS/wa-sqlite runtime
  were removed from active package scripts. The retained browser validation
  path is `tsgo`, browser tests, WASM build/size, generated-code check, Rust
  conformance, and docs build.
- Gates run:
  - `bun run tsgo`: passed.
  - `bun run rust:browser:tsgo`: passed.
  - `bun run rust:browser:test`: passed, `91` tests.
  - `bun run rust:browser:build:wasm`: passed; release full artifact
    `2.26 MiB` raw / `1.01 MiB` gzip, with `1.04 MiB` raw and `357.4 KiB`
    gzip headroom.
  - `bun run rust:codegen:check`: passed.
  - `bun run rust:conformance:fast`: passed.
  - `bun run docs:build`: passed after generating OpenAPI and building
    `@syncular/ui` dist artifacts locally.
  - `bun test packages tests/unit tests/dialects tests/typegen`: passed,
    `703` tests.

2026-05-21 Rust-client demo retained:

- Added `apps/demo`, a Vite/React split-view todo demo using the generated
  todo TypeScript bindings and canonical `@syncular/client` Rust browser
  package. The demo starts an in-memory Hono/Bun sync server, enables the
  canonical `/sync/realtime` websocket route, opens two separate browser
  clients, and syncs todos between them.
- Gates run:
  - `bun --cwd apps/demo tsgo`: passed.
  - `bun --cwd apps/demo build`: passed.
  - Headless Chrome smoke: adding a todo in Client A appeared in Client B over
    websocket with both panes `Ready`.

The full Rust/WASM artifact and a smaller core artifact have been measured.
Feature variants remain optional and should be driven by package-size evidence;
the current product decision is to ship the full artifact by default rather than
publish a feature-package matrix.

The release full Rust-owned SQLite WASM size gate remains green after removing
browser-only fallback paths and retaining the stronger size profile as the
default:

- Budget: `3,460,301` raw bytes / `1,426,063` gzip bytes.
- Previous retained profile: `3,365,410` raw bytes / `1,383,462` gzip bytes.
- Fallback-cleanup profile: `3,316,614` raw bytes / `1,351,931` gzip bytes.
- Current retained profile: `2,220,519` raw bytes / `1,001,184` gzip bytes.
- Headroom: `1,239,782` raw bytes / `424,879` gzip bytes.
- Retained size change versus fallback cleanup: `-1,096,095` raw bytes /
  `-350,747` gzip bytes.
- The retained Rust workspace release profile is `opt-level = "z"`,
  `lto = true`, `codegen-units = 1`, and `panic = "abort"`.
- Browser `web-transport` no longer enables `flate2`. Snapshot chunks and
  artifacts require `DecompressionStream('gzip')` in browser runtimes and fail
  with a capability error when it is unavailable. Native transport keeps
  `flate2`.
- Browser Rust no longer exposes a direct `WebRealtimeSocket` path. The
  TypeScript Worker owns browser WebSocket lifecycle, reconnect, heartbeat,
  presence, and URL/auth parameter refresh; Rust still owns binary sync-pack
  decode/apply and native WebSocket support.
- The retained artifact is under 1 MiB but just over decimal 1 MB.
- The package also ships a `full-perf` artifact built with release
  `opt-level=3` for apps that prefer the old runtime profile over shipped
  bytes. It has the same runtime feature set as `full` and is selected only
  when callers pass that artifact explicitly. Current catalog sizes are:
  `core` `1,719,643` raw / `775,688` gzip bytes, `full` `2,220,519` raw /
  `1,001,184` gzip bytes, and `full-perf` `3,316,614` raw / `1,351,931` gzip
  bytes.
- Local browser E2E guardrails with `query-iterations=0` accepted the tradeoff:
  100k bootstrap `214.88ms -> 217.86ms`, 100k cached bootstrap
  `136.38ms -> 143.84ms`, 500k bootstrap `969.87ms -> 1,034.91ms`, and 500k
  cached bootstrap `664.84ms -> 721.38ms`.

## Next Action

Keep running `bun run rust:browser:tsgo`, `bun run rust:browser:test`, and
`bun run rust:browser:build:wasm` for every browser package change. Run
`bun run rust:browser:build:wasm:variants` before package changes so
`dist/wasm`, `dist/wasm-perf`, `dist/wasm-core`, and the artifact catalog stay
aligned. Keep surviving server tests on stable error taxonomy and fail-closed
snapshot storage behavior rather than reintroducing legacy fallback
expectations.
