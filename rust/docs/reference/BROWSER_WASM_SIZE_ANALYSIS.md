# Browser WASM Size Analysis

Last measured: 2026-06-18

## Current Baseline

Measured from a fresh `@syncular/client` core WASM build:

```sh
PATH=/tmp/syncular-bun-1.3.9/bun-darwin-aarch64:$PATH bun run build:wasm:core
PATH=/tmp/syncular-bun-1.3.9/bun-darwin-aarch64:$PATH bun scripts/size-syncular-wasm.ts --wasm dist/wasm-core/syncular_bg.wasm --json
```

Result:

- `packages/client/dist/wasm-core/syncular_bg.wasm`
- raw: `1,700,974 B` (`1.62 MiB`)
- gzip: `768,136 B` (`750.1 KiB`)
- within current package budget

Measured full browser build:

- raw: `2,276,149 B` (`2.17 MiB`)
- gzip: `1,018,294 B` (`994.4 KiB`)

Measured full perf build:

- raw: `3,385,081 B` (`3.23 MiB`)
- gzip: `1,383,478 B` (`1.32 MiB`)
- within current package budget

## What Is Large

Earlier stripped core WASM attribution showed the binary is mostly code:

- code section: about `1.66 MiB`, roughly `88%`
- data section: about `188 KiB`, roughly `10%`
- all other sections: about `26 KiB`, roughly `1%`

Directional named-symbol attribution from the pre-trim unstripped profile artifact:

| Chunk | Approx. function code | Why it matters |
| --- | ---: | --- |
| SQLite C engine/amalgamation | `~696 KiB` | Largest single chunk. This is SQLite itself, not OPFS glue. |
| `serde` / `serde_json` / `serde-wasm-bindgen` | `~406 KiB` | Lots of generated typed deserializer code plus dynamic JSON handling. |
| Rust std / alloc / compiler support | `~344 KiB` | Formatting, allocation, `dlmalloc`, compiler builtins, panic/error support. |
| `wasm-bindgen` / `js-sys` / `web-sys` / futures | `~209 KiB` | JS boundary, async export glue, bindings machinery. |
| Syncular web SQLite store and exported client methods | `~180 KiB` | Browser-owned SQLite store, exported JSON methods, local APIs. |
| Syncular runtime/protocol/client/transport | `~171 KiB` | Sync protocol, transport, pull/push, health, binary pack handling. |
| `sqlite-wasm-rs` / `sqlite-wasm-vfs` / OPFS wrapper code | `~44 KiB` | Small compared with SQLite itself. OPFS is not the main bloat source. |
| Hashing/random/UUID | `~9 KiB` | Too small to prioritize. |

Core does not include real Yrs or real E2EE crypto dependencies. Before the
feature-export gate, it still exported CRDT/Yjs and E2EE facade methods that
could only reject at runtime. Those exports are now compiled only into the full
artifact, with TypeScript runtime-feature guards preserving clear failures for
core users:

- core-only CRDT/Yjs and E2EE WASM export gate: `-83,550 B` raw, `-30,372 B`
  gzip
- full artifact CRDT/Yjs and E2EE surface: retained unchanged
- some disabled-path validation code remains in core because schema validation
  and shared sync paths need clear feature errors

Other named areas from the pre-trim attribution:

- diagnostics/health/support-bundle names: about `29.6 KiB`
- query/live/subscription names: about `34.2 KiB`

## What To Do Per Large Chunk

### SQLite C Engine

The main SQLite size lever is compile-time SQLite feature flags. Upstream `sqlite-wasm-rs` builds a fairly full SQLite with extensions such as FTS5, RTREE, SESSION, DBSTAT/DBPAGE/BYTECODE virtual tables, math functions, statement virtual table, preupdate hook, column metadata, and related features. Syncular now carries a local Cargo patch that keeps FTS5 and removes the optional extension/debug/introspection flags that are not part of the browser SQL contract.

Retained fix:

