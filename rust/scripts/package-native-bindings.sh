#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_DIR="${REPO_ROOT}/rust/crates/runtime"
OUT_ROOT="${SYNCULAR_NATIVE_PACKAGE_OUT:-${REPO_ROOT}/.context/native-packages}"
OVERLAY_PATH="${OUT_ROOT}/boltffi.native-package.toml"
JVM_HOST_TARGETS="${SYNCULAR_JVM_HOST_TARGETS:-current}"
if [ "$(uname -s)" = "Darwin" ]; then
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-${SYNCULAR_MACOS_DEPLOYMENT_TARGET:-13.0}}"
fi
if [ "${SYNCULAR_NATIVE_PACKAGE_PROFILE+x}" = "x" ]; then
  PROFILE_FLAG="${SYNCULAR_NATIVE_PACKAGE_PROFILE}"
else
  PROFILE_FLAG="--release"
fi

usage() {
  cat <<'EOF'
Usage: package-native-bindings.sh [--all] [--apple] [--android] [--java] [--java-linux-x86_64] [--java-windows-x86_64]

Build fresh native Syncular binding packages from the current Rust runtime.

Outputs default to:
  .context/native-packages/apple
  .context/native-packages/android
  .context/native-packages/android-maven
  .context/native-packages/java

Set SYNCULAR_NATIVE_PACKAGE_OUT to choose another output directory.
Set SYNCULAR_NATIVE_PACKAGE_PROFILE="" for debug builds; release is default.
Set SYNCULAR_JVM_HOST_TARGETS=current,linux-x86_64,windows-x86_64 to package multiple JVM hosts.
Set SYNCULAR_MACOS_DEPLOYMENT_TARGET to override the default macOS deployment target.
EOF
}

if ! command -v boltffi >/dev/null 2>&1; then
  echo "boltffi is required. Install it with cargo or make sure it is on PATH." >&2
  exit 1
fi

platforms=()

add_platform() {
  local candidate="$1"
  local existing
  if [ "${#platforms[@]}" -gt 0 ]; then
    for existing in "${platforms[@]}"; do
      if [ "${existing}" = "${candidate}" ]; then
        return
      fi
    done
  fi
  platforms+=("${candidate}")
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all)
      platforms=(apple android java)
      ;;
    --apple)
      add_platform apple
      ;;
    --android)
      add_platform android
      ;;
    --java)
      add_platform java
      ;;
    --java-linux-x86_64)
      add_platform java
      JVM_HOST_TARGETS="linux-x86_64"
      ;;
    --java-windows-x86_64)
      add_platform java
      JVM_HOST_TARGETS="windows-x86_64"
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

if [ "${#platforms[@]}" -eq 0 ]; then
  platforms=(apple android java)
fi

mkdir -p "${OUT_ROOT}"

toml_string_array_from_csv() {
  local csv="$1"
  local first=1
  local raw value

  printf '['
  IFS=',' read -r -a values <<<"${csv}"
  for raw in "${values[@]}"; do
    value="${raw//[[:space:]]/}"
    if [ -z "${value}" ]; then
      continue
    fi
    case "${value}" in
      current|darwin-arm64|darwin-x86_64|linux-x86_64|linux-aarch64|windows-x86_64)
        ;;
      *)
        echo "Unsupported JVM host target: ${value}" >&2
        exit 1
        ;;
    esac

    if [ "${first}" -eq 0 ]; then
      printf ', '
    fi
    printf '"%s"' "${value}"
    first=0
  done
  printf ']'
}

jvm_host_targets_contain() {
  local needle="$1"
  local raw value
  IFS=',' read -r -a values <<<"${JVM_HOST_TARGETS}"
  for raw in "${values[@]}"; do
    value="${raw//[[:space:]]/}"
    if [ "${value}" = "${needle}" ]; then
      return 0
    fi
  done
  return 1
}

