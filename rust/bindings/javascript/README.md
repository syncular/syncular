# @syncular/client-javascript-bindings

Generated JavaScript and WASM binding package for the Syncular Rust browser
runtime.

This package owns the wasm-bindgen output contract and runtime artifacts used by
`@syncular/client`. Keep browser client ergonomics, worker lifecycle, Kysely
integration, and generated-app APIs in `packages/client`; keep low-level Rust
WASM build, size, catalog, and generated wasm declaration files here.

## Scripts

```bash
bun run tsgo
bun run build:wasm:dev
bun run build:wasm
bun run build:wasm:core
bun run build:wasm:variants
bun run catalog:wasm
bun run size:wasm
bun run size:wasm:check
```
