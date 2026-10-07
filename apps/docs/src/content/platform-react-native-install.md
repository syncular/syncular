# React Native: install & first sync

Build the native artifacts, wire the package into your app, and create the first
client. You finish with a native Syncular core on a file-backed database that
syncs against your server.

::meta{for="React Native developers adding sync to an iOS or Android app" time="20 minutes" first="platform-react-native add-to-existing-app"}

:::terms
- **XCFramework**: The iOS and macOS bundle of static archives that holds the Rust core.
- **`jniLibs`**: The Android directory that holds one `libsyncular.so` per ABI.
- **Autolinking**: React Native's mechanism that wires a package's native code into the app build.
:::

:::figure{title="From Rust source to a running client" note="Build, drop in, link" ticks}
<div class="d-row">
<div class="node"><span class="t">build-native.sh</span>Builds each target whose toolchain exists</div>
<span class="d-arrow"></span>
<div class="d-stack">
<div class="node hot"><span class="t">iOS</span><code>Syncular.xcframework</code> into <code>ios/</code>, then <code>pod install</code></div>
<div class="node hot"><span class="t">Android</span><code>libsyncular.so</code> into <code>jniLibs/&lt;abi&gt;/</code></div>
</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">App</span><code>createNativeSyncClient</code></div>
</div>

::caption[Autolinking wires the rest through `syncular-react-native.podspec` and `android/build.gradle`.]
:::

:::::steps
::::step{title="Get the package" time="2 min"}
The package lives at
[`bindings/react-native`](https://github.com/syncular/syncular/tree/main/bindings/react-native)
and is not published to npm. Consume it from a repo checkout, as the bundled
[example app](https://github.com/syncular/syncular/tree/main/bindings/react-native/example)
does: Metro `watchFolders` point at the workspace source packages. The app
stays outside the bun workspace because React Native apps pin exact `react` and
`react-native` versions.

::checkpoint[Metro resolves `@syncular/react-native` in your app.]
::::

::::step{title="Build the native artifact" time="10 min"}
```sh title="terminal"
rust/scripts/build-native.sh
```

The script builds every target whose toolchain exists and skips the rest:

- iOS and macOS: `Syncular.xcframework` with device and simulator static
  archives. It needs full Xcode. Drop it into the package's `ios/` directory,
  then run `pod install` in your app.
- Android: `libsyncular.so` per ABI through `cargo-ndk` (`arm64-v8a`,
  `x86_64`). Drop each into `android/src/main/jniLibs/<abi>/`.

React Native codegen runs at your app's build from the TurboModule spec in
`src/NativeSyncular.ts`; the `codegenConfig` in `package.json` names the spec
`SyncularSpec`.

::checkpoint[The artifact for your target exists in `ios/` or `jniLibs/`.]
::::

::::step{title="Create the client" time="3 min"}
`createNativeSyncClient` opens the file database on the Rust side and returns a
ready `SyncClientLike`:

```tsx title="src/sync.ts"
import { createNativeSyncClient } from '@syncular/react-native';
import { schema } from './syncular.generated';

const client = await createNativeSyncClient({
  schema,                          // the typegen output, same as every host
  baseUrl: 'https://your.server',  // engages the native transport
  dbPath: `${appDataDir}/syncular.db`,
});

await client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });
await client.syncUntilIdle();
```

With a `baseUrl`, the client runs the native HTTP and WebSocket transport.
Without one it runs the offline-only core with no network stack. Give the client
a persistent database path.

::checkpoint[`await client.query('SELECT id, title FROM todos')` returns the server's rows. Restart the app and the rows are still there.]
::::
:::::

## Client config

| Key | Meaning |
|---|---|
| `schema` | The generated schema from [typegen](/guide-schema/). |
| `clientId` | Optional explicit id. Otherwise the core creates and persists one in the database. A different id for an existing database fails loudly. |
| `baseUrl` | Sync server mount. Engages the native transport. |
| `dbPath` | On-disk SQLite path, usually a file under the app-data directory. |
| `headers` | Extra transport headers (auth, tenant). |
| `limits` | §4.2 client limits, forwarded to the native `create`. |
| `realtimePolicy` | `optional` (default) or `required`; see [Realtime & lifecycle](/platform-react-native-realtime/). |
| `encryption` | Portable E2EE keyring installed in the Rust core. |
| `securityPreflight` | Opens the replica behind the fail-closed security gate. Mutually exclusive with `encryption`: the client rejects the combination with `sync.invalid_request`, and you install keys with `activateSecurity` after preflight. |
| `requestTimeoutMs` | End-to-end deadline for one HTTP request. |
| `roundDeadlineMs` | One monotonic deadline for a whole sync round. |
| `maxRequestBytes`, `maxResponseBytes` | Largest request body sent and largest decoded response accepted. |
| `redirects` | `"deny"` (default) or `"follow"`. |
| `autoSync` | Consume explicit core sync intents on the JS event loop. Default `true`. |
| `nativeModule`, `eventEmitter` | Injection points for tests. In an app both auto-resolve. |

## Next

- [Reads & writes](/platform-react-native-reads-writes/): hooks and direct calls.
- [Realtime & lifecycle](/platform-react-native-realtime/): `pause`, `resume`, and credentials.