- `rust/vendor/sqlite-wasm-rs-0.5.3-syncular` patches the upstream crate's `build.rs` flags.
- The retained browser SQLite build keeps base WASM flags and `SQLITE_ENABLE_FTS5`.
- It removes `UNLOCK_NOTIFY`, `API_ARMOR`, `BYTECODE_VTAB`, `DBPAGE_VTAB`, `DBSTAT_VTAB`, `MATH_FUNCTIONS`, `OFFSET_SQL_FUNC`, `PREUPDATE_HOOK`, `RTREE`, `SESSION`, `STMTVTAB`, `UNKNOWN_SQL_FUNCTION`, and `COLUMN_METADATA`.
- This remains the one browser SQLite build, not a fake "lite" SKU.

Tradeoff:

- If Syncular promises arbitrary SQLite extension availability through `executeSql*`, this is a breaking product/API decision.
- If Syncular only promises normal SQLite DDL/DML required by generated apps and Syncular internals, removing unused extensions is likely the highest-value size reduction.

Turso is not a size fix today:

- Current browser WASM packages measured larger than Syncular's SQLite WASM.
- The browser path still has practical bundler/runtime issues in current testing.
- Turso may be worth revisiting later for engine capability or replication strategy, not for immediate payload reduction.

Measured SQLite compile-flag probe:

| Experiment | SQLite flags | Raw | Gzip | Decision |
| --- | --- | ---: | ---: | --- |
| Original upstream baseline | upstream `sqlite-wasm-rs` 23-flag build before export pruning | `1,882,560 B` | `842,366 B` | replaced |
| Export-pruned baseline | upstream `sqlite-wasm-rs` 23-flag build after unused WASM export pruning | `1,841,350 B` | `826,918 B` | replaced |
| Productized keep FTS5, trim others | Keep base WASM flags and `FTS5`; remove `UNLOCK_NOTIFY`, `API_ARMOR`, `BYTECODE_VTAB`, `DBPAGE_VTAB`, `DBSTAT_VTAB`, `MATH_FUNCTIONS`, `OFFSET_SQL_FUNC`, `PREUPDATE_HOOK`, `RTREE`, `SESSION`, `STMTVTAB`, `UNKNOWN_SQL_FUNCTION`, `COLUMN_METADATA` | `1,784,524 B` | `798,508 B` | retained |
| Extension trim | Keep base WASM flags; remove explicit optional extension enables: `UNLOCK_NOTIFY`, `API_ARMOR`, `BYTECODE_VTAB`, `DBPAGE_VTAB`, `DBSTAT_VTAB`, `FTS5`, `MATH_FUNCTIONS`, `OFFSET_SQL_FUNC`, `PREUPDATE_HOOK`, `RTREE`, `SESSION`, `STMTVTAB`, `UNKNOWN_SQL_FUNCTION`, `COLUMN_METADATA` | `1,702,685 B` | `750,038 B` | Strong candidate if Syncular does not promise those SQLite extensions |

Delta:

- Productized keep FTS5, trim others vs export-pruned baseline: raw `-56,826 B` (`-55.5 KiB`), gzip `-28,410 B` (`-27.7 KiB`)
- Productized keep FTS5, trim others vs original upstream baseline: raw `-98,036 B` (`-95.7 KiB`), gzip `-43,858 B` (`-42.8 KiB`)
- Extension trim including FTS5 removal: raw `-179,875 B` (`-175.7 KiB`), gzip `-92,328 B` (`-90.2 KiB`)
- FTS5 costs about `123,105 B` raw and `64,011 B` gzip compared with the no-FTS trim.

Verification:

