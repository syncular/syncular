# Troubleshooting (Flutter)

Match a symptom to its cause and fix.

::meta{for="Flutter developers with a failing build or a client that does not sync" time="3 minutes"}

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid argument(s): Failed to load dynamic library 'libsyncular...'` | The loader found no library at the default name | Pass `libraryPath`, set `SYNCULAR_LIBRARY_PATH`, or ship the artifact per [Platform specifics](/platform-flutter-specifics/#library-loading) |
| `Failed to lookup symbol 'syncular_client_new'` on iOS | The xcframework slice is not linked into the Runner | Link `Syncular.xcframework`; leave `libraryPath` null |
| `create` throws `client.failed` | A `baseUrl` was passed to a core built without `native-transport`, or the config is malformed | Rebuild with `rust/scripts/build-native.sh` (it enables `native-transport`) |
| `sync()` returns `{ok: false, errorCode: "transport.unavailable"}` | No `baseUrl`, so the client runs the lean core | Pass `baseUrl`; the outbox keeps the commits until a round succeeds |
| Android emulator cannot reach the server | `localhost` points at the emulator | Use `http://10.0.2.2:8787` |
| Writes vanish after restart | `dbPath` is null, so the replica is in memory | Pass a path under `getApplicationSupportDirectory()` |
| `events` never fires | The listener was added after the events were delivered, or the client is paused | Listen right after `create`; call `resume()` |
| UI freezes during sync | `syncUntilIdle()` blocks the isolate that owns the client | Create and use the client on a background isolate |
| Commands throw `client.closed` | The client was closed | Keep one client for the app's lifetime |
| Release build cannot find the library on macOS | The dylib is not in the bundle | Copy it into `.app/Contents/Frameworks` |

For protocol-level failures (`sync.*` codes, revoked subscriptions, conflicts) see [Troubleshooting](/troubleshooting/).
