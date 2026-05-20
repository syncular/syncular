# Browser Feature Variants Decision

This captures the WP-11 decision for optional browser/runtime package variants.

## Decision

Do not publish separate no-CRDT, no-E2EE, no-blob, or no-realtime browser
wrapper packages yet.

The current browser package is intentionally one canonical Rust-owned SQLite
runtime. It gives generated app clients one stable low-level contract and keeps
Kysely query behavior consistent. A second TypeScript wrapper around the same
WASM file would not reduce shipped bytes.

Feature variants are only worth doing when they remove measured bytes from the
compiled Rust/WASM artifact and the generator can choose the right artifact from
schema metadata.

The chosen shape for now is one npm package with an optional artifact catalog:
the package can build `full` and `core` WASM artifacts, write per-artifact
metadata next to each artifact, and write a top-level ordered catalog that app
bundles may serve. Generated apps select the smallest compatible artifact by
schema-derived runtime features.

## Current Feature Shape

The shipping browser build uses:

```sh
wasm-pack build rust/crates/runtime \
  --target web \
  --no-pack \
  -- \
  --no-default-features \
  --features web-owned-sqlite
```

`web-owned-sqlite` currently implies:

- Rust-owned SQLite via `sqlite-wasm-rs` and `sqlite-wasm-vfs`.
- Browser host APIs via `wasm-bindgen`, `wasm-bindgen-futures`, and `web-sys`.
- CRDT/Yjs support via `crdt-yjs` and `yrs`.
- Field-level E2EE and encrypted CRDT support via `e2ee` and the crypto helper
  dependencies.
- Blob protocol and storage code as part of the same runtime contract.
- Realtime support through browser websocket/fetch bindings.

`crdt-yjs` is now a real Cargo dependency boundary: disabling it removes the
`yrs` dependency and CRDT/Yjs operations return a runtime capability error
instead of linking the Yrs implementation. The canonical browser artifact still
enables `web-owned-sqlite`, which enables `crdt-yjs`.

`e2ee` is also now a real Cargo dependency boundary: disabling it removes the
field-encryption/encrypted-CRDT crypto helper dependencies while keeping the
same public API shape. E2EE operations return a runtime capability error from
no-E2EE builds. The canonical browser artifact still enables
`web-owned-sqlite`, which enables `e2ee`.

Measured release budgets are enforced in
`rust/bindings/browser/scripts/size-syncular-v2-wasm.ts` and documented in
`rust/bindings/browser/README.md`.

Latest local optimized measurements:

| Artifact | Features | Raw | Gzip |
| --- | --- | ---: | ---: |
| canonical full | `web-owned-sqlite` | `2.92 MiB` | `1.20 MiB` |
| internal core | `web-owned-sqlite-core` | `2.19 MiB` | `925.6 KiB` |

The internal core build removes CRDT/Yrs, E2EE crypto, and blob
upload/cache helpers while preserving the browser Rust-owned SQLite sync base.
The measured savings are `743.8 KiB` raw and `303.2 KiB` gzip versus the
canonical artifact. That clears the measurement gate for a possible
no-CRDT/no-E2EE/no-blob artifact, but it does not by itself justify publishing
a second package before package layout and per-variant conformance are in
place.

Variant build metadata now exists. The package `build` runs
`build:wasm:variants`, which writes
`syncular-v2-runtime-artifact.json` next to `dist/wasm` and `dist/wasm-core`,
then writes `dist/syncular-v2-runtime-artifacts.json` with ordered artifact
URLs, Rust features, runtime features, and raw/gzip sizes.

Direct Rust WebSocket transport is no longer a browser artifact boundary. The
browser artifact uses the TypeScript Worker controller as the single WebSocket
owner because browser sockets are a JavaScript platform API and the worker is
the right place for reconnect, heartbeat, presence, auth parameter refresh, and
DevTools-visible diagnostics. Rust still owns binary sync-pack decode/apply and
native WebSocket support. Removing browser Rust WebSocket ownership is a
boundary cleanup, not a major size lever.

Browser gzip fallback is also no longer a variant boundary. The browser
artifact requires `DecompressionStream('gzip')` for snapshot chunks and
snapshot artifacts. Native Rust keeps `flate2`; browser Rust does not link the
`flate2` fallback.

The package may include multiple optimization profiles for the same full
feature set without creating a feature matrix. The default `full` artifact is
size-optimized with release `opt-level=z`; `full-perf` is the same full feature
set built with release `opt-level=3` and must be selected explicitly. Generated
feature selection should continue to pick the smallest compatible artifact by
default.

