#!/usr/bin/env bash
# Build the FFI dylib, compile ffi-smoke/main.c against it, run the smoke.
# Proves the C ABI end-to-end (new -> command -> close) on this machine.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
HEADER_DIR="${RUST_DIR}"                       # ffi.h lives at rust/ffi.h
TARGET_DIR="${RUST_DIR}/target"

echo "[smoke] building libsyncular (debug cdylib)…"
( cd "${RUST_DIR}" && cargo build -p syncular-ffi )

case "$(uname -s)" in
  Darwin) LIB="libsyncular.dylib" ;;
  Linux)  LIB="libsyncular.so" ;;
  MINGW*|MSYS*|CYGWIN*) LIB="syncular.dll" ;;
  *)      LIB="libsyncular.so" ;;
esac
LIB_PATH="${TARGET_DIR}/debug/${LIB}"
if [ ! -f "${LIB_PATH}" ]; then
  echo "[smoke] expected library not found: ${LIB_PATH}" >&2
  exit 1
fi

BIN="${SCRIPT_DIR}/smoke"
echo "[smoke] compiling main.c against ${LIB}…"
cc -I"${HEADER_DIR}" "${SCRIPT_DIR}/main.c" \
  -L"${TARGET_DIR}/debug" -lsyncular \
  -o "${BIN}"

echo "[smoke] running…"
# The linker recorded -lsyncular; point the loader at the debug dir.
case "$(uname -s)" in
  Darwin) DYLD_LIBRARY_PATH="${TARGET_DIR}/debug" "${BIN}" ;;
  *)      LD_LIBRARY_PATH="${TARGET_DIR}/debug" "${BIN}" ;;
esac
status=$?

rm -f "${BIN}"
exit "${status}"
