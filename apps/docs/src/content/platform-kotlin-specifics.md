# Platform specifics (Kotlin)

Reference for how the Kotlin binding loads the core, packages it for Android, and bounds the native transport.

::meta{for="Kotlin developers shipping or debugging a build" time="6 minutes"}

## Library loading

The FFM `SymbolLookup` resolves `libsyncular` in a fixed order. There is no fallback past the second step.

| Order | Mechanism | Use |
|---|---|---|
| 1 | The `syncular.library.path` system property, an absolute file path | Tests and desktop apps that ship the library at a known path |
| 2 | `System.loadLibrary("syncular")` through `java.library.path` | Packaged apps; resolves `libsyncular.dylib`, `libsyncular.so`, or `syncular.dll` |

On a plain JVM, build the host library with `build-native.sh desktop` and point one mechanism at it.

## Android

The wrapper compiles JVM-neutral with no Android SDK dependency, so it drops into an Android library module unchanged. `build-native.sh android` builds `arm64-v8a` and `x86_64` `.so` files through `cargo-ndk`; place them under `jniLibs/`. The `.so` then loads by name from the APK, so `syncular.library.path` is unnecessary. The script skips the Android slice when `cargo-ndk` or the NDK is absent. An AAR needs the Android Gradle Plugin and `cargo-ndk`; the repository gate does not build one. FFM on Android requires a recent runtime.

## JVM flags

| Flag | Needed when |
|---|---|
| `--enable-preview` | JDK 21 (FFM is a preview API there); harmless on JDK 22 and newer |
| `--enable-native-access=ALL-UNNAMED` | Always, to allow the downcalls without a warning |

The Gradle build uses `jvmToolchain(21)` and passes `-Xjvm-enable-preview` to the Kotlin compiler.

## Threading

| Work | Where it runs |
|---|---|
| Commands | The calling thread, under one internal lock |
| Event poll | A daemon thread named `syncular-poll`, 25 ms `poll_event` waits |
| Event delivery | The poll thread; no marshaling to a UI thread |

The core is thread-affine, which the lock satisfies. Never call the FFM functions directly.

## Transport policy

`SyncularConfig` carries the native transport bounds. `null` leaves a bound off.

| Field | Type | Effect |
|---|---|---|
| `requestTimeoutMs` | `Long?` | End-to-end deadline for one HTTP request; expiry returns `transport.timeout` |
| `roundDeadlineMs` | `Long?` | One deadline for a whole sync round; expiry returns `transport.timeout` |
| `maxRequestBytes` | `Long?` | Larger request bodies fail with `transport.request_too_large` before any I/O |
| `maxResponseBytes` | `Long?` | Larger decoded responses fail with `transport.response_too_large` |
| `redirects` | `String?` | `"deny"` (default) or `"follow"`; `"follow"` applies only to a request with no headers |

The wrapper serializes each bound as an exact integer token and throws `IllegalArgumentException` for a `Long` above 2^53 that has no exact `Double` representation. [Rust: Platform specifics](/platform-rust-specifics/#native-transport-policy) gives the full semantics.

## Errors

`SyncularException` carries a stable `code` and a message. `create` throws `client.failed` when `syncular_client_new` returns NULL: a malformed config, or a `baseUrl` on a core built without `native-transport`. A command after `close()` throws `client.closed`.

## Example app

[`bindings/kotlin/example`](https://github.com/syncular/syncular/tree/main/bindings/kotlin/example) is a terminal todo app over a 30-line store. Its `ci-smoke.sh` pushes a write through a live quickstart server and reads it back from an independent client.