- `bun test src/__tests__/variant-core.wasm.test.ts`: `11 pass` for the retained build.
- `bun test src/__tests__/sync-hono.wasm.test.ts --test-name-pattern "keeps readonly executeSql"`: `1 pass` for the full artifact.
- `bun test src/public-api.test.ts`: `7 pass`.
- `bun run tsgo`: pass.
- Basic SQL and Syncular core schema/sync flows still pass.
- Retained keep-FTS5 build: `ENABLE_FTS5` reports `1`, `create virtual table ... using fts5` works, and `ENABLE_RTREE`, `ENABLE_SESSION`, `ENABLE_MATH_FUNCTIONS`, `ENABLE_DBSTAT_VTAB`, `ENABLE_BYTECODE_VTAB`, `ENABLE_STMTVTAB`, `ENABLE_COLUMN_METADATA`, and `ENABLE_UNLOCK_NOTIFY` report `0`; `create virtual table ... using rtree` and `select sqrt(4)` fail as expected.
- No-FTS extension trim: removed features are actually absent: `ENABLE_FTS5`, `ENABLE_RTREE`, `ENABLE_SESSION`, `ENABLE_MATH_FUNCTIONS`, `ENABLE_DBSTAT_VTAB`, and `ENABLE_BYTECODE_VTAB` all report `0`; `create virtual table ... using fts5`, `create virtual table ... using rtree`, and `select sqrt(4)` fail as expected.

Conclusion:

- SQLite compile flags are a real size lever.
- FTS5 is the only removed extension that looks broadly valuable for normal browser offline-first apps, because local full-text search is a common user-facing offline capability.
- RTREE is valuable for geospatial/CAD/time-range niche apps, but not typical offline CRUD/sync.
- The session extension, dbstat/dbpage/bytecode/stmt virtual tables, preupdate hook, column metadata, unknown SQL function support, unlock notify, API armor, and math functions are not required for normal browser offline-first use.
- Retained default: keep FTS5 and trim the rest.
- The no-FTS profile is only appropriate if full-text search is intentionally outside the browser DB contract.
- Longer-term maintenance option: upstream configurable `sqlite-wasm-rs` flags and drop the local Cargo patch once upstream supports this cleanly.

### JSON / Serde

`serde_json` is the second-largest actionable chunk. The repo uses dynamic `serde_json::Value` for row payloads, protocol bodies, arbitrary SQL results, and several JSON boundary APIs, so `serde_json` cannot disappear in one broad swap.

Potential fixes:

- Do not move only small typed JS/WASM request DTOs to a second JSON parser; measured nanoserde/miniserde probes made gzip worse.
- Revisit parser changes only as part of a larger boundary redesign that removes enough `serde_json` typed and dynamic usage to amortize the new path.
- Keep `serde_json::Value` where the data is truly dynamic: row JSON, arbitrary query parameters, SQL results, protocol values, and user-defined payloads.
- Prefer measured removal of typed-deserializer monomorphization over a broad parser migration.

Candidate libraries:

- `nanoserde`: zero-dependency JSON derives, useful for simple JSON structs/enums.
- `miniserde`: smaller design than Serde with typed derives and JSON `Value`, but fewer customization features.
- `core-json`: interesting for no-allocation parsing, but not a drop-in replacement for current dynamic row/protocol JSON flows.
- `serde-json-core`: poor fit for arbitrary row JSON because it lacks the same dynamic `Value` use case.

Measured parser experiments:

| Experiment | Scope | Raw | Gzip | Decision |
| --- | --- | ---: | ---: | --- |
| Baseline | current `web-owned-sqlite-core` | `1,882,560 B` | `842,366 B` | Keep |
| `nanoserde` | CRDT field request DTOs + Yjs envelope parse | `1,903,719 B` | `849,982 B` | Reject: `+21,159 B` raw, `+7,616 B` gzip |
| `miniserde` narrow | same CRDT field request DTO slice | `1,881,559 B` | `845,095 B` | Reject: raw `-1,001 B`, gzip `+2,729 B` |
| `miniserde` widened | CRDT field DTOs, subscription id arrays, auth header map, live-query table/hint DTOs | `1,881,402 B` | `844,916 B` | Reject: raw `-1,158 B`, gzip `+2,550 B` |

Conclusion:

