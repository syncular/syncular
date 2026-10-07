# Troubleshooting (Swift)

Match a symptom to its cause and fix.

::meta{for="Swift developers with a failing build or a client that does not sync" time="3 minutes"}

| Symptom | Cause | Fix |
|---|---|---|
| Link error: undefined `_syncular_client_new` | The target links the package's own `libSyncular.a` instead of the core | Link the dylib by path (`vendor/libsyncular.dylib`), or switch to the xcframework `.binaryTarget` |
| `dyld: Library not loaded: libsyncular.dylib` at launch | The loader cannot find the dylib | Set `DYLD_LIBRARY_PATH` to the `vendor/` directory, or embed the xcframework |
| Initializer throws `client.failed` | A `baseUrl` was passed to a core built without `native-transport`, or the config is malformed | Build with `rust/scripts/build-native.sh apple` (it enables `native-transport`) |
| `sync()` returns `{ok: false, errorCode: "transport.unavailable"}` | No `baseUrl`, so the client runs the lean core | Pass `baseUrl`; the outbox keeps the commits until a round succeeds |
| Writes vanish after relaunch | `dbPath` is nil, so the replica is in memory | Pass a file path under Application Support |
| `sync-intent` events never arrive | The client is paused, or `onEvent` was set after the events were delivered and dropped | Call `resume()`; set `onEvent` right after construction |
| New token ignored on the live socket | An open WebSocket keeps its handshake headers | `setHeaders`, then `pause()` and `resume()` |
| Commands throw `client.closed` | The client was closed or deallocated | Keep one strong reference for the app's lifetime |
| Client stays paused after the app foregrounds | A connectivity adapter and a scene-phase handler fight over the lifecycle | Use one lifecycle owner; see [Realtime & lifecycle](/platform-swift-realtime/) |
| `mutate` throws `sync.invalid_request` | An unknown column, a wrong value type, or a missing required column | Match the generated row struct; nothing is recorded |

For protocol-level failures (`sync.*` codes, revoked subscriptions, conflicts) see [Troubleshooting](/troubleshooting/).
