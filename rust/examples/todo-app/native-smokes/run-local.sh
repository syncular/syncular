#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../../.." && pwd)"
EXAMPLE_DIR="${REPO_ROOT}/rust/examples/todo-app"
CONFORMANCE_FIXTURE="${EXAMPLE_DIR}/conformance/generated-client.json"
SYNC_SCENARIOS_FIXTURE="${EXAMPLE_DIR}/conformance/sync-scenarios.json"
OUT_DIR="${SYNCULAR_NATIVE_SMOKE_OUT:-${REPO_ROOT}/.context/native-smokes}"
KOTLINX_VERSION="${SYNCULAR_KOTLINX_SERIALIZATION_VERSION:-1.9.0}"
KOTLIN_LIB_DIR="${SYNCULAR_KOTLIN_LIB_DIR:-${OUT_DIR}/kotlin-libs}"
RUNTIME_TARGET_DIR="${REPO_ROOT}/rust/target/release"
SWIFT_FFI_MODULE_DIR="${OUT_DIR}/swift-ffi-module"
HONO_SERVER_INFO="${OUT_DIR}/hono-sync-server.json"
HONO_SERVER_LOG="${OUT_DIR}/hono-sync-server.log"
HONO_SERVER_PID=""

mkdir -p "${OUT_DIR}" "${KOTLIN_LIB_DIR}" "${SWIFT_FFI_MODULE_DIR}"

