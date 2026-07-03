#!/usr/bin/env bash
# Build the syncular-ffi native core for the platforms whose toolchains exist
# on THIS machine; detect + skip + summarize the rest. Reuses v1's packaging
# KNOWLEDGE (apple xcframework, android arm64+x86_64 .so, linux/windows JVM/
# desktop libraries) without its boltffi/UniFFI machinery — the v2 core is a
# hand-written C ABI (rust/ffi.h), so packaging is plain cargo + platform tools.
#
# Targets:
#   apple    macOS arm64 dylib + iOS device (arm64) + iOS sim (arm64) static
#            libs assembled into Syncular.xcframework (needs the Rust apple
#            targets + xcodebuild)
#   android  arm64-v8a + x86_64 .so via cargo-ndk (skipped if cargo-ndk / NDK
#            absent — never fails the run)
#   desktop  the host's own cdylib (.dylib/.so/.dll) for JVM/desktop hosts
#
# The library ships with the native transport ON (native-transport feature) —
# a shipped app needs to own HTTP+WS. Set SYNCULAR_FFI_FEATURES to override.
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OUT_ROOT="${SYNCULAR_NATIVE_OUT:-${RUST_DIR}/target/native}"
FEATURES="${SYNCULAR_FFI_FEATURES:-native-transport}"
PROFILE="${SYNCULAR_FFI_PROFILE:-release}"
PROFILE_FLAG="--release"
PROFILE_DIR="release"
if [ "${PROFILE}" = "debug" ]; then
  PROFILE_FLAG=""
  PROFILE_DIR="debug"
fi

FEATURE_FLAG=()
if [ -n "${FEATURES}" ]; then
  FEATURE_FLAG=(--features "${FEATURES}")
fi

mkdir -p "${OUT_ROOT}"

# summary rows: "target|status|detail"
summary=()
record() { summary+=("$1|$2|$3"); }

human_size() {
  if [ -f "$1" ]; then
    if command -v du >/dev/null 2>&1; then
      du -h "$1" | awk '{print $1}'
    else
      wc -c <"$1"
    fi
  else
    echo "-"
  fi
}

build_target() { # <rust-triple>
  local triple="$1"
  ( cd "${RUST_DIR}" && cargo build -p syncular-ffi ${PROFILE_FLAG} \
      "${FEATURE_FLAG[@]}" --target "${triple}" )
}

target_installed() { # <rust-triple>
  rustup target list --installed 2>/dev/null | grep -q "^$1$"
}

lib_name_for() { # <triple> -> filename
  case "$1" in
    *windows*) echo "syncular.dll" ;;
    *apple*)   echo "libsyncular.dylib" ;;
    *)         echo "libsyncular.so" ;;
  esac
}

# --- desktop: the host cdylib (always attempted) ---------------------------
echo "[native] desktop (host cdylib)…"
if ( cd "${RUST_DIR}" && cargo build -p syncular-ffi ${PROFILE_FLAG} "${FEATURE_FLAG[@]}" ); then
  host_lib=""
  for name in libsyncular.dylib libsyncular.so syncular.dll; do
    if [ -f "${RUST_DIR}/target/${PROFILE_DIR}/${name}" ]; then
      host_lib="${RUST_DIR}/target/${PROFILE_DIR}/${name}"
    fi
  done
  if [ -n "${host_lib}" ]; then
    mkdir -p "${OUT_ROOT}/desktop"
    cp "${host_lib}" "${OUT_ROOT}/desktop/"
    cp "${RUST_DIR}/ffi.h" "${OUT_ROOT}/desktop/"
    record "desktop (host)" "OK" "$(basename "${host_lib}") $(human_size "${host_lib}")"
  else
    record "desktop (host)" "FAIL" "no cdylib produced"
  fi
else
  record "desktop (host)" "FAIL" "cargo build failed"
fi

# --- apple xcframework -----------------------------------------------------
# iOS cross-compiles need the platform SDK, which ships only with full Xcode —
# Command Line Tools alone locate macosx but not iphoneos/iphonesimulator. So
# each iOS slice is gated on its SDK being locatable; a CLT-only machine builds
# the mac dylib and reports the iOS slices skipped (never fails the run).
echo "[native] apple…"
APPLE_MAC="aarch64-apple-darwin"
apple_detail=""
sdk_available() { xcrun --show-sdk-path --sdk "$1" >/dev/null 2>&1; }

if [ "$(uname -s)" != "Darwin" ]; then
  record "apple" "SKIP" "not macOS"
