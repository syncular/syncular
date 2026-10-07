# React Native

`@syncular/react-native` runs the native Rust client core behind a React Native
TurboModule and presents it as the same `SyncClientLike` interface every other
host implements. This overview shows how the app reaches the core and the calls
of a first sync. The hooks are the same as on the web; this SDK links to
[React](/platform-react/) for them.

::meta{for="React Native developers on iOS and Android" runs="Rust core through the C FFI, SQLite file on the device (rusqlite)" package="`@syncular/react-native`, consumed from a repo checkout (not published to npm)" threading="Native shims pump core events on a background queue; JS calls are promises" time="4 minutes"}

:::terms
- **TurboModule**: The React Native native-module interface that carries JSON commands to the core.
- **Event pump**: The native loop that polls the core for events and emits them to JS.
- **FFI**: The five-function C ABI of `libsyncular`, the shared native core library.
:::

## How the pieces connect

:::figure{title="React Native SDK" note="JSON in, JSON out" ticks}
<div class="d-row">
<div class="node hot"><span class="t">JS · Hermes</span>Your app and <code>@syncular/react</code> hooks over <code>createNativeSyncClient</code></div>
<span class="d-arrow"></span>
<div class="d-box">
<p class="d-label">Native module</p>
<div class="d-stack">
<div class="node"><span class="t">Shim</span>ObjC++ on iOS, Kotlin on Android; forwards <code>{method, params}</code></div>
<div class="node hot"><span class="t">Rust core · libsyncular</span>Outbox, subscriptions, sync rounds</div>
<div class="node ok"><span class="t">SQLite file</span>Rows, cursors, outbox, client id</div>
</div>
</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Your server</span>Native HTTP and WebSocket transport</div>
</div>

::caption[Hermes lacks OPFS and sqlite-wasm, which the TypeScript client's persistent path needs, so the binding drives the `syncular-ffi` crate. Bytes cross as `{"$bytes":"hex"}`, and `poll_event` feeds a `NativeEventEmitter`.]
:::

## First sync in four calls

[Install & first sync](/platform-react-native-install/) covers the native
artifacts. The JS side:

```tsx title="src/sync.ts"
import { createNativeSyncClient } from '@syncular/react-native';
import { schema } from './syncular.generated';

// 1. Create: opens the file database on the Rust side.
export const client = await createNativeSyncClient({
  schema,
  baseUrl: 'https://your.server',
  dbPath: `${appDataDir}/syncular.db`,
});

// 2. Subscribe: which rows this device receives.
await client.subscribe({ id: 'todos', table: 'todos', scopes: { list_id: ['groceries'] } });

// 3. Write: visible to local reads at once, queued in the outbox.
await client.mutate([
  { table: 'todos', op: 'upsert', values: { id: 't1', list_id: 'groceries', title: 'Hello', done: false } },
]);

// 4. Sync: push the outbox, pull new rows.
await client.syncUntilIdle();
```

:::warning{title="Use a persistent database path"}
An in-memory database loses rows, cursors, the client id, and the outbox on
restart.
:::

## The pages of this SDK

| Page | Type | You get |
|---|---|---|
| [Install & first sync](/platform-react-native-install/) | How-to | Native artifacts, autolinking, `createNativeSyncClient`, and its config. |
| [Reads & writes](/platform-react-native-reads-writes/) | How-to | Hooks over the client, direct reads and writes, and CRDT text. |
| [Realtime & lifecycle](/platform-react-native-realtime/) | How-to | The event pump, `pause`/`resume`, the supervisor, and credential rotation. |
| [Platform specifics](/platform-react-native-specifics/) | Reference | The iOS and Android shims, atomic snapshot reads, and security lifecycle. |
| [Troubleshooting](/platform-react-native-troubleshooting/) | Reference | Build, native-module, and configuration failures. |

For the hook surface, see [React](/platform-react/). The C ABI underneath is in
[FFI & the native core](/platform-ffi/). The runnable
[example app](https://github.com/syncular/syncular/tree/main/bindings/react-native/example)
holds the per-platform device-build recipe.
