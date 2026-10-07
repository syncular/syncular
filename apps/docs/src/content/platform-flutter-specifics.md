# Platform specifics (Flutter)

Reference for how the Dart package loads the core on each platform, schedules events, and bounds the native transport.

::meta{for="Flutter developers shipping or debugging a build" time="6 minutes"}

## Library loading

`dart:ffi` resolves `libsyncular` in a fixed order: the `libraryPath` argument of `SyncularClient.create`, then the `SYNCULAR_LIBRARY_PATH` environment variable, then the per-platform default name on the loader search path.

| Platform | Default name | Notes |
|---|---|---|
| Android | `libsyncular.so` | `arm64-v8a` and `x86_64` from `build-native.sh android` (needs `cargo-ndk`), in `jniLibs/<abi>/` |
| iOS | none | `DynamicLibrary.process()`: the xcframework slice is statically linked into the Runner, so leave `libraryPath` null |
| macOS | `libsyncular.dylib` | Bundle in `.app/Contents/Frameworks`, or link the xcframework macOS slice |
| Linux | `libsyncular.so` | Next to the executable or on the loader path |
| Windows | `syncular.dll` | Next to the executable |

These are the artifacts the Swift and Kotlin release paths use; only the load call differs. `dart:ffi` has no web target. Use [`@syncular/client`](/platform-web/) in a browser.

## Isolates

The core is thread-affine. Commands and the poll timer both run on the isolate that called `create`, so they cannot race. A background isolate would need a `SendPort` bridge, and a blocking poll on the UI isolate would freeze the UI; the package polls without blocking on the owning isolate instead. `close()` cancels the timer synchronously, which guarantees no poll overlaps the free.

## Transport policy

`SyncularConfig` carries the native transport bounds. `null` leaves a bound off.

| Field | Type | Effect |
|---|---|---|
| `requestTimeoutMs` | `int?` | End-to-end deadline for one HTTP request; expiry returns `transport.timeout` |
| `roundDeadlineMs` | `int?` | One deadline for a whole sync round; expiry returns `transport.timeout` |
| `maxRequestBytes` | `int?` | Larger request bodies fail with `transport.request_too_large` before any I/O |
| `maxResponseBytes` | `int?` | Larger decoded responses fail with `transport.response_too_large` |
| `redirects` | `String?` | `"deny"` (default) or `"follow"`; `"follow"` applies only to a request with no headers |

[Rust: Platform specifics](/platform-rust-specifics/#native-transport-policy) gives the full semantics.

## Errors

`SyncularError` carries a stable `code` and a message. `create` throws `client.failed` when `syncular_client_new` returns null: a malformed config, or a `baseUrl` on a core built without `native-transport`. A command after `close()` throws `client.closed`.

## API surface beyond the common set

`setWindow` and `windowState` are typed on the Dart client. `SyncularFfi` is exported for hosts that need the raw five functions.

## Example app

[`bindings/flutter/example`](https://github.com/syncular/syncular/tree/main/bindings/flutter/example) is a Flutter todo app of about 150 lines. Its platform scaffolds come from `flutter create` and stay out of the repository. Point it at a server with `--dart-define=SYNCULAR_SERVER=http://...`.
