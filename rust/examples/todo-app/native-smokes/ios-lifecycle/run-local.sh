#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../../../.." && pwd)"
OUT_DIR="${SYNCULAR_IOS_LIFECYCLE_OUT:-${REPO_ROOT}/.context/native-smokes/ios-lifecycle}"
PROJECT_PATH="${SCRIPT_DIR}/SyncularLifecycleApp.xcodeproj"
DERIVED_DATA="${OUT_DIR}/DerivedData"
HEADERS_DIR="${OUT_DIR}/headers"
XCFRAMEWORK_PATH="${OUT_DIR}/Syncular.xcframework"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required for the iOS lifecycle smoke." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}" "${HEADERS_DIR}"

echo "[ios-lifecycle] build Rust runtime for iOS simulator"
cargo build \
  --manifest-path "${REPO_ROOT}/rust/Cargo.toml" \
  -p syncular-runtime \
  --target aarch64-apple-ios-sim \
  --release \
  --lib

cp "${REPO_ROOT}/rust/bindings/swift/include/syncular-runtime.h" "${HEADERS_DIR}/syncular-runtime.h"
cat >"${HEADERS_DIR}/module.modulemap" <<EOF
module SyncularFFI {
  header "syncular-runtime.h"
  export *
}
EOF

rm -rf "${XCFRAMEWORK_PATH}"
xcodebuild -create-xcframework \
  -library "${REPO_ROOT}/rust/target/aarch64-apple-ios-sim/release/libsyncular_runtime.a" \
  -headers "${HEADERS_DIR}" \
  -output "${XCFRAMEWORK_PATH}" >/dev/null

echo "[ios-lifecycle] generate Xcode project"
xcodegen generate --spec "${SCRIPT_DIR}/project.yml" --project "${SCRIPT_DIR}" >/dev/null

if [ -z "${SYNCULAR_IOS_DESTINATION:-}" ]; then
  if xcrun simctl list devices available | grep -q "iPhone 17"; then
    SYNCULAR_IOS_DESTINATION="platform=iOS Simulator,name=iPhone 17"
  else
    SYNCULAR_IOS_DESTINATION="platform=iOS Simulator,name=iPhone 16"
  fi
fi

echo "[ios-lifecycle] test on ${SYNCULAR_IOS_DESTINATION}"
xcodebuild \
  -project "${PROJECT_PATH}" \
  -scheme SyncularLifecycleApp \
  -destination "${SYNCULAR_IOS_DESTINATION}" \
  -derivedDataPath "${DERIVED_DATA}" \
  CODE_SIGNING_ALLOWED=NO \
  test