- Replacing a handful of typed boundary DTOs does not amortize the extra parser dependency.
- The gzip number gets worse even when raw bytes barely improve.
- Do not retry nanoserde/miniserde piecemeal for small boundary DTO sets.
- A JSON size win probably requires reducing dynamic `serde_json::Value` usage, changing the JS/WASM boundary shape, or removing whole feature surfaces; a local parser swap is not enough.

### Rust Std / Alloc / Formatting

Potential fixes:

- Reduce rich error formatting in WASM release paths.
- Replace broad `anyhow`/formatted error chains at JS boundaries with compact error codes plus TypeScript-side message mapping where that does not damage debuggability.
- Audit panic formatting and debug-only diagnostic strings.
- Test allocator alternatives only after higher-value chunks; this is likely lower return.

Measured Rust/Wasm code-size guide probes:

| Experiment | Raw | Gzip | Delta vs export-audit baseline | Decision |
| --- | ---: | ---: | --- | --- |
| Baseline after export-surface audit | `1,841,350 B` | `826,918 B` | reference | current retained build |
| `wee_alloc` global allocator | `1,834,734 B` | `824,030 B` | `-6,616` raw, `-2,888` gzip | reject: too little for allocator/runtime-risk tradeoff |
| Static panic hook message | `1,840,756 B` | `826,675 B` | `-594` raw, `-243` gzip | reject: loses panic detail for almost no win |
| No panic hook | `1,839,894 B` | `826,264 B` | `-1,456` raw, `-654` gzip | reject: loses panic logging for almost no win |
| `opt-level = "s"` | `2,024,553 B` | `882,595 B` | `+183,203` raw, `+55,677` gzip | reject |
| `opt-level = 3` | `2,761,907 B` | `1,123,805 B` | `+920,557` raw, `+296,887` gzip | reject |
| LTO off | `1,841,556 B` | `826,951 B` | `+206` raw, `+33` gzip | keep current LTO setting |
| `codegen-units = 16` | `1,886,384 B` | `845,719 B` | `+45,034` raw, `+18,801` gzip | reject |
| `strip = "debuginfo"` | `1,700,974 B` | `768,133 B` | `0` raw, `0` gzip vs the pre-cfg-cleanup retained core | reject: wasm-bindgen/wasm-opt already remove shipped debuginfo |
| `strip = true` | n/a | n/a | n/a | reject: `wasm-pack` / `wasm-opt` validation failed after symbol stripping |

Conclusion:

- The current Cargo release profile is already the right size profile: `opt-level = "z"`, `lto = true`, `codegen-units = 1`, and `panic = "abort"`.
- Panic-hook formatting is not the important retained formatting bloat; removing it barely moves gzip.
- `wee_alloc` is measurable but not worth the allocator tradeoff for a persistent browser database runtime.
- Explicit Cargo debuginfo stripping does not shrink the shipped artifact, and
  full symbol stripping is unsafe with the current wasm-pack/wasm-opt pipeline.

### Wasm Bindgen / JS Boundary

Potential fixes:

- Reduce exported Rust method count.
- Move ergonomic wrappers to TypeScript where possible.
- Replace many narrow `*Json` exports with fewer command-style exports only if measured to reduce glue/code size.
- Remove exports never called by the TypeScript runtime.
- Avoid async exported functions where sync APIs are enough.

Tradeoff:

- Fewer exports can improve size, but command-style APIs can make the boundary less typed and harder to debug. Measure before committing.

Measured export-surface audit:

