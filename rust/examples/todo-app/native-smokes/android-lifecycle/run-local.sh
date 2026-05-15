#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../../../.." && pwd)"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}"
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT}}"
ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-${ANDROID_SDK_ROOT}/ndk/29.0.14206865}"
OUT_DIR="${SYNCULAR_ANDROID_LIFECYCLE_OUT:-${REPO_ROOT}/.context/native-smokes/android-lifecycle}"
JNI_LIBS_DIR="${OUT_DIR}/jniLibs/arm64-v8a"
HEADERS_DIR="${OUT_DIR}/headers"
JNI_OBJECT="${OUT_DIR}/jni_glue.o"
LLVM_BIN="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/darwin-x86_64/bin"
AVD_NAME="${SYNCULAR_ANDROID_AVD:-syncular_native_api36_arm64}"
DEVICE_NAME="${SYNCULAR_ANDROID_DEVICE:-pixel_6}"
SDKMANAGER="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/avdmanager"
ADB="${ANDROID_SDK_ROOT}/platform-tools/adb"
EMULATOR="${ANDROID_SDK_ROOT}/emulator/emulator"

export ANDROID_SDK_ROOT ANDROID_HOME ANDROID_NDK_HOME
export PATH="${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/emulator:${LLVM_BIN}:${PATH}"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="${CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER:-aarch64-linux-android24-clang}"
export CC_aarch64_linux_android="${CC_aarch64_linux_android:-aarch64-linux-android24-clang}"
export AR_aarch64_linux_android="${AR_aarch64_linux_android:-llvm-ar}"

if [ ! -x "${SDKMANAGER}" ] || [ ! -x "${AVDMANAGER}" ] || [ ! -x "${ADB}" ] || [ ! -x "${EMULATOR}" ]; then
  echo "Android SDK command-line tools, platform-tools, and emulator are required under ${ANDROID_SDK_ROOT}" >&2
  exit 1
fi

mkdir -p "${JNI_LIBS_DIR}" "${HEADERS_DIR}"

echo "[android-lifecycle] build Rust runtime for Android arm64"
cargo build \
  --manifest-path "${REPO_ROOT}/rust/Cargo.toml" \
  -p syncular-runtime \
  --target aarch64-linux-android \
  --release \
  --lib

cp "${REPO_ROOT}/rust/bindings/swift/include/syncular-runtime.h" \
  "${HEADERS_DIR}/syncular-runtime.h"

"${LLVM_BIN}/aarch64-linux-android24-clang" \
  -c \
  -fPIC \
  -O3 \
  -I "${HEADERS_DIR}" \
  "${REPO_ROOT}/rust/bindings/kotlin/kotlin/jni/jni_glue.c" \
  -o "${JNI_OBJECT}"

"${LLVM_BIN}/aarch64-linux-android24-clang" \
  -shared \
  -o "${JNI_LIBS_DIR}/libsyncular_runtime.so" \
  "${JNI_OBJECT}" \
  -Wl,--whole-archive \
  "${REPO_ROOT}/rust/target/aarch64-linux-android/release/libsyncular_runtime.a" \
  -Wl,--no-whole-archive \
  -Wl,--gc-sections \
  -lm \
  -llog \
  -ldl

if ! "${AVDMANAGER}" list avd | grep -q "Name: ${AVD_NAME}$"; then
  echo "[android-lifecycle] create AVD ${AVD_NAME}"
  yes "" | "${AVDMANAGER}" create avd \
    --force \
    --name "${AVD_NAME}" \
    --package "system-images;android-36;google_apis;arm64-v8a" \
    --device "${DEVICE_NAME}" >/dev/null
fi

BOOTED_DEVICE="$("${ADB}" devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
EMULATOR_PID=""
if [ -z "${BOOTED_DEVICE}" ]; then
  echo "[android-lifecycle] start emulator ${AVD_NAME}"
  "${EMULATOR}" @"${AVD_NAME}" \
    -no-window \
    -no-audio \
    -no-snapshot \
    -no-boot-anim \
    -gpu swiftshader_indirect \
    >/tmp/syncular-android-lifecycle-emulator.log 2>&1 &
  EMULATOR_PID="$!"
  trap 'if [ -n "${EMULATOR_PID}" ]; then "${ADB}" emu kill >/dev/null 2>&1 || kill "${EMULATOR_PID}" >/dev/null 2>&1 || true; fi' EXIT
fi

echo "[android-lifecycle] wait for boot"
"${ADB}" wait-for-device
BOOT_DEADLINE=$((SECONDS + 180))
while [ "$("${ADB}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
  if [ "${SECONDS}" -ge "${BOOT_DEADLINE}" ]; then
    echo "Timed out waiting for Android emulator boot. Emulator log:" >&2
    tail -200 /tmp/syncular-android-lifecycle-emulator.log >&2 || true
    exit 1
  fi
  sleep 2
done

"${ADB}" shell input keyevent 82 >/dev/null 2>&1 || true

echo "[android-lifecycle] run instrumentation test"
gradle --no-daemon -p "${SCRIPT_DIR}" connectedDebugAndroidTest
