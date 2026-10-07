# Troubleshooting (Kotlin)

Match a symptom to its cause and fix.

::meta{for="Kotlin developers with a failing build or a client that does not sync" time="3 minutes"}

| Symptom | Cause | Fix |
|---|---|---|
| `UnsatisfiedLinkError: no syncular in java.library.path` | Neither load mechanism found the library | Set `-Dsyncular.library.path=/abs/path/libsyncular.dylib`, or add its directory to `java.library.path` |
| `UnsupportedClassVersionError` or a missing `java.lang.foreign` class | The JVM is older than 21 | Run on JDK 21 or newer |
| Preview-feature error on JDK 21 | The JVM lacks `--enable-preview` | Add `--enable-preview` to the app and test JVM args |
| Warning: restricted method called | The JVM lacks native-access permission | Add `--enable-native-access=ALL-UNNAMED` |
| `create` throws `client.failed` | A `baseUrl` was passed to a core built without `native-transport`, or the config is malformed | Rebuild with `rust/scripts/build-native.sh` (it enables `native-transport`) |
| `sync()` returns `{ok: false, errorCode: "transport.unavailable"}` | No `baseUrl`, so the client runs the lean core | Pass `baseUrl`; the outbox keeps the commits until a round succeeds |
| Writes vanish after restart | `dbPath` is null, so the replica is in memory | Pass a file path in app storage |
| UI updates crash with a wrong-thread error | The listener runs on `syncular-poll` | Post to the main thread inside the listener |
| `IllegalArgumentException` from `SyncularConfig` | A byte or millisecond bound above 2^53 cannot be sent exactly | Configure a smaller bound |
| Commands throw `client.closed` | The client was closed, possibly by `use { }` | Keep one client for the app's lifetime |
| Android: library not found at runtime | The `.so` is missing for the device ABI | Build `arm64-v8a` and `x86_64` with `build-native.sh android` into `jniLibs/` |

For protocol-level failures (`sync.*` codes, revoked subscriptions, conflicts) see [Troubleshooting](/troubleshooting/).