| Experiment | Scope | Raw | Gzip | Decision |
| --- | --- | ---: | ---: | --- |
| Baseline | current `web-owned-sqlite-core` before export audit | `1,882,560 B` | `842,366 B` | reference |
| Remove five unused client method exports | `executeSqlJson`, `executeUnsafeSqlJson`, class-level `materializeYjsRowJson`, class-level `yjsStateVectorBase64`, `setOutboxAuthLeaseJson` | `1,881,228 B` | `842,343 B` | too small alone |
| Remove unused low-level store JS class export too | Remove direct `openSyncularRustOwnedSqlite` / `SyncularRustOwnedSqlite` WASM export surface; keep Rust store used by `SyncularRustOwnedSqliteClient` | `1,841,350 B` | `826,918 B` | retained |
| Feature-gate unavailable CRDT/Yjs and E2EE exports from core | Compile CRDT/Yjs and E2EE WASM exports only into the full artifact; add TypeScript runtime-feature guards for core; cfg-gate newly unreachable private helpers to keep fresh core builds warning-clean | `1,700,974 B` | `768,136 B` | retained |

Delta:

- Client-only unused wrapper cut: raw `-1,332 B`, gzip `-23 B`.
- Full export-surface cut: raw `-41,210 B` (`-40.2 KiB`), gzip `-15,448 B` (`-15.1 KiB`).
- Core-only CRDT/Yjs and E2EE export gate vs the SQLite-trimmed baseline:
  raw `-83,550 B` (`-81.6 KiB`), gzip `-30,372 B` (`-29.7 KiB`).
- Current core vs the original upstream baseline: raw `-181,586 B`
  (`-177.3 KiB`), gzip `-74,230 B` (`-72.5 KiB`).

Verification:

- `bun test src/__tests__/variant-core.wasm.test.ts`: `10 pass`
- `bun test src/public-api.test.ts`: `7 pass`
- `bun run tsgo`: pass
- Regenerated WASM bindings no longer expose the low-level store class or the five unused client methods.
- Retained feature-export gate verification:
  - full artifact declarations still expose CRDT/Yjs and E2EE methods.
  - core artifact declarations no longer expose those unavailable methods.
  - `variant-core.wasm.test.ts`: `11 pass`; includes clear TypeScript
    runtime-feature errors for CRDT/Yjs and E2EE calls against the core
    artifact.
  - `sync-hono.wasm.test.ts --test-name-pattern "CRDT|encrypted|encrypts"`:
    `6 pass`; confirms full CRDT/E2EE runtime paths still work.
  - `public-api.test.ts`: `7 pass`.
  - `bun run tsgo`: pass.
  - Fresh core rebuild after cfg-cleaning newly unreachable private CRDT/E2EE
    helpers emitted no unused-code warning noise; raw bytes were unchanged and
    gzip moved by `+3 B`.

Conclusion:

- The low-level Rust-owned SQLite store was not part of the TypeScript package path and should remain internal.
- Removing unused exports is worth keeping: the gzip win is modest, but the public WASM surface is cleaner and the maintenance cost is low.
- The core artifact should not export CRDT/Yjs or E2EE methods that require
  full-runtime features. Gating them is a meaningful size win and keeps the
  product model honest: core remains the offline SQLite runtime, full remains
  the CRDT/E2EE runtime.

Measured Rust/Wasm post-processing probes:

| Experiment | Raw | Gzip | Delta vs export-audit baseline | Decision |
| --- | ---: | ---: | --- | --- |
| Baseline after export-surface audit | `1,841,350 B` | `826,918 B` | reference | current retained build |
| Re-run current `wasm-opt -Oz` pipeline | `1,840,927 B` | `826,714 B` | `-423` raw, `-204` gzip | reject: too small for an extra optimizer pass |
| Re-run current pipeline with `--converge` | `1,840,924 B` | `826,507 B` after rebuild | `-426` raw, `-411` gzip | reject: `variant-core.wasm.test.ts` failed with a WASM type-section compile error |
| Re-run as `wasm-opt -Os` | `1,840,939 B` | `826,704 B` | `-411` raw, `-214` gzip | reject: tiny post-pass delta |
| Re-run as `wasm-opt -O3` | `1,884,110 B` | `834,645 B` | `+42,760` raw, `+7,727` gzip | reject |
| Extra strip flags | `1,840,927 B` | `826,714 B` | `-423` raw, `-204` gzip | reject: same as a plain rerun; custom sections are already stripped |
| Closed-world optimization | `1,842,576 B` | `827,195 B` | `+1,226` raw, `+277` gzip | reject |
| Closed-world + signature pruning/refining | `1,842,577 B` | `827,195 B` | `+1,227` raw, `+277` gzip | reject |

