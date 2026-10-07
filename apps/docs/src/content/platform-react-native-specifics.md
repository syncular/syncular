# React Native: platform specifics

Reference for the native side of the React Native SDK: the iOS and Android
shims, atomic snapshot reads, error shape, the security lifecycle, and the
injection points for off-device tests.

::meta{for="Developers debugging or extending the native bridge" time="8 minutes" first="platform-react-native-install" spec="7.5"}

:::terms
- **Shim**: The per-platform native module that owns the core handle and forwards JSON commands.
- **`syncular_free_string`**: The deallocator the C ABI requires for every library-owned string.
- **FFM**: Java's foreign function and memory API (`java.lang.foreign`).
:::

## The shims

| Platform | Source | Does |
|---|---|---|
| iOS | [`ios/Syncular.mm`](https://github.com/syncular/syncular/blob/main/bindings/react-native/ios/Syncular.mm), ObjC++ | Owns the opaque handle, forwards JSON command strings to the C ABI, pumps `poll_event` on a serial background dispatch queue, and emits through `RCTEventEmitter`. Releases every library-owned string with `syncular_free_string`. |
| Android | `SyncularModule.kt` and `SyncularPackage.kt`, Kotlin | Binds the C ABI through FFM with zero JNI C glue, the same technique as the [Kotlin binding](/platform-kotlin/), and loads `libsyncular.so` from the APK's `jniLibs`. |

The shims compile at the consuming app's build: they need the React Native pods
or the Android Gradle Plugin, the codegen'd spec, and the native artifact. The
repo tests the JS bridge and the hooks-to-module integration hermetically with
an injected NativeModule double, so no device is needed.

The native module and the event emitter are injectable:
`createNativeSyncClient({ nativeModule, eventEmitter })` is how the bridge
unit-tests off-device. In an app, both auto-resolve.

## Atomic snapshot reads

`client.snapshotRead({ statements, subscriptions, commitIds, owner })` reads
several SQL statements, window coverage, subscription bootstrap progress, and
commit delivery status in one native transaction. The result carries one
`bigint` revision, and the bridge decodes binary and large-integer query cells.
Owned read failures appear in diagnostics and clear after a successful read.
Native errors keep `code`, `retryable`, and structured `details`.

## Security lifecycle and purge

`client.purgeLocalData({ purgeId, targets })` forwards the same bounded purge
plan to the Rust core as Tauri and the C FFI do. For quarantine before data,
create the client with `securityPreflight: true`, apply the validated local
purge, then call `activateSecurity({ encryption })`. See
[Authorized local purge](/concepts-local-data-purge/). `securityPreflight` and
`encryption` in the create config are mutually exclusive.

## Related

- [FFI & the native core](/platform-ffi/): the five-function C ABI beneath the TurboModule.
- [Realtime](/concepts-realtime/): sockets, deltas, and invalidations.
- [Authorized local purge](/concepts-local-data-purge/): device and key revocation, with no claim that an offline device was remotely erased.