boltffi_output_path() {
  local path="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "${path}"
        return
      fi
      ;;
  esac
  printf '%s' "${path}"
}

write_overlay() {
  local jvm_targets
  local apple_output apple_swift_output apple_header_output
  local android_output android_kotlin_output android_header_output android_pack_output
  local java_output
  jvm_targets="$(toml_string_array_from_csv "${JVM_HOST_TARGETS}")"
  apple_output="$(boltffi_output_path "${OUT_ROOT}/apple")"
  apple_swift_output="$(boltffi_output_path "${OUT_ROOT}/apple/Sources/BoltFFI")"
  apple_header_output="$(boltffi_output_path "${OUT_ROOT}/apple/include")"
  android_output="$(boltffi_output_path "${OUT_ROOT}/android")"
  android_kotlin_output="$(boltffi_output_path "${OUT_ROOT}/android/kotlin")"
  android_header_output="$(boltffi_output_path "${OUT_ROOT}/android/include")"
  android_pack_output="$(boltffi_output_path "${OUT_ROOT}/android/jniLibs")"
  java_output="$(boltffi_output_path "${OUT_ROOT}/java")"

  cat >"${OVERLAY_PATH}" <<EOF
[targets.apple]
output = "${apple_output}"

[targets.apple.swift]
output = "${apple_swift_output}"

[targets.apple.header]
output = "${apple_header_output}"

[targets.apple.xcframework]
output = "${apple_output}"

[targets.apple.spm]
output = "${apple_output}"

[targets.android]
output = "${android_output}"

[targets.android.kotlin]
output = "${android_kotlin_output}"

[targets.android.header]
output = "${android_header_output}"

[targets.android.pack]
output = "${android_pack_output}"

[targets.java.jvm]
output = "${java_output}"
host_targets = ${jvm_targets}
EOF
}

write_overlay

setup_android_env() {
  export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}"
  export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT}}"
  export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-${ANDROID_SDK_ROOT}/ndk/29.0.14206865}"

  local llvm_bin="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/darwin-x86_64/bin"
  if [ ! -x "${llvm_bin}/aarch64-linux-android24-clang" ]; then
    echo "Android NDK clang not found under ${ANDROID_NDK_HOME}" >&2
    exit 1
  fi

  export PATH="${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/emulator:${llvm_bin}:${PATH}"
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="${CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER:-aarch64-linux-android24-clang}"
  export CC_aarch64_linux_android="${CC_aarch64_linux_android:-aarch64-linux-android24-clang}"
  export AR_aarch64_linux_android="${AR_aarch64_linux_android:-llvm-ar}"
  export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="${CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER:-x86_64-linux-android24-clang}"
  export CC_x86_64_linux_android="${CC_x86_64_linux_android:-x86_64-linux-android24-clang}"
  export AR_x86_64_linux_android="${AR_x86_64_linux_android:-llvm-ar}"
}

setup_java_env() {
  if [ -z "${JAVA_HOME:-}" ] && /usr/libexec/java_home >/dev/null 2>&1; then
    export JAVA_HOME="$(/usr/libexec/java_home)"
  elif [ -z "${JAVA_HOME:-}" ] && [ -d "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home" ]; then
    export JAVA_HOME="/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"
  fi

  if [ -z "${JAVA_HOME:-}" ]; then
    echo "JAVA_HOME is required for JVM packaging." >&2
    exit 1
  fi
}

