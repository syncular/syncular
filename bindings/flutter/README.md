# syncular · flutter/dart binding

An idiomatic **Dart/Flutter** wrapper over the syncular v2 native core — the
C-ABI `syncular-ffi` (the five functions in [`rust/ffi.h`](../../rust/ffi.h)),
bound via `dart:ffi`. It is the Flutter sibling of [`bindings/swift`](../swift)
(`SyncularClient`) and [`bindings/kotlin`](../kotlin) (`SyncularClient` via FFM):
the SAME one JSON command surface (`{method, params}` in, `{result|error}` out,
bytes as `{"$bytes":hex}`), typed conveniences, a `poll_event`-driven event
Stream, and a pause/resume/close lifecycle owned in the wrapper.

Layout:

- **`syncular/`** — the Dart package (`pubspec.yaml`, `lib/syncular.dart` +
  `lib/src/{ffi,client}.dart`, `test/`). This is the reusable binding.
- **`example/`** — a minimal Flutter todo app (`lib/main.dart`, ~150 lines)
  proving the binding end-to-end against the demo server.

Like every binding here, this is its **own isolated build** — its gate is
`./check.sh`, and it never joins `bun run check` / the main cargo gate.

## The Dart surface

```dart
import 'package:syncular/syncular.dart';

final client = SyncularClient.create(
  clientId: 'device-a',                       // stable per-device id
  schema: todoSchema,                          // the generated schema JSON (Map)
  config: SyncularConfig(
    baseUrl: 'http://localhost:8787',          // omit → offline-only lean core
    dbPath: '/path/to/todos.db',               // omit → in-memory
  ),
);

client.subscribe('todos', 'todos', scopes: {'list_id': ['inbox']});

// Optimistic write — visible immediately, offline or not.
client.mutate([
  {'op': 'upsert', 'table': 'todos', 'values': {'id': 't1', /* … */}},
]);

// The live-query fast path (flat SQL rows).
final rows = client.query(
  'SELECT id, title, done FROM todos WHERE list_id = ?', params: ['inbox']);

// Drive sync; inspect the outcome (never throws out-of-band).
client.syncUntilIdle();

// Client-observable events → a broadcast Stream.
client.events.listen((e) {
  if (e.type == 'sync-needed') client.sync();
});

client.pause();   // stop poll + disconnect realtime (e.g. app backgrounded)
client.resume();  // reconnect + restart poll
client.close();   // release DB/transport/socket; idempotent
```

Typed conveniences mirror the command surface exactly (same names as the
Swift/Kotlin wrappers): `mutate` / `subscribe` / `unsubscribe` / `sync` /
`syncUntilIdle` / `readRows` / `query` / `pendingCommitIds` / `syncNeeded` /
`subscriptionState` / `conflicts` / `presence` / `setPresence` / `setWindow` /
`windowState` / `connectRealtime` / `disconnectRealtime`. Anything not lifted is
reachable via the raw `command(method, params)`.

### Event delivery — the honest simple choice

The core is **callback-free**: events (`sync-needed`, `conflict`, `rejection`,
`presence`, `schema-floor`, `lease`) are drained via `poll_event`. This wrapper
runs a `Timer.periodic` on the **owning isolate** doing **non-blocking** polls
(`timeout_ms = 0`) that drain everything currently queued, then return
immediately. This is deliberate:

- It runs on the same isolate as command dispatch, so it can **never race** an
  in-flight command — the core is thread-affine, and here there is exactly one
  thread. `close()` cancels the Timer synchronously, so the handle is never
  freed under an in-flight poll.
- A background isolate would need `Isolate.spawn` + a `SendPort` and could not
  share the non-`Sendable` opaque handle without a second core — pure overhead
  for a callback-free FFI. A blocking poll (`timeout_ms < 0`) on the main
  isolate would freeze the UI. Non-blocking-on-the-owner is the one good path.

The poll interval (default 40 ms) is a `SyncularClient.create` parameter.

## The native library (dylib) story per platform

`dart:ffi` loads `libsyncular` at runtime. The loader resolves the path in this
order (`lib/src/ffi.dart`):

