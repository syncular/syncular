#!/usr/bin/env bash
# The gate for the tauri bindings workspace — kept SEPARATE from `v2/rust` so
# Tauri's heavy crate tree never bloats the main workspace's cargo gate. Run
# from v2/bindings/tauri (or anywhere; it cds to its own dir).
#
# Mirrors the main rust-conformance job's hygiene: fmt + clippy (deny warnings)
# + test. Builds the plugin with and without the native-transport feature so
# both lanes stay green, and compiles the example app (the wiring proof).
set -euo pipefail

cd "$(dirname "$0")"

echo "== cargo fmt --check =="
cargo fmt --check

echo "== cargo clippy (default features) =="
cargo clippy --all-targets -- -D warnings

echo "== cargo clippy (native-transport) =="
cargo clippy -p tauri-plugin-syncular --all-targets --features native-transport -- -D warnings

echo "== cargo test =="
cargo test

echo "== example compiles =="
cargo build -p syncular-tauri-example

echo "OK: tauri bindings workspace is green"