setup_linux_x86_64_jvm_env() {
  if ! rustup target list --installed | grep -q '^x86_64-unknown-linux-gnu$'; then
    echo "Missing Rust target x86_64-unknown-linux-gnu. Run: rustup target add x86_64-unknown-linux-gnu" >&2
    exit 1
  fi

  if ! command -v zig >/dev/null 2>&1; then
    echo "zig is required for Linux x86_64 JVM cross packaging from macOS." >&2
    exit 1
  fi

  setup_java_env
  verify_file "${JAVA_HOME}/include/jni.h"

  local tools_dir="${OUT_ROOT}/tools"
  local linker="${tools_dir}/zig-cc-x86_64-unknown-linux-gnu"
  local include_root="${OUT_ROOT}/java-linux-x86_64-jni/include"
  mkdir -p "${tools_dir}" "${include_root}/linux"

  cat >"${linker}" <<'EOF'
#!/usr/bin/env bash
args=()
skip_next=0

for arg in "$@"; do
  if [ "${skip_next}" -eq 1 ]; then
    skip_next=0
    if [ "${arg}" = "x86_64-unknown-linux-gnu" ] || [ "${arg}" = "x86_64-linux-gnu" ]; then
      continue
    fi
  fi

  case "${arg}" in
    --target=x86_64-unknown-linux-gnu|--target=x86_64-linux-gnu)
      continue
      ;;
    -target)
      skip_next=1
      continue
      ;;
  esac

  args+=("${arg}")
done

exec zig cc -target x86_64-linux-gnu "${args[@]}"
EOF
  chmod +x "${linker}"

  cp "${JAVA_HOME}/include/jni.h" "${include_root}/jni.h"
  cat >"${include_root}/linux/jni_md.h" <<'EOF'
#ifndef _JAVASOFT_JNI_MD_H_
#define _JAVASOFT_JNI_MD_H_

#ifndef JNIEXPORT
#define JNIEXPORT __attribute__((visibility("default")))
#endif
#ifndef JNIIMPORT
#define JNIIMPORT __attribute__((visibility("default")))
#endif

typedef int jint;
#ifdef _LP64
typedef long jlong;
#else
typedef long long jlong;
#endif
typedef signed char jbyte;

#endif
EOF

  export BOLTFFI_JAVA_LINKER_X86_64_UNKNOWN_LINUX_GNU="${linker}"
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="${linker}"
  export CC_x86_64_unknown_linux_gnu="${linker}"
  export BOLTFFI_JAVA_INCLUDE_X86_64_UNKNOWN_LINUX_GNU="${include_root}/linux"
}

setup_android_gradle_project() {
  if ! command -v gradle >/dev/null 2>&1; then
    echo "gradle is required to package the Android AAR/Maven artifact." >&2
    exit 1
  fi

  local project_dir="${OUT_ROOT}/android-maven/project"
  local repo_dir="${OUT_ROOT}/android-maven/repository"
  local group_id="${SYNCULAR_ANDROID_MAVEN_GROUP:-dev.syncular}"
  local artifact_id="${SYNCULAR_ANDROID_MAVEN_ARTIFACT:-syncular-android}"
  local version="${SYNCULAR_ANDROID_MAVEN_VERSION:-$(runtime_version)}"

  mkdir -p "${project_dir}/syncular-android"

  cat >"${project_dir}/settings.gradle.kts" <<EOF
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "SyncularAndroidPackage"
include(":syncular-android")
EOF

  cat >"${project_dir}/build.gradle.kts" <<'EOF'
plugins {
    id("com.android.library") version "9.2.1" apply false
}
EOF

  cat >"${project_dir}/syncular-android/build.gradle.kts" <<EOF
plugins {
    id("com.android.library")
    id("maven-publish")
    id("signing")
}

android {
    namespace = "dev.syncular.client"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    sourceSets {
        getByName("main") {
            kotlin.directories.add("${OUT_ROOT}/android/kotlin")
            jniLibs.directories.add("${OUT_ROOT}/android/jniLibs")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "${group_id}"
            artifactId = "${artifact_id}"
            version = "${version}"

            afterEvaluate {
                from(components["release"])
            }

            pom {
                name.set("Syncular Android")
                description.set("Syncular Rust native Android bindings")
                url.set("https://github.com/syncular/syncular")
                licenses {
                    license {
                        name.set("MIT")
                    }
                }
                developers {
                    developer {
                        id.set("syncular")
                        name.set("Syncular")
                    }
                }
                scm {
                    url.set("https://github.com/syncular/syncular")
                }
            }
        }
    }

    repositories {
        maven {
            name = "local"
            url = uri("${repo_dir}")
        }
    }
}

val signingKey = providers.environmentVariable("SYNCULAR_MAVEN_SIGNING_KEY")
val signingPassword = providers.environmentVariable("SYNCULAR_MAVEN_SIGNING_PASSWORD")

signing {
    setRequired(signingKey.isPresent)
    if (signingKey.isPresent) {
        useInMemoryPgpKeys(signingKey.get(), signingPassword.orNull)
        sign(publishing.publications)
    }
}
EOF

  cat >"${project_dir}/syncular-android/consumer-rules.pro" <<'EOF'
-keep class dev.syncular.client.** { *; }
EOF
}

