#!/usr/bin/env bash
# The gate for the Kotlin/JVM bindings — isolated from the main workspaces
# exactly like bindings/tauri (never joins `bun run check` / the main cargo
# gate). Run from anywhere; it cds to its own dir.
#
# Steps:
#   1. Build the lean libsyncular for THIS machine and vendor it (the FFM
#      SymbolLookup loads it via the `syncular.library.path` system property,
#      set in build.gradle.kts from vendor/).
#   2. `gradle test` (offline-first hermetic suite) against it.
#
# Detect-and-skip (mirroring build-native.sh / the Swift gate): the wrapper uses
# FFM (java.lang.foreign), which needs a JDK 21+ AND a Gradle to drive the
# build. On a machine without a JDK or Gradle this gate SKIPS cleanly (exit 0)
# and prints why — it never fails the run. FFM (not JNA) is the primary path;
# JNA is a documented fallback for JDK < 21 (README.md).
set -euo pipefail

cd "$(dirname "$0")"
KOTLIN_DIR="$(pwd)"
V2_DIR="$(cd ../.. && pwd)"
RUST_DIR="${V2_DIR}/rust"

# -- generated schema freshness (runs even without a JDK/Gradle) --------------
# The example's Kotlin schema (example/src/main/kotlin/dev/syncular/example/
# Syncular.generated.kt) is produced by `syncular-v2 generate` from
# example/syncular.json + migrations/. Gate its freshness byte-exactly so a
# hand-edit or a migration change without a regenerate fails loud. Requires bun
# (the repo toolchain); this gate runs BEFORE the JDK detect-and-skip so schema
# freshness is verified even on a JDK-less machine.
if command -v bun >/dev/null 2>&1; then
  echo "== generated schema is fresh (syncular-v2 generate --check) =="
  ( cd "${V2_DIR}" && bun packages/typegen/src/cli.ts generate \
      --manifest-dir bindings/kotlin/example --check )
  echo "ok: example Syncular.generated.kt is fresh"
else
  echo "SKIP: no bun; cannot verify generated-schema freshness (repo toolchain)."
fi

# -- toolchain detection ------------------------------------------------------
# NOTE: macOS ships a /usr/bin/java STUB that exists but has no runtime, so we
# must actually RUN `java -version` (not just `command -v java`) to detect a
# real JDK.
JAVA_VERSION_OUT="$(java -version 2>&1 || true)"
if ! printf '%s' "${JAVA_VERSION_OUT}" | grep -qE 'version "[0-9]'; then
  echo "SKIP: no working JDK. The Kotlin/FFM bindings need JDK 21+."
  echo "      (Install a JDK 21+ and a Gradle, then re-run ./check.sh.)"
  exit 0
fi

# Require JDK 21+ (FFM: preview in 21, stable in 22).
JAVA_MAJOR="$(printf '%s' "${JAVA_VERSION_OUT}" | awk -F'"' '/version/ {print $2}' | awk -F. '{print ($1=="1")?$2:$1}')"
if [ -n "${JAVA_MAJOR}" ] && [ "${JAVA_MAJOR}" -lt 21 ] 2>/dev/null; then
  echo "SKIP: JDK ${JAVA_MAJOR} found, but FFM needs JDK 21+."
  echo "      (Use JDK 21+, or the JNA fallback documented in README.md.)"
  exit 0
fi

GRADLE_CMD=""
if [ -x "./gradlew" ]; then
  GRADLE_CMD="./gradlew"
elif command -v gradle >/dev/null 2>&1; then
  GRADLE_CMD="gradle"
else
  echo "SKIP: no Gradle (no ./gradlew wrapper, no system gradle)."
  echo "      (Install Gradle 8.5+ — it drives the FFM build — then re-run.)"
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
mkdir -p "${KOTLIN_DIR}/vendor"
cp "${LIB_SRC}" "${KOTLIN_DIR}/vendor/${LIB}"
echo "ok: vendored ${LIB}"

# -- gradle test --------------------------------------------------------------
echo "== ${GRADLE_CMD} test =="
"${GRADLE_CMD}" --no-daemon test

echo "OK: kotlin bindings gate is green"