cleanup() {
  if [ -n "${HONO_SERVER_PID}" ] && kill -0 "${HONO_SERVER_PID}" 2>/dev/null; then
    kill "${HONO_SERVER_PID}" 2>/dev/null || true
    wait "${HONO_SERVER_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT

start_hono_server() {
  rm -f "${HONO_SERVER_INFO}" "${HONO_SERVER_LOG}"
  echo "[native-smoke] Hono sync server"
  SYNCULAR_NATIVE_HONO_INFO_PATH="${HONO_SERVER_INFO}" \
    bun "${EXAMPLE_DIR}/native-smokes/hono-sync-server.ts" \
    >"${HONO_SERVER_LOG}" 2>&1 &
  HONO_SERVER_PID="$!"

  for _ in $(seq 1 100); do
    if [ -f "${HONO_SERVER_INFO}" ]; then
      return
    fi
    if ! kill -0 "${HONO_SERVER_PID}" 2>/dev/null; then
      echo "Hono sync server exited before writing ${HONO_SERVER_INFO}." >&2
      cat "${HONO_SERVER_LOG}" >&2 || true
      exit 1
    fi
    sleep 0.1
  done

  echo "Timed out waiting for Hono sync server." >&2
  cat "${HONO_SERVER_LOG}" >&2 || true
  exit 1
}

echo "[native-smoke] Swift generated client"
swiftc \
  "${EXAMPLE_DIR}/generated/swift/SyncularApp.swift" \
  "${EXAMPLE_DIR}/native-smokes/swift/GeneratedClientSmoke.swift" \
  -o "${OUT_DIR}/generated-swift-smoke"
"${OUT_DIR}/generated-swift-smoke" "${CONFORMANCE_FIXTURE}" "${SYNC_SCENARIOS_FIXTURE}"

if ! command -v kotlinc >/dev/null 2>&1; then
  echo "kotlinc is required for the Kotlin generated client smoke. Install Kotlin or set PATH." >&2
  exit 1
fi

if ! command -v boltffi >/dev/null 2>&1; then
  echo "boltffi is required for the real native host smokes. Install it with cargo or set PATH." >&2
  exit 1
fi

echo "[native-smoke] build Rust runtime dylib"
cargo build --manifest-path "${REPO_ROOT}/rust/Cargo.toml" -p syncular-runtime --release --lib

cat >"${SWIFT_FFI_MODULE_DIR}/module.modulemap" <<EOF
module SyncularFFI [system] {
  header "${REPO_ROOT}/rust/bindings/swift/include/syncular-runtime.h"
  link "syncular_runtime"
  export *
}
EOF

SWIFT_BOLT_DB="${OUT_DIR}/swift-bolt-host.sqlite"
rm -f "${SWIFT_BOLT_DB}" "${SWIFT_BOLT_DB}-wal" "${SWIFT_BOLT_DB}-shm" "${SWIFT_BOLT_DB}-journal"

echo "[native-smoke] Swift generated client + BoltFFI host"
swiftc \
  -I "${SWIFT_FFI_MODULE_DIR}" \
  -L "${RUNTIME_TARGET_DIR}" \
  -lsyncular_runtime \
  -Xlinker -rpath -Xlinker "${RUNTIME_TARGET_DIR}" \
  "${REPO_ROOT}/rust/bindings/swift/Sources/BoltFFI/Syncular-runtimeBoltFFI.swift" \
  "${EXAMPLE_DIR}/generated/swift/SyncularApp.swift" \
  "${EXAMPLE_DIR}/native-smokes/swift/GeneratedBoltHostSmoke.swift" \
  -o "${OUT_DIR}/generated-swift-bolt-host-smoke"
"${OUT_DIR}/generated-swift-bolt-host-smoke" "${SWIFT_BOLT_DB}"

echo "[native-smoke] Swift lifecycle app shell"
swiftc \
  -I "${SWIFT_FFI_MODULE_DIR}" \
  -L "${RUNTIME_TARGET_DIR}" \
  -lsyncular_runtime \
  -Xlinker -rpath -Xlinker "${RUNTIME_TARGET_DIR}" \
  "${REPO_ROOT}/rust/bindings/swift/Sources/BoltFFI/Syncular-runtimeBoltFFI.swift" \
  "${EXAMPLE_DIR}/generated/swift/SyncularApp.swift" \
  "${EXAMPLE_DIR}/native-smokes/swift/LifecycleAppSmoke.swift" \
  -o "${OUT_DIR}/generated-swift-lifecycle-smoke"
"${OUT_DIR}/generated-swift-lifecycle-smoke" "${OUT_DIR}"

download_jar() {
  local name="$1"
  local url="$2"
  local path="${KOTLIN_LIB_DIR}/${name}"
  if [ ! -f "${path}" ]; then
    echo "[native-smoke] downloading ${name}"
    curl -fL --retry 3 -o "${path}" "${url}"
  fi
}

download_jar \
  "kotlinx-serialization-json-jvm-${KOTLINX_VERSION}.jar" \
  "https://repo1.maven.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-json-jvm/${KOTLINX_VERSION}/kotlinx-serialization-json-jvm-${KOTLINX_VERSION}.jar"
download_jar \
  "kotlinx-serialization-core-jvm-${KOTLINX_VERSION}.jar" \
  "https://repo1.maven.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-core-jvm/${KOTLINX_VERSION}/kotlinx-serialization-core-jvm-${KOTLINX_VERSION}.jar"

KOTLIN_CP="${KOTLIN_LIB_DIR}/kotlinx-serialization-json-jvm-${KOTLINX_VERSION}.jar:${KOTLIN_LIB_DIR}/kotlinx-serialization-core-jvm-${KOTLINX_VERSION}.jar"

echo "[native-smoke] Kotlin generated client"
kotlinc \
  -cp "${KOTLIN_CP}" \
  "${EXAMPLE_DIR}/generated/kotlin/SyncularApp.kt" \
  "${EXAMPLE_DIR}/native-smokes/kotlin/GeneratedClientSmoke.kt" \
  -d "${OUT_DIR}/generated-kotlin-smoke.jar"
kotlin \
  -cp "${KOTLIN_CP}:${OUT_DIR}/generated-kotlin-smoke.jar" \
  GeneratedClientSmokeKt \
  "${CONFORMANCE_FIXTURE}" \
  "${SYNC_SCENARIOS_FIXTURE}"

if [ -z "${JAVA_HOME:-}" ]; then
  if /usr/libexec/java_home >/dev/null 2>&1; then
    export JAVA_HOME="$(/usr/libexec/java_home)"
  elif [ -d "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home" ]; then
    export JAVA_HOME="/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"
  fi
fi

echo "[native-smoke] package JVM native library"
SYNCULAR_NATIVE_PACKAGE_OUT="${OUT_DIR}/native-packages" \
SYNCULAR_NATIVE_PACKAGE_PROFILE="" \
  bash "${REPO_ROOT}/rust/scripts/package-native-bindings.sh" --java

JAVA_NATIVE_DIR="$(find "${OUT_DIR}/native-packages/java/native" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
JAVA_NATIVE_LIB="$(find "${JAVA_NATIVE_DIR:-${OUT_DIR}}" -maxdepth 1 -type f \( -name 'libsyncular_runtime_jni.*' -o -name 'syncular_runtime_jni.dll' \) | head -n 1)"
if [ -z "${JAVA_NATIVE_DIR}" ] || [ -z "${JAVA_NATIVE_LIB}" ]; then
  echo "Could not find packaged JVM native library under ${OUT_DIR}/native-packages/java/native." >&2
  exit 1
fi

KOTLIN_BOLT_DB="${OUT_DIR}/kotlin-bolt-host.sqlite"
rm -f "${KOTLIN_BOLT_DB}" "${KOTLIN_BOLT_DB}-wal" "${KOTLIN_BOLT_DB}-shm" "${KOTLIN_BOLT_DB}-journal"

echo "[native-smoke] Kotlin generated client + BoltFFI host"
kotlinc \
  -cp "${KOTLIN_CP}" \
  "${REPO_ROOT}/rust/bindings/kotlin/kotlin/dev/syncular/client/Syncular.kt" \
  "${EXAMPLE_DIR}/generated/kotlin/SyncularApp.kt" \
  "${EXAMPLE_DIR}/native-smokes/kotlin/GeneratedBoltHostSmoke.kt" \
  -d "${OUT_DIR}/generated-kotlin-bolt-host-smoke.jar"
kotlin \
  -J-Djava.library.path="${JAVA_NATIVE_DIR}" \
  -cp "${KOTLIN_CP}:${OUT_DIR}/generated-kotlin-bolt-host-smoke.jar" \
  GeneratedBoltHostSmokeKt \
  "${KOTLIN_BOLT_DB}"

echo "[native-smoke] Kotlin lifecycle app shell"
kotlinc \
  -cp "${KOTLIN_CP}" \
  "${REPO_ROOT}/rust/bindings/kotlin/kotlin/dev/syncular/client/Syncular.kt" \
  "${EXAMPLE_DIR}/generated/kotlin/SyncularApp.kt" \
  "${EXAMPLE_DIR}/native-smokes/kotlin/LifecycleAppSmoke.kt" \
  -d "${OUT_DIR}/generated-kotlin-lifecycle-smoke.jar"
kotlin \
  -J-Djava.library.path="${JAVA_NATIVE_DIR}" \
  -cp "${KOTLIN_CP}:${OUT_DIR}/generated-kotlin-lifecycle-smoke.jar" \
  LifecycleAppSmokeKt \
  "${OUT_DIR}"

start_hono_server

SWIFT_SERVER_DB="${OUT_DIR}/swift-server-sync.sqlite"
rm -f "${SWIFT_SERVER_DB}" "${SWIFT_SERVER_DB}-wal" "${SWIFT_SERVER_DB}-shm" "${SWIFT_SERVER_DB}-journal"

echo "[native-smoke] Swift native server sync"
swiftc \
  -I "${SWIFT_FFI_MODULE_DIR}" \
  -L "${RUNTIME_TARGET_DIR}" \
  -lsyncular_runtime \
  -Xlinker -rpath -Xlinker "${RUNTIME_TARGET_DIR}" \
  "${REPO_ROOT}/rust/bindings/swift/Sources/BoltFFI/Syncular-runtimeBoltFFI.swift" \
  "${EXAMPLE_DIR}/generated/swift/SyncularApp.swift" \
  "${EXAMPLE_DIR}/native-smokes/swift/ServerSyncSmoke.swift" \
  -o "${OUT_DIR}/generated-swift-server-sync-smoke"
"${OUT_DIR}/generated-swift-server-sync-smoke" "${SWIFT_SERVER_DB}" "${HONO_SERVER_INFO}"

KOTLIN_SERVER_DB="${OUT_DIR}/kotlin-server-sync.sqlite"
rm -f "${KOTLIN_SERVER_DB}" "${KOTLIN_SERVER_DB}-wal" "${KOTLIN_SERVER_DB}-shm" "${KOTLIN_SERVER_DB}-journal"

echo "[native-smoke] Kotlin native server sync"
kotlinc \
  -cp "${KOTLIN_CP}" \
  "${REPO_ROOT}/rust/bindings/kotlin/kotlin/dev/syncular/client/Syncular.kt" \
  "${EXAMPLE_DIR}/generated/kotlin/SyncularApp.kt" \
  "${EXAMPLE_DIR}/native-smokes/kotlin/ServerSyncSmoke.kt" \
  -d "${OUT_DIR}/generated-kotlin-server-sync-smoke.jar"
kotlin \
  -J-Djava.library.path="${JAVA_NATIVE_DIR}" \
  -cp "${KOTLIN_CP}:${OUT_DIR}/generated-kotlin-server-sync-smoke.jar" \
  ServerSyncSmokeKt \
  "${KOTLIN_SERVER_DB}" \
  "${HONO_SERVER_INFO}"
