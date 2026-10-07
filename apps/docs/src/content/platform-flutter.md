# Flutter & Dart

The `syncular` package gives a Flutter or Dart app a local SQLite replica, an outbox, and a sync loop. This page shows the shape of the SDK and a first sync in six calls; the sub-pages cover install, daily use, lifecycle, platform details, and fixes.

::meta{for="Flutter and Dart developers" time="4 minutes"}

| Property | Value |
|---|---|
| **Runs on** | Android, iOS, macOS, Linux, and Windows; Flutter apps and headless Dart programs. Not the web (`dart:ffi` has no web target) |
| **Package** | `syncular`, a pub package in [`bindings/flutter/syncular`](https://github.com/syncular/syncular/tree/main/bindings/flutter/syncular), depended on by path; `package:ffi` is its only runtime dependency |
| **Core** | Rust core through the C ABI, bound with `dart:ffi` |
| **Threading** | One isolate owns the client; commands and event polling both run on it |
| **Reading time** | 4 minutes here, about 20 for the full set |

:::figure{title="How Dart reaches the core" note="Everything below the JSON line is shared" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Your app</span>Flutter widgets<br>typed rows from typegen</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">package:syncular</span><code>SyncularClient</code><br>poll timer, <code>events</code> stream</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">dart:ffi</span>5 hand-written<br>function bindings</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">libsyncular</span>Rust core<br>SQLite, native transport</div>
</div>

::caption[The three native SDKs share this model. [Native client API](/native-client-api/) documents the shared half.]
:::

## First sync

The calls below assume the package is a dependency and `libsyncular` is loadable ([Install & first sync](/platform-flutter-install/)), and `syncular generate` emitted `syncular.generated.dart`.

```dart
import 'package:syncular/syncular.dart';

final client = SyncularClient.create(
  schema: syncularSchema,
  config: SyncularConfig(baseUrl: 'http://localhost:8787', dbPath: dbPath),
);
client.subscribe('todos', 'todos', scopes: {'list_id': ['groceries']});
client.mutate([
  {
    'op': 'upsert',
    'table': 'todos',
    'values': {'id': 't1', 'list_id': 'groceries', 'title': 'Buy milk',
               'done': false, 'position': 1, 'updated_at_ms': 1},
  },
]);
client.syncUntilIdle();
print(client.query('SELECT id, title FROM todos'));
```

`mutate` is visible to `query` at once. `syncUntilIdle` pushes the outbox and pulls the subscribed list, so a second device with the same subscription reads `t1`.

## The pages

- **[Install & first sync](/platform-flutter-install/)**: depend on the package, ship the core, create a client.
- **[Reads & writes](/platform-flutter-reads-writes/)**: subscribe, mutate, query, windows, and collaborative text.
- **[Realtime & lifecycle](/platform-flutter-realtime/)**: the `events` stream, `pause()`, `resume()`, `close()`, and the connectivity adapter.
- **[Platform specifics](/platform-flutter-specifics/)**: library loading per platform, transport policy, and isolate rules.
- **[Troubleshooting](/platform-flutter-troubleshooting/)**: library lookup errors, `client.failed`, and offline results.

The behavior shared with Swift and Kotlin (configuration, events, snapshot and outcome methods) is on [Native client API](/native-client-api/).
