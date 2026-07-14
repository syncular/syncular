#!/usr/bin/env bash
# The gate for the tauri bindings workspace — kept SEPARATE from `rust` so
# Tauri's heavy crate tree never bloats the main workspace's cargo gate. Run
# from bindings/tauri (or anywhere; it cds to its own dir).
#
# Mirrors the main rust-conformance job's hygiene: fmt + clippy (deny warnings)
# + test. Builds the plugin with and without the native-transport feature so
# both lanes stay green, and compiles the example app (the wiring proof) — whose
# React frontend must be built FIRST, because `tauri::generate_context!`
# validates `frontendDist` (../dist) at compile time (every cargo step that
# touches the example crate needs the bundle present).
set -euo pipefail

cd "$(dirname "$0")"

echo "== frontend deps (bun install, workspace root) =="
# The example is a workspace member; install at the repo root so its deps
# (react, @syncular/react, @syncular/tauri, @tauri-apps/api) are linked.
( cd ../.. && bun install --frozen-lockfile )

# The example's frontend schema (src/frontend/syncular.generated.ts) is REAL
# typegen output from example/syncular.json + migrations/ (mirroring
# apps/demo-react). Gate its freshness byte-exactly so a migration change
# without a regenerate fails loud.
echo "== generated schema is fresh (syncular generate --check) =="
( cd ../.. && bun packages/typegen/src/cli.ts generate \
    --manifest-dir bindings/tauri/example --check )
echo "ok: example/src/frontend/syncular.generated.ts is fresh"

echo "== frontend bundle (bun) =="
( cd example && bun run build-frontend )

echo "== frontend typecheck (tsc) =="
( cd example && bun run typecheck )

echo "== cargo fmt --check =="
cargo fmt --check

echo "== cargo clippy (default features) =="
cargo clippy --all-targets -- -D warnings

echo "== cargo clippy (native-transport) =="
cargo clippy -p tauri-plugin-syncular --all-targets --features native-transport -- -D warnings

echo "== cargo clippy (crdt-yjs) =="
# §5.10.5 native CRDT commands compile clean on their own feature lane too.
cargo clippy -p tauri-plugin-syncular --all-targets --features crdt-yjs -- -D warnings

echo "== cargo test =="
cargo test

echo "== cargo test (native-transport) =="
cargo test -p tauri-plugin-syncular --features native-transport

echo "== real native core -> TypeScript bridge -> reactive store =="
cargo build -p syncular-tauri-bridge-harness
( cd ../.. && SYNCULAR_TAURI_NATIVE_TEST=1 bun test packages/tauri/test/native-bridge.test.ts )

echo "== example compiles =="
cargo build -p syncular-tauri-example

echo "OK: tauri bindings workspace is green"