runtime_version() {
  sed -n 's/^version = "\(.*\)"/\1/p' "${RUNTIME_DIR}/Cargo.toml" | head -n 1
}

verify_file() {
  if [ ! -f "$1" ]; then
    echo "Missing expected artifact: $1" >&2
    exit 1
  fi
}

verify_dir() {
  if [ ! -d "$1" ]; then
    echo "Missing expected artifact directory: $1" >&2
    exit 1
  fi
}

normalize_android_library_names() {
  local abi
  for abi in arm64-v8a x86_64; do
    local abi_dir="${OUT_ROOT}/android/jniLibs/${abi}"
    local hyphen_name="${abi_dir}/libsyncular-runtime.so"
    local underscore_name="${abi_dir}/libsyncular_runtime.so"
    if [ -f "${hyphen_name}" ]; then
      if [ ! -f "${underscore_name}" ]; then
        mv "${hyphen_name}" "${underscore_name}"
      else
        rm -f "${hyphen_name}"
      fi
    fi
  done
}

normalize_boltffi_kotlin_sources() {
  local kotlin_file="$1"
  verify_file "${kotlin_file}"
  perl -0pi -e 's/\?: 1\.toInt\(\)/?: 1/g' "${kotlin_file}"
}

install_swift_adapter_sources() {
  mkdir -p "${OUT_ROOT}/apple/Sources/BoltFFI" "${OUT_ROOT}/apple/Sources/SyncularUI"
  cp "${REPO_ROOT}/rust/bindings/swift/Package.swift" "${OUT_ROOT}/apple/Package.swift"
  cp "${REPO_ROOT}/rust/bindings/swift/Sources/BoltFFI/Syncular-runtimeConvenience.swift" \
    "${OUT_ROOT}/apple/Sources/BoltFFI/Syncular-runtimeConvenience.swift"
  cp "${REPO_ROOT}/rust/bindings/swift/Sources/SyncularUI/SyncularUI.swift" \
    "${OUT_ROOT}/apple/Sources/SyncularUI/SyncularUI.swift"
}

install_kotlin_adapter_sources() {
  mkdir -p "${OUT_ROOT}/android/kotlinx" "${OUT_ROOT}/android/compose"
  cp -R "${REPO_ROOT}/rust/bindings/kotlin/kotlinx/." "${OUT_ROOT}/android/kotlinx/"
  cp -R "${REPO_ROOT}/rust/bindings/kotlin/compose/." "${OUT_ROOT}/android/compose/"
}

install_java_adapter_sources() {
  mkdir -p "${OUT_ROOT}/java/dev/syncular/client"
  cp "${REPO_ROOT}/rust/bindings/java/dev/syncular/client/SyncularBoltClient.java" \
    "${OUT_ROOT}/java/dev/syncular/client/SyncularBoltClient.java"
  cp "${REPO_ROOT}/rust/bindings/java/dev/syncular/client/SyncularNativeEvent.java" \
    "${OUT_ROOT}/java/dev/syncular/client/SyncularNativeEvent.java"
}

