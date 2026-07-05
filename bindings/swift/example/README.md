# syncular · Swift todo example

A todo app over the [`SyncularClient`](../README.md) wrapper, proving the Swift
bindings compile **and** drive a real app end-to-end against a real server. Two
executables share one ~30-line integration ([`TodoKit`](Sources/TodoKit/TodoStore.swift)):

- **`TodoUI`** — a SwiftUI macOS **window** (the headline demo). It boots
  `NSApplication` and hosts a SwiftUI view in an `NSWindow` via `NSHostingView`,
  so it compiles, links, and presents a **real titled window on a
  Command-Line-Tools-only mac — no full Xcode required** (verified). A list
  (query), an add field (mutate), per-row toggle (mutate), a Sync button
  (`syncUntilIdle`), a pending badge, and an event-driven refresh.
- **`todo`** — a terminal app (a `readLine` loop) that drives the same store
  from stdin, so it scripts deterministically. Commands: `list`, `add <title>`,
  `toggle <id>`, `sync`, `pending`, `quit`.

Both talk to the [`examples/quickstart`](../../../examples/quickstart) server's
`notes` table — the same schema and server the quickstart's TS clients use. A
todo is a `notes` row: `body` carries the title, and done-state rides as a
leading `[x] ` / `[ ] ` marker (the quickstart schema has no `done` column and
this example is read-only, so completion is modeled in the body — an honest fit,
no schema fork).

## The integration, in ~30 lines

The whole syncular surface is [`TodoStore`](Sources/TodoKit/TodoStore.swift):
`init` constructs a `SyncularClient` (schema + `baseUrl`) and `subscribe`s to the
list; `todos()` is one `query` decoded through the generated typed `Notes` row;
`add`/`toggle` are `mutate`; `sync()` is `syncUntilIdle`. No protocol logic —
the native core owns all of it.

The schema is **generated, not hand-built**:
[`Sources/TodoKit/Syncular.generated.swift`](Sources/TodoKit/Syncular.generated.swift)
(`SyncularSchema.schema` + the `Notes` struct + the `ListNotes` subscription
helper) comes from [`syncular.json`](syncular.json) + [`migrations/`](migrations)
via `syncular generate`. Regenerate after a schema change:

```sh
cd ../../.. && bun packages/typegen/src/cli.ts generate --manifest-dir bindings/swift/example
```

`check.sh` runs `generate --check` (a byte-exact freshness gate) before the
build, so a stale generated file fails loud.

## Run it

First build the native core and start the quickstart server:

```sh
# 1. Build the native-transport dylib and vendor it (check.sh does this for you)
cd bindings/swift && ./check.sh          # builds + vendors + builds the example

# 2. Start the quickstart server in another terminal
cd examples/quickstart && bun run generate && PORT=8787 bun run server
```

Then run either demo (the loader needs the vendored dylib on its search path):

```sh
cd bindings/swift/example
export DYLD_LIBRARY_PATH="$PWD/vendor"
export SYNCULAR_URL=http://localhost:8787   # unset/empty → offline (writes still queue)

# The SwiftUI window:
swift run TodoUI

# …or the terminal app:
swift run todo
# > add Buy milk
# > sync
# > list
```

Point at a different server with `SYNCULAR_URL`, and set `SYNCULAR_CLIENT_ID` to
give a client a stable identity across runs.

## Verified end-to-end

Run against a live quickstart server, the terminal app adds two todos
optimistically (`pending: 2`), `sync` pushes them (`pending: 0`), and an
**independent** client (the quickstart's own bun:sqlite + fetch web-client, a
separate database) then syncs and reads the exact rows back — the first
native-transport-to-real-server round-trip outside the wrapper's tests. Toggling
a synced row and re-syncing flips it on the server too.

## Release (a shipping .app)

This package links the vendored dylib via a `-L` search path (local-dev mode).
A shipping `.app` would instead consume the `Syncular.xcframework` binary target
(iOS device + simulator + macOS slices, built on a full-Xcode machine) — the app
code is identical. See the [swift bindings README](../README.md#binary-linkage--two-consumption-modes).
