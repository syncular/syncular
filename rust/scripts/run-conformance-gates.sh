#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
MODE="fast"

usage() {
  cat <<'EOF'
Usage: run-conformance-gates.sh [--fast|--browser-hono|--native|--all]

Runs the Rust-first conformance gates around the shared todo app fixtures.

Modes:
  --fast          Rust testkit, runtime protocol/blob/CRDT, Rust generated app,
                  and browser generated-app contract tests.
  --browser-hono  Fast gates plus browser/Hono WASM sync/auth/realtime/blob
                  conformance tests. Build the browser WASM first when needed.
  --native        Swift/Kotlin/JVM native smoke suite against the generated app.
  --all           Browser/Hono plus native.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fast)
      MODE="fast"
      ;;
    --browser-hono)
      MODE="browser-hono"
      ;;
    --native)
      MODE="native"
      ;;
    --all)
      MODE="all"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

run() {
  echo "[conformance] $*"
  "$@"
}

run_fast() {
  run cargo test --manifest-path "${REPO_ROOT}/rust/Cargo.toml" -p syncular-testkit
  run cargo test --manifest-path "${REPO_ROOT}/rust/Cargo.toml" -p syncular-runtime --test protocol_contract --test blob_transport --test crdt_field
  run cargo test --manifest-path "${REPO_ROOT}/rust/Cargo.toml" -p syncular-todo-app-example
  run bun test "${REPO_ROOT}/rust/bindings/browser/src/generated-app-conformance.test.ts"
}

run_browser_hono() {
  run_fast
  run bun test \
    "${REPO_ROOT}/rust/bindings/browser/src/__tests__/auth-hono.wasm.test.ts" \
    "${REPO_ROOT}/rust/bindings/browser/src/__tests__/sync-hono.wasm.test.ts" \
    "${REPO_ROOT}/rust/bindings/browser/src/__tests__/realtime-hono.wasm.test.ts" \
    "${REPO_ROOT}/rust/bindings/browser/src/__tests__/blob-hono.wasm.test.ts"
}

run_native() {
  run bash "${REPO_ROOT}/rust/examples/todo-app/native-smokes/run-local.sh"
}

case "${MODE}" in
  fast)
    run_fast
    ;;
  browser-hono)
    run_browser_hono
    ;;
  native)
    run_native
    ;;
  all)
    run_browser_hono
    run_native
    ;;
esac