## What A Real Variant Requires

A real feature split needs all of these, not just package names:

- Cargo feature boundaries that compile out unused Rust modules and
  dependencies.
- Generated schema metadata that declares required runtime capabilities:
  `crdt-yjs`, `encrypted-crdt`, `field-e2ee`, `blobs`, `realtime`, and
  storage mode.
- Browser package loading that selects an artifact from those generated
  requirements. This hook now exists through `requiredRuntimeFeatures` plus an
  ordered `runtimeArtifacts` catalog.
- Runtime contract validation so an app generated for CRDT or E2EE cannot boot
  against a smaller artifact missing those capabilities. This validation now
  exists in Rust open and generated TypeScript runtime assertions.
- Separate size reports and budgets per artifact.
- Conformance coverage per variant.

The core/full catalog and the first core conformance suite now exist. Further
variants should not be added until they clear the same size and conformance
bar.

## Candidate Artifacts

Only these variants are plausible:

- `web-owned-sqlite-full`: current canonical artifact.
- `web-owned-sqlite-basic`: SQLite, sync, typed reads, mutations, conflicts,
  and auth; no blobs, no E2EE, no CRDT, no realtime.
- `web-owned-sqlite-no-crdt`: useful only if `yrs` removal saves enough gzip
  size while keeping E2EE/blobs/realtime.
- `web-owned-sqlite-local-only`: local SQLite/Kysely and generated mutations,
  no HTTP sync, blobs, E2EE, CRDT, or realtime. This is a different product
  shape and should not pretend to be a full Syncular client.

Do not create many combinations. Every artifact multiplies testing, docs,
release, and support surface.

## Measurement Gate

Start implementation only if a prototype proves one of these:

- At least 250 KiB gzip reduction versus the canonical browser artifact.
- At least 15 percent gzip reduction versus the canonical browser artifact.
- A product requires a local-only package with no network/sync features.

The internal `web-owned-sqlite-core` prototype now clears this gate for the
combined CRDT/Yrs, E2EE, and blob split: `303.2 KiB` gzip reduction, roughly
`24.7%` of the canonical gzip size. Keep one npm package with explicit artifact
metadata unless a concrete install-size or CDN-packaging requirement appears.

## First Implementation Chunk If Needed

If the product decision changes, start with a measurement-only branch:

1. Measure the already-proven `crdt-yjs` and `e2ee` boundaries in optimized
   WASM artifacts.
2. Keep the measured `blobs` boundary in the internal core build.
3. Do not split direct Rust WebSocket/realtime; browser realtime lifecycle is
   TypeScript-owned and native realtime remains Rust-owned.
4. Keep the default browser build unchanged.
5. Add a non-published `web-owned-sqlite-basic` build script that compiles
   without those features.
6. Run the same `wasm-opt -Oz` and custom-section stripping.
7. Write raw/gzip attribution to `.context/wasm-size`.
8. Only then decide whether package variants are worth maintaining.

## Current Status

Unblocked for the first browser artifact pair. We have size budgets, feature
workload benchmarks, real `crdt-yjs`, `e2ee`, and `web-blobs` feature
boundaries, optimized artifact measurements, and cataloged full/core build
outputs.
No-default normal/build dependency trees no longer ship Yrs or the targeted
E2EE crypto crates (`argon2`, `bip39`, `chacha20poly1305`, `hkdf`, `pbkdf2`,
or `x25519-dalek`). `base64` may still appear through native HTTP dependencies;
`zeroize` may still appear through native TLS dependencies.

Runtime capability validation now exists in two places: Rust rejects injected
app schemas that require missing `crdt-yjs` or `e2ee` features during open, and
generated TypeScript clients emit `syncularGeneratedRequiredRuntimeFeatures`
from schema metadata. Generator-selected artifact loading also exists:
`createSyncularAppDatabase()` passes schema-derived requirements into the
Worker, and an optional ordered `runtimeArtifacts` catalog selects the first
artifact that satisfies those requirements.

Do not publish separate wrapper packages. Local commands can build the core
artifact into `dist/wasm-core` and a catalog into
`dist/syncular-v2-runtime-artifacts.json` for app experiments. The
`test:wasm:variants` suite covers a basic non-CRDT/non-E2EE Worker open, local
mutation/query, Hono push/pull between two core WASM clients, and CRDT/blob
schema rejection against the core artifact. Direct Rust websocket/realtime was
measured and rejected as a useful WASM boundary.
