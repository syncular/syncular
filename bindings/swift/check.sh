#!/usr/bin/env bash
# The gate for the Swift bindings package — isolated from the main workspaces
# exactly like bindings/tauri (it never joins `bun run check` / the main cargo
# gate). Run from anywhere; it cds to its own dir.
#
# Steps:
#   1. Verify the vendored C header is byte-identical to rust/ffi.h (drift = fail).
#   2. Build the lean libsyncular dylib (default features) for THIS mac.
#   3. Copy it into vendor/ where Package.swift's linker search path points.
#   4. `swift build` + `swift test` against it, with the loader pointed at vendor/.
#
# Requires: a Swift toolchain (Command-Line-Tools is enough for the mac slice).
# Skips cleanly (never fails) if `swift` is absent — mirroring build-native.sh's
# detect-and-skip doctrine. iOS/xcframework packaging needs full Xcode and is a
# documented release step, not part of this hermetic gate.
set -euo pipefail

cd "$(dirname "$0")"
SWIFT_DIR="$(pwd)"
V2_DIR="$(cd ../.. && pwd)"
RUST_DIR="${V2_DIR}/rust"

# -- generated schema freshness (runs even without a Swift toolchain) ---------
# The example's Swift schema (Sources/TodoKit/Syncular.generated.swift) is
# produced by `syncular generate` from example/syncular.json + migrations/.
# Gate its freshness byte-exactly so a hand-edit or a migration change without a
# regenerate fails loud. Requires bun (the repo toolchain); if bun is somehow
# absent we skip THIS gate only (never a silent pass of the whole run).
if command -v bun >/dev/null 2>&1; then
  echo "== generated schema is fresh (syncular generate --check) =="
  ( cd "${V2_DIR}" && bun packages/typegen/src/cli.ts generate \
      --manifest-dir bindings/swift/example --check )
  echo "ok: example/Sources/TodoKit/Syncular.generated.swift is fresh"
else
  echo "SKIP: no bun; cannot verify generated-schema freshness (repo toolchain)."
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "SKIP: no swift toolchain; the Swift bindings gate needs Swift."
  exit 0
fi

echo "== ffi.h in sync with the vendored header =="
if ! diff -q "${RUST_DIR}/ffi.h" "${SWIFT_DIR}/Sources/CSyncularFFI/include/syncular_ffi.h" >/dev/null; then
  echo "ERROR: Sources/CSyncularFFI/include/syncular_ffi.h has drifted from rust/ffi.h." >&2
  echo "Re-copy it: cp ${RUST_DIR}/ffi.h ${SWIFT_DIR}/Sources/CSyncularFFI/include/syncular_ffi.h" >&2
  exit 1
fi
echo "ok: header matches rust/ffi.h"

echo "== build libsyncular (lean, this mac) =="
( cd "${RUST_DIR}" && cargo build -p syncular-ffi )

case "$(uname -s)" in
  Darwin) LIB="libsyncular.dylib" ;;
  Linux)  LIB="libsyncular.so" ;;
  *)      LIB="libsyncular.so" ;;
esac
LIB_SRC="${RUST_DIR}/target/debug/${LIB}"
if [ ! -f "${LIB_SRC}" ]; then
  echo "ERROR: expected ${LIB_SRC} not found after build." >&2
  exit 1
fi
mkdir -p "${SWIFT_DIR}/vendor"
cp "${LIB_SRC}" "${SWIFT_DIR}/vendor/${LIB}"
echo "ok: vendored ${LIB} ($(du -h "${SWIFT_DIR}/vendor/${LIB}" | awk '{print $1}'))"

echo "== swift build =="
swift build

echo "== swift test =="
# The tests use Swift Testing (`import Testing`), the framework that ships with
# the toolchain. On a Command-Line-Tools-only mac (no full Xcode) SwiftPM does
# not add its framework/interop dirs automatically, so we pass them explicitly:
# the module search path (-F), a matching rpath so the test bundle's dlopen
# finds Testing.framework, and an rpath for lib_TestingInterop.dylib. On a
# full-Xcode machine these flags are harmless (the toolchain already resolves
# them). The loader also needs vendor/ for libsyncular at runtime.
DEV="$(xcode-select -p 2>/dev/null || true)"
TEST_FLAGS=()
if [ -n "${DEV}" ] && [ -d "${DEV}/Library/Developer/Frameworks/Testing.framework" ]; then
  FWK="${DEV}/Library/Developer/Frameworks"
  INTEROP="${DEV}/Library/Developer/usr/lib"
  TEST_FLAGS=(
    -Xswiftc -F -Xswiftc "${FWK}"
    -Xlinker -F -Xlinker "${FWK}"
    -Xlinker -rpath -Xlinker "${FWK}"
    -Xlinker -rpath -Xlinker "${INTEROP}"
  )
fi
if [ "${#TEST_FLAGS[@]}" -gt 0 ]; then
  case "$(uname -s)" in
    Darwin) DYLD_LIBRARY_PATH="${SWIFT_DIR}/vendor" swift test "${TEST_FLAGS[@]}" ;;
    *)      LD_LIBRARY_PATH="${SWIFT_DIR}/vendor" swift test "${TEST_FLAGS[@]}" ;;
  esac
else
  # Bash 3.2 treats an empty-array expansion as unbound under `set -u`.
  case "$(uname -s)" in
    Darwin) DYLD_LIBRARY_PATH="${SWIFT_DIR}/vendor" swift test ;;
    *)      LD_LIBRARY_PATH="${SWIFT_DIR}/vendor" swift test ;;
  esac
fi

# -- example: the todo demo (SwiftUI window + terminal) -----------------------
# Build the example so it can't rot. It needs the NATIVE-TRANSPORT dylib (the
# demo talks to a real server), so we build that variant and vendor it into
# example/vendor (the wrapper's own tests above use the lean dylib). Build only
# — running the SwiftUI window / the end-to-end sync is a documented manual
# recipe (example/README.md), not a headless gate step.
echo "== build example (native-transport dylib) =="
( cd "${RUST_DIR}" && cargo build -p syncular-ffi --features native-transport )
mkdir -p "${SWIFT_DIR}/example/vendor"
cp "${LIB_SRC}" "${SWIFT_DIR}/example/vendor/${LIB}"
echo "ok: vendored native-transport ${LIB} into example/vendor"

echo "== swift build (example) =="
( cd "${SWIFT_DIR}/example" && swift build )

echo "OK: swift bindings gate is green"
