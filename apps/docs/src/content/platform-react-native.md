# React Native

`@syncular/react-native` runs the native Rust client core behind a React
Native TurboModule (rusqlite on the device filesystem, HTTP and WebSockets
owned in Rust) and surfaces it as the same `SyncClientLike` interface every
other host implements. As a result, every `@syncular/react` hook works
unchanged in a React Native app.

## Why the binding runs the native core

RN's Hermes runtime lacks both OPFS and sqlite-wasm, and the TypeScript
client's persistent path depends on both. So React Native uses the native
core from the [`syncular-ffi`](https://github.com/syncular/syncular/tree/main/rust/crates/ffi)
crate: a real SQLite file on the device filesystem (rusqlite) and a
native HTTP + WebSocket transport, bridged through a TurboModule. The bridge
is thin because the surface is already JSON-command-shaped: `{method,
params}` in, `{result|error}` out, bytes as `{"$bytes":"hex"}`, and
`poll_event` feeding a `NativeEventEmitter`.

## Install

The package lives at
[`bindings/react-native`](https://github.com/syncular/syncular/tree/main/bindings/react-native)
and is not yet published to npm; consume it from a repo checkout, the
way the bundled [example app](https://github.com/syncular/syncular/tree/main/bindings/react-native/example)
does (Metro `watchFolders` pointed at the workspace source packages, kept
outside the bun workspace because RN apps pin exact `react`/`react-native`
versions).

The native artifact is built from the Rust tree:

```sh
rust/scripts/build-native.sh
```

The script builds every target whose toolchain exists and skips the rest:

- iOS/macOS — `Syncular.xcframework` (device + simulator static archives;
  needs full Xcode). Drop it into the package's `ios/` directory, then
  `pod install` in your app.
- Android — `libsyncular.so` per ABI via `cargo-ndk` (`arm64-v8a`,
  `x86_64`). Drop each into `android/src/main/jniLibs/<abi>/`.

RN autolinking wires the rest through `syncular-react-native.podspec` and
`android/build.gradle`; the TurboModule spec in `src/NativeSyncular.ts` drives
RN codegen at your app's build (the `codegenConfig` in `package.json` names
the spec `SyncularSpec`).

## Create a client

`createNativeSyncClient` opens the file database on the Rust side and returns
a ready `SyncClientLike`:

```tsx
import { createNativeSyncClient } from '@syncular/react-native';
import { SyncProvider } from '@syncular/react';
import { schema } from './syncular.generated';

const client = await createNativeSyncClient({
  schema,                          // the typegen output, same as every host
  baseUrl: 'https://your.server',  // engages the native HTTP+WS transport
});
```

The config keys:

| Key | Meaning |
| --- | --- |
| `clientId` | Optional explicit id; otherwise the core creates and persists one. |
| `schema` | The generated schema from [typegen](/guide-schema/). |
| `baseUrl` | Sync server mount; engages the native transport. Omit for a client-local core. |
| `dbPath` | On-disk SQLite path (apps usually pass a file under the app-data dir). |
| `headers` | Extra transport headers (auth, tenant, …). |
| `limits` | §4.2 client limits, forwarded to the native `create`. |

## Every React hook works unchanged

Pass the client to `<SyncProvider>` and the entire
[`@syncular/react`](/platform-react/) surface (`useQuery`, `useRawSql`,
`useMutation`, `useSyncStatus`, `useCommitOutcomes`, `usePresence`) behaves exactly as it does
against the browser client. From the example app's real `App.tsx`:

```tsx
import { SyncProvider, useMutation, useRawSql } from '@syncular/react';
import type { TodosRow } from './syncular.generated';

function TodoList() {
  const { mutate } = useMutation();
  const { rows } = useRawSql<TodosRow>(
    'SELECT id, title, done FROM todos WHERE list_id = ? ORDER BY position, id',
    ['groceries'],
  );
  // mutate([{ table: 'todos', op: 'upsert', values: { ... } }]) — the outbox
  // queues offline; the row appears optimistically via invalidation.
}

export function App({ client }) {
  return (
    <SyncProvider client={client}>
      <TodoList />
    </SyncProvider>
  );
}
```

Native CRDT text (needs the FFI `crdt-yjs` feature) is exposed as typed
methods on the client (`crdtText`, `crdtInsertText`, `crdtDeleteText`,
`crdtApplyUpdate`), byte-compatible with the web `@syncular/crdt-yjs` helper.
See [CRDT columns](/concepts-crdt/).

## Durable recovery and local purge

Final commit outcomes use the native SQLite journal. `commitOutcome`,
`commitOutcomes`, and `resolveCommitOutcome` survive process restarts; failed
aggregate outcomes retain the complete ordered local operation envelope for an
authorized repair flow. React applications normally observe that journal with
`useCommitOutcomes()`.

`client.purgeLocalData({ purgeId, targets })` forwards the same bounded plan to
the Rust core as Tauri and the C FFI. It atomically removes matching rows and
FTS documents, rejects whole affected pending commits, replays safe optimistic
work, reconciles blob references, and returns counts only. Validate the
directive and gate subscriptions first; see
[Authorized local purge](/concepts-local-data-purge/).

## Events and lifecycle

The client core has no callbacks: the native shims pump
`syncular_client_poll_event` on a background queue and emit each event JSON on
the `syncular::event` topic. The FFI forwards exact revisioned `change` batches
and explicit `sync-intent` effects from the Rust core; it does not diff
counters. The JS bridge feeds changes into the same shared reactive store as
web and Tauri, while `presence` remains ephemeral.

Lifecycle is explicit and battery-aware:

- `client.pause()` — stop the native event pump and disconnect realtime. Call
  from `AppState` `'background'`. The database and outbox stay intact;
  mutations keep queuing offline.
- `client.resume()` — reconnect realtime and restart the pump.
- `client.close()` — detach listeners and release the native core.

## Platform notes

- **iOS shim** — [`ios/Syncular.mm`](https://github.com/syncular/syncular/blob/main/bindings/react-native/ios/Syncular.mm),
  ObjC++. Owns the opaque handle, forwards JSON command strings to the C ABI,
  pumps `poll_event` on a serial background dispatch queue, and emits via
  `RCTEventEmitter`. Every library-owned string is released with
  `syncular_free_string`, the deallocator the C ABI requires.
- **Android shim** — `SyncularModule.kt` + `SyncularPackage.kt`, Kotlin. Binds
  the C ABI via FFM (`java.lang.foreign`) with zero JNI C glue, the same
  technique as the [Kotlin binding](/platform-kotlin/), and loads
  `libsyncular.so` from the APK's `jniLibs`.
- The shims compile at the consuming app's build (they need the RN pods /
  Android Gradle Plugin plus the codegen'd spec and the native artifact). The
  JS bridge and the hooks↔module integration are tested hermetically in the
  repo with an injected NativeModule double, so no device is needed.
- The native module and event emitter are injectable
  (`createNativeSyncClient({ nativeModule, eventEmitter })`), which is how the
  bridge unit-tests off-device; in an app both auto-resolve.

## Where to go next

- **[React hooks](/platform-react/)** — the full `useQuery` / `useRawSql` /
  `useMutation` / `usePresence` surface this binding feeds.
- **[Embedding via C FFI](/platform-ffi/)** — the five-function C ABI
  underneath the TurboModule.
- **[The example app](https://github.com/syncular/syncular/tree/main/bindings/react-native/example)**
  — the runnable todo app, with the per-platform device-build recipe.
- **[Realtime](/concepts-realtime/)** — how the socket, deltas, and
  invalidations work.
- **[Authorized local purge](/concepts-local-data-purge/)** — device and key
  revocation without pretending an offline device was remotely erased.
