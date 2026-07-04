#!/usr/bin/env bash
# The gate for the Flutter/Dart bindings — isolated from the main workspaces
# exactly like bindings/swift and bindings/kotlin (it never joins `bun run
# check` / the main cargo gate). Run from anywhere; it cds to its own dir.
#
# Steps:
#   1. Build the lean libsyncular for THIS machine and vendor it (the dart:ffi
#      loader opens it via SYNCULAR_LIBRARY_PATH, set below from vendor/).
#   2. `dart pub get` in the binding.
#   3. `dart analyze` the binding (and the example lib — see note below).
#   4. `dart test` (offline-first hermetic suite) against the real native core.
#
# Detect-and-skip (mirroring build-native.sh / the Swift+Kotlin gates): the
# wrapper needs a Dart SDK (bundled with Flutter, or standalone `dart`). On a
# machine without either this gate SKIPS cleanly (exit 0) and prints why — it
# never fails the run. Locally on a Dart-less mac it will SKIP.
set -euo pipefail

cd "$(dirname "$0")"
FLUTTER_DIR="$(pwd)"
SYNCULAR_PKG="${FLUTTER_DIR}/syncular"
V2_DIR="$(cd ../.. && pwd)"
RUST_DIR="${V2_DIR}/rust"

# -- generated schema freshness (runs even without a Dart SDK) ----------------
# The example's Dart schema (example/lib/syncular.generated.dart) is produced by
# `syncular-v2 generate` from example/syncular.json + migrations/. Gate its
# freshness byte-exactly so a hand-edit or a migration change without a
# regenerate fails loud. Requires bun (the repo toolchain); this gate runs
# BEFORE the Dart detect-and-skip so schema freshness is verified even on a
# Dart-less machine.
if command -v bun >/dev/null 2>&1; then
  echo "== generated schema is fresh (syncular-v2 generate --check) =="
  ( cd "${V2_DIR}" && bun packages/typegen/src/cli.ts generate \
      --manifest-dir bindings/flutter/example --check )
  echo "ok: example/lib/syncular.generated.dart is fresh"
else
  echo "SKIP: no bun; cannot verify generated-schema freshness (repo toolchain)."
fi

# -- toolchain detection ------------------------------------------------------
# Prefer a standalone `dart`; fall back to Flutter's bundled dart. The binding
# package + its tests are pure Dart (dart:ffi), so a standalone Dart SDK is
# enough to prove the binding — `flutter` is only needed to BUILD the example
# app (a heavier, GTK/SDK-gated step; see README's CI note).
DART_CMD=""
if command -v dart >/dev/null 2>&1; then
  DART_CMD="dart"
elif command -v flutter >/dev/null 2>&1; then
  DART_CMD="flutter"  # `flutter pub`, `flutter analyze`, `flutter test`
else
  echo "SKIP: no Dart SDK (no \`dart\`, no \`flutter\`)."
  echo "      (Install Flutter or a standalone Dart SDK, then re-run ./check.sh.)"
  exit 0
fi

# -- build + vendor the native core ------------------------------------------
echo "== build libsyncular (lean, this machine) =="
( cd "${RUST_DIR}" && cargo build -p syncular-ffi )

case "$(uname -s)" in
  Darwin) LIB="libsyncular.dylib" ;;
  Linux)  LIB="libsyncular.so" ;;
  MINGW*|MSYS*|CYGWIN*) LIB="syncular.dll" ;;
  *)      LIB="libsyncular.so" ;;
esac
LIB_SRC="${RUST_DIR}/target/debug/${LIB}"
if [ ! -f "${LIB_SRC}" ]; then
  echo "ERROR: expected ${LIB_SRC} not found after build." >&2
  exit 1
fi
mkdir -p "${FLUTTER_DIR}/vendor"
cp "${LIB_SRC}" "${FLUTTER_DIR}/vendor/${LIB}"
export SYNCULAR_LIBRARY_PATH="${FLUTTER_DIR}/vendor/${LIB}"
echo "ok: vendored ${LIB} ($(du -h "${FLUTTER_DIR}/vendor/${LIB}" | awk '{print $1}'))"

# -- analyze + test the binding ----------------------------------------------
echo "== dart pub get (syncular) =="
( cd "${SYNCULAR_PKG}" && "${DART_CMD}" pub get )

echo "== dart analyze (syncular) =="
( cd "${SYNCULAR_PKG}" && "${DART_CMD}" analyze )

echo "== dart test (syncular, offline hermetic) =="
( cd "${SYNCULAR_PKG}" && "${DART_CMD}" test )

echo "OK: flutter/dart bindings gate is green"
