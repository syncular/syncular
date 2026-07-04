# syncular todo — Flutter example

A minimal Flutter todo list (`lib/main.dart`, ~150 lines) proving the
[`syncular`](../syncular) Dart binding works with a clean interface and no
hacks. The whole syncular surface it touches: `SyncularClient.create`
(file-backed DB + server URL), `subscribe`, `mutate` (add / toggle), `query`
(the live read), `syncUntilIdle` (the sync button + auto-sync on the event
stream), `pendingCommitIds` (the unsynced badge), and `close`.

The `todos` schema is **generated, not hand-built**:
[`lib/syncular.generated.dart`](lib/syncular.generated.dart) (`syncularSchema` +
the `Todos` class + the `SyncularTodoListSubscription` helper) comes from
[`syncular.json`](syncular.json) + [`migrations/`](migrations) via `syncular-v2
generate` (regenerate with `bun packages/typegen/src/cli.ts generate
--manifest-dir bindings/flutter/example` from the repo root). `check.sh` runs
`generate --check` (a byte-exact freshness gate, bun-only, so it runs even
without a Dart SDK).

## Run it

1. **Start the demo server** (from `apps/demo`): `bun run server` — it serves
   `POST /sync` on port 8787 with the `todos` schema this app targets.
2. **Generate the platform scaffolds** (once — they are git-ignored):

   ```sh
   flutter create --platforms=macos,linux,android,ios .
   ```

   This keeps `pubspec.yaml` and `lib/main.dart` and adds the native runners.
3. **Wire the native library** for your target (see the binding README's
   dylib table): Android → `jniLibs/<abi>/libsyncular.so`; macOS/iOS → link the
   `Syncular.xcframework` slice; Linux → `libsyncular.so` beside the binary.
   `rust/scripts/build-native.sh` produces these.
4. `flutter pub get && flutter run`.

Point the app at a different server with `--dart-define=SYNCULAR_SERVER=http://…`
(Android emulators rewrite `localhost` → `10.0.2.2` automatically).

## What it demonstrates

- **Optimistic writes**: adding a todo shows it instantly (offline or online),
  before any round-trip — `mutate` then `query`.
- **The outbox**: the app-bar badge is `pendingCommitIds().length` — unsynced
  work is visible.
- **Auto-sync**: `client.events` delivers `sync-needed`; the app calls
  `syncUntilIdle()` in response, so writes push and server changes pull without
  a manual tap. The sync button forces a round.
- **Convergence**: run a second client (this app on another device, or the
  `apps/demo` web frontend on the same list) and watch todos converge.

The app is intentionally single-file and un-clever — the point is that the
binding reads clean.