1. an explicit `libraryPath` passed to `SyncularClient.create` / `SyncularFfi`;
2. the `SYNCULAR_LIBRARY_PATH` environment variable (what `check.sh` and the CI
   lane set to the freshly-built `target/debug/libsyncular.{dylib,so}`);
3. the per-platform default name from the loader search path.

| Platform | Library | How a consuming app ships it |
|---|---|---|
| **Android** | `libsyncular.so` (`arm64-v8a`, `x86_64`) | `cargo-ndk` → `android/src/main/jniLibs/<abi>/` (build-native.sh's android target) |
| **iOS** | statically linked | link the `Syncular.xcframework` slice into the Runner (build-native.sh's apple target); `libraryPath` is `null` (symbols live in the process) |
| **macOS** | `libsyncular.dylib` | bundle into `.app/Contents/Frameworks`, or link the xcframework mac slice |
| **Linux** | `libsyncular.so` | ship next to the executable / on the loader path |
| **Windows** | `syncular.dll` | ship next to the executable |

`rust/scripts/build-native.sh` builds each target whose toolchain exists and
detects+skips the rest — the same artifacts the Swift/Kotlin release paths use.
This binding reuses those; the packaging *knowledge* is identical, only the
FFI-load call site differs.

## Building the example's platform folders

The app **code** (`example/lib/main.dart`) is the deliverable and it is
tracked. The per-platform scaffolds (`android/`, `ios/`, `linux/`, `macos/`,
`windows/`) are machine-generated and **git-ignored** — generate them once with:

```sh
cd example
flutter create --platforms=macos,linux,android,ios .
```

This preserves `pubspec.yaml` and `lib/`. Then wire the native library per the
table above (Android jniLibs / macOS+iOS xcframework / Linux .so beside the
binary) and `flutter run`. Hand-writing those scaffolds would be brittle churn
for zero binding value — the Tauri/RN bindings took the same "generate, don't
commit, the app code is the point" stance.

## Running the gate

```sh
cd bindings/flutter && ./check.sh
```

`check.sh` **detects and skips** cleanly when no Dart SDK is present (never
fails the run) — mirroring build-native.sh and the Swift/Kotlin gates. With a
Dart SDK it: builds the lean `libsyncular` for this machine, vendors it, points
`SYNCULAR_LIBRARY_PATH` at it, then `dart analyze` + `dart test` the binding
against the **real native core**.

### What CI proves vs. what needs a local Flutter run

Per the [bindings conformance doctrine](../README.md), wrappers are
protocol-thin, so they earn a thin bar: an **offline hermetic smoke** against
the real core. The CI lane (`.github/workflows/v2.yml`, `flutter-bindings` job,
Ubuntu) does exactly that:

- `cargo build -p syncular-ffi` → the real cdylib;
- `subosito/flutter-action` provisions Flutter (which bundles Dart);
- `dart analyze` (binding + example lib) + `dart test` with
  `SYNCULAR_LIBRARY_PATH` at the built `.so` — **the strong proof**: the actual
  `dart:ffi` boundary exercised against the real Rust core (mutate → readRows
  optimistic row, query, outbox, `transport.unavailable`, close idempotence,
  pause/resume).

What CI does **not** do, and why it's honest to skip:

- **`flutter build linux`** of the example needs the GTK desktop dev
  headers; **`flutter build web` is not applicable** — the binding is
  `dart:ffi`, which has no web target. Building the *app* while the *binding* is
  already proven against the real core adds toolchain weight for little extra
  signal, so the app BUILD is a **documented local step** (`flutter run`), the
  same scoping the Tauri job used (`cargo tauri dev` needs a human) and the RN
  binding used (an example app was explicitly out). `dart test` against the real
  dylib is the load-bearing proof.
- The app running on a device/simulator is a manual `flutter run` against the
  demo server (`apps/demo`, port 8787) — start the server, then run the app.

## Offline-first, by design

The tests need **no server**: syncular is offline-first, so `mutate` →
`readRows`/`query` shows the optimistic row (`version == -1`), the outbox
(`pendingCommitIds`) grows, and `sync()` on the lean core honestly reports
`transport.unavailable`. That is the whole hermetic suite —
`syncular/test/syncular_client_test.dart`, mirroring the Swift/Kotlin suites.