`wasm-snip` status:

- `wasm-snip 0.4.0` from crates.io failed to parse the current artifact: `failed to parse type section`.
- The current module uses modern wasm type features that the archived/stale `wasm-snip` tool does not understand.
- Do not add `wasm-snip` to the release path unless a maintained parser-compatible replacement is found and the resulting artifact passes the WASM gates.

### Syncular Runtime / Store / Protocol

Potential fixes:

- Keep CRDT/Yjs and E2EE WASM exports gated to the full artifact.
- Audit local health, repair, support-bundle, diagnostics, and debug APIs for default browser inclusion.
- Keep protocol/binary sync pack code if it is part of the core sync path.
- Remove unused Rust-owned SQLite methods after checking generated TypeScript binding usage.

Measured support/diagnostics export-gating probes:

| Experiment | Raw | Gzip | Delta vs productized SQLite-trim baseline | Decision |
| --- | ---: | ---: | --- | --- |
| Baseline after SQLite trim | `1,784,524 B` | `798,508 B` | reference | current retained build |
| Gate local health, repair, reset, and support-bundle WASM exports | `1,784,542 B` | `798,511 B` | `+18` raw, `+3` gzip | reject; size-neutral and product-support-negative |
| Gate transport stats and live-query diagnostics WASM exports | `1,784,531 B` | `798,509 B` | `+7` raw, `+1` gzip | reject; size-neutral and product-support-negative |

Conclusion:

- Local health, repair, reset, support bundles, transport stats, and live-query diagnostics are not meaningful WASM size levers after the SQLite trim.
- Keep these APIs in the default browser artifact because they are product support and observability surfaces with existing public tests.

### Data Section

Potential fixes:

- Removing SQLite extensions should also reduce static tables/strings.
- Shorten or centralize large WASM error strings where TypeScript can provide the long text.
- Keep user-facing diagnostics where they are needed for production support.

### OPFS / VFS

The measured wrapper code is small. Do not spend early time here unless Syncular is changing persistence architecture.

Potential fixes:

- Leave OPFS/SAH pool alone for size work.
- Revisit only for correctness, durability, browser compatibility, or runtime performance.

### Hashing / Random / UUID

This chunk is too small to prioritize.

## Remaining Follow-Ups

1. Revisit JSON only for a larger boundary redesign or dynamic `serde_json::Value` reduction; nanoserde/miniserde piecemeal DTO swaps were measured and rejected.
2. Upstream or replace the local `sqlite-wasm-rs` patch if upstream gains configurable SQLite flags.

## NPM Tarball Guardrail

The 2026-06-19 release dry-run caught a packaging issue separate from the
runtime WASM size: `@syncular/client` used `"files": ["dist", "src", ...]`, so
scratch measurement directories left under `packages/client/dist` were included
in the npm package.

Measured impact:

- Before allowlisting the real runtime outputs: `@syncular/client` packed at
  about `15.2 MB` / `36.7 MB` unpacked.
- After narrowing `package.json#files` to root dist files, subpath builds, and
  only `dist/wasm`, `dist/wasm-core`, and `dist/wasm-perf`: `3.5 MB` /
  `9.1 MB` unpacked.

Decision:

- Retain the explicit allowlist. It prevents ad hoc measurement artifacts such
  as `dist/wasm-core-*` and `dist/wasm-measure-*` from silently shipping.

## Measurement Rules

- Always rebuild before comparing sizes.
- Compare against `web-owned-sqlite-core` first because it isolates the browser SQLite core without real Yrs/E2EE crypto.
- Record raw and gzip bytes.
- Treat stripped shipped WASM size as the product number.
- Treat unstripped `twiggy` profile attribution as directional only.