package_apple_xcframework_zip() {
  local xcframework="${OUT_ROOT}/apple/Syncular.xcframework"
  local zip_path="${OUT_ROOT}/apple/Syncular.xcframework.zip"
  verify_dir "${xcframework}"
  rm -f "${zip_path}" "${zip_path}.sha256" "${zip_path}.swift-checksum"
  (
    cd "${OUT_ROOT}/apple"
    ditto -c -k --sequesterRsrc --keepParent "Syncular.xcframework" "Syncular.xcframework.zip"
  )
  shasum -a 256 "${zip_path}" >"${zip_path}.sha256"
  swift package compute-checksum "${zip_path}" >"${zip_path}.swift-checksum"
}

package_android_maven() {
  setup_android_gradle_project
  local project_dir="${OUT_ROOT}/android-maven/project"
  local repo_dir="${OUT_ROOT}/android-maven/repository"
  local group_path="${SYNCULAR_ANDROID_MAVEN_GROUP:-dev.syncular}"
  group_path="$(printf '%s' "${group_path}" | tr '.' '/')"
  local artifact_id="${SYNCULAR_ANDROID_MAVEN_ARTIFACT:-syncular-android}"
  local version="${SYNCULAR_ANDROID_MAVEN_VERSION:-$(runtime_version)}"

  echo "[native-package] package Android AAR/Maven artifact"
  ANDROID_HOME="${ANDROID_HOME}" ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT}" \
    gradle --no-daemon -p "${project_dir}" :syncular-android:publishReleasePublicationToLocalRepository

  verify_file "${repo_dir}/${group_path}/${artifact_id}/${version}/${artifact_id}-${version}.aar"
  verify_file "${repo_dir}/${group_path}/${artifact_id}/${version}/${artifact_id}-${version}.pom"
  verify_file "${repo_dir}/${group_path}/${artifact_id}/${version}/${artifact_id}-${version}-sources.jar"
  verify_android_maven_consumer "${repo_dir}" "${group_path}" "${artifact_id}" "${version}"
}

verify_android_maven_consumer() {
  local repo_dir="$1"
  local group_path="$2"
  local artifact_id="$3"
  local version="$4"
  local group_id="${group_path//\//.}"
  local smoke_dir="${OUT_ROOT}/android-maven/consumer-smoke"

  mkdir -p "${smoke_dir}/consumer/src/main/kotlin/dev/syncular/maven/smoke"

  cat >"${smoke_dir}/settings.gradle.kts" <<EOF
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri("${repo_dir}")
        }
    }
}

rootProject.name = "SyncularAndroidMavenConsumerSmoke"
include(":consumer")
EOF

  cat >"${smoke_dir}/build.gradle.kts" <<'EOF'
plugins {
    id("com.android.library") version "9.2.1" apply false
}
EOF

  cat >"${smoke_dir}/consumer/build.gradle.kts" <<EOF
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.syncular.maven.smoke"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    sourceSets {
        getByName("main") {
            kotlin.directories.add("src/main/kotlin")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("${group_id}:${artifact_id}:${version}")
}
EOF

  cat >"${smoke_dir}/consumer/src/main/kotlin/dev/syncular/maven/smoke/SyncularMavenSmoke.kt" <<'EOF'
package dev.syncular.maven.smoke

import dev.syncular.client.SyncularBoltClientConfig

fun syncularMavenSmokeConfig(): SyncularBoltClientConfig =
    SyncularBoltClientConfig(
        dbPath = "smoke.sqlite",
        baseUrl = "http://127.0.0.1:9/sync",
        clientId = "maven-smoke",
        actorId = "user-rust",
        projectId = null,
        appSchemaJson = null,
        autoSyncLocalWrites = false,
    )
EOF

  echo "[native-package] verify Android Maven consumer"
  ANDROID_HOME="${ANDROID_HOME}" ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT}" \
    gradle --no-daemon -p "${smoke_dir}" :consumer:assembleDebug
}

