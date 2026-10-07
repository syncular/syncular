# React Native: troubleshooting

Match a React Native symptom or error code to its cause and fix: lost state
after restart, credentials that do not reach the socket, create-time config
errors, and missing native artifacts.

::meta{for="React Native developers debugging a failing client" time="4 minutes" first="platform-react-native-realtime"}

## Find the symptom

| Symptom or code | Cause | Fix |
|---|---|---|
| Rows, the client id, and the outbox vanish on restart | The client has no persistent `dbPath`. | Pass a file path under the app-data directory in [Client config](/platform-react-native-install/#client-config). |
| No network traffic and no realtime socket | `createNativeSyncClient` ran without `baseUrl`, so the core is offline-only. | Pass `baseUrl`. |
| A rotated token fails on the open socket | The WebSocket keeps the headers from its handshake. | Call `pause()` and `resume()` after `setHeaders`. See [Realtime & lifecycle](/platform-react-native-realtime/#rotate-credentials). |
| `sync.realtime_unavailable` | `realtimePolicy: 'required'` is set and the socket is down. | Restore the socket, or use the `optional` policy. See [Realtime](/concepts-realtime/#required-realtime). |
| `sync.invalid_request` on create | `securityPreflight` and `encryption` were both set. | Create with `securityPreflight: true`, then call `activateSecurity({ encryption })`. |
| `client.identity_mismatch` | An explicit `clientId` differs from the database's. | Omit `clientId` and let the core restore the stored one. |
| The app build fails to find the native library | `rust/scripts/build-native.sh` skips every target whose toolchain is missing. | Install the toolchain (full Xcode for iOS; the Android SDK, NDK, and `cargo-ndk` for Android), rerun the script, and place the artifact. See [Install & first sync](/platform-react-native-install/#build-the-native-artifact). |
| Hooks report no change after a native write | Events arrive through the pump, which `pause()` stops. | Call `resume()` when the app returns to the foreground. |

## Errors from the core

Native errors keep their `code`, `retryable` flag, and structured `details`, so
handle them as you handle the same codes on the web. The stable code catalog is
in [Troubleshooting](/troubleshooting/#error-code-index).