else
  mkdir -p "${OUT_ROOT}/apple/include"
  cp "${RUST_DIR}/ffi.h" "${OUT_ROOT}/apple/include/ffi.h"
  # macOS arm64 dylib (the host slice; macosx SDK is always present).
  if target_installed "${APPLE_MAC}" && build_target "${APPLE_MAC}"; then
    cp "${RUST_DIR}/target/${APPLE_MAC}/${PROFILE_DIR}/libsyncular.dylib" \
       "${OUT_ROOT}/apple/libsyncular-macos-arm64.dylib"
  else
    apple_detail="mac dylib failed; "
  fi
  # iOS device + sim static archives, gated on SDK availability.
  ios_slices=("aarch64-apple-ios:iphoneos" "aarch64-apple-ios-sim:iphonesimulator")
  ios_libs=""
  for slice in "${ios_slices[@]}"; do
    t="${slice%%:*}"; sdk="${slice##*:}"
    if ! target_installed "${t}"; then
      apple_detail="${apple_detail}no ${t} target; "
    elif ! sdk_available "${sdk}"; then
      apple_detail="${apple_detail}${sdk} SDK unavailable (needs full Xcode); "
    elif build_target "${t}"; then
      ios_libs="${ios_libs} ${RUST_DIR}/target/${t}/${PROFILE_DIR}/libsyncular.a"
    else
      apple_detail="${apple_detail}${t} build failed; "
    fi
  done
  # Assemble an xcframework from whatever iOS static libs built.
  if command -v xcodebuild >/dev/null 2>&1 && [ -n "${ios_libs# }" ]; then
    xcargs=()
    for lib in ${ios_libs}; do
      xcargs+=(-library "${lib}" -headers "${OUT_ROOT}/apple/include")
    done
    rm -rf "${OUT_ROOT}/apple/Syncular.xcframework"
    if xcodebuild -create-xcframework "${xcargs[@]}" \
         -output "${OUT_ROOT}/apple/Syncular.xcframework" >/dev/null 2>&1; then
      sz="$(du -sh "${OUT_ROOT}/apple/Syncular.xcframework" 2>/dev/null | awk '{print $1}')"
      record "apple" "OK" "${apple_detail}xcframework ${sz}"
    else
      record "apple" "PARTIAL" "${apple_detail}xcframework assembly failed"
    fi
  elif [ -f "${OUT_ROOT}/apple/libsyncular-macos-arm64.dylib" ]; then
    sz="$(human_size "${OUT_ROOT}/apple/libsyncular-macos-arm64.dylib")"
    record "apple" "PARTIAL" "${apple_detail}mac dylib only ${sz}"
  else
    record "apple" "SKIP" "${apple_detail}no apple slices produced"
  fi
fi

# --- android arm64-v8a + x86_64 (cargo-ndk) --------------------------------
echo "[native] android…"
if ! command -v cargo-ndk >/dev/null 2>&1; then
  record "android" "SKIP" "cargo-ndk not installed (cargo install cargo-ndk)"
elif [ -z "${ANDROID_NDK_HOME:-}${ANDROID_NDK_ROOT:-}" ]; then
  record "android" "SKIP" "ANDROID_NDK_HOME not set"
else
  mkdir -p "${OUT_ROOT}/android"
  if ( cd "${RUST_DIR}" && cargo ndk -t arm64-v8a -t x86_64 \
        -o "${OUT_ROOT}/android/jniLibs" build -p syncular-ffi \
        ${PROFILE_FLAG} "${FEATURE_FLAG[@]}" ); then
    cp "${RUST_DIR}/ffi.h" "${OUT_ROOT}/android/ffi.h"
    a="$(human_size "${OUT_ROOT}/android/jniLibs/arm64-v8a/libsyncular.so")"
    x="$(human_size "${OUT_ROOT}/android/jniLibs/x86_64/libsyncular.so")"
    record "android" "OK" "arm64-v8a ${a}, x86_64 ${x}"
  else
    record "android" "FAIL" "cargo ndk build failed"
  fi
fi

# --- linux / windows JVM/desktop cross libs (optional) ---------------------
echo "[native] cross JVM/desktop libs…"
for triple in x86_64-unknown-linux-gnu x86_64-pc-windows-gnu; do
  label="cross ${triple}"
  if ! target_installed "${triple}"; then
    record "${label}" "SKIP" "target not installed (rustup target add ${triple})"
    continue
  fi
  if build_target "${triple}"; then
    lib="$(lib_name_for "${triple}")"
    src="${RUST_DIR}/target/${triple}/${PROFILE_DIR}/${lib}"
    if [ -f "${src}" ]; then
      mkdir -p "${OUT_ROOT}/${triple}"
      cp "${src}" "${OUT_ROOT}/${triple}/"
      cp "${RUST_DIR}/ffi.h" "${OUT_ROOT}/${triple}/"
      record "${label}" "OK" "${lib} $(human_size "${src}")"
    else
      record "${label}" "FAIL" "no ${lib} produced (missing cross linker?)"
    fi
  else
    record "${label}" "FAIL" "build failed (cross linker/toolchain?)"
  fi
done

# --- summary ---------------------------------------------------------------
echo ""
echo "  native build summary (features: ${FEATURES:-none}, profile: ${PROFILE})"
echo "  ----------------------------------------------------------------------"
printf "  %-26s %-8s %s\n" "TARGET" "STATUS" "DETAIL"
for row in "${summary[@]}"; do
  IFS='|' read -r t s d <<<"${row}"
  printf "  %-26s %-8s %s\n" "${t}" "${s}" "${d}"
done
echo "  ----------------------------------------------------------------------"
echo "  artifacts under ${OUT_ROOT}"