run_boltffi_pack() {
  local platform="$1"

  echo "[native-package] pack ${platform}"
  (
    cd "${RUNTIME_DIR}"
    if [ -n "${PROFILE_FLAG}" ]; then
      boltffi pack "${platform}" "${PROFILE_FLAG}" --regenerate \
        --cargo-arg=--package --cargo-arg=syncular-runtime \
        --overlay "${OVERLAY_PATH}"
    else
      boltffi pack "${platform}" --regenerate \
        --cargo-arg=--package --cargo-arg=syncular-runtime \
        --overlay "${OVERLAY_PATH}"
    fi
  )
}

for platform in "${platforms[@]}"; do
  case "${platform}" in
    apple)
      run_boltffi_pack apple
      install_swift_adapter_sources
      package_apple_xcframework_zip
      verify_dir "${OUT_ROOT}/apple/Syncular.xcframework"
      verify_file "${OUT_ROOT}/apple/Syncular.xcframework.zip"
      verify_file "${OUT_ROOT}/apple/Syncular.xcframework.zip.sha256"
      verify_file "${OUT_ROOT}/apple/Syncular.xcframework.zip.swift-checksum"
      verify_file "${OUT_ROOT}/apple/Package.swift"
      verify_file "${OUT_ROOT}/apple/Sources/BoltFFI/Syncular-runtimeBoltFFI.swift"
      verify_file "${OUT_ROOT}/apple/Sources/BoltFFI/Syncular-runtimeConvenience.swift"
      verify_file "${OUT_ROOT}/apple/Sources/SyncularUI/SyncularUI.swift"
      verify_file "${OUT_ROOT}/apple/include/syncular-runtime.h"
      ;;
    android)
      setup_android_env
      run_boltffi_pack android
      normalize_android_library_names
      normalize_boltffi_kotlin_sources "${OUT_ROOT}/android/kotlin/dev/syncular/client/Syncular.kt"
      install_kotlin_adapter_sources
      verify_file "${OUT_ROOT}/android/kotlin/dev/syncular/client/Syncular.kt"
      verify_file "${OUT_ROOT}/android/kotlinx/dev/syncular/client/SyncularKtx.kt"
      verify_file "${OUT_ROOT}/android/compose/dev/syncular/client/SyncularCompose.kt"
      verify_file "${OUT_ROOT}/android/kotlin/jni/jni_glue.c"
      verify_file "${OUT_ROOT}/android/include/syncular-runtime.h"
      verify_file "${OUT_ROOT}/android/jniLibs/arm64-v8a/libsyncular_runtime.so"
      verify_file "${OUT_ROOT}/android/jniLibs/x86_64/libsyncular_runtime.so"
      package_android_maven
      ;;
    java)
      setup_java_env
      if jvm_host_targets_contain "linux-x86_64"; then
        setup_linux_x86_64_jvm_env
      fi
      run_boltffi_pack java
      install_java_adapter_sources
      verify_file "${OUT_ROOT}/java/dev/syncular/client/Syncular.java"
      verify_file "${OUT_ROOT}/java/dev/syncular/client/SyncularBoltClient.java"
      verify_file "${OUT_ROOT}/java/dev/syncular/client/SyncularNativeEvent.java"
      if jvm_host_targets_contain "linux-x86_64"; then
        verify_file "${OUT_ROOT}/java/native/linux-x86_64/libsyncular_runtime_jni.so"
      fi
      if jvm_host_targets_contain "windows-x86_64"; then
        verify_file "${OUT_ROOT}/java/native/windows-x86_64/syncular_runtime_jni.dll"
      fi
      if ! find "${OUT_ROOT}/java/native" -type f \( -name 'libsyncular_runtime_jni.*' -o -name 'syncular_runtime_jni.dll' \) | grep -q .; then
        echo "Missing expected JVM native library under ${OUT_ROOT}/java/native" >&2
        exit 1
      fi
      ;;
  esac
done

echo "[native-package] wrote artifacts to ${OUT_ROOT}"
