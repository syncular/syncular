# Flutter & Dart

The Dart binding is a **pub package** (`syncular` under
[`bindings/flutter/syncular`](https://github.com/syncular/syncular/tree/main/bindings/flutter/syncular))
over the Rust native core's C FFI. It uses `dart:ffi`: five hand-written
function bindings, no ffigen, and `package:ffi` as the only runtime
dependency. The package itself only marshals JSON across that boundary.
[FFI & the native core](/platform-ffi/) covers the C ABI and the command
surface underneath.

## Install

Depend on the package by path (it is not published to pub.dev):

```yaml
dependencies:
  syncular:
    path: ../path/to/bindings/flutter/syncular
```

The native core (`libsyncular`) is built by
[`rust/scripts/build-native.sh`](https://github.com/syncular/syncular/blob/main/rust/scripts/build-native.sh)
and shipped per platform (see the library-loading section below). The binding
itself is plain Dart, so it runs in Flutter apps and in headless Dart programs
alike. The one gap is web: `dart:ffi` doesn't target it.

## Create a client

`SyncularClient.create` loads the native library, spins up the core, sends
the initial `create` command with your schema and client id, and kicks off
the event poll loop. The schema itself comes from typegen: point a `dart`
output in `syncular.json` and `syncular generate` produces
`syncular.generated.dart`, exporting a ready-made `syncularSchema` map along
with typed row classes and subscription helpers (see
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

Passing `baseUrl` activates the native transport layer, HTTP plus WebSocket;
that requires a core built with the `native-transport` feature, and leaving
it out keeps the client on the offline-only core. Passing `dbPath` points the
client at a file-backed SQLite database that outlives app restarts (in a
Flutter app, `getApplicationSupportDirectory()` from `path_provider` is the
natural place for it); skip it and state lives only for the current process.
`SyncularConfig` also accepts `wsUrl` and `headers`, and `create` takes
`limits`, an explicit `libraryPath`, and `pollInterval` (40 ms by default).

## Reads & writes

```dart
// Subscribe: table + scope map. Local; sync fills it.
client.subscribe('todos', 'todos', scopes: {'list_id': ['inbox']});

// Optimistic write: the local read sees it right away.
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

// Arbitrary read-only SQL against the local database, returned as flat rows.
final rows = client.query(
  'SELECT id, title, done FROM todos WHERE list_id = ?', params: ['inbox']);
```

Scope maps use the same authorization vocabulary as the rest of syncular;
see [Scopes & authorization](/concepts-scopes/). The Dart client exposes the
same convenience methods as the Swift and Kotlin wrappers: `mutate`,
`subscribe`, `unsubscribe`, `sync`, `syncUntilIdle`, `readRows`, `query`,
`pendingCommitIds`, `syncNeeded`, `subscriptionState`, `conflicts`,
`presence`, `setPresence`, `setWindow`, `windowState`, `connectRealtime`,
`disconnectRealtime`, and the CRDT helpers. For anything not lifted into a
named method, call `command(method, params)` directly.

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
owning isolate's event loop, so listeners can touch UI state directly. Under
the hood a `Timer.periodic` on the owning isolate drains the core's
`poll_event` queue with non-blocking polls, so event delivery runs safely
alongside in-flight commands without blocking the isolate inside the FFI.

Failed commands throw `SyncularError`, carrying a stable `code` and a
message. `sync()` is the one call that folds transport trouble into its
result instead of throwing: offline, or on the lean core, it comes back as
`{ok: false, errorCode: "transport.unavailable"}`, and the write sits in the
offline outbox until the next sync clears it (check `pendingCommitIds()`
for what's queued). Every `mutate` writes optimistically, so `readRows` and
`query` reflect it the moment the call returns, well ahead of any round trip
to the server.

## Collaborative text (CRDT)

Enable the `crdt-yjs` feature on the core and `crdt` columns pick up native
editing helpers. The wire format matches the web `@syncular/crdt-yjs` helper,
so a Flutter app and a browser can collaborate on the same document (see
[CRDT](/concepts-crdt/)):

```dart
final text = client.crdtText('notes', 'n1', 'doc');
client.crdtInsertText('notes', 'n1', 'doc', 0, 'Hi ');
client.crdtDeleteText('notes', 'n1', 'doc', 0, 3);
```

When the built-in text helpers don't cover a case, hand `crdtApplyUpdate` an
arbitrary Yjs update as a `List<int>`. Whichever route you take, the update
rides the standard mutate call and comes back with a queued
`clientCommitId`.

## Library loading & platform artifacts

`dart:ffi` resolves `libsyncular` in a fixed order: an explicit `libraryPath`
passed to `SyncularClient.create`, then the `SYNCULAR_LIBRARY_PATH`
environment variable, then the per-platform default name on the loader search
path. What each platform ships:

| Platform | Library | How a consuming app ships it |
|---|---|---|
| Android | `libsyncular.so` (`arm64-v8a`, `x86_64`) | `cargo-ndk` via `build-native.sh android` → `android/src/main/jniLibs/<abi>/` |
| iOS | statically linked | link the `Syncular.xcframework` slice into the Runner (`build-native.sh apple`); `libraryPath` stays null since the symbols already live in the process |
| macOS | `libsyncular.dylib` | bundle into `.app/Contents/Frameworks`, or link the xcframework mac slice |
| Linux | `libsyncular.so` | ship next to the executable / on the loader path |
| Windows | `syncular.dll` | ship next to the executable |

These are the same artifacts the Swift and Kotlin release paths use; only
the load call site differs.

## Lifecycle & threading

```dart
client.pause();   // stop poll + disconnect realtime (app backgrounded)
client.resume();  // reconnect + restart poll
client.close();   // release DB/transport/socket; idempotent
```

- **`pause()`** shuts down the poll timer and drops the realtime connection.
  Trigger it from `AppLifecycleState.paused` or a connectivity-lost handler.
  The database and outbox stay intact; mutations keep queuing.
- **`resume()`** brings the realtime socket back (if one exists) and
  restarts polling.
- **`close()`** cancels the poll timer, frees the core, and closes the event
  stream. It is idempotent; once closed, commands throw `client.closed`.

Only one thread ever touches the core, and Dart's concurrency model makes
that automatic: commands and the poll loop both run on the isolate that
created the handle, so there is nothing to race. The
[example](https://github.com/syncular/syncular/tree/main/bindings/flutter/example)
is a ~150-line Flutter todo app (`flutter run` against the demo server); its
platform scaffolds come from `flutter create` and stay out of the repo.

## Where to go next

- [FFI & the native core](/platform-ffi/) — the C ABI this package binds via `dart:ffi`.
- [Scopes & authorization](/concepts-scopes/) — the rules behind the scope maps in `subscribe`.
- [Conflicts & optimistic writes](/concepts-conflicts/) — what shows up in the `conflict` event.
- [Quickstart](/quickstart/) — the server the todo example runs against.
