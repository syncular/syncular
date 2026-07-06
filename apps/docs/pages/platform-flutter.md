# Flutter & Dart

The Dart binding is a **pub package** (`syncular` under
[`bindings/flutter/syncular`](https://github.com/syncular/syncular/tree/main/bindings/flutter/syncular))
over the Rust native core's C FFI, bound via `dart:ffi` — five hand-written
function bindings, no ffigen, and `package:ffi` as the only runtime
dependency. The binding is thin marshaling over the shared Rust core —
protocol behavior is identical on every platform because every binding drives
the same `syncular-command` surface. See
[FFI & the native core](/platform-ffi/) for the underlying C ABI.

## Install

Depend on the package by path (it is not published to pub.dev):

```yaml
dependencies:
  syncular:
    path: ../path/to/bindings/flutter/syncular
```

The native core (`libsyncular`) is built by
[`rust/scripts/build-native.sh`](https://github.com/syncular/syncular/blob/main/rust/scripts/build-native.sh)
and shipped per platform — see the library-loading section below. The binding
itself is plain Dart, so it works in Flutter apps and headless Dart alike
(there is no web target — `dart:ffi` has none).

## Create a client

`SyncularClient.create` loads the library, constructs the native core, issues
`create` with your schema and client id, and starts the event poll loop. The
schema comes from typegen — declare a `dart` output in `syncular.json` and
`syncular generate` emits a `syncular.generated.dart` with a ready-made
`syncularSchema` map plus typed rows and subscription helpers (see
[Schema & typegen](/guide-schema/)).

```dart
import 'package:syncular/syncular.dart';

final client = SyncularClient.create(
  clientId: 'device-a',                        // stable per-device id
  schema: syncularSchema,                      // from syncular.generated.dart
  config: SyncularConfig(
    baseUrl: 'https://your.server/sync',       // engages the native transport
    dbPath: '${dir.path}/todos.db',            // file-backed persistence
  ),
);
```

`baseUrl` engages the native HTTP + WebSocket transport (a core built with the
`native-transport` feature); omit it for the dependency-lean, offline-only
core. `dbPath` installs a file-backed SQLite database (in a Flutter app,
`getApplicationSupportDirectory()` from `path_provider` is the natural home);
omit it for in-memory. `SyncularConfig` also takes `wsUrl` and `headers`.
`create` additionally accepts `limits`, an explicit `libraryPath`, and
`pollInterval` (default 40 ms).

## Reads & writes

```dart
// Subscribe: table + scope map. Local; sync fills it.
client.subscribe('todos', 'todos', scopes: {'list_id': ['inbox']});

// Optimistic write — visible immediately, offline or not.
final commitId = client.mutate([
  {
    'op': 'upsert',
    'table': 'todos',
    'values': {'id': 't1', 'list_id': 'inbox', 'title': 'Hello',
               'done': false, 'position': 1, 'updated_at_ms': 1},
  },
]);

// RowState maps: {rowId, version, values}; version == -1 = optimistic.
final states = client.readRows('todos');

// The live-query fast path: arbitrary read-only SQL, flat rows.
final rows = client.query(
  'SELECT id, title, done FROM todos WHERE list_id = ?', params: ['inbox']);
```

The scope map is the same authorization vocabulary as everywhere else in
syncular — see [Scopes & authorization](/concepts-scopes/). The full
convenience set mirrors the Swift/Kotlin wrappers: `mutate`, `subscribe`,
`unsubscribe`, `sync`, `syncUntilIdle`, `readRows`, `query`,
`pendingCommitIds`, `syncNeeded`, `subscriptionState`, `conflicts`,
`presence`, `setPresence`, `setWindow`, `windowState`, `connectRealtime`,
`disconnectRealtime`, and the CRDT helpers. Anything not lifted is reachable
via the raw `command(method, params)` escape hatch.

## Sync loop & events

```dart
final outcome = client.sync();       // one round; needs native-transport
client.syncUntilIdle(maxRounds: 10); // drive to quiescence

client.events.listen((e) {
  if (e.type == 'sync-needed') client.sync();
});
```

Events (`sync-needed`, `conflict`, `rejection`, `presence`, `schema-floor`,
`lease`) arrive on `client.events`, a **broadcast Stream** delivered on the
owning isolate's event loop — listeners can touch UI state directly. Under
the hood a `Timer.periodic` on the owning isolate drains the core's
`poll_event` queue with non-blocking polls, so event delivery can never race
an in-flight command and never parks the isolate inside the FFI.

Failed commands throw `SyncularError` (a stable `code` plus a message) — with
one deliberate exception: `sync()` never errors out-of-band. Offline or on the
lean core it returns `{ok: false, errorCode: "transport.unavailable"}`, and
the mutation stays in the **offline outbox** (`pendingCommitIds()` is
non-empty until sync drains it). Writes are always optimistic: a `mutate` is
immediately visible via `readRows`/`query`, server or not.

## Collaborative text (CRDT)

With a core built with the `crdt-yjs` feature, `crdt` columns get native
helpers — byte-compatible with the web `@syncular/crdt-yjs` helper (see
[CRDT](/concepts-crdt/)):

```dart
final text = client.crdtText('notes', 'n1', 'doc');
client.crdtInsertText('notes', 'n1', 'doc', 0, 'Hi ');
client.crdtDeleteText('notes', 'n1', 'doc', 0, 3);
```

`crdtApplyUpdate` applies an arbitrary Yjs update (a `List<int>`) as an escape
hatch. Each editing helper pushes the update through the normal mutate path
and returns the enqueued `clientCommitId`.

## Library loading & platform artifacts

`dart:ffi` resolves `libsyncular` in a fixed order: an explicit `libraryPath`
passed to `SyncularClient.create`, then the `SYNCULAR_LIBRARY_PATH`
environment variable, then the per-platform default name on the loader search
path. What each platform ships:

| Platform | Library | How a consuming app ships it |
|---|---|---|
| Android | `libsyncular.so` (`arm64-v8a`, `x86_64`) | `cargo-ndk` via `build-native.sh android` → `android/src/main/jniLibs/<abi>/` |
| iOS | statically linked | link the `Syncular.xcframework` slice into the Runner (`build-native.sh apple`); `libraryPath` stays null — symbols live in the process |
| macOS | `libsyncular.dylib` | bundle into `.app/Contents/Frameworks`, or link the xcframework mac slice |
| Linux | `libsyncular.so` | ship next to the executable / on the loader path |
| Windows | `syncular.dll` | ship next to the executable |

These are the same artifacts the Swift and Kotlin release paths use — only
the load call site differs.

## Lifecycle & threading

```dart
client.pause();   // stop poll + disconnect realtime (app backgrounded)
client.resume();  // reconnect + restart poll
client.close();   // release DB/transport/socket; idempotent
```

- **`pause()`** — call from `AppLifecycleState.paused` or a connectivity-lost
  handler. Database and outbox intact; mutations still queue.
- **`resume()`** — reconnects realtime (if present) and restarts the poll.
- **`close()`** — cancels the poll Timer, frees the core, and closes the
  event Stream. Idempotent; commands throw `client.closed` afterwards.

The core is **thread-affine**, and Dart's concurrency model makes that
natural: commands and the poll loop both run on the isolate that created the
handle, so there is exactly one thread and nothing to race. The
[example](https://github.com/syncular/syncular/tree/main/bindings/flutter/example)
is a ~150-line Flutter todo app (`flutter run` against the demo server); its
platform scaffolds are generated with `flutter create`, not committed.

## Where to go next

- [FFI & the native core](/platform-ffi/) — the C ABI every binding shares.
- [Scopes & authorization](/concepts-scopes/) — the scope maps you subscribe with.
- [Conflicts & optimistic writes](/concepts-conflicts/) — what the `conflict` event carries.
- [Quickstart](/quickstart/) — the server the example app talks to.
