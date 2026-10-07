# Install & first sync (Flutter)

Depend on the `syncular` package, ship `libsyncular` for your platform, and sync one row with the quickstart server.

::meta{for="Flutter and Dart developers adding Syncular to an app" time="15 minutes"}

:::terms
- **`libsyncular`**: The Rust core built as a C library. `dart:ffi` loads it at runtime.
- **Native transport**: The core's HTTP and WebSocket stack, compiled in by the `native-transport` feature.
- **Owning isolate**: The isolate that called `SyncularClient.create`. All commands run there.
:::

You need Dart 3 or newer, a Rust toolchain, and a Syncular server (the [Quickstart](/quickstart/) server on port 8787 works). Declare a `dart` output in `syncular.json` so `syncular generate` emits `syncular.generated.dart` with a `syncularSchema` map ([Schema & typegen](/guide-schema/)).

::::::steps
:::::step{title="Depend on the package" time="2 min"}
The package is not published to pub.dev; depend on it by path.

```yaml title="pubspec.yaml"
dependencies:
  syncular:
    path: ../path/to/bindings/flutter/syncular
```

::checkpoint[`flutter pub get` resolves `syncular` and `ffi`.]
:::::

:::::step{title="Build and ship the core" time="8 min"}
```sh title="terminal"
rust/scripts/build-native.sh
```

`build-native.sh` compiles with `native-transport` on, which `baseUrl` requires, and builds each target whose toolchain exists on the machine. Ship the result per platform:

| Platform | Artifact | Where it goes |
|---|---|---|
| Android | `libsyncular.so` (`arm64-v8a`, `x86_64`) | `android/src/main/jniLibs/<abi>/` |
| iOS | `Syncular.xcframework` | Link the slice into the Runner |
| macOS | `libsyncular.dylib` | `.app/Contents/Frameworks`, or the xcframework macOS slice |
| Linux | `libsyncular.so` | Next to the executable |
| Windows | `syncular.dll` | Next to the executable |

The platform folders (`android/`, `ios/`, and so on) come from `flutter create --platforms=macos,linux,android,ios .`.

::checkpoint[The artifact for your target platform sits where the table says.]
:::::

:::::step{title="Create a client" time="3 min"}
```dart title="lib/sync.dart"
import 'package:path_provider/path_provider.dart';
import 'package:syncular/syncular.dart';

final dir = await getApplicationSupportDirectory();
final client = SyncularClient.create(
  schema: syncularSchema,
  config: SyncularConfig(
    baseUrl: 'http://localhost:8787',
    dbPath: '${dir.path}/todos.db',
  ),
);
```

`create` loads the library, sends `create` with your schema, and starts the poll timer. Pass `clientId:` for an explicit id; without it the core generates one and keeps it in the database. Use a file path for `dbPath`: an in-memory database loses the outbox on restart. An Android emulator reaches the host at `10.0.2.2` instead of `localhost`. [Native client API](/native-client-api/#configuration) lists every `SyncularConfig` field.

::checkpoint[`create` returns without throwing `SyncularError`.]
:::::

:::::step{title="Write and sync" time="2 min"}
```dart title="lib/sync.dart"
client.subscribe('todos', 'todos', scopes: {'list_id': ['groceries']});
client.mutate([
  {
    'op': 'upsert',
    'table': 'todos',
    'values': {'id': 't1', 'list_id': 'groceries', 'title': 'Buy milk',
               'done': false, 'position': 1, 'updated_at_ms': 1},
  },
]);
print(client.syncUntilIdle());
print(client.pendingCommitIds());
```

::checkpoint[`pendingCommitIds()` prints `[]`, and the quickstart server holds the row. Run `bun run clients` from the quickstart to read it from a second client.]
:::::
::::::

Next: [Reads & writes](/platform-flutter-reads-writes/).
