# Native Packaging

The native packages must be generated from the current Rust runtime, generated
headers, and JNI glue in one pass. Do not rely on checked-in binary artifacts as
the source of truth; they can drift from the current BoltFFI surface.

The current native FFI ABI version is `2`. Generated Swift/Kotlin app clients
assert this against `runtimeManifestJson()` before using a native host, so
runtime/binding changes and app-client generation must be released together.

Run from the repo root:

```bash
bash rust/scripts/package-native-bindings.sh --all
```

For the local release-readiness gate, prefer the root script:

```bash
bun run rust:native:release-check
```

That command builds the Apple package, Android AAR/local Maven package,
current-host JVM package, Linux x86_64 JVM package, and the generated
Swift/Kotlin/JVM native smoke. Windows JVM packaging is still a Windows
host/runner check because BoltFFI `0.24.1` does not cross-package that target
from macOS.

The native smoke validates the current event-stream contract:
`startEventStream(...)`, `nextEventJson()`, and `closeEventStream()`. The old
host-facing event wait API is intentionally not part of the release surface.

By default this writes fresh artifacts under `.context/native-packages`:

- `apple/Syncular.xcframework`
- `apple/Syncular.xcframework.zip`
- `apple/Syncular.xcframework.zip.swift-checksum`
- `apple/Syncular.xcframework.zip.sha256`
- `apple/Package.swift`
- `apple/Sources/BoltFFI/Syncular-runtimeBoltFFI.swift`
- `android/kotlin/dev/syncular/client/Syncular.kt`
- `android/jniLibs/*/libsyncular_runtime.so`
- `android-maven/repository/dev/syncular/syncular-android/<version>/*.aar`
- `android-maven/repository/dev/syncular/syncular-android/<version>/*.pom`
- `java/dev/syncular/client/*.java`
- `java/native/*/libsyncular_runtime_jni.*`

Use `SYNCULAR_NATIVE_PACKAGE_OUT=/path/to/out` when preparing a release bundle
or when copying artifacts into another app.

On macOS, the packaging script defaults `MACOSX_DEPLOYMENT_TARGET` to `13.0`
so Rust static libraries and BoltFFI JNI/Swift link steps agree on the same
minimum OS version. Override with `SYNCULAR_MACOS_DEPLOYMENT_TARGET` or an
explicit `MACOSX_DEPLOYMENT_TARGET` if a release needs a different floor.

For SwiftPM remote binary releases, upload `Syncular.xcframework.zip` and use
the contents of `Syncular.xcframework.zip.swift-checksum` as the
`binaryTarget` checksum. The `.sha256` file is a standard archive digest for
release verification outside SwiftPM.

The Android package links the generated JNI glue into `libsyncular_runtime.so`.
The script normalizes BoltFFI's packaged library filename to the underscore
name loaded by the generated Kotlin wrapper. A raw Cargo `cdylib` is not enough
for Android because `System.loadLibrary` needs JNI entry symbols such as
`Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1open`.

The Android release decision is to publish the low-level native binding as an
AAR with Maven coordinates:

```text
dev.syncular:syncular-android:<runtime-version>
```

The package contains only the schema-agnostic native binding and JNI libraries.
App-specific generated Kotlin clients stay in the consuming app and depend on
that AAR.

For a local consumer app:

```kotlin
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri("/path/to/syncular/.context/native-packages/android-maven/repository")
        }
    }
}
```

```kotlin
dependencies {
    implementation("dev.syncular:syncular-android:0.1.0")
}
```

Override Maven metadata when needed:

```bash
SYNCULAR_ANDROID_MAVEN_GROUP=dev.syncular \
SYNCULAR_ANDROID_MAVEN_ARTIFACT=syncular-android \
SYNCULAR_ANDROID_MAVEN_VERSION=0.1.0 \
  bash rust/scripts/package-native-bindings.sh --android
```

Signing is optional for local packaging. For release publication, provide an
ASCII-armored in-memory PGP key:

```bash
SYNCULAR_MAVEN_SIGNING_KEY="$(cat private-key.asc)" \
SYNCULAR_MAVEN_SIGNING_PASSWORD="..." \
  bash rust/scripts/package-native-bindings.sh --android
```

The script also builds a generated Gradle consumer smoke against the local
Maven repository so the AAR is proven resolvable before release.

Useful targeted commands:

```bash
bun run rust:native:package:apple
bun run rust:native:package:android
bun run rust:native:package:java
bun run rust:native:package:java:linux
bun run rust:native:package:java:windows
```

The equivalent direct script commands are:

```bash
bash rust/scripts/package-native-bindings.sh --apple
bash rust/scripts/package-native-bindings.sh --android
bash rust/scripts/package-native-bindings.sh --java
bash rust/scripts/package-native-bindings.sh --java-windows-x86_64
```

`--java` packages the current desktop JVM host by default. To include supported
additional JVM desktop hosts, set `SYNCULAR_JVM_HOST_TARGETS`:

```bash
SYNCULAR_JVM_HOST_TARGETS=current,linux-x86_64 \
  bash rust/scripts/package-native-bindings.sh --java
```

For a Linux x86_64 JVM artifact from macOS, install the Rust target and use the
dedicated helper:

```bash
rustup target add x86_64-unknown-linux-gnu
bash rust/scripts/package-native-bindings.sh --java-linux-x86_64
```

The Linux cross path expects `zig` on `PATH`. The script writes a local Zig
linker wrapper and temporary JNI include shim under `.context/native-packages`
so the generated JNI glue can compile from macOS. The wrapper also normalizes
Cargo C-build target flags from `x86_64-unknown-linux-gnu` to Zig's
`x86_64-linux-gnu` spelling. Release CI on Linux should prefer packaging from a
real Linux JDK/host.

With BoltFFI `0.24.1`, Windows JVM artifacts are host-only. Verify/package
`windows-x86_64` from a Windows runner instead of trying to cross-package it
from macOS.

On a Windows runner with Git Bash, Java, Rust, and BoltFFI installed:

```bash
bun run rust:native:package:java:windows
```

CI runs the same path in `.github/workflows/checks.yml` as
`rust-windows-jvm-package` on `windows-latest`.

Expected output:

```text
.context/native-packages/java/native/windows-x86_64/syncular_runtime_jni.dll
```

If invoking the script directly, the equivalent command is:

```bash
SYNCULAR_JVM_HOST_TARGETS=windows-x86_64 \
  bash rust/scripts/package-native-bindings.sh --java
```

Android expects `ANDROID_SDK_ROOT`/`ANDROID_HOME` and `ANDROID_NDK_HOME`. On the
local development machine the script defaults to:

```bash
ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools
ANDROID_NDK_HOME=/opt/homebrew/share/android-commandlinetools/ndk/29.0.14206865
```

After packaging, run the app-shell smokes:

```bash
bash rust/examples/todo-app/native-smokes/ios-lifecycle/run-local.sh
bash rust/examples/todo-app/native-smokes/android-lifecycle/run-local.sh
```

The command-line native smoke also packages JVM bindings through
`rust/scripts/package-native-bindings.sh` into its `.context/native-smokes`
output directory, so it validates the same generated artifact shape without
rewriting checked-in binding outputs.
